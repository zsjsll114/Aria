/* ============================================================
 * parsers/lyricMatch.js — 两份歌词是不是同一首歌（纯函数，无 DOM 无网络）
 *
 * 给「跨音源逐字歌词自动替换」（todos #12 开关2）用：当前歌词只有行级时间戳时，
 * 去别的音源找一份**文本对得上**的逐字歌词。"对得上"必须是可量化的，
 * 否则就会把另一首歌的节拍贴过来——那比没有逐字更糟。
 *
 * ★ 为什么不用现成的字符串库：全仓原先没有任何相似度实现（复扫：
 *   grep -rn "levenshtein|similarity" web/src --include=*.js 只有 vendor）。
 *   这里只要一个有界的编辑距离，够短文本用。
 * ============================================================ */

/** 归一化一行：去掉装饰符/空白/标点、全角转半角、拉丁转小写。
 *  各平台对同一句的写法差异基本都在这些上（酷狗 KRC 带 ^ $ \ 装饰、
 *  网易译名有空格差异），不归一直接比会把同句判成不同句。 */
export function normalizeLyricLine(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/[０-９Ａ-Ｚａ-ｚ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .toLowerCase()
        /* KRC 的装饰字符（^ 起音标记、$ 行内分隔、\ 断句）与常见标点空白一律不算字 */
        .replace(/[\s\^$\\,，。.!！?？、·—\-_~:：;;"'“”‘’()（）\[\]【】<>《》/|*+#&@%+=]/g, '')
        .trim();
}

/** 一行可显示的文本：优先整行，逐字行退化为拼词元（与 lyricIndex.lineTextOf 同思路，
 *  但这里不 import 那个模块，保持本文件零依赖可单测）。 */
function lineText(line) {
    if (!line) return '';
    if (typeof line.text === 'string' && line.text) return line.text;
    if (Array.isArray(line.words) && line.words.length) {
        return line.words.map(w => (w && (w.word ?? w.text ?? w.c)) || '').join('');
    }
    return '';
}

/**
 * 有界编辑距离相似度（0~1）。
 * 超过 maxLen*0.5 的距离直接早退——判"像不像"不需要精确到第 30 个编辑。
 */
export function lineSimilarity(a, b) {
    const s = normalizeLyricLine(a), t = normalizeLyricLine(b);
    if (!s && !t) return 1;
    if (!s || !t) return 0;
    if (s === t) return 1;
    const m = s.length, n = t.length;
    /* 长度差本身就超过阈值时不必再算 DP */
    if (Math.abs(m - n) / Math.max(m, n) > 0.5) return 0;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        const si = s.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = cur; cur = tmp;
    }
    const dist = prev[n];
    return 1 - dist / Math.max(m, n);
}

/** 这份歌词是不是「真·逐字」——合成出来的不算（约束 17：有 words ≠ 有真实逐字）。
 *  刻意不 import wordTiming.js，避免 parsers 内部互相牵连；判据保持一字不差。 */
export function hasRealWordTiming(lines) {
    if (!Array.isArray(lines)) return false;
    return lines.some(l => {
        if (!l || l.wordTiming === 'synthesized') return false;
        if (!Array.isArray(l.words) || !l.words.length) return false;
        const w0 = l.words[0];
        return typeof w0?.start === 'number' && typeof w0?.end === 'number' && w0.end > w0.start;
    });
}

/** 制作信息 / 元数据行。各平台连「有几条、什么顺序、怎么写」都不一样
 *  （实测同一首《晴天》：网易 8 条制作信息、酷狗 10 条且顺序不同），
 *  它们既不该拉低匹配率，也不该算进分母。 */
const CREDIT_RE = /(作词|作曲|编曲|制作人|出品人|出品|发行|版权|录音|混音|母带|和声|吉他|贝斯|钢琴|弦乐|弦编|缩混|助理|监制|经纪|唱片|工作室|厂牌|OP|SP|Lyricist|Composer|Arrang|Producer|Program|Mixing|Mixed|Recording|Master|Engineer|Studio|Bass|Guitar|Piano|Strings|Violin|Cello|Choir|©|℗)/i;

function isCreditLine(text) {
    return CREDIT_RE.test(text);
}

/**
 * 顺序保持的最长公共子序列计数（只数「达标」的配对）。
 *
 * ★ 为什么不用位置对齐（第一版就是位置对齐，实测直接把功能做死了）：
 *   两份官方歌词的行数与开头制作信息条数几乎从不相同，只要前面多一行，
 *   后面**全部**错位——同一首《晴天》的网易版与酷狗版按位置比只有 0.048 分，
 *   于是自动替换永远不触发（用户实测「下面的开关没用、不会替换」）。
 *   LCS 容忍插入/删除，同一对实测 0.962。
 * ★ 为什么仍然是「顺序保持」：不做乱序匹配，歌词只多一段重复副歌不会变成高分，
 *   而两首歌的歌词打乱顺序也不会被误判成同一首。
 */
function lcsMatched(a, b, threshold) {
    const n = a.length, m = b.length;
    if (!n || !m) return 0;
    let prev = new Int32Array(m + 1);
    let cur = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const skip = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
            const take = a[i - 1] === b[j - 1] ? 1
                : (Math.abs(a[i - 1].length - b[j - 1].length) / Math.max(a[i - 1].length, b[j - 1].length) > 0.5
                    ? -1 : (lineSimilarity(a[i - 1], b[j - 1]) >= threshold ? 1 : -1));
            cur[j] = Math.max(skip, take > 0 ? prev[j - 1] + 1 : -1);
        }
        const tmp = prev; prev = cur; cur = tmp;
        cur.fill(0);
    }
    return prev[m];
}

