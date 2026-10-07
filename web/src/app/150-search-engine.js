/* ============================================================
 * 150-search-engine.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 5787-6051 行 | 单元数: 13
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { escapeHtml } from '../utils/formatters.js';
import { hueOfName } from '../utils/colorUtils.js';
import { proxyFetch, searchKugouSongs } from '../services/musicApi.js';
import { artistSearchSupported, searchArtists } from '../services/artistApi.js';
import { adoptVkeysMvFields, mvSearchSupported, searchMvsForWord } from '../services/mvApi.js';
import { selfhostKeyOf } from '../services/playSource.js';
import { favoritesOverlay, searchBtn, searchInput, searchResultsEl, sourceBtns, searchOverlay } from './30-dom-refs.js';
import { closeSearch, getFavorites, hideResults, openSearch, saveFavorites, setHint, showResults, showResultsSkeleton, updateFavoriteBtn } from './120-search-results.js';
import { closeFavorites, renderFavoritesList } from './125-favorites.js';
import { addToPlaylistOverlay, importPlaylistOverlay, playlistsOverlay } from './130-playlists.js';
import { closePlaylists, loadPlaylistTrack, openAddToPlaylist } from './135-crossfade.js';
import { closeAddToPlaylist } from './140-playlist-ui-events.js';
import { addSearchHistory, hideSearchHistory, updateSearchView } from './157-search-history.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* ESC 关闭弹窗 */
if (typeof window !== "undefined") window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                /* ★ 逐层关闭（2026-09-22 操作性自查）：此前一次 ESC 把所有叠开的弹窗
                   全部关掉——歌单页上叠开导入弹窗时按 ESC 整个栈消失，破坏用户上下文。
                   改为从最上层弹窗开始，一次只关一个。 */
                /* ★ 歌手页是从搜索结果/榜单里叠开的一层，顺序上必须最先关 */
                if (typeof Aria !== 'undefined' && typeof Aria.isArtistPageOpen === 'function' && Aria.isArtistPageOpen()) {
                    Aria.closeArtist(); return;
                }
                const createPl = document.getElementById('createPlaylistModalOverlay');
                if (createPl && createPl.classList.contains('visible')) { createPl.classList.remove('visible'); return; }
                if (importPlaylistOverlay.classList.contains('visible') && !isImportingPlaylist) { importPlaylistOverlay.classList.remove('visible'); return; }
                if (addToPlaylistOverlay.classList.contains('visible')) { closeAddToPlaylist(); return; }
                const rankOv = document.getElementById('rankingsOverlay');
                const recentOv = document.getElementById('recentOverlay');
                const favOv = document.getElementById('favoritesOverlay');
                if (rankOv && rankOv.classList.contains('visible')) { rankOv.classList.remove('visible'); return; }
                if (recentOv && recentOv.classList.contains('visible')) { recentOv.classList.remove('visible'); return; }
                if (favOv && favOv.classList.contains('visible')) { closeFavorites(); return; }
                if (playlistsOverlay.classList.contains('visible')) { closePlaylists(); return; }
                if (searchOverlay && searchOverlay.classList.contains('visible')) { searchOverlay.classList.remove('visible'); }
            }
        });

/* ========== 预留：推荐歌单接口 ==========
           可通过扩展此函数从服务端获取推荐歌单并合并显示
           async function fetchRecommendedPlaylists() {
               const res = await fetch('https://api.example.com/playlists/recommend');
               return res.json();
           }
           获取后可插入到 getPlaylists() 返回列表中，并加 .tag='推荐' 标记
        */
/* 搜索缓存：按音源缓存关键词与已加载的真实后端分页数据 */
globalThis.lastSearchKeyword = { tencent: '', netease: '', kugou: '', kuwo: '', qishui: '' };

/* 各源真实后端分页单页上限（2026-08 实测）：QQ=60 网易=20 酷狗=100
   ★ 酷我（=99）已于 2026-10-03 从搜索移除，表项保留仅为兼容旧缓存。
   ★ 汽水是自建 vendor 一层封装，上限由我们自己的 server.mjs 定（默认 30，硬顶 100）。 */
const SOURCE_PAGE_SIZE = { tencent: 60, netease: 20, kugou: 100, kuwo: 99, qishui: 30 };
/* 每源结构：{ keyword, pages:{1:[...],2:[...]}, pageSize, lastFull, curPage, busy } */
globalThis.searchPageCache = { tencent: null, netease: null, kugou: null, kuwo: null, qishui: null };
/* ★ "这个源的这次搜索正在飞"标记**挂在 cache 对象上**（cache.busy），不再是全局单变量。
   全局 `searchPagingBusy` 有过一个真实缺陷（2026-10-03 定位）：用户在 A 源搜索飞行
   途中点 B 源按钮 → searchSongs 建了 B 的 cache、铺了骨架屏 → goToSearchPage(1) 看见
   全局 busy 还是 true 就 `return` —— **B 源的搜索被静默丢弃**；随后 A 的响应回来判定
   stale，又把这层骨架和提示清掉，于是 B 源页面上什么都没有，再点一次搜索才正常。
   挂在 cache 上以后：切源/换词都是新对象，各自独立；清缓存把 cache 置 null，标记
   随之消失，不需要任何"记得复位"的额外代码。 */
globalThis.searchPage = 1;

/* ============ 搜索页音源（与「正在播放的平台」解耦，2026-10-03） ============
   症状（用户报）：①打开搜索页有时一个音源按钮都不亮，此时搜索什么也搜不出来，
   历史区却显示着「不知道哪个源」的词；②搜完一首，关掉搜索页再打开，结果区空了、
   上方 label 还挂着「加载中」。
   根因：搜索页此前直接用 currentSource —— 可它是**播放平台**：loadPlaylistTrack
   会把它设成 'local'（本地文件/导入歌单里的本地曲）、切歌会把它设成那一首的平台
   （日推首曲常常是网易云）。于是：
     · 它不在 {tencent,netease,kugou,qishui} 里时 → 音源按钮全灭，
       搜索又拿 'local' 去查 → 必然空手而归；
     · 它被切歌改成别家时 → 搜索页跟着跳源，缓存键一换就查不到刚搜的结果，
       结果区与 label 同时被 updateSearchView 的「无缓存」分支清掉。
   ★ 语义定死为一句话：**搜索页音源是「用户选的」，会话内粘性。**
     · 用户点过音源按钮 → 之后任何播放/切歌都不再改写它；
     · 用户还没点过 → 打开面板那一刻用「正在播放的平台」初始化（合法时），
       非法平台（'local' 等）则回落到 QQ。
   这样既修好「一个源都不亮」，也不会再出现「搜索页自己换源、结果凭空消失」。 */
/* ★ 酷我（2026-10-03 移除）：曲库偏、命中率低，用户判定「太鸡肋」→ 只从**搜索**里摘掉
   入口（index.html 的按钮 + 这张表），酷我作为**歌词/兜底取链**的链路原样保留
   （170-lyric-sources / 175-track-index-online 仍在用，删表项会让它们判成非法源）。 */
const SEARCH_SOURCES = ['tencent', 'netease', 'kugou', 'qishui'];
let searchSourceUserChosen = false;   /* 用户是否显式点过音源按钮（粘性开关） */
function isSearchSource(s) { return SEARCH_SOURCES.includes(s); }
function sourcePlaceholder(src) {
    return src === 'tencent' ? '搜索QQ音乐歌曲...'
        : (src === 'kugou' ? '搜索酷狗音乐歌曲...'
        : (src === 'qishui' ? '搜索汽水音乐歌曲...' : '搜索网易云音乐歌曲...'));
}
/* 同步音源按钮高亮 + 输入框占位（纯 UI，不发请求、不改结果区） */
function syncSearchSourceUI() {
    sourceBtns?.forEach(b => b.classList.toggle('active', b.dataset.source === searchSource));
    if (searchInput) searchInput.placeholder = sourcePlaceholder(searchSource);
}
/* 打开面板时校正搜索音源：用户还没选过就用「正在播放的平台」，选过就保持不动。
   无论如何都保证落到一个合法源上（自愈），这就是「一个源都不亮」的修复点。 */
