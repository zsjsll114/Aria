import { wordSegmenter } from './pvEngine/WordSegmenter.js';
import { logInfo, logWarn } from '../services/log.js';

/**
 * proceduralLayout.js — 程序化歌词排版引擎（folia 作者方案落地）
 *
 * ▌设计来源（folia 作者对 AI 分析的阐述）：
 *   "其实这个还挺容易实现的。分析音频文件先测BPM然后快速傅里叶就可以拿到挺多节奏信息。
 *    排版的话只要获取文字分段的测量数据（直接 intl.segment，或者用专用分词器，效果远好于这个），
 *    接下来就和 blender 几何节点一样做成程序化生成就可以了，是一个二维搜索问题。"
 *
 * ▌本模块取代原「第二路 LLM 排版请求」（requestLayoutAnalyses / buildLayoutSystemPrompt）：
 *   - 文字测量：wordSegmenter 分词（segmentit/kuromoji/Intl.Segmenter 三级 + 情感词锚定，
 *     与 PVLyricLayout/TunnelDirector 完全同管线）→ 按字符类别估算 em 宽度
 *   - 二维搜索：每行词块的分页与页内换行走 DP 断行（宽度约束 + 标点偏好 + 页宽均衡），
 *     O(n²) 且 n ≤ 40，微秒级
 *   - 情绪/能量：情感词典投票（folia §5 四维样式函数的降级路）+ 副歌区间/BPM/时长调制
 *   - 输出：与原 AI line_analyses 完全同构（line_index/page_index/emotion/energy/
 *     keywords/group_indices/alignment/line_breaks/bg_theme），下游 AILyricSegmenter、
 *     TunnelDirector、蒙德里安零改动
 *
 * ▌确定性：全程禁用 Math.random——构图/对齐变化全部由「全曲文本哈希 + 行号/页号取模」
 *   驱动，同一首歌每次渲染结果完全一致（可跨端复现、可单测）。

/* ==================== 常量 ==================== */

/** 页宽（em）：软目标 / 硬上限。CJK 一字 1em，PV 大字排版一行约 10~16 字 */
const PAGE_TARGET_EM = 13;
const PAGE_HARD_EM = 18;
/** 页内视觉行宽上限（em），供 line_breaks 计算 */
const ROW_MAX_EM = 9;
/** 每页词块数下限（单块页仅在剩余块=1 或单块超宽时出现，带惩罚） */
const SOFT_MIN_BLOCKS = 2;
/** 每页词块数硬上限——超过则排版过密，强制断页 */
const HARD_MAX_BLOCKS = 9;

/** 单字符 em 宽度估算（字符类别 → 宽度；无 DOM、无 canvas，纯确定性） */
const EM_WIDTH_TESTS = [
    [/[\u2E80-\u9FFF\uF900-\uFAFF]/, 1.0],                              // CJK 汉字
    [/[\u3040-\u30FF]/, 1.0],                                           // 日文假名
    [/[\uAC00-\uD7AF]/, 1.0],                                           // 谚文
    [/[\uFF00-\uFFEF\u3000-\u303F]/, 1.0],                              // 全角标点
    [/[MWmw@％%]/, 0.92],                                               // 宽拉丁
    [/[A-Z0-9]/, 0.68],                                                 // 大写/数字
    [/[iIl1!''’,.;:|·]/, 0.30],                                         // 窄字符
    [/[a-z]/, 0.55],                                                    // 小写
    [/\s/, 0.32],                                                       // 空白
];

function charEmWidth(ch) {
    for (const [re, w] of EM_WIDTH_TESTS) {
        if (re.test(ch)) return w;
    }
    return 0.6;
}

/** 文本 em 宽度（grapheme 安全切分，emoji 合成序列不拆碎） */
export function measureTextEm(text) {
    if (!text) return 0;
    const glyphs = wordSegmenter.graphemeSplit(String(text));
    let w = 0;
    for (const g of glyphs) w += charEmWidth(g);
    return w;
}

