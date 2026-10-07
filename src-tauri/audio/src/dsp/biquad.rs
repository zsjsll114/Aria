//! 双二阶（biquad）滤波器 —— EQ 的积木。
//!
//! ★ 公式来源必须是 **Audio EQ Cookbook（Robert Bristow-Johnson）**，
//!   因为 Web Audio 的 `BiquadFilterNode` 用的就是它。这不是"随便找个好公式"
//!   的选择题：Aria 有两套播放路径（WebView2 的 Web Audio 图 / 本原生引擎），
//!   用户会来回切换。若两边系数设计不同，同一组 EQ 增益会听出**不同的音色**，
//!   用户会认为"切到原生后端音质变了"——这个 bug 极难归因，因为两边
//!   各自看都"对"。所以这里逐条对齐 Web Audio 规范：
//!
//! | 类型 | alpha | 说明 |
//! |---|---|---|
//! | lowshelf / highshelf | `sin(w0)/2 * sqrt((A + 1/A)*(1/S - 1) + 2)`，**S=1** | Web Audio 把 shelf 斜率 S 固定为 1 → 退化成 `sin(w0)/2*sqrt(2)` |
//! | peaking | `sin(w0)/(2*Q)` | Q 用用户给值 |
//!
//! 实现用 **Transposed Direct Form II**：状态变量少、且在中低频下数值稳定性
//! 优于 Direct Form I（DF1 在极低频 highshelf 上会有可闻的量化噪声累积）。

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterKind {
    LowShelf,
    Peaking,
    HighShelf,
}

