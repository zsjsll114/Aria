import { parseYrc, parseNeteaseYrc } from './yrcParser.js';
import { parseLrc, cleanQQMusicMetadata } from './lrcParser.js';
import { parseRoma } from './romaParser.js';
import { parseKrc } from '../services/krcParser.js';


/* ==================== 歌词行有效性守卫（v1） ====================
 * 真实事故：中文歌配上了"另一首中文歌"的翻译轨（源站把同语言歌词当翻译下发），
 * 且正轨里混着「出品：昌禾文化」「[该版本已获词曲正式授权]」这类制作信息行。
 * 两道守卫在 mergeLyrics 里生效，所有视觉模式与桌面歌词共用。 */
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;   /* 日文假名（有假名 = 日文行） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function cjkRatio(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t.length) return 0;
    let cjk = 0;
    for (const ch of t) if (CJK_RE.test(ch)) cjk += 1;
    return cjk / t.length;
}

/* 中文主导行：含较多汉字且无假名。日文歌（含假名）不在此列，日→中翻译不受影响 */
function isChineseLine(text) {
    const t = String(text || '');
    return !KANA_RE.test(t) && cjkRatio(t) > 0.55;
}

/* 制作信息/版权行：字段冒号开头（出品：xx / 作词：xx）、方括号授权声明、
   整句版权套话。保守匹配，宁可漏掉也不误伤正常歌词。 */
