/* ============================================================
 * core/autoeqImport.js — AutoEQ PEQ 文本 → 10 段均衡器增益（需求 3）
 *
 * 用途：用户在 AutoEQ 项目（github.com/jaakkopasanen/AutoEq）拿到耳机的参数化
 * 均衡（PEQ）文本，粘贴进来 → 加载到本播放器固定的 10 段 EQ 上。
 *
 * ★ 为什么"不自己写算法"：
 *   需求原文要求「别自己写算法」。这里做的不是发明 EQ，而是**用行业标准公式**
 *   把 PEQ 参数还原成频率响应，再在 10 个固定频点上采样：
 *     ① 系数 = RBJ Audio EQ Cookbook（Robert Bristow-Johnson）双二阶，Web Audio
 *        BiquadFilterNode 内部用的就是同一套（所以还原出来的曲线与播放器实际
 *        渲染的曲线一致，不是另一套近似）；
 *     ② 响应 = 标准传递函数在单位圆上的模 |H(e^{jω})|，取 20log10 转 dB。
 *   有损之处是**频点离散化**：AutoEQ 的 PEQ 频点任意（如 105Hz / 220Hz），
 *   而本播放器是 10 段固定频点（31.25→16k），只能在各段中心采样。这是需求
 *   「加载到 10 段均衡器上」的必然结果，不是 bug。
 *
 * ★ 采样率假设：响应按 48kHz 计算。EQ 实际跑在播放采样率上，但 <10kHz 区间
 *   两者差异 <0.1dB（双二阶的频响对 fs 只在接近 Nyquist 处才敏感），可忽略。
 * ============================================================ */

/** AutoEQ 文本里出现的滤波器类型 → 内部规范名 */
const TYPE_MAP = {
    PK: 'peaking',
    PEAKING: 'peaking',
    LSC: 'lowshelf', LS: 'lowshelf', 'LOW SHELF': 'lowshelf', LOWSHELF: 'lowshelf',
    HSC: 'highshelf', HS: 'highshelf', 'HIGH SHELF': 'highshelf', HIGHSHELF: 'highshelf',
};

/** 参考采样率（见文件头 ★ 采样率假设） */
export const AUTO_EQ_FS = 48000;
/** 段增益上下限，与 EQ 滑块一致 */
export const AUTO_EQ_GAIN_LIMIT = 12;

/* AutoEQ 标准行：`Filter 1: ON PK Fc 105 Hz Gain 6.1 dB Q 0.70`
   —— ON/OFF、Fc/Gain/Q 顺序固定，但容忍多空格与小数。
   ★ Gain 与 Q 都设为**可选**：LP/HP/BP 这类无增益滤波器也要被捕获到，
   才能计入 skipped 如实告诉用户「有 N 条无法表示」，而不是静默丢掉。 */
const RE_FILTER = /Filter\s*\d+\s*:\s*(ON|OFF)\s+([A-Za-z ]+?)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/gi;
/* Peace / 旧版括号式：`Peaking: 105 Hz, 6.1 dB, Q 0.70` */
const RE_FILTER_ALT = /(Peaking|Low Shelf|High Shelf)\s*:\s*([\d.]+)\s*Hz\s*,\s*(-?[\d.]+)\s*dB(?:\s*,\s*Q\s*([\d.]+))?/gi;
const RE_PREAMP = /Preamp\s*:\s*(-?[\d.]+)\s*dB/i;

/**
 * 解析 AutoEQ PEQ 文本。
 * @param {string} text
 * @returns {{preampDb:number|null, filters:Array<{type:string,fc:number,gainDb:number,q:number}>, skipped:number}}
 *   skipped = 解析到但类型不支持（LP/HP/BP 等无增益项）而被丢弃的条数
 */
export function parseAutoEqPeq(text) {
    const out = { preampDb: null, filters: [], skipped: 0 };
    if (!text || typeof text !== 'string') return out;

    const pm = RE_PREAMP.exec(text);
    if (pm) out.preampDb = parseFloat(pm[1]);

    const pushFilter = (rawType, fc, gainDb, q) => {
        const type = TYPE_MAP[String(rawType).trim().toUpperCase()];
        if (!type) { out.skipped++; return; }
        if (!isFinite(fc) || fc <= 0 || !isFinite(gainDb)) { out.skipped++; return; }
        out.filters.push({
            type,
            fc,
            gainDb,
            q: (isFinite(q) && q > 0) ? q : 0.707,
        });
    };

    RE_FILTER.lastIndex = 0;
    let m;
    while ((m = RE_FILTER.exec(text)) !== null) {
        if (m[1].toUpperCase() !== 'ON') { continue; }   /* OFF 的滤波器直接不采 */
        pushFilter(m[2], parseFloat(m[3]), parseFloat(m[4]), m[5] ? parseFloat(m[5]) : NaN);
    }

    RE_FILTER_ALT.lastIndex = 0;
    while ((m = RE_FILTER_ALT.exec(text)) !== null) {
        pushFilter(m[1], parseFloat(m[2]), parseFloat(m[3]), m[4] ? parseFloat(m[4]) : NaN);
    }

    return out;
}

