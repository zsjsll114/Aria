//! 播放引擎核心：命令 → 解码 → 队列 → 输出。
//!
//! 线程拓扑（三条线程，生命周期由「代际」统一管理）：
//!
//! ```text
//!   调用方 ──Cmd──► [控制线程] ──spawn/kill──┬─► [解码线程]  decoder → ring
//!                     │                      └─► [输出线程]  ring → WASAPI → 设备
//!                     └── 维护共享状态（时钟 / 音量 / 曲目信息 / 错误）
//! ```
//!
//! ★ 代际（generation）是整个引擎唯一的并发原语：
//!   任何「换曲 / 重开输出 / 停机」都做一次 `gen += 1`，然后所有线程在循环
//!   顶部比对 `gen != my_gen` 自行退出。这样不需要 join 每个线程、不需要
//!   复杂的锁层次，也不会出现"旧线程还活着、往新队列里灌旧歌数据"这类
//!   最难查的 bug。代价是线程退出有最大一个循环周期的延迟（≤ 200ms），
//!   对"换歌"这个场景完全够用。
//!
//! ★ 时钟模型（逐字歌词的正确性基础）：
//!   `position = frames_written - device_padding`。
//!   `frames_written` 是**已写入设备缓冲**的帧数，`device_padding` 是其中
//!   还没播出去的帧数（WASAPI 直接提供）。两者相减才是"此刻真正从扬声器
//!   出来的位置"。少了这个补偿，歌词高亮会稳定领先一个设备缓冲（20ms+）。
//!   —— 这里只维护**权威值**；给前端的高频插值由前端用 performance.now()
//!   自己做（见 lib.rs 文档），避免逐帧 IPC。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{sleep, spawn, JoinHandle};
use std::time::Duration;

use crate::decoder::{Decoder, TrackInfo};
use crate::dsp::{EqChain, EqSettings, SpatialChain, SpatialSettings};
use crate::error::{AudioError, Result};
use crate::output::{OutputConfig, OutputMode, OutputSampleFormat, WasapiOutput};
use crate::ring::SampleRing;
use crate::source::{self, AudioSourceSpec};

/// 队列容量。2 秒 @48k：足够吸收解码抖动（尤其是 HTTP 源整首下载后的
/// 解码高峰），又短到 seek 时丢弃的旧数据不会太多。
const RING_FRAMES: usize = 96_000;
const CHANNELS: usize = 2;

/// 播放速率量程。UI 的"练习模式"只用到 0.5~2.0，这里给调试留余量。
pub const MIN_RATE: f64 = 0.25;
pub const MAX_RATE: f64 = 4.0;
/// 单批重采样最多产出多少输出帧。存在的意义是**限住速率变化的响应延迟**：
/// 一批内用同一个 rate，所以最坏延迟 ≈ 该批的播放时长（8192 帧 @48k ≈ 170ms）。
const RESAMPLE_BATCH_FRAMES: usize = 8192;

/// 读当前速率，并把非有限值/越界值夹回合法区间。
fn read_rate(shared: &Shared) -> f64 {
    let r = f64::from_bits(shared.rate_bits.load(Ordering::Relaxed));
    if r.is_finite() {
        r.clamp(MIN_RATE, MAX_RATE)
    } else {
        1.0
    }
}

/// 供前端/CLI 读取的一致快照（无副作用）。
#[derive(Debug, Clone)]
pub struct EngineSnapshot {
    pub playing: bool,
    pub ended: bool,
    pub position_sec: f64,
    pub duration_sec: Option<f64>,
    pub sample_rate: u32,
    /// 当前播放速率（1.0 = 原速）。仅供前端显示/探针核对。
    pub rate: f64,
    pub volume: f32,
    pub buffered_frames: usize,
    pub underruns: u64,
    pub decoding: bool,
    pub track: Option<TrackInfo>,
    pub output_mode: OutputMode,
    /// 设备实际接受的样本格式。共享恒为 f32；独占由驱动协商决定
    /// （本机实测是 s24/s16）——前端把它显示给用户，才能回答
    /// 「我现在听到的到底是不是比特完美」。
    pub sample_format: OutputSampleFormat,
    pub last_error: Option<String>,
}

struct Shared {
    playing: AtomicBool,
    /// f32 位模式存放（AtomicU32 没有 f32 变体）
    volume_bits: AtomicU32,
    /// 代际：换曲/重开输出/停机时 +1，旧线程据此自杀
    gen: AtomicU64,
    /// 已写入设备的帧数（权威值，输出线程维护）
    frames_written: AtomicU64,
    /// 已真正播出的帧数 = frames_written - device_padding
    played_frames: AtomicU64,
    src_rate: AtomicU32,
    duration_ms: AtomicU64,
    ended: AtomicBool,
    /// 解码线程是否还在推进（EOF 后置 false）
    decoding: AtomicBool,
    info: Mutex<Option<TrackInfo>>,
    last_error: Mutex<Option<String>>,
    output_mode: Mutex<OutputMode>,
    /// 设备实际接受的样本格式（由打开输出的那一刻决定，见 snapshot）。
    sample_format: Mutex<OutputSampleFormat>,
    /// 用户选定的输出配置（SetOutput 时记录，下次 Load 直接复用）。
    /// ★ 存在这里而不是让调用方每次重传：换曲是高频操作，而设备选择是低频设置，
    ///   让"换曲"隐式继承"设备选择"才是符合直觉的语义。
    pending_output: Mutex<Option<OutputConfig>>,
    /// 当前活动队列（只读用：快照要报队列深度与 underrun）。
    ring: Mutex<Option<Arc<SampleRing>>>,
    /// EQ 设置。配合下面的版本号使用，见 `eq_version` 的注释。
    eq: Mutex<EqSettings>,
    /// EQ 设置的版本号。
    /// ★ 输出线程是实时线程，**不能每个音频块都去 lock 一次 Mutex**——
    ///   虽然实际竞争为零，但锁本身有内存屏障开销，且一旦将来有人在持锁时
    ///   做了慢操作（比如从 IPC 线程直接改），实时线程就会被拖出爆音。
    ///   用版本号做"变化才读"：稳态下输出线程只做一次 Relaxed load。
    eq_version: AtomicU64,
    /// 空间处理（空间音频 + 虚拟声场）设置。与 `eq` 同构：版本号驱动，
    /// 输出线程稳态下不 lock。见 `spatial.rs` / `spatial_version`。
    spatial: Mutex<SpatialSettings>,
    spatial_version: AtomicU64,
    /// 播放速率（≠1 = 变速）。f64 位模式存放（同 volume_bits，Atomic 没有 f64 变体）。
    /// 见 `spawn_decode` 里重采样那段的长注释：**设备侧采样率不动**，变速在
    /// 「解码 → ring」之间完成，所以输出线程/ring/seek 全部无需感知它。
    rate_bits: AtomicU64,
    /// 已推入 ring 的输出帧所对应的**源帧**累计数（重采样器口径，解码线程独占写）。
    /// ★ 为什么必须单独记：`played_frames` 是**设备帧**，而设备帧与源帧在 rate≠1 时
    ///   差一个 rate 因子；`snapshot` 需要拿它反推"现在听到的是源里的第几秒"，
    ///   否则进度条只会走到 1/rate（1.5× 时整首歌只能走到 66%）。
    src_frames_advanced: AtomicU64,
}

