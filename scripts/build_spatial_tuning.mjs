/* ============================================================
 * scripts/build_spatial_tuning.mjs — 空间音频 / 虚拟声场 参数与 IR 生成器
 *
 * 为什么要有这一步（docs/空间音频与虚拟声场-技术方案.md §5）：
 *   「档位 → 参数」必须是 Web 与 Rust **同一张表**。dsp/biquad.rs 的教训是
 *   ——两边系数不一致时，用户切到原生后端会听出不同音色，而两边各自看都『对』，
 *   这个 bug 极难归因。手抄数字必然分叉，所以让**物理上不可能不一致**：
 *   一份 JSON → 同时生成 JS 常量与 Rust 常量（同 scripts/anime4k 生成 shader 的模式）。
 *
 * 还多生成一样东西：**HRTF 冲激响应（IR）本身**。
 *   我们没有（也不该打包）实测 HRTF 素材（体积 + 授权），所以按方案 §1.1 的
 *   「生成式 IR」路线，用**简易头模型 + 早期反射场**在构建期算出一对 IR，
 *   把样本**逐字**写进两侧源码（不是两边各写一份合成代码——那又会分叉）。
 *   ★ 采样率固定 48k；两侧都按输出采样率做**同一套线性插值**重采样（见 spatial.rs / spatialTuning.js）。
 *
 * ── IR 合成模型（简化版，不是实测 HRTF）──────────────────────
 *   对每个预设、每只耳：
 *     ① 直达声：单位脉冲（右耳按 ITD 延迟，模拟声源略偏前方）；
 *     ② 耳廓梳状：直达后 0.12~0.6ms 的若干交替极性小反射（pinna notch 的粗糙近似）；
 *     ③ 房间早期反射：reflectMaxMs 内的稀疏、指数衰减、随机极性抽头；
 *     ④ 扩散尾：指数衰减噪声，填充到 tailMs；双耳相关性 = 1 - decorr
 *        （★ 这是「声源离开头部、声场变宽」的关键：两耳尾段去相关）。
 *     ⑤ 单极低通（damp）模拟空气吸收 / HF 衰减。
 *   ★ taps 上限把 tailMs 卡在 ~10.6ms：这是「短 IR（头相关早期反射）」，
 *     不是房间混响——理由见 JSON 的 _irNote。
 *   ★ 归一化：两耳用**同一个**能量归一因子（Σ(L²+R²)/2 → 1），
 *     使 wet 与 dry 的响度可比（对应 Web Audio ConvolverNode 的 normalize 语义，
 *     但我们显式 pre-normalize 并把 ConvolverNode 设 normalize=false，
 *     从而绕开浏览器归一化口径与 Rust 不一致的风险 —— 方案 §2.1 允许，
 *     条件是「自己补增益补偿」，这里就是那个补偿）。
 *
 * 用法：node scripts/build_spatial_tuning.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC_PATH = resolve(HERE, 'spatial', 'spatial_tuning.json');
const JS_OUT = resolve(ROOT, 'web', 'src', 'core', 'spatialTuning.js');
const RS_OUT = resolve(ROOT, 'src-tauri', 'audio', 'src', 'dsp', 'spatial_tuning.rs');

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

/* ---------------- 数值格式化：两侧共用同一段文本，保证逐位一致 ----------------
   ★ IR 样本用 **9 位有效数字**：binary32 的十进制往返安全位数（7 位不足以保证
     不同 f32 不撞同一个串）。两侧读的是同一段文本、按同一规则舍入到 f32，
     因此结果必然逐位相同——9 位是为了让"写下来的值"也忠实于原始 f64。
   ★ 档位表（wet/stageS…）都是圆整数，7 位足够且更易读。
   ★ Rust 浮点字面量不接受 `e+5` 这种带加号的指数，统一去掉 `+`。 */
function fmtNum(x, digits = 7) {
    if (!Number.isFinite(x)) return '0.0';
    let s = x.toPrecision(digits);
    s = s.replace('e+', 'e');
    if (!/[.e]/.test(s)) s += '.0';
    return s;
}
function fmtArray(arr, digits = 7) {
    return arr.map((v) => fmtNum(v, digits)).join(', ');
}
function wrapRows(arr, perRow, indent, digits = 7) {
    const rows = [];
    for (let i = 0; i < arr.length; i += perRow) {
        rows.push(indent + arr.slice(i, i + perRow).map((v) => fmtNum(v, digits)).join(', ') + ',');
    }
    return rows.join('\n');
}

