//! 空间音频（双耳 HRTF 卷积）+ 虚拟声场（M/S 展宽 + Haas 微延时）
//! —— 逐项对齐 `web/src/core/equalizer.js`。**两条路径必须同时落**（见文件末尾）。
//!
//! 插在链上的位置与 Web 侧一致（方案 §2.1/§2.2）：
//!
//! ```text
//!   ring ──► EQ（10 段 biquad）──► 【空间音频 → 虚拟声场】──► 音量 ──► WASAPI
//! ```
//!
//! 三条位置理由（与 Web 侧逐条对应）：
//!   1. **在 EQ 之后** —— 用户调 EQ 是「先把频谱修好」，空间处理应在干净信号上做；
//!   2. **在音量之前** —— 与 Web 侧「在 compressor 之前」同源：空间处理会改变
//!      电平分布，放在音量**之前**才能被后级的名义响度控制吃到（Rust 侧音量是
//!      用户随时会拖的独立控制，见 dsp/mod.rs 的链序注释）。
//!   3. **在混音总线之后** —— 引擎内部只有一个输出线程、一条链，天然共享；
//!      Automix 双 deck 在 Rust 侧尚未接管（lib.rs Phase 2d），未来接管时同样
//!      必须挂在这条链上，别在每条 deck 上各挂一套（交叉时声场会跳）。
//!
//! ## 与 Web 侧为什么**必须**逐样本等价
//!
//! `dsp/biquad.rs` 文件头把这条写成了硬约束：「若两边系数设计不同，同一组 EQ 增益
//! 会听出不同的音色，用户会认为『切到原生后端音质变了』——这个 bug 极难归因，
//! 因为两边各自看都『对』。」空间音频同理，而且更隐蔽（听感差异是"宽窄/前后"，
//! 没有参照物时根本说不清）。因此：
//!   · 参数表与 IR 样本**都由 `scripts/build_spatial_tuning.mjs` 生成**（同一份数据）；
//!   · IR 重采样用**同一个线性插值函数**（生成器同时产出 JS 与 Rust 两版）；
//!   · 归一化在生成期完成，Web 侧把 `ConvolverNode.normalize` 显式设 `false`，
//!     从而绕开「浏览器归一化口径」这个第三变量（方案 §2.1 允许，条件是自补增益）。
//!
//! ## ★ 虚拟声场为什么用 M/S 形式（而不是"向对侧注入同相信号"）
//!
//! 直觉上的「把 L 串一点到 R、R 串一点到 L」是**同相串音（crossfeed）**，
//! 它的效果是**收窄**而不是展宽：
//!
//! ```text
//!   out_L = L + k·R,  out_R = R + k·L   (k > 0)
//!   S_out = (out_L − out_R)/2 = S_in · (1 − k)   ⟹ S 被缩小
//! ```
//!
//! （耳机上的 Bauer crossfeed 正是这个原理——它就是为了**减少**立体声宽度。
//!   本模块早期版本误用过它，注释里「同相注入会增大 S」是把方向写反了。）
//!
//! 要真展宽就得让 `S_out = S · S_in`（S > 1），对偶地要求**反相注入**：
//!
//! ```text
//!   a = (1 + S)/2   同侧增益
//!   b = (1 − S)/2   对侧增益（S > 1 时 b < 0，即反相）
//!   out_L = a·L + b·R ,   out_R = b·L + a·R
//!   S_out = (out_L − out_R)/2 = S · S_in           ✔ 真展宽
//!   M_out = (out_L + out_R)/2 = (a+b)/2·(L+R) = M_in   ✔ 单声道和精确不变
//! ```
//!
//! 关键在 `a + b ≡ 1`：**同侧那一份被同步抬高**，正好抵消掉对侧反相注入对和的削减。
//! 所以它既真展宽、又天然不抵消——这正是方案 §1.2 说「轻档用 M/S，几乎零风险」的原意。
//! （盲目"把一侧反相"之所以会翻车，是因为只做了 `b < 0` 却没抬 `a`，于是 `(L+R)`
//!   被 `(1 − |b|)` 削弱，k 一大就近乎抵消。本实现不存在这个形态。）
//!
//! ## 已知取舍（诚实记录，别当成缺陷）
//!
//!   · **IR 是「短 IR」**：512 taps @48k ≈ 10.7ms，只含头相关早期反射，
//!     **不含长房间混响尾**。这是被本模块的时域 FIR 成本卡死的（方案 §2.2/§6：
//!     >512 taps 需引入 `rustfft` 做 FFT 分块卷积）。想要真正的厅堂尾，
//!     那是另一个阶段的事（先量化，再决定值不值）。
//!   · **IR 是生成式的**（简化头模型 + 早期反射场），不是实测 HRTF：
//!     我们既没有也不该打包实测 HRTF 素材（体积 + 授权）。方案 §1.1 的备选路线。
//!   · **没有跨耳抵消**（方案 §8.2 用户拍板：收益存疑、复杂度最高，不做）。
//!   · **不做峰值补偿**：M/S 形式下同侧增益 `a = (1+S)/2 ≤ 1.16`（S≤1.32），
//!     对全相关/全反相关素材的最大抬升 ≤ +1.4 dB。留这个余量是为了保住
//!     `a + b ≡ 1` 这条单声道不变量——为压 1 dB 而破坏它，不划算。
//!   · 切换 IR 预设时**不做交叉淡化**：FIR 系数是线性时不变算子，中途换系数
//!     只产生有界瞬态（不炸、不静音）。要彻底无感需要双实例 + 淡化，属于过度设计。