impl Shared {
    fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Relaxed))
    }
    fn set_error(&self, msg: String) {
        eprintln!("[aria-audio] {}", msg);
        if let Ok(mut g) = self.last_error.lock() {
            *g = Some(msg);
        }
    }
    fn clear_error(&self) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = None;
        }
    }
}

enum Cmd {
    Load {
        spec: AudioSourceSpec,
        autoplay: bool,
        reply: Option<Sender<Result<TrackInfo>>>,
    },
    Play,
    Pause,
    Seek(f64),
    SetVolume(f32),
    /// 播放速率。非有限值/越界一律夹到 [MIN_RATE, MAX_RATE]（IPC 是不可信输入）。
    SetRate(f64),
    SetEq(EqSettings),
    SetSpatial(SpatialSettings),
    SetOutput(OutputConfig),
    /// 主动交还输出设备（关掉原生输出时由前端调用）。见 `AudioEngine::release_output`。
    ReleaseOutput,
    Shutdown,
}

/// 对外句柄。Clone 便宜（内部只有 channel + Arc），可以自由塞进 Tauri State。
#[derive(Clone)]
pub struct AudioEngine {
    tx: Sender<Cmd>,
    shared: Arc<Shared>,
}

impl AudioEngine {
    pub fn new() -> Result<Self> {
        let (tx, rx) = channel::<Cmd>();
        let shared = Arc::new(Shared {
            playing: AtomicBool::new(false),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            gen: AtomicU64::new(0),
            frames_written: AtomicU64::new(0),
            played_frames: AtomicU64::new(0),
            src_rate: AtomicU32::new(48000),
            duration_ms: AtomicU64::new(0),
            ended: AtomicBool::new(false),
            decoding: AtomicBool::new(false),
            info: Mutex::new(None),
            last_error: Mutex::new(None),
            output_mode: Mutex::new(OutputMode::Shared),
            sample_format: Mutex::new(OutputSampleFormat::F32),
            pending_output: Mutex::new(None),
            ring: Mutex::new(None),
            eq: Mutex::new(EqSettings::default()),
            eq_version: AtomicU64::new(0),
            spatial: Mutex::new(SpatialSettings::default()),
            spatial_version: AtomicU64::new(0),
            rate_bits: AtomicU64::new(1.0f64.to_bits()),
            src_frames_advanced: AtomicU64::new(0),
        });
        let engine = Self {
            tx,
            shared: shared.clone(),
        };
        /* 控制线程：唯一的"有权创建/销毁其他线程"的地方。
           把它放在独立线程而不是调用线程里，是因为 Load 可能耗时数秒
           （HTTP 拉整首 + 探测容器），绝不能让 UI 线程等。 */
        spawn(move || control_loop(rx, shared));
        Ok(engine)
    }

    /// 加载一首并（可选）自动播放。
    /// ★ 同步等待加载完成——**只给 CLI 与测试用**。IPC 层请用 `load_async`，
    ///   否则一次网络卡顿会把命令线程堵住。
    pub fn load_blocking(&self, spec: AudioSourceSpec, autoplay: bool) -> Result<TrackInfo> {
        let (rtx, rrx) = channel();
        self.tx
            .send(Cmd::Load {
                spec,
                autoplay,
                reply: Some(rtx),
            })
            .map_err(|_| AudioError::Internal("engine control thread gone".into()))?;
        rrx.recv_timeout(Duration::from_secs(120))
            .map_err(|_| AudioError::Internal("load timed out".into()))?
    }

    pub fn load_async(&self, spec: AudioSourceSpec, autoplay: bool) {
        let _ = self.tx.send(Cmd::Load {
            spec,
            autoplay,
            reply: None,
        });
    }

    pub fn play(&self) {
        let _ = self.tx.send(Cmd::Play);
    }

    pub fn pause(&self) {
        let _ = self.tx.send(Cmd::Pause);
    }

    pub fn seek(&self, sec: f64) {
        let _ = self.tx.send(Cmd::Seek(sec));
    }

    pub fn set_volume(&self, v: f32) {
        let _ = self.tx.send(Cmd::SetVolume(v));
    }

    /// 设置播放速率（1.0 = 原速）。0.5~2.0 是给"练习模式"用的量程，
    /// 这里放到 0.25~4.0 只是给调试留余量。
    pub fn set_rate(&self, r: f64) {
        let _ = self.tx.send(Cmd::SetRate(r));
    }

    /// 当前播放速率（读原子，不经过控制线程）。
    pub fn rate(&self) -> f64 {
        read_rate(&self.shared)
    }

