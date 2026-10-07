//! symphonia 解码封装。
//!
//! 输出的**统一格式**：交错 f32、立体声（2 声道）。
//! 归一化到立体声的理由：
//!   · 下游（EQ / 交叉混音 / 输出）只处理一种布局，分支少、不易错；
//!   · 单声道源在立体声设备上本来就要复制（否则只有左耳有声音）；
//!   · 5.1 等多余声道在音乐场景里没有意义，直接取前两个。
//! 采样率**不做**统一：保留源采样率，交给输出层决定是重采样还是 autoconvert
//! （独占模式下 44100 源直通设备才是 bit-perfect，统一到 48000 反而破坏它）。
//!
//! 错误语义：解码中途遇到坏包（`DecodeError`）跳过继续，只有**结构性失败**
//! （容器损坏 / IO 断开）才向上抛。在线流偶尔有坏帧，跳过是正确行为。

use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as SymphoniaDecoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use crate::error::{AudioError, Result};
use crate::source::ByteStream;

/// symphonia 需要一个 `MediaSource`：
/// 我们的 `ByteStream` 已经满足 Read + Seek + Send，这里做一层薄适配。
struct StreamAdapter(Box<dyn ByteStream>);

impl std::io::Read for StreamAdapter {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}
impl std::io::Seek for StreamAdapter {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.0.seek(pos)
    }
}
impl MediaSource for StreamAdapter {
    fn is_seekable(&self) -> bool {
        self.0.is_seekable()
    }
    fn byte_len(&self) -> Option<u64> {
        self.0.byte_len()
    }
}

/// 一首曲目的基本参数（加载时就能拿到，供 UI 与时钟使用）。
#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub sample_rate: u32,
    pub channels: usize,
    /// 秒；容器未声明帧数时为 None（例如部分 chunked 流）——此时 UI 应显示"直播式"进度
    pub duration_sec: Option<f64>,
    /// 解码器认定的编码名（诊断用）
    pub codec: String,
}

pub struct Decoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn SymphoniaDecoder>,
    track_id: u32,
    /// 复用缓冲：避免每帧分配（解码是热路径）
    sample_buf: Option<SampleBuffer<f32>>,
    pub sample_rate: u32,
    pub channels: usize,
    /// 已完成解码的帧数（用于把「当前位置」换算成秒）
    decoded_frames: u64,
    /// 容器声明的总帧数
    total_frames: Option<u64>,
    /// 解码器标识（诊断：确认走的是 mp3 还是 aac 分支）
    codec_name: String,
}

impl Decoder {
    /// 打开一个音频源并完成探测。返回的 Decoder 已就绪，可以直接 `next_chunk`。
    pub fn open(stream: Box<dyn ByteStream>, hint_path: Option<&Path>) -> Result<Self> {
        let mss = MediaSourceStream::new(
            Box::new(StreamAdapter(stream)),
            MediaSourceStreamOptions::default(),
        );

        let mut hint = Hint::new();
        if let Some(p) = hint_path {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                /* 扩展名提示能显著提速探测（MP4/FLAC 靠魔数，MP3 靠帧同步较慢）。
                   注意只是「提示」：探测失败时会退化成扫描，不改变正确性。 */
                hint.with_extension(ext);
            }
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions {
                    enable_gapless: true,
                    ..Default::default()
                },
                &MetadataOptions::default(),
            )
            .map_err(|e| {
                AudioError::SourceFailed(format!("probe failed (unrecognized container): {:?}", e))
            })?;

        let format = probed.format;
        let track = format
            .default_track()
            .or_else(|| format.tracks().first())
            .ok_or_else(|| AudioError::SourceFailed("no audio track in container".into()))?;