/** IR 样本专用位数（见 fmtNum 注释）。 */
const IR_DIGITS = 9;

/* ---------------- 确定性 PRNG（mulberry32）---------------- */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ---------------- IR 合成 ---------------- */
function synthIRPair(preset, sampleRate, taps) {
    const ms = (x) => (x * sampleRate) / 1000;
    const L = new Float64Array(taps);
    const R = new Float64Array(taps);
    const rng = mulberry32(preset.seed >>> 0);
    const pre = Math.round(ms(preset.preDelayMs));
    const itd = Math.round(ms(preset.itdMs));
    const clampIdx = (i) => (i >= 0 && i < taps ? i : -1);

    /* ① 直达声 */
    let di = clampIdx(pre);
    if (di >= 0) L[di] += 1.0;
    di = clampIdx(pre + itd);
    if (di >= 0) R[di] += 1.0;

    /* ② 耳廓梳状（每耳独立抽头位置，制造细微的双耳差异） */
    for (let e = 0; e < 2; e++) {
        const arr = e === 0 ? L : R;
        const base = e === 0 ? pre : pre + itd;
        for (let i = 0; i < preset.pinnaCount; i++) {
            const d = Math.round(ms(0.12 + i * 0.18 + rng() * 0.06));
            const idx = clampIdx(base + d);
            if (idx < 0) continue;
            const sign = i % 2 === 0 ? 1 : -1;
            arr[idx] += sign * preset.pinnaGain * Math.pow(preset.pinnaDecay, i);
        }
    }

    /* ③ 房间早期反射（稀疏、指数衰减、随机极性；两耳共享同一反射但右耳加抖动） */
    for (let i = 0; i < preset.reflections; i++) {
        const tms = 1.0 + rng() * preset.reflectMaxMs;
        const g = preset.reflectGain * Math.exp(-tms / preset.reflectTauMs) * (rng() * 2 - 1);
        const jitter = Math.round(ms(rng() * 0.8));
        const idxL = clampIdx(pre + Math.round(ms(tms)));
        const idxR = clampIdx(pre + itd + Math.round(ms(tms)) + jitter);
        if (idxL >= 0) L[idxL] += g;
        if (idxR >= 0) R[idxR] += g;
    }

    /* ④ 扩散尾：指数衰减噪声，双耳相关性 = 1 - decorr */
    const tailStart = Math.max(1, Math.round(ms(1.5)));
    const tailEnd = Math.min(taps, Math.round(ms(preset.tailMs)));
    const n = Math.max(0, tailEnd - tailStart);
    const shared = new Float64Array(n);
    const nl = new Float64Array(n);
    const nr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        shared[i] = rng() * 2 - 1;
        nl[i] = rng() * 2 - 1;
        nr[i] = rng() * 2 - 1;
    }
    const d = Math.max(0, Math.min(1, preset.decorr));
    const a = Math.sqrt(1 - d);
    const b = Math.sqrt(d);
    /* 单极低通：coeff 越小越闷 */
    const lpK = Math.max(0.05, 1 - preset.damp);
    let lpL = 0;
    let lpR = 0;
    /* 先算「直达 + 早期反射」的能量，尾段按 tailEnergyRatio 显式配比——
       否则长尾会通过能量归一化把直达脉冲压到很小，听感变成「糊」
       而不是「空间感」（违背 §1.1『不夸张、保留清晰度』）。 */
    let headEnergy = 0;
    for (let i = 0; i < taps; i++) headEnergy += L[i] * L[i] + R[i] * R[i];
    headEnergy /= 2;

    const tL = new Float64Array(n);
    const tR = new Float64Array(n);
    let tailEnergy = 0;
    for (let i = 0; i < n; i++) {
        const tms = 1.5 + (i * 1000) / sampleRate;
        const env = Math.exp(-(tms - 1.5) / preset.tailTauMs);
        const wL = env * (a * shared[i] + b * nl[i]);
        const wR = env * (a * shared[i] + b * nr[i]);
        lpL += lpK * (wL - lpL);
        lpR += lpK * (wR - lpR);
        tL[i] = lpL;
        tR[i] = lpR;
        tailEnergy += (lpL * lpL + lpR * lpR) / 2;
    }
    const tailTarget = Math.max(0, preset.tailEnergyRatio || 0) * headEnergy;
    const tailScale = tailEnergy > 0 ? Math.sqrt(tailTarget / tailEnergy) : 0;
    for (let i = 0; i < n; i++) {
        L[tailStart + i] += tL[i] * tailScale;
        R[tailStart + i] += tR[i] * tailScale;
    }

    /* ⑤ 双耳共用同一归一因子：Σ(L²+R²)/2 → 1 */
    let energy = 0;
    for (let i = 0; i < taps; i++) energy += L[i] * L[i] + R[i] * R[i];
    const meanEnergy = energy / 2;
    if (meanEnergy > 0) {
        const g = 1 / Math.sqrt(meanEnergy);
        for (let i = 0; i < taps; i++) {
            L[i] *= g;
            R[i] *= g;
        }
    }
    return { left: Array.from(L), right: Array.from(R) };
}

