/* ============================================================
 * core/playlistQueue.js — 传统主流桌面播放器播放队列纯逻辑（可单测）
 *
 * 收敛两类入口的队列行为与曲目归一化：
 *   1. A 类（发现/临时列表：搜索 / 榜单 / 日推 / 歌手页 / 历史播放）：
 *      - 单击曲目：清空并以仅此一首替换队列（playlist = [track], currentTrackIndex = 0）
 *      - 「播放全部」：整表归一化替换队列并从第 0 首起播
 *      - 行内「加入当前播放」：不打断播放、去重追加到当前队列末尾
 *   2. B 类（合集/歌单：本地歌单 / 本地音乐库 / 本地收藏 / 自建云端歌单与红心）：
 *      - 单击第 i 首：以归一化后的整份合集替换队列并从第 i 首起播
 *      - 「播放全部」：以归一化后的整份合集替换队列并从第 0 首起播
 *   3. 切歌/结束判定（computeNextQueueDecision）：
 *      - 单曲队列（len === 1）在顺序/随机模式下自然播完（ended/auto）时停止，
 *        不再 `% 1 === 0` 死循环；只有单曲循环（playMode === 'loop'）才自动重播。
 *      - 多曲队列（len > 1）保持顺序循环 / 随机散列 / 单曲循环；手动上下曲在单曲队列上
 *        从头重播当前曲目而非盲目丢弃队列去摇随机 API。
 * ============================================================ */
import { pickScatteredIndex } from './scatterPick.js';
import { platformKeyOf } from '../services/playSource.js';

/** @param {any} raw @returns {boolean} */
export function hasLocalTrackAssets(raw) {
    if (!raw || typeof raw !== 'object') return false;
    return Boolean(raw.isLocal === true || raw.folder || raw.audioUrl || raw.elrcUrl || raw.lrcUrl);
}

/**
 * 将各渠道原始歌曲对象归一化为播放队列条目，保留跨源取链与本地歌词所需全部元数据。
 * @param {any} raw
 * @param {string} [fallbackSource]
 * @returns {any}
 */
export function normalizeQueueTrack(raw, fallbackSource = '') {
    if (!raw || typeof raw !== 'object') return null;

    const explicitRawSrc = String(raw.source || raw.src || fallbackSource || '').trim();
    const explicitNormSrc = explicitRawSrc ? (platformKeyOf(explicitRawSrc) || explicitRawSrc) : '';
    const hasOnlineId = Boolean(
        (raw.id != null && raw.id !== '')
        || (raw.songId != null && raw.songId !== '')
        || raw.mid
        || raw.songmid
        || raw.hash
    );
    const localAssets = hasLocalTrackAssets(raw);
    const isLocal = Boolean(
        localAssets
        || explicitNormSrc === 'local'
        || (!explicitNormSrc && !hasOnlineId && (raw.url || raw.audioUrl))
    );

    let source = 'local';
    if (!isLocal) {
        if (explicitNormSrc && explicitNormSrc !== 'local') {
            source = explicitNormSrc;
        } else if (raw.hash) {
            source = 'kugou';
        } else if (raw.mid || raw.songmid) {
            source = 'tencent';
        } else if (raw.id != null && raw.id !== '') {
            /* 兼容早期收藏：仅保存网易数字 ID 而缺 source 字段 */
            source = 'netease';
        } else {
            source = '';
        }
    }

    const title = String(raw.title || raw.song || raw.name || raw.songname || '').trim() || '未知歌曲';
    const rawArtist = raw.artist || raw.singer || raw.author || raw.singername
        || (Array.isArray(raw.authors) ? raw.authors.map((/** @type {any} */ a) => a && (a.author_name || a.name)).filter(Boolean).join(' / ') : '')
        || (Array.isArray(raw.ar) ? raw.ar.map((/** @type {any} */ a) => a && a.name).filter(Boolean).join(' / ') : '');
    const artist = String(rawArtist || '').trim() || '未知歌手';
    const album = String(raw.album || raw.albumName || raw.albumname || (raw.al && raw.al.name) || '');
    const cover = String(raw.cover || raw.coverUrl || raw.pic || '');

    const rawId = raw.id != null && raw.id !== ''
        ? raw.id
        : (raw.songId != null && raw.songId !== '' ? raw.songId : (raw.hash || raw.mid || raw.songmid || ''));
    const id = rawId != null && rawId !== '' ? String(rawId) : '';
    const mid = raw.mid ? String(raw.mid) : (raw.songmid ? String(raw.songmid) : '');
    const hash = raw.hash ? String(raw.hash) : '';
    const url = isLocal
        ? String(raw.audioUrl || raw.url || '')
        : (raw.url ? String(raw.url) : null);

    const key = raw.key
        ? String(raw.key)
        : (isLocal
            ? (raw.folder ? `local:${raw.folder}` : `local:${url || title}`)
            : ((source && (id || mid || hash)) ? `${source}:${id || mid || hash}` : ''));

    /** @type {Record<string, any>} */
    const track = {
        url,
        title,
        song: title,
        artist,
        singer: artist,
        cover,
        source,
        id,
        mid,
        hash,
        album,
        isLocal,
        key,
        mvVid: raw.mvVid || '',
        mvId: raw.mvId || '',
        mvHash: raw.mvHash || '',
    };

    if (raw.interval != null) track.interval = raw.interval;
    if (raw.duration != null) track.duration = raw.duration;
    if (raw.dt != null) track.dt = raw.dt;
    if (isLocal) {
        if (raw.folder) track.folder = String(raw.folder);
        if (raw.audioUrl || url) track.audioUrl = String(raw.audioUrl || url || '');
        if (raw.coverUrl || cover) track.coverUrl = String(raw.coverUrl || cover || '');
        if (raw.elrcUrl) track.elrcUrl = String(raw.elrcUrl);
        if (raw.lrcUrl) track.lrcUrl = String(raw.lrcUrl);
        if (typeof raw.hasWordLevel === 'boolean') track.hasWordLevel = raw.hasWordLevel;
        if (raw.matchScore != null) track.matchScore = raw.matchScore;
    }

    return track;
}