use super::spatial_tuning::{
    ir_pair_for, resample_linear, spatial_tuning_for, stage_tuning_for, IR_DEFAULT, IR_ORDER,
    IR_SAMPLE_RATE, SPATIAL_DEFAULT, SPATIAL_LEVELS, STAGE_DEFAULT, STAGE_LEVELS,
};

/// 平滑时间常数（秒）。★ 与 Web 侧 `equalizer.js` 的 `STAGE_SMOOTH` 同值（0.05s）。
/// 切换开关/档位时**绝不能直接跳变**：增益跳变 = 咔哒声（Web 侧对应
/// `setTargetAtTime`，Rust 侧对应下面的单极平滑）。
const SMOOTH_SEC: f32 = 0.05;

/// 单极平滑一步：`cur` 向 `target` 逼近。距离小于 `snap` 时直接吸附到 `target`
/// ——否则几何衰减永远到不了精确目标值，`at_rest()` 的判据会失效。
/// ★ 与 Web 侧 `setTargetAtTime(v, now, 0.05)` 的时间常数同源。
///
/// ★★ **累加必须用 f64**：用 f32 时，当增益逼近 1.0，每步减量 `k·Δ` 会降到
///    `f32::EPSILON` 的半个 ULP 以下而被舍回原值，于是**永久停滞在
///    `ULP(1.0)/(2k) ≈ 1.43e-4` 处**（实测 `a` 就死咬在 1.000143），
///    既够不着 1e-7 的吸附阈值，也留下可测的透明性残差。f64 下同一式子的
///    停滞点降到 ~2.6e-13，比吸附阈值小三个数量级。
#[inline]
fn approach(cur: f64, target: f64, k: f64, snap: f64) -> f64 {
    if (target - cur).abs() <= snap {
        target
    } else {
        cur + k * (target - cur)
    }
}

/// 空间处理设置（可跨线程传递的快照）。
///
/// ★ 用**索引**而不是字符串：输出线程每块都要比对一次，字符串比较是白费；
///   同时避开「IPC 传来的档位名不在表里」这类脏值——由 `apply` 统一兜底。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialSettings {
    /// 空间音频（HRTF 卷积）总开关。
    pub spatial_on: bool,
    /// 空间音频档位索引（→ `SPATIAL_LEVELS`，即 wet）。
    pub spatial_level: u8,
    /// IR 预设索引（→ `IR_ORDER`）。
    pub ir_index: u8,
    /// 虚拟声场总开关。
    pub stage_on: bool,
    /// 虚拟声场档位索引（→ `STAGE_LEVELS`）。
    pub stage_level: u8,
}