/* ---------------- 生成 IR ---------------- */
const taps = spec.irTaps;
const sr = spec.irSampleRate;
const irs = {};
const irStats = [];
for (const name of spec.irOrder) {
    const preset = spec.irs[name];
    const pair = synthIRPair(preset, sr, taps);
    irs[name] = pair;
    let e = 0;
    let peak = 0;
    for (let i = 0; i < taps; i++) {
        e += pair.left[i] * pair.left[i] + pair.right[i] * pair.right[i];
        peak = Math.max(peak, Math.abs(pair.left[i]), Math.abs(pair.right[i]));
    }
    irStats.push({ name, energy: e / 2, peak });
}

/* ---------------- 生成 JS ---------------- */
const jsIrBlocks = spec.irOrder
    .map((name) => {
        const p = irs[name];
        const label = spec.irs[name].label;
        return `    ${name}: {
        label: ${JSON.stringify(label)},
        left: new Float32Array([
${wrapRows(p.left, 6, '            ', IR_DIGITS)}
        ]),
        right: new Float32Array([
${wrapRows(p.right, 6, '            ', IR_DIGITS)}
        ]),
    },`;
    })
    .join('\n');

const jsSpatialRows = spec.spatialLevels
    .map((lv) => `    ${lv}: { wet: ${fmtNum(spec.spatialTuning[lv].wet)} },`)
    .join('\n');
const jsStageRows = spec.stageLevels
    .map((lv) => {
        const t = spec.stageTuning[lv];
        return `    ${lv}: { stageS: ${fmtNum(t.stageS)}, haasMs: ${fmtNum(t.haasMs)}, haasMix: ${fmtNum(t.haasMix)} },`;
    })
    .join('\n');

