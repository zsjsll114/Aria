/* ============================================================
 * services/artistApi.js — 歌手数据适配层（四源）
 *
 * 上游能力（2026-10-03 四家 vendor 全部实测，非文档推断）：
 *
 *   源      按关键词搜歌手                    歌手详情 / 作品
 *   ───────────────────────────────────────────────────────────────────────────
 *   QQ      ✗ getSearchByKey 不返回歌手分组   /getSingerDesc     ?singermid=  (XML+CDATA)
 *           （remoteplace=singer 实测无效）    /getSingerHotsong  ?singermid=&limit=
 *                                             /getSingerAlbum    ?singermid=&limit=
 *   网易    ✔ /cloudsearch?type=100           /artists           ?id=  (含 hotSongs 50)
 *                                             /artist/songs      ?id=&limit=200&order=hot  ← 全量作品
 *                                             /artist/album      ?id=&limit=&offset=
 *   酷狗    ✔ /search?type=author             /artist/detail     ?id=
 *                                             /artist/audios     ?id=&sort=hot&pagesize=(≤300)
 *                                             /artist/albums     ?id=&sort=hot&pagesize=(≤60)
 *   汽水    ✗ 适配层未暴露 artist 路由         ✗（同上，vendor 有 getArtist 但未挂路由）
 *
 * 作品条数实测上限（2026-10-03，周杰伦）：QQ hotsong 60 / 专辑 43；
 * 网易 /artist/songs 200 / 专辑 44；酷狗 audios 300 / 专辑 49。
 * 所以歌曲默认取 100、专辑一律 60 —— 低于这个量级就会「内容不全」。
 *
 * 注意路径形状：酷狗是 `/artist/detail`（函数名 artist_detail、路由带斜杠），
 * 网易是 `/artist/album`（**不是** `/artist_album`，后者返回空 hotAlbums）。
 *
 * ★ 平台键：所有 selfhost 调用必须过 selfhostKeyOf()（services/playSource.js）——
 *   搜索页签的 source 是 'tencent'，后端 _SERVICES 的键是 'qq'，直接拼就是 404。
 *
 * 本模块只做数据与归一化，不碰 DOM（渲染在 app/297-artist-page.js）。
 * 歌曲一律归一化为搜索页形状 {id,mid,song,singer,artists,album,cover,interval,source}，
 * 这样歌手页里的歌曲可以直接交给 175 的 loadOnlineSong()，不需要第二条播放链路。
 * ============================================================ */
import { logCatch, logWarn } from './log.js';
import { selfhostKeyOf } from './playSource.js';

const SH_TIMEOUT = 8000;
const enc = encodeURIComponent;

/* ---------------- 基础请求 ---------------- */

