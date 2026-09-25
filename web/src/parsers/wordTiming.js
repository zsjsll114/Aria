/** parsers/wordTiming.js — 行级歌词 → 逐字时间补全（纯函数，零依赖，可 Node 单测）
 *
 * 为什么需要它：`renderLyrics` 只在 `line.words` 存在时才生成 `.word` /
 * `.word-highlight` 元素（见 app/20-lyrics-render.js 的 buildWordsInto 分支），
 * 没有 words 的行一律按纯文本渲染 —— 这正是「NPS 接管播歌看不到逐字歌词」的
 * 结构性原因：外部播放器给的多是行级 LRC，行内没有时间点。
 *
 * 本模块提供两种能力：
 *   - ensureWordTiming(lines)：已有真实逐字（words 带 start/end）就原样保留，
 *     否则按行区间均分「合成」逐字时间。
 *   - synthesizeWords(lines)：直接做合成。
 *
 * 合成的性质（必须诚实对待）：它是**按行时长摊平的近似节拍**，不是真实演唱时间。
 * 句子内的停顿、拖腔都会与实际不符；但只要行级时间准确，逐字高亮的推进节奏
 * 整体是跟得上的 —— 这是没有逐字数据时唯一可行的做法。
 */

/* CJK / 假名 / 谚文：逐字切分的最小单位 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
/* 相邻两行间隔过大时（长间奏）不把整段间隔摊到这一行上，否则一个字要亮好几秒 */
const DEFAULT_MAX_LINE_MS = 10000;
/* 无下一行、无总时长时的兜底行长 */
const FALLBACK_LINE_MS = 4000;

/* 打在合成行上的标记。必须可区分：下游有代码拿 `line.words.length` 判**真值**——
   下载歌词、"逐字歌词"标签、歌词源质量打分。合成的是按行时长摊平的近似节拍，
   被当成平台精确逐字的话，下载出去的 .lrc 会带一串假时间戳。 */
export const SYNTHESIZED = 'synthesized';

/** 这一行的 words 是不是合成出来的 */
export function isSyntheticWordLine(line) {
    return !!(line && line.wordTiming === SYNTHESIZED);
}

/**
 * 取一行**真实**的逐字数据；合成的或脏数据一律返回 null。
 * 给「拿 line.words 判真值」的一侧用：下载歌词、"逐字歌词"标签、歌词源质量打分。
 * 渲染侧不要用这个——它要的就是有就用（合成的也比整行一跳好）。
 * @param {Object} line
 * @returns {Array<{text:string,start:number,end:number}>|null}
 */
export function realWordsOf(line) {
    return lineHasRealWords(line) ? line.words : null;
}

/**
 * 把合成出来的 words 摘掉（真实逐字原样保留）。
 * 导出/下载歌词前必须过这一道，否则假时间戳会写进用户的文件。
 * @param {Array<Object>} lines
 * @returns {Array<Object>} 新数组，不改入参
 */
export function stripSyntheticWords(lines) {
    if (!Array.isArray(lines)) return lines;
    return lines.map(l => (isSyntheticWordLine(l)
        ? Object.assign({}, l, { words: [], wordTiming: undefined })
        : l));
}

/**
 * 把一行文本切成「可逐字高亮的词元」：
 * - CJK 每字一个词元（真正的逐字推进）；
 * - 拉丁/数字等非 CJK 连写为一个词元（保持单词完整，渲染层会在词内再按字符细分）；
 * - 空白并入前一个词元尾部，保留词间距（渲染层已有 leading/trailing 空白占位逻辑）。
 * weight = 该词元占用的「演唱长度」权重（可见字符数，拉丁词上限 6），用于分配时长。
 * @param {string} text
 * @returns {Array<{text: string, weight: number}>}
 */
export function tokenizeForKaraoke(text) {
    const out = [];
    const s = String(text == null ? '' : text);
    const n = s.length;
    let i = 0;
    while (i < n) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (out.length) out[out.length - 1].text += ch;
            else out.push({ text: ch, weight: 0 });   /* 行首空白：独立占位词元 */
            i++;
            continue;
        }
        if (CJK_RE.test(ch)) {
            out.push({ text: ch, weight: 1 });
            i++;
            continue;
        }
        let j = i;
        while (j < n && !/\s/.test(s[j]) && !CJK_RE.test(s[j])) j++;
        const seg = s.slice(i, j);
        out.push({ text: seg, weight: Math.max(1, Math.min(seg.length, 6)) });
        i = j;
    }
    return out;
}

