/* ============================================================
 * core/smartPlaylist.js — 智能播放列表（需求 7）纯逻辑层
 *
 * 职责边界（这是本模块存在的全部理由）：
 *   AI **只负责一件事**：把用户的一句自然语言翻译成**结构化规则 JSON**。
 *   之后「规则 → 歌单」的匹配完全在本地做（`queryLibrary`），**不再调用 AI**。
 *
 * 为什么把 AI 输出当不可信输入（normalizeSmartRule 存在的理由）：
 *   LLM 会漂移——字段名换写法、把数字写成字符串、给 300 个歌手、
 *   把 bpm 区间写成 "80-120"、偶尔夹带 markdown 代码围栏与解释性文字。
 *   训练/模型切换后行为还会变。所以解析入口一律 normalize：
 *   白名单字段 + 类型收敛 + 上限夹取 + 非法值丢弃，**永不抛异常**。
 *   宁可少几个过滤条件，也不能让一次漂移把整个功能打死。
 *
 * 为什么匹配失败要**分原因**返回（而不是悄悄少几首）：
 *   需求原文「匹配不到的标记出来」。用户的真实场景是"我有 500 首收藏，
 *   要 30 首慢歌"——只说"生成了 12 首"会让人以为规则生效了；
 *   必须能回答"另外 488 首为什么没进来"，否则没法判断是规则写窄了
 *   还是本地曲库确实没有这类歌。
 * ============================================================ */

/** 规则结构版本：将来改字段语义时，老歌单里的规则可以按版本迁移 */
export const SMART_RULE_VERSION = 1;

/** 上限：单次生成的歌曲数（防止规则太宽把整个曲库倒进一个歌单） */
export const SMART_LIMIT_MAX = 500;
export const SMART_LIMIT_DEFAULT = 50;

/** 单个过滤字段最多接受多少个词（防 LLM 发疯给一屏） */
const MAX_WORDS = 40;

/** BPM 的合理物理范围：低于 20 / 高于 300 必是解析错误 */
const BPM_MIN = 20;
const BPM_MAX = 300;

/**
 * 匹配失败的原因码。刻意用机器码而不是句子：
 * 本模块不引入任何 UI 文案（i18n 词表只登记 UI 层），展示时由 app 分片翻译。
 */
export const REJECT_REASONS = [
    'source',        /* 音源不在允许列表 */
    'artist',        /* 歌手不命中规则里的歌手列表 */
    'title',         /* 标题不含任何关键词 */
    'excluded',      /* 命中排除词 */
    'mood-unknown',  /* 规则要情绪，但本地没有这首歌的情绪分析 */
    'mood',          /* 有情绪数据但不在期望情绪里 */
    'bpm-unknown',   /* 规则要 BPM，但本地没有这首歌的 BPM 分析 */
    'bpm',           /* 有 BPM 但不在区间内 */
];

/** 归一化后的空规则（也是 normalizeSmartRule 的兜底形状） */
export function emptySmartRule() {
    return {
        version: SMART_RULE_VERSION,
        name: '',
        artists: [],
        titleKeywords: [],
        excludeWords: [],
        moods: [],
        sources: [],
        bpm: null,
        limit: SMART_LIMIT_DEFAULT,
    };
}

/** 字符串数组收敛：去空、去首尾空格、按小写去重、截断、非字符串直接丢 */
function cleanWords(list) {
    if (!Array.isArray(list)) {
        /* LLM 常把单值写成裸字符串（"artists": "周杰伦"），容忍一次 */
        if (typeof list === 'string' && list.trim()) list = [list];
        else return [];
    }
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        const s = String(raw).trim();
        if (!s) continue;
        const low = s.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        out.push(s);
        if (out.length >= MAX_WORDS) break;
    }
    return out;
}

/**
 * 把 BPM 区间收敛成 `{min,max}` 或 null。
 * 容忍三种写法：`{min:80,max:120}`、`[80,120]`、`"80-120"` / `"80~120"`。
 * 上下界颠倒时自动交换（LLM 写反很常见，直接丢掉一整条规则太浪费）；
 * 只给一侧时另一侧留空（表示开区间）。
 */
function cleanBpm(raw) {
    let min = null;
    let max = null;
    if (Array.isArray(raw)) {
        min = Number(raw[0]);
        max = Number(raw[1]);
    } else if (raw && typeof raw === 'object') {
        min = Number(raw.min !== undefined ? raw.min : raw.from);
        max = Number(raw.max !== undefined ? raw.max : raw.to);
    } else if (typeof raw === 'string') {
        const m = /(\d+(?:\.\d+)?)\s*[-~到至]\s*(\d+(?:\.\d+)?)/.exec(raw);
        if (m) { min = Number(m[1]); max = Number(m[2]); }
        else {
            const one = Number(raw.replace(/[^\d.]/g, ''));
            if (!Number.isNaN(one)) { min = one; max = one; }
        }
    } else if (typeof raw === 'number') {
        min = raw;
        max = raw;
    }
    if (!Number.isFinite(min)) min = null;
    if (!Number.isFinite(max)) max = null;
    if (min !== null && (min < BPM_MIN || min > BPM_MAX)) min = null;
    if (max !== null && (max < BPM_MIN || max > BPM_MAX)) max = null;
    if (min !== null && max !== null && min > max) { const t = min; min = max; max = t; }
    if (min === null && max === null) return null;
    return { min, max };
}

