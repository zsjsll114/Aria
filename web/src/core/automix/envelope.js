/* ============================================================
 * core/automix/envelope.js — Automix 信号分析纯函数（无浏览器 API，node 可测）
 *
 * Phase 0（Automix-技术方案.md §3.1）：RMS 能量包络 → intro/outro 边界点 + BPM 自相关。
 * 与 analyzer.js 的分工：本文件只做数学——收 Float32Array 吐数值，不碰
 * fetch / OfflineAudioContext / IndexedDB（那些全在 analyzer.js）。
 * 这样信号处理可以在 node --test 下用合成音频夹具直接验证，不用 mock 浏览器。
 *
 * 单位约定：所有时间量一律毫秒（与项目歌词时间契约一致，parseLrc 输出 ms）。
 *
 * BPM 差异策略（方案 §3.3.1）对本文件的依赖：
 *   · 呼吸点交叉需要 outroSparsePoint（比 outroPoint 更靠后的稀疏出口）；
 *   · 对拍交叉与「置信度低降级」需要 bpmConfidence——纯器乐/长铺垫的
 *     自相关不收敛时 confidence 归 0、bpm 为 null，调度层按最保守处理。
 * ============================================================ */

/** 包络窗口长（毫秒）。50ms ≈ 人耳把连续能量感知为「节拍强度」的最小粒度。 */
export const AUTOMIX_WINDOW_MS = 50;
/** 分析采样率（Hz）。22.05kHz 单声道足够分辨节拍，4 分钟歌 ≈ 10MB float32。 */
export const AUTOMIX_ANALYSIS_RATE = 22050;

/**
 * 滑窗 RMS 能量包络。
 * @param {Float32Array} samples 单声道采样
 * @param {number} sampleRate 采样率
 * @param {number} [windowMs] 窗口长（毫秒）
 * @returns {{ env: Float32Array, frameMs: number }}
 */
export function computeRmsEnvelope(samples, sampleRate, windowMs = AUTOMIX_WINDOW_MS) {
    const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
    const frameCount = Math.floor(samples.length / windowSamples);
    const env = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
        let sum = 0;
        const base = f * windowSamples;
        for (let i = 0; i < windowSamples; i++) {
            const s = samples[base + i];
            sum += s * s;
        }
        env[f] = Math.sqrt(sum / windowSamples);
    }
    return { env, frameMs: windowMs };
}

/**
 * intro 静音终点：裁掉开头的真静音（编码文件的噪声底 ≪ 峰值 2%）。
 * 语义是「裁真静音」而不是「跳过安静的开场」——后者（气声/弱起人声）
 * RMS 可达峰值 10%+，绝不能裁，所以阈值必须钉死在峰值附近的绝对低比，
 * 不能用均值比例（安静开场多的歌会把均值拖低造成误裁）。
 * @param {Float32Array} env RMS 包络
 * @param {number} frameMs 每帧毫秒
 * @param {{ ratio?: number, minQuietMs?: number }} [opts]
 * @returns {number} 毫秒；开头无静音返回 0
 */
export function findIntroPoint(env, frameMs, { ratio = 0.02, minQuietMs = 300 } = {}) {
    const n = env.length;
    if (n === 0) return 0;
    let peak = 0;
    for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
    const threshold = peak * ratio;
    /* 从头数连续低于阈值的帧数 */
    let quietFrames = 0;
    while (quietFrames < n && env[quietFrames] < threshold) quietFrames++;
    if (quietFrames * frameMs < minQuietMs) return 0;
    return quietFrames * frameMs;
}

/**
 * outro 衰减点与稀疏点。
 * outroPoint = 从尾部回扫第一个「能量 ≥ 峰值×peakRatio」窗口的**结束处**——
 *   即 A 最早可以开始交叉的位置（鼓点已进入衰减）。
 * outroSparsePoint = 更靠后的备选出口（能量 ≥ 峰值×sparseRatio 的最后位置），
 *   供呼吸点交叉（方案 §3.3.1 第二层）把 A 撑到更接近结尾的稀疏区。
 * 尾部无衰减（突然截断）时两点都返回全曲时长——这不是错误，是给调度层的信号：
 *   「这首没有自然淡出，重叠交叉会切在响处，优先降级 segue」。
 * @param {Float32Array} env RMS 包络
 * @param {number} frameMs 每帧毫秒
 * @param {{ peakRatio?: number, sparseRatio?: number }} [opts]
 * @returns {{ outroPointMs: number, outroSparsePointMs: number }}
 */
export function findOutroPoints(env, frameMs, { peakRatio = 0.30, sparseRatio = 0.10 } = {}) {
    const n = env.length;
    const durationMs = n * frameMs;
    if (n === 0) return { outroPointMs: 0, outroSparsePointMs: 0 };
    let peak = 0;
    for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
    if (peak <= 0) return { outroPointMs: durationMs, outroSparsePointMs: durationMs };

    let outroPointMs = durationMs;
    for (let i = n - 1; i >= 0; i--) {
        if (env[i] >= peak * peakRatio) {
            outroPointMs = (i + 1) * frameMs;
            break;
        }
    }
    let outroSparsePointMs = durationMs;
    for (let i = n - 1; i >= 0; i--) {
        if (env[i] >= peak * sparseRatio) {
            outroSparsePointMs = (i + 1) * frameMs;
            break;
        }
    }
    return { outroPointMs, outroSparsePointMs };
}