/** 取一行的起止（ms）：优先行自带 end，否则用下一行 start / 总时长 / 兜底 */
function resolveLineRange(lines, i, totalMs, maxLineMs) {
    const line = lines[i];
    const start = Number(line.start) || 0;
    let end = Number(line.end);
    if (!Number.isFinite(end) || end <= start) {
        const next = lines[i + 1];
        if (next && Number.isFinite(Number(next.start)) && Number(next.start) > start) {
            end = Number(next.start);
        } else if (totalMs > start) {
            end = totalMs;
        } else {
            end = start + FALLBACK_LINE_MS;
        }
    }
    /* 长间奏截断：本行最多占用 maxLineMs，剩余间隔留给「无高亮」状态 */
    if (end - start > maxLineMs) end = start + maxLineMs;
    return { start, end };
}

/**
 * 按行区间均分合成逐字时间。
 * @param {Array<Object>} lines [{ start, text|original, end?, words? }]
 * @param {{totalMs?: number, maxLineMs?: number}} [opts]
 * @returns {Array<Object>} 新数组，每行带 words: [{text, start, end}]
 */
export function synthesizeWords(lines, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) return lines || [];
    const totalMs = Number(opts.totalMs) || 0;
    const maxLineMs = Number(opts.maxLineMs) || DEFAULT_MAX_LINE_MS;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) { out.push(line); continue; }
        const text = String(line.text != null ? line.text : (line.original != null ? line.original : ''));
        const { start, end } = resolveLineRange(lines, i, totalMs, maxLineMs);
        const tokens = tokenizeForKaraoke(text);
        const totalWeight = tokens.reduce((sum, t) => sum + t.weight, 0);
        if (!tokens.length || totalWeight <= 0) {
            out.push(Object.assign({}, line, { words: [], wordTiming: undefined }));
            continue;
        }
        const dur = end - start;
        const words = [];
        let acc = 0;
        for (const t of tokens) {
            const wStart = Math.round(start + dur * (acc / totalWeight));
            acc += t.weight;
            const wEnd = Math.round(start + dur * (acc / totalWeight));
            /* 每个词元至少 1ms，避免零长区间被渲染层的除法算出 NaN/Infinity */
            words.push({ text: t.text, start: wStart, end: Math.max(wEnd, wStart + 1) });
        }
        out.push(Object.assign({}, line, { words, wordTiming: SYNTHESIZED }));
    }
    return out;
}

/** 这一行自己带不带可信的真实逐字时间（合成出来的不算） */
function lineHasRealWords(line) {
    return !!(line && !isSyntheticWordLine(line) && Array.isArray(line.words) && line.words.length > 0
        && typeof line.words[0].start === 'number' && typeof line.words[0].end === 'number'
        && line.words[0].end > line.words[0].start);
}

/**
 * 判断一组行是否已带可信的真实逐字时间。
 * 合成出来的 words 不算——否则「合成过一次」就会被当成「平台给了精确逐字」，
 * 既让二次合成失效，也让真值判定（下载/标签/选源）被骗。
 */
export function hasRealWordTiming(lines) {
    if (!Array.isArray(lines)) return false;
    return lines.some(lineHasRealWords);
}

/**
 * 主入口：保证每行都有逐字时间。
 * 已带真实逐字 → 原样保留（不覆盖第三方给的精确节拍）；否则按行区间均分合成。
 *
 * 混合形状逐行处理而非整组放行：KRC/YRC 里常有「多数行带标记、个别行没带」，
 * 整组放行会让没带的那几行仍然整行一跳。全组都真实时返回原数组引用
 * ——调用方（232 的 withWordTiming、单测）靠引用相等判「没动过」。
 * @param {Array<Object>} lines
 * @param {{totalMs?: number, maxLineMs?: number}} [opts] totalMs 用于末行的结束时间
 * @returns {Array<Object>}
 */
export function ensureWordTiming(lines, opts = {}) {
    if (!Array.isArray(lines) || lines.length < 2) return lines;
    if (!hasRealWordTiming(lines)) return synthesizeWords(lines, opts);
    if (lines.every(lineHasRealWords)) return lines;
    /* 合成整组只为拿到逐行的位次区间，带真实节拍的行原样留着 */
    const fallback = synthesizeWords(lines, opts);
    return lines.map((line, i) => (lineHasRealWords(line) ? line : fallback[i]));
}