/**
 * RBJ Audio EQ Cookbook 双二阶系数（与 Web Audio BiquadFilterNode 同源）。
 * @returns {{b0:number,b1:number,b2:number,a0:number,a1:number,a2:number}}
 */
function _biquad(type, fc, gainDb, q, fs) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * Math.min(fc, fs * 0.49) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    if (type === 'peaking') {
        const alpha = sw / (2 * q);
        return {
            b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A,
            a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A,
        };
    }
    /* shelf：Q 固定取 S=1 对应的 alpha（cookbook：alpha = sin/2·√((A+1/A)(1/S−1)+2)，
       S=1 时退化为 sin/2·√2）；shelf 的 Q 参数在 AutoEQ 里常缺省，取 0.707 等价。 */
    const alpha = sw / 2 * Math.SQRT2;
    const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
        return {
            b0: A * ((A + 1) - (A - 1) * cw + twoSqrtAalpha),
            b1: 2 * A * ((A - 1) - (A + 1) * cw),
            b2: A * ((A + 1) - (A - 1) * cw - twoSqrtAalpha),
            a0: (A + 1) + (A - 1) * cw + twoSqrtAalpha,
            a1: -2 * ((A - 1) + (A + 1) * cw),
            a2: (A + 1) + (A - 1) * cw - twoSqrtAalpha,
        };
    }
    /* highshelf */
    return {
        b0: A * ((A + 1) + (A - 1) * cw + twoSqrtAalpha),
        b1: -2 * A * ((A - 1) + (A + 1) * cw),
        b2: A * ((A + 1) + (A - 1) * cw - twoSqrtAalpha),
        a0: (A + 1) - (A - 1) * cw + twoSqrtAalpha,
        a1: 2 * ((A - 1) - (A + 1) * cw),
        a2: (A + 1) - (A - 1) * cw - twoSqrtAalpha,
    };
}

/** 单个滤波器在频点 f 的幅频响应（dB） */
function _responseDb(filt, f, fs) {
    const { b0, b1, b2, a0, a1, a2 } = _biquad(filt.type, filt.fc, filt.gainDb, filt.q, fs);
    const w = 2 * Math.PI * f / fs;
    const cw = Math.cos(w), sw = Math.sin(w), c2w = Math.cos(2 * w), s2w = Math.sin(2 * w);
    /* H(z) = (b0 + b1 z⁻¹ + b2 z⁻²)/(a0 + a1 z⁻¹ + a2 z⁻²)，z = e^{jw} */
    const nRe = b0 + b1 * cw + b2 * c2w;
    const nIm = -(b1 * sw + b2 * s2w);
    const dRe = a0 + a1 * cw + a2 * c2w;
    const dIm = -(a1 * sw + a2 * s2w);
    const mag2 = (nRe * nRe + nIm * nIm) / Math.max(1e-20, dRe * dRe + dIm * dIm);
    return 10 * Math.log10(Math.max(1e-20, mag2));
}

/**
 * 把解析结果在给定频点上采样，得到各段增益（整数，clamp ±12）。
 * @param {{filters:Array}} parsed
 * @param {number[]} bands  固定频点数组（Hz）
 * @returns {number[]}
 */
export function peqToBandGains(parsed, bands) {
    const filters = (parsed && parsed.filters) || [];
    return bands.map((f) => {
        let total = 0;
        for (const filt of filters) total += _responseDb(filt, f, AUTO_EQ_FS);
        /* 四舍五入到整数（EQ 滑块 step=1，且避免浮点尾巴） */
        const v = Math.round(total);
        return Math.max(-AUTO_EQ_GAIN_LIMIT, Math.min(AUTO_EQ_GAIN_LIMIT, v));
    });
}

/**
 * 一步到位：文本 → 段增益 + 报告。
 * @param {string} text
 * @param {number[]} bands
 * @returns {{ok:boolean, gains?:number[], report?:object, error?:string}}
 */
export function compileAutoEq(text, bands) {
    if (!text || !String(text).trim()) return { ok: false, error: 'empty' };
    if (!Array.isArray(bands) || bands.length === 0) return { ok: false, error: 'no-bands' };
    const parsed = parseAutoEqPeq(text);
    if (parsed.filters.length === 0) return { ok: false, error: 'no-filter' };
    return {
        ok: true,
        gains: peqToBandGains(parsed, bands),
        report: {
            count: parsed.filters.length,
            skipped: parsed.skipped,
            preampDb: parsed.preampDb,
        },
    };
}
