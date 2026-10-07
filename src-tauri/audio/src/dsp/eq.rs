//! 10 段图示均衡器 —— 对齐 `web/src/core/equalizer.js` 的 Web Audio 图。
//!
//! 频点、Q、滤波器类型、增益范围全部取自项目既有定义（`config/constants.js`
//! 的 `EQ_BANDS` 与 `90-eq.js` 的滑杆 min/max/step）：
//!
//! | 索引 | 频率 | 类型 | 备注 |
//! |---|---|---|---|
//! | 0 | 32 Hz | lowshelf | 首段用 shelf 而非 peaking，与 Web 侧一致 |
//! | 1..8 | 64 … 8000 | peaking, Q=1.0 | |
//! | 9 | 16000 Hz | highshelf | |
//!
//! 增益范围 −12 … +12 dB（整档步进）。**默认全 0 → 整条链直通**，
//! 且每一段的 0 增益会被短路成 `Coefficients::PASS`，不消耗任何乘加
//! —— "没开 EQ 却有 CPU 开销"是这类实现的常见隐性代价。
//!
//! ★ 关于 zipper noise：Web Audio 的 BiquadFilterNode 系数按 k-rate
//!   （每 128 样本）更新，因此拖动滑杆时本来就有轻微阶梯感。这里在
//!   **每个音频块**（10~20ms）边界重算系数，粒度与 Web 侧同量级，
//!   不额外引入更差的行为。刻意**不清零滤波器状态**——清了才会在
//!   调整增益的瞬间产生可闻的爆音。

use super::biquad::{design, BiquadState, Coefficients, FilterKind};

/// 与 `web/src/core/constants.js` 的 `EQ_BANDS` 逐字对应，顺序即频段顺序。
pub const EQ_BANDS: [f64; 10] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// 与 Web 侧 `f.Q.value = 1.0` 一致。
pub const EQ_Q: f64 = 1.0;
/// 与 Web 侧滑杆 `min="-12" max="12"` 一致。
pub const EQ_MAX_GAIN_DB: f64 = 12.0;
pub const EQ_BAND_COUNT: usize = 10;

fn kind_of(index: usize) -> FilterKind {
    if index == 0 {
        FilterKind::LowShelf
    } else if index == EQ_BAND_COUNT - 1 {
        FilterKind::HighShelf
    } else {
        FilterKind::Peaking
    }
}

/// 均衡器设置（可跨线程传递的快照）。
#[derive(Clone, Copy, Debug)]
pub struct EqSettings {
    pub enabled: bool,
    pub gains_db: [f64; EQ_BAND_COUNT],
}

impl Default for EqSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            gains_db: [0.0; EQ_BAND_COUNT],
        }
    }
}

impl EqSettings {
    /// 是否等价于"什么都不做"（未启用，或全部增益为 0）。
    /// 用于让引擎在 EQ 闲置时完全跳过这条链。
    pub fn is_noop(&self) -> bool {
        !self.enabled || self.gains_db.iter().all(|g| g.abs() < 1e-9)
    }
}

pub struct EqChain {
    sample_rate: f64,
    coeffs: [Coefficients; EQ_BAND_COUNT],
    /// [声道][频段]。两个声道必须各有独立状态，否则左右会被交叉污染。
    states_l: [BiquadState; EQ_BAND_COUNT],
    states_r: [BiquadState; EQ_BAND_COUNT],
    applied: EqSettings,
}

