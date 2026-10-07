/* ============================================================
 * core/scatterPick.js — 随机播放的「散列」选曲（纯函数，可单测）
 *
 * 需求：随机播放时**同歌手的歌不相邻**；当队列里全是同一歌手时，退而求其次把
 * **相似歌名隔开**（去掉 Live / Remix 等后缀后核心歌名相同、编辑距离近、或同专辑）。
 * 约束实在满足不了时**允许偶尔相邻**（宁可相邻也不能选不出歌）。
 *
 * 为什么单独成模块：`95-track-loading.js` 的 `computeStepTrack` 是被 automix
 * 复用的**纯决策函数**（预载也要走同一条决策），散列逻辑塞进去会让那条路径
 * 变得难测。这里只做「给一个索引」，不碰任何全局状态。
 * ============================================================ */

/** 尾部修饰：Live / Remix / 伴奏 / 版本标注 …（只削尾部，"Live 版 我的歌" 不动） */
const TAIL_NOISE_RE = /[\s\-—_·]*[（([【]?\s*(live|remix|伴奏|纯音乐|instrumental|acoustic|unplugged|ver\.?|version|demo|cover|翻唱|重制|remaster(ed)?|feat\.?[^）)\]】]*|ft\.?[^）)\]】]*)\s*[）)\]】]?\s*$/gi;

/** 归一化歌名：削尾部修饰 + 去掉所有标点空白 + 小写 */
export function coreTitle(title) {
    let s = String(title == null ? '' : title);
    /* 反复削：`歌曲 (Live) (Remix)` 要削两次 */
    for (let i = 0; i < 3; i++) {
        const next = s.replace(TAIL_NOISE_RE, '');
        if (next === s) break;
        s = next;
    }
    s = s.replace(/[\s\-—_·.。!！?？,，、:：;；'"“”‘’`()（）[\]【】{}<>《》/\\|~]/g, '');
    return s.toLowerCase();
}

/** 歌手的归一化键（歌手字段名在不同音源不一致：artist / singer / artists） */
export function artistKey(track) {
    if (!track) return '';
    let a = track.artist || track.singer || track.artists || track.artistName || '';
    if (Array.isArray(a)) a = a.join('/');
    return String(a).trim().toLowerCase();
}

/** 专辑键（同上，字段名不统一） */
export function albumKey(track) {
    if (!track) return '';
    return String(track.album || track.albumName || track.albumname || '').trim().toLowerCase();
}

/** 经典 Levenshtein（迭代 + 两行滚动；歌名很短，不需要更花的算法） */
export function editDistance(a, b) {
    const s = String(a || ''), t = String(b || '');
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    let prev = new Array(t.length + 1);
    let cur = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= t.length; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[t.length];
}

/**
 * 两个核心歌名是否「像同一首」（编辑距离 ≤ 长度的 20%，至少容 1）。
 * 只对**长度接近**的短串生效，避免「abc」和「abd」这种误伤。
 */
export function similarTitle(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const max = Math.max(a.length, b.length);
    if (max < 3) return false;
    const min = Math.min(a.length, b.length);
    if (min / max < 0.6) return false;   /* 长度差太多，不可能是一首 */
    return editDistance(a, b) <= Math.max(1, Math.floor(max * 0.2));
}

/**
 * 从播放队列里挑一个「散列」索引：尽量不与当前曲同歌手 / 同核心歌名 / 同专辑。
 *
 * 三级降级（保证**一定能选出歌**）：
 *   ① 过滤掉同歌手 —— 正常情况走这里（用户要的主约束）；
 *   ② 全是同歌手：过滤掉「核心歌名相同 / 编辑距离近 / 同专辑」（用户要的次约束）；
 *   ③ 仍为空（例如整个队列就是同一首歌的不同版本）：放手，允许偶尔相邻。
 *
 * @param {Array} playlist 播放队列
 * @param {number} currentIndex 当前曲索引
 * @param {() => number} [rand] 随机源（测试可注入）
 * @returns {number} 选中的索引（队列长度 ≤1 时原样返回 currentIndex）
 */
export function pickScatteredIndex(playlist, currentIndex, rand = Math.random) {
    const n = Array.isArray(playlist) ? playlist.length : 0;
    if (n <= 1) return currentIndex;

    const candidates = [];
    for (let i = 0; i < n; i++) if (i !== currentIndex) candidates.push(i);

    const cur = playlist[currentIndex] || {};
    const curArtist = artistKey(cur);

    /* ① 不同歌手 */
    let pool = candidates.filter((i) => artistKey(playlist[i]) !== curArtist);

    /* ② 同歌手兜底 → 隔开相似歌名 / 同专辑 */
    if (pool.length === 0) {
        const curCore = coreTitle(cur.title || cur.name);
        const curAlbum = albumKey(cur);
        pool = candidates.filter((i) => {
            const tr = playlist[i] || {};
            const t = coreTitle(tr.title || tr.name);
            const sameTitle = !!t && !!curCore && similarTitle(t, curCore);
            const sameAlbum = !!curAlbum && albumKey(tr) === curAlbum;
            return !(sameTitle || sameAlbum);
        });
    }

    /* ③ 约束无法满足：允许偶尔相邻 */
    if (pool.length === 0) pool = candidates;

    const r = Number(rand());
    const k = Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * pool.length)));
    return pool[k];
}