/** 词块 em 宽度（含西文词尾空格） */
function blockWidthEm(block) {
    if (!block) return 0;
    return measureTextEm(block.text) + (block.hasSpaceAfter ? 0.32 : 0);
}

/* ==================== 情感词典（folia §5 降级路：逐词投票取最高票） ==================== */

const LEXICON_ZH = {
    sorrow: ['泪', '哭', '痛', '孤单', '寂寞', '遗忘', '告别', '离别', '伤', '悲', '心碎', '失去', '遗憾', '抱歉', '冷淡', '灰', '残'],
    love: ['爱', '喜欢', '恋', '吻', '拥抱', '温柔', '想念', '心动', '甜蜜', '亲爱的', '陪伴'],
    anger: ['恨', '怒', '烧', '滚', '吼', '疯狂', '厌倦', '反抗', '战斗', '呐喊', '燃烧', '撕裂'],
    hope: ['光', '梦', '飞', '晴', '升起', '勇敢', '相信', '未来', '希望', '闪耀', '黎明', '追逐', '前进', '绽放'],
    betray: ['骗', '背叛', '谎言', '虚伪', '丢弃', '抛弃', '嘲笑', '讽刺', '辜负', '承诺']
};
const LEXICON_EN = {
    sorrow: ['cry', 'tears', 'lonely', 'goodbye', 'lost', 'hurt', 'cold', 'rain', 'broken', 'alone'],
    love: ['love', 'heart', 'kiss', 'hold', 'sweet', 'baby', 'darling', 'forever'],
    anger: ['hate', 'burn', 'scream', 'fight', 'rage', 'mad', 'fire'],
    hope: ['fly', 'dream', 'shine', 'rise', 'bright', 'believe', 'tomorrow', 'light', 'sky'],
    betray: ['lie', 'liar', 'betray', 'fake', 'used', 'leave']
};
const EMOTIONS = ['sorrow', 'love', 'anger', 'hope', 'betray', 'neutral'];

/** 情绪 → 对齐/色板映射（folia §5：情绪决定构图张力，不搞「悲伤→预设A」） */
const EMOTION_STYLE = {
    sorrow: { alignment: 'center', palette: ['#8FA8B8', '#A8B8C4', '#C4CDD4', '#6E7F8D'] },
    love:   { alignment: 'center', palette: ['#D8A8A8', '#C89AA4', '#E0C4B4', '#B08890'] },
    anger:  { alignment: 'right',  palette: ['#C87878', '#B86A6A', '#D89888', '#A85858'] },
    hope:   { alignment: 'left',   palette: ['#C8C89A', '#D8D0A8', '#B8C8B0', '#A8B888'] },
    betray: { alignment: 'right',  palette: ['#A088B0', '#8888B8', '#B0A0C0', '#7878A0'] },
    neutral:{ alignment: 'center', palette: ['#B0B0AA', '#C0BEB8', '#A8A8A4', '#C8C6C0'] }
};

/** 蒙德里安构图池（确定性轮换：songSeed + 行号/页号取模） */
const COMPOSITION_POOL = ['band', 'diagonal', 'column', 'arc', 'steps', 'center', 'tilt', 'scatter'];

/* ==================== 工具 ==================== */

/** 时间归一到毫秒（歌词行 start/end 可能是秒(LRC)或毫秒(YRC)；>1000 视为毫秒） */
function toMs(v, fallback) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return fallback;
    return v > 1000 ? v : v * 1000;
}

/** 稳定字符串哈希（确定性种子） */
function hashStr(s) {
    let h = 7;
    for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
    return h;
}

/** 行尾标点分级：2=句末（强断点）1=句中（弱断点）0=无 */
function endPunctClass(text) {
    const t = String(text || '').trim();
    if (!t) return 0;
    if (/[。！？!?…]$/.test(t)) return 2;
    if (/[，,、；;：:～—]$/.test(t)) return 1;
    return 0;
}