const js = `/* ============================================================
 * core/spatialTuning.js — 空间音频 / 虚拟声场 参数与 IR（★ 自动生成，勿手改）
 *
 * 生成器：node scripts/build_spatial_tuning.mjs
 * 参数源：scripts/spatial/spatial_tuning.json
 *
 * 为什么是生成的：方案 §5 要求「档位 → 参数」在 Web 与 Rust 两侧是**同一张表**。
 * dsp/biquad.rs 的教训——两边不一致时用户切到原生后端会听出不同音色，
 * 而两边各自看都『对』，极难归因。生成保证物理上不可能分叉。
 *
 * 本文件同时提供 HRTF 冲激响应（IR）：按方案 §1.1 的「生成式 IR」路线，
 * 用简易头模型 + 早期反射场在构建期算出（我们没有也不该打包实测 HRTF 素材）。
 * ★ 是「短 IR / 简化版」：只含头相关早期反射，不含长房间混响尾——
 *   taps 上限被 Rust 时域 FIR 成本卡死（方案 §2.2/§6），详见 JSON 的 _irNote。
 *
 * ── 空间音频（HRTF 卷积）────────────────────────────────────
 * wet 档位：out = dry·(1-wet) + wetConv·wet。dry 保清晰度（HRTF 天然低通）。
 * ── 虚拟声场（M/S 展宽 + Haas）──────────────────────────────
 * P1 已落 Web 侧；P2 对齐到 Rust。档位枚举不含 strong（方案 §8.2 不做跨耳抵消）。
 * ★ 单声道安全：M 不动 ⇒ 左右相加不抵消；Haas 改相位但幅度克制，已实测。
 * ============================================================ */

/** IR 参考采样率。两侧都按输出采样率做同一套线性插值重采样，故此处仅记录基准。 */
export const IR_SAMPLE_RATE = ${sr};

/** IR 长度（taps，单耳）。两侧必须相同，否则声音不一致。 */
export const IR_TAPS = ${taps};

/* ---------------------------------------------------------------
 * 空间音频（HRTF 卷积）档位 → 参数
 * ------------------------------------------------------------- */

/**
 * 档位 → { wet }。字段含义（Rust 侧 spatial_tuning.rs 逐字对应）：
 *   wet — 湿声比例。0 = 全干（旁通），1 = 全湿（必然糊，方案 §1.1 警告）。
 */
export const SPATIAL_TUNING = {
${jsSpatialRows}
};

/** 合法档位（顺序即 UI 顺序）。'off' 由开关表达，不进本表。 */
export const SPATIAL_LEVELS = [${spec.spatialLevels.map((s) => `'${s}'`).join(', ')}];

/** 缺省档位：用户拍板「打开后默认落在轻档」。 */
export const SPATIAL_DEFAULT = '${spec.spatialDefault}';

/**
 * 取某档参数；非法档位回落到缺省档（不抛，音频路径不该因一个脏值静音）。
 * @param {string} level
 * @returns {{wet:number}}
 */
export function spatialTuningFor(level) {
    return SPATIAL_TUNING[level] || SPATIAL_TUNING[SPATIAL_DEFAULT];
}

/* ---------------------------------------------------------------
 * HRTF 冲激响应（IR）
 * ------------------------------------------------------------- */

/** IR 预设名（顺序即 UI 顺序）。 */
export const IR_ORDER = [${spec.irOrder.map((s) => `'${s}'`).join(', ')}];

/** 缺省 IR 预设。 */
export const IR_DEFAULT = '${spec.irDefault}';

/**
 * 每个预设一对 IR（左耳 / 右耳），已按能量归一化（两耳共用归一因子）。
 * ★ 直接用 Float32Array，喂给 ConvolverNode 时把 normalize 设为 **false**——
 *   我们已经 pre-normalize，让浏览器再归一化一次会让两侧口径不一致。
 */
export const SPATIAL_IRS = {
${jsIrBlocks}
};

/**
 * 取某个 IR 预设；非法名回落到缺省预设（不抛）。
 * @param {string} name
 * @returns {{label:string, left:Float32Array, right:Float32Array}}
 */
export function irFor(name) {
    return SPATIAL_IRS[name] || SPATIAL_IRS[IR_DEFAULT];
}

/**
 * 线性插值重采样（IR 用）。IR 固定 48k，但输出采样率可能是 44.1k / 96k / 192k
 * （独占保留源采样率，方案 §2.2 差异点 3）。
 * ★ 与 Rust 侧 spatial_tuning.rs 的 resample_linear 是**同一算法**——
 *   这是「两侧逐样本一致」的必要条件。改一处 = 必须改生成器（不是改另一处）。
 * @param {ArrayLike<number>} src
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(src, fromRate, toRate) {
    const n = src.length;
    if (!n || fromRate === toRate) return Float32Array.from(src);
    const ratio = toRate / fromRate;
    const outLen = Math.max(1, Math.round(n * ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i / ratio;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = i0 < n ? src[i0] : 0;
        const b = i0 + 1 < n ? src[i0 + 1] : 0;
        out[i] = a + (b - a) * frac;
    }
    return out;
}

/* ---------------------------------------------------------------
 * 虚拟声场（M/S 展宽 + Haas 微延时）
 * ------------------------------------------------------------- */

/**
 * 档位 → 参数（Rust 侧 spatial_tuning.rs 逐字对应）：
 *   stageS  — S（差）通道增益。1.0 = 原样，>1 = 展宽。
 *   haasMs  — 对侧声道微延时（ms）。0 = 不启用（纯 M/S）。
 *   haasMix — Haas 支路混入比例（0~1）。仅 haasMs > 0 时有意义。
 */
export const STAGE_TUNING = {
${jsStageRows}
};

/** 合法档位（顺序即 UI 顺序）。 */
export const STAGE_LEVELS = [${spec.stageLevels.map((s) => `'${s}'`).join(', ')}];

/** 缺省档位。 */
export const STAGE_DEFAULT = '${spec.stageDefault}';

/**
 * 取某档参数；非法档位回落到缺省档（不抛）。
 * @param {string} level
 * @returns {{stageS:number, haasMs:number, haasMix:number}}
 */
export function stageTuningFor(level) {
    return STAGE_TUNING[level] || STAGE_TUNING[STAGE_DEFAULT];
}

/** 自定义强档键位预留（跨耳抵消，方案明确不做）。保留常量名让「为什么没有 strong」可检索。 */
export const STAGE_STRONG_RESERVED = 'strong';
`;

