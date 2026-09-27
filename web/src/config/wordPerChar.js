/* ============================================================
 * config/wordPerChar.js — 「行级歌词要不要按逐字显示」的判定（纯函数）
 *
 * 两个开关的关系是用户定的（todos #12）：
 *   开关1 perCharFromLineLyrics —— 只有行级时间戳的歌词要不要摊平成逐字；
 *   开关2 autoUpgradeWordLyrics —— 去别的音源找 >90% 匹配的真逐字来替换。
 * ★ 开 2 自动禁用 1：既然要去拿**真**节拍，就不该同时给用户看**编**的节拍。
 *   这条不是 UI 层的联动装饰，而是判定函数里的优先级——
 *   写在 UI 上会被绕过（快捷键/导入配置/远端改设置都不经过 UI）。
 *
 * 单独成文件而不是塞进 20-lyrics-render.js：那个分片是逐帧热路径的宿主，
 * 而且判定逻辑要能脱离 DOM 单测。
 * ============================================================ */

/** 开关1 的作用范围。用户明确只点名这三个模式。
 *  PV / 隧道 / 霓虹 / 活字 / 全景 / 飞入 这些视觉模式自己接管歌词绘制，
 *  逐字与否不归这个开关管（它们中有不少根本不用行内 fill 进度）。 */
export const PER_CHAR_MODES = new Set(['lyrics', 'cover', 'wordcloud']);

/** 开关2 的**主判据**：当前这份歌词里要有 90% 以上的行能在候选里找到对应行，
 *  才敢把候选的节拍整份贴上来。用「覆盖率」而不是「两份行数是否一样多」，
 *  因为各平台分行习惯本来就不同（实测同一首歌按行数比只有 67%，覆盖率却是够的）。 */
export const WORD_UPGRADE_MIN_COVERAGE = 0.9;

/** 副判据：候选与当前的行数差不能太离谱（matched / 两份较大行数）。
 *  挡的是「当前只有 4 行、候选是整张专辑精选」这种覆盖率满分但明显不对的情况。 */
export const WORD_UPGRADE_MIN_MATCH_RATE = 0.6;

/** 少于这么多行就不自动换：样本太小，任何判据都不可信 */
export const WORD_UPGRADE_MIN_LINES = 5;

/**
 * 现在该不该给行级歌词合成逐字时间？
 * @param {Object} settings appSettings（缺字段按默认值处理）
 * @param {string} mode     当前视图模式（currentViewMode）
 */
export function perCharSynthesisWanted(settings, mode) {
    const l = (settings && settings.lyrics) || {};
    if (l.autoUpgradeWordLyrics === true) return false;
    /* 默认开：老用户的 appSettings 里没这个键时，行为与约束 17 落地后完全一致 */
    if (l.perCharFromLineLyrics === false) return false;
    return PER_CHAR_MODES.has(String(mode || ''));
}

/** 开关2 是否生效（给渲染层与升级服务共用，避免两处各判一遍） */
export function wordUpgradeWanted(settings) {
    return !!((settings && settings.lyrics) || {}).autoUpgradeWordLyrics;
}

/** 候选源 → 本机自建 vendor 的平台键。没有自建服务的源（酷我/amll/lrclib）不在表里。
 *  注意 QQ 的两套命名：歌词源叫 'tencent'，自建服务叫 'qq'（AGENTS.md 约束 19 的同一张别名表）。 */
export const WORD_SOURCE_VENDOR = { kugou: 'kugou', tencent: 'qq', netease: 'netease' };

/**
 * 候选源排序：**本机已登录的自建 vendor 优先**，其余保持原顺序。
 *
 * 为什么不是写死「酷狗第一」：用户实测指出「其实优先应该是 vendor 登录了的，
 * 不一定是酷狗，QQ 的歌词也很优质」。自建副进程是毫秒级回包且不受公网上游失联影响
 * （AGENTS.md「全链路数据通道优先级」同一条理由），所以谁在线谁先试；
 * 公网源排在后面，只在没有自建可用时才轮到。
 *
 * @param {string[]} candidates 原始优先序
 * @param {(platform:string)=>boolean} isEnabled 该 vendor 是否可用（自建开关 + 登录）
 */
export function orderWordCandidateSources(candidates, isEnabled) {
    const rank = (src) => (WORD_SOURCE_VENDOR[src] && isEnabled(WORD_SOURCE_VENDOR[src]) ? 0 : 1);
    return (candidates || [])
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (rank(a.s) - rank(b.s)) || (a.i - b.i))
        .map(x => x.s);
}