function isJunkCreditLine(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^[[(【]/.test(t) && /(授权|版权|著作权|许可)/.test(t)) return true;
    if (/^(出品|制作|制作人|监制|作词|作曲|编曲|填词|谱曲|混音|母带|录音|发行|和声|配唱|吉他|贝斯|鼓|键盘|弦乐|统筹|文案|翻译|OP|SP)\s*[:：]/.test(t)) return true;
    if (t.length < 40 && /(未经[^。]{0,12}授权|不得转发|保留所有权利|版权所有)/.test(t)) return true;
    return false;
}

/* ==================== 两轨时间对齐（v2：先估整体偏移，再做单调 1:1 最优指派） ====================
 * 现场事故（2026-09-26 用户报告）：v1 的单调对齐只认「|行时间 - 译文字间| ≤ 3s」这个**绝对**
 * 窗口，而真实翻译轨往往带一个**系统性偏移**——译文整轨重新打过点、原轨多了前缀/制作信息行、
 * 两份词由不同工具产出。后果两条，正好对上用户的两句抱怨：
 *   ① 偏移一超窗就整片拿不到译文（实测覆盖率掉到约一半）；
 *   ② 偏移卡在行距之间时，每一行都会拿到**上一行**的译文（表现为"岔开了"），
 *      而 v1 用单向指针消费行（ri = best + 1）+ 过早 break，一次早先的错配会把后面所有行
 *      的窗口永久带偏，没法自愈。
 *
 * v2 三步（纯函数、零依赖、无 Math.random，同输入必同输出）：
 *   ① 估计整体偏移：把两轨所有候选配对的时间差 (译文 - 行) 收起来，取其中位数作稳健估计
 *      anchor，再按密度聚簇取前几个簇心当候选（真偏移一定是最密的簇；两轨在"名次"上各自
 *      连续时这堆差值天然关于真偏移对称，所以缺行/多一条开头行都带不偏它）；
 *   ② 每个候选偏移（外加 0 偏移基线）各跑一次「单调 1:1 最优指派」DP，按
 *      配对数最多 → 残差之和最小 → 离 anchor 最近 → 偏移绝对值最小 选优。
 *      全局最优取代贪心走一步看一步，所以「开头多一条没有译文的行」不会再把它后面整体带偏；
 *      第三档不可省：整轨平移 k 个行距往往能凑出同样多、残差同样为 0 的另一套配对，
 *      而那正是"每行都拿到邻居译文"的岔开。
 *   ③ 用上一步的锚点拟合一条线性漂移（偏移随行时间线性增长，不同工具打点常见），
 *      只有**严格提高配对数**才采纳——这一步只可能补回覆盖，不会换走已配对的行。
 *
 * 不变量（v1 当初就是为了修这个，绝不能退回）：一行最多一条译文、一条译文最多给一行、
 * 且不会跨到明显属于邻居的行。靠四道闸保证：残差窗收窄到 min(1.6s, 0.8×中位行距)、
 * 指派必须单调不交叉、同基数时取残差最小（"谁更近给谁"）、非零偏移必须先攒够证据
 * （minSupport = max(2, 0.3×较短一轨)）。
 * 退化输入（一空轨 / 时间戳全 0 或全同 / 非数字 / 翻译轨短到只剩孤句）一律出空：
 * 少一句译文远好过贴错一句译文。 */
const ALIGN = {
    maxSystematicOffset: 20000,   /* 整体偏移搜索上限：超过 20s 不认为是"同一首歌的偏移" */
    voteTolerance: 600,           /* 偏移投票的聚类半径（ms） */
    maxVoteCandidates: 6,         /* 送进 DP 的候选偏移个数 */
    residualMin: 800,             /* 校正后允许的最小残差窗 */
    residualMax: 1600,            /* 校正后允许的最大残差窗（v1 的 3000 太松，是错配根源） */
    residualSpacingFactor: 0.8,   /* 行距很密时按 0.8×中位行距收窄，避免捡到邻居的译文 */
    supportRatio: 0.3,            /* 采纳非零偏移所需配对数 = max(2, 该比例 × 较短一轨) */
    minAnchorsForDrift: 3,        /* 少于 3 个锚点不拟合漂移（两点定线等于噪声） */
    minDriftSpan: 5000,           /* 锚点前后两半的时间跨度太小 → 斜率不可信 */
    maxDriftSlope: 0.25,          /* 偏移每毫秒最多漂 0.25ms，再陡就不是"同一首歌的漂移" */
    maxDpCells: 4000000,          /* DP 规模上限，超过退回单遍贪心（正常歌词几百行，用不到） */
    maxVotePairs: 60000           /* 候选时间差的采样上限（防御性截断，避免病态输入放大） */
};

/* 时间戳清洗：只接受有限数字（NaN/undefined/字符串脏数据 → null，该行不参与对齐） */
function toFiniteTime(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function toTimedEntries(list, timeOf) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const obj of list) {
        if (!obj) continue;
        const t = toFiniteTime(timeOf(obj));
        if (t === null) continue;
        out.push({ obj, t });
    }
    /* ES2019+ 的 Array.sort 稳定：同一时间戳的行/译文保持原始先后，不会凭空调序 */
    out.sort((a, b) => a.t - b.t);
    return out;
}

/* 中位数（入参无需有序；样本量都是"行数"级别，排序成本忽略） */
function median(values) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* 中位行距：只统计"真正推进了"的间隔（全 0 时间戳时返回 Infinity，由 hasOrderingInfo 拦下） */
function medianSpacing(entries) {
    const gaps = [];
    for (let i = 1; i < entries.length; i++) {
        const g = entries[i].t - entries[i - 1].t;
        if (g > 0) gaps.push(g);
    }
    return gaps.length ? median(gaps) : Infinity;
}

function residualTolerance(entries) {
    const sp = medianSpacing(entries);
    if (!Number.isFinite(sp)) return ALIGN.residualMax;
    return Math.min(ALIGN.residualMax, Math.max(ALIGN.residualMin, sp * ALIGN.residualSpacingFactor));
}

/* 时间戳全是同一个值（典型：整轨 [00:00.00]）→ 没有任何顺序信息，按数组下标硬配等于编造 */
function hasOrderingInfo(entries) {
    return entries.length < 2 || entries[0].t < entries[entries.length - 1].t;
}

/* ① 偏移投票，拆两步：
      collectDeltas —— 收齐两轨所有候选配对的时间差 (译文时间 - 行时间)，
          它的中位数就是整体偏移的稳健估计 anchor：两轨在"名次"上各自连续时，这堆差值
          天然关于真偏移对称，所以缺几行、多一条开头行都带不偏它。
      pickOffsets —— 同一批差值按密度聚簇，最密的几个簇心才是送进 DP 的候选偏移
          （并列时偏移小的优先；anchor 只在同分候选之间择一，见 isBetterModel）。 */