/* ---------------- 生成 Rust ---------------- */
function rsIrConst(name, ear, arr) {
    const cname = `IR_${name.toUpperCase()}_${ear.toUpperCase()}`;
    return `pub const ${cname}: [f32; IR_TAPS] = [
${wrapRows(arr, 4, '    ', IR_DIGITS)}
];`;
}

const rsSpatialRows = spec.spatialLevels
    .map((lv) => `    SpatialTuning { wet: ${fmtNum(spec.spatialTuning[lv].wet)} },`)
    .join('\n');
const rsStageRows = spec.stageLevels
    .map((lv) => {
        const t = spec.stageTuning[lv];
        return `    StageTuning { stage_s: ${fmtNum(t.stageS)}, haas_ms: ${fmtNum(t.haasMs)}, haas_mix: ${fmtNum(t.haasMix)} },`;
    })
    .join('\n');

const rsIrConsts = spec.irOrder
    .map((name) => {
        const p = irs[name];
        return `/// ${spec.irs[name].label}（${name}）
${rsIrConst(name, 'l', p.left)}

/// ${spec.irs[name].label}（${name}）
${rsIrConst(name, 'r', p.right)}`;
    })
    .join('\n\n');

const rsIrMatch = spec.irOrder
    .map((name) => `        "${name}" => (&IR_${name.toUpperCase()}_L, &IR_${name.toUpperCase()}_R),`)
    .join('\n');