/** @param {any} entry @returns {boolean} */
export function isPlayableQueueTrack(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.isLocal === true || entry.source === 'local') {
        return Boolean(entry.url || entry.audioUrl);
    }
    const hasOnline = Boolean(entry.source && (entry.id || entry.mid || entry.hash));
    return hasOnline || Boolean(entry.url);
}

/**
 * 为去重生成稳定的曲目唯一标识（与历史播放 / 自建去重同口径）。
 * @param {any} raw
 * @param {string} [fallbackSource]
 * @returns {string}
 */
export function trackIdentityKey(raw, fallbackSource = '') {
    const t = normalizeQueueTrack(raw, fallbackSource);
    if (!t) return '';
    if (t.isLocal) {
        return `local:${t.folder || t.audioUrl || t.url || t.title}`;
    }
    const src = platformKeyOf(t.source) || t.source || '';
    const nativeId = src === 'tencent'
        ? (t.mid || t.id || '')
        : (src === 'kugou' ? (t.hash || t.id || '') : (t.id || t.mid || t.hash || ''));
    if (src && nativeId) return `${src}:${nativeId}`;
    if (t.url) return `url:${t.url}`;
    const title = String(t.title || '').toLowerCase();
    const artist = String(t.artist || '').toLowerCase();
    return title ? `meta:${title}|${artist}` : '';
}

/**
 * A 类列表单曲点播：清空队列并以仅此一首替代。
 * @param {any} rawTrack
 * @param {string} [fallbackSource]
 * @returns {{ playlist: any[], currentTrackIndex: number }}
 */
export function buildSingleTrackQueue(rawTrack, fallbackSource = '') {
    const norm = normalizeQueueTrack(rawTrack, fallbackSource);
    if (!norm || !isPlayableQueueTrack(norm)) {
        return { playlist: [], currentTrackIndex: 0 };
    }
    return { playlist: [norm], currentTrackIndex: 0 };
}

/**
 * B 类合集或「播放全部」：将整份列表归一化为播放队列，并准确定位被点击项索引。
 * @param {any[]} rawTracks
 * @param {number} [clickedIndex]
 * @param {string} [fallbackSource]
 * @returns {{ playlist: any[], currentTrackIndex: number }}
 */