    /// 应用均衡器设置（10 段增益 + 总开关）。
    /// 换曲/换设备都不会重置 EQ —— 它是**跨曲目**的用户偏好。
    pub fn set_eq(&self, s: EqSettings) {
        let _ = self.tx.send(Cmd::SetEq(s));
    }

    /// 当前 EQ 设置（诊断/回显用）。
    pub fn eq_settings(&self) -> EqSettings {
        self.shared.eq.lock().map(|g| *g).unwrap_or_default()
    }

    /// 应用空间处理设置（空间音频 HRTF + 虚拟声场）。跨曲目保持，与 EQ 同理。
    pub fn set_spatial(&self, s: SpatialSettings) {
        let _ = self.tx.send(Cmd::SetSpatial(s));
    }

    /// 当前空间处理设置（诊断/回显用）。
    pub fn spatial_settings(&self) -> SpatialSettings {
        self.shared.spatial.lock().map(|g| *g).unwrap_or_default()
    }

    pub fn set_output(&self, cfg: OutputConfig) {
        let _ = self.tx.send(Cmd::SetOutput(cfg));
    }

    /// 交还输出设备：停掉输出线程、丢掉队列，让端点回到「无人占用」。
    ///
    /// ★ 为什么必须有这个命令：WASAPI **独占**要求端点空闲，而引擎一旦
    ///   打开过输出就会一直持有它（共享模式也一样）。前端关掉原生输出后再
    ///   打开时，如果引擎还占着设备，独占 `Initialize` 会直接返回
    ///   AUDCLNT_E_DEVICE_IN_USE ——表现是「同一个开关第二次就点不亮了」。
    ///   顺带的好处：用户不用原生输出时，设备交还出去，别的播放器才能拿独占。
    ///
    /// 只停输出与队列，**不销毁控制线程**：引擎仍可继续 load/play，
    /// 下一次 Load 会按 `pending_output` 重新开设备。
    pub fn release_output(&self) {
        let _ = self.tx.send(Cmd::ReleaseOutput);
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Cmd::Shutdown);
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let s = &self.shared;
        let rate = s.src_rate.load(Ordering::Relaxed).max(1);
        let info = s.info.lock().ok().and_then(|g| g.clone());
        let mode = s.output_mode.lock().map(|g| *g).unwrap_or(OutputMode::Shared);
        let sample_format = s
            .sample_format
            .lock()
            .map(|g| *g)
            .unwrap_or(OutputSampleFormat::F32);
        /* 队列指标从活动 ring 现取。刻意不缓存到 Shared 的原子里：
           ring 会随换曲整个替换，缓存值就需要在两个地方同步更新，
           而这类"两份真相"正是最难查的一类 bug。 */
        let (buffered, underruns) = s
            .ring
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|r| (r.available_frames(), r.underrun_frames())))
            .unwrap_or((0, 0));
        /* ★★ 位置换算（rate≠1 时必须这样算，否则进度条只会走到 1/rate）：
           `played_frames` 是**设备帧**；设备帧与源帧差一个 rate 因子，而且 rate 中途可变，
           所以不能简单地 played×rate —— 那在"听了 60s 再改成 2×"之后会算出 150s。
           正确做法是拿**源帧口径的产量**减去"还在路上的那部分"：
             produced   = 已推入 ring 的输出帧总数 = 已被取走(written) + 仍在队列(buffered)
             in_flight  = produced - played            （= 队列里 + 设备缓冲里还没播的）
             src_played = src_advanced - in_flight×rate
           同速率下与旧公式 `played/rate` **逐位等价**（rate=1 时 src_advanced≡produced），
           跨速率变化也连续正确。 */
        let rate_now = read_rate(s);
        let written = s.frames_written.load(Ordering::Relaxed);
        let played = s.played_frames.load(Ordering::Relaxed);
        let src_adv = s.src_frames_advanced.load(Ordering::Relaxed);
        let produced = written.saturating_add(buffered as u64);
        let in_flight = produced.saturating_sub(played);
        let src_played = src_adv.saturating_sub((in_flight as f64 * rate_now).round() as u64);
        EngineSnapshot {
            playing: s.playing.load(Ordering::Relaxed),
            ended: s.ended.load(Ordering::Relaxed),
            position_sec: src_played as f64 / rate as f64,
            duration_sec: info.as_ref().and_then(|i| i.duration_sec),
            sample_rate: rate,
            rate: rate_now,
            volume: s.volume(),
            buffered_frames: buffered,
            underruns,
            decoding: s.decoding.load(Ordering::Relaxed),
            track: info,
            output_mode: mode,
            sample_format,
            last_error: s.last_error.lock().ok().and_then(|g| g.clone()),
        }
    }
}

/* ============================ 控制线程 ============================ */

/// 控制线程持有的活动资源。换曲时整体重建。
struct Live {
    ring: Arc<SampleRing>,
    seek_tx: Sender<f64>,
    decode_join: Option<JoinHandle<()>>,
    output_join: Option<JoinHandle<()>>,
}