/** 情绪词典投票：返回六类之一（无票沿用 prev，保持跨页连贯） */
export function voteEmotion(text, prev) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const scores = { sorrow: 0, love: 0, anger: 0, hope: 0, betray: 0 };
    for (const emo of EMOTIONS) {
        if (emo === 'neutral') continue;
        for (const w of (LEXICON_ZH[emo] || [])) {
            if (raw.includes(w)) scores[emo] += (w.length >= 2 ? 2 : 1);
        }
        for (const w of (LEXICON_EN[emo] || [])) {
            if (lower.includes(w)) scores[emo] += 2;
        }
    }
    let best = null, bestScore = 0;
    for (const emo of EMOTIONS) {
        if (emo === 'neutral') continue;
        if (scores[emo] > bestScore) { bestScore = scores[emo]; best = emo; }
    }
    return best || prev || 'neutral';
}

/* ==================== 二维搜索：分页 DP ==================== */

/**
 * 对一行的词块做分页（宽度约束 + 标点偏好 + 页宽均衡的 DP 断行）
 * 返回 [{ startIdx, endIdx }]（endIdx 含）。
 */
export function paginateBlocks(blocks) {
    const n = blocks.length;
    if (n === 0) return [];
    const widths = blocks.map(blockWidthEm);
    const punct = blocks.map(b => endPunctClass(b && b.text));

    const INF = 1e9;
    const cost = new Array(n + 1).fill(INF);
    const back = new Array(n + 1).fill(-1);
    cost[n] = 0;

    /* cost[i] = 词块 i..n-1 的最优分页代价；从后往前 DP */
    for (let i = n - 1; i >= 0; i--) {
        let w = 0;
        for (let j = i; j < n; j++) {
            w += widths[j];
            const cnt = j - i + 1;
            if (cnt > HARD_MAX_BLOCKS) break;
            /* 单块即超硬限：允许它独占一页（不可拆的语义单元），只加巨额惩罚 */
            const overfull = Math.max(0, w - PAGE_HARD_EM);
            if (overfull > 0 && cnt > 1) break;

            let c = Math.pow(Math.max(0, w - PAGE_TARGET_EM), 2) * 0.22;
            c += overfull * 14;
            /* 断点偏好：页尾落在句末标点最自然，句中标点次之 */
            if (punct[j] === 2) c -= 3.2;
            else if (punct[j] === 1) c -= 1.4;
            else if (j < n - 1) c += 0.8;
            /* 单块页惩罚（短行/结尾残余才允许） */
            if (cnt === 1 && n > 1) c += 1.6;
            /* 情感词块倾向与相邻搭配同页（原 AI 规则4：情感词独立或与最紧搭配同组） */
            if (blocks[j] && blocks[j].isEmotion && cnt >= 2) c -= 0.8;

            const total = c + cost[j + 1];
            if (total < cost[i]) { cost[i] = total; back[i] = j; }
        }
        /* 兜底：单块超宽且无法成页时，允许整行剩余收进一页 */
        if (cost[i] >= INF) { cost[i] = 0; back[i] = n - 1; }
    }

    const pages = [];
    let i = 0;
    while (i < n && pages.length < 64) {
        const j = Math.max(back[i], i);
        pages.push({ startIdx: i, endIdx: j });
        i = j + 1;
    }
    return pages;
}

/** 页内换行位置（词块索引，表示在该块后换行）：宽度约束 + 标点偏好，避免孤字行 */
export function computePageLineBreaks(pageBlocks) {
    const breaks = [];
    const n = pageBlocks.length;
    let w = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
        w += blockWidthEm(pageBlocks[i]);
        cnt++;
        if (i === n - 1) break;
        const pc = endPunctClass(pageBlocks[i].text);
        const nextW = blockWidthEm(pageBlocks[i + 1]);
        const willOverflow = (w + nextW > ROW_MAX_EM);
        if (cnt < SOFT_MIN_BLOCKS) continue;                  /* 行至少 2 块，防孤字 */
        if (pc === 2 && (w >= ROW_MAX_EM * 0.45 || cnt >= 3)) { breaks.push(i); w = 0; cnt = 0; continue; }
        if (willOverflow && cnt >= 2) { breaks.push(i); w = 0; cnt = 0; continue; }
        if (w > ROW_MAX_EM && cnt >= 3) { breaks.push(i); w = 0; cnt = 0; }
    }
    return breaks;
}

