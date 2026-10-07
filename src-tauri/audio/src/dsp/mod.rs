//! DSP 链：插在「队列出队」与「写设备」之间，全部在输出线程内就地处理。
//!
//! 顺序刻意与 Web Audio 图对齐（`core/equalizer.js` 的
//! `mixBus → filters → 空间音频 → 虚拟声场 → compressor → destination`）：
//!
//! ```text
//!   ring ──► EQ（10 段 biquad）──► 空间音频（HRTF）──► 虚拟声场（M/S+Haas）──► 音量 ──► WASAPI
//! ```
//!
//! 为什么 EQ 必须在音量**之前**：音量是用户随时会拖的独立控制，放在最后一级
//! 才能保证「拖动音量」不会重新触发 EQ 的系数计算，也不会被 EQ 的 shelf
//! 改变响度感知曲线（这是 Web 侧 `deckGain` 与最终音量的既有分工）。
//!
//! 为什么空间处理也必须在这条链上、且**在音量之前**：见 `spatial.rs` 文件头
//! 「三条位置理由」——与 Web 侧逐条对应，两条路径必须同时落、且顺序一致。
//!
//! ⬜ 待办（Phase 2c 后半）：`DynamicsCompressor` 的响度归一化
//! （threshold −22 / knee 8 / ratio 3.2 / attack 0.008 / release 0.18）。
//! 它是 Web 侧听感的一部分，但 Web Audio 的压缩器实现未完全公开，
//! 只能做行为近似、做不到 bit-exact——因此先说清楚，而不是假装对齐。

pub mod biquad;
pub mod eq;
pub mod spatial;
pub mod spatial_tuning;

pub use eq::{EqChain, EqSettings, EQ_BANDS, EQ_BAND_COUNT, EQ_MAX_GAIN_DB};
pub use spatial::{SpatialChain, SpatialSettings};
pub use spatial_tuning::{
    IR_DEFAULT, IR_ORDER, IR_TAPS, SPATIAL_DEFAULT, SPATIAL_LEVELS, STAGE_DEFAULT, STAGE_LEVELS,
};
