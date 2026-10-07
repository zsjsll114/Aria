/* ============================================================
 * 293-word-upgrade.js — 行级歌词自动升级成真逐字（todos #12 开关2）
 *
 * 当前歌词只有行级时间戳、且用户开了 autoUpgradeWordLyrics 时：
 * 去其它音源找一份**文本对得上**的逐字歌词，找到就整份换掉。
 *
 * ★ 为什么放在这里而不是各歌词加载点：和约束 17（逐字兜底）、约束 18（频谱对齐）
 *   同一个理由——renderLyrics 是 23 个调用点的唯一咽喉，接在这里一次覆盖全部来源。
 * ★ 为什么不直接复用 probeLyricSourcesAvailability 的结果：那个函数是给
 *   「选择歌词来源」弹窗用的，返回的 isWord 只说"有没有逐字"，不说"是不是这首歌"。
 *   自动替换必须过 lyricMatchRate 这道文本核对，否则会把另一首歌的节拍贴过来——
 *   那比没有逐字糟得多。
 * ============================================================ */
import { hasRealWordTiming, lyricMatchRate } from '../parsers/lyricMatch.js';
import { WORD_UPGRADE_MIN_COVERAGE, WORD_UPGRADE_MIN_LINES, WORD_UPGRADE_MIN_MATCH_RATE, orderWordCandidateSources, wordUpgradeWanted } from '../config/wordPerChar.js';
import { selfhostEnabled } from './selfhost-runtime.js';
import { logCatch, logInfo } from '../services/log.js';

const TAG = 'wordUpgrade';
/* 优先序的**基线**，不是最终顺序：真正试之前会按「本机自建 vendor 是否可用」重排
   （见 pickWordSource 里的 orderWordCandidateSources）。酷狗 KRC 仍是并列首选，
   但没登录酷狗而登录了 QQ 时，QQ 就该排在它前面——用户实测指出这点。 */
const CANDIDATE_SOURCES = ['kugou', 'tencent', 'netease', 'kuwo', 'amll', 'lrclib'];
/* 等歌词区稳定再动手：切歌瞬间还在渲染，此时换整份歌词会看见闪跳 */
const UPGRADE_DELAY_MS = 2500;
/* 每首歌只试一次。没有这个集合就是死循环：
   替换 → renderLyrics → 又触发升级 → 又替换（约束 18 的 _alignTried 同一个教训） */
const TRIED_CAP = 200;
const _tried = new Set();
/* 按标题记一份已排期的歌：songKey 里的 id/source 在 boot 恢复/取链补全时会漂移，
   标题不会（见 maybeUpgradeToWordLyrics 内的同标题去重注释） */
const _triedByTitle = new Set();
/* 已排期但还没开跑的歌（防同一次渲染里叠多个定时器；也是「放弃时不要烧掉重试机会」的凭据） */
let _scheduledKey = null;
let _running = false;

/* ★ 抓词/应用两个能力由 170 注入，而不是本分片 import 170。
   20-lyrics-render → 293 → 170 → 20 会成环（ESM 能跑但求值顺序有坑），
   而且 293 作为"策略"层本就不该反向依赖具体分片。
   刻意不用 globalThis.__xxx 挂钩：那是往约束 11 禁止的方向加键。 */
let _fetchSource = null;
let _applySource = null;

export function bindSourceAccessors(fetchFn, applyFn) {
    _fetchSource = typeof fetchFn === 'function' ? fetchFn : null;
    _applySource = typeof applyFn === 'function' ? applyFn : null;
}

function songKey() {
    const csd = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    return `${csd.source || ''}:${csd.id || csd.mid || csd.title || ''}`;
}

function remember(key) {
    if (_tried.size >= TRIED_CAP) _tried.clear();
    _tried.add(key);
}