function resolveSearchSource(playbackSrc) {
    if (!searchSourceUserChosen && isSearchSource(playbackSrc)) searchSource = playbackSrc;
    if (!isSearchSource(searchSource)) searchSource = 'tencent';   /* 自愈兜底 */
    syncSearchSourceUI();
    return searchSource;
}
/* 显式切换音源（音源按钮点击 / 外部指定）。用户一旦用过，搜索页音源就钉住，
   不再受播放平台影响（见本段文件头）。 */
function setSearchSource(src) {
    if (!isSearchSource(src)) return false;
    searchSourceUserChosen = true;
    if (src === searchSource) { syncSearchSourceUI(); return false; }
    searchSource = src;
    syncSearchSourceUI();
    refreshSearchSourceView();
    return true;
}
function refreshSearchSourceView() {
    if (!searchOverlay || !searchOverlay.classList.contains('visible')) return;
    if (searchInput) searchInput.value = lastSearchKeyword[searchSource] || '';
    const loaded = getLoadedSearchResults();
    if (loaded.length) {
        searchResultsCache = loaded;
        renderSearchResults(loaded);
        /* 数量标签由 renderSearchResults 画进列表头部（见那里的说明），这里只清顶部瞬时提示 */
        setHint('');
        /* 切回一个「歌曲有缓存但卡片还没拉过」的源时补拉（缓存命中不经过 goToSearchPage） */
        const c = searchPageCache[searchSource];
        if (c && c.keyword) ensureSearchExtras(searchSource, c.keyword, loaded);
    } else {
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        setHint('');
        updateSearchView();
    }
}

function getAllLoaded(cache) {
    return Object.keys(cache.pages).map(Number)
        .sort((a, b) => a - b)
        .reduce((acc, k) => acc.concat(cache.pages[k]), []);
}

/* 供外部恢复界面：返回当前源已加载的全部结果（无缓存返回 []） */
function getLoadedSearchResults() {
    const cache = searchPageCache[searchSource];
    return (cache && Object.keys(cache.pages).length) ? getAllLoaded(cache) : [];
}

/* ★ 恢复渲染当前源已缓存的搜索结果（用于搜索框编辑后删回原词，避免空白） */
function restoreCachedSearchResults() {
    const cache = searchPageCache[searchSource];
    if (!cache || !Object.keys(cache.pages).length) return;
    const loaded = getAllLoaded(cache);
    if (!loaded.length) return;
    searchResultsCache = loaded;
    globalThis.searchPage = cache.curPage || 1;
    renderSearchResults(loaded);
    setHint('');
}
globalThis.__restoreCachedSearchResults = restoreCachedSearchResults;

async function fetchSourcePage(source, word, page) {
    /* ★ 不再静默切换到其它源：
       用户选"QQ音乐"就是想搜 QQ 的歌——接口无结果/失败时明确报错提示，由用户自行切换音源，
       避免"搜索接到别家去"(接过去后常遇到 VIP 播不了、没歌词的双重问题)。 */
    if (source === 'kugou') {
        const r = await searchKugouSongs(word, page, SOURCE_PAGE_SIZE.kugou);
        if (r && r.success && r.list && r.list.length) return r.list;
        logWarn('searchEngine', '[Search] 酷狗搜索无结果，不自动切换到其它源');
        throw new Error('酷狗搜索暂无结果，可尝试点击顶部音源切换');
    }
    /* ★ 汽水（2026-10-03）：只有自建 vendor 一条路——汽水没有匿名公开搜索接口，
       第三方站要么已挂要么要 token（实测见 scripts/probes/qishui-source-probe.py）。
       所以这里不做「失败静默回退」（没有可回退的目标），而是明确报错让用户知道
       要先把本机自建服务跑起来。 */
    if (source === 'qishui') {
        const qs = await fetchQishuiSearchPage(word, page, SOURCE_PAGE_SIZE.qishui);
        if (qs && qs.length) return qs;
        logWarn('searchEngine', '[Search] 汽水搜索无结果（自建服务离线或上游无匹配）');
        throw new Error('汽水音乐搜索暂无结果（需本机自建服务在线）');
    }
    /* ★ 自建 vendor 与公网 vkeys **并发竞速**（2026-10-03 真机实测后改）。
       实测本机数据：
         · QQ 自建搜索 2.5–3.4s —— 而且**不是我们的锅**：上游 c.y.qq.com 的
           client_search_cp 单次就要 2.4–4.9s，limit=10/30/60 毫无差别（直连
           单发 4.8s，vendor 靠 keep-alive 才压到 2.5s）。这是我们改不动的一段。
         · vkeys 聚合搜索 0.7s。
       旧的「自建优先、失败再回退公网」等于把 0.7s 的路径死死压在 3s 之后——
       这就是用户感知到的「QQ 搜索怎么这么慢（vkeys 以前没这么慢）」。
       竞速后：vkeys 活着 → ~0.7s 出结果；vkeys 挂了/限流/返空 → 自建兜住
       （当初切 vendor-first 要解决的正是这个，能力一点没丢）。 */
    let vkeysErr = null;
    const vendorP = fetchVendorSearchPage(source, word, page, 100);
    const vkeysP = fetchVkeysSearchPage(source, word, page).catch(e => { vkeysErr = e; return null; });
    const hit = await firstNonEmpty([vendorP, vkeysP]);
    if (hit && hit.length) {
        logInfo('searchEngine', `[Search] ${source} 第${page}页 ${hit.length} 首（自建/vkeys 竞速）`);
        return hit;
    }
    const srcName = source === 'tencent' ? 'QQ音乐' : '网易云音乐';
    logWarn('searchEngine', `[Search] ${source} 自建与 vkeys 均无结果，不自动切换到其它源`);
    throw vkeysErr || new Error(`${srcName}搜索暂无结果，可尝试点击顶部音源切换`);
}

/* ★ 竞速：谁先给出**非空**数组就用谁；全部空/失败才返回 null。
   注意每条 promise 都要自带 catch（竞速输的那条仍在飞，不能变成 unhandled rejection）。 */
function firstNonEmpty(promises) {
    return new Promise(resolve => {
        let pending = promises.length;
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        promises.forEach(p => {
            Promise.resolve(p).then(list => {
                if (settled) return;
                if (Array.isArray(list) && list.length) { done(list); return; }
                if (--pending === 0) done(null);
            }).catch(() => {
                if (settled) return;
                if (--pending === 0) done(null);
            });
        });
    });
}

/* vkeys 公网搜索：走本地 /proxy（浏览器直连 api.vkeys.cn 会被 CORS 拦）。
   无结果时抛错（带上 code），由调用方决定最终提示文案。 */
