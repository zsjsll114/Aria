/* ============================================================
 * lyricRows.js — 视觉模式的歌词排版与字素时间线纯逻辑（棱镜等全屏模式共用）
 *
 * 四件事，全部无 DOM：
 *   ① 歌词行归一化 & 字素时间线拆解（normalizeLine / buildGraphemes）；
 *   ② 长句分行：按字素权重均衡切成 1~4 行，拉丁词不拆断，
 *      断点优先落在空格/标点附近（这样长句不再被省略号截掉）；
 *   ③ 多行整体缩放：每行都放得下时取最大可用字号，下限 0.42；
 *   ④ 情感词着色：AI 词色按 JS 字符串偏移映射到字素，
 *      暗背景上自动提亮（保色相），避免深蓝/深紫在暗景里隐身。
 *
 * 行宽与字重都是近似值，只用于"切在哪"，真正的缩放仍以测量结果为准。
 * ============================================================ */

import { buildWordColorRanges } from './wordColoring.js';
import { hexToRgb, hslToRgb, rgbToHsl } from '../../utils/colorUtils.js';
import { buildLineGraphemeTimeline, splitLyricGraphemes } from '../../utils/lyrics/graphemeTiming.js';

/** @param {number} v @returns {number} */
export function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/** @param {any} line @param {any} [nextLine] @returns {{ text: string, start: number, end: number, words: Array<{text:string,startTime:number,endTime:number}> }} */
export function normalizeLine(line, nextLine) {
    const text = String((line && (line.fullText || line.original || line.text)) || '');
    const start = Number(line && (line.startTime ?? line.start ?? line.time)) || 0;
    let end = Number(line && (line.endTime ?? line.end)) || 0;
    if (!(end > start)) {
        const nextStart = Number(nextLine && (nextLine.startTime ?? nextLine.start ?? nextLine.time)) || 0;
        end = nextStart > start ? Math.max(start + 1, nextStart - 80) : start + Math.max(2600, text.length * 210);
    }
    const raw = Array.isArray(line && line.words) ? line.words : [];
    const words = [];
    for (const w of raw) {
        const t = String((w && w.text) || '');
        if (!t) continue;
        const ws = Number(w.startTime ?? w.start) || start;
        const we = Number(w.endTime ?? w.end) || ws + 1;
        words.push({ text: t, startTime: ws, endTime: we });
    }
    return { text, start, end, words };
}

/** @param {any} line @param {any} [nextLine] @returns {Array<{char:string,start:number,end:number}>} */
export function buildGraphemes(line, nextLine) {
    const n = normalizeLine(line, nextLine);
    if (!n.text) return [];
    const raw = buildLineGraphemeTimeline({
        fullText: n.text,
        startTime: n.start,
        endTime: n.end,
        words: n.words,
    });
    const out = [];
    for (const g of raw) {
        out.push({ char: String(g.char || ''), start: Number(g.startTime) || n.start, end: Number(g.endTime) || n.end });
    }
    if (out.length) return out;
    const chars = splitLyricGraphemes(n.text);
    const dur = Math.max(n.end - n.start, 0) / Math.max(chars.length, 1);
    return chars.map((char, i) => ({ char, start: n.start + dur * i, end: i === chars.length - 1 ? n.end : n.start + dur * (i + 1) }));
}

/**
 * @typedef {{ char: string, start: number, end: number }} FlowGrapheme
 * @typedef {{ start: number, end: number }} FlowRowRange
 */