/// 归一化后的系数（b0/b1/b2/a1/a2，已全部除以 a0）。
#[derive(Clone, Copy, Debug)]
pub struct Coefficients {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefficients {
    /// 恒等（直通）。用于增益为 0 的 band —— 直接跳过计算，省 10 次乘加。
    pub const PASS: Coefficients = Coefficients {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    pub fn is_pass(&self) -> bool {
        self.b0 == 1.0 && self.b1 == 0.0 && self.b2 == 0.0 && self.a1 == 0.0 && self.a2 == 0.0
    }
}

/// Web Audio 的 `BiquadFilterNode` 允许 frequency 超过 Nyquist（内部会 clamp），
/// 这里同样 clamp 而不是报错——报错会让一个 UI 滑杆的极端值把整条音频链打断。
fn clamp_freq(freq: f64, sample_rate: f64) -> f64 {
    let nyquist = sample_rate * 0.5;
    freq.clamp(1.0, nyquist * 0.999)
}

/// 设计一个双二阶段。`gain_db` 为 0 且类型是 peaking/shelf 时返回严格直通。
pub fn design(kind: FilterKind, freq: f64, q: f64, gain_db: f64, sample_rate: f64) -> Coefficients {
    if gain_db.abs() < 1e-9 && kind != FilterKind::Peaking {
        /* shelf 在 0dB 时理论上也是直通，但浮点会算出 b0=1.0000000000000002 这类值，
           显式短路既省计算也避免任何残留色染。 */
        return Coefficients::PASS;
    }
    if kind == FilterKind::Peaking && gain_db.abs() < 1e-9 {
        return Coefficients::PASS;
    }

    let f0 = clamp_freq(freq, sample_rate);
    let w0 = 2.0 * PI * f0 / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let a = 10f64.powf(gain_db / 40.0); // A = 10^(dBgain/40)
    let q = q.max(1e-6);

    let (b0, b1, b2, a0, a1, a2) = match kind {
        FilterKind::Peaking => {
            let alpha = sin_w0 / (2.0 * q);
            (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            )
        }
        FilterKind::LowShelf => {
            /* S = 1（Web Audio 固定值）→ (A + 1/A)*(1/1 - 1) = 0 → 只剩 +2 */
            let alpha = sin_w0 / 2.0 * 2f64.sqrt();
            let sqrt_a = a.sqrt();
            (
                a * ((a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                a * ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
                (a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                (a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
            )
        }
        FilterKind::HighShelf => {
            let alpha = sin_w0 / 2.0 * 2f64.sqrt();
            let sqrt_a = a.sqrt();
            (
                a * ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                a * ((a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
                (a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
                2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                (a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
            )
        }
    };

    Coefficients {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

/// 单声道的一个滤波段状态（TDF2）。
#[derive(Clone, Copy, Debug, Default)]
pub struct BiquadState {
    z1: f64,
    z2: f64,
}

impl BiquadState {
    #[inline]
    pub fn process(&mut self, x: f64, c: &Coefficients) -> f64 {
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用给定系数跑一段白噪声，测量指定频率的正弦增益（dB）。
    /// 这是验证"EQ 真的按预期曲线工作"最直接的办法。
    fn measured_gain_db(c: &Coefficients, freq: f64, sample_rate: f64) -> f64 {
        let n = 32_768;
        let mut st = BiquadState::default();
        let mut peak_in = 0.0f64;
        let mut peak_out = 0.0f64;
        /* 先跑一段让它进入稳态，再测量 */
        for i in 0..n * 2 {
            let x = (2.0 * PI * freq * i as f64 / sample_rate).sin();
            let y = st.process(x, c);
            if i >= n {
                peak_in = peak_in.max(x.abs());
                peak_out = peak_out.max(y.abs());
            }
        }
        if peak_in <= 0.0 {
            return 0.0;
        }
        20.0 * (peak_out / peak_in).log10()
    }

    #[test]
    fn zero_gain_is_exact_passthrough() {
        let c = design(FilterKind::Peaking, 1000.0, 1.0, 0.0, 44100.0);
        assert!(c.is_pass());
        let c2 = design(FilterKind::LowShelf, 32.0, 1.0, 0.0, 44100.0);
        assert!(c2.is_pass());
    }

    #[test]
    fn peaking_boosts_at_center_frequency() {
        let c = design(FilterKind::Peaking, 1000.0, 1.0, 6.0, 44100.0);
        let g = measured_gain_db(&c, 1000.0, 44100.0);
        /* 中心频率处的增益应当接近设定的 +6dB（受 Q 与测量方法影响，给 0.6dB 容差） */
        assert!(
            (g - 6.0).abs() < 0.6,
            "expected ~+6dB at 1kHz, measured {:.2}dB",
            g
        );
    }

    #[test]
    fn peaking_cut_reduces_at_center_frequency() {
        let c = design(FilterKind::Peaking, 1000.0, 1.0, -6.0, 44100.0);
        let g = measured_gain_db(&c, 1000.0, 44100.0);
        assert!(
            (g + 6.0).abs() < 0.6,
            "expected ~-6dB at 1kHz, measured {:.2}dB",
            g
        );
    }

    #[test]
    fn peaking_leaves_far_frequencies_alone() {
        let c = design(FilterKind::Peaking, 1000.0, 1.0, 12.0, 44100.0);
        /* 1kHz 的 peaking，在 100Hz 处影响应当很小 */
        let g = measured_gain_db(&c, 100.0, 44100.0);
        assert!(g.abs() < 1.5, "expected near 0dB at 100Hz, got {:.2}dB", g);
    }

    #[test]
    fn low_shelf_affects_lows_not_highs() {
        let c = design(FilterKind::LowShelf, 250.0, 1.0, 9.0, 44100.0);
        let low = measured_gain_db(&c, 40.0, 44100.0);
        let high = measured_gain_db(&c, 8000.0, 44100.0);
        assert!(low > 7.0, "lowshelf should boost 40Hz, got {:.2}dB", low);
        assert!(high.abs() < 1.0, "should not touch 8kHz, got {:.2}dB", high);
    }

    #[test]
    fn high_shelf_affects_highs_not_lows() {
        let c = design(FilterKind::HighShelf, 8000.0, 1.0, 9.0, 44100.0);
        let high = measured_gain_db(&c, 16000.0, 44100.0);
        let low = measured_gain_db(&c, 100.0, 44100.0);
        assert!(high > 6.0, "highshelf should boost 16kHz, got {:.2}dB", high);
        assert!(low.abs() < 1.0, "should not touch 100Hz, got {:.2}dB", low);
    }

    #[test]
    fn frequency_above_nyquist_is_clamped_not_panicking() {
        /* 16kHz 在 22050Hz 采样率下已越过 Nyquist —— 必须 clamp 成合法值，
           而不是产出 NaN 把整条链路毒死。 */
        let c = design(FilterKind::HighShelf, 16000.0, 1.0, 6.0, 22050.0);
        assert!(c.b0.is_finite() && c.a1.is_finite() && c.a2.is_finite());
    }

    #[test]
    fn coefficients_are_stable_for_extreme_settings() {
        /* 全频段 × 全增益的暴力组合：任何一组产生 NaN/Inf 都说明公式有问题 */
        for &f in &[32.0, 64.0, 125.0, 16000.0] {
            for &g in &[-12.0, 12.0] {
                for kind in [FilterKind::LowShelf, FilterKind::Peaking, FilterKind::HighShelf] {
                    let c = design(kind, f, 1.0, g, 44100.0);
                    assert!(
                        c.b0.is_finite()
                            && c.b1.is_finite()
                            && c.b2.is_finite()
                            && c.a1.is_finite()
                            && c.a2.is_finite(),
                        "{:?} f={} g={} produced non-finite coefficients",
                        kind,
                        f,
                        g
                    );
                }
            }
        }
    }
}
