/* ============================================================
 * core/energyMotion.js — 音频能量驱动的视觉微动效（需求 19）纯逻辑层
 *
 * 需求口径一句话：**低频强 → 元素轻微放大 1%~2% / 光晕增强 → 再回弹**，
 * 参数**极度克制**，且**不新增频谱模式**（只是给现有画面加一层几乎察觉不到的呼吸）。
 *
 * ★ 为什么放大上限写死 2%：这类效果唯一的失败方式是"过头"。
 *   超过 2% 就不再是"低频强时轻轻一涨"，而是一个会跟着鼓点抽搐的封面；
 *   连续看十分钟非常累。所以上限是**硬约束**，由本模块保证，
 *   不交给调用方传参随便放大（opts.maxScale 也会被夹回来）。
 *
 * ★ 为什么要有阈值（threshold）而不是直接用能量：安静的段落里底层噪声
 *   也会让封面一直在轻微呼吸，看起来像画面在抖。只有明确"有低频"时才动。
 *
 * ★ 为什么起得快、落得慢（attack 60ms / release 420ms）：
 *   起得慢会错过鼓点（听感上"没反应"），落得慢则是留出回弹的余韵；
 *   反过来（起慢落快）看起来像在抽搐。这两个数是本效果的手感核心。
 * ============================================================ */

/** 低频取前几个 bin（fftSize=128 时每个 bin ≈ 375Hz，前 4 个 ≈ 0~1.5kHz） */
export const LOW_BIN_COUNT = 4;

/** 硬上限：放大到 1.02 倍（+2%），任何调用方都改不大 */
export const ENERGY_MAX_SCALE_CAP = 1.02;

export const ENERGY_DEFAULTS = {
    minScale: 1,
    maxScale: ENERGY_MAX_SCALE_CAP,
    /* 起得快、落得慢 —— 手感核心，别随手改 */
    attackMs: 60,
    releaseMs: 420,
    /* 低于这个原始能量视为静音段，直接回落（挡掉底噪导致的持续微颤） */
    threshold: 0.18,
    bins: LOW_BIN_COUNT,
};

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/**
 * 从 AnalyserNode 的 `getByteFrequencyData` 结果里取低频能量（0~1）。
 * 取**平均而不是峰值**：峰值会被单个尖峰bin带飞，平均才是"这一段有多低"。
 * @param {Uint8Array|ArrayLike<number>} freq
 * @param {number} [bins]
 */
export function lowEnergyFromFreqData(freq, bins = LOW_BIN_COUNT) {
    if (!freq || typeof freq.length !== 'number' || freq.length === 0) return 0;
    const n = Math.max(1, Math.min(Math.floor(bins) || LOW_BIN_COUNT, freq.length));
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const v = Number(freq[i]);
        sum += Number.isFinite(v) ? v : 0;
    }
    return clamp01((sum / n) / 255);
}

/** 把 0~1 的能量映射成缩放倍率（永远落在 [1, 1.02] 内） */
export function scaleFromLevel(level, opts) {
    const o = Object.assign({}, ENERGY_DEFAULTS, opts || {});
    const max = Math.min(Number(o.maxScale) || ENERGY_MAX_SCALE_CAP, ENERGY_MAX_SCALE_CAP);
    const min = Number(o.minScale) || 1;
    const l = clamp01(level);
    return min + (max - min) * l;
}

/**
 * 能量包络器（有状态）。时间由调用方注入（`update(level, nowMs)`），
 * 所以可以在单测里精确推进时间，不依赖 rAF/Date.now。
 */
export function createEnergyMotion(opts) {
    const o = Object.assign({}, ENERGY_DEFAULTS, opts || {});
    o.maxScale = Math.min(Number(o.maxScale) || ENERGY_MAX_SCALE_CAP, ENERGY_MAX_SCALE_CAP);
    o.minScale = Number(o.minScale) || 1;

    let value = 0;
    let lastT = null;

    function reset() {
        value = 0;
        lastT = null;
    }

    /**
     * 推进一步。
     * @param {number} raw 原始低频能量 0~1（来自 lowEnergyFromFreqData 或外部推送）
     * @param {number} nowMs 单调时钟（毫秒）
     * @returns {{level:number, scale:number, glow:number}}
     */
    function update(raw, nowMs) {
        const level = clamp01(raw);
        /* 阈值以下（含底噪）目标为 0；以上线性重映射到 0~1，避免刚过阈值就跳一大格 */
        const target = level < o.threshold ? 0 : (level - o.threshold) / (1 - o.threshold);

        const t = Number(nowMs);
        if (lastT === null || !Number.isFinite(t)) {
            /* 首帧直接到位：否则每次开始播放都要等几百毫秒才见到第一次呼吸 */
            value = target;
            lastT = Number.isFinite(t) ? t : 0;
        } else {
            const dt = Math.max(0, t - lastT);
            lastT = t;
            const tau = (target > value ? o.attackMs : o.releaseMs);
            const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
            value += (target - value) * alpha;
        }
        value = clamp01(value);
        return { level: value, scale: scaleFromLevel(value, o), glow: value };
    }

    return { update, reset, opts: o, get level() { return value; } };
}