async function shGet(source, path, timeout = SH_TIMEOUT) {
    const key = selfhostKeyOf(source);
    if (!key) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
        const res = await fetch(`/api/selfhost/${key}/proxy?path=${enc(path)}`, { signal: ctl.signal });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        logCatch('artistApi', e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- 归一化小工具 ---------------- */

/* WebView2/tauri 页面下 http 图片会被 mixed-content 拦掉（先例见 150 的网易封面处理） */
function upHttps(u) {
    return typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : '';
}

/* 酷狗头像/封面 URL 里的 {size} 占位符必须替换，否则取到的是字面量路径 */
function kgUrl(u, size) {
    return upHttps(String(u || '').replace('{size}', String(size || 480)));
}

function qqCoverOf(albumMid) {
    return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '';
}

function qqAvatarOf(mid) {
    return mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : '';
}

/* 酷狗 timelength 是毫秒、QQ interval 是秒、网易 dt 是毫秒 —— 统一到「秒」，
   用阈值判别而不是按源分支，少一处会写错的映射表。 */
function toSec(v) {
    const n = Number(v) || 0;
    return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

/* QQ 的 /getSingerDesc 返回的不是 JSON，而是一段 XML 字符串：
   { response: '<?xml ...<result>...<data><info><desc><![CDATA[简介…]]></desc>…' }
   必须从 CDATA 里抠，直接塞 DOM 会把整段 XML 显示出来。 */
function qqDescFromXml(raw) {
    const s = typeof raw === 'string' ? raw : (raw && raw.desc) || '';
    if (!s) return '';
    const m = s.match(/<desc>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/desc>/);
    if (m) return m[1].trim();
    const m2 = s.match(/<desc>([\s\S]*?)<\/desc>/);
    return m2 ? m2[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return String(Math.round(v / 1000000) / 100) + ' 亿';
    if (v >= 10000) return String(Math.round(v / 1000) / 10) + ' 万';
    return String(v);
}

/* ---------------- 歌手搜索 ---------------- */

/** 该源是否支持「按关键词搜歌手」。QQ 的 getSearchByKey 实测不出歌手分组，汽水未暴露路由。 */
export function artistSearchSupported(source) {
    const k = selfhostKeyOf(source);
    return k === 'netease' || k === 'kugou';
}

/**
 * @returns {Promise<Array<{source,artistId,artistMid,name,avatar,sub}>>}
 *          失败/不支持一律返回 []（调用方据此隐藏整块，不做报错打扰）
 */
export async function searchArtists(source, keyword, limit = 6) {
    const kw = String(keyword || '').trim();
    if (!kw || !artistSearchSupported(source)) return [];
    const n = Math.max(1, Math.min(20, parseInt(limit, 10) || 6));
    const key = selfhostKeyOf(source);

    if (key === 'netease') {
        const j = await shGet('netease', `/cloudsearch?keywords=${enc(kw)}&limit=${n}&type=100`);
        const arr = ((j || {}).result || {}).artists || [];
        return arr.map(a => ({
            source: 'netease',
            artistId: String(a.id || ''),
            artistMid: '',
            name: a.name || '',
            avatar: upHttps(a.picUrl),
            sub: [a.albumSize ? `${a.albumSize} 张专辑` : '', a.musicSize ? `${a.musicSize} 首单曲` : '']
                .filter(Boolean).join(' · '),
        })).filter(a => a.artistId && a.name);
    }

    /* 酷狗：与歌曲搜索同一条 /search，靠 type=author 切分支（module/search.js 的 type 白名单） */
    const j = await shGet('kugou', `/search?keywords=${enc(kw)}&type=author&pagesize=${n}&page=1`);
    const arr = (((j || {}).data) || {}).lists || [];
    return arr.map(a => ({
        source: 'kugou',
        artistId: String(a.AuthorId || ''),
        artistMid: '',
        name: a.AuthorName || '',
        avatar: kgUrl(a.Avatar, 300),
        sub: [
            a.AlbumCount ? `${a.AlbumCount} 张专辑` : '',
            a.AudioCount ? `${a.AudioCount} 首单曲` : '',
            a.FansNum ? `${fmtCount(a.FansNum)} 粉丝` : '',
        ].filter(Boolean).join(' · '),
    })).filter(a => a.artistId && a.name);
}

/* ---------------- 歌手详情 ---------------- */

const CACHE = new Map();
const CACHE_MAX = 60;
const CACHE_TTL = 30 * 60 * 1000;

/* ★ 名字 → id 解析缓存（2026-10-03）：歌曲卡片有时只能给到歌手名字
   （酷狗 mobilecdn 兜底搜索结果没有 SingerId、本地/收藏只有名字），
   此时按名字去该源搜一次歌手拿 id，歌手页才不会「点了没反应/提示不可用」。 */
const NAME_CACHE = new Map();
const NAME_CACHE_MAX = 80;

async function resolveArtistByName(source, name) {
    const ck = `${source}:${String(name).toLowerCase()}`;
    if (NAME_CACHE.has(ck)) return NAME_CACHE.get(ck);
    let hit = null;
    try {
        const list = await searchArtists(source, name, 5);
        const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
        hit = list.find(a => a.name === name)
            || list.find(a => norm(a.name) === norm(name))
            || null;
    } catch (e) { logCatch('artistApi', e); }
    NAME_CACHE.set(ck, hit);
    while (NAME_CACHE.size > NAME_CACHE_MAX) NAME_CACHE.delete(NAME_CACHE.keys().next().value);
    return hit;
}

export function clearArtistCache() { CACHE.clear(); NAME_CACHE.clear(); }

function cacheGet(key) {
    const hit = CACHE.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) { CACHE.delete(key); return null; }
    CACHE.delete(key); CACHE.set(key, hit);   /* LRU 触碰 */
    return hit.data;
}

function cacheSet(key, data) {
    CACHE.set(key, { at: Date.now(), data });
    while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

/**
 * 拉取歌手详情。四源字段形状各不相同，统一归一化为：
 * { source, artistId, artistMid, name, avatar, desc, fans, songs[], albums[],
 *   partial, empty }
 * - partial：拿到了歌手本体但作品列表为空（上游限流/无版权时会出现）
 * - empty  ：连本体都没拿到（未登录 / 接口挂 / 该源不支持）
 * 绝不抛异常——页面按 empty/partial 决定降级文案。
 */
export async function fetchArtist(artist, opts = {}) {
    const src = String((artist && artist.source) || '');
    const key = selfhostKeyOf(src);
    const result = {
        source: src,
        artistId: String((artist && artist.artistId) || ''),
        artistMid: String((artist && artist.artistMid) || ''),
        name: (artist && artist.name) || '',
        avatar: upHttps((artist && artist.avatar) || ''),
        desc: '', fans: '', stat: '', songs: [], albums: [],
        partial: false, empty: false,
    };
    if (!key) { result.empty = true; return result; }

    /* ★ 只有名字时先按名字解析出 id（见 resolveArtistByName 注释）。
       QQ 搜索恒给 mid，不会走到这里；酷狗 mobilecdn 兜底 / 收藏 / 本地曲目会。 */
    if (!result.artistId && !result.artistMid && result.name && artistSearchSupported(src)) {
        const hit = await resolveArtistByName(key, result.name);
        if (hit) {
            result.artistId = hit.artistId || '';
            result.artistMid = hit.artistMid || '';
            result.avatar = result.avatar || hit.avatar || '';
        }
    }

    const cacheKey = `${key}:${result.artistMid || result.artistId || result.name}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    /* 作品条数：三家上游能一次给全的量级不同（实测 2026-10-03，周杰伦）——
       QQ hotsong 硬顶 60；网易 /artists 只给热门 50，要全量得走 /artist/songs；
       酷狗 audios 可到 300。默认取 100（歌手页不做分页，一屏给足）。
       ★ 专辑一律 60：QQ 60→43、网易 60→44、酷狗 60→49，而 30 会把它们统统截断，
       这正是用户反馈「歌手页内容不全」的直接原因。 */
    const want = Math.max(1, Math.min(300, parseInt(opts.songLimit, 10) || 100));
    const ALBUM_LIMIT = 60;

    if (key === 'qq') {
        const mid = result.artistMid || result.artistId;
        if (!mid) { result.empty = true; return result; }
        result.avatar = result.avatar || qqAvatarOf(mid);
        const [descJ, hotJ, albJ] = await Promise.all([
            shGet('tencent', `/getSingerDesc?singermid=${enc(mid)}`),
            shGet('tencent', `/getSingerHotsong?singermid=${enc(mid)}&limit=${Math.min(want, 60)}&page=0`),
            shGet('tencent', `/getSingerAlbum?singermid=${enc(mid)}&limit=${ALBUM_LIMIT}&page=0`),
        ]);
        result.desc = qqDescFromXml(((descJ || {}).response !== undefined) ? descJ.response : descJ);
        const songlist = ((((hotJ || {}).response) || {}).singer || {}).data || {};
        result.songs = (songlist.songlist || []).map(s => {
            const ars = Array.isArray(s.singer) ? s.singer : [];
            const al = s.album || {};
            return {
                id: s.mid, mid: s.mid,
                song: s.name || s.title || '',
                singer: ars.map(x => x.name).join('/') || result.name,
                artists: ars.map(x => ({ id: String(x.id || ''), mid: x.mid || '', name: x.name || '' })).filter(a => a.name),
                album: al.name || '',
                cover: qqCoverOf(al.mid),
                interval: toSec(s.interval),
                source: 'tencent',
            };
        }).filter(s => s.id);
        const albumData = (((albJ || {}).response) || {}).singer || {};
        result.albums = (((albumData.data || {}).albumList) || []).map(a => ({
            id: a.albumMid || '',
            name: a.albumName || '',
            cover: qqCoverOf(a.albumMid),
            year: String(a.publishDate || '').slice(0, 4),
        }));
        /* ★ QQ 的 hotsong 偶发返回空（上游短时限流，实测同参数连续两次调用 5→0）。
           不当作失败：只要简介或专辑还在就继续渲染，partial 会提示「作品暂时拉不到」。 */
        if (!result.songs.length) logWarn('artistApi', `[QQ] hotsong 为空（上游限流或该歌手无热门）mid=${mid}`);
    } else if (key === 'netease') {
        if (!result.artistId) { result.empty = true; return result; }
        const [detJ, songJ, albJ] = await Promise.all([
            shGet('netease', `/artists?id=${enc(result.artistId)}`),
            /* ★ 全量作品走 /artist/songs（实测 limit=200 → 200 首）；/artists 的
               hotSongs 恒为热门 50，只用它当兜底，别当主列表。 */
            shGet('netease', `/artist/songs?id=${enc(result.artistId)}&limit=${Math.min(want, 200)}&offset=0&order=hot`),
            shGet('netease', `/artist/album?id=${enc(result.artistId)}&limit=${ALBUM_LIMIT}&offset=0`),
        ]);
        const a = (detJ || {}).artist || {};
        if (a.name) result.name = a.name;
        result.avatar = result.avatar || upHttps(a.picUrl);
        result.desc = (a.briefDesc || '').trim();
        /* 网易 /artists 不给粉丝数，用作品量代替（有粉丝数时优先显示粉丝数） */
        result.stat = [
            a.albumSize ? `${a.albumSize} 张专辑` : '',
            a.musicSize ? `${a.musicSize} 首歌` : '',
        ].filter(Boolean).join(' · ');
        /* 这里只需 3 次请求就能拿到「歌手信息 + 全量作品 + 全量专辑」，
           比原来 2 次请求多拿 150 首歌——单次 /artist/songs 已经是分页接口，
           不再额外翻页（歌手页不做分页 UI）。 */
        const rawSongs = ((songJ || {}).songs && (songJ || {}).songs.length)
            ? songJ.songs
            : (((detJ || {}).hotSongs) || []);
        result.songs = rawSongs.map(s => {
            const al = s.al || {};
            const ars = Array.isArray(s.ar) ? s.ar : [];
            return {
                id: String(s.id), mid: '',
                song: s.name || '',
                singer: ars.map(x => x.name).join('/') || result.name,
                artists: ars.map(x => ({ id: String(x.id || ''), mid: '', name: x.name || '' })).filter(x => x.name),
                album: al.name || '',
                cover: upHttps(al.picUrl),
                interval: toSec(s.dt),
                source: 'netease',
            };
        }).filter(s => s.id);
        result.albums = (((albJ || {}).hotAlbums) || []).map(al => ({
            id: String(al.id || ''),
            name: al.name || '',
            cover: upHttps(al.picUrl),
            year: al.publishTime ? String(new Date(al.publishTime).getFullYear()) : '',
        }));
    } else if (key === 'kugou') {
        if (!result.artistId) { result.empty = true; return result; }
        const [detJ, audJ, albJ] = await Promise.all([
            shGet('kugou', `/artist/detail?id=${enc(result.artistId)}`),
            /* 酷狗 audios 支持到 300（实测），pagesize 给足；sort=hot 与网页版一致 */
            shGet('kugou', `/artist/audios?id=${enc(result.artistId)}&pagesize=${want}&page=1&sort=hot`),
            shGet('kugou', `/artist/albums?id=${enc(result.artistId)}&pagesize=${ALBUM_LIMIT}&page=1&sort=hot`),
        ]);
        const d = (detJ || {}).data || {};
        if (d.author_name) result.name = d.author_name;
        result.avatar = result.avatar || kgUrl(d.sizable_avatar, 480);
        result.desc = (((d.long_intro || [])[0] || {}).content || '').trim();
        result.fans = d.fansnums ? fmtCount(d.fansnums) : '';
        result.stat = result.fans
            ? `${result.fans} 粉丝`
            : [
                d.album_count ? `${d.album_count} 张专辑` : '',
                d.audio_count ? `${d.audio_count} 首歌` : '',
            ].filter(Boolean).join(' · ');
        result.songs = (((audJ || {}).data) || []).map(s => ({
            id: s.hash || s.hash_320 || '',
            mid: s.hash || s.hash_320 || '',
            song: s.audio_name || '',
            singer: s.author_name || result.name,
            /* 酷狗 audios 不带歌手对象（作者就是本人），留空而不是塞假 ID */
            artists: [],
            album: s.album_name || '',
            cover: kgUrl((s.trans_param || {}).union_cover, 400),
            interval: toSec(s.timelength),
            source: 'kugou',
        })).filter(s => s.id);
        result.albums = (((albJ || {}).data) || []).map(al => ({
            id: String(al.album_id || ''),
            name: al.album_name || '',
            cover: kgUrl(al.sizable_cover, 400),
            year: String(al.publish_date || '').slice(0, 4),
        }));
    } else {
        /* 汽水：vendor 有 getArtist/listArtistTracks，但 scripts/qishui-server.mjs 未挂路由 */
        result.empty = true;
        return result;
    }

    const hasAny = !!(result.desc || result.songs.length || result.albums.length);
    result.empty = !hasAny;
    result.partial = hasAny && !result.songs.length;

    /* 空结果不写缓存：上游限流造成的空是暂时的，缓存 30 分钟会把"暂时"变成"半天" */
    if (hasAny) cacheSet(cacheKey, result);
    return result;
}
