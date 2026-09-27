/* ============================================================
 * core/wordAligner.js — 频谱逐字对齐（纯函数，零依赖，可在 Node 单测）
 *
 * 要解决的问题：只有行级时间戳的歌词，此前由 parsers/wordTiming.js 按行时长
 * **均分**摊成逐字——节奏对不上拖腔和停顿。本模块用音频包络把每个字的起点
 * 拉到真实的发声起始点上。
 *
 * 为什么在浏览器里做而不是接 whisper/stable-whisper：
 *   后端有「Python 纯标准库」硬约束（要 PyInstaller 打进绿色包，用户机器没有
 *   Python/Node），而 stable-whisper 会拖进 torch + 模型权重（GB 级）。
 *   WebAudio 的 decodeAudioData 已经能解本工程实际用到的 FLAC
 *   （core/chorusDetector.js 早就在这么干），所以对齐放在前端、零新增依赖。
 *   代价是精度不及强制对齐：这里只能定位「能量起始」，识别不了音素。
 *
 * 算法：
 *   1) buildOnsetEnvelope —— 预加重（一阶差分，突出辅音/声母的攻击）→ 分帧 RMS
 *      → 正向差分（谱通量的时域近似，只保留能量上升沿）→ 局部均值归一。
 *      不做 FFT：既有分辨率够用，又省掉一次全曲 STFT 的开销。
 *   2) alignLine —— 在 [lineStart, lineEnd) 窗口内做单调 DP 选 N-1 个边界：
 *      代价 = 时长先验偏离² / 期望时长  −  β·该边界处的 onset 强度。
 *      先验项保证不会被噪声拽乱，onset 项把边界吸到实际发声点上。
 *
 * 关键性质：**没有信号可依据时自动退化成均分**，所以任何情况下都不会比
 * 现有的摊平兜底更差。
 * ============================================================ */

/** 帧移：20ms 才够分辨音节级起始 */
export const HOP_MS_DEFAULT = 20;

/* 时长先验与 onset 奖励的相对权重 */
const LAMBDA_DURATION = 1;
const BETA_ONSET = 40;
/* 单字最长不超过期望时长的这个倍数（拖腔要留余地，但挡住被噪声拽飞） */
const MAX_STRETCH = 4;

/**
 * 由 PCM 生成 onset 包络。
 * @param {Float32Array} samples 单声道 PCM
 * @param {number} sampleRate
 * @param {{hopMs?: number}} [opts]
 * @returns {{values: Float32Array, hopMs: number}} values[f] 对应 t = f*hopMs 毫秒
 */
export function buildOnsetEnvelope(samples, sampleRate, opts = {}) {
    const hopMs = Number(opts.hopMs) > 0 ? Number(opts.hopMs) : HOP_MS_DEFAULT;
    const sr = Number(sampleRate);
    if (!samples || !samples.length || !Number.isFinite(sr) || sr <= 0) {
        return { values: new Float32Array(0), hopMs };
    }
    const hop = Math.max(1, Math.round(sr * hopMs / 1000));
    const n = samples.length;
    const frames = Math.max(0, Math.floor(n / hop));
    if (frames <= 0) return { values: new Float32Array(0), hopMs };

    /* 分帧能量（对预加重后的一阶差分求均方）——一阶差分是廉价的高通，
       突出声母/辅音的攻击，正是我们要定位的位置 */
    const energy = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        const from = f * hop;
        const to = Math.min(n, from + hop);
        let acc = 0, prev = from > 0 ? samples[from - 1] : 0;
        for (let i = from; i < to; i++) {
            const d = samples[i] - prev;
            prev = samples[i];
            acc += d * d;
        }
        energy[f] = acc / Math.max(1, to - from);
    }

    /* 正向差分：只保留能量上升沿 */
    const flux = new Float32Array(frames);
    for (let f = 1; f < frames; f++) {
        const d = energy[f] - energy[f - 1];
        flux[f] = d > 0 ? d : 0;
    }
    /* ±1 帧平滑，压掉单帧毛刺 */
    const sm = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        sm[f] = (flux[Math.max(0, f - 1)] + flux[f] + flux[Math.min(frames - 1, f + 1)]) / 3;
    }
    /* 局部均值归一 + 半波整流：让弱响度段落同样有可比的峰 */
    const LOCAL = Math.max(4, Math.round(750 / hopMs));
    const values = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
        let mean = 0;
        const a = Math.max(0, f - LOCAL), b = Math.min(frames - 1, f + LOCAL);
        for (let i = a; i <= b; i++) mean += sm[i];
        mean /= (b - a + 1);
        values[f] = sm[f] - mean > 0 ? sm[f] - mean : 0;
    }
    /* 归一到 0..1；全静音时保持全 0（下游据此退化成均分） */
    let max = 0;
    for (let f = 0; f < frames; f++) if (values[f] > max) max = values[f];
    if (max > 1e-12) for (let f = 0; f < frames; f++) values[f] /= max;
    else values.fill(0);

    return { values, hopMs };
}

