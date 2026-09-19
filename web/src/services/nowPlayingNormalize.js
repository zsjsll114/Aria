/* ============================================================
 * services/nowPlayingNormalize.js — now-playing 负载容错解析（纯函数，零依赖）
 * 被 app/232-nowplaying-follow.js 与 Node 单测共用。
 * 键集覆盖：
 *  - now-playing-service（9863 /api/query）：嵌套 {data:{song:{...}}} + cover_url + artists[] + is_playing
 *  - now-playing-service 老版（9863 /query）：{data:{...}} 包裹 + title/artist 常见命名
 *  - kthri/now-playing：顶层 title/artist/album/artwork_url
 *  - 通用 JSON：song/name、singer/author、picUrl/image
 * ============================================================ */

/* 按键序取首个非空字符串（数值转字符串；数组取首元素，元素为对象时取其 name/value/title/artist） */
function firstStr(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v;
        if (typeof v === 'number' && !isNaN(v)) return String(v);
        if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item === 'string' && item.trim()) return item;
                if (item && typeof item === 'object') {
                    const n = item.name ?? item.value ?? item.title ?? item.artist;
                    if (typeof n === 'string' && n.trim()) return n;
                }
            }
        }
    }
    return '';
}

/* 按键序取首个可解析为数值的字段（兼容字符串数字） */
function firstNum(obj, keys) {
    for (const k of keys) {
        const v = obj[k];
        const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
        if (!isNaN(n)) return n;
    }
    return 0;
}

/**
 * 把任意 now-playing 负载规整为 { title, artist, cover, duration, isPlaying }。
 * @param {*} raw 服务端裸 JSON（可为 {data:{...}} 或平铺对象）
 * @returns {object|null} 缺歌名时返回 null
 */
export function normalizeNowPlayingPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    /* 层次合并：平铺 → data 包裹 → song/track 子对象，后层覆盖前层同名键，
       兼容 {data:{song:{...}}} / {data:{track:{...}}} / 顶层 song/track 各类形态 */
    const nodes = [raw];
    const push = (o) => { if (o && typeof o === 'object') nodes.push(o); };
    push(raw.data);
    push(raw.song);
    push(raw.track);
    if (raw.data && typeof raw.data === 'object') {
        push(raw.data.song);
        push(raw.data.track);
    }
    const data = Object.assign({}, ...nodes);

    const title = firstStr(data, ['title', 'song', 'name', 'trackName', 'track', 'songName', 'musicName', 'music']);
    if (!title) return null;

    const artist = firstStr(data, ['artist', 'artists', 'singer', 'author', 'artistName', 'albumArtist', 'creator', 'singerName']);
    const cover = firstStr(data, ['cover', 'cover_url', 'coverUrl', 'picUrl', 'albumCover', 'albumCoverUrl', 'artwork', 'artworkUrl', 'artwork_url', 'image', 'cover_img']);
    const duration = firstNum(data, ['duration', 'durationMs', 'duration_ms', 'length', 'time']); /* 秒 */
    const durMs = firstNum(data, ['durationMs', 'duration_ms']);
    /* 播放状态：平铺键之外，播放器信息常在独立 player 节点（/api/query 的「播放器信息」部分），
       只取播放状态字段，绝不整层合并——player.name 等会污染歌名提取 */
    const playerNode = (raw.player && typeof raw.player === 'object') ? raw.player
        : (raw.data && raw.data.player && typeof raw.data.player === 'object') ? raw.data.player
            : null;
    const pOk = (v) => v === true || v === 'true';
    /* 「正在播放」判定：
       ① 显式正键：isPlaying / is_playing / playing / state|playState='playing'；
       ② ★ kthri/now-playing(9863) 只用 player.isPaused / hasSong 表达播放状态，永不置 isPlaying——
          若 isPlaying 未提供则用「未暂停(isPaused:false)」反推，否则该服务永远判 isPlaying=false，
          自动跟播门(info.isPlaying !== false)被永久卡死，表现正是"开关开了却毫无反应" */
    const pPaused = playerNode && (pOk(playerNode.isPaused) || pOk(playerNode.is_paused));
    /* 幂等回退：若已是本模块归一化产物（无 player 节点），顶层 paused 键直接透传，
       避免二次 normalize 把 player 层的 paused 丢成 false（暂停镜像失效） */
    const dataPaused = data.paused === true || data.isPaused === true || data.is_paused === true;
    const pPlaying = playerNode && (pOk(playerNode.isPlaying) || pOk(playerNode.is_playing) || pOk(playerNode.playing)
        || playerNode.state === 'playing' || playerNode.playState === 'playing')
        || (playerNode && playerNode.isPlaying === undefined && playerNode.isPaused !== undefined && !pPaused);
    const isPlaying = data.isPlaying === true
        || data.is_playing === true
        || data.playing === true
        || !!pPlaying
        || data.state === 'playing'
        || data.playState === 'playing'
        || data.status === 'playing';

    /* ★ 播放状态镜像字段透传（供 232 跟随暂停/播放与进度）：
       paused = player.isPaused（无显式 playing 键时的权威暂停信号）；
       seek = seekbarCurrentPosition 秒（容错字符串→数字）；
       无 player 节点时回退读顶层（二次归一的幂等保障）。 */
    const _seekRaw = playerNode ? playerNode.seekbarCurrentPosition : undefined;
    let seek = (typeof _seekRaw === 'number' && isFinite(_seekRaw))
        ? _seekRaw
        : (typeof _seekRaw === 'string' ? (parseFloat(_seekRaw) || 0) : 0);
    if (!seek) seek = firstNum(data, ['seek', 'seekbarCurrentPosition', 'seekPos', 'position']);

    return {
        title: title.trim(),
        artist: (artist || '').trim(),
        cover: cover || '',
        duration: durMs ? Math.round(durMs / 1000) : Math.round(duration),
        isPlaying,
        paused: !!pPaused || dataPaused,
        seek
    };
}

/** 曲目身份键：跨负载做“切歌”判等用（一律小写，忽略空白） */
export function nowPlayingKey(info) {
    return `${(info.title || '').trim().toLowerCase()}|${(info.artist || '').trim().toLowerCase()}`;
}