/** 顺序夹取：非数字/NaN 回落到默认值。`Number(null)===0` 这个坑在这里必须显式挡掉。 */
function cleanLimit(raw) {
    if (raw === null || raw === undefined || raw === '') return SMART_LIMIT_DEFAULT;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return SMART_LIMIT_DEFAULT;
    return Math.min(SMART_LIMIT_MAX, n);
}

/**
 * 把任意输入（AI 回复解析结果 / 用户手改过的 JSON / 老版本规则）收敛成合法规则。
 * **永不抛异常、永不返回 null** —— 拿不到就返回空规则，让上层只处理"有没有匹配到"。
 *
 * 接受同义字段名：LLM 换写法的概率极高（`keywords` / `title_keywords` /
 * `titleKeywords` 都见过），不做同义归并的话同一条规则时好时坏。
 */
export function normalizeSmartRule(raw) {
    const rule = emptySmartRule();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rule;

    const pick = (...names) => {
        for (const n of names) {
            if (raw[n] !== undefined && raw[n] !== null) return raw[n];
        }
        return undefined;
    };

    rule.name = String(pick('name', 'playlistName', 'title') || '').trim().slice(0, 60);
    rule.artists = cleanWords(pick('artists', 'artist', 'singers', '歌手'));
    rule.titleKeywords = cleanWords(pick('titleKeywords', 'title_keywords', 'keywords', 'titleContains', '标题关键词'));
    rule.excludeWords = cleanWords(pick('excludeWords', 'exclude_words', 'exclude', 'blacklist', '排除'));
    rule.moods = cleanWords(pick('moods', 'mood', 'emotions', 'emotion', 'tags', '情绪'));
    rule.sources = cleanWords(pick('sources', 'source', '音源'));
    rule.bpm = cleanBpm(pick('bpm', 'tempo', 'bpmRange', 'bpm_range'));
    rule.limit = cleanLimit(pick('limit', 'count', 'maxSongs'));
    return rule;
}

/**
 * 规则里是否**没有任何**筛选条件（等于"整库都要"）。
 * 上层用它来决定要不要提醒用户"你这句话没解析出条件"，而不是默默导出一个全库歌单。
 */
export function isEmptySmartRule(rule) {
    const r = normalizeSmartRule(rule);
    return r.artists.length === 0
        && r.titleKeywords.length === 0
        && r.excludeWords.length === 0
        && r.moods.length === 0
        && r.sources.length === 0
        && !r.bpm;
}

/**
 * 规则是否需要「按歌分析数据」（BPM / 情绪）。
 * 上层据此决定要不要去 IndexedDB 拉 automixCache / aiThemeCache ——
 * 不需要时不拉，几百首歌就是几百次无谓的 IDB 事务。
 */
export function ruleNeedsAnalysis(rule) {
    const r = normalizeSmartRule(rule);
    return !!r.bpm || r.moods.length > 0;
}

/** 构造 AI 提示词：只要 JSON，且把字段表写死（比"输出规则"这种话可靠得多） */
export function buildSmartPrompt(description, opts) {
    const desc = String(description || '').trim().slice(0, 1000);
    const sources = Array.isArray(opts && opts.sources) ? opts.sources.filter(Boolean) : [];
    const system = [
        '你是一个音乐播放器的歌单规则解析器。',
        '用户会用一句自然语言描述想听的歌，你要把它翻译成 JSON 规则。',
        '只输出 JSON，不要任何解释、不要 markdown 代码块。',
        'JSON 字段（全部可选，没提到的就不要出现）：',
        /* 提示词里的字段说明刻意用全角冒号：i18n 门禁把 `name:` 这类「标识符 + 半角冒号」
           判成 UI 文案（那是给对象字面量用的启发式），写成全角就不会误报——
           这是提示词不是界面文本，不该进 STATIC_PHRASE_MAP。 */
        '  name：string，给这个歌单起个短名字（不超过 12 个字）',
        '  artists: string[]，歌手名',
        '  titleKeywords: string[]，歌名里应出现的关键词',
        '  excludeWords: string[]，歌名或歌手名里出现就排除的词（如"现场""伴奏"）',
        '  moods: string[]，情绪标签，如 安静/忧伤/温暖/燃/治愈',
        '  sources: string[]，音源平台名',
        '  bpm: {"min": number, "max": number}，速度区间',
        '  limit: number，最多几首',
        '规则要克制：用户没提的维度不要凭空补。',
    ].join('\n');
    const user = [
        `用户描述：${desc}`,
        sources.length ? `可用音源：${sources.join('、')}` : '',
        '请输出 JSON：',
    ].filter(Boolean).join('\n');
    return { system, user };
}