impl Default for SpatialSettings {
    fn default() -> Self {
        Self {
            spatial_on: false,
            spatial_level: 0,
            ir_index: 0,
            stage_on: false,
            stage_level: 0,
        }
    }
}

impl SpatialSettings {
    /// 等价于「什么都不做」——两个开关都关。
    pub fn is_noop(&self) -> bool {
        !self.spatial_on && !self.stage_on
    }

    /// 解析出的空间音频档位名（诊断/日志用）。
    pub fn spatial_level_name(&self) -> &'static str {
        SPATIAL_LEVELS
            .get(self.spatial_level as usize)
            .copied()
            .unwrap_or(SPATIAL_DEFAULT)
    }

    /// 解析出的 IR 预设名（诊断/日志用）。
    pub fn ir_name(&self) -> &'static str {
        IR_ORDER
            .get(self.ir_index as usize)
            .copied()
            .unwrap_or(IR_DEFAULT)
    }

    /// 解析出的虚拟声场档位名（诊断/日志用）。
    pub fn stage_level_name(&self) -> &'static str {
        STAGE_LEVELS
            .get(self.stage_level as usize)
            .copied()
            .unwrap_or(STAGE_DEFAULT)
    }
}

/// 空间处理链。状态（FIR 历史 / Haas 延迟线）只属于输出线程，
/// 与 `EqChain` 一样**不跨线程共享**——两条线程同时摸延迟线必然出噪声。
pub struct SpatialChain {
    sample_rate: f64,
    /// 已按输出采样率重采样的 HRTF FIR（左耳 / 右耳）。
    fir_l: Vec<f32>,
    fir_r: Vec<f32>,
    /// FIR 历史：长度 `2 * taps`，双写双读以消除内层取模分支。
    hist_l: Vec<f32>,
    hist_r: Vec<f32>,
    hist_pos: usize,
    taps: usize,

    /* 平滑中的实际增益（每样本单极逼近目标值，防 zipper/咔哒）。
       ★ 类型是 f64 而非 f32 —— 见 `approach` 的注释：f32 会在 1.0 附近停滞。 */
    wet_cur: f64,
    wet_target: f64,
    /// M/S 同侧增益 `(1+S)/2`。stage 关时 = 1。
    a_cur: f64,
    a_target: f64,
    /// M/S 对侧增益 `(1-S)/2`。stage 关时 = 0；S>1 时为负（反相）。
    b_cur: f64,
    b_target: f64,
    /// Haas 混入比例。
    hmix_cur: f64,
    hmix_target: f64,

    /// Haas 延迟线（左右各一条环形，长度 = 50ms 上限 + 余量）。
    haas_l: Vec<f32>,
    haas_r: Vec<f32>,
    haas_len: usize,
    haas_pos: usize,
    haas_delay: usize,

    /// 每样本平滑系数（由 SMOOTH_SEC 与采样率决定）。
    k: f64,
    applied: SpatialSettings,
}