        let track_id = track.id;
        let codec_params = track.codec_params.clone();
        let sample_rate = codec_params
            .sample_rate
            .ok_or_else(|| AudioError::SourceFailed("track declares no sample rate".into()))?;
        let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);
        let total_frames = codec_params.n_frames;

        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|e| AudioError::SourceFailed(format!("no decoder for codec: {:?}", e)))?;

        let codec_name = format!("{:?}", codec_params.codec);

        Ok(Self {
            format,
            decoder,
            track_id,
            sample_buf: None,
            sample_rate,
            channels,
            decoded_frames: 0,
            total_frames,
            codec_name,
        })
    }

    pub fn info(&self) -> TrackInfo {
        TrackInfo {
            sample_rate: self.sample_rate,
            channels: self.channels,
            /* ★ duration 只有在容器声明了 n_frames 时才给。
               给不出就是 None —— 绝不能编一个值：前端拿它画进度条、
               automix 拿它判断"歌尾还剩多久"，一个假的时长比没有更危险
               （原 JS 实现踩过的坑：duration=Infinity 时整个 ARM 判定失效）。 */
            duration_sec: self
                .total_frames
                .map(|n| n as f64 / self.sample_rate as f64),
            codec: self.codec_name.clone(),
        }
    }

    /// 解出下一块**立体声交错 f32**，追加到 `out`。
    /// 返回新增的样本数；返回 0 表示解码结束（正常 EOF）。
    pub fn next_chunk(&mut self, out: &mut Vec<f32>) -> Result<usize> {
        let before = out.len();
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    /* 正常的流末尾：symphonia 用 UnexpectedEof 表示"没有更多包了" */
                    return Ok(0);
                }
                Err(symphonia::core::errors::Error::ResetRequired) => {
                    /* 容器中途换参数（极少见于音乐文件）——当作结束，交给上层重新 open */
                    return Ok(0);
                }
                Err(e) => return Err(AudioError::from(e)),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(symphonia::core::errors::Error::DecodeError(msg)) => {
                    /* 坏帧跳过：在线流偶发，跳过比整首失败正确得多 */
                    eprintln!("[aria-audio] skip corrupt frame: {}", msg);
                    continue;
                }
                Err(e) => return Err(AudioError::from(e)),
            };

            /* ★ 顺序很重要：`copy_interleaved_ref` 会**移动** decoded，
               之后不能再读 decoded.spec()（AudioBufferRef 不是 Copy）。
               所以先把声道数取出来备用。 */
            let spec = *decoded.spec();
            let src_channels = spec.channels.count().max(1);

            if self.sample_buf.is_none() {
                /* capacity 是上限：SampleBuffer 要求容量 ≥ 本次帧数 */
                let cap = decoded.capacity() as u64;
                self.sample_buf = Some(SampleBuffer::new(cap, spec));
            }
            let frames;
            {
                let sb = self.sample_buf.as_mut().unwrap();
                sb.copy_interleaved_ref(decoded);
                let src = sb.samples();
                frames = src.len() / src_channels;
                mixdown_to_stereo(src, src_channels, out);
            }
            self.decoded_frames += frames as u64;
            return Ok(out.len() - before);
        }
    }

    /// 跳到指定秒数。seek 后解码位置由容器负责对齐到最近的帧。
    pub fn seek(&mut self, sec: f64) -> Result<()> {
        let sec = sec.max(0.0);
        /* Time::new(seconds, frac) —— frac 是 f64 的小数秒，
           这里传的是**秒**不是纳秒（别被 *_1e9 的乘子骗了）。 */
        let t = Time::new(sec as u64, sec.fract());
        self.format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: t,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|e| AudioError::SourceFailed(format!("seek failed: {:?}", e)))?;
        /* 编码器内部有预测状态（如 MP3 的 bit reservoir），seek 必须重置 */
        self.decoder.reset();
        self.decoded_frames = (sec.max(0.0) * self.sample_rate as f64) as u64;
        Ok(())
    }

    /// 当前解码位置（秒）。注意这是**解码位置**，比扬声器实际出声要靠前
    /// （中间还隔着 ring buffer 与设备缓冲）——时钟补偿在 engine 层做。
    pub fn position_sec(&self) -> f64 {
        self.decoded_frames as f64 / self.sample_rate as f64
    }
}

/// 任意声道数 → 立体声交错。
/// 单声道复制成左右；多声道取前两个（左右主声道）。
fn mixdown_to_stereo(src: &[f32], src_channels: usize, out: &mut Vec<f32>) {
    let frames = src.len() / src_channels.max(1);
    out.reserve(frames * 2);
    match src_channels {
        0 => {}
        1 => {
            for f in 0..frames {
                let v = src[f];
                out.push(v);
                out.push(v);
            }
        }
        2 => out.extend_from_slice(&src[..frames * 2]),
        n => {
            for f in 0..frames {
                let base = f * n;
                out.push(src[base]);
                out.push(src[base + 1]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixdown_mono_duplicates_to_both_channels() {
        let mut out = Vec::new();
        mixdown_to_stereo(&[0.1, 0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    }

    #[test]
    fn mixdown_stereo_passthrough() {
        let mut out = Vec::new();
        mixdown_to_stereo(&[0.1, -0.1, 0.2, -0.2], 2, &mut out);
        assert_eq!(out, vec![0.1, -0.1, 0.2, -0.2]);
    }

    #[test]
    fn mixdown_51_takes_front_pair() {
        let mut out = Vec::new();
        /* 一帧 6 声道，取前两个 */
        mixdown_to_stereo(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 6, &mut out);
        assert_eq!(out, vec![1.0, 2.0]);
    }

    #[test]
    fn mixdown_ignores_partial_trailing_frame() {
        /* 声道数不能整除时，尾部的半个帧必须被丢掉，不能错位 */
        let mut out = Vec::new();
        mixdown_to_stereo(&[1.0, 2.0, 3.0, 4.0, 5.0], 2, &mut out);
        assert_eq!(out, vec![1.0, 2.0, 3.0, 4.0]);
    }
}
