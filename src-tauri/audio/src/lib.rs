//! # aria-audio —— Aria 的原生音频引擎
//!
//! 为什么存在这个 crate：**WASAPI 独占模式在 WebView2 里做不到**。
//! Web Audio 的终点是 `AudioContext.destination`，它固定走系统共享混音，
//! 没有任何 Web API 能拿到独占流（Chromium 的 `--enable-exclusive-audio`
//! 2012 年加入、后被官方标为 Won't Fix，塞进 WebView2 启动参数也不生效）。
//! ASIO 则更彻底：Chromium 从来没实现过。所以「比特完美输出」这条路，
//! 必须把播放引擎整体搬到 Rust。
//!
//! ## 分层
//!
//! ```text
//!   source   —— 字节从哪来（本地文件 / 本机后端流代理）
//!   decoder  —— symphonia 解码，统一成 交错 f32 立体声
//!   ring     —— 解码 ↔ 输出的非阻塞帧队列
//!   output   —— WASAPI（共享 / 独占）
//!   engine   —— 把上面四件组装成「命令 → 声音」的机器 + 时钟
//!   dsp      —— EQ / 增益（Phase 2c，挂在 ring 与 output 之间）
//! ```
//!
//! ## 与前端的分工（时钟契约，决定逐字歌词会不会抖）
//!
//! 前端的逐字高亮跑在 `requestAnimationFrame` 里，每帧都要一个"当前播到哪儿"。
//! **绝不能每帧走一次 IPC** —— Tauri IPC 是 JSON over 消息循环，逐帧调用会
//! 把主线程压满，高亮反而比现在还抖。
//!
//! 因此约定：
//!   1. 前端以 **20Hz**（50ms，见 `TICK_INTERVAL_MS`）来取 `native_audio_snapshot`；
//!   2. 前端缓存最后一次快照的 `position_sec` 与取到它的墙钟时刻，在 rAF 里做线性插值
//!      `position + (now - wall_clock) * rate`；
//!   3. 每收到一次新快照就**重锚定**（把插值基点换成新值），避免误差累积。
//!
//! 这样 IPC 频率与渲染帧率解耦：帧率 60fps、IPC 20Hz，两者互不拖累。
//! —— 这个模型是「原生引擎会不会让歌词变抖」这个风险的唯一解，别改成逐帧。
//!
//! ★ 注意方向：**是前端来取，不是引擎去推**。引擎没有主动推送通道（`TICK_INTERVAL_MS`
//! 是给前端定的节拍基准，Rust 侧不使用），快照由 `AudioEngine::snapshot()` 现取。
//! 前端实现见 `web/src/core/nativeDeck.js`。
//!
//! ## 当前进度
//!
//! - ✅ Phase 2a：解码 + 共享模式输出 + 时钟 + 队列
//! - ✅ Phase 2b：Tauri IPC 契约 + 前端 nativeDeck 鸭子类型（见 src-tauri/src/native_audio.rs、
//!   web/src/core/nativeBridge.js、web/src/core/nativeDeck.js、web/src/app/298-native-output.js）
//! - ⬜ Phase 2c：DSP（10 段 EQ 已接；响度压缩未做，参数对齐 core/equalizer.js）
//! - ⬜ Phase 2d：Automix 双 deck 交叉混音（当前原生模式下 automix 显式让位）
//! - ⚠ Phase 3：WASAPI 独占（见 output.rs）
//!   格式协商已完成（本机实测：驱动只收整数格式，f32 全被拒 → 按 f32 → s24 → s16 协商）。
//!   **但本机的独占端点不消费缓冲**：格式被接受、`Initialize` 返回 S_OK、
//!   `Write` 不报错，`GetCurrentPadding` 却恒定不变（轮询/事件、2/4/8× 缓冲、
//!   s16/s24 全试过）。共享模式一切正常 → 判定为设备/驱动/环境问题，不是代码问题。
//!   代码的处理方式是**检测并如实报告**：`WasapiOutput::start()` 会做端点消费体检，
//!   失败时返回 `AudioError::Busy` 并带上「接受了 N 帧但一帧未消费」的原因，
//!   而不是静默播空气。设置面板在放行独占开关前会先问 `check_exclusive_usable()`。

pub mod decoder;
pub mod dsp;
pub mod engine;
pub mod error;
pub mod output;
pub mod ring;
pub mod source;

pub use decoder::{Decoder, TrackInfo};
pub use dsp::{
    EqSettings, SpatialSettings, EQ_BANDS, EQ_BAND_COUNT, EQ_MAX_GAIN_DB, IR_DEFAULT, IR_ORDER,
    IR_TAPS, SPATIAL_DEFAULT, SPATIAL_LEVELS, STAGE_DEFAULT, STAGE_LEVELS,
};
pub use engine::{AudioEngine, EngineSnapshot};
pub use error::{AudioError, Result};
pub use output::{
    check_exclusive_usable, list_output_devices, probe_exclusive_formats, DeviceInfo,
    ExclusiveFormatInfo, OutputConfig, OutputMode, OutputSampleFormat,
};
pub use source::AudioSourceSpec;

/// 引擎 → 前端的时钟推送间隔（毫秒）。见上文「时钟契约」。
/// 50ms 是权衡结果：再密对插值没有增益（rAF 每帧才取一次），
/// 再疏会让 seek/暂停后的重锚定显得迟钝。
pub const TICK_INTERVAL_MS: u64 = 50;

/// 本机后端基地址。在线流一律经过它（取链/防盗链/Range/缓存都在 Python 侧解决）。
pub const DEFAULT_BACKEND_BASE: &str = "http://127.0.0.1:8001";