/* ==================== 分词与测量数据 ==================== */

/**
 * 与 PVLyricLayout._semanticTokenize 同管线：YRC 逐字（有 words 时）或纯文本分词
 * → sticky 标点合并 → CJK ≥4 字语义段聚合。保证 group_indices 与隧道引擎词块对齐。
 */
function segmentLine(line, lineStartMs, lineEndMs, emotionWords) {
    const text = String(line.original || line.text || '').trim();
    if (!text) return [];
    try {
        let blocks;
        if (Array.isArray(line.words) && line.words.length > 0) {
            blocks = wordSegmenter.segmentYrcWords(text, line.words, lineStartMs, lineEndMs, emotionWords);
        } else {
            blocks = wordSegmenter._segmentFromPlainText(text, lineStartMs, lineEndMs, emotionWords);
        }
        blocks = wordSegmenter.stickyMergeBlocks(blocks || []);
        return wordSegmenter.collapseShortCjkBlocks(blocks, 4);
    } catch (e) {
        logWarn('proceduralLayout', '分词失败，退化为整行单块:', e && e.message);
        return [{
            text, hasSpaceAfter: false, isEmotion: false,
            start: lineStartMs, end: lineEndMs, chars: []
        }];
    }
}

/* ==================== 主入口 ==================== */

/**
 * 生成程序化 line_analyses（替代第二路 LLM 排版请求）
 *
 * @param {Array} lyrics 歌词行数组（state.lyrics 同构：text/original/words/start/end/time）
 * @param {Object} [opts]
 * @param {Array}  [opts.emotionWords]    第一路 AI 情感词（[{word}] 或 string[]），用于锚定分词
 * @param {Array}  [opts.chorusSegments]  副歌/高能段落 [{start,end,energy}]（单位：秒）
 * @param {number} [opts.bpm]             实测 BPM（chorusDetector.rhythm.bpm），调制高能行
 * @returns {{ line_analyses: Array }}    与旧 AI 输出同构，可直接挂 themeObj.line_analyses
 */