const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\u3040-\u30ff\uf900-\ufaff]/;
const BREAK_RE = /[\s，。！？、；：,.!?;:—…·"'“”‘’）)\]】》〉]/;
const LATIN_RE = /[A-Za-z0-9]/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * 字素在视觉上的相对宽度（以全角汉字为 1）。
 * @param {string} char
 * @returns {number}
 */
export function graphemeWeight(char) {
    const s = String(char || '');
    if (!s) return 0.3;
    if (/^\s+$/.test(s)) return 0.34;
    if (CJK_RE.test(s)) return 1;
    if (EMOJI_RE.test(s)) return 1.05;
    if (BREAK_RE.test(s)) return 0.38;
    if (LATIN_RE.test(s)) return /[A-Z0-9]/.test(s) ? 0.62 : 0.55;
    return 0.55;
}

/** @param {string} char @returns {boolean} */
function isLatinLetter(char) {
    return LATIN_RE.test(String(char || ''));
}

/**
 * 行数只按总字重决定：短句一行，20~44 两行，44~78 三行，再长四行。
 * 不按 CSS 自动换行 —— 每行必须有独立的擦除蒙版，自动换行会把一行拆成两条擦除线。
 * @param {number} totalWeight
 * @returns {number}
 */
export function rowCountFor(totalWeight) {
    if (!(totalWeight > 0)) return 1;
    if (totalWeight <= 20) return 1;
    if (totalWeight <= 44) return 2;
    if (totalWeight <= 78) return 3;
    return 4;
}

/**
 * 把一行字素均衡切成多行。
 * @param {FlowGrapheme[]} graphemes
 * @param {number} [maxRows]
 * @returns {FlowRowRange[]}
 */
export function splitIntoRows(graphemes, maxRows = 4) {
    const list = Array.isArray(graphemes) ? graphemes : [];
    const n = list.length;
    if (n === 0) return [];

    const weights = list.map(g => graphemeWeight(g && g.char ? g.char : ''));
    const prefix = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + weights[i];
    const total = prefix[n];

    const rows = Math.max(1, Math.min(Math.max(1, maxRows), rowCountFor(total)));
    if (rows === 1) return [{ start: 0, end: n }];

    const ranges = [];
    let from = 0;
    for (let r = 1; r < rows; r++) {
        const target = total * r / rows;
        /* 还要给后续行至少留 1 个字素 */
        const last = n - (rows - r);
        let best = from + 1;
        let bestScore = Infinity;
        for (let k = from + 1; k <= last; k++) {
            let score = Math.abs(prefix[k] - target);
            if (k > 0 && k < n && isLatinLetter(list[k - 1].char) && isLatinLetter(list[k].char)) {
                score += 1000; /* 拉丁词内部不拆 */
            } else if (k > 0 && k < n && (BREAK_RE.test(list[k - 1].char) || BREAK_RE.test(list[k].char))) {
                score -= 0.9; /* 断在空格/标点后更自然 */
            }
            if (score < bestScore) {
                bestScore = score;
                best = k;
            }
        }
        ranges.push({ start: from, end: best });
        from = best;
    }
    ranges.push({ start: from, end: n });
    return ranges;
}

/**
 * 多行共用同一个缩放：取最宽的一行来算，保证每行都放得下。
 * @param {number[]} rowWidths
 * @param {number} boxWidth
 * @param {number} [min] 下限：再小就不如多分一行
 * @returns {number}
 */
export function rowFitScale(rowWidths, boxWidth, min = 0.42) {
    const list = Array.isArray(rowWidths) ? rowWidths : [];
    let maxWidth = 0;
    for (const w of list) {
        const v = Number(w);
        if (Number.isFinite(v) && v > maxWidth) maxWidth = v;
    }
    if (!(maxWidth > 0) || !(boxWidth > 0)) return 1;
    const raw = boxWidth / maxWidth;
    return Math.max(min, Math.min(1, raw));
}

/**
 * 暗底上的情感词色：L 低于 minLightness 时按 HSL 提亮，色相与饱和度保留。
 * 只认 #rrggbb（AI 输出格式）；其它写法原样返回。
 * @param {string} color
 * @param {number} [minLightness]
 * @returns {string}
 */
export function ensureReadableOnDark(color, minLightness = 0.68) {
    const s = String(color || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    const rgb = hexToRgb(s);
    if (!rgb) return s;
    const [h, sat, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (l >= minLightness) return s;
    const [r, g, b] = hslToRgb(h, Math.min(sat, 0.92), minLightness);
    return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/**
 * 逐字素解析情感词颜色。返回与 graphemes 等长的数组，未命中的位置是 null。
 * 匹配口径与主界面一致：走 wordColoring 的 buildWordColorRanges（中文短语、英文词边界）。
 * @param {FlowGrapheme[]} graphemes
 * @param {Array<{ word?: string, color?: string }>|null|undefined} wordColors
 * @returns {Array<string|null>}
 */
export function emotionColorsForGraphemes(graphemes, wordColors) {
    const list = Array.isArray(graphemes) ? graphemes : [];
    /** @type {Array<string|null>} */
    const out = new Array(list.length).fill(null);
    if (list.length === 0 || !Array.isArray(wordColors) || wordColors.length === 0) return out;

    const text = list.map(g => (g && g.char) || '').join('');
    const ranges = buildWordColorRanges(text, wordColors, true);
    if (ranges.length === 0) return out;

    let offset = 0;
    let rangeIndex = 0;
    for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (!g) continue;
        const charLen = String(g.char || '').length;
        const start = offset;
        const end = offset + charLen;
        while (rangeIndex < ranges.length && ranges[rangeIndex].endOffset <= start) rangeIndex += 1;
        const range = ranges[rangeIndex];
        if (range && range.startOffset < end && range.endOffset > start) {
            out[i] = ensureReadableOnDark(range.color);
        }
        offset = end;
    }
    return out;
}
