//! 原生音频引擎的 Tauri IPC 层（原生输出线 Phase 2b）。
//!
//! 职责边界很窄：**只做「IPC 契约」与「字符串 ↔ 引擎类型」的翻译**。
//! 所有音频逻辑都在 `aria-audio` crate 里，这里一行 DSP 都不写。
//! 这样引擎能继续用 `audio-probe` 脱离 WebView2 单独验证，而 IPC 层可以
//! 整个删掉换成别的宿主（CLI/测试）而不影响引擎。
//!
//! ## 时钟契约（前端 nativeDeck 必须遵守，否则逐字歌词会抖）
//!
//! 引擎以 20Hz 推送 `position_sec`；前端 rAF 每帧用 `performance.now()`
//! 线性插值、每次收到新推送就重锚定。**绝不要逐帧 invoke** ——
//! Tauri IPC 是 JSON over 消息循环，60fps 调用会把主线程压满。
//!
//! ## 为什么 load 是"发完就返回"
//!
//! 在线曲目的加载包含一次 HTTP 拉全曲（可能数秒）。做成 await 会让这条 IPC
//! 挂住几秒，而前端在等待期间既拿不到进度也发不出取消。所以 `native_audio_load`
//! 只把命令投进引擎就返回，加载结果由前端**本来就在做**的 20Hz snapshot 轮询
//! 发现（`track` 由 None 变 Some = loadedmetadata，`last_error` 出现 = error）。

use std::sync::Mutex;

use aria_audio::{
    check_exclusive_usable, list_output_devices, AudioEngine, AudioSourceSpec, EqSettings,
    OutputConfig, OutputMode, OutputSampleFormat, SpatialSettings, DEFAULT_BACKEND_BASE,
    IR_DEFAULT, IR_ORDER, SPATIAL_DEFAULT, SPATIAL_LEVELS, STAGE_DEFAULT, STAGE_LEVELS,
};
use serde::{Deserialize, Serialize};
use tauri::State;

/// 引擎句柄。**懒创建**：构造本身不碰硬件（见 engine.rs 的单测），
/// 但没必要在用户从没用过原生输出时白起一条控制线程。
pub struct NativeAudioState {
    engine: Mutex<Option<AudioEngine>>,
}

impl NativeAudioState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(None),
        }
    }
}

impl Default for NativeAudioState {
    fn default() -> Self {
        Self::new()
    }
}

fn engine_of(state: &NativeAudioState) -> Result<AudioEngine, String> {
    let mut guard = state
        .engine
        .lock()
        .map_err(|_| "native audio state poisoned".to_string())?;
    if let Some(e) = guard.as_ref() {
        return Ok(e.clone());
    }
    let e = AudioEngine::new().map_err(|e| e.to_string())?;
    *guard = Some(e.clone());
    Ok(e)
}

/* ============================ DTO ============================ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    /// 引擎能不能用。注意：**这只表示"原生引擎这条链路存在"**，
    /// 不代表独占能用——那要 `native_audio_check_exclusive` 实地试。
    pub available: bool,
    pub mode: String,
    pub sample_format: String,
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDto {
    pub sample_rate: u32,
    pub channels: usize,
    /// "f32" / "s24" / "s16"
    pub format: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDto {
    pub playing: bool,
    pub ended: bool,
    pub position_sec: f64,
    pub duration_sec: Option<f64>,
    pub sample_rate: u32,
    /// 当前播放速率（1.0 = 原速）。前端显示 + 诊断用。
    pub rate: f64,
    pub volume: f32,
    pub buffered_frames: usize,
    pub underruns: u64,
    pub decoding: bool,
    /// Some = 已加载到元数据（前端据此合成 loadedmetadata / durationchange）
    pub has_track: bool,
    pub track_name: Option<String>,
    pub output_mode: String,
    pub sample_format: String,
    pub last_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqDto {
    pub enabled: bool,
    /// 用 f64 而非 f32：引擎侧 `EqSettings::gains_db` 是 `[f64; 10]`，
    /// 且 JSON 数字本身就是双精度——中间夹一层 f32 只会白丢精度，
    /// 还会在赋值处多出一次显式转换（曾经就是这里报的 E0308）。
    pub gains_db: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDto {
    /// None / 空串 = 系统默认设备
    pub device_id: Option<String>,
    /// true = 独占
    pub exclusive: bool,
}

/// 空间处理设置（空间音频 HRTF + 虚拟声场）。
/// ★ 档位用**字符串**而不是索引：索引是引擎内部表示，把它暴露到 IPC
///   就等于把「表顺序」变成跨语言契约——将来在表中间插一档会静默错位。
///   字符串进引擎后由 `index_of` 翻译，未知值回落缺省档（不报错）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialDto {
    /// 空间音频（HRTF 卷积）总开关
    pub spatial_enabled: bool,
    /// "light" | "medium" | "strong"
    pub spatial_level: String,
    /// IR 预设 "near" | "hall" | "wide"
    pub ir: String,
    /// 虚拟声场总开关
    pub stage_enabled: bool,
    /// "light" | "medium"
    pub stage_level: String,
}

/// 档位名 → 表内索引。未知名字回落到 `default_name`，再不行才回 0。
/// 不报错：音频路径不该因为一个脏档位名而把功能整体打回去。
fn index_of(list: &[&str], name: &str, default_name: &str) -> u8 {
    list.iter()
        .position(|n| *n == name)
        .or_else(|| list.iter().position(|n| *n == default_name))
        .unwrap_or(0) as u8
}

/* ============================ 命令 ============================ */

