/* ============================================================
 * jizuraPreset.js — 「AI 推荐」：按 AI 情绪分析结果挑一套版式风格 + 心情标签
 *                    （纯逻辑，无 DOM，可单测）
 *
 * 背景（2026-10-11 用户："加上 ai 分析的时候顺便选择一个合适的模式预设，
 *   不要一直让用户手动调预设和心情 —— 选一个"）。
 *
 * 为什么推荐**具体风格 id**，而不是沿用现成的「自动匹配」（`style:'auto'`，引擎抽签）：
 *   - 用户要的是"选一个"：具体风格可见、确定、可复现（同歌同结果）；
 *   - 引擎抽签保留在 'auto' 档，两档语义分明：
 *       'auto' = 引擎按歌词抽一套（J.omakase）；'ai' = 按 AI 分析结果选一套；其它 = 用户手选。
 *   - **没有分析结果时 'ai' 回落 'auto'**：所以默认档换成 'ai' 不会让任何人看到空白/异常。
 *
 * 决策顺序（前者命中即返回；全程**确定性**，不用随机数 —— 否则同一首歌每次
 * plan 重建（改字号、切画幅）都会换风格，那不是推荐，是抽风）：
 *   ① 情绪关键词（zh/ja/en，来自 AI 的 mood / description / animation_style / pv_theme.preset）
 *   ② AI 的 animation_style（glitch / breathing / floating / smooth / flyin）
 *   ③ 主配色启发式（色相 / 饱和度 / 明度）
 *   ④ 兜底 = 引擎风格表的第一套（上游 J.STYLE_ORDER[0]）
 * 候选里的 id 一律用调用方给的 `styleIds`（引擎的 J.STYLE_ORDER）**过滤**，
 * 引擎里不存在的 id 直接跳过，避免"推荐出一个不存在的风格"。
 * ============================================================ */

/** 引擎的心情标签（08b_omakase.js 的 J.MOODS 键；面板「情绪倾向」的 8 项） */
export const JIZURA_MOOD_IDS = ['calm', 'pop', 'graphic', 'editorial', 'emotional', 'glitch', 'horror', 'chaos'];

/**
 * 关键词 → 候选风格 + 心情标签。
 * 顺序即优先级：把「最不该认错」的放前面（恐怖、故障、和风这类一旦判错观感差得最明显）。
 */
export const JIZURA_PRESET_RULES = [
    {
        mood: 'horror',
        styles: ['hrRuin', 'hrNightRec', 'hrCurse', 'noir', 'mono'],
        words: ['恐怖', '惊悚', '诡异', '阴森', '黑暗', '绝望', '死亡', '诅咒', '噩梦', 'horror', 'creepy', 'eerie', 'dread', 'nightmare'],
    },
    {
        mood: 'glitch',
        styles: ['synth80', 'acid', 'hud', 'blueprint', 'transit'],
        words: ['赛博', '电子', '故障', '科技', '机械', '未来', '朋克', '数据', 'cyber', 'glitch', 'neon', 'electric', 'techno', 'digital', 'machine'],
    },
    {
        mood: 'calm',
        styles: ['sumi', 'paper', 'newsprint', 'sakura', 'mono'],
        words: ['和风', '古风', '传统', '日式', '禅', '静谧', '平静', '温柔', '安静', '怀石', 'wa', 'sumi', 'zen', 'calm', 'gentle', 'quiet', 'traditional'],
    },
    {
        mood: 'emotional',
        styles: ['rouge', 'sakura', 'ocean', 'sumi', 'gold'],
        words: ['悲伤', '忧郁', '失落', '孤独', '思念', '离别', '遗憾', '眼泪', '心碎', 'sad', 'melancholy', 'lonely', 'sorrow', 'tear', 'blue', 'nostalgic'],
    },
    {
        mood: 'pop',
        styles: ['candy', 'magenta', 'sunset', 'crimson', 'gold'],
        words: ['甜', '可爱', '欢快', '恋爱', '心动', '青春', '夏日', '明亮', 'love', 'sweet', 'cute', 'happy', 'summer', 'kawaii', 'bright'],
    },
    {
        mood: 'chaos',
        styles: ['crimson', 'caution', 'sunset', 'magenta', 'acid'],
        words: ['热烈', '激情', '燃烧', '摇滚', '爆发', '狂', '愤怒', 'energetic', 'rock', 'passion', 'fire', 'wild', 'angry', 'intense'],
    },
    {
        mood: 'calm',
        styles: ['forest', 'mint', 'paper', 'kraft'],
        words: ['清新', '治愈', '自然', '森林', '海风', '绿', 'healing', 'nature', 'forest', 'green', 'fresh', 'sea'],
    },
    {
        mood: 'editorial',
        styles: ['vapor', 'ocean', 'gold', 'specimen'],
        words: ['梦幻', '空灵', '星空', '宇宙', '漂浮', '梦境', 'dream', 'ethereal', 'star', 'cosmic', 'float', 'ambient'],
    },
    {
        mood: 'editorial',
        styles: ['kraft', 'newsprint', 'specimen', 'transit', 'paper'],
        words: ['复古', '怀旧', '旧日', '年代', '胶片', 'retro', 'vintage', 'nostalgia', 'film', 'old'],
    },
    {
        mood: 'graphic',
        styles: ['specimen', 'gold', 'rouge', 'mono'],
        words: ['优雅', '华丽', '精致', '高级', '古典', 'elegant', 'luxury', 'graceful', 'classic', 'gold'],
    },
    {
        mood: 'graphic',
        styles: ['blueprint', 'hud', 'mono', 'magenta'],
        words: ['几何', '极简', '冷峻', '秩序', '工业', '都市', 'minimal', 'geometric', 'industrial', 'urban', 'cold'],
    },
];