fn control_loop(rx: Receiver<Cmd>, shared: Arc<Shared>) {
    let mut live: Option<Live> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Cmd::Load {
                spec,
                autoplay,
                reply,
            }) => {
                teardown(&mut live, &shared);
                let r = do_load(&spec, autoplay, &shared, &mut live);
                if let Some(ch) = reply {
                    let _ = ch.send(r);
                }
            }
            Ok(Cmd::Play) => {
                shared.playing.store(true, Ordering::SeqCst);
                shared.ended.store(false, Ordering::SeqCst);
            }
            Ok(Cmd::Pause) => {
                shared.playing.store(false, Ordering::SeqCst);
            }
            Ok(Cmd::Seek(sec)) => {
                if let Some(l) = &live {
                    let rate = shared.src_rate.load(Ordering::Relaxed).max(1) as f64;
                    let frames = (sec.max(0.0) * rate) as u64;
                    l.ring.clear();
                    shared.frames_written.store(frames, Ordering::SeqCst);
                    shared.played_frames.store(frames, Ordering::SeqCst);
                    shared.ended.store(false, Ordering::SeqCst);
                    shared.decoding.store(true, Ordering::SeqCst);
                    let _ = l.seek_tx.send(sec.max(0.0));
                }
            }
            Ok(Cmd::SetVolume(v)) => {
                let v = v.clamp(0.0, 1.0);
                shared
                    .volume_bits
                    .store(v.to_bits(), Ordering::Relaxed);
            }
            Ok(Cmd::SetRate(r)) => {
                /* 与 SetEq 同理：IPC 是不可信输入。NaN/Inf 传进重采样会让
                   `pos += rate` 立刻变成 NaN，此后**每一帧**都读不出数据、
                   解码线程原地空转（听感=永久静音）。在这里挡掉最便宜。 */
                let r = if r.is_finite() {
                    r.clamp(MIN_RATE, MAX_RATE)
                } else {
                    1.0
                };
                shared.rate_bits.store(r.to_bits(), Ordering::Relaxed);
            }
            Ok(Cmd::SetEq(s)) => {
                let mut clean = s;
                for g in clean.gains_db.iter_mut() {
                    if !g.is_finite() {
                        /* IPC 是不可信输入：NaN 传进系数设计会让整条链输出 NaN，
                           而 NaN 一旦进入滤波器状态就永久残留（可听见的持续静音
                           或噪声）。在这里挡掉，比在 DSP 里每样本判一次便宜得多。 */
                        *g = 0.0;
                    }
                }
                if let Ok(mut g) = shared.eq.lock() {
                    *g = clean;
                }
                shared.eq_version.fetch_add(1, Ordering::SeqCst);
            }
            Ok(Cmd::SetSpatial(s)) => {
                /* 档位/IR 用 u8 索引表达。IPC 是不可信输入，索引可能越界——
                   DSP 侧（spatial.rs `apply`）对越界索引一律回落缺省档、不 panic，
                   所以这里只做「存 + 递增版本号」，不重复校验。 */
                if let Ok(mut g) = shared.spatial.lock() {
                    *g = s;
                }
                shared.spatial_version.fetch_add(1, Ordering::SeqCst);
            }
            Ok(Cmd::SetOutput(cfg)) => {
                /* ★ 顺序不能反：restart_output 是**读 pending_output** 去开设备的。
                   先重开再记录选择的话，本次改动要等下一首 Load 才生效
                   ——「切了输出设备却听不出任何变化」正是这么来的。 */
                if let Ok(mut g) = shared.pending_output.lock() {
                    *g = Some(cfg.clone());
                }
                let had_live = live.is_some();
                /* 改设备 = 重开输出线程。若正在播放，保持播放状态继续
                   （新线程从队列里接着取，听感是几毫秒的断点，不是重新开始）。 */
                restart_output(&shared, &mut live);
                /* 没有在播曲目就没有输出线程可重开（restart_output 直接返回）：
                   此时如实记录意图，让设置面板能显示已选模式，
                   实际生效在下一首加载。开了的话上面那句已写入真实模式。 */
                if !had_live {
                    if let Ok(mut g) = shared.output_mode.lock() {
                        *g = cfg.mode;
                    }
                }
            }
            Ok(Cmd::ReleaseOutput) => {
                /* 交还设备（见 AudioEngine::release_output）。除停线程外还要清掉
                   「当前曲目」——设备都没了却还报 hasTrack=true，
                   前端会一直以为歌还在、rAF 循环也跟着跑。 */
                teardown(&mut live, &shared);
                if let Ok(mut g) = shared.info.lock() {
                    *g = None;
                }
                shared.decoding.store(false, Ordering::SeqCst);
                shared.ended.store(false, Ordering::SeqCst);
            }
            Ok(Cmd::Shutdown) => {
                shared.playing.store(false, Ordering::SeqCst);
                teardown(&mut live, &shared);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                teardown(&mut live, &shared);
                return;
            }
        }
    }
}

/* ============================ 加载 ============================ */

fn do_load(
    spec: &AudioSourceSpec,
    autoplay: bool,
    shared: &Arc<Shared>,
    live: &mut Option<Live>,
) -> Result<TrackInfo> {
    shared.clear_error();
    let stream = source::open(spec)?;
    let hint_path = match spec {
        AudioSourceSpec::File(p) => Some(p.as_path()),
        AudioSourceSpec::Http { .. } => None,
    };
    let decoder = Decoder::open(stream, hint_path)?;
    let info = decoder.info();

    let gen = shared.gen.fetch_add(1, Ordering::SeqCst) + 1;
    shared.src_rate.store(info.sample_rate, Ordering::SeqCst);
    shared
        .duration_ms
        .store((info.duration_sec.unwrap_or(0.0) * 1000.0) as u64, Ordering::SeqCst);
    shared.frames_written.store(0, Ordering::SeqCst);
    shared.played_frames.store(0, Ordering::SeqCst);
    shared.src_frames_advanced.store(0, Ordering::SeqCst);
    shared.ended.store(false, Ordering::SeqCst);
    shared.decoding.store(true, Ordering::SeqCst);
    if let Ok(mut g) = shared.info.lock() {
        *g = Some(info.clone());
    }

    let ring = Arc::new(SampleRing::new(CHANNELS, RING_FRAMES));
    if let Ok(mut g) = shared.ring.lock() {
        *g = Some(ring.clone());
    }

    /* 输出：用**源采样率**打开。共享模式靠 autoconvert 让系统转采样率，
       因此不需要引擎里有个重采样器；独占模式（Phase 3）则正好是直通。 */
    let cfg = shared
        .pending_output
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(OutputConfig {
            sample_rate: info.sample_rate,
            ..Default::default()
        });
    let out_cfg = OutputConfig {
        sample_rate: info.sample_rate,
        ..cfg
    };
    let mut output = WasapiOutput::open(&out_cfg)?;
    if let Ok(mut g) = shared.output_mode.lock() {
        *g = output.mode();
    }
    /* 独占下这个值由驱动协商决定（可能是 s24，也可能退到 s16），
       前端据此告诉用户"当前是不是真的比特完美"。 */
    if let Ok(mut g) = shared.sample_format.lock() {
        *g = output.sample_format();
    }
    output.start()?;

    let (seek_tx, seek_rx) = channel::<f64>();
    let out_join = spawn_output(output, ring.clone(), shared.clone(), gen);
    let dec_join = spawn_decode(decoder, ring.clone(), shared.clone(), gen, seek_rx);

    *live = Some(Live {
        ring,
        seek_tx,
        decode_join: Some(dec_join),
        output_join: Some(out_join),
    });
    shared.playing.store(autoplay, Ordering::SeqCst);
    Ok(info)
}