#[tauri::command]
pub fn native_audio_status(state: State<'_, NativeAudioState>) -> StatusDto {
    match engine_of(&state) {
        Ok(e) => {
            let s = e.snapshot();
            StatusDto {
                available: true,
                mode: s.output_mode.label().to_string(),
                sample_format: s.sample_format.label().to_string(),
                reason: None,
            }
        }
        Err(reason) => StatusDto {
            available: false,
            mode: OutputMode::Shared.label().to_string(),
            sample_format: OutputSampleFormat::F32.label().to_string(),
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub fn native_audio_devices() -> Result<Vec<DeviceDto>, String> {
    list_output_devices()
        .map(|list| {
            list.into_iter()
                .map(|d| DeviceDto {
                    id: d.id,
                    name: d.name,
                    is_default: d.is_default,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

/// 独占可用的**端到端**检查（真的开一次、启动、确认端点消费）。
///
/// 这是设置面板在放行"独占"开关之前必须问的一道问题：本机实测存在
/// "驱动说支持、Initialize 成功、却永不出声"的组合，只看格式协商会给错结论。
/// 会短暂独占设备，因此是显式的用户动作（点开关）才调用。
///
/// 阻塞长达约 600ms（等端点消费的预算），所以走 spawn_blocking，
/// 不能堵住 Tauri 的消息循环——那会让整个界面卡住。
#[tauri::command]
pub async fn native_audio_check_exclusive(
    device_id: Option<String>,
    sample_rate: u32,
) -> Result<FormatDto, String> {
    let rate = if sample_rate == 0 { 44_100 } else { sample_rate };
    let handle = tauri::async_runtime::spawn_blocking(move || {
        check_exclusive_usable(device_id.as_deref(), rate, 2)
    });
    match handle.await {
        Ok(Ok(info)) => Ok(FormatDto {
            sample_rate: info.sample_rate,
            channels: info.channels,
            format: info.format.label().to_string(),
        }),
        Ok(Err(reason)) => Err(reason),
        Err(e) => Err(format!("exclusive probe task failed: {}", e)),
    }
}

/// 把前端给的 `src` 翻译成引擎的来源描述。
///
/// 前端拿到的 `src` 有四种形态，全部在这里收口（**不要在 JS 侧再判一次**，
/// 两份判断迟早会分叉）：
///   1. `/api/audio/stream?url=…&songId=…`（含可能的 origin 前缀）—— 正常在线曲，
///      **拆开**它自己的参数，别再套一层代理；
///   2. 绝对 `http(s)://…` —— 裸外链（本地后端不可用时的回退），交给本机后端代理；
///   3. 站内绝对路径（`/local_music/…`）—— 本地曲库，同样走后端代理；
///   4. Windows 路径 / `file://` —— 本地音乐。
///
/// 认不出的形态（`blob:` / `data:` 等）明确报错：原生引擎读不了内存 blob，
/// 让前端回退到 HTML 元素，比在这里猜一个错的 URL 好。
fn parse_src(src: &str) -> Result<AudioSourceSpec, String> {
    let s = src.trim();
    if s.is_empty() {
        return Err("empty src".into());
    }
    if let Some(rest) = s.strip_prefix("file://") {
        /* file:///D:/a.mp3 → /D:/a.mp3 → D:/a.mp3；UNC（file://server/share）
           不处理：本项目的本地音乐永远是本机盘符路径。 */
        let path = rest.trim_start_matches('/');
        return Ok(AudioSourceSpec::file(path));
    }
    if let Some(q) = s.find("/api/audio/stream?") {
        let base = if q == 0 {
            DEFAULT_BACKEND_BASE.to_string()
        } else {
            s[..q].trim_end_matches('/').to_string()
        };
        let query = &s[q + "/api/audio/stream?".len()..];
        let url = query_param(query, "url").ok_or_else(|| "stream url param missing".to_string())?;
        let song_id = query_param(query, "songId").unwrap_or_default();
        return Ok(AudioSourceSpec::Http {
            url,
            song_id,
            base,
        });
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return Ok(AudioSourceSpec::http(DEFAULT_BACKEND_BASE, s, s));
    }
    if s.starts_with('/') {
        /* 站内绝对路径：拼成绝对 URL 再交给后端代理，
           与 getStreamCachedAudioUrl 对裸外链的处理保持同一条链路。 */
        let abs = format!("{}{}", DEFAULT_BACKEND_BASE, s);
        return Ok(AudioSourceSpec::http(DEFAULT_BACKEND_BASE, &abs, s));
    }
    if s.len() > 2 && s.as_bytes()[1] == b':' {
        return Ok(AudioSourceSpec::file(s));
    }
    Err(format!(
        "native engine cannot play this src form: {}",
        &s[..s.len().min(48)]
    ))
}

/// 取查询串里的一个参数（百分号解码 + `+` 视为空格）。
/// 不引 url 库：这里只需要认自己后端生成的两种键。
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        if k != key {
            continue;
        }
        let v = it.next().unwrap_or("");
        return Some(percent_decode(&v.replace('+', " ")));
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    /* 非法 UTF-8 用替换字符而不是丢弃：宁可路径里多个问号，
       也不要静默把两条不同的路径解码成同一条。 */
    String::from_utf8_lossy(&out).into_owned()
}

/// 加载一首（**不阻塞**，见文件头注释）。`autoplay` 为真时加载完成即播放。
#[tauri::command]
pub fn native_audio_load(
    state: State<'_, NativeAudioState>,
    src: String,
    autoplay: bool,
) -> Result<(), String> {
    let spec = parse_src(&src)?;
    let engine = engine_of(&state)?;
    engine.load_async(spec, autoplay);
    Ok(())
}

#[tauri::command]
pub fn native_audio_play(state: State<'_, NativeAudioState>) -> Result<(), String> {
    engine_of(&state)?.play();
    Ok(())
}

#[tauri::command]
pub fn native_audio_pause(state: State<'_, NativeAudioState>) -> Result<(), String> {
    engine_of(&state)?.pause();
    Ok(())
}

#[tauri::command]
pub fn native_audio_seek(state: State<'_, NativeAudioState>, sec: f64) -> Result<(), String> {
    engine_of(&state)?.seek(sec.max(0.0));
    Ok(())
}

#[tauri::command]
pub fn native_audio_set_volume(state: State<'_, NativeAudioState>, volume: f32) -> Result<(), String> {
    engine_of(&state)?.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn native_audio_set_eq(state: State<'_, NativeAudioState>, eq: EqDto) -> Result<(), String> {
    let engine = engine_of(&state)?;
    let mut settings = EqSettings {
        enabled: eq.enabled,
        ..Default::default()
    };
    /* 段数是跨语言契约（core/equalizer.js 的 10 段）。数量对不上时宁可整体
       丢弃也不要错位赋值——错位会让"调 1kHz"实际动到 60Hz，而且听不出来。 */
    if eq.gains_db.len() == settings.gains_db.len() {
        for (dst, src) in settings.gains_db.iter_mut().zip(eq.gains_db.iter()) {
            /* NaN/Inf 在这里就挡掉：引擎层还有一道，但那道只保证"不炸"，
               这里挡掉能顺带把非法值从日志里暴露出来。 */
            let v = *src;
            *dst = if v.is_finite() { v } else { 0.0 };
        }
    }
    engine.set_eq(settings);
    Ok(())
}

/// 应用空间处理设置（空间音频 HRTF 卷积 + 虚拟声场 M/S 展宽）。
///
/// ★ 存在的意义：Web Audio 图在 WASAPI 独占下**整条不生效**（引擎由 Rust 接管），
///   所以独占时这两个功能必须由 Rust 侧承担，否则用户一开独占就"听不到空间音频"
///   且不知道原因（方案 §2.3）。Web 侧与 Rust 侧的参数/IR 来自**同一份生成数据**，
///   保证两条路径听感一致（方案 §5）。
#[tauri::command]
pub fn native_audio_set_spatial(
    state: State<'_, NativeAudioState>,
    spatial: SpatialDto,
) -> Result<(), String> {
    let engine = engine_of(&state)?;
    engine.set_spatial(SpatialSettings {
        spatial_on: spatial.spatial_enabled,
        spatial_level: index_of(&SPATIAL_LEVELS, &spatial.spatial_level, SPATIAL_DEFAULT),
        ir_index: index_of(&IR_ORDER, &spatial.ir, IR_DEFAULT),
        stage_on: spatial.stage_enabled,
        stage_level: index_of(&STAGE_LEVELS, &spatial.stage_level, STAGE_DEFAULT),
    });
    Ok(())
}

/// 设置播放速率（1.0 = 原速）。练习模式 / 变速用。
/// ★ 语义：**设备侧完全不动**（仍以源采样率打开），变速在引擎的「解码 → ring」
///   之间按 rate 重采样，所以它天然覆盖独占与共享两条路径。
/// ★ 音色：线性重采样 ⇒ **音色随速度变化**（黑胶/磁带那种）。
///   Web 侧必须同步把 `preservesPitch` 置 false，否则两条路径听感不一致。
/// ★ 非有限值/越界会被夹到 [MIN_RATE, MAX_RATE]（IPC 是不可信输入，
///   NaN 进了重采样会让解码线程原地空转 = 永久静音）。
#[tauri::command]
pub fn native_audio_set_rate(state: State<'_, NativeAudioState>, rate: f64) -> Result<(), String> {
    let engine = engine_of(&state)?;
    engine.set_rate(rate);
    Ok(())
}

/// 切换输出设备 / 共享↔独占。
/// ★ 引擎会**记住**这次选择，之后的换曲沿用（见 engine.rs `pending_output`），
///   所以前端不需要在每次 load 前重发。
#[tauri::command]
pub fn native_audio_set_output(
    state: State<'_, NativeAudioState>,
    output: OutputDto,
) -> Result<(), String> {
    let engine = engine_of(&state)?;
    engine.set_output(OutputConfig {
        device_id: output.device_id.filter(|s| !s.is_empty()),
        mode: if output.exclusive {
            OutputMode::Exclusive
        } else {
            OutputMode::Shared
        },
        ..Default::default()
    });
    Ok(())
}

/// 交还输出设备（前端关掉「WASAPI 独占输出」时调用）。
///
/// 为什么这不是「关掉开关就算了」：引擎一旦开过输出就一直持有端点，
/// 而 WASAPI 独占要求端点空闲——不交还的话第二次打开必然撞
/// AUDCLNT_E_DEVICE_IN_USE。同时这也让用户不用原生输出时设备真正空出来。
#[tauri::command]
pub fn native_audio_release_output(state: State<'_, NativeAudioState>) -> Result<(), String> {
    engine_of(&state)?.release_output();
    Ok(())
}

#[tauri::command]
pub fn native_audio_snapshot(state: State<'_, NativeAudioState>) -> Result<SnapshotDto, String> {
    let engine = engine_of(&state)?;
    let s = engine.snapshot();
    Ok(SnapshotDto {
        playing: s.playing,
        ended: s.ended,
        position_sec: s.position_sec,
        duration_sec: s.duration_sec,
        sample_rate: s.sample_rate,
        rate: s.rate,
        volume: s.volume,
        buffered_frames: s.buffered_frames,
        underruns: s.underruns,
        decoding: s.decoding,
        has_track: s.track.is_some(),
        track_name: s.track.as_ref().map(|t| {
            format!(
                "{} Hz / {} ch",
                t.sample_rate, t.channels
            )
        }),
        output_mode: s.output_mode.label().to_string(),
        sample_format: s.sample_format.label().to_string(),
        last_error: s.last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_src_unwraps_backend_stream_url() {
        /* 最常见的形态：getStreamCachedAudioUrl() 的产物。
           必须**拆开**而不是再套一层代理，否则后端会去请求自己。 */
        let spec = parse_src(
            "/api/audio/stream?url=https%3A%2F%2Fcdn.example%2Fa.mp3&songId=186016",
        )
        .expect("spec");
        match spec {
            AudioSourceSpec::Http { url, song_id, base } => {
                assert_eq!(url, "https://cdn.example/a.mp3");
                assert_eq!(song_id, "186016");
                assert_eq!(base, DEFAULT_BACKEND_BASE);
            }
            other => panic!("expected Http, got {:?}", other.label()),
        }
    }

    #[test]
    fn parse_src_keeps_origin_when_stream_url_is_absolute() {
        let spec = parse_src("http://127.0.0.1:8001/api/audio/stream?url=a.mp3&songId=7")
            .expect("spec");
        match spec {
            AudioSourceSpec::Http { base, song_id, .. } => {
                assert_eq!(base, "http://127.0.0.1:8001");
                assert_eq!(song_id, "7");
            }
            other => panic!("expected Http, got {:?}", other.label()),
        }
    }

    #[test]
    fn parse_src_wraps_bare_absolute_url_through_backend() {
        let spec = parse_src("https://cdn.example/b.flac").expect("spec");
        match spec {
            AudioSourceSpec::Http { url, base, .. } => {
                assert_eq!(url, "https://cdn.example/b.flac");
                assert_eq!(base, DEFAULT_BACKEND_BASE);
            }
            other => panic!("expected Http, got {:?}", other.label()),
        }
    }

    #[test]
    fn parse_src_maps_local_paths_to_file() {
        for p in ["D:\\music\\a.mp3", "D:/music/a.mp3", "file:///D:/music/a.mp3"] {
            match parse_src(p).expect("spec") {
                AudioSourceSpec::File(path) => {
                    assert_eq!(path.to_string_lossy().replace('\\', "/"), "D:/music/a.mp3");
                }
                other => panic!("{} should be File, got {:?}", p, other.label()),
            }
        }
    }

    #[test]
    fn parse_src_rejects_memory_blobs_instead_of_guessing() {
        /* blob/data 读不了，必须明确报错让前端回退 HTML 元素——
           猜一个 URL 会得到"能加载但放的是别的东西"这种最糟的结果。 */
        assert!(parse_src("blob:http://localhost:8001/abc").is_err());
        assert!(parse_src("").is_err());
    }

    #[test]
    fn index_of_maps_names_and_falls_back_to_default() {
        assert_eq!(index_of(&SPATIAL_LEVELS, "light", SPATIAL_DEFAULT), 0);
        assert_eq!(index_of(&SPATIAL_LEVELS, "strong", SPATIAL_DEFAULT), 2);
        assert_eq!(index_of(&IR_ORDER, "hall", IR_DEFAULT), 1);
        assert_eq!(index_of(&IR_ORDER, "wide", IR_DEFAULT), 2);
        assert_eq!(index_of(&STAGE_LEVELS, "medium", STAGE_DEFAULT), 1);
        /* 未知名字回落缺省档（不报错、不 panic）——「ultra 不是档位」不该让功能失效 */
        assert_eq!(index_of(&SPATIAL_LEVELS, "ultra", SPATIAL_DEFAULT), 0);
        /* strong 是空间音频合法档位，但在**虚拟声场**表里不存在 ⇒ 回落 light */
        assert_eq!(index_of(&STAGE_LEVELS, "strong", STAGE_DEFAULT), 0);
        assert_eq!(index_of(&STAGE_LEVELS, "high", STAGE_DEFAULT), 0);
    }

    #[test]
    fn percent_decode_handles_encoded_query() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fx%2Fa.mp3%3Ft%3D1"),
            "https://x/a.mp3?t=1"
        );
        assert_eq!(percent_decode("a+b"), "a b");
        /* 残缺的 % 序列原样保留而不是吞掉 */
        assert_eq!(percent_decode("100%25%"), "100%%");
    }
}