/** AI 的 animation_style → 候选风格 + 心情标签（关键词没命中时的第二判据） */
export const JIZURA_MOTION_STYLE_RULES = {
    glitch: { mood: 'glitch', styles: ['synth80', 'acid', 'hud', 'transit'] },
    breathing: { mood: 'calm', styles: ['sumi', 'paper', 'mono', 'noir'] },
    floating: { mood: 'editorial', styles: ['vapor', 'ocean', 'gold', 'paper'] },
    smooth: { mood: 'graphic', styles: ['blueprint', 'mono', 'newsprint', 'noir'] },
    flyin: { mood: 'pop', styles: ['candy', 'magenta', 'sunset', 'crimson'] },
};

/** '#RRGGBB' → {h:0-360, s:0-1, l:0-1}；非法输入返回 null */
export function hexToHsl(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    let body = m[1];
    if (body.length === 3) body = body.split('').map(c => c + c).join('');
    const n = parseInt(body, 16);
    const r = ((n >> 16) & 0xff) / 255;
    const g = ((n >> 8) & 0xff) / 255;
    const b = (n & 0xff) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s, l };
}

/** 配色启发式（第三判据）：优先级＝明度 → 饱和度 → 色相 */
export const JIZURA_PALETTE_PICKS = [
    { test: (c) => c.l < 0.16, mood: 'graphic', styles: ['noir', 'mono', 'hrNightRec'] },
    { test: (c) => c.s < 0.12, mood: 'graphic', styles: ['mono', 'newsprint', 'kraft', 'sumi'] },
    { test: (c) => c.h >= 330 || c.h < 20, mood: 'emotional', styles: ['rouge', 'crimson', 'caution', 'hrRuin'] },
    { test: (c) => c.h >= 20 && c.h < 55, mood: 'pop', styles: ['sunset', 'gold', 'kraft'] },
    { test: (c) => c.h >= 55 && c.h < 95, mood: 'pop', styles: ['gold', 'acid', 'candy'] },
    { test: (c) => c.h >= 95 && c.h < 170, mood: 'calm', styles: ['forest', 'mint', 'paper'] },
    { test: (c) => c.h >= 170 && c.h < 215, mood: 'calm', styles: ['ocean', 'blueprint', 'mint'] },
    { test: (c) => c.h >= 215 && c.h < 270, mood: 'editorial', styles: ['blueprint', 'synth80', 'hud'] },
    { test: (c) => c.h >= 270 && c.h < 330, mood: 'editorial', styles: ['magenta', 'vapor', 'specimen'] },
];

/**
 * AI 分析结果 → 推荐的一套风格 + 心情标签。
 * @param {object} aiData AI 主题对象（`VisualizerBase.setLyrics(lines, aiData)` 灌进来的那个：
 *   含 `mood` / `description` / `animation_style` / `primary_color` / `secondary_color` / `pv_theme`）
 * @param {string[]} styleIds 引擎里真实存在的风格 id（`J.STYLE_ORDER`）；用它过滤候选
 * @returns {{style:string|null, mood:string|null, reason:'keyword'|'animationStyle'|'palette'|'default'}}
 */
export function recommendJizuraPreset(aiData, styleIds) {
    const styles = Array.isArray(styleIds) ? styleIds.filter(id => typeof id === 'string' && id) : [];
    const pick = (candidates) => candidates.find(id => styles.includes(id)) || null;
    const t = (aiData && typeof aiData === 'object') ? aiData : {};
    const pv = (t.pv_theme && typeof t.pv_theme === 'object') ? t.pv_theme : {};

    /* ① 关键词。
       ★ 刻意**不**把 `animation_style` 混进来：它的取值集合（glitch/breathing/…）与心情标签
       高度重叠，混进来会让第 ② 判据永远轮不到（reason 也就分不清"词里写了故障"还是
       "AI 推荐了故障动效）——分开判，两者各司其职。 */
    const haystack = [t.mood, t.description, pv.preset]
        .filter(v => typeof v === 'string' && v)
        .join(' ')
        .toLowerCase();
    if (haystack) {
        for (const rule of JIZURA_PRESET_RULES) {
            if (rule.words.some(w => haystack.includes(w))) {
                const style = pick(rule.styles);
                if (style) return { style, mood: rule.mood, reason: 'keyword' };
            }
        }
    }

    /* ② animation_style */
    const motion = typeof t.animation_style === 'string' ? t.animation_style.trim().toLowerCase() : '';
    if (motion && JIZURA_MOTION_STYLE_RULES[motion]) {
        const rule = JIZURA_MOTION_STYLE_RULES[motion];
        const style = pick(rule.styles);
        if (style) return { style, mood: rule.mood, reason: 'animationStyle' };
    }

    /* ③ 配色（主色优先，拿不到就用辅色） */
    const hsl = hexToHsl(t.primary_color) || hexToHsl(t.secondary_color);
    if (hsl) {
        for (const rule of JIZURA_PALETTE_PICKS) {
            if (!rule.test(hsl)) continue;
            const style = pick(rule.styles);
            if (style) return { style, mood: rule.mood, reason: 'palette' };
        }
    }

    /* ④ 兜底：引擎风格表的第一套（上游 STYLE_ORDER[0]），不带心情约束 */
    return { style: styles[0] || null, mood: null, reason: 'default' };
}

/**
 * 推荐结果的**指纹**（供 plan 重建判断）：
 * 只取参与推荐的字段，AI 分析异步到达/换歌时才变，其余无关设置改动不会误触发重建。
 */
export function jizuraPresetSignature(aiData) {
    const t = (aiData && typeof aiData === 'object') ? aiData : {};
    return [t.mood || '', t.animation_style || '', t.primary_color || '', t.secondary_color || ''].join('|');
}