/** 按权重把窗口均分（无信号可依据时的退化路径，等价于旧的摊平行为） */
function evenSplit(tokens, lineStartMs, lineEndMs) {
    const total = tokens.reduce((s, t) => s + (t.weight || 1), 0);
    const dur = lineEndMs - lineStartMs;
    if (!tokens.length || total <= 0 || dur <= 0) return [];
    const out = [];
    let acc = 0;
    for (const t of tokens) {
        const s = Math.round(lineStartMs + dur * (acc / total));
        acc += (t.weight || 1);
        const e = Math.round(lineStartMs + dur * (acc / total));
        out.push({ text: t.text, start: s, end: Math.max(e, s + 1) });
    }
    return out;
}

/**
 * 对齐结果相对「均分」的最大起点偏移（ms）。
 * 用来判断音频到底有没有给出信息：偏差≈0 说明 DP 没被 onset 拉动（静音/平稳段），
 * 这时结果不该冒充真实逐字——调用方应把它标回 synthesized。
 * @param {Array<{text:string,start:number}>} words alignLine 的输出
 * @param {Array<{text:string,weight:number}>} tokens 同一批 tokens
 * @param {number} lineStartMs @param {number} lineEndMs
 * @returns {number}
 */
export function maxDeviationFromEvenSplit(words, tokens, lineStartMs, lineEndMs) {
    if (!Array.isArray(words) || !Array.isArray(tokens) || !words.length || words.length !== tokens.length) return 0;
    const even = evenSplit(tokens, lineStartMs, lineEndMs);
    let max = 0;
    for (let i = 0; i < words.length; i++) {
        const d = Math.abs((words[i].start || 0) - (even[i] ? even[i].start : 0));
        if (d > max) max = d;
    }
    return max;
}

/**
 * 把一行歌词对齐到 onset 包络上。
 * @param {Object} p
 * @param {Array<{text:string,weight:number}>} p.tokens 建议直接给 tokenizeForKaraoke 的结果
 * @param {{values:Float32Array,hopMs:number}} p.envelope buildOnsetEnvelope 的输出
 * @param {number} p.lineStartMs 行起点（绝对 ms，也是首字的起点）
 * @param {number} p.lineEndMs   行终点（下一行起点或总时长，绝对 ms）
 * @returns {Array<{text:string,start:number,end:number}>} 绝对 ms；形状与真实逐字一致，
 *          因此调用方**不要**给它打 wordTiming='synthesized' 标记
 */