/** 挑第一个「有真逐字 且 文本匹配率 ≥90%」的来源 */
async function pickWordSource(currentLines) {
    if (!_fetchSource || !_applySource) return null;
    const override = (typeof globalThis !== 'undefined' && globalThis.lyricSourceOverride) || null;
    const ordered = orderWordCandidateSources(CANDIDATE_SOURCES, (platform) => {
        try {
            return selfhostEnabled(platform);
        } catch (e) {
            logCatch(TAG, e);
            return false;      // 读不到自建状态就当不可用，退回基线顺序
        }
    });
    logInfo(TAG, `[WordUpgrade] 候选顺序：${ordered.join(' → ')}`);
    for (const src of ordered) {
        if (src === override) continue;
        let parts;
        try {
            parts = await _fetchSource(src);
        } catch (e) {
            logCatch(TAG, e);
            continue;                       /* 这个源挂了继续下一个，不影响当前播放 */
        }
        const originals = (parts && parts.originals) || [];
        if (!originals.length || !hasRealWordTiming(originals)) continue;
        const { rate, coverage, matched, total } = lyricMatchRate(currentLines, originals);
        if (currentLines.length < WORD_UPGRADE_MIN_LINES) {
            logInfo(TAG, `[WordUpgrade] 当前歌词只有 ${currentLines.length} 行，样本太小不自动换`);
            return null;
        }
        if (coverage < WORD_UPGRADE_MIN_COVERAGE || rate < WORD_UPGRADE_MIN_MATCH_RATE) {
            logInfo(TAG, `[WordUpgrade] ${src} 有逐字但覆盖 ${(coverage * 100).toFixed(0)}% / 行数和 ${(rate * 100).toFixed(0)}%（${matched}/${total}），不换`);
            continue;
        }
        /* ★ 2026-10-03 时长一致性校验（用户实测「自动替换总是替成别的歌」）：文本
           匹配率对短句/重复副歌会虚高（阈值 0.6 偏松），再加一道最硬的——候选歌词的
           时间轴终点必须与音频时长接近（±35%）。不同歌的时长几乎必然对不上，能拦住
           「同歌手另一首/同名不同版本」这类误替换。时长未知（直播流/未加载）时跳过校验。 */
        const durMs = (typeof globalThis !== 'undefined' && globalThis.audio
            && Number.isFinite(globalThis.audio.duration)) ? globalThis.audio.duration * 1000 : 0;
        const candEnd = originals.reduce((mx, l) => Math.max(mx, Number(l.start) || 0), 0);
        if (durMs > 30000 && candEnd > 0) {
            const drift = Math.abs(candEnd - durMs) / durMs;
            if (drift > 0.35) {
                logInfo(TAG, `[WordUpgrade] ${src} 候选时长 ${(candEnd / 1000).toFixed(0)}s 与音频 ${(durMs / 1000).toFixed(0)}s 差 ${(drift * 100).toFixed(0)}%，疑似别的歌，不换`);
                continue;
            }
        }
        /* ★ 不静默：换歌词是「用户看不见就会以为功能没做」的动作（本轮反馈的
           「还是不触发」有一半是这种——其实换了但没有任何提示）。
           只在真的换上时响一次，失败不打扰（失败原因留在日志轨迹里）。
           文案由 170 拼：来源显示名只有那一份（SOURCE_NAMES），别在这里抄第二份。 */
        if (_applySource(src, parts, { upgradeRate: coverage })) {
            return { src, rate, coverage };
        }
    }
    return null;
}

/**
 * renderLyrics 末尾调用。
 * @param {Array<Object>} lines 当前歌词（已过 ensureWordTiming）
 */
export function maybeUpgradeToWordLyrics(lines) {
    if (typeof window === 'undefined') return;
    if (_running) return;
    if (!wordUpgradeWanted(globalThis.appSettings)) return;
    if (!Array.isArray(lines) || lines.length < 2) return;
    /* 已经有真逐字 → 无事可做（合成行不算，见 lyricMatch.hasRealWordTiming） */
    if (hasRealWordTiming(lines)) return;
    const key = songKey();
    const titleKey0 = (globalThis.currentSongData && (globalThis.currentSongData.title
        || globalThis.currentSongData.song)) || '';
    if (!key || _tried.has(key) || _scheduledKey === key) return;
    if (titleKey0 && _triedByTitle.has(titleKey0)) return;
    _scheduledKey = key;
    /* ★ 同标题去重（2026-09-27）：排期与 2.5s 执行之间，boot 恢复/取链补全可能把
       songInfo 字段补齐（source 从空到有、id 从 hash 变数字）→ songKey 漂移 →
       同一首歌被当成两首各排期一次，重复打网络（E2E 实测 applied=2）。
       排期时按标题记一份，漂移后的 key 只要标题相同就视为同一首。 */
    const titleKey = titleKey0;
    if (titleKey) _triedByTitle.add(titleKey);
    const snapshot = lines;
    setTimeout(() => {
        _scheduledKey = null;
        /* ★ 守卫必须是「还是不是同一首歌、还要不要升级」，不能是「数组引用变没变」。
           上一版写的是 `globalThis.lyrics !== snapshot`，而这份数组在 2.5 秒窗口里
           几乎一定会被换掉——频谱对齐回填（约束 18）、双语切换、AI 情感词回填、
           甚至设置面板那次 rerender 都会重新赋值。结果：当场静默放弃，
           而 _tried 已经记下这首歌 → 这一首永远不再试（用户实测「还是不触发」）。
           现在：拿当下这份歌词继续，只有真的换了歌才放弃。 */
        const cur = Array.isArray(globalThis.lyrics) && globalThis.lyrics.length ? globalThis.lyrics : snapshot;
        if (songKey() !== key) return;
        if (hasRealWordTiming(cur)) { remember(key); return; }   // 别的途径已经拿到真逐字，不用再试
        remember(key);
        _running = true;
        pickWordSource(cur)
            .then(hit => {
                if (hit) logInfo(TAG, `[WordUpgrade] ${hit.src} 命中，覆盖 ${(hit.coverage * 100).toFixed(0)}%`);
                else logInfo(TAG, '[WordUpgrade] 各来源都没有够格的逐字歌词');
            })
            .catch(e => logCatch(TAG, e))
            .finally(() => { _running = false; });
    }, UPGRADE_DELAY_MS);
}

/** 测试/设置页用：清掉"已尝试"记录，让当前这首歌重新走一遍升级 */
export function resetWordUpgradeTracker() {
    _tried.clear();
    _triedByTitle.clear();
    _running = false;
    _scheduledKey = null;
}