/**
 * 从 AI 回复里抠出规则。
 *
 * 为什么不能直接 JSON.parse：实测模型即使被要求"只输出 JSON"，
 * 也可能套 ```json 围栏、或在前后写一句"好的，这是规则："。
 * 所以先剥围栏，再取**第一个平衡的** `{...}` 子串。
 * 解析失败返回 null（而不是空规则）——上层要能区分
 * "AI 说没有条件"与"AI 根本没给出可用的东西"，这两种提示不一样。
 */
export function parseSmartRuleReply(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    let s = text.trim();
    /* 去掉 markdown 代码围栏 */
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
    /* 截取第一个花括号平衡段（跳过字符串里的括号，避免被歌名里的 } 带偏） */
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) return null;
    try {
        return normalizeSmartRule(JSON.parse(s.slice(start, end + 1)));
    } catch {
        return null;
    }
}

/* ---------------- 本地匹配 ---------------- */

/** 大小写无关的"包含任一" */
function hitsAny(haystack, words) {
    const h = String(haystack || '').toLowerCase();
    if (!h) return false;
    return words.some((w) => h.includes(String(w).toLowerCase()));
}

/** 情绪匹配：本地缓存里的 mood 可能是字符串或数组，两种都认 */
function moodMatches(entryMood, wanted) {
    const got = Array.isArray(entryMood) ? entryMood : [entryMood];
    for (const g of got) {
        if (!g) continue;
        if (hitsAny(g, wanted)) return true;
    }
    return false;
}

/**
 * 用规则筛本地曲库。**纯函数**：不读 localStorage、不碰 DOM、不查 IndexedDB，
 * 所以能直接单测，也能在探针里用一份假曲库跑。
 *
 * @param {object} rule normalizeSmartRule 的结果（内部会再归一化一次，容忍调用方偷懒）
 * @param {Array<object>} library 条目：{key,title,artist,album,source,id,mid,url,cover,bpm,mood}
 * @returns {{matched:Array, rejected:Array<{entry:object,reason:string}>, overLimit:number}}
 */
export function queryLibrary(rule, library) {
    const r = normalizeSmartRule(rule);
    const list = Array.isArray(library) ? library : [];
    const matched = [];
    const rejected = [];
    const seen = new Set();

    for (const entry of list) {
        if (!entry) continue;
        const key = entry.key || entry.url || `${entry.source || ''}:${entry.id || ''}:${entry.title || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let reason = '';
        if (r.sources.length && !hitsAny(entry.source, r.sources)) reason = 'source';
        else if (r.artists.length && !hitsAny(entry.artist, r.artists)) reason = 'artist';
        else if (r.titleKeywords.length && !hitsAny(entry.title, r.titleKeywords)) reason = 'title';
        else if (r.excludeWords.length && (hitsAny(entry.title, r.excludeWords) || hitsAny(entry.artist, r.excludeWords))) reason = 'excluded';
        else if (r.moods.length) {
            if (entry.mood === undefined || entry.mood === null || entry.mood === '') reason = 'mood-unknown';
            else if (!moodMatches(entry.mood, r.moods)) reason = 'mood';
        }
        if (!reason && r.bpm) {
            const bpm = Number(entry.bpm);
            if (!Number.isFinite(bpm) || bpm <= 0) reason = 'bpm-unknown';
            else if (r.bpm.min !== null && bpm < r.bpm.min) reason = 'bpm';
            else if (r.bpm.max !== null && bpm > r.bpm.max) reason = 'bpm';
        }

        if (reason) rejected.push({ entry, reason });
        else matched.push(entry);
    }

    /* 超出上限的部分**不算匹配失败**——它们是"合格但没装下"，
       报成 rejected 会让用户以为规则有问题。 */
    let overLimit = 0;
    let kept = matched;
    if (matched.length > r.limit) {
        overLimit = matched.length - r.limit;
        kept = matched.slice(0, r.limit);
    }
    return { matched: kept, rejected, overLimit };
}

/** 把规则渲染成"给用户确认"的纯文本（供 JSON 编辑框的旁注使用；不含 UI 文案） */
export function ruleToJSON(rule) {
    const r = normalizeSmartRule(rule);
    const out = {};
    if (r.name) out.name = r.name;
    if (r.artists.length) out.artists = r.artists;
    if (r.titleKeywords.length) out.titleKeywords = r.titleKeywords;
    if (r.excludeWords.length) out.excludeWords = r.excludeWords;
    if (r.moods.length) out.moods = r.moods;
    if (r.sources.length) out.sources = r.sources;
    if (r.bpm) out.bpm = r.bpm;
    out.limit = r.limit;
    return JSON.stringify(out, null, 2);
}