/// 换设备/换模式：只重建输出线程，解码不动。
fn restart_output(shared: &Arc<Shared>, live: &mut Option<Live>) {
    let Some(l) = live.as_mut() else { return };
    let rate = shared.src_rate.load(Ordering::Relaxed);
    let cfg = shared
        .pending_output
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(OutputConfig {
            sample_rate: rate,
            ..Default::default()
        });
    let out_cfg = OutputConfig {
        sample_rate: rate,
        ..cfg
    };
    let gen = shared.gen.fetch_add(1, Ordering::SeqCst) + 1;

    /* 先让旧输出线程自杀，再开新的：否则两个线程会同时从同一个 ring 抢数据。 */
    if let Some(h) = l.output_join.take() {
        let _ = h.join();
    }
    match WasapiOutput::open(&out_cfg) {
        Ok(mut output) => {
            /* ★ 把 start 的真实错误带出去：独占的失效原因（格式被拒 /
               端点不流动）全在这一句里，笼统写 "start_stream failed"
               会让设置面板只能显示"切换失败"，用户永远不知道该改什么。 */
            if let Err(e) = output.start() {
                shared.set_error(format!("reopen output: start failed: {}", e));
                return;
            }
            if let Ok(mut g) = shared.output_mode.lock() {
                *g = output.mode();
            }
            if let Ok(mut g) = shared.sample_format.lock() {
                *g = output.sample_format();
            }
            l.output_join = Some(spawn_output(output, l.ring.clone(), shared.clone(), gen));
        }
        Err(e) => shared.set_error(format!("reopen output failed: {}", e)),
    }
}

fn teardown(live: &mut Option<Live>, shared: &Arc<Shared>) {
    shared.gen.fetch_add(1, Ordering::SeqCst);
    shared.playing.store(false, Ordering::SeqCst);
    if let Ok(mut g) = shared.ring.lock() {
        *g = None;
    }
    if let Some(mut l) = live.take() {
        l.ring.close();
        if let Some(h) = l.decode_join.take() {
            let _ = h.join();
        }
        if let Some(h) = l.output_join.take() {
            let _ = h.join();
        }
    }
}

/* ============================ 输出线程 ============================ */

fn spawn_output(
    mut output: WasapiOutput,
    ring: Arc<SampleRing>,
    shared: Arc<Shared>,
    my_gen: u64,
) -> JoinHandle<()> {
    spawn(move || {
        let chunk = output.max_chunk_frames();
        let mut buf = vec![0.0f32; chunk * CHANNELS];
        /* EQ 链活在输出线程内：状态（滤波器延迟线）不能被两条线程同时摸。
           u64::MAX 作为哨兵，保证第一块一定会去读一次真实设置。 */
        let mut eq = EqChain::new(output.sample_rate());
        let mut eq_ver = u64::MAX;
        /* 空间处理链（HRTF + 虚拟声场）活在输出线程内，理由与 EQ 相同：
           状态（FIR 历史 / Haas 延迟线）不能被两条线程同时摸。 */
        let mut spatial = SpatialChain::new(output.sample_rate());
        let mut spatial_ver = u64::MAX;

        /* ★ 起播预填充已移进 `WasapiOutput::start()`（在 Start 之前完成）。
           这里**不能**再填一次：那时缓冲已经是满的，available_space 为 0，
           再填等于什么都没做；而若写成"无论可用空间都填一个整缓冲"，
           就会在设备正在消费时把它顶满，反而造成一次 underrun。 */

        while shared.gen.load(Ordering::SeqCst) == my_gen {
            /* 等设备事件（200ms 超时只是为了让循环能定期检查 gen/暂停状态）。
               ★ 超时不是错误：它意味着这段时间设备缓冲一直有空间没被消耗，
               可能正因为暂停。绝不能因此退出循环。 */
            let _ = output.wait_event(200);
            if shared.gen.load(Ordering::SeqCst) != my_gen {
                break;
            }

            let space = match output.available_space_frames() {
                Ok(s) => s as usize,
                Err(e) => {
                    /* 设备被拔/被独占/端点失效：记一次错就退出，由上层决定
                       是否回退到默认设备（不要在这里自动重试，会掩盖真因）。 */
                    shared.set_error(format!("output device lost: {}", e));
                    break;
                }
            };
            if space == 0 {
                continue;
            }
            let frames = space.min(chunk);

            let playing = shared.playing.load(Ordering::SeqCst);
            let written = shared.frames_written.load(Ordering::SeqCst);
            let padding_before = output.padding_frames() as u64;

            if !playing {
                /* 暂停：写静音把设备"喂住"（避免 stop/start 的爆音与开销），
                   但不推进 frames_written，也不动已播位置——
                   恢复时就从同一位置继续。 */
                let _ = output.write_silence(frames);
                shared
                    .played_frames
                    .store(written.saturating_sub(padding_before), Ordering::SeqCst);
                continue;
            }

            /* EQ 参数只在版本变化时读取（见 Shared::eq_version 注释）：
               稳态下这行只是两个原子读，不进锁。 */
            let ver = shared.eq_version.load(Ordering::Relaxed);
            if ver != eq_ver {
                if let Ok(s) = shared.eq.lock() {
                    eq.apply(&s);
                }
                eq_ver = ver;
            }
            /* 空间处理设置同样按版本号读（稳态下只是两个原子读，不进锁）。 */
            let sver = shared.spatial_version.load(Ordering::Relaxed);
            if sver != spatial_ver {
                if let Ok(s) = shared.spatial.lock() {
                    spatial.apply(&s);
                }
                spatial_ver = sver;
            }

            let got = ring.pop_into(&mut buf[..frames * CHANNELS]);
            /* 只处理真正取到数据的那些帧：underrun 补的静音过 EQ/空间处理
               毫无意义，而且会让滤波器状态多跑一遍无谓的激励。 */
            if got > 0 {
                eq.process_interleaved(&mut buf[..got * CHANNELS]);
                /* ★ 空间处理紧跟在 EQ 之后、音量之前 —— 顺序必须与 Web 侧一致
                   （见 dsp/mod.rs 的链序声明与 spatial.rs 文件头）。 */
                spatial.process_interleaved(&mut buf[..got * CHANNELS]);
            }
            let vol = shared.volume();
            if (vol - 1.0).abs() > f32::EPSILON {
                for s in buf[..frames * CHANNELS].iter_mut() {
                    *s *= vol;
                }
            }
            if let Err(e) = output.write_f32(frames, &buf[..frames * CHANNELS]) {
                shared.set_error(format!("write_to_device failed: {}", e));
                break;
            }
            shared
                .frames_written
                .store(written + frames as u64, Ordering::SeqCst);

            /* 时钟：已播 = 已写入(不含本次) − 缓冲中未播。
               本批刚写入的 frames 还没播出去，且 padding 读的是写入前的值，
               两者互相抵消——所以直接用 written 而不是 written+frames。 */
            shared
                .played_frames
                .store(written.saturating_sub(padding_before), Ordering::SeqCst);

            /* 曲终判定：队列取空 **且** 解码线程已到 EOF。
               只判队列空会把"解码一时跟不上"误判成播完，触发提前切歌。 */
            if got == 0 && !shared.decoding.load(Ordering::SeqCst) {
                shared.ended.store(true, Ordering::SeqCst);
                shared.playing.store(false, Ordering::SeqCst);
            }
        }
    })
}