function collectDeltas(R, T) {
    const tArr = T.map(x => x.t);
    const deltas = [];
    let lo = 0, hi = 0;
    outer:
    for (const r of R) {
        while (lo < tArr.length && tArr[lo] < r.t - ALIGN.maxSystematicOffset) lo++;
        if (hi < lo) hi = lo;
        while (hi < tArr.length && tArr[hi] <= r.t + ALIGN.maxSystematicOffset) hi++;
        for (let j = lo; j < hi; j++) {
            deltas.push(tArr[j] - r.t);
            if (deltas.length >= ALIGN.maxVotePairs) break outer;   /* 防御性截断 */
        }
    }
    return deltas;
}

function pickOffsets(deltas) {
    if (!deltas.length) return [];
    const sorted = deltas.slice().sort((a, b) => a - b);
    const width = ALIGN.voteTolerance * 2;
    const clusters = [];
    let end = 0;
    for (let s = 0; s < sorted.length; s++) {
        if (end < s) end = s;
        while (end + 1 < sorted.length && sorted[end + 1] - sorted[s] <= width) end++;
        clusters.push({ center: sorted[(s + end) >> 1], count: end - s + 1 });
    }
    clusters.sort((a, b) => (b.count - a.count) || (Math.abs(a.center) - Math.abs(b.center)));
    const picked = [];
    for (const c of clusters) {
        if (Math.abs(c.center) < 1) continue;                       /* 0 偏移是基线，不必投 */
        if (c.count < 2 && picked.length) continue;                 /* 单证据簇只在前面的补位 */
        if (picked.some(o => Math.abs(o - c.center) <= ALIGN.voteTolerance)) continue;
        picked.push(c.center);
        if (picked.length >= ALIGN.maxVoteCandidates) break;
    }
    return picked;
}

/* ② 单调 1:1 最优指派（DP）。pred[i] = 第 i 行译文"应该"出现的时间；
      每配一对得 (gain - 残差/窗)，gain = n+m+1 > 任何单对罚分(≤1)，
      所以先最大化配对数、再最小化残差之和。返回的 pairs 按行号升序且互不交叉。 */
function assignByDp(R, tArr, pred, tol) {
    const n = R.length, m = tArr.length, cols = m + 1;
    const gain = n + m + 1;
    const dir = new Uint8Array((n + 1) * cols);                     /* 0 跳过行 / 1 跳过译文 / 2 配对 */
    let prev = new Float64Array(cols);
    let cur = new Float64Array(cols);
    for (let i = 1; i <= n; i++) {
        const p = pred[i - 1];
        cur[0] = 0;
        for (let j = 1; j <= m; j++) {
            let score = prev[j];
            let d = 0;
            if (cur[j - 1] > score) { score = cur[j - 1]; d = 1; }
            const res = Math.abs(p - tArr[j - 1]);
            if (res <= tol) {
                const pairScore = prev[j - 1] + gain - res / tol;
                if (pairScore > score) { score = pairScore; d = 2; }
            }
            cur[j] = score;
            dir[i * cols + j] = d;
        }
        const swap = prev; prev = cur; cur = swap;
    }
    const pairs = [];
    for (let i = n, j = m; i > 0 && j > 0;) {
        const d = dir[i * cols + j];
        if (d === 2) { pairs.push([i - 1, j - 1]); i--; j--; }
        else if (d === 1) { j--; }
        else { i--; }
    }
    pairs.reverse();
    return pairs;
}

/* 病态规模（行×译文超过 maxDpCells）才走这里：同一套校正后的时间，单遍贪心，放弃全局最优 */
function assignBySweep(R, tArr, pred, tol) {
    const pairs = [];
    let j = 0;
    for (let i = 0; i < R.length && j < tArr.length; i++) {
        while (j < tArr.length && tArr[j] < pred[i] - tol) j++;     /* 这条译文已经早过头，作废 */
        if (j >= tArr.length) break;
        if (Math.abs(tArr[j] - pred[i]) <= tol) { pairs.push([i, j]); j++; }
    }
    return pairs;
}