impl SpatialChain {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate.max(1) as f64;
        let (ir_l, ir_r) = ir_pair_for(IR_DEFAULT);
        let fir_l = resample_linear(ir_l, IR_SAMPLE_RATE, sample_rate.max(1));
        let fir_r = resample_linear(ir_r, IR_SAMPLE_RATE, sample_rate.max(1));
        /* ★★ `taps` 必须取**重采样后的实际长度**，不能直接用常量 IR_TAPS。
           IR 是 48k、输出采样率却可能是 44.1k：512 → 470（44100/48000×512）。
           用常量做循环上界 / 开历史缓冲 ⇒ 44.1k 下直接越界 panic。
           （这个 bug 单测没抓到——它们全跑 48k，而 48k 下两者恰好相等；
             是 audio-probe spatialbench 扫 44.1k 时炸出来的。见回归测试。） */
        let taps = fir_l.len().max(1);
        debug_assert_eq!(fir_l.len(), fir_r.len(), "左右耳 FIR 长度必须一致");
        let haas_len = ((0.05 * sr).ceil() as usize).max(2) + 2;
        let k = 1.0 - (-1.0 / (SMOOTH_SEC as f64 * sr)).exp();
        Self {
            sample_rate: sr,
            fir_l,
            fir_r,
            hist_l: vec![0.0; taps * 2],
            hist_r: vec![0.0; taps * 2],
            hist_pos: 0,
            taps,
            /* 初始都落在「关」的目标值上 ⇒ 未启用时逐样本透明（与 EqChain 同思路） */
            wet_cur: 0.0,
            wet_target: 0.0,
            a_cur: 1.0,
            a_target: 1.0,
            b_cur: 0.0,
            b_target: 0.0,
            hmix_cur: 0.0,
            hmix_target: 0.0,
            haas_l: vec![0.0; haas_len],
            haas_r: vec![0.0; haas_len],
            haas_len,
            haas_pos: 0,
            haas_delay: 0,
            k,
            applied: SpatialSettings::default(),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate as u32
    }

    /// 当前实际生效的 FIR 长度（**重采样后**的，不等于常量 `IR_TAPS`）。
    /// 诊断/量化用：`audio-probe spatialbench` 靠它算真实的 MAC 数。
    /// ★ 成本 ∝ taps × 采样率，而 taps 本身随采样率线性增长 ⇒ **总成本 ∝ 采样率²**。
    ///   48k→192k 是 16 倍（实测 20 秒音频 2.6% → 39% 单核）。
    pub fn taps(&self) -> usize {
        self.taps
    }

    /// 当前生效的设置（诊断用）。
    pub fn settings(&self) -> SpatialSettings {
        self.applied
    }

    /// 应用设置。设置没变时**直接返回**（输出线程每块都会调一次）。
    pub fn apply(&mut self, s: &SpatialSettings) {
        if self.applied == *s {
            return;
        }
        /* ★ 从「完全待机」进入「启用」时清空历史：待机期间我们整块跳过（见
           `process_interleaved` 的早退），历史里留着的是很久以前的样本；
           不清的话，启用瞬间卷积会混入陈旧音频。清历史是安全的——
           wet 本身从 0 平滑爬升，听不出瞬态。 */
        if self.applied.is_noop() && !s.is_noop() {
            self.hist_l.fill(0.0);
            self.hist_r.fill(0.0);
            self.haas_l.fill(0.0);
            self.haas_r.fill(0.0);
        }

        /* IR 预设变化 → 重采样系数（可能与当前采样率不同）。 */
        if s.ir_index != self.applied.ir_index {
            let name = IR_ORDER
                .get(s.ir_index as usize)
                .copied()
                .unwrap_or(IR_DEFAULT);
            let (l, r) = ir_pair_for(name);
            self.fir_l = resample_linear(l, IR_SAMPLE_RATE, self.sample_rate as u32);
            self.fir_r = resample_linear(r, IR_SAMPLE_RATE, self.sample_rate as u32);
            /* 长度若变（同一采样率下不会，防御性处理），历史缓冲必须同步重建，
               否则又回到那个越界 bug（见 `new` 里的注释）。 */
            let new_taps = self.fir_l.len().max(1);
            if new_taps != self.taps {
                self.taps = new_taps;
                self.hist_l = vec![0.0; new_taps * 2];
                self.hist_r = vec![0.0; new_taps * 2];
                self.hist_pos = 0;
            }
        }

        /* 解析参数并写入平滑目标 */
        let st = spatial_tuning_for(s.spatial_level_name());
        self.wet_target = if s.spatial_on {
            st.wet.clamp(0.0, 1.0) as f64
        } else {
            0.0
        };

        let gt = stage_tuning_for(s.stage_level_name());
        if s.stage_on {
            /* ★ M/S 形式（见文件头推导）：a + b ≡ 1 ⇒ 单声道和精确不变。 */
            let s_mult = gt.stage_s.max(0.0) as f64;
            self.a_target = (1.0 + s_mult) * 0.5;
            self.b_target = (1.0 - s_mult) * 0.5;
            let haas_on = gt.haas_ms > 0.0 && gt.haas_mix > 0.0;
            self.hmix_target = if haas_on { gt.haas_mix as f64 } else { 0.0 };
            self.haas_delay = if haas_on {
                ((gt.haas_ms as f64 / 1000.0) * self.sample_rate).round() as usize
            } else {
                0
            };
            /* 延时不能超过延迟线长度（脏值兜底） */
            if self.haas_delay >= self.haas_len {
                self.haas_delay = self.haas_len - 1;
            }
        } else {
            self.a_target = 1.0;
            self.b_target = 0.0;
            self.hmix_target = 0.0;
        }

        self.applied = *s;
    }