/* ============================ 解码线程 ============================ */

/**
 * 分数重采样：按 `rate` 把 `src` 里的源帧抽成输出帧写进 `out`。
 * `pos` 是**跨批保留**的浮点源帧位置（相对 `src` 起点）——
 * 变速时每产出一帧 `pos += rate`：rate>1 走得快（变短），rate<1 走得慢（拉长）。
 * 线性插值 ⇒ **音色随速度变化**（黑胶/磁带那种），所以 Web 侧练习模式必须
 * 同步把 `preservesPitch` 置 false，否则两条路径听感不一致。
 *
 * 返回产出的输出帧数；缓冲里不足 2 帧（没有插值需要的下一帧）时返回 0。
 * ★ 抽成自由函数是为了能在无音频设备的环境里单测（CI 没有 WASAPI 设备）。
 */
fn resample_into(src: &[f32], pos: &mut f64, rate: f64, max_out: usize, out: &mut Vec<f32>) -> usize {
    let frames = src.len() / CHANNELS;
    let mut produced = 0usize;
    while produced < max_out {
        if !pos.is_finite() || *pos < 0.0 {
            *pos = 0.0;
        }
        let i = *pos as usize;
        if i + 1 >= frames {
            break;
        }
        let f = (*pos - i as f64) as f32;
        let a = i * CHANNELS;
        let b = a + CHANNELS;
        for c in 0..CHANNELS {
            let s0 = src[a + c];
            out.push(s0 + (src[b + c] - s0) * f);
        }
        *pos += rate;
        produced += 1;
    }
    produced
}

/**
 * ★★ 变速就落在这里 —— 解码 → ring 之间，**设备侧一个字节都不用改**。
 *
 * 为什么不在输出线程里改读指针：设备是以 `src_rate` 打开的（见 load 里的注释），
 * 输出环路只负责 `ring.pop_into()` 填设备缓冲、并维护 `frames_written/played_frames`
 * （设备帧口径）与曲终判定。若把重采样塞进输出线程，就要在那条实时路径上同时
 * 处理"读指针跨块""under-run 补偿"，还要把位置/seek 的换算全部跟着改一遍。
 * 放在解码侧则天然成立：源帧被按 rate 抽稀/插密后**仍以 src_rate 交付**，
 * 于是 ring、设备、seek、`frames_written` 的语义全部不变，
 * 唯一需要补的就是"源帧位置"另记一笔（`src_frames_advanced`）。
 */