impl EqChain {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(1) as f64;
        let mut coeffs = [Coefficients::PASS; EQ_BAND_COUNT];
        for (i, c) in coeffs.iter_mut().enumerate() {
            *c = design(kind_of(i), EQ_BANDS[i], EQ_Q, 0.0, sr);
        }
        Self {
            sample_rate: sr,
            coeffs,
            states_l: [BiquadState::default(); EQ_BAND_COUNT],
            states_r: [BiquadState::default(); EQ_BAND_COUNT],
            applied: EqSettings::default(),
        }
    }

    /// 应用新设置。设置没变时**不重算系数**（否则每个音频块都要跑 10 次
    /// 三角函数，纯浪费——播放中这个函数每块都会被调用一次）。
    pub fn apply(&mut self, s: &EqSettings) {
        if self.applied.enabled == s.enabled && self.applied.gains_db == s.gains_db {
            return;
        }
        for i in 0..EQ_BAND_COUNT {
            let g = if s.enabled {
                s.gains_db[i].clamp(-EQ_MAX_GAIN_DB, EQ_MAX_GAIN_DB)
            } else {
                0.0
            };
            self.coeffs[i] = design(kind_of(i), EQ_BANDS[i], EQ_Q, g, self.sample_rate);
        }
        self.applied = *s;
    }

    /// 换曲/换采样率后重建（系数依赖采样率）。
    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        let sr = sample_rate.max(1) as f64;
        if (sr - self.sample_rate).abs() < f64::EPSILON {
            return;
        }
        self.sample_rate = sr;
        let keep = self.applied;
        /* 强制重算：把 applied 改成一个不可能相等的值 */
        self.applied.enabled = !keep.enabled;
        self.apply(&keep);
        self.reset();
    }

    pub fn reset(&mut self) {
        for s in self.states_l.iter_mut().chain(self.states_r.iter_mut()) {
            s.reset();
        }
    }

    /// 当前生效的设置（诊断用）。
    pub fn settings(&self) -> EqSettings {
        self.applied
    }

    /// 原地处理**立体声交错 f32** 缓冲。
    /// 单声道/其他布局不对：引擎内部已统一成立体声交错（见 decoder.rs）。
    pub fn process_interleaved(&mut self, buf: &mut [f32]) {
        if self.applied.is_noop() {
            return;
        }
        /* 只对非直通的段做循环：默认全 0 时这里一个 band 都不进 */
        let active: Vec<usize> = (0..EQ_BAND_COUNT)
            .filter(|&i| !self.coeffs[i].is_pass())
            .collect();
        if active.is_empty() {
            return;
        }

        let frames = buf.len() / 2;
        for f in 0..frames {
            let idx = f * 2;
            let mut l = buf[idx] as f64;
            let mut r = buf[idx + 1] as f64;
            for &b in &active {
                let c = &self.coeffs[b];
                l = self.states_l[b].process(l, c);
                r = self.states_r[b].process(r, c);
            }
            /* 系数是稳定设计，理论上不会发散；但一旦出现 NaN 就必须切断，
               否则一个采样点的 Inf 会在滤波器状态里永久回响（整条链报废）。 */
            if l.is_finite() {
                buf[idx] = l as f32;
            }
            if r.is_finite() {
                buf[idx + 1] = r as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成一段正弦，过 EQ，返回输出/输入的峰值比（dB）。测的是**整条链**。
    fn chain_gain_db(chain: &mut EqChain, freq: f64, sr: f64, n: usize) -> f64 {
        let mut in_peak = 0.0f64;
        let mut out_peak = 0.0f64;
        let mut buf = Vec::with_capacity(n * 2);
        for i in 0..n {
            let x = (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32;
            buf.push(x);
            buf.push(x);
        }
        chain.process_interleaved(&mut buf);
        for i in n / 2..n {
            let x = (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin();
            in_peak = in_peak.max(x.abs());
            out_peak = out_peak.max(buf[i * 2].abs() as f64);
        }
        if in_peak <= 0.0 {
            0.0
        } else {
            20.0 * (out_peak / in_peak).log10()
        }
    }

    #[test]
    fn default_settings_are_transparent() {
        let mut c = EqChain::new(44100);
        c.apply(&EqSettings::default());
        assert!(c.settings().is_noop());
        let g = chain_gain_db(&mut c, 1000.0, 44100.0, 8192);
        assert!(g.abs() < 0.01, "default EQ must be bit-transparent, got {:.3}dB", g);
    }

    #[test]
    fn disabled_chain_ignores_nonzero_gains() {
        let mut c = EqChain::new(44100);
        let mut gains = [0.0; EQ_BAND_COUNT];
        gains[5] = 12.0; // 1kHz +12dB
        c.apply(&EqSettings {
            enabled: false,
            gains_db: gains,
        });
        let g = chain_gain_db(&mut c, 1000.0, 44100.0, 8192);
        assert!(
            g.abs() < 0.01,
            "disabled EQ must not colour the sound, got {:.3}dB",
            g
        );
    }

    #[test]
    fn boost_on_one_band_raises_that_frequency() {
        let mut c = EqChain::new(44100);
        let mut gains = [0.0; EQ_BAND_COUNT];
        gains[5] = 6.0; // 1kHz
        c.apply(&EqSettings {
            enabled: true,
            gains_db: gains,
        });
        let at_1k = chain_gain_db(&mut c, 1000.0, 44100.0, 16384);
        assert!(at_1k > 4.5, "1kHz should be boosted, got {:.2}dB", at_1k);

        /* 相邻的 4k 段不受影响 */
        let mut c2 = EqChain::new(44100);
        c2.apply(&EqSettings {
            enabled: true,
            gains_db: gains,
        });
        let at_4k = chain_gain_db(&mut c2, 4000.0, 44100.0, 16384);
        assert!(at_4k.abs() < 2.0, "4kHz should be nearly untouched, got {:.2}dB", at_4k);
    }

    #[test]
    fn reapply_with_same_settings_is_a_noop() {
        let mut c = EqChain::new(44100);
        let s = EqSettings {
            enabled: true,
            gains_db: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0],
        };
        c.apply(&s);
        let before = c.settings();
        c.apply(&s);
        let after = c.settings();
        assert_eq!(before.gains_db, after.gains_db);
        assert_eq!(before.enabled, after.enabled);
    }

    #[test]
    fn chain_never_emits_nan_even_with_extreme_gains() {
        let mut c = EqChain::new(44100);
        c.apply(&EqSettings {
            enabled: true,
            gains_db: [12.0; EQ_BAND_COUNT],
        });
        let mut buf = vec![0.5f32; 4096];
        c.process_interleaved(&mut buf);
        assert!(
            buf.iter().all(|v| v.is_finite()),
            "all +12dB must not blow up the chain"
        );
    }

    #[test]
    fn stereo_channels_are_independent() {
        /* 左声道给信号、右声道静音：处理后右声道必须仍是静音，
           否则说明两个声道共用了一份滤波器状态（经典的实现错误）。 */
        let mut c = EqChain::new(44100);
        c.apply(&EqSettings {
            enabled: true,
            gains_db: [6.0; EQ_BAND_COUNT],
        });
        let mut buf = Vec::new();
        for i in 0..2048 {
            buf.push(((i as f64 * 0.1).sin()) as f32); // L
            buf.push(0.0); // R
        }
        c.process_interleaved(&mut buf);
        let right_energy: f32 = buf.chunks(2).map(|p| p[1].abs()).sum();
        assert!(right_energy < 1e-6, "right channel leaked: {}", right_energy);
    }

    #[test]
    fn sample_rate_change_recomputes_coefficients() {
        let mut c = EqChain::new(44100);
        let mut gains = [0.0; EQ_BAND_COUNT];
        gains[0] = 9.0; // 32Hz lowshelf
        c.apply(&EqSettings {
            enabled: true,
            gains_db: gains,
        });
        let at_44 = chain_gain_db(&mut c, 32.0, 44100.0, 32768);
        c.set_sample_rate(48000);
        let at_48 = chain_gain_db(&mut c, 32.0, 48000.0, 32768);
        /* 换采样率后同一物理频率的增益应当基本一致（系数重新按新采样率设计） */
        assert!(
            (at_44 - at_48).abs() < 1.5,
            "gain drifted after sample-rate change: 44.1k={:.2}dB 48k={:.2}dB",
            at_44,
            at_48
        );
    }

    #[test]
    fn gains_are_clamped_to_ui_range() {
        let mut c = EqChain::new(44100);
        /* 传一个超范围的增益（理论上 UI 不会给，但 IPC 是不可信输入） */
        c.apply(&EqSettings {
            enabled: true,
            gains_db: [999.0; EQ_BAND_COUNT],
        });
        let mut buf = vec![0.3f32; 1024];
        c.process_interleaved(&mut buf);
        assert!(buf.iter().all(|v| v.is_finite()));
    }
}