    /// 是否完全待机（无任何处理在生效）。用于整块跳过，省掉 512×2 次乘加/帧。
    fn at_rest(&self) -> bool {
        self.applied.is_noop()
            && self.wet_cur == 0.0
            && self.wet_target == 0.0
            && self.a_cur == 1.0
            && self.a_target == 1.0
            && self.b_cur == 0.0
            && self.b_target == 0.0
            && self.hmix_cur == 0.0
            && self.hmix_target == 0.0
    }

    /// 原地处理**立体声交错 f32** 缓冲（与 `EqChain::process_interleaved` 同口径）。
    pub fn process_interleaved(&mut self, buf: &mut [f32]) {
        if self.at_rest() {
            return;
        }
        let frames = buf.len() / 2;
        let taps = self.taps;
        let k = self.k;
        let haas_len = self.haas_len;

        for f in 0..frames {
            let idx = f * 2;
            let l = buf[idx];
            let r = buf[idx + 1];

            /* ---- 每样本推进平滑（与 Web 侧 setTargetAtTime 的时间常数等价） ----
               ★ 单极平滑是几何衰减，永远到不了精确目标值；靠近时吸附，
                 否则 `at_rest()` 永远为假、待机跳过失效，白烧 CPU。 */
            self.wet_cur = approach(self.wet_cur, self.wet_target, k, 1e-7);
            self.a_cur = approach(self.a_cur, self.a_target, k, 1e-7);
            self.b_cur = approach(self.b_cur, self.b_target, k, 1e-7);
            self.hmix_cur = approach(self.hmix_cur, self.hmix_target, k, 1e-7);

            /* ---- ① 空间音频：双耳 HRTF 卷积（per-channel，各一条 FIR） ---- */
            let p = self.hist_pos;
            self.hist_l[p] = l;
            self.hist_l[p + taps] = l;
            self.hist_r[p] = r;
            self.hist_r[p + taps] = r;
            let base = p + taps;
            let mut cl = 0.0f32;
            let mut cr = 0.0f32;
            for t in 0..taps {
                cl += self.fir_l[t] * self.hist_l[base - t];
                cr += self.fir_r[t] * self.hist_r[base - t];
            }
            self.hist_pos = if p + 1 == taps { 0 } else { p + 1 };

            /* dry/wet 并联：dry 保清晰度（HRTF 天然低通，方案 §1.1） */
            let wet = self.wet_cur as f32;
            let sl = l + (cl - l) * wet;
            let sr_ = r + (cr - r) * wet;

            /* ---- ② 虚拟声场：M/S 展宽（a/b 同侧·对侧）+ Haas ---- */
            /* 延迟线写入（Haas 用对侧声道的历史，两条线都要写） */
            let hp = self.haas_pos;
            self.haas_l[hp] = sl;
            self.haas_r[hp] = sr_;
            let read = if hp >= self.haas_delay {
                hp - self.haas_delay
            } else {
                hp + haas_len - self.haas_delay
            };
            let dl = self.haas_l[read];
            let dr = self.haas_r[read];
            self.haas_pos = if hp + 1 == haas_len { 0 } else { hp + 1 };

            /* ★ 反相注入在对侧（b<0）是**有意为之**：它增大 S。
               ★ 单声道安全靠 a+b≡1，不靠"从不反相"——见文件头推导。 */
            let a = self.a_cur as f32;
            let b = self.b_cur as f32;
            let hmix = self.hmix_cur as f32;
            let out_l = sl * a + sr_ * b + dr * hmix;
            let out_r = sr_ * a + sl * b + dl * hmix;

            /* NaN 兜底：一个 Inf 进延迟线会永久回响，整条链报废
               （与 EqChain 同一处理）。 */
            if out_l.is_finite() {
                buf[idx] = out_l;
            }
            if out_r.is_finite() {
                buf[idx + 1] = out_r;
            }
        }
    }