/* 一次指派的完整打分：配对 + 残差之和 + 这个配对所依据的偏移假设 */
function scoreModel(R, tArr, pred, tol, offset) {
    const pairs = (R.length + 1) * (tArr.length + 1) > ALIGN.maxDpCells
        ? assignBySweep(R, tArr, pred, tol)
        : assignByDp(R, tArr, pred, tol);
    let residualSum = 0;
    for (const [i, j] of pairs) residualSum += Math.abs(pred[i] - tArr[j]);
    return { pairs, residualSum, offset };
}

/* 选优：配对数 → 残差之和 → 离整体偏移估计(anchor)更近 → 偏移绝对值更小。
   ① 非零偏移必须先攒够证据（minSupport）才有资格上台，防止"两句话的巧合"劫持整轨；
   ② 第三档是必需的：整体平移 k 个行距往往能凑出**同样多、同样准**的另一套配对
      （每行都拿到邻居的译文，残差全是 0），此时只有"哪个偏移是两轨共同的主张"能分辨。 */
function isBetterModel(a, b, minSupport, anchor) {
    if (a.offset !== 0 && a.pairs.length < minSupport) return false;
    if (a.pairs.length !== b.pairs.length) return a.pairs.length > b.pairs.length;
    if (Math.abs(a.residualSum - b.residualSum) > 1) return a.residualSum < b.residualSum;
    const da = Math.abs(a.offset - anchor), db = Math.abs(b.offset - anchor);
    if (Math.abs(da - db) > 1) return da < db;
    return Math.abs(a.offset) < Math.abs(b.offset);
}

/* ③ 漂移细化：锚点上的"实际偏移"若随行时间爬升（两份词各自打点、误差累积），
      用两半中位数拟合一条直线再指派一次。只接受严格提高配对数的结果——
      这一步只会补回覆盖，不可能把已经配对正确的行换走。 */
function fitDrift(R, tArr, best, tol) {
    if (best.pairs.length < ALIGN.minAnchorsForDrift) return null;
    const anchors = best.pairs.map(([i, j]) => ({ x: R[i].t, y: tArr[j] - R[i].t }));
    const mid = median(anchors.map(a => a.x));
    const low = anchors.filter(a => a.x < mid);
    const high = anchors.filter(a => a.x >= mid);
    if (!low.length || !high.length) return null;
    const dx = median(high.map(a => a.x)) - median(low.map(a => a.x));
    if (Math.abs(dx) < ALIGN.minDriftSpan) return null;             /* 锚点挤在一起，斜率是噪声 */
    const slope = (median(high.map(a => a.y)) - median(low.map(a => a.y))) / dx;
    if (!Number.isFinite(slope) || Math.abs(slope) > ALIGN.maxDriftSlope) return null;
    const base = median(anchors.map(a => a.y - slope * (a.x - mid)));
    const pred = R.map(r => r.t + base + slope * (r.t - mid));
    return scoreModel(R, tArr, pred, tol, base);
}

/* 保留 v1 的名字：语义仍是"单调 1:1 对齐"，只是窗口从绝对改成了「整体偏移 + 残差」 */
function monotonicAlign(rows, tracks, rowTime, trackTime) {
    const map = new Map();
    const R = toTimedEntries(rows, rowTime);
    const T = toTimedEntries(tracks, trackTime);
    if (!R.length || !T.length) return map;
    if (!hasOrderingInfo(R) || !hasOrderingInfo(T)) return map;
    const tArr = T.map(x => x.t);
    const tol = residualTolerance(R);
    const minSupport = Math.max(2, Math.ceil(ALIGN.supportRatio * Math.min(R.length, T.length)));
    const deltas = collectDeltas(R, T);
    const anchor = deltas.length ? median(deltas) : 0;              /* 整体偏移的稳健估计 */

    const zeroPred = R.map(x => x.t);
    let best = scoreModel(R, tArr, zeroPred, tol, 0);                /* 基线：零偏移 */
    for (const off of pickOffsets(deltas)) {
        const cand = scoreModel(R, tArr, zeroPred.map(t => t + off), tol, off);
        if (isBetterModel(cand, best, minSupport, anchor)) best = cand;
    }
    const refined = fitDrift(R, tArr, best, tol);
    if (refined && refined.pairs.length > best.pairs.length && refined.pairs.length >= minSupport) {
        best = refined;
    }
    for (const [i, j] of best.pairs) map.set(R[i].obj, T[j].obj);
    return map;
}