async function fetchVkeysSearchPage(source, word, page) {
    let json = { code: 0 };
    try {
        const res = await proxyFetch(`${API_BASE}/${source}?word=${encodeURIComponent(word)}&num=${SOURCE_PAGE_SIZE[source]}&page=${page}`, { timeout: 4500 });
        json = await res.json().catch(() => ({ code: 0 }));
    } catch (_) { /* 见下方统一报错 */ }
    const okList = (json.code === 200 && json.data) ? (Array.isArray(json.data) ? json.data : [json.data]) : [];
    if (okList.length) {
        /* ★ vkeys 网易云封面是 http://pX.music.126.net → 统一升 https，
           否则 https/tauri 页面 mixed-content 拦图（CDN https 已实测 200） */
        if (source === 'netease') {
            for (const it of okList) {
                if (it && typeof it.cover === 'string') it.cover = it.cover.replace(/^http:\/\//, 'https://');
            }
        }
        /* ★ vkeys 条目的歌手字段形状与自建 vendor 不同（2026-10-03 实测）：
           QQ 给的是 snake_case 的 singer_list[{id,mid,name}]，网易只有 singer 字符串。
           这里统一补一份 **artists** 出来：
             · 歌曲行的歌手名才能变成可点链接（此前 QQ 走 vkeys 时歌手名是死的纯文本，
               因为 artistSearchSupported('tencent') 为假、没有 artists 就退化成文本）；
             · 搜索结果页的「歌手卡片」与 QQ 的「MV 卡片」都要靠它拿 mid
               （QQ 的 MV 是歌手维度 /getSingerMv，没 mid 就整排空）。
           ★ 这条必须补：vkeys 通常比自建 vendor 快（0.7s vs 2.5s）会赢下竞速，
             缺了它 = QQ 的歌手/MV 卡片在实际使用中**恒为空**。 */
        for (const it of okList) {
            if (!it || Array.isArray(it.artists)) continue;
            if (Array.isArray(it.singer_list)) {
                it.artists = it.singer_list
                    .map(s => ({ id: String((s && s.id) || ''), mid: (s && s.mid) || '', name: (s && s.name) || '' }))
                    .filter(a => a.name);
            } else if (typeof it.singer === 'string' && it.singer) {
                it.artists = it.singer.split(/[\/、,&;]+/).map(n => n.trim())
                    .filter(Boolean).map(name => ({ id: '', mid: '', name }));
            } else {
                it.artists = [];
            }
        }
        /* ★ 2026-10-04：MV 关联字段必须一起搬（用户：「qq 不会自动匹配 mv 但是网易云
           和酷狗可以」）。上面那段竞速注释写明 **vkeys 会赢下竞速**（0.7s vs 2.5s），
           而 vkeys 的 QQ 条目自带 `vid`（实测与自建 getSearchByKey 完全一致：
           青花瓷 l00131om505 / 晴天 w0026q7f01a）—— 不搬它，QQ 搜索结果的 item.mvVid
           就恒空，自动匹配只能退到「跨源同名+歌手」（而 QQ 没有关键词搜 MV 的接口，
           本平台那一级被跳过了），于是 QQ 几乎匹配不上 MV。
           ★ 单独一轮循环：上面补 artists 的那个循环遇到「已有 artists」会 continue，
             塞进去会被跳过。 */
        adoptVkeysMvFields(okList);
        return okList;
    }
    const srcName = source === 'tencent' ? 'QQ音乐' : '网易云音乐';
    logWarn('searchEngine', `[Search] ${source} vkeys 无结果(code=${json.code})`);
    throw new Error(`${srcName}搜索${json.code === 503 ? '服务暂时不可用(503)' : '暂无结果'}，可尝试点击顶部音源切换`);
}

/* ★ 自建 vendor 搜索：QQ=/getSearchByKey（KuGouMusicApi 同系）、网易=/search（NeteaseCloudMusicApi）。
   统一规范化为搜索页标准字段 {id, mid, song, singer, album, cover, interval, source}。
   任何失败（副进程离线/超时/无结果）返回 null，由调用方回退公网 vkeys。 */
async function fetchVendorSearchPage(source, word, page, want) {
    try {
        let path;
        if (source === 'tencent') {
            /* ★ 参数名是 limit 不是 num（2026-10-03 实测）：vendor 的 getSearchByKey.ts
               读的是 `ctx.query.limit`，`n: +n || 10` —— 传 num 会被完全忽略、恒回 10 首。
               症状：自建 QQ 服务"登录了却只搜出 10 首"（以前走公网 vkeys 有 60~100 首），
               即 AGENTS.md 里「QQ 单页缩水」那条的真实原因。
               ★ 且上游硬顶 60：limit=60 → 60 首，limit=65/70/80 → 仍 60，
               **limit=100 → 0 首**（上游直接判非法、整页空）。调用方传的是 100，
               所以这里必须夹住，否则修成 limit 反而比现在还糟（0 首 → 静默回退公网）。 */
            const qqN = Math.min(want, 60);
            path = `/getSearchByKey?key=${encodeURIComponent(word)}&limit=${qqN}&page=${page}`;
        } else if (source === 'netease') {
            /* ★ /cloudsearch 而非 /search（2026-09-26）：旧 /search 的 album 只有 picId 没有
               picUrl → 封面恒空；/cloudsearch 的 songs[].al.picUrl 才带封面 URL */
            path = `/cloudsearch?keywords=${encodeURIComponent(word)}&limit=${want}&offset=${(page - 1) * want}&type=1`;
        } else {
            return null;
        }
        const ctl = new AbortController();
        /* ★ 超时不能按「本机 vendor 应该毫秒级」来定（2026-10-03 实测）：
           vendor 是本机的，但它背后要打 QQ 上游，浏览器侧实测单次 3.5–4.4s
           （同一请求用 python 直连只要 1.5s）。原来卡 4000ms 正好压在这条线上，
           首搜就间歇性 AbortError → 静默回退 vkeys → 公网不通时表现为「搜索一直转圈」
           （真机探针里 hint 停在「第 1 页搜索中...」）。放宽到 9s：
           仍远小于用户可感知的「卡死」，又让自建这条快路径稳定命中。 */
        const timer = setTimeout(() => ctl.abort(), 9000);
        /* ★ 后端平台键 ≠ 前端 source（QQ 是 'tencent'→'qq'）：直接拼 source 会 404，
           且被本函数的 catch 吞掉 → 表现为"静默回退公网"。走 selfhostKeyOf 收口。 */
        const shKey = selfhostKeyOf(source);
        if (!shKey) return null;
        const res = await fetch(`/api/selfhost/${shKey}/proxy?path=${encodeURIComponent(path)}`, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const j = await res.json();
        let list = [];
        if (source === 'tencent') {
            const raw = (((j.response || {}).data || {}).song || {}).list || [];
            list = raw.map(it => ({
                /* ★ id 必须是**数字 songid**（2026-10-03 真机定位）。
                   此前这里把 id 写成 songmid（字符串 '000SMH6F05TVNQ'），而公网
                   vkeys 的 /tencent 只认整数——传 mid 直接 `code 500「id 必须是整数」`。
                   后果：自建取链失败需要兜底时，整条链在 vkeys 那一步必然断掉，
                   真机表现正是用户报的「有的歌放不出来，但用 vkeys 搜同一首却能取到」。
                   实测同一首歌：vkeys?id=108879872 → 200；?id=000SMH6F05TVNQ → 500。 */
                id: String(it.songid || it.songmid),
                mid: it.songmid,
                song: it.songname || '',
                singer: Array.isArray(it.singer) ? it.singer.map(s => s.name).join('/') : (it.singer || ''),
                /* ★ 另存歌手对象（singer 字符串保持原样 → 现有渲染点零改动）：
                   QQ 上游给的是 [{id, mid, name}]，此前只取 name，把 mid 丢了，
                   点歌手名进歌手页就只剩"拿名字猜"这条路。 */
                artists: Array.isArray(it.singer)
                    ? it.singer.map(s => ({ id: String(s.id || ''), mid: s.mid || '', name: s.name || '' })).filter(a => a.name)
                    : [],
                album: it.albumname || '',
                cover: it.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${it.albummid}.jpg` : '',
                interval: parseInt(it.interval) || 0,
                /* ★ 这首歌自己的 MV id（2026-10-03 二次修正）：QQ 搜索报文里每首歌都带
                   `vid`，实测 /getMvPlay?vid=<vid> 直出该曲 MV 的 mp4。上一版完全没读它，
                   只能退回"按歌手搜 MV"，于是搜索页摆出来的是该歌手**别的歌**的 MV
                   （用户截图确证）。这里存下来供两处消费：搜索页 MV 卡 + 背景跟随播放。 */
                mvVid: it.vid || '',
                source: 'tencent'
            }));
        } else {
            /* ★ /cloudsearch 新结构 al/ar/dt；兼容旧 /search 的 album/artists/duration。
               picUrl 是 http://pX.music.126.net → 统一升 https（https/tauri 页面下
               http 图会被 mixed-content 拦掉 → onerror 隐藏 → 用户看到无封面） */
            const raw = ((j.result || {}).songs) || [];
            list = raw.map(it => {
                const al = it.al || it.album || {};
                const pic = al.picUrl || '';
                const ars = Array.isArray(it.ar) ? it.ar : (Array.isArray(it.artists) ? it.artists : []);
                return {
                    id: String(it.id),
                    song: it.name || '',
                    singer: ars.map(a => a.name).join('/'),
                    artists: ars.map(a => ({ id: String(a.id || ''), mid: '', name: a.name || '' })).filter(a => a.name),
                    album: al.name || '',
                    cover: pic ? pic.replace(/^http:\/\//, 'https://') : '',
                    interval: Math.round((it.dt || it.duration || 0) / 1000),
                    /* ★ 这首歌自己的 MV id（2026-10-04）：/cloudsearch 的歌曲对象带 `mv`
                       字段（实测「成都」=5619601），0 表示没有 MV。
                       ★ 字段名是 `mv` **不是** `mvid` —— 旧结构（/search）才叫 mvid，
                         新结构里读 mvid 恒为 undefined，所以此前一直是"没匹配上"。
                       拿到后由 mvApi.resolveMvForSong 走 /mv/detail 换成真 MV 描述符。 */
                    mvId: String(it.mv || ''),
                    source: 'netease'
                };
            });
        }
        return list.length ? list : null;
    } catch (e) {
        return null;  /* vendor 未在线/超时/结构不符 → 静默回退公网 */
    }
}

/* ★ 汽水搜索（走自建 vendor）：/api/selfhost/qishui/proxy?path=/search?keyword=&limit=
   归一化为搜索页标准字段 {id, song, singer, album, cover, interval, source}。
   为什么不并进上面的 fetchVendorSearchPage：汽水的字段名与 QQ/网易**三者互不相同**
   （title / artists[].name / coverUrl / durationMs），塞进同一个 if 链会把那个函数
   变成「按源分叉的 switch」，反而更难维护。 */
async function fetchQishuiSearchPage(word, page, want) {
    try {
        /* 一次取到第 page 页末尾（上限 100，与 server.mjs 的硬顶一致），再本地切片，
           保持与其它源一致的「翻页请求」语义。 */
        const limit = Math.min(100, Math.max(want, want * page));
        const path = `/search?keyword=${encodeURIComponent(word)}&limit=${limit}`;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        let j;
        try {
            const res = await fetch(`/api/selfhost/qishui/proxy?path=${encodeURIComponent(path)}`, { signal: ctl.signal });
            if (!res.ok) return null;
            j = await res.json();
        } finally { clearTimeout(timer); }
        if (!j || j.ok === false) return null;
        const raw = Array.isArray(j.songs) ? j.songs : [];
        const list = raw.map(it => ({
            id: String(it.id),
            song: it.title || '',
            singer: (Array.isArray(it.artists) ? it.artists : [])
                .map(a => (a && a.name) || '').filter(Boolean).join('/'),
            artists: (Array.isArray(it.artists) ? it.artists : [])
                .map(a => ({ id: String((a && a.id) || ''), mid: '', name: (a && a.name) || '', avatar: (a && a.avatarUrl) || '' }))
                .filter(a => a.name),
            album: it.album || '',
            /* 汽水封面本身是 https（p3-luna.douyinpic.com），无需像网易那样升协议 */
            cover: it.coverUrl || '',
            interval: Math.round((Number(it.durationMs) || 0) / 1000),
            source: 'qishui',
        }));
        return list.slice((page - 1) * want, page * want);
    } catch (e) {
        return null;
    }
}

async function goToSearchPage(p) {
    const cache = searchPageCache[searchSource];
    /* cache.busy：只有**同一个 cache 对象**的在飞请求才去重（同一源连点翻页）。
       别的源的 cache 有自己的 busy，互不阻塞——见 searchPageCache 处的说明。 */
    if (!cache || !cache.keyword || cache.busy) return;
    p = Math.max(1, p);
    /* 上一页不满即已到末页，禁发未缓存的更后页 */
    if (p > 1 && !cache.lastFull && !cache.pages[p]) return;
    const prevPage = cache.curPage;
    cache.curPage = p;
    if (cache.pages[p]) {
        /* 缓存命中：1→2→回1 不再请求 */
        searchResultsCache = getAllLoaded(cache);
        globalThis.searchPage = p;
        renderSearchResults(searchResultsCache);
        setHint('');
        return;
    }
    cache.busy = true;
    setHint(`第 ${p} 页搜索中...`);
    /* ★ 竞态守卫快照：await 期间用户可能切音源/改关键词——旧响应不得渲染进新视图
       （结果仍写入原 cache.pages，切回时缓存命中照常显示，只是不渲染） */
    const reqSource = searchSource;
    const reqWord = cache.keyword;
    try {
        const list = await fetchSourcePage(searchSource, cache.keyword, p);
        const stale = searchSource !== reqSource ||
                      !searchPageCache[reqSource] ||
                      searchPageCache[reqSource].keyword !== reqWord;
        cache.lastFull = (list || []).length >= cache.pageSize;
        if (list && list.length) {
            cache.pages[p] = list;
        } else if (p > 1) {
            /* 空页不落缓存，末页回退到上一有内容页 */
            cache.curPage = prevPage;
        }
        if (stale) {
            /* ★ 旧响应（切音源/换关键词）不渲染是对的，但**不能就这样 return**：
               调用方在 await 之前已经 setHint('第 N 页搜索中...') 并铺了骨架屏，
               直接返回会把提示永久留在「搜索中」、骨架屏永久挂在列表上。
               真机复现（2026-10-03）：启动阶段 loadPlaylistTrack 预加载「开篇歌单」
               会把 currentSource 改成该曲目的平台（日推首曲是网易云），把正在飞的
               自建 QQ 搜索判成 stale 丢掉 —— console 里明明有 `[Vendor] tencent
               搜索走自建服务: 第1页 60 首`，UI 却一直转圈，表现就是「自建服务从来
               没成功过」（实际成功了，结果被扔了）。
               收尾原则：新源已有缓存就把缓存顶上来；否则只清掉自己铺的那层骨架 +
               把提示交还 UI，不动音源切换 handler / 搜索历史已经渲染的内容。 */
            const live = searchPageCache[searchSource];
            /* ★ 新源自己正在飞（切源后立刻发起的那个请求）→ 别碰它的骨架屏和提示。
               否则旧源的响应会把这层骨架 hideResults() 掉、把「第 1 页搜索中...」
               抹成空白，用户看到列表闪一下又空 —— 修 cache.busy 时顺带补的一道。 */
            if (live && live.busy) return;   /* busy 由各自请求的 finally 复位 */
            if (live && Object.keys(live.pages).length) {
                searchResultsCache = getAllLoaded(live);
                globalThis.searchPage = live.curPage || 1;
                renderSearchResults(searchResultsCache);
                setHint('');
            } else {
                if (searchResultsEl && searchResultsEl.querySelector('.sk-list, .sk-row, .sk-grid')) {
                    hideResults();
                }
                setHint('');
            }
            return;   /* cache.busy 由下方 finally 复位 */
        }
        searchResultsCache = getAllLoaded(cache);
        globalThis.searchPage = cache.curPage;
        /* ★ 歌手 / MV 卡片只在第 1 页拉一次（它们是「关键词级」信息，与翻页无关）。
           ★ 2026-10-04：**提到 renderSearchResults 之前** —— 先置 pending，
             紧接着的这次渲染才会画骨架而不是留空。 */
        if (p === 1) ensureSearchExtras(reqSource, reqWord, list || []);
        if (searchResultsCache.length) renderSearchResults(searchResultsCache);
        setHint((list && list.length) ? '' : (p === 1 ? '无搜索结果' : '没有更多结果了'));
    } catch (err) {
        logError('searchEngine', '搜索出错:', err);
        cache.curPage = prevPage;
        /* 展示 fetchSourcePage 抛出的具体原因（如"QQ音乐服务暂时不可用"），否则通用提示 */
        setHint((err && err.message && String(err.message).length < 60) ? err.message : '搜索失败，请检查网络');
    } finally {
        cache.busy = false;
    }
}

sourceBtns?.forEach(btn => {
            btn?.addEventListener('click', () => {
                /* ★ 只改搜索页音源，不再顺手改写 currentSource（那是播放平台，
                   被搜索页覆盖会让「正在播放」的来源判定失真）。
                   走 setSearchSource：里面置「用户已选」粘性位 + 刷新视图
                   （占位文案 / 该源缓存 / 该源历史），与 120 打开面板时的
                   resolveSearchSource 共用同一套状态。 */
                if (!setSearchSource(btn.dataset.source)) syncSearchSourceUI();
            });
        });

/* 搜索按钮 & 回车 */
searchBtn?.addEventListener('click', searchSongs);

searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { // ★ IME 组合态（中文选词 Enter）不触发
                e.preventDefault();
                searchSongs();
            }
        });

async function searchSongs() {
            const word = searchInput.value.trim();
            if (!word) { setHint('请输入关键词'); return; }
            lastSearchKeyword[searchSource] = word;
            addSearchHistory(searchSource, word);
            hideSearchHistory();
            searchBtn.disabled = true;
            setHint('搜索中...');
            /* ★ 原为 hideResults()（清空 = 1~3 秒纯空白）。改为列表骨架，
               并走 005-skeleton 的时序规范：本机/缓存快响应不会闪骨架。
               ★ 2026-10-04：连带把「歌手 / MV」两排的骨架一起铺上（prefix）——
               此前只铺歌曲列表，顶部两排要等 extras 回来才"凭空出现"（用户报）。 */
            showResultsSkeleton(8, searchExtraRowsSkeletonHtml(searchSource));
            try {
                searchPageCache[searchSource] = {
                    keyword: word,
                    pages: {},
                    pageSize: SOURCE_PAGE_SIZE[searchSource],
                    lastFull: true,
                    curPage: 1
                };
                await goToSearchPage(1);
            } catch (err) {
                logError('searchEngine', '搜索出错:', err);
                setHint('搜索失败，请检查网络');
            } finally {
                searchBtn.disabled = false;
            }
        }

/* ★ 供歌手页的专辑卡片调用：用关键词打开搜索面板并直接检索
   （专辑详情页还没做，先给一个「点了有反应」的出口，而不是死链接）。 */
function openSearchWithKeyword(kw) {
            const word = String(kw || '').trim();
            if (!word) return;
            openSearch();
            if (searchInput) searchInput.value = word;
            searchSongs();
        }
if (typeof Aria !== 'undefined') {
            Aria.__openSearchWithKeyword = openSearchWithKeyword;
            /* ★ 搜索页音源接口（2026-10-03）：120 打开面板时调 resolveSearchSource
               校正音源（用户没选过才跟随播放平台）；setSearchSource 供显式
               指定音源（音源按钮内部直接调本地函数，外部入口用它）。 */
            Aria.resolveSearchSource = resolveSearchSource;
            Aria.setSearchSource = setSearchSource;
        }

/* 收藏/取消收藏搜索结果中的歌曲（不依赖当前播放） */
function toggleSearchResultFav(idx) {
            const item = searchResultsCache[idx];
            if (!item) return;
            const src = item.source || searchSource;
            const songKey = `${src}:${item.id}`;
            let favs = getFavorites();
            const favIdx = favs.findIndex(f => f.key === songKey);
            if (favIdx >= 0) {
                favs.splice(favIdx, 1);
            } else {
                favs.unshift({
                    key: songKey,
                    title: item.song || '未知歌曲',
                    artist: item.singer || '未知歌手',
                    cover: item.cover || '',
                    source: src,
                    id: item.id,
                    mid: item.mid || item.hash || ''
                });
            }
            saveFavorites(favs);
            /* 更新当前歌曲的收藏按钮状态 */
            if (currentSongData && currentSongData.id === item.id && (currentSongData.source === src || currentSongData.source === searchSource)) {
                currentSongKey = songKey;
                updateFavoriteBtn();
            }
            /* 重新渲染搜索结果以更新星星图标（保持当前页） */
            renderSearchResults(searchResultsCache);
            if (favoritesOverlay.classList.contains('visible')) renderFavoritesList();
        }

/* 将搜索结果中的歌曲添加到歌单 */
function addSearchResultToPlaylist(idx) {
            const item = searchResultsCache[idx];
            if (!item) return;
            const src = item.source || currentSource;
            const songKey = `${src}:${item.id}`;
            /* 临时设置 currentSongData 以便 openAddToPlaylist 使用 */
            currentSongData = {
                title: item.song || '未知歌曲',
                artist: item.singer || '未知歌手',
                cover: item.cover || '',
                source: src,
                id: item.id,
                mid: item.mid || item.hash || ''
            };
            currentSongKey = songKey;
            openAddToPlaylist();
        }

/* ★ 歌手名渲染成可点链接（297 歌手页的入口）。
   没有 artists 对象（本地音乐/酷我/老收藏）时：
   · 该源支持「按名字搜歌手」（酷狗/网易）→ 把 singer 串拆成若干条只带名字的
     链接，打开歌手页时由 artistApi 的 resolveArtistByName 解析出 id。
     —— 酷狗 mobilecdn 兜底搜索结果就没有 SingerId，不这么做整行都是死文本。
   · 其余情况退回纯文本：不能因为缺 ID 就让整行显示不出来，也不能拿名字去猜一个
     不存在的 ID（QQ/酷我没有「按名字搜歌手」的口子）。 */
function artistLinksHtml(item) {
    const src = (item && item.source) || searchSource || '';
    const cap = typeof artistSearchSupported === 'function' && artistSearchSupported(src);
    const ars = (item && Array.isArray(item.artists)) ? item.artists.filter(a => a && a.name) : [];
    const list = ars.length
        ? ars
        : (cap ? String((item && item.singer) || '').split(/[\/、,&;]+/).map(n => n.trim())
            .filter(Boolean).map(name => ({ id: '', mid: '', name })) : []);
    if (!list.length) return escapeHtml((item && item.singer) || '未知歌手');
    const srcEsc = escapeHtml(src);
    return list.map(a => `<span class="artist-link" role="button" tabindex="0"`
        + ` data-a-src="${srcEsc}"`
        + ` data-a-id="${escapeHtml(a.id || '')}"`
        + ` data-a-mid="${escapeHtml(a.mid || '')}"`
        + ` data-a-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>`)
        .join('<span class="artist-sep"> / </span>');
}

/* ==================== 歌手 / MV 卡片（2026-10-03） ====================
   形态对齐 Apple Music 的搜索页：歌曲列表上方两排横向卡片（歌手、MV）。
   为什么不是把歌手塞进歌曲行：搜「周杰伦」时用户的第一诉求往往是进歌手页，
   而不是点第 37 首翻唱；MV 则要能一键铺成动态背景。

   ★ 三源能力不同，所以这里**不是**「支持就显示、不支持就静默消失」：
     · 歌手卡：QQ 与汽水没有「按关键词搜歌手」的接口（QQ getSearchByKey 不返回
       歌手分组，汽水 vendor 未挂 artist 路由）→ 退化为「从歌曲结果里提取歌手」。
       QQ 的歌曲行本来就带 singer[{id,mid,name}]，头像按 mid 直接拼 y.gtimg.cn；
       酷狗 mobilecdn 兜底结果只有名字，就出首字母占位。永不缺一块。
     · MV 卡：只有 QQ／网易／酷狗有（汽水底层库零 video 方法），
       汽水给一行明确说明，而不是让用户对着空白猜哪里坏了。
   ★ 竞态：extras 有自己的缓存（按源 + 关键词），与歌曲分页缓存解耦——
     翻第 2/3 页不重复拉卡片；切源或换词时旧响应按 keyword 校验后丢弃。 */
globalThis.searchExtras = { tencent: null, netease: null, kugou: null, qishui: null, kuwo: null };

const MV_PLAY_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" opacity="0.9"><path d="M8 5v14l11-7z"></path></svg>';

function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* 从歌曲结果里反推歌手（QQ/汽水，以及任何 searchArtists 拿不到的时候）。
   按名字去重：同一歌手在不同歌曲里可能带不同 id（QQ 的合唱条目就是），
   但显示上必须只有一张卡。 */
function deriveArtistsFromSongs(source, songs) {
    const seen = new Set();
    const out = [];
    for (const s of (Array.isArray(songs) ? songs : [])) {
        const ars = Array.isArray(s && s.artists) ? s.artists : [];
        for (const a of ars) {
            const name = (a && a.name) || '';
            if (!name) continue;
            const key = name.replace(/\s+/g, '').toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                source,
                artistId: String((a && a.id) || ''),
                artistMid: String((a && a.mid) || ''),
                name,
                avatar: (a && a.avatar) || '',
                sub: '',
            });
            if (out.length >= 8) return out;
        }
    }
    return out;
}

/* 歌手头像：artistApi 给的优先；QQ 从歌曲里提的没有头像，用 mid 拼官方头像路径
   （T001R300x300M000<mid>，与歌手页同一个 CDN 规则）。 */
function artistAvatarOf(a) {
    if (a && a.avatar) return a.avatar;
    if (a && a.source === 'tencent' && a.artistMid) {
        return `https://y.gtimg.cn/music/photo_new/T001R300x300M000${a.artistMid}.jpg`;
    }
    return '';
}

/* ★ 同名变体去重（2026-10-03）：上游把**同一个人换个装饰符**也当成不同歌手返回 ——
   实测网易搜「周杰伦」会回 "周杰伦" / "周杰伦." / "周杰伦♚" 三条，酷狗更极端，
   6 条全是"周杰伦XX"。6 张几乎一样的卡既像 bug，又把真正不同的歌手全挤出去了。
   判据 = 去掉全部空白/标点/符号再转小写后**完全相等**才算同一人
   （`\p{P}` 标点 + `\p{S}` 符号 + `\s` 空白，用 Unicode 属性类避免逐个转义）。
   ⚠ 刻意**不做**"包含即重复"：那会把「周杰伦音乐张」也删掉，搜「周杰伦」就一张
   卡都不剩 —— 它是另一个账号，删了反而少一张真卡。宁可留一条相似的，不可全灭。 */
function artistNameKey(name) {
    return String(name || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
function dedupeArtists(list, limit = 8) {
    const seen = new Set();
    const out = [];
    for (const a of (Array.isArray(list) ? list : [])) {
        const k = artistNameKey(a && a.name);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(a);
    }
    /* ★ 有头像的排前面（2026-10-03 用户反馈"有的歌手没有头像"）：
       酷狗 type=author 的返回里混着大量 UGC 粉丝号（"周杰伦音乐集""周杰伦微博台"
       "周杰伦昆凌后援会"），它们的 Avatar 上游**恒为空**——实测连 /artist/detail
       的 sizable_avatar 也是空串，不是我们没取到，是本来就没有；而真人歌手都有头像。
       稳定分区后，一排 6 张卡基本都是有脸的真歌手，不会一上来就是几个灰圈。
       （不做"删掉没头像的"：那会在小众关键词下把整排卡删空。） */
    const withFace = out.filter(a => artistAvatarOf(a));
    const noFace = out.filter(a => !artistAvatarOf(a));
    return withFace.concat(noFace).slice(0, limit);
}

/* 无头像时的占位底色：按名字做稳定散列取色相，同一个人每次都是同一个颜色
   （随机色会让每次搜索的观感都不一样，看起来像没做完）。
   ★ 2026-10-03：散列本体抽到 utils/colorUtils.hueOfName，歌手页头部要用同一份
   （两处颜色必须一致，否则同一个人在两个页面是两个颜色）。 */

async function fetchArtistCards(source, keyword, songs) {
    if (typeof artistSearchSupported === 'function' && artistSearchSupported(source)) {
        try {
            /* 多要 2 条：同名变体被去掉后仍能凑满一排（去重只砍装饰符变体，一般只掉 1~2 条） */
            const list = await searchArtists(source, keyword, 8);
            if (list && list.length) return dedupeArtists(list, 6);
        } catch (e) {
            logWarn('searchEngine', '[Search] 歌手卡拉取失败，回落到歌曲结果提取:', e && e.message);
        }
    }
    return dedupeArtists(deriveArtistsFromSongs(source, songs), 6);
}

/* 两排卡片的**骨架**（inner，不含外层容器）。★ 2026-10-04 新增。
   用户报：「搜索的骨架屏不太对吧 只有底下的歌曲卡片的骨架 而上面歌手、mv 却没有骨架屏
   而且歌手、mv、歌曲卡片不是同时出现」。骨架的尺寸必须与真实卡片一致
   （歌手 92px / 圆头像 64px，MV 168px / 16:9 缩略图，见 styles/mv.css），
   否则内容填进来时这一排会"跳一下"。
   ★ 只铺**该源确定支持**的那一排：汽水没有 MV 能力，铺了会「出现又消失」。 */
function extraRowsSkeletonInner(src) {
    if (typeof Aria === 'undefined' || typeof Aria.__skeleton !== 'function') return '';
    const card = (cls) => `<div class="sk-shelf-card ${cls}"><div class="sk sk-banner"></div><div class="sk sk-line"></div></div>`;
    let html = '';
    /* 歌手排：所有源都可能有 —— 不支持按名字搜歌手的源会退回「从歌曲结果提取」 */
    html += '<div class="search-shelf"><div class="search-shelf-title">歌手</div>'
        + '<div class="search-shelf-row">' + card('is-artist').repeat(6) + '</div></div>';
    if (mvSearchSupported(src)) {
        html += '<div class="search-shelf"><div class="search-shelf-title">MV</div>'
            + '<div class="search-shelf-row">' + card('is-mv').repeat(6) + '</div></div>';
    }
    return html;
}

/* 含外层容器的骨架：搜索一开始就整块铺进 #searchResults。
   带上 id 是为了让 extras 回来时 refreshExtraRows 能**立刻**写入，
   而不是靠 _fillExtraRowsWhenReady 轮询等容器出现（那是骨架延迟写入留下的历史包袱）。 */
function searchExtraRowsSkeletonHtml(src) {
    const inner = extraRowsSkeletonInner(src || searchSource);
    return inner ? `<div class="search-extra" id="searchExtraRows">${inner}</div>` : '';
}

/* 两排卡片的 HTML。**只读 extras 缓存**（不做任何请求）：
   请求由 ensureSearchExtras 负责，这里被 renderSearchResults 同步调用。 */
function extraRowsHtml(src) {
    const ex = (globalThis.searchExtras && globalThis.searchExtras[src]) || null;
    const artists = (ex && ex.artists) || [];
    const mvs = (ex && ex.mvs) || [];
    const mvOk = mvSearchSupported(src);
    /* ★ 2026-10-04 改动：**还在拉的时候给骨架，而不是空串**。
       此前这里一律 return '' —— 歌曲结果先到并 settle 写入，顶部两排是空的；
       等歌手/MV 回来才"凭空冒出来"，这正是用户报的「没有骨架屏 + 三块不同时出现」。
       确实拉完了但没结果时仍然不占位（不留两个空标题）。 */
    if (!artists.length && !mvs.length) {
        if (ex && ex.pending) return extraRowsSkeletonInner(src);
        return '';
    }
    let html = '';

    if (artists.length) {
        html += '<div class="search-shelf"><div class="search-shelf-title">歌手</div><div class="search-shelf-row">';
        artists.forEach(a => {
            const avatar = artistAvatarOf(a);
            /* ★ 无头像时不再是一个灰色空圈，而是「按名字取色的**纯色**底 + 首字」
               （2026-10-03；用户明确要求纯色、不要渐变）。
               ★ 首字与头像图**同时**渲染，图盖在上面：这样能覆盖三种情况而不需要
               任何 JS ——
                 ① 上游本来就没头像（酷狗 UGC 粉丝号）→ 没有 <img>，直接是字母牌；
                 ② 有头像但图挂了（QQ 的 T001 头像路径对某些 mid 是 404）→
                    `onerror=this.remove()` 把 <img> 摘掉，底下的字母自己露出来
                    （旧实现只 remove 不兜底，于是留一个空圈，看起来就是"没头像"）；
                 ③ 图正常 → 完全盖住字母。
               ★ 色相先算成局部数字再插模板：它是 0~359 的整数，但直接写
               hueOfName(a.name) 会被 aria/no-unescaped-html 判成"文本字段未转义"。 */
            const hue = hueOfName(a.name);
            const initial = String(a.name || '?').slice(0, 1).toUpperCase();
            html += `<div class="artist-card" role="button" tabindex="0"`
                + ` data-a-src="${escapeHtml(a.source || src)}"`
                + ` data-a-id="${escapeHtml(a.artistId || '')}"`
                + ` data-a-mid="${escapeHtml(a.artistMid || '')}"`
                + ` data-a-name="${escapeHtml(a.name || '')}"`
                + ` title="${escapeHtml(a.name || '')}">`
                + `<div class="artist-card-avatar" style="--ah:${hue}">`
                + `<span class="artist-card-initial">${escapeHtml(initial)}</span>`
                + (avatar ? `<img src="${escapeHtml(avatar)}" alt="" loading="lazy" onerror="this.remove()">` : '')
                + '</div>'
                + `<div class="artist-card-name">${escapeHtml(a.name || '')}</div>`
                + (a.sub ? `<div class="artist-card-sub">${escapeHtml(a.sub)}</div>` : '')
                + '</div>';
        });
        html += '</div></div>';
    }

    if (mvs.length) {
        const cur = (typeof Aria !== 'undefined' && typeof Aria.getCurrentMv === 'function') ? Aria.getCurrentMv() : null;
        html += '<div class="search-shelf"><div class="search-shelf-title">MV'
            + '<span class="search-shelf-note">点卡片设为动态背景</span></div><div class="search-shelf-row">';
        mvs.forEach((mv, i) => {
            const playing = !!(cur && cur.source === mv.source && String(cur.mvId) === String(mv.mvId));
            const dur = fmtDur(mv.duration);
            html += `<div class="mv-card${playing ? ' playing' : ''}" role="button" tabindex="0" data-mv-idx="${i}"`
                + ` title="${escapeHtml(mv.name || '')}">`
                + '<div class="mv-card-thumb">'
                + `<img src="${escapeHtml(mv.cover || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
                + '<span class="mv-card-badge">背景中</span>'
                + `<span class="mv-card-play">${MV_PLAY_SVG}</span>`
                + (dur ? `<span class="mv-card-dur">${escapeHtml(dur)}</span>` : '')
                + '</div>'
                + `<div class="mv-card-name">${escapeHtml(mv.name || '')}</div>`
                + (mv.singer ? `<div class="mv-card-singer">${escapeHtml(mv.singer)}</div>` : '')
                + '</div>';
        });
        html += '</div></div>';
    } else if (!mvOk) {
        html += '<div class="search-shelf-empty">该音源暂不支持 MV · 切到 QQ 音乐／网易云音乐／酷狗音乐试试</div>';
    }
    return html;
}

/* 把 extras 结果补进当前结果区。★ 只改 #searchExtraRows 这一块，
   不重渲染整个列表——重渲染会把滚动位置和骨架时序全部打乱。
   ● 返回值 = 是否真的写进了 DOM。容器不存在时返回 false，由
     _fillExtraRowsWhenReady 等它出现。
   ● src 省略时按当前搜索源，显式传入时写那个源的卡片（两者一般相同；
     显式传是为了让"等容器"的轮询在用户切源后能正确收手）。 */
function refreshExtraRows(src) {
    const s = src || searchSource;
    const box = typeof document !== 'undefined' ? document.getElementById('searchExtraRows') : null;
    if (!box) return false;
    box.innerHTML = extraRowsHtml(s);
    return true;
}

/* ★ 等结果区容器出现后再补画 extras（2026-10-03 定位，这是「卡片时有时无」的根因）。
   必须"等"而不是只补一拍：结果区的真实内容由 120 的 showResults() →
   Aria.skeleton.settle() 写入，而骨架屏时序规范在**骨架已经显示过**时会延迟
   SK_MIN_VISIBLE（280ms）才把 html 落到 DOM（避免"闪一下"）。extras 通常一两百
   毫秒就回来了，那一刻 #searchExtraRows 还在骨架后面、根本没进文档。
   后果：renderSearchResults 是在拼 html 时同步读 extras 缓存的，骨架延迟写入的
   是那份**已经把 extras 固化成空串**的 html —— 写进去就是空的，之后再没有任何
   人补画。实测表现：bucket 里明明有 6 歌手/6 MV，界面却一张卡都没有。
   轮询上限 12×80ms≈1s（> 280ms 的等待窗口）；切源立即收手，不留悬挂定时器。 */
function _fillExtraRowsWhenReady(src) {
    if (refreshExtraRows(src)) return;
    let tries = 0;
    const timer = setInterval(() => {
        if (searchSource !== src || refreshExtraRows(src) || ++tries > 12) clearInterval(timer);
    }, 80);
}

async function ensureSearchExtras(src, keyword, songs) {
    const word = String(keyword || '').trim();
    if (!word || !globalThis.searchExtras) return;
    const cur = globalThis.searchExtras[src];
    if (cur && cur.keyword === word && (cur.pending || cur.done)) return;   /* 同一词只拉一次 */
    const bucket = { keyword: word, pending: true, done: false, artists: [], mvs: [] };
    globalThis.searchExtras[src] = bucket;
    /* ★ 2026-10-04：置好 pending 后**立刻补一次渲染**。
       歌曲结果通常先到，它 settle 的那一刻 extras 还没开始拉（没有 bucket），
       那一次渲染的顶部两排是空的。这里补一手把骨架画上，否则用户看到的是
       「先出歌曲、过一会儿两排卡片凭空冒出来」——正是「三块不同时出现」。 */
    if (searchSource === src) refreshExtraRows(src);
    try {
        const cardArtists = await fetchArtistCards(src, word, songs);
        /* ★ MV 的相关性基准必须是**歌曲结果里提取的歌手**，而不是上面那排歌手卡
           （2026-10-03 定位，这就是「网易云没有 MV」的根因）：
           fetchArtistCards 优先返回 searchArtists(关键词) 的产物，而搜歌名时那批歌手
           与原唱常常毫无关系 —— 搜「world.execute(me);」网易回的歌手串里没有 Mili，
           于是上游送来的 5 条 MV（头两条正是 Mili 的）全被判"歌手不符"→ 整排丢空。
           改成歌曲自带的 artists 后立刻恢复。
           ★ 只在歌曲里**拿不到任何歌手**时才退回歌手卡（本地/缺 artists 的兜底路径）；
             两者并集反而有害：搜「晴天」时歌手卡会带进"傅晴天/晴天的一天"这些同名词
             歌手，把他们的无关 MV 也放行（同一批候选，精度直接掉）。 */
        const songArtists = deriveArtistsFromSongs(src, songs);
        const relArtists = songArtists.length ? songArtists : cardArtists;
        /* ★ songs 也要传：QQ 的 MV 卡直接由"歌曲自带的 vid"生成（零请求），
           见 mvApi.js 文件头「QQ」段。 */
        /* ★ searchMvsForWord 比 searchMvs 多一层召回补救：纯歌名搜 MV 时上游常被翻唱刷满
           （实测「起风了」前 18 条全是翻唱、原唱不在池里 → 歌手筛后整排空），
           这时会用「歌名 + 原唱歌手」再搜一次。详见 mvApi 里该函数的注释。 */
        const mvs = await searchMvsForWord(src, word, { limit: 6, artists: relArtists, songs });
        if (globalThis.searchExtras[src] !== bucket) return;   /* 期间切源/换词 → 丢弃 */
        bucket.artists = cardArtists;
        bucket.mvs = mvs;
        bucket.pending = false;
        bucket.done = true;
        /* ★ 两道渲染（2026-10-03）：这一句只写"当前就在看的源"，其余源的卡片等切过去
           时由 refreshSearchSourceView / renderSearchResults 从缓存同步画出来。
           _fillExtraRowsWhenReady 负责"容器可能还没进 DOM"这件事——详见它的注释，
           那是「卡片时有时无」的根因所在。 */
        if (searchSource === src) _fillExtraRowsWhenReady(src);
    } catch (e) {
        if (globalThis.searchExtras[src] === bucket) { bucket.pending = false; bucket.done = true; }
        logWarn('searchEngine', '[Search] 歌手/MV 卡片拉取失败:', e && e.message);
    }
}

/* 点 MV 卡片 → 铺成动态背景（取址失败/极端性能模式各有明确文案） */
async function onMvCardClick(idx) {
    const ex = globalThis.searchExtras[searchSource];
    const mv = ex && ex.mvs && ex.mvs[idx];
    if (!mv) return;
    if (typeof Aria === 'undefined' || typeof Aria.setMvBackground !== 'function') return;
    setHint('MV 取址中...');
    /* force：用户手动点卡片 = 明确要看，绕过「刚失败过的 MV 冷却 30s」的自动跟随保护
       waitReady：等真拿到视频元数据再回话。"地址取到了但视频播不出来"（源站限制 /
       协议不通）以前会被报成成功，用户那边却只看到一张封面（2026-10-04 报障）。 */
    const r = await Aria.setMvBackground(mv, { force: true, waitReady: true });
    if (r && r.ok) {
        refreshExtraRows();
        setHint(`已设为动态背景：${mv.name || 'MV'} · 关闭搜索页可见`);
    } else if (r && r.reason === 'perf') {
        setHint('当前性能模式下已停用 MV 动态背景');
    } else if (r && (r.reason === 'timeout' || r.reason === 'load-error')) {
        setHint('这支 MV 的地址播不出来（源站限制），已回退封面背景');
    } else {
        setHint('这支 MV 暂时取不到播放地址');
    }
}

function renderSearchResults(list) {
            /* ★ 渲染结果前隐藏历史区：切换音源走缓存渲染的路径不经过
               searchSongs 的 hideSearchHistory，历史会残留显示在结果上方 */
            hideSearchHistory();
            const favs = getFavorites();
            const total = list.length;
            const cache = searchPageCache[searchSource];
            const curPage = (cache && cache.curPage) || 1;
            /* data-idx 为合并列表偏移：当前页之前各已缓存页长度累加 */
            const offset = (cache && Object.keys(cache.pages).length)
                ? Object.keys(cache.pages).map(Number).filter(k => k < curPage)
                    .reduce((acc, k) => acc + cache.pages[k].length, 0)
                : 0;
            const pageList = (cache && cache.pages[curPage]) || list;
            let html = '';
            /* ★ 歌手 / MV 两排横向卡片（2026-10-03）：放在「播放全部」之上，
               与歌曲列表同属一次搜索结果。内容来自 extras 缓存（同步渲染），
               抢在歌曲之前返回时由 ensureSearchExtras → refreshExtraRows 补进来。 */
            const extraHtml = extraRowsHtml(searchSource);
            html += `<div class="search-extra" id="searchExtraRows">${extraHtml}</div>`;
            /* ★ 「已加载 N 首」从面板顶部的 #searchHint 挪到这里（2026-10-03 用户反馈）：
               它统计的是**歌曲列表**，却一直挂在歌手/MV 两排卡片之上，喧宾夺主。
               放在卡片之后、「播放全部」之前，语义上正好是歌曲列表的表头。
               顶部 #searchHint 从此只承担瞬时状态（搜索中 / 无结果 / 出错）。 */
            if (total > 0) {
                html += `<div class="search-count" id="searchCount">已加载 ${total} 首</div>`;
            }
            /* 播放全部 */
            html += `
                <div class="play-all-btn" id="searchPlayAllBtn">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                    <span>播放全部（${total}）</span>
                </div>`;
            pageList.forEach((item, i) => {
                const idx = offset + i;
                const song = escapeHtml(item.song || '未知歌曲');
                const cover = escapeHtml(item.cover || '');
                const src = item.source || searchSource;
                const songKey = `${src}:${item.id}`;
                const isFav = favs.some(f => f.key === songKey);
                const isCurrent = (currentSongData && currentSongData.id === item.id && (currentSongData.source === src || currentSongData.source === searchSource));
                const statusText = isCurrent ? '正在播放' : '';
                html += `<div class="result-item" data-idx="${idx}">
                    <img class="result-cover" src="${cover}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
                    <div class="result-info">
                        <div class="result-title">${song}</div>
                        <div class="result-artist">${artistLinksHtml(item)}${item.album ? ' · ' + escapeHtml(item.album) : ''}</div>
                    </div>
                    <span class="result-status">${statusText}</span>
                    <div class="result-actions">
                        <button class="result-action-btn" data-action="addnow" data-idx="${idx}" title="加入当前播放">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"></path></svg>
                        </button>
                        <button class="result-action-btn ${isFav ? 'active-fav' : ''}" data-action="fav" data-idx="${idx}" title="${isFav ? '取消收藏' : '收藏'}">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                        </button>
                        <button class="result-action-btn" data-action="addpl" data-idx="${idx}" title="添加到歌单">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                    </div>
                </div>`;
            });
            /* 底端翻页条：真实后端分页；margin-top 与上方列表留出间隔 */
            if (total > 0 && (curPage > 1 || (cache && cache.lastFull))) {
                html += `<div class="search-pagination">
                    <button class="page-btn" data-page="${curPage - 1}" ${curPage <= 1 ? 'disabled' : ''}>上一页</button>
                    <span class="page-info">第 ${curPage} 页 · 共 ${total} 首</span>
                    <button class="page-btn" data-page="${curPage + 1}" ${(cache && cache.lastFull) ? '' : 'disabled'}>下一页</button>
                </div>`;
            }
            showResults(html);
        }
/* 点击搜索结果：翻页 / 播放歌曲 / 操作按钮 / 播放全部 */
searchResultsEl?.addEventListener('click', (e) => {
            /* ★ 歌手名优先拦截：它嵌在 .result-item 里，而整行是播放热区（见本段末尾的
               loadOnlineSong 分支）——不在这里 stopPropagation，点歌手名会连带开始播放。 */
            const aLink = e.target.closest('.artist-link');
            if (aLink) {
                e.stopPropagation();
                if (typeof Aria !== 'undefined' && typeof Aria.openArtist === 'function') {
                    Aria.openArtist({
                        source: aLink.dataset.aSrc || searchSource,
                        artistId: aLink.dataset.aId || '',
                        artistMid: aLink.dataset.aMid || '',
                        name: aLink.dataset.aName || '',
                    });
                }
                return;
            }
            /* ★ 歌手卡片（横向卡）——与上面的 .artist-link 走同一个 openArtist */
            const aCard = e.target.closest('.artist-card');
            if (aCard) {
                e.stopPropagation();
                if (typeof Aria !== 'undefined' && typeof Aria.openArtist === 'function') {
                    Aria.openArtist({
                        source: aCard.dataset.aSrc || searchSource,
                        artistId: aCard.dataset.aId || '',
                        artistMid: aCard.dataset.aMid || '',
                        name: aCard.dataset.aName || '',
                    });
                }
                return;
            }
            /* ★ MV 卡片：点一下把 MV 铺成动态背景（不跳走、不开新页） */
            const mvCard = e.target.closest('.mv-card');
            if (mvCard) {
                e.stopPropagation();
                const mi = parseInt(mvCard.dataset.mvIdx, 10);
                if (!isNaN(mi)) onMvCardClick(mi);
                return;
            }
            /* 翻页条 */
            const pgBtn = e.target.closest('.page-btn');
            if (pgBtn) {
                e.stopPropagation();
                if (!pgBtn.disabled) {
                    const p = parseInt(pgBtn.dataset.page);
                    if (!isNaN(p)) goToSearchPage(p);
                }
                return;
            }
            /* 操作按钮优先 */
            const actionBtn = e.target.closest('.result-action-btn');
            if (actionBtn) {
                e.stopPropagation();
                const idx = parseInt(actionBtn.dataset.idx);
                if (isNaN(idx)) return;
                if (actionBtn.dataset.action === 'fav') {
                    toggleSearchResultFav(idx);
                } else if (actionBtn.dataset.action === 'addpl') {
                    addSearchResultToPlaylist(idx);
                } else if (actionBtn.dataset.action === 'addnow') {
                    addSearchResultToNowPlaying(idx);
                }
                return;
            }
            /* 播放全部 */
            const playAll = e.target.closest('#searchPlayAllBtn');
            if (playAll) {
                playEntireSearchResults();
                return;
            }
            /* 播放单曲（允许中断当前加载，代际机制会自动废弃旧请求） */
            const item = e.target.closest('.result-item');
            if (!item) return;
            const idx = parseInt(item.dataset.idx);
            if (isNaN(idx) || !searchResultsCache[idx]) return;
            loadOnlineSong(searchResultsCache[idx]);
        });

/* 将搜索结果加入当前播放队列 */
function addSearchResultToNowPlaying(idx) {
            const item = searchResultsCache[idx];
            if (!item) return;
            playlist.push({
                url: null,
                title: item.song || '未知歌曲',
                artist: item.singer || '未知歌手',
                cover: item.cover || '',
                source: searchSource,
                id: item.id,
                mid: item.mid || '',
                /* 带上这首歌的 MV id，队列里播到它时 MV 背景能直接跟随（见 101）。
                   ★ 2026-10-04：mvId（网易 song.mv）也要带 —— 此前只带了 QQ 的 mvVid，
                     网易歌曲进队列后 MV 关联就丢了。 */
                mvVid: item.mvVid || '',
                mvId: item.mvId || ''
            });
        }

/* 播放搜索结果的"播放全部" */
async function playEntireSearchResults() {
            if (!searchResultsCache || searchResultsCache.length === 0) return;
            closeSearch();
            /* 构建播放队列 */
            playlist = searchResultsCache.map(item => ({
                url: null,
                title: item.song || '未知歌曲',
                artist: item.singer || '未知歌手',
                cover: item.cover || '',
                source: searchSource,
                id: item.id,
                mid: item.mid || '',
                mvVid: item.mvVid || '',
                mvId: item.mvId || ''
            }));
            currentTrackIndex = 0;
            await loadPlaylistTrack(0);
        }

export { addSearchResultToNowPlaying, addSearchResultToPlaylist, ensureSearchExtras, getLoadedSearchResults, playEntireSearchResults, renderSearchResults, searchSongs, toggleSearchResultFav };