export function buildCollectionQueue(rawTracks, clickedIndex = 0, fallbackSource = '') {
    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
        return { playlist: [], currentTrackIndex: 0 };
    }
    const safeTarget = Number.isInteger(clickedIndex) && clickedIndex >= 0 && clickedIndex < rawTracks.length
        ? clickedIndex
        : 0;
    const out = [];
    let mappedIndex = 0;
    for (let i = 0; i < rawTracks.length; i++) {
        const norm = normalizeQueueTrack(rawTracks[i], fallbackSource);
        if (!norm || !isPlayableQueueTrack(norm)) continue;
        if (i === safeTarget) mappedIndex = out.length;
        out.push(norm);
    }
    if (mappedIndex >= out.length) mappedIndex = 0;
    return { playlist: out, currentTrackIndex: mappedIndex };
}

/**
 * @param {any[]} queue
 * @param {any} rawTrack
 * @param {string} [fallbackSource]
 * @param {{ insertNext?: boolean, moveIfDuplicate?: boolean, currentIndex?: number }} [opts]
 * @returns {{ added: boolean, duplicate: boolean, moved?: boolean, alreadyCurrent?: boolean, alreadyNext?: boolean, index: number, currentIndex?: number, track: any }}
 */
export function enqueueTrack(queue, rawTrack, fallbackSource = '', opts = {}) {
    if (!Array.isArray(queue)) {
        return { added: false, duplicate: false, index: -1, track: null };
    }
    const norm = normalizeQueueTrack(rawTrack, fallbackSource);
    if (!norm || !isPlayableQueueTrack(norm)) {
        return { added: false, duplicate: false, index: -1, track: null };
    }
    const rawCur = Number(opts && opts.currentIndex);
    const cur = Number.isInteger(rawCur) && rawCur >= 0 && rawCur < queue.length ? rawCur : 0;
    const key = trackIdentityKey(norm, fallbackSource);
    if (key) {
        const existingIdx = queue.findIndex((item) => trackIdentityKey(item) === key);
        if (existingIdx >= 0) {
            if (opts && opts.insertNext && opts.moveIfDuplicate && queue.length > 0) {
                if (existingIdx === cur) {
                    return { added: false, duplicate: true, alreadyCurrent: true, moved: false, index: existingIdx, currentIndex: cur, track: queue[existingIdx] };
                }
                if (existingIdx === cur + 1) {
                    return { added: false, duplicate: true, alreadyNext: true, moved: false, index: existingIdx, currentIndex: cur, track: queue[existingIdx] };
                }
                const [existing] = queue.splice(existingIdx, 1);
                const newCur = existingIdx < cur ? cur - 1 : cur;
                const pos = Math.min(newCur + 1, queue.length);
                queue.splice(pos, 0, existing);
                return { added: false, duplicate: false, moved: true, index: pos, currentIndex: newCur, track: existing };
            }
            return { added: false, duplicate: true, index: existingIdx, track: queue[existingIdx] };
        }
    }
    if (opts && opts.insertNext && queue.length > 0) {
        const pos = Math.min(cur + 1, queue.length);
        queue.splice(pos, 0, norm);
        return { added: true, duplicate: false, index: pos, currentIndex: cur, track: norm };
    }
    queue.push(norm);
    return { added: true, duplicate: false, index: queue.length - 1, track: norm };
}

/**
 * 传统播放器「下一首播放 / 插播」：新曲目插入当前曲目之后，
 * 若已在队列其他位置则移动至下一首位置并同步返回校正后的 currentIndex。
 * @param {any[]} queue
 * @param {any} rawTrack
 * @param {string} [fallbackSource]
 * @param {number} [currentIndex=0]
 * @returns {{ added: boolean, duplicate: boolean, moved?: boolean, alreadyCurrent?: boolean, alreadyNext?: boolean, index: number, currentIndex?: number, track: any }}
 */
export function enqueuePlayNext(queue, rawTrack, fallbackSource = '', currentIndex = 0) {
    return enqueueTrack(queue, rawTrack, fallbackSource, {
        insertNext: true,
        moveIfDuplicate: true,
        currentIndex,
    });
}