export function mergeLyrics(originals, translations = [], romaji = []) {
    const merged = [];
    const hasTranslations = translations && translations.length > 0;
    const hasRomaji = romaji && romaji.length > 0;

    /* ★ 译文/罗马音按「整体偏移 + 单调 1:1 最优指派」对齐，见本文件顶部 monotonicAlign 的注释。
       下面两道守卫（制作信息行 / 同文字系统）在配对之后仍然逐行复核，配对策略改了也不放过。 */
    const transMap = hasTranslations
        ? monotonicAlign(originals, translations, o => o.start, t => t.time)
        : new Map();
    const romaMap = hasRomaji
        ? monotonicAlign(originals, romaji, o => o.start, r => r.start)
        : new Map();
    for (const original of originals) {
        const origText = String(original.original || original.text || '').trim();
        /* 守卫 1：制作信息/版权行不进歌词（它们的"翻译"通常是另一首歌的词） */
        if (isJunkCreditLine(origText)) continue;
        const mergedLine = { ...original, translation: "", romaji: "", romajiWords: [] };
        if (hasTranslations && transMap.has(original)) {
            mergedLine.translation = transMap.get(original).text || '';
        }
        /* 守卫 2：同文字系统翻译无效——中文原行配中文"翻译" = 源站错发（往往是另一首歌），
           直接丢弃该行翻译。日文行（含假名）配中文翻译是正常日→中，不受影响。 */
        if (mergedLine.translation) {
            const tText = String(mergedLine.translation).trim();
            if (!tText ||
                tText === origText ||
                isJunkCreditLine(tText) ||
                (isChineseLine(origText) && isChineseLine(tText))) {
                mergedLine.translation = "";
            }
        }
        if (hasRomaji && romaMap.has(original)) {
            const romaLine = romaMap.get(original);
            mergedLine.romajiWords = (romaLine && romaLine.words) || [];
            mergedLine.romaji = (romaLine && romaLine.original) || "";
        }
        merged.push(mergedLine);
    }
    return merged;
}

