/* ============================================================
 * core/mediaSession.js — OS 媒体会话元数据与浏览器标签标题纯逻辑
 *
 * 为 Windows SMTC / 硬件媒体键 / 浏览器媒体控件与页面标签提供
 * 无副作用的格式化、封面规范化与进度边界保护函数，可直接在 Node 单测。
 * ============================================================ */

const PLACEHOLDER_TITLES = new Set([
    '',
    '未选择歌曲',
    '加载中...',
    '加载中…',
    'Aria',
    'Aria - 歌词播放器',
]);

const PLACEHOLDER_ARTISTS = new Set([
    '',
    '未知歌手',
    '选择一首音乐开始播放',
    'Select a song to play',
]);

/**
 * 规范化标题/歌手文本，过滤占位提示文案。
 * @param {unknown} raw
 * @param {Set<string>} placeholders
 * @returns {string}
 */
function cleanText(raw, placeholders) {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!s || placeholders.has(s)) return '';
    return s;
}

/**
 * 规范化封面地址，确保为浏览器 MediaMetadata 可识别的有效 URL。
 * @param {unknown} rawUrl
 * @param {string} [baseOrigin]
 * @returns {string}
 */
export function normalizeMediaArtworkUrl(rawUrl, baseOrigin = '') {
    if (typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim().replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
    if (!trimmed || trimmed === '#' || trimmed === 'about:blank') return '';
    if (/^(https?:|data:image\/|blob:)/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/')) {
        return baseOrigin ? `${baseOrigin.replace(/\/+$/, '')}${trimmed}` : trimmed;
    }
    return '';
}

/**
 * 构造浏览器标签页动态标题。
 * @param {unknown} rawTitle
 * @param {unknown} rawArtist
 * @param {boolean} isPlaying
 * @param {string} [baseTitle='Aria - 歌词播放器']
 * @returns {string}
 */
export function formatDocumentTitle(rawTitle, rawArtist, isPlaying, baseTitle = 'Aria - 歌词播放器') {
    const title = cleanText(rawTitle, PLACEHOLDER_TITLES);
    if (!title) return baseTitle;
    const artist = cleanText(rawArtist, PLACEHOLDER_ARTISTS);
    const label = artist ? `${title} - ${artist}` : title;
    return `${isPlaying ? '▶ ' : ''}${label} · Aria`;
}

/**
 * 构造 MediaMetadata 初始化对象；无有效曲目标题时返回 null。
 * @param {any} track
 * @param {{ domTitle?: string, domArtist?: string, coverUrl?: string, origin?: string }} [fallback]
 * @returns {{ title: string, artist: string, album: string, artwork: Array<{ src: string }> } | null}
 */
export function buildMediaMetadataInit(track, fallback = {}) {
    const t = (track && typeof track === 'object') ? track : {};
    const title = cleanText(t.title || t.song || t.name || fallback.domTitle, PLACEHOLDER_TITLES);
    if (!title) return null;
    const artist = cleanText(t.artist || t.singer || fallback.domArtist, PLACEHOLDER_ARTISTS) || 'Aria';
    const album = String(t.album || t.albumName || '').trim();
    const coverSrc = normalizeMediaArtworkUrl(
        t.cover || t.coverUrl || fallback.coverUrl || '',
        fallback.origin || ''
    );
    return {
        title,
        artist,
        album,
        artwork: coverSrc ? [{ src: coverSrc }] : [],
    };
}

/**
 * 计算安全的 MediaSession PositionState 参数（避免 position > duration 或 NaN 抛 TypeError）。
 * @param {number} currentTimeSec
 * @param {number} durationSec
 * @param {number} playbackRate
 * @returns {{ duration: number, playbackRate: number, position: number } | null}
 */
export function clampPositionState(currentTimeSec, durationSec, playbackRate) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    const rawPos = Number.isFinite(currentTimeSec) ? currentTimeSec : 0;
    const position = Math.max(0, Math.min(durationSec, rawPos));
    const rate = (Number.isFinite(playbackRate) && playbackRate > 0) ? playbackRate : 1;
    return {
        duration: durationSec,
        playbackRate: rate,
        position,
    };
}