/**
 * 发现/瞬态渠道单曲点播：把选中歌曲插入当前播放曲目下一位并立即切换到该曲（不清空原有队列）。
 * 若该歌曲已在队列其他位置，则移动至当前曲目下一位并同步校正 currentTrackIndex；
 * 若当前正在播放的就是同一首歌，则停留在原下标直接重播而不重复插入。
 * @param {any[]} queue
 * @param {any} rawTrack
 * @param {string} [fallbackSource]
 * @param {number} [currentIndex=0]
 * @returns {{ playlist: any[], currentTrackIndex: number, index: number, track: any }}
 */
export function insertNextAndPlay(queue, rawTrack, fallbackSource = '', currentIndex = 0) {
    const baseList = Array.isArray(queue) ? queue.filter(isPlayableQueueTrack) : [];
    const safeCur = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < baseList.length ? currentIndex : 0;
    const res = enqueuePlayNext(baseList, rawTrack, fallbackSource, safeCur);
    if (res.index < 0 || !res.track) {
        return { playlist: baseList, currentTrackIndex: safeCur, index: -1, track: null };
    }
    return {
        playlist: baseList,
        currentTrackIndex: res.index,
        index: res.index,
        track: res.track,
    };
}

/**
 * 格式化队列条目的时长徽标（空值返回 ''）。
 * @param {any} track
 * @returns {string}
 */
export function formatQueueTrackDuration(track) {
    if (!track || typeof track !== 'object') return '';
    const raw = Number(track.interval || track.duration || track.dt || 0);
    if (!Number.isFinite(raw) || raw <= 0) return '';
    /* 网易 dt 为毫秒（>10800 视为毫秒，兼容秒制曲目），QQ/酷狗 interval 为秒 */
    const totalSec = Math.floor(raw > 10800 ? raw / 1000 : raw);
    if (totalSec <= 0) return '';
    const mins = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const secs = (totalSec % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

/**
 * 切歌 / 播完自动推进决策（纯函数）。
 * @param {{
 *   playlist?: any[],
 *   currentIndex?: number,
 *   playMode?: string,
 *   delta?: number,
 *   reason?: 'auto'|'manual',
 *   autoPlayNext?: boolean,
 * }} [ctx]
 * @returns {{ kind: 'stop'|'random-api'|'loop-replay'|'replay-current'|'online'|'local', index: number, track: any }}
 */
export function computeNextQueueDecision(ctx = {}) {
    const pl = Array.isArray(ctx.playlist) ? ctx.playlist : [];
    const len = pl.length;
    const rawCur = Number(ctx.currentIndex);
    const cur = Number.isInteger(rawCur) && rawCur >= 0 && rawCur < len ? rawCur : 0;
    const playMode = (ctx.playMode === 'loop' || ctx.playMode === 'random') ? ctx.playMode : 'sequence';
    const delta = (Number(ctx.delta) || 1) < 0 ? -1 : 1;
    const reason = ctx.reason === 'manual' ? 'manual' : 'auto';
    const autoPlayNext = ctx.autoPlayNext !== false;

    if (len === 0) {
        if (reason === 'auto' && !autoPlayNext) {
            return { kind: 'stop', index: -1, track: null };
        }
        return { kind: 'random-api', index: -1, track: null };
    }

    if (playMode === 'loop') {
        return { kind: 'loop-replay', index: cur, track: pl[cur] };
    }

    if (len === 1) {
        if (reason === 'auto') {
            return { kind: 'stop', index: -1, track: null };
        }
        return { kind: 'replay-current', index: 0, track: pl[0] };
    }

    if (reason === 'auto' && !autoPlayNext) {
        return { kind: 'stop', index: -1, track: null };
    }

    const idx = playMode === 'random'
        ? pickScatteredIndex(pl, cur)
        : (cur + delta + len) % len;
    const track = pl[idx];
    const isLocal = !track
        || track.isLocal === true
        || track.source === 'local'
        || (!(track.source && (track.id || track.mid || track.hash)) && Boolean(track.url || track.audioUrl));
    return {
        kind: isLocal ? 'local' : 'online',
        index: idx,
        track,
    };
}
