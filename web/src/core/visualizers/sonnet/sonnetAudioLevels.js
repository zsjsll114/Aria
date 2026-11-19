/* ============================================================
 * sonnetAudioLevels.js — 把共享频谱折算成 folia sonnet 要的三个量（bass / power / vocal）
 *
 * 这不是「移植文件」，是 Aria 侧的适配层：上游把 `audioBands`/`audioPower` 作为 props
 * 一路传进运行时（VisualizerSonnet → createSonnetPixiRuntime → sonnetShotFrame /
 * sonnetShotMg），本仓没有那条 React 链路，改由 sonnetMode 的逐帧循环读共享 analyser 后
 * 经 `SonnetEngine.setAudioLevels()` 灌进去。
 *
 * ── 上游口径（机械对齐 usePlaybackVisualizerBridge.ts:101-120）──────────────
 *   getEnergy(minHz, maxHz) = 该频段内 FFT 幅值的**平均**（0~255）
 *   process(v, boost)       = pow(v / 255, boost) * 255
 *   bass   = process(getEnergy(20, 150),    1.8)
 *   lowMid = process(getEnergy(150, 400),   2)
 *   vocal  = process(getEnergy(1000, 3500), 1.5)
 *   power  = process((bass + lowMid) / 2,   3)
 * 引擎侧只消费 bass / power / vocal（见 sonnetShotMgFull 的
 * `updateTime(time, cues, shotStart, shotEnd, audioBass, audioPower, audioVocal)`）。
 * ★ 刻度是 **0~255**（不是 0~1）：那正是上游 `process()` 的返回值口径，也对得上移植过来的
 *   `normalizeAudioLevel(v) = v > 1 ? v / 255 : v`。喂 0~1 虽然也能work，但含义就变了。
 *
 * ── 分辨率现实（必须知道）──────────────────────────────────────────
 * 本仓只有**一颗**共享 analyser：core/equalizer.js:849 建图时挂在链路末端的
 * `window.playerAudioAnalyser`，**fftSize=128 → 64 个 bin**（每 bin ≈ sampleRate/128 ≈ 344~375Hz）。
 * 上游是自建 FFT、频点可任意取；这里只能把 Hz 区间映射到 bin 下标，**低频段因此偏粗**
 * （20~150Hz 整个落进 bin 0）。不新建音频节点、也不改这颗的 fftSize 是有意的：
 * 改它会连带改掉 306-energy-motion 的低频口径（那里按 bins 0~3 = 0~1.5kHz 取）。
 *
 * ── 一条边界 ──────────────────────────────────────────────────
 * 走原生 WASAPI 独占输出时音频不过 WebAudio 图，`window.playerAudioAnalyser` 没有数据
 * → 本条静默给出 0（与 306-energy-motion 同一条边界，不是坏）。
 * ============================================================ */

/** 与上游 getEnergy 一致的三段频带（Hz） */
export const SONNET_BANDS_HZ = {
    bass: [20, 150],
    lowMid: [150, 400],
    vocal: [1000, 3500],
};

/** 与上游 process() 的指数提升一致 */
export const SONNET_BAND_BOOST = { bass: 1.8, lowMid: 2, vocal: 1.5, power: 3 };

/** 全零：引擎在没数据时必须有确定值（不要 undefined，否则下游做算术会出 NaN） */
export const SONNET_SILENT_LEVELS = Object.freeze({ bass: 0, power: 0, vocal: 0 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Hz 区间 → bin 下标区间（闭区间）。
 * @param {number} minHz
 * @param {number} maxHz
 * @param {number} sampleRate 来自 analyser.context.sampleRate
 * @param {number} fftSize 来自 analyser.fftSize（bin 数 = fftSize / 2）
 * @param {number} binCount 实际可用的 bin 数（analyser.frequencyBinCount）
 * @returns {{from:number, to:number}} 一定满足 0 ≤ from ≤ to ≤ binCount-1（binCount 为 0 时都给 0）
 */
export function bandBinRange(minHz, maxHz, sampleRate, fftSize, binCount) {
    const last = Math.max(0, Math.floor(binCount) - 1);
    const sr = Number(sampleRate);
    const size = Number(fftSize);
    /* 采样率/fftSize 拿不到时退化成"整个频段用 bin 0"——宁可粗，也不要算出 NaN 下标 */
    if (!Number.isFinite(sr) || sr <= 0 || !Number.isFinite(size) || size <= 0) return { from: 0, to: 0 };
    const binWidth = sr / size;
    /* ★ NaN 必须在这里收口：`clamp(NaN, …)` 的两个比较都是 false，会把 NaN 原样放出去，
       于是下标变 NaN → 取值为 undefined → 整条音频驱动静默失效（与本次要修的 bug 同一类）。 */
    const safeHz = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
    const from = clamp(Math.floor(safeHz(minHz) / binWidth), 0, last);
    const to = clamp(Math.floor(safeHz(maxHz) / binWidth), 0, last);
    return { from: Math.min(from, to), to: Math.max(from, to) };
}

/**
 * bin 区间内的平均值（0~255）。取平均而非峰值：峰值会被单个尖峰 bin 带飞
 * （与 core/energyMotion.js 的 lowEnergyFromFreqData 同一理由）。
 */
export function bandAverage(freq, from, to) {
    if (!freq || typeof freq.length !== 'number' || freq.length === 0) return 0;
    const lo = clamp(Math.floor(from), 0, freq.length - 1);
    const hi = clamp(Math.floor(to), 0, freq.length - 1);
    let sum = 0;
    let n = 0;
    for (let i = lo; i <= hi; i++) {
        const v = Number(freq[i]);
        if (Number.isFinite(v)) { sum += v; n++; }
    }
    return n ? sum / n : 0;
}

/** 上游 process()：归一 → 幂提升 → 回到 0~255 */
export function boostBand(value, boost) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    const b = Number(boost);
    const normalized = clamp(v, 0, 255) / 255;
    if (!Number.isFinite(b) || b === 0) return clamp(v, 0, 255);
    return clamp(Math.pow(normalized, b) * 255, 0, 255);
}

/**
 * 主入口：频谱 → 引擎要的三个量。
 * @param {Uint8Array|ArrayLike<number>|null} freq `getByteFrequencyData` 的结果
 * @param {number} sampleRate
 * @param {number} fftSize
 * @returns {{bass:number, power:number, vocal:number}} 均为 0~255
 */
export function resolveSonnetAudioLevels(freq, sampleRate, fftSize) {
    if (!freq || typeof freq.length !== 'number' || freq.length === 0) return { ...SONNET_SILENT_LEVELS };
    const binCount = freq.length;
    const rangeOf = (band) => bandBinRange(band[0], band[1], sampleRate, fftSize, binCount);
    const bassRange = rangeOf(SONNET_BANDS_HZ.bass);
    const lowMidRange = rangeOf(SONNET_BANDS_HZ.lowMid);
    const vocalRange = rangeOf(SONNET_BANDS_HZ.vocal);
    const bassRaw = bandAverage(freq, bassRange.from, bassRange.to);
    const lowMidRaw = bandAverage(freq, lowMidRange.from, lowMidRange.to);
    const vocalRaw = bandAverage(freq, vocalRange.from, vocalRange.to);
    return {
        bass: boostBand(bassRaw, SONNET_BAND_BOOST.bass),
        /* power = 上游的 (bass + lowMid) / 2 再三次方提升 */
        power: boostBand((bassRaw + lowMidRaw) / 2, SONNET_BAND_BOOST.power),
        vocal: boostBand(vocalRaw, SONNET_BAND_BOOST.vocal),
    };
}
