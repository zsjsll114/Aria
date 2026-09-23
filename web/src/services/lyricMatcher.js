/**
 * lyricMatcher.js — 智能歌词匹配度评分（v2，借鉴 上游参考项目 matchScore 算法）
 *
 * 升级点（相对 v1 二值判断）：
 *  - 标题/专辑：Jaccard 连续相似度 + 子串包含按长度比例（非 0/1）
 *  - 标题归一化剔除 feat 与「括号内的版本标记」(live/remix/instrumental…)，
 *    其余括号内容保留 → 版本差异不再靠硬扣分，而是自然收敛到相似度
 *  - 歌手：按 ,&、feat 等拆分多艺人逐个匹配，主艺人加权
 *  - 时长吻合：尾奏窗口 0~35s 满分 / 35~60s 中档 / 更长老档；首行过晚、歌词超音频均扣分
 *  - 防误配：标题或歌手身份缺失时总分封顶 74（避免低分仍自动采纳）
 *  - 保留歌词质量维度：逐字(isWordLevel) / 双语(hasTranslation) / 时间轴单调性
 *
 * 输入：
 *  currentSong   { title, artist, album?, duration?（秒） }
 *  candidateLyric{ title, artist, album?, isWordLevel, hasTranslation, parsedLines:[{start|time}...] }
 * 返回 0~100 整数。
 */
import { toSimplified as toSimplifiedHan } from './vendor/han-convert/index.mjs';

/**
 * 繁→简：chinese-simple2traditional 的 toSimplified() = 繁体输入 → 简体输出
 *（函数名与包名 simple2traditional 相反，以 README/实测为准；勿误用 toTraditional）。
 * 繁→简大体一对一（合字简化），仅极少数按读音存在一对多（著→著/着、乾→乾/干、徵→徵/征、
 * 藉→藉/借、於→於/于），单字模式取常规默认值。两侧走同一确定性变换，结果恒一致，不影响匹配。
 */
function toSimplified(value) {
  return toSimplifiedHan(String(value || ''));
}


/* 归一化：繁→简 + 小写 + 去标点符号 + 空格规整（保留跨语言字符） */
function normalizeLyricMatchText(value) {
    return toSimplified(String(value || ''))
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')  // Unicode 标点/符号
        .replace(/\s+/g, ' ')
        .trim();
}

/* 标题归一化：删 feat 从属；括号内容仅当命中版本标记时整段剔除，否则保留 */
const VERSION_MARKER_PATTERN = /(instrumental|inst|off\s*vocal|karaoke|remix|mix|version|ver\.?|cover|live|edit|arrange|伴奏|カラオケ|インスト|リミックス|remaster|remastered)/iu;

function normalizeTitleForMatch(value) {
    return normalizeLyricMatchText(
        String(value || '')
            .replace(/[\(\[（【]\s*(feat|featuring|ft)\.?\s+[^\)\]）】]+[\)\]）】]/giu, '')
            .replace(/\b(feat|featuring|ft)\.?\s+.+$/iu, '')
            .replace(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/gu, (match, content) =>
                VERSION_MARKER_PATTERN.test(content) ? match : '')
    );
}

/* Jaccard 字符相似度；完全相等=1，一方被包含按长度比例 */
function stringSimilarity(s1, s2, normalizer = normalizeLyricMatchText) {
    const n1 = normalizer(s1);
    const n2 = normalizer(s2);
    if (!n1 || !n2) return 0;
    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) return Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
    const set1 = new Set(n1);
    const set2 = new Set(n2);
    let intersection = 0;
    for (const ch of set1) if (set2.has(ch)) intersection++;
    const union = new Set([...set1, ...set2]).size;
    return union > 0 ? intersection / union : 0;
}

/* 歌手拆分：支持 ,&、/ feat 等分隔，返回归一化后的艺人名数组 */
function splitArtistsForMatch(artistText) {
    return String(artistText || '')
        .split(/[,&、/]|feat\.?|ft\.?|featuring|与/i)
        .map(s => normalizeLyricMatchText(s))
        .filter(s => s.length > 0);
}