    /// 复位全部状态（换采样率/诊断用）。
    pub fn reset(&mut self) {
        self.hist_l.fill(0.0);
        self.hist_r.fill(0.0);
        self.haas_l.fill(0.0);
        self.haas_r.fill(0.0);
        self.hist_pos = 0;
        self.haas_pos = 0;
    }

    /// 诊断：当前平滑中的增益（wet, a, b, hmix）。测试用。
    pub fn debug_gains(&self) -> (f64, f64, f64, f64) {
        (self.wet_cur, self.a_cur, self.b_cur, self.hmix_cur)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成一段立体声交错信号（L/R 各自不同，便于验证展宽）。
    fn stereo_signal(
        n: usize,
        left: impl Fn(usize) -> f32,
        right: impl Fn(usize) -> f32,
    ) -> Vec<f32> {
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            v.push(left(i));
            v.push(right(i));
        }
        v
    }

    fn settings(spatial_on: bool, level: u8, ir: u8, stage_on: bool, slevel: u8) -> SpatialSettings {
        SpatialSettings {
            spatial_on,
            spatial_level: level,
            ir_index: ir,
            stage_on,
            stage_level: slevel,
        }
    }

    #[test]
    fn default_is_bit_transparent() {
        let mut c = SpatialChain::new(48_000);
        c.apply(&SpatialSettings::default());
        let mut buf = stereo_signal(4096, |i| (i as f32 * 0.01).sin(), |i| (i as f32 * 0.013).cos());
        let orig = buf.clone();
        c.process_interleaved(&mut buf);
        assert_eq!(buf, orig, "默认（全关）必须逐样本透明");
    }

    #[test]
    fn turning_off_is_transparent_after_settling() {
        let mut c = SpatialChain::new(48_000);
        c.apply(&settings(true, 2, 2, true, 1));
        let mut warm = stereo_signal(48_000, |i| (i as f32 * 0.01).sin(), |i| (i as f32 * 0.02).sin());
        c.process_interleaved(&mut warm);
        c.apply(&SpatialSettings::default());
        let mut buf = stereo_signal(48_000, |i| (i as f32 * 0.01).sin(), |i| (i as f32 * 0.02).sin());
        c.process_interleaved(&mut buf);
        let expected = stereo_signal(48_000, |i| (i as f32 * 0.01).sin(), |i| (i as f32 * 0.02).sin());
        let a = &buf[buf.len() - 4096..];
        let b = &expected[expected.len() - 4096..];
        for (x, y) in a.iter().zip(b.iter()) {
            assert!((x - y).abs() < 1e-6, "关闭后应回到旁通，实得 {} 期望 {}", x, y);
        }
    }