fn spawn_decode(
    mut decoder: Decoder,
    ring: Arc<SampleRing>,
    shared: Arc<Shared>,
    my_gen: u64,
    seek_rx: Receiver<f64>,
) -> JoinHandle<()> {
    spawn(move || {
        /* 源帧缓冲（交错，跨批保留：末尾那 1 帧还要用于插值） */
        let mut raw: Vec<f32> = Vec::with_capacity(1 << 16);
        /* 重采样后的输出缓冲（跨批保留：ring 满时没推完的尾巴留在这里） */
        let mut out: Vec<f32> = Vec::with_capacity(1 << 16);
        let mut out_pos = 0usize; // out 里已推入 ring 的**样本数**
        let mut pos = 0.0f64; // 重采样器在 raw 上的浮点帧位置
        let mut batch_rate = 1.0f64; // 本批输出所用的速率（推送时按它换算源帧）
        let mut eof = false;
        /* 源帧推进的小数累加器：原子是 u64，小数部分留在这儿，
           否则 rate=1.5 这类非整数速率会因为每批取整而持续漏算。 */
        let mut adv_frac = 0.0f64;

        while shared.gen.load(Ordering::SeqCst) == my_gen && !ring.is_closed() {
            /* ① 命令优先：seek 必须最先响应，否则用户会听到"拖了但没动" */
            let mut did_seek = false;
            while let Ok(sec) = seek_rx.try_recv() {
                if let Err(e) = decoder.seek(sec) {
                    shared.set_error(format!("seek failed: {}", e));
                }
                raw.clear();
                out.clear();
                out_pos = 0;
                pos = 0.0;
                eof = false;
                adv_frac = 0.0;
                /* 源帧位置重新锚定到 seek 目标。
                   ★ 本原子**只由本线程写**（单写者），控制线程那边只动
                   `frames_written/played_frames`（设备帧口径），两者不交叉。 */
                let sr = shared.src_rate.load(Ordering::Relaxed).max(1) as f64;
                shared
                    .src_frames_advanced
                    .store((sec.max(0.0) * sr) as u64, Ordering::SeqCst);
                did_seek = true;
            }
            if did_seek {
                shared.decoding.store(true, Ordering::SeqCst);
            }

            /* ② 暂停时不推进解码：继续灌数据只会把队列填满然后干等 */
            if !shared.playing.load(Ordering::SeqCst) {
                sleep(Duration::from_millis(10));
                continue;
            }

            /* ③ 上一批推完了 → 备新的一批 */
            if out_pos >= out.len() {
                /* 丢掉重采样器已经走过去的整帧，让 `pos` 回到 [0,1)。
                   ★ 这一步也保证 `raw` 不会无限增长：每批至少丢掉本批消费掉的源帧。
                   丢了之后 `pos -= 实际丢掉的帧数`（用 clamp 后的值相减，
                   否则下溢会让位置倒退）。 */
                let drop_frames = pos.floor().max(0.0) as usize;
                if drop_frames > 0 {
                    let drop_samples = (drop_frames * CHANNELS).min(raw.len());
                    raw.drain(0..drop_samples);
                    pos -= (drop_samples / CHANNELS) as f64;
                }
                /* 插值至少要 2 帧；不足就再解一个 packet（next_chunk 只追加，不清空） */
                if raw.len() / CHANNELS < 2 && !eof {
                    match decoder.next_chunk(&mut raw) {
                        Ok(0) => eof = true,
                        Ok(_) => {}
                        Err(e) => {
                            shared.set_error(format!("decode failed: {}", e));
                            shared.decoding.store(false, Ordering::SeqCst);
                            sleep(Duration::from_millis(50));
                            continue;
                        }
                    }
                }
                out.clear();
                out_pos = 0;
                batch_rate = read_rate(&shared);
                let got = resample_into(&raw, &mut pos, batch_rate, RESAMPLE_BATCH_FRAMES, &mut out);
                if got == 0 {
                    /* 产不出东西：要么源已见底，要么数据还没到。
                       ★ 必须 sleep，否则会变成 busy loop 把一个核跑满。 */
                    if eof {
                        /* EOF：解码结束。输出线程据此判定曲终。 */
                        shared.decoding.store(false, Ordering::SeqCst);
                        sleep(Duration::from_millis(30));
                    } else {
                        sleep(Duration::from_millis(5));
                    }
                    continue;
                }
            }

            /* ④ 非阻塞推入：队列满就 sleep 重试，保证命令响应延迟在毫秒级 */
            let frames = ring.push_some(&out[out_pos..]);
            if frames == 0 {
                sleep(Duration::from_millis(2));
            } else {
                out_pos += frames * CHANNELS;
                /* 源帧推进按**实际推入**的输出帧换算（N×rate），这样它与
                   ring/设备侧的 in-flight 口径严格对齐；若按"重采样器已消费"计，
                   会领先一个批次，进度条会周期性前跳。 */
                adv_frac += frames as f64 * batch_rate;
                let whole = adv_frac.floor();
                if whole >= 1.0 {
                    shared
                        .src_frames_advanced
                        .fetch_add(whole as u64, Ordering::Relaxed);
                    adv_frac -= whole;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 引擎在没有音频设备的环境（CI）里也应该能构造出来——
    /// 真正的设备交互发生在 load 阶段，构造本身不该触碰硬件。
    #[test]
    fn engine_constructs_and_reports_default_state() {
        let e = AudioEngine::new().expect("engine");
        let s = e.snapshot();
        assert!(!s.playing);
        assert_eq!(s.volume, 1.0);
        assert!(s.track.is_none());
        assert!(s.last_error.is_none());
    }

    /// 未加载任何曲目时交还设备：不能 panic，且快照要回到「无曲目、未播放」。
    /// 这条命令存在的理由是独占模式要求端点空闲（见 AudioEngine::release_output），
    /// 所以「什么都不持有时调用它是安全的」必须钉住——用户可能在从没播过歌的
    /// 情况下打开又关掉独占开关。
    #[test]
    fn release_output_is_safe_without_a_loaded_track() {
        let e = AudioEngine::new().expect("engine");
        e.release_output();
        for _ in 0..50 {
            let s = e.snapshot();
            if !s.playing && !s.ended && !s.decoding && s.track.is_none() {
                return;
            }
            sleep(Duration::from_millis(10));
        }
        let s = e.snapshot();
        panic!(
            "release_output left stale state: playing={} ended={} decoding={} has_track={}",
            s.playing,
            s.ended,
            s.decoding,
            s.track.is_some()
        );
    }

    #[test]
    fn volume_clamps_and_is_visible_in_snapshot() {
        let e = AudioEngine::new().expect("engine");
        e.set_volume(0.42);
        /* 命令是异步的：给它一点时间穿过控制线程 */
        for _ in 0..50 {
            if (e.snapshot().volume - 0.42).abs() < 1e-6 {
                return;
            }
            sleep(Duration::from_millis(10));
        }
        panic!("volume not applied, got {}", e.snapshot().volume);
    }

    #[test]
    fn volume_out_of_range_is_clamped() {
        let e = AudioEngine::new().expect("engine");
        e.set_volume(5.0);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().volume, 1.0);
        e.set_volume(-2.0);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().volume, 0.0);
    }

    #[test]
    fn load_missing_file_reports_source_failed() {
        let e = AudioEngine::new().expect("engine");
        let r = e.load_blocking(
            AudioSourceSpec::file("D:/definitely/not/here/nope.mp3"),
            false,
        );
        match r {
            Err(AudioError::SourceFailed(_)) => {}
            other => panic!("expected SourceFailed, got {:?}", other),
        }
    }

    /* ---------- 变速（重采样）单测 ----------
       ★ 这些测的是 `resample_into` + 调用方的「跨批丢帧」组合——
         真正会出错的从来不是单批插值，而是**批与批之间**的接缝：
         位置没保留就会每批丢一帧（听感是规律的咔哒），
         丢帧算错就会整段漂移。所以用 `drain_batches` 复刻调用方逻辑。 */

    /// 复刻 `spawn_decode` 里「丢整帧 → 重采样」的批次循环（不含 ring/EOF）。
    fn drain_batches(src: &[f32], rate: f64, batch: usize) -> Vec<f32> {
        let mut raw = src.to_vec();
        let mut pos = 0.0f64;
        let mut out = Vec::new();
        let mut guard = 0;
        loop {
            guard += 1;
            assert!(guard < 10_000, "批次循环没有收敛");
            let drop_frames = pos.floor().max(0.0) as usize;
            if drop_frames > 0 {
                let n = (drop_frames * CHANNELS).min(raw.len());
                raw.drain(0..n);
                pos -= (n / CHANNELS) as f64;
            }
            if resample_into(&raw, &mut pos, rate, batch, &mut out) == 0 {
                break;
            }
        }
        out
    }

    /// 构造一段确定性的双声道斜坡信号（L = i，R = -i）
    fn ramp(frames: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(frames * CHANNELS);
        for i in 0..frames {
            v.push(i as f32);
            v.push(-(i as f32));
        }
        v
    }

    /// rate=1 必须**逐样本恒等**（原速播放不能因为引入重采样而变味）。
    /// ★ 末尾会少 1 帧：线性插值要用"下一帧"，源见底时就没有下一帧了
    ///   （1/48000 s = 20µs，听不出来，但断言必须写对，否则会误判成 bug）。
    #[test]
    fn resample_at_rate_one_is_bit_exact() {
        let src = ramp(200);
        for batch in [1usize, 7, 64, 8192] {
            let out = drain_batches(&src, 1.0, batch);
            assert_eq!(
                out.len(),
                src.len() - CHANNELS,
                "batch={} 帧数不一致",
                batch
            );
            assert_eq!(out[..], src[..out.len()], "batch={} rate=1 不是恒等", batch);
        }
    }

    /// rate=2 抽稀成一半、rate=0.5 插密成两倍（各允许末尾 1 帧的取整余量）。
    #[test]
    fn resample_scales_frame_count() {
        let frames = 400usize;
        let src = ramp(frames);
        let fast = drain_batches(&src, 2.0, 32);
        let slow = drain_batches(&src, 0.5, 32);
        let expect_fast = (frames as f64 / 2.0).round() as i64;
        let expect_slow = (frames as f64 / 2.0).round() as i64 * 2;
        assert!(
            (fast.len() as i64 / CHANNELS as i64 - expect_fast).abs() <= 1,
            "rate=2 帧数 {} 应约为 {}",
            fast.len() / CHANNELS,
            expect_fast
        );
        assert!(
            (slow.len() as i64 / CHANNELS as i64 - expect_slow).abs() <= 2,
            "rate=0.5 帧数 {} 应约为 {}",
            slow.len() / CHANNELS,
            expect_slow
        );
    }

    /// rate=0.5（拉长一倍）时相邻输出帧应是「原值 / 中点」交替 —— 线性插值生效。
    #[test]
    fn resample_half_rate_interpolates_midpoints() {
        let src = ramp(8);
        let out = drain_batches(&src, 0.5, 8192);
        /* L 声道：0, 0.5, 1, 1.5, 2 … */
        for k in 0..6 {
            let got = out[k * CHANNELS];
            let want = k as f32 * 0.5;
            assert!((got - want).abs() < 1e-4, "第 {} 帧 L={} 期望 {}", k, got, want);
        }
    }

    /// 跨批接缝不能丢帧/重复：小批量与大单批的**样本总数**必须一致。
    #[test]
    fn resample_batch_boundary_loses_nothing() {
        let src = ramp(500);
        let one = drain_batches(&src, 1.0, 100_000);
        for batch in [1usize, 3, 17, 101] {
            let many = drain_batches(&src, 1.0, batch);
            assert_eq!(
                many.len(),
                one.len(),
                "batch={} 的接缝丢了/多了样本",
                batch
            );
            assert_eq!(many, one, "batch={} 跨批结果与单批不一致", batch);
        }
    }

    /// 非法速率必须被夹到合法区间，并原样反映到 snapshot（前端据此显示）。
    #[test]
    fn rate_is_clamped_and_visible_in_snapshot() {
        let e = AudioEngine::new().expect("engine");
        assert_eq!(e.snapshot().rate, 1.0, "默认应为原速");

        e.set_rate(1.5);
        sleep(Duration::from_millis(60));
        assert!((e.snapshot().rate - 1.5).abs() < 1e-9);

        e.set_rate(99.0);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().rate, MAX_RATE, "越界应夹到 MAX_RATE");

        e.set_rate(-1.0);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().rate, MIN_RATE, "负数应夹到 MIN_RATE");

        /* ★ NaN/Inf 是最要命的一种「IPC 不可信输入」：不在这里挡掉，
           重采样器的 `pos += rate` 会立刻变 NaN，此后每帧都读不出数据，
           解码线程原地空转 = 永久静音。 */
        e.set_rate(f64::NAN);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().rate, 1.0, "NaN 应回落到原速");

        e.set_rate(f64::INFINITY);
        sleep(Duration::from_millis(60));
        assert_eq!(e.snapshot().rate, 1.0, "Inf 应回落到原速");
    }
}