export function alignLine({ tokens, envelope, lineStartMs, lineEndMs }) {
    if (!Array.isArray(tokens) || !tokens.length) return [];
    if (!envelope || !envelope.values || !envelope.values.length) return [];
    const start = Number(lineStartMs), end = Number(lineEndMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

    const hopMs = Number(envelope.hopMs) > 0 ? envelope.hopMs : HOP_MS_DEFAULT;
    const N = tokens.length;
    const f0 = Math.round(start / hopMs);
    const f1 = Math.round(end / hopMs);
    const M = f1 - f0;
    /* 帧数不够分给每个字就没有对齐余地，直接退化 */
    if (M < N * 2) return evenSplit(tokens, start, end);

    const env = envelope.values;
    const at = (f) => (f >= 0 && f < env.length ? env[f] : 0);
    /* 全局帧 f 处的 onset 强度（f 是绝对帧号，可能落在 envelope 之外） */
    const onsetAt = (f) => at(f0 + f);

    const totalW = tokens.reduce((s, t) => s + (t.weight || 1), 0);
    const expect = tokens.map(t => (t.weight || 1) / totalW * M);

    /* DP：dp[i][f] = 前 i+1 个字、第 i 个字结束于相对帧 f 的最小代价 */
    const INF = Number.POSITIVE_INFINITY;
    let prev = new Float64Array(M + 1).fill(INF);
    let cur = new Float64Array(M + 1);
    const back = [];   // back[i][f] = 第 i 个字的起始帧

    const segCost = (i, p, f) => {
        const len = f - p;
        const e = Math.max(1, expect[i]);
        const dev = (len - e) * (len - e) / e;
        const reward = i === 0 ? 0 : onsetAt(p) * BETA_ONSET;
        return LAMBDA_DURATION * dev - reward;
    };

    for (let f = 1; f <= M; f++) prev[f] = segCost(0, 0, f);

    for (let i = 1; i < N; i++) {
        const row = new Int32Array(M + 1).fill(-1);
        cur.fill(INF);
        /* 累计期望位置，把搜索窗限制在它附近，避免 O(M^2) 全扫 */
        let cumExpect = 0;
        for (let k = 0; k <= i; k++) cumExpect += expect[k];
        const center = Math.round(cumExpect);
        const span = Math.ceil(expect[i] * MAX_STRETCH) + 4;
        const loF = Math.max(i, center - span), hiF = Math.min(M - (N - 1 - i), center + span);
        for (let f = loF; f <= hiF; f++) {
            const maxP = f - 1;
            const minP = Math.max(i - 1, f - 1 - Math.ceil(expect[i] * MAX_STRETCH) - 2);
            for (let p = minP; p <= maxP; p++) {
                if (!Number.isFinite(prev[p])) continue;
                const c = prev[p] + segCost(i, p, f);
                if (c < cur[f]) { cur[f] = c; row[f] = p; }
            }
        }
        back.push(row);
        const t = prev; prev = cur; cur = t;
    }

    /* 回溯：末字必须收到行尾，所以从 M 往回找 */
    let last = M;
    if (!Number.isFinite(prev[last])) {
        /* 搜索窗太窄导致不可达：放宽到任意可达终点 */
        let best = INF;
        for (let f = M; f >= N; f--) if (Number.isFinite(prev[f]) && prev[f] < best) { best = prev[f]; last = f; }
        if (best === INF) return evenSplit(tokens, start, end);
    }
    const bounds = new Int32Array(N + 1);
    bounds[N] = last;
    bounds[0] = 0;
    let f = last;
    for (let i = N - 1; i >= 1; i--) {
        const p = back[i - 1][f];
        if (p < 0) return evenSplit(tokens, start, end);   // 路径断裂，退化
        bounds[i] = p;
        f = p;
    }

    const out = [];
    for (let i = 0; i < N; i++) {
        const s = Math.round(start + (end - start) * (bounds[i] / M));
        const e = i === N - 1 ? Math.round(end) : Math.round(start + (end - start) * (bounds[i + 1] / M));
        out.push({ text: tokens[i].text, start: i === 0 ? start : s, end: Math.max(e, (i === 0 ? start : s) + 1) });
    }
    /* 单调性收口：DP 已保证，但四舍五入可能造出 1ms 级重叠，渲染层会算出负进度 */
    for (let i = 1; i < out.length; i++) {
        if (out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
        if (out[i].end <= out[i].start) out[i].end = out[i].start + 1;
    }
    out[out.length - 1].end = Math.round(end);
    return out;
}