    #[test]
    fn virtual_stage_widens_and_preserves_mono_sum() {
        /* 验证 M/S 展宽的两条核心性质：
           ① L/R 的**差**变大（真展宽，S 被放大）；
           ② L+R 的和**精确不变**（a+b≡1 ⇒ 单声道不抵消）。
           ★ 这正是旧「同相串音」实现做不到的：那个版本 ① 反而是变小。 */
        let mut c = SpatialChain::new(48_000);
        c.apply(&settings(false, 0, 0, true, 0)); // stage light (S=1.18)
        let n = 4096;
        let mk = || {
            stereo_signal(
                n,
                |i| (i as f32 * 0.02).sin() * 0.5,
                |i| (i as f32 * 0.05).sin() * 0.5,
            )
        };
        /* 让平滑收敛到目标后再取尾部比较 */
        let mut warm = mk();
        c.process_interleaved(&mut warm);
        let mut buf = mk();
        c.process_interleaved(&mut buf);

        let mut in_diff = 0.0f64;
        let mut out_diff = 0.0f64;
        let mut in_sum = 0.0f64;
        let mut out_sum = 0.0f64;
        for i in n / 2..n {
            let (lin, rin) = ((i as f32 * 0.02).sin() * 0.5, (i as f32 * 0.05).sin() * 0.5);
            let lout = buf[i * 2];
            let rout = buf[i * 2 + 1];
            in_diff += (lin - rin).abs() as f64;
            out_diff += (lout - rout).abs() as f64;
            in_sum += (lin + rin).abs() as f64;
            out_sum += (lout + rout).abs() as f64;
        }
        /* ① 展宽：S ×1.18 ⇒ 差应约增大 18% */
        assert!(
            out_diff > in_diff * 1.10,
            "展宽后 L/R 差应增大：in={} out={}",
            in_diff,
            out_diff
        );
        /* ② 单声道安全：和精确不变（容差留给 f32 舍入） */
        let err = (out_sum - in_sum).abs() / in_sum.max(1e-9);
        assert!(err < 0.005, "单声道和应基本不变：in={} out={} 相对误差={}", in_sum, out_sum, err);
    }

    #[test]
    fn stage_direct_and_cross_gains_sum_to_one() {
        /* a + b ≡ 1 是单声道安全的全部依据，值得单独钉住。 */
        let mut c = SpatialChain::new(48_000);
        for lv in 0..2u8 {
            c.apply(&settings(false, 0, 0, true, lv));
            let gt = stage_tuning_for(c.settings().stage_level_name());
            let a = (1.0 + gt.stage_s) * 0.5;
            let b = (1.0 - gt.stage_s) * 0.5;
            assert!((a + b - 1.0).abs() < 1e-6, "档位 {} 的 a+b 应为 1", lv);
        }
    }

    #[test]
    fn haas_delays_contralateral_channel() {
        /* medium 档（有 Haas）：只在 L 给一个脉冲，右声道应收到对侧注入。
           验证「对侧微延时」真的接上了，而不只是写进了参数表。 */
        let mut c = SpatialChain::new(48_000);
        c.apply(&settings(false, 0, 0, true, 1)); // stage medium
        let mut warm = vec![0.0f32; 48_000 * 2];
        c.process_interleaved(&mut warm);
        let n = 4096;
        let mut buf = vec![0.0f32; n * 2];
        buf[0] = 1.0; // L 脉冲
        c.process_interleaved(&mut buf);
        let right_energy: f32 = (0..n).map(|i| buf[i * 2 + 1].abs()).sum();
        assert!(right_energy > 0.1, "右声道应收到对侧注入，实得能量 {}", right_energy);
    }

    #[test]
    fn spatial_hrtf_changes_signal_but_stays_bounded() {
        let mut c = SpatialChain::new(48_000);
        c.apply(&settings(true, 2, 1, false, 0)); // spatial strong / hall
        let n = 8192;
        let mut buf = stereo_signal(n, |i| (i as f32 * 0.03).sin(), |i| (i as f32 * 0.03).sin());
        let orig = buf.clone();
        c.process_interleaved(&mut buf);
        let mut buf2 = orig.clone();
        c.process_interleaved(&mut buf2);
        let changed = buf2.iter().zip(orig.iter()).any(|(a, b)| (a - b).abs() > 1e-4);
        assert!(changed, "开启空间音频后信号应被改变");
        assert!(buf2.iter().all(|v| v.is_finite() && v.abs() < 8.0), "输出必须有界且无 NaN");
    }