/** 字符级顺序 LCS 长度（两行滚动数组）。判定「同一首歌」用这个，不用按行比。 */
function charLcsLength(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return 0;
    let prev = new Uint16Array(m + 1);
    let cur = new Uint16Array(m + 1);
    for (let i = 1; i <= n; i++) {
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
            cur[j] = ca === b.charCodeAt(j - 1)
                ? prev[j - 1] + 1
                : (prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1]);
        }
        const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[m];
}

/**
 * 两份歌词的匹配率（0~1）。
 *
 * 口径：先把制作信息行滤掉，再做顺序保持的 LCS 配对，
 * 分母取两份**正文**行数的较大值——候选少了一整段副歌也是不匹配，
 * 不能按「匹配上的都挺像」给满分。
 *
 * @param {Array<Object>} current  当前在用的（行级）歌词
 * @param {Array<Object>} candidate 候选（逐字）歌词
 * @param {{perLineThreshold?:number}} [opts]
 * @returns {{rate:number, matched:number, total:number, perLine:number}}
 *          perLine 是**按位置**比的均值，只作诊断/测试用，判定一律用 rate
 */
export function lyricMatchRate(current, candidate, opts = {}) {
    const perLineThreshold = Number.isFinite(opts.perLineThreshold) ? opts.perLineThreshold : 0.82;
    const rawA = (Array.isArray(current) ? current : []).map(lineText).filter(t => normalizeLyricLine(t));
    const rawB = (Array.isArray(candidate) ? candidate : []).map(lineText).filter(t => normalizeLyricLine(t));
    const total = Math.max(rawA.length, rawB.length);
    if (!total) return { rate: 0, matched: 0, total: 0, perLine: 0 };

    const a = rawA.filter(t => !isCreditLine(t));
    const b = rawB.filter(t => !isCreditLine(t));
    /* 两份都只剩制作信息（纯音乐/说明型歌词）时退回全量，别除以 0 */
    const useA = a.length ? a : rawA;
    const useB = b.length ? b : rawB;
    const denom = Math.max(useA.length, useB.length);

    const shared = Math.min(rawA.length, rawB.length);
    let sum = 0;
    for (let i = 0; i < shared; i++) sum += lineSimilarity(rawA[i], rawB[i]);

    const matched = lcsMatched(useA, useB, perLineThreshold);
    /* ★ 真正的判据在字流上，不在「行」上：各平台分行习惯天生不同
       （酷狗 KRC 把一句唱词拆成两行、网易一行），按行比会把同一首歌算成 67%。
       这里把两份词各自摊成一条归一化字符流，做顺序 LCS，
       问的是「我现在这份词的字数，有多少能按顺序在候选里找到」。 */
    const streamA = useA.map(t => normalizeLyricLine(t)).join('');
    const streamB = useB.map(t => normalizeLyricLine(t)).join('');
    const charMatched = charLcsLength(streamA, streamB);
    /* ★ 两个口径都要，但**判定用 coverage**：
       coverage = 当前这份词有多少行在候选里找得到对应 —— 这才是「能不能把候选的节拍贴上来」
       真正要问的问题。rate（matched / 两份较大行数）惩罚的是「两份行数不一样多」，
       而各平台分行习惯本来就不同（同一句酷狗拆两行、网易一行），实测一首歌
       kugou 67% / tencent 86% 都被 rate 挡掉，可它对当前歌词的覆盖率其实是够的。
       保留 rate 作诊断口径，别再拿它当唯一判据。 */
    const cur = useA.length || 1;
    return {
        rate: denom ? matched / denom : 0,
        coverage: streamA.length ? Math.min(1, charMatched / streamA.length) : 0,
        matched, total: denom,
        perLine: shared ? sum / shared : 0,
    };
}
