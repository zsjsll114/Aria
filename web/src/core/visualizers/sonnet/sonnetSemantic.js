/**
 * sonnetSemantic.js — folia sonnet 语义分段（sonnetSemantic.ts 的 Aria 适配移植）
 *
 * 上游把行文本切成「词组 segments」并映射逐字时间。Aria 的 line.words 已带
 * {text,start,end} 逐字数据（yrc/krc 解析产物），语义切分直接消费 words：
 *  - wordLike = 含字母/CJK/谚文的词（纯标点/符号不算）
 *  - 非词非空白的 segment（标点）粘连到前一个词（上游 sticky 规则）
 *  - 每词内部 graphemes 均分词时长（上游 graphemeTiming 的均分兜底一致；
 *    真实逐字精度由 words 的 start/end 承载，不再二次细摊）
 */

const WORD_LIKE_RE = /[\p{L}\p{M}\p{N}\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

/** 词内逐字均分（folia graphemeTiming 均分兜底的等价物） */
function spreadGraphemes(text, startTime, endTime) {
    const chars = Array.from(text);
    const span = Math.max(0, endTime - startTime);
    return chars.map((char, index) => ({
        char,
        startTime: startTime + span * index / Math.max(1, chars.length),
        endTime: startTime + span * (index + 1) / Math.max(1, chars.length),
    }));
}

/**
 * @param {Object} line Aria 歌词行 {start, original, words:[{text,start,end}]}
 * @returns {Array<SonnetSemanticSegment>}
 */
export function buildSonnetSemanticSegments(line) {
    const words = Array.isArray(line.words) && line.words.length > 0 ? line.words : null;
    const fullText = (line.original || line.text || '')
        || (words ? words.map(w => w.text || '').join('') : '');
        /* ★ 2026-09-30 优先 original：此前用 words 无空格拼接当 fullText——英文行
           「Power by love」变成「Powerbylove」，isSpace 分支永不触发、Segmenter
           边界也全错（英文空格消失/词粘连的根因）。 */
    if (!fullText) return [];
    const lineStart = typeof line.start === 'number' ? line.start : 0;
    const lineEnd = words && words.length
        ? Math.max(...words.map(w => w.end || w.start || lineStart))
        : lineStart + 4;

    // 粗分段：words 路径做「词块聚合」（2026-09-30）；无 words 时按 Intl.Segmenter 词级切
    const raw = [];
    if (words && /\s/.test(fullText)) {
        /* ★ 2026-09-30 空格语言（英/韩等）：按行文本的空白/非空白 run 分段，
           词时间轴按字符占比插值摊到 run 上——空白段保留（上游 wordSegmentation
           同策略：空白自成 segment，布局据此留缝）。此前 Segmenter 边界按字符数
           消费 words 在空白处错位 → 词粘连/空格消失。 */
        const base = fullText;
        const runs = base.match(/\s+|[^\s]+/g) || [];
        const wordTexts = words.map(w => (w.text || '').replace(/\s+/g, ''));
        const lineEnd = Math.max(...words.map(w => w.end || w.start || lineStart), lineStart + 0.3);
        const lineSpan = Math.max(0.3, lineEnd - lineStart);
        const totalChars = Math.max(1, base.length);
        let wi = 0;
        let charCursor = 0;
        runs.forEach(run => {
            const t0 = lineStart + lineSpan * (charCursor / totalChars);
            charCursor += run.length;
            const t1 = lineStart + lineSpan * (charCursor / totalChars);
            if (/^\s+$/.test(run)) {
                raw.push({ text: ' ', startTime: t0, endTime: t1, isWordLike: false });
                return;
            }
            const target = run.replace(/\s+/g, '');
            const blockWords = [];
            let acc = '';
            while (wi < wordTexts.length && acc.length < target.length) {
                blockWords.push(words[wi]);
                acc += wordTexts[wi];
                wi += 1;
            }
            const firstW = blockWords[0];
            const lastW = blockWords[blockWords.length - 1];
            const start = firstW && typeof firstW.start === 'number' ? firstW.start : t0;
            const end = lastW && typeof lastW.end === 'number' && lastW.end > start ? lastW.end : t1;
            raw.push({ text: run, startTime: start, endTime: end });
        });
        if (wi < words.length && raw.length > 0) {
            const rest = words.slice(wi);
            const tail = raw[raw.length - 1];
            tail.text += rest.map(w => w.text || '').join('');
            const lastEnd = rest[rest.length - 1];
            tail.endTime = typeof lastEnd.end === 'number' ? lastEnd.end : tail.endTime;
        }
    } else if (words) {
        /* ★ 词块聚合（2026-09-30）：网易云/QQ 的 yrc 逐字数据每个字一个 word——
           逐 word 一 segment 会把「也曾盼望」拆成四个独立块散开摆放（用户实测截图
           「也 曾 盼 望 有 人 懂 我」字间大空隙）。改为按 Intl.Segmenter 词边界把
           相邻 words 合并成词块：块文本=词、时间=块内首 word.start ~ 末 word.end，
           与上游「grapheme timeline + 词切分组装 segment」语义一致。 */
        const boundaries = [];
        try {
            const Segmenter = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
            if (Segmenter) {
                boundaries.push(...Array.from(
                    new Segmenter(undefined, { granularity: 'word' }).segment(fullText),
                    part => part.segment,
                ));
            }
        } catch { /* fallback below */ }
        const useBoundaryMerge = boundaries.length > 0 && boundaries.join('') === fullText;
        if (useBoundaryMerge) {
            let wi = 0;
            boundaries.forEach(boundText => {
                if (!boundText.length) return;
                const blockWords = [];
                let consumed = 0;
                while (wi < words.length && consumed < boundText.length) {
                    const w = words[wi];
                    blockWords.push(w);
                    consumed += (w.text || '').length;
                    wi += 1;
                }
                if (blockWords.length === 0) return;
                const start = typeof blockWords[0].start === 'number' ? blockWords[0].start : lineStart;
                const lastW = blockWords[blockWords.length - 1];
                const end = typeof lastW.end === 'number' && lastW.end > start
                    ? lastW.end
                    : (typeof lastW.start === 'number' ? lastW.start + 0.3 : start + 0.3);
                raw.push({ text: blockWords.map(w => w.text || '').join(''), startTime: start, endTime: end });
            });
            // 尾部未消费的 words 兜底并入
            if (wi < words.length && raw.length > 0) {
                const rest = words.slice(wi);
                const tail = raw[raw.length - 1];
                tail.text += rest.map(w => w.text || '').join('');
                const lastEnd = rest[rest.length - 1];
                tail.endTime = typeof lastEnd.end === 'number' ? lastEnd.end : tail.endTime;
            }
        } else {
            // Segmenter 不可用/不一致：退回逐 word（原行为）
            words.forEach(word => {
                const start = typeof word.start === 'number' ? word.start : lineStart;
                const end = typeof word.end === 'number' && word.end > start ? word.end : start + 0.3;
                raw.push({ text: word.text || '', startTime: start, endTime: end });
            });
        }
    } else {
        /* ★ 词级切分（2026-09-29，上游 segmentTextWords 等价——Intl.Segmenter word 粒度）：
           英文按词（"let's" 一段）、中文按字块。此前「单字均分」对英文是字母级碎片
           （一行 30 个字母 segment 各自摆放），满屏碎字重叠的根因。
           空白独立成段（与上游 Intl.Segmenter 形态一致），时间按字符占比均分。 */
        const span = Math.max(0.4, lineEnd - lineStart);
        let parts;
        try {
            const Segmenter = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
            parts = Segmenter
                ? Array.from(new Segmenter(undefined, { granularity: 'word' }).segment(fullText),
                    part => part.segment)
                : (fullText.match(/\s+|[\s\S]/g) || []);
        } catch {
            parts = fullText.match(/\s+|[\s\S]/g) || [];
        }
        const visibleParts = parts.filter(text => text.length > 0);
        const totalLen = visibleParts.reduce((sum, text) => sum + text.length, 0) || 1;
        let cursor = 0;
        visibleParts.forEach(text => {
            const d0 = cursor / totalLen;
            cursor += text.length;
            const d1 = cursor / totalLen;
            raw.push({
                text,
                startTime: lineStart + span * d0,
                endTime: lineStart + span * d1,
            });
        });
    }

    /* ★ 2026-10-02 CJK 单字聚块（用户实测「中文分成很多单字并且间隔很大」）：
       Intl.Segmenter 的中文切分常出一字块（我/拉/着/线…），散点布局把每块独立
       摆放 → 满屏单字 + 大间隔。相邻纯汉字块两两合并到 ≤3 字（时间取并集），
       散点数约减半、每块更可读；逐字 karaoke 时序不受影响（块内 graphemes
       仍按字符展开）。英文/混合块不动。 */
    const isCjkOnly = (t) => /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(t);
    const raw2 = [];
    raw.forEach(part => {
        const prev = raw2[raw2.length - 1];
        if (prev && isCjkOnly(prev.text) && isCjkOnly(part.text)
            && prev.text.length + part.text.length <= 3) {
            prev.text += part.text;
            prev.endTime = part.endTime;
            return;
        }
        raw2.push(part);
    });

    // graphemes（字符级时间，用于逐字渲染与可见长度统计）
    const segments = raw2.map(part => ({
        text: part.text,
        startOffset: 0,
        endOffset: part.text.length,
        startTime: part.startTime,
        endTime: part.endTime,
        graphemes: spreadGraphemes(part.text, part.startTime, part.endTime),
        wordIndices: [],
        isWordLike: WORD_LIKE_RE.test(part.text),
    }));

    // 粘连规则（上游 sticky）：非词非空白的 segment 并入前一个
    const sticky = [];
    for (const segment of segments) {
        const previous = sticky[sticky.length - 1];
        if (previous && !segment.isWordLike && !/^\s+$/u.test(segment.text)) {
            previous.text += segment.text;
            previous.endOffset = segment.endOffset;
            previous.endTime = Math.max(previous.endTime, segment.endTime);
            previous.graphemes.push(...segment.graphemes);
        } else {
            sticky.push({ ...segment, graphemes: [...segment.graphemes], wordIndices: [] });
        }
    }
    return sticky;
}

/** 是否 CJK（决定竖排可行性与旋转规则） */
export const isSonnetCjkText = (text) => CJK_RE.test(text);