export function detectAndParseLyrics(data) {
    if (!data) return { format: 'empty', originals: [], translations: [], romaji: [] };

    /* 兼容直接传入纯文本字符串 */
    if (typeof data === 'string') {
        const text = data.trim();
        if (text.startsWith('[') && text.includes(',')) {
            data = { yrc: text };
        } else {
            data = { lrc: text };
        }
    }

    // 酷狗 KRC 已预先解析列表直通
    if (data.parsedList && Array.isArray(data.parsedList) && data.parsedList.length > 0) {
        return {
            format: 'kugou_krc',
            originals: data.parsedList,
            translations: data.translations || [],
            romaji: data.romaji || []
        };
    }

    // 酷狗原始 KRC 文本解析
    if (data.krc && typeof data.krc === 'string' && data.krc.trim()) {
        const krcParsed = parseKrc(data.krc);
        if (krcParsed && krcParsed.length > 0) {
            return {
                format: 'kugou_krc',
                originals: krcParsed,
                translations: [],
                romaji: []
            };
        }
    }

    let format = 'unknown';
    let originals = [];
    let translations = [];
    let romaji = [];
    const yrcTrim = data.yrc ? data.yrc.trim() : '';
    const isYrc = yrcTrim && (yrcTrim.match(/^\[\d+,\d+\]/) || yrcTrim.includes('(') || yrcTrim.match(/^\[ti:/) || yrcTrim.match(/^\[ar:/) || yrcTrim.match(/^\{/));

    if (isYrc) {
        /* 区分QQ（2参数 (a,b) 文本在标记之间）与网易云（3参数 (a,b,0) 文本在标记之后） */
        const isNeteaseYrc = /\(\d+,\d+,\d+\)/.test(yrcTrim);
        if (isNeteaseYrc) {
            format = 'netease_yrc';
            originals = parseNeteaseYrc(data.yrc);
            if (originals.length === 0) originals = parseYrc(data.yrc);
        } else {
            format = 'qq_yrc';
            originals = parseYrc(data.yrc);
            if (originals.length === 0) originals = parseNeteaseYrc(data.yrc);
        }
        /* 如果按 YRC 解析依然为空，可能其实是普通 LRC 文本，自动回退到 parseLrc */
        if (originals.length === 0) {
            originals = parseLrc(data.yrc).map((item, index, arr) => ({
                start: item.time,
                end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                original: item.text,
                words: []
            }));
            if (originals.length > 0) format = 'lrc';
        }
        if (data.trans) {
            let transText = cleanQQMusicMetadata(data.trans);
            translations = parseLrc(transText).filter(item => item.text.trim() !== '//');
        }
        if (data.roma) {
            /* ★ QQ 罗马音（contentroma）与 QRC 同构：[行起点,行时长]词(词起点,词时长)…
               且和 QRC 一样带 [ti:]/[ar:]/[kana:] 元数据头。旧实现拿原始串直接
               match(/^\[\d+,\d+\]/) → 首行是 [ti:...] 必然失败 → 掉进 LRC 分支
               被丢掉（罗马音永远不显示）。必须先剥元数据再判定格式。 */
            const romaClean = cleanQQMusicMetadata(data.roma).trim();
            if (romaClean && /^\[\d+,\d+\]/.test(romaClean)) {
                romaji = parseYrc(romaClean);
                /* 兜底：极少数源是「(s,d)文本」排布（文本在标记后），parseYrc 会空手而归 */
                if (romaji.length === 0) romaji = parseRoma(romaClean);
            } else if (romaClean) {
                romaji = parseLrc(romaClean).map((item, index, arr) => ({
                    start: item.time,
                    end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                    original: item.text,
                    words: []
                }));
            }
            /* 丢弃「只有 (s,d) 标记、无实际文字」的间奏占位行（parseYrc 会把它
               当成无标记普通行保留下来，污染罗马音轴） */
            romaji = romaji.filter(r => /[^\s\d(),，、]/.test(r.original || ''));
        }
    } else if (data.lrc) {
        let lrcText = data.lrc;
        format = 'lrc';
        if (data.trans) {
            translations = parseLrc(cleanQQMusicMetadata(data.trans)).filter(item => item.text.trim() !== '//');
        }
        if (data.roma) {
            romaji = parseLrc(cleanQQMusicMetadata(data.roma)).map((item, index, arr) => ({
                start: item.time,
                end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
                original: item.text,
                words: []
            }));
        }
        originals = parseLrc(lrcText).map((item, index, arr) => ({
            start: item.time,
            end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
            original: item.text,
            words: []
        }));
        /* 如果 LRC 解析为空，尝试作为 YRC 解析 */
        if (originals.length === 0) {
            originals = parseYrc(lrcText);
            if (originals.length === 0) originals = parseNeteaseYrc(lrcText);
        }
    }

    /* 绝对兜底：如果前面全部为空但存在任何文本字段 */
    if (originals.length === 0 && (data.lrc || data.yrc || data.krc)) {
        const rawFallback = data.lrc || data.yrc || data.krc;
        originals = parseLrc(rawFallback).map((item, index, arr) => ({
            start: item.time,
            end: index < arr.length - 1 ? arr[index + 1].time : item.time + 5000,
            original: item.text,
            words: []
        }));
    }
    return { format, originals, translations, romaji };
}