const rs = `//! 空间音频 / 虚拟声场 —— 参数与 IR（★ 由 scripts/build_spatial_tuning.mjs 生成，勿手改）。
//!
//! 参数源：scripts/spatial/spatial_tuning.json。
//! 与 Web 侧 \`web/src/core/spatialTuning.js\` 是**同一份数据**的两种语言形态，
//! 由生成器保证逐位一致（方案 §5 的硬约束）。
//!
//! ★ IR 是「短 IR / 简化版 HRTF」：taps 上限由本模块的时域 FIR 成本决定
//!   （方案 §2.2/§6：≤512 taps，再长要引入 rustfft 做 FFT 分块卷积）。
//!   采样率固定 48k；使用方须按 output.sample_rate() 用 spatial.rs 的
//!   \`resample_linear\` 重采样（与 Web 侧同算法）。

/// IR 参考采样率。使用前必须按输出采样率重采样。
pub const IR_SAMPLE_RATE: u32 = ${sr};

/// IR 长度（taps，单耳）。Web 侧同值。
pub const IR_TAPS: usize = ${taps};

/// 空间音频档位 → wet。字段与 Web 侧 SPATIAL_TUNING 逐字对应。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialTuning {
    /// 湿声比例。0 = 全干（旁通），1 = 全湿。
    pub wet: f32,
}

/// 档位顺序。'off' 由开关表达，不进本表。
pub const SPATIAL_LEVELS: [&str; ${spec.spatialLevels.length}] = [${spec.spatialLevels.map((s) => `"${s}"`).join(', ')}];

/// 缺省档位。
pub const SPATIAL_DEFAULT: &str = "${spec.spatialDefault}";

/// 与 Web 侧 SPATIAL_TUNING 完全一致。
pub const SPATIAL_TUNING: [SpatialTuning; ${spec.spatialLevels.length}] = [
${rsSpatialRows}
];

/// 虚拟声场档位 → 参数。字段与 Web 侧 STAGE_TUNING 逐字对应。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StageTuning {
    /// S（差）通道增益。1.0 = 原样，>1 = 展宽。
    pub stage_s: f32,
    /// 对侧声道微延时（ms）。0 = 不启用。
    pub haas_ms: f32,
    /// Haas 支路混入比例（0~1）。
    pub haas_mix: f32,
}

/// 档位顺序（不含 strong，方案 §8.2）。
pub const STAGE_LEVELS: [&str; ${spec.stageLevels.length}] = [${spec.stageLevels.map((s) => `"${s}"`).join(', ')}];

/// 缺省档位。
pub const STAGE_DEFAULT: &str = "${spec.stageDefault}";

/// 与 Web 侧 STAGE_TUNING 完全一致。
pub const STAGE_TUNING: [StageTuning; ${spec.stageLevels.length}] = [
${rsStageRows}
];

/// IR 预设名（顺序即 UI 顺序）。
pub const IR_ORDER: [&str; ${spec.irOrder.length}] = [${spec.irOrder.map((s) => `"${s}"`).join(', ')}];

/// 缺省 IR 预设。
pub const IR_DEFAULT: &str = "${spec.irDefault}";

${rsIrConsts}

/// 取档位参数；未知档位回落缺省（不抛——音频路径不该因脏值静音）。
pub fn spatial_tuning_for(level: &str) -> SpatialTuning {
    SPATIAL_LEVELS
        .iter()
        .position(|n| *n == level)
        .map(|i| SPATIAL_TUNING[i])
        .unwrap_or(SPATIAL_TUNING[0])
}

/// 取虚拟声场档位参数；未知档位回落缺省。
pub fn stage_tuning_for(level: &str) -> StageTuning {
    STAGE_LEVELS
        .iter()
        .position(|n| *n == level)
        .map(|i| STAGE_TUNING[i])
        .unwrap_or(STAGE_TUNING[0])
}

/// 取某一对 IR（左耳，右耳）；未知预设回落缺省。
pub fn ir_pair_for(name: &str) -> (&'static [f32; IR_TAPS], &'static [f32; IR_TAPS]) {
    match name {
${rsIrMatch}
        _ => (&IR_${spec.irDefault.toUpperCase()}_L, &IR_${spec.irDefault.toUpperCase()}_R),
    }
}

/// 线性插值重采样（IR 用）。IR 固定 48k，但输出采样率可能是
/// 44.1k / 96k / 192k（独占保留源采样率，方案 §2.2 差异点 3）。
/// ★ 与 Web 侧 spatialTuning.js 的 resampleLinear 是**同一算法**——
///   这是「两侧逐样本一致」的必要条件。改一处 = 必须改生成器。
pub fn resample_linear(src: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    let n = src.len();
    if n == 0 || from_rate == to_rate {
        return src.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((n as f64) * ratio).round().max(1.0) as usize;
    let mut out = vec![0.0f32; out_len];
    for i in 0..out_len {
        let pos = i as f64 / ratio;
        let i0 = pos.floor() as usize;
        let frac = pos - i0 as f64;
        let a = if i0 < n { src[i0] as f64 } else { 0.0 };
        let b = if i0 + 1 < n { src[i0 + 1] as f64 } else { 0.0 };
        out[i] = (a + (b - a) * frac) as f32;
    }
    out
}
`;

mkdirSync(dirname(JS_OUT), { recursive: true });
mkdirSync(dirname(RS_OUT), { recursive: true });
writeFileSync(JS_OUT, js, 'utf8');
writeFileSync(RS_OUT, rs, 'utf8');

console.log('build_spatial_tuning: 生成完毕');
console.log(`  JS  -> ${JS_OUT}`);
console.log(`  RS  -> ${RS_OUT}`);
console.log(`  IR  -> ${sr} Hz / ${taps} taps (${((taps / sr) * 1000).toFixed(2)} ms)`);
for (const s of irStats) {
    console.log(`      ${s.name.padEnd(5)} energy/ear=${s.energy.toFixed(6)}  peak=${s.peak.toFixed(4)}`);
}
console.log(`  spatial: ${spec.spatialLevels.map((l) => `${l}=${spec.spatialTuning[l].wet}`).join(' ')}`);
console.log(`  stage  : ${spec.stageLevels.map((l) => `${l}=${spec.stageTuning[l].stageS}`).join(' ')}`);