/**
 * BPM 估计：包络一阶差分（onset 强度）→ 去均值自相关 → 峰值 → 派物线插值细化。
 * octave 折叠到 70~180（DJ 惯例的「可辨拍频」区间）。
 * @param {Float32Array} env RMS 包络
 * @param {number} frameMs 每帧毫秒
 * @param {{ minBpm?: number, maxBpm?: number }} [opts]
 * @returns {{ bpm: number|null, confidence: number }}
 *   confidence = 自相关峰值 / 区间内绝对值均值；纯器乐等无节拍内容收敛失败时
 *   bpm 为 null、confidence 为 0（调度层据此走「置信度低」分支）。
 */
export function estimateBpm(env, frameMs, { minBpm = 60, maxBpm = 180 } = {}) {
    const n = env.length;
    if (n < 20) return { bpm: null, confidence: 0 };
    /* onset：能量上升量（拍点=能量突增） */
    const onset = new Float64Array(n - 1);
    let onsetMean = 0;
    for (let i = 1; i < n; i++) {
        const d = env[i] - env[i - 1];
        onset[i - 1] = d > 0 ? d : 0;
        onsetMean += onset[i - 1];
    }
    onsetMean /= onset.length;
    if (onsetMean <= 0) return { bpm: null, confidence: 0 };
    /* ★ 相对幅度守卫：onset 峰值不到包络峰值的 1% 说明「节拍感」是包络量化噪声
       （实测恒定正弦会因窗口相位漂移产生 ~1e-3 量级的假 onset，自相关收敛出
       171 BPM 这类伪拍），直接判无节拍。真音乐的鼓点 onset 是包络峰值的几十%。 */
    let envPeak = 0;
    for (let i = 0; i < n; i++) if (env[i] > envPeak) envPeak = env[i];
    let onsetMax = 0;
    for (let i = 0; i < onset.length; i++) if (onset[i] > onsetMax) onsetMax = onset[i];
    if (onsetMax < envPeak * 0.01) return { bpm: null, confidence: 0 };
    for (let i = 0; i < onset.length; i++) onset[i] -= onsetMean;

    const frameHz = 1000 / frameMs;
    const lagMin = Math.max(2, Math.floor(frameHz * 60 / maxBpm));
    const lagMax = Math.min(onset.length - 1, Math.ceil(frameHz * 60 / minBpm));
    if (lagMax <= lagMin) return { bpm: null, confidence: 0 };

    const ac = new Float64Array(lagMax + 1);
    let absSum = 0;
    let absCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
        let s = 0;
        for (let i = 0; i + lag < onset.length; i++) s += onset[i] * onset[i + lag];
        ac[lag] = s;
        absSum += Math.abs(s);
        absCount++;
    }
    const absMean = absSum / absCount;
    if (absMean <= 0) return { bpm: null, confidence: 0 };

    let bestLag = -1;
    let bestVal = 0;
    for (let lag = lagMin + 1; lag < lagMax; lag++) {
        if (ac[lag] > bestVal) { bestVal = ac[lag]; bestLag = lag; }
    }
    if (bestLag < 0 || bestVal <= 0) return { bpm: null, confidence: 0 };

    /* 派物线插值细化 lag（20fps 下 120BPM 附近裸粒度 ±13BPM，插值后收敛到 ±3 内） */
    let lag = bestLag;
    const yPrev = ac[bestLag - 1];
    const yNext = ac[bestLag + 1];
    const denom = yPrev - 2 * bestVal + yNext;
    if (denom !== 0) {
        const delta = 0.5 * (yPrev - yNext) / denom;
        if (delta > -1 && delta < 1) lag = bestLag + delta;
    }

    let bpm = 60000 / (lag * frameMs);
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return { bpm, confidence: bestVal / absMean };
}

/**
 * 一次算全套（analyzer.js 与测试共用入口）。
 * @param {Float32Array} samples 单声道 @ AUTOMIX_ANALYSIS_RATE
 * @param {number} sampleRate
 * @returns {{ introPointMs: number, outroPointMs: number, outroSparsePointMs: number,
 *             bpm: number|null, bpmConfidence: number, meanEnergy: number,
 *             durationMs: number, frameMs: number }}
 */
export function analyzeEnvelope(samples, sampleRate) {
    const { env, frameMs } = computeRmsEnvelope(samples, sampleRate);
    let meanEnergy = 0;
    for (let i = 0; i < env.length; i++) meanEnergy += env[i];
    meanEnergy = env.length ? meanEnergy / env.length : 0;
    const { outroPointMs, outroSparsePointMs } = findOutroPoints(env, frameMs);
    const { bpm, confidence } = estimateBpm(env, frameMs);
    return {
        introPointMs: findIntroPoint(env, frameMs),
        outroPointMs,
        outroSparsePointMs,
        bpm,
        bpmConfidence: confidence,
        meanEnergy,
        durationMs: env.length * frameMs,
        frameMs,
    };
}