function calculateArtistSimilarity(target, search) {
    const tArtists = splitArtistsForMatch(target);
    const sArtists = splitArtistsForMatch(search);

    if (tArtists.length === 0 || sArtists.length === 0) {
        return stringSimilarity(target, search);
    }

    let matchCount = 0;
    for (const a1 of tArtists) {
        for (const a2 of sArtists) {
            if (a1 === a2 || (a1.length >= 3 && a2.includes(a1)) || (a2.length >= 3 && a1.includes(a2))) {
                matchCount++;
                break;
            }
        }
    }

    const tokenSim = matchCount / Math.max(tArtists.length, sArtists.length);
    // 主艺人（第一个）命中给加成：至少提升到 0.7
    const mainA = tArtists[0];
    const mainB = sArtists[0];
    const mainMatched = mainA && mainB && (
        mainA === mainB ||
        (mainA.length >= 3 && mainB.includes(mainA)) ||
        (mainB.length >= 3 && mainA.includes(mainB))
    );
    const mainBonus = mainMatched ? Math.max(tokenSim, 0.7) : tokenSim;
    return Math.max(mainBonus, stringSimilarity(target, search));
}

export function calculateLyricMatchScore(currentSong = {}, candidateLyric = {}) {
    if (!candidateLyric || !candidateLyric.parsedLines || candidateLyric.parsedLines.length === 0) {
        return 0;
    }

    const lines = candidateLyric.parsedLines;
    const audioDur = Number(currentSong.duration) || 0;

    // -------------------------------------------------------------
    // 维度 1: 标题 / 歌手 / 专辑 身份匹配（0~75 分，上游参考项目 权重结构）
    // -------------------------------------------------------------
    const titleSim = stringSimilarity(currentSong.title || '', candidateLyric.title || '', normalizeTitleForMatch);
    const titleScore = titleSim * 40;

    const targetArtist = String(currentSong.artist || '').trim();
    const artistSim = targetArtist
        ? calculateArtistSimilarity(targetArtist, candidateLyric.artist || '')
        : 1;   // 无目标歌手时按 1（不扣身份分）
    const artistScore = artistSim * 25;

    const targetAlbum = String(currentSong.album || '').trim();
    const searchAlbum = String(candidateLyric.album || '').trim();
    const albumScore = (targetAlbum && searchAlbum)
        ? stringSimilarity(targetAlbum, searchAlbum, normalizeTitleForMatch) * 10
        : (targetAlbum ? 0 : 10);   // 双方都无专辑信息给基准分

    const identityScore = titleScore + artistScore + albumScore;

    // 身份缺失封顶：标题不达标或（有目标歌手但歌手不达标）→ 总分封顶，防低分误采纳
    const AUTO_MATCH_CAP = 74;
    const titleMatched = titleSim >= 0.65;
    const artistMatched = !targetArtist || artistSim >= 0.75;   // 阈值收紧，防"同曲名不同歌手"溜过
    const hasReliableIdentity = titleMatched && artistMatched;
    const cappedIdentity = hasReliableIdentity ? identityScore : Math.min(identityScore, AUTO_MATCH_CAP);

    // -------------------------------------------------------------
    // 维度 2: 时长与时间跨度吻合度（0~25 分）
    // -------------------------------------------------------------
    let durationScore = 15;   // 无时长/无法判断的基准分
    if (audioDur > 0) {
        const firstLineSec = (lines[0].start || lines[0].time || 0) / 1000;
        const lastLineSec = (lines[lines.length - 1].start || lines[lines.length - 1].time || 0) / 1000;

        if (lastLineSec > audioDur + 3) {
            // 歌词比音频还长 → 严重错配
            durationScore = 0;
        } else {
            const tail = audioDur - lastLineSec;   // 尾奏时长
            if (tail >= 0 && tail <= 35) durationScore = 25;
            else if (tail > 35 && tail <= 60) durationScore = 18;
            else durationScore = 8;
        }
        if (firstLineSec > audioDur * 0.45) durationScore = Math.min(durationScore, 5);   // 首行过晚 → 多为主歌缺失，强压
    }

    // -------------------------------------------------------------
    // 维度 3: 歌词精度层级（0~12 分）
    // -------------------------------------------------------------
    let qualityScore = candidateLyric.isWordLevel ? 8 : 5;
    if (candidateLyric.hasTranslation) qualityScore += 4;

    // -------------------------------------------------------------
    // 维度 4: 时间轴健康度（0~5 分）
    // -------------------------------------------------------------
    let monotonic = true;
    for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1].start || lines[i - 1].time || 0;
        const curr = lines[i].start || lines[i].time || 0;
        if (curr < prev) { monotonic = false; break; }
    }
    if (monotonic && lines.length >= 6) qualityScore += 5;

    // 身份缺失时质量维度也封顶（保证 cap 真正生效在总分布局上）
    const total = hasReliableIdentity
        ? cappedIdentity + durationScore + qualityScore
        : Math.min(cappedIdentity + durationScore + qualityScore, AUTO_MATCH_CAP);

    return Math.max(0, Math.min(100, Math.round(total)));
}