export function generateLineAnalyses(lyrics, opts = {}) {
    const out = [];
    if (!Array.isArray(lyrics) || lyrics.length === 0) return { line_analyses: out };

    const emotionWords = (Array.isArray(opts.emotionWords) ? opts.emotionWords : [])
        .map(w => (typeof w === 'string' ? w : (w && w.word) || ''))
        .map(w => w.trim())
        .filter(Boolean);

    const chorus = (Array.isArray(opts.chorusSegments) ? opts.chorusSegments : [])
        .map(s => ({ start: (s.start || 0) * 1000, end: (s.end || 0) * 1000, energy: (typeof s.energy === 'number' ? s.energy : 0.8) }))
        .filter(s => s.end > s.start);
    const bpm = typeof opts.bpm === 'number' && opts.bpm > 30 ? opts.bpm : null;

    /* 全曲种子：构图池轮换的确定性偏移 */
    const songSeed = hashStr(lyrics.map(l => String(l.original || l.text || '')).join('\u241f')) % 100000;

    let lineIdx = -1;
    for (const line of lyrics) {
        const rawText = String(line.original || line.text || '').trim();
        if (!rawText) continue; /* 与 getLyricsTextForAI 的 L 编号同规则：跳过空行 */
        lineIdx++;

        /* 时间归一（毫秒） */
        let lineStartMs = toMs(line.start, toMs(line.time, 0));
        let lineEndMs = toMs(line.end, lineStartMs + 3000);
        if (Array.isArray(line.words) && line.words.length > 0) {
            lineStartMs = line.words[0].start || lineStartMs;
            lineEndMs = line.words[line.words.length - 1].end || lineEndMs;
        }
        const lineDurMs = Math.max(lineEndMs - lineStartMs, 600);

        /* 1. 文字分段测量数据 */
        const blocks = segmentLine(line, lineStartMs, lineEndMs, emotionWords);
        if (blocks.length === 0) continue;

        /* 2. 行级情绪基线（词典投票，逐块累积）+ 副歌/时长/BPM 能量 */
        let lineEmotion = 'neutral';
        for (const b of blocks) {
            lineEmotion = voteEmotion(b.text, lineEmotion);
        }
        const midMs = lineStartMs + lineDurMs / 2;
        const chorusHit = chorus.find(s => midMs >= s.start && midMs <= s.end);
        const exclam = (rawText.match(/[！!?？…]/g) || []).length;
        let energy = 0.4;
        if (chorusHit) energy += 0.24 + 0.1 * chorusHit.energy;
        if (lineDurMs > 3000) energy += 0.08;
        if (exclam > 0) energy += Math.min(0.1, exclam * 0.04);
        if (bpm && bpm >= 118 && chorusHit) energy += 0.05;
        energy = Math.max(0.05, Math.min(0.98, Math.round(energy * 100) / 100));

        /* 3. 二维搜索分页 */
        const pages = paginateBlocks(blocks);

        /* 4. 行内对齐：情绪映射 + 行内所有页保持一致（原 AI 规则5：避免同句页间跳变） */
        let alignment = EMOTION_STYLE[lineEmotion].alignment;
        if (lineEmotion === 'neutral') {
            const rot = ['center', 'left', 'center', 'right'];
            alignment = rot[(songSeed + lineIdx) % rot.length];
        }

        pages.forEach((page, pIdx) => {
            const pageBlocks = blocks.slice(page.startIdx, page.endIdx + 1);
            const pageText = pageBlocks.map(b => (b.hasSpaceAfter ? `${b.text} ` : b.text)).join('').trim();

            /* 页级情绪：词典对页内文本重投票，无票沿用行级 */
            const pageEmotion = voteEmotion(pageText, lineEmotion);

            /* keywords：页内情感词优先，其次最长 CJK 块，≤2 个 */
            const keywords = [];
            for (const b of pageBlocks) {
                if (b.isEmotion && !keywords.includes(b.text)) keywords.push(b.text);
            }
            if (keywords.length < 2) {
                const byLen = pageBlocks
                    .filter(b => !keywords.includes(b.text))
                    .sort((a, b2) => measureTextEm(b2.text) - measureTextEm(a.text));
                for (const b of byLen) {
                    if (keywords.length >= 2) break;
                    if (!keywords.includes(b.text) && Array.from(b.text).length >= 2) keywords.push(b.text);
                }
            }

            const style = EMOTION_STYLE[pageEmotion] || EMOTION_STYLE.neutral;
            out.push({
                line_index: lineIdx,
                page_index: pIdx,
                emotion: pageEmotion,
                energy,
                keywords,
                group_indices: pageBlocks.map((_, k) => page.startIdx + k),
                alignment,
                line_breaks: computePageLineBreaks(pageBlocks),
                bg_theme: {
                    palette: style.palette.slice(),
                    composition: COMPOSITION_POOL[(songSeed + lineIdx * 7 + pIdx * 5) % COMPOSITION_POOL.length]
                }
            });
        });
    }

    logInfo('proceduralLayout', `程序化排版完成: ${lineIdx + 1} 行 → ${out.length} 页（词典投票 + 宽度 DP，无网络请求）`);
    return { line_analyses: out };
}

/* 全局出口（浏览器控制台调试用；node 单测走 import） */
if (typeof window !== 'undefined') {
    window.ProceduralLayout = { generateLineAnalyses, measureTextEm, voteEmotion, paginateBlocks };
}