    #[test]
    fn never_emits_nan_on_extreme_input() {
        let mut c = SpatialChain::new(48_000);
        c.apply(&settings(true, 2, 2, true, 1));
        let mut buf = vec![0.0f32; 2048];
        for (i, v) in buf.iter_mut().enumerate() {
            *v = if i % 2 == 0 { 1.0 } else { -1.0 };
        }
        c.process_interleaved(&mut buf);
        assert!(buf.iter().all(|v| v.is_finite()), "极端输入不得产生 NaN/Inf");
    }

    #[test]
    fn resample_linear_identity_when_rates_match() {
        let src: Vec<f32> = (0..64).map(|i| i as f32 * 0.01).collect();
        let out = resample_linear(&src, 48_000, 48_000);
        assert_eq!(out, src, "采样率相同必须原样返回");
    }

    #[test]
    fn resample_linear_upsamples_to_expected_length() {
        let src = vec![0.0f32; 480]; // 10ms @48k
        let up = resample_linear(&src, 48_000, 96_000);
        assert_eq!(up.len(), 960, "48k→96k 长度应翻倍");
        let down = resample_linear(&src, 48_000, 44_100);
        assert_eq!(down.len(), 441, "48k→44.1k 长度应按比例缩短");
    }

    #[test]
    fn apply_same_settings_twice_is_a_noop() {
        let mut c = SpatialChain::new(48_000);
        let s = settings(true, 1, 2, true, 1);
        c.apply(&s);
        let before = c.settings();
        c.apply(&s);
        assert_eq!(before, c.settings());
    }

    #[test]
    fn unknown_level_index_falls_back_without_panic() {
        let mut c = SpatialChain::new(48_000);
        /* 越界索引（IPC 不可信输入）：应回落到缺省档而不是 panic */
        c.apply(&settings(true, 200, 200, true, 200));
        let mut buf = stereo_signal(1024, |i| (i as f32 * 0.01).sin(), |i| (i as f32 * 0.02).sin());
        c.process_interleaved(&mut buf);
        assert!(buf.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn sample_rate_change_rebuilds_fir() {
        let c44 = SpatialChain::new(44_100);
        let c48 = SpatialChain::new(48_000);
        /* 44.1k 下 512 taps@48k 应重采样到更短（512 * 44100/48000 ≈ 470） */
        assert!(c44.fir_l.len() < c48.fir_l.len());
        assert_eq!(c48.fir_l.len(), 512);
    }

    #[test]
    fn works_at_every_sample_rate_with_spatial_on() {
        /* ★ 回归（audio-probe spatialbench 抓出来的）：44.1k 下 IR 被重采样成 470
           taps ≠ 常量 IR_TAPS(512)。曾经 FIR 循环上界与历史缓冲都用常量，
           于是 44.1k 直接 `index out of bounds: len is 470 but index is 470`。
           单测当初只跑 48k（那时两者恰好相等）⇒ 集体漏过。
           这条钉死「任何采样率 + 两个开关都开」都要能跑。 */
        for &rate in &[44_100u32, 48_000, 96_000, 192_000] {
            let mut c = SpatialChain::new(rate);
            c.apply(&settings(true, 2, 2, true, 1));
            let mut buf = stereo_signal(
                2048,
                |i| (i as f32 * 0.01).sin(),
                |i| (i as f32 * 0.013).cos(),
            );
            c.process_interleaved(&mut buf);
            assert!(buf.iter().all(|v| v.is_finite()), "{} Hz 下输出必须有限", rate);
            /* 顺带钉住"taps 与实际 FIR 长度一致"这条不变量 */
            assert_eq!(c.taps, c.fir_l.len());
            assert_eq!(c.hist_l.len(), c.taps * 2);
        }
    }
}
