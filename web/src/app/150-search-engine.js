/* ============================================================
 * 150-search-engine.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 5787-6051 行 | 单元数: 13
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { API_BASE } from '../config/constants.js';
import { escapeHtml } from '../utils/formatters.js';
import { proxyFetch, fetchKuwoSearch, searchKugouSongs } from '../services/musicApi.js';
import { favoritesOverlay, searchBtn, searchInput, searchResultsEl, sourceBtns, searchOverlay } from './30-dom-refs.js';
import { closeSearch, getFavorites, saveFavorites, setHint, showResults, showResultsSkeleton, updateFavoriteBtn } from './120-search-results.js';
import { renderFavoritesList } from './125-favorites.js';
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
                const createPl = document.getElementById('createPlaylistModalOverlay');
                if (createPl && createPl.classList.contains('visible')) { createPl.classList.remove('visible'); return; }
                if (importPlaylistOverlay.classList.contains('visible') && !isImportingPlaylist) { importPlaylistOverlay.classList.remove('visible'); return; }
                if (addToPlaylistOverlay.classList.contains('visible')) { closeAddToPlaylist(); return; }
                const rankOv = document.getElementById('rankingsOverlay');
                const recentOv = document.getElementById('recentOverlay');
                const favOv = document.getElementById('favoritesOverlay');
                if (rankOv && rankOv.classList.contains('visible')) { rankOv.classList.remove('visible'); return; }
                if (recentOv && recentOv.classList.contains('visible')) { recentOv.classList.remove('visible'); return; }
                if (favOv && favOv.classList.contains('visible')) { favOv.classList.remove('visible'); return; }
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
globalThis.lastSearchKeyword = { tencent: '', netease: '', kugou: '', kuwo: '' };

/* 各源真实后端分页单页上限（2026-08 实测）：QQ=60 网易=20 酷狗=100 酷我=99 */
const SOURCE_PAGE_SIZE = { tencent: 60, netease: 20, kugou: 100, kuwo: 99 };
/* 每源结构：{ keyword, pages:{1:[...],2:[...]}, pageSize, lastFull, curPage } */
globalThis.searchPageCache = { tencent: null, netease: null, kugou: null, kuwo: null };
globalThis.searchPagingBusy = false;
globalThis.searchPage = 1;

function getAllLoaded(cache) {
    return Object.keys(cache.pages).map(Number)
        .sort((a, b) => a - b)
        .reduce((acc, k) => acc.concat(cache.pages[k]), []);
}

/* 供外部恢复界面：返回当前源已加载的全部结果（无缓存返回 []） */
function getLoadedSearchResults() {
    const cache = searchPageCache[currentSource];
    return (cache && Object.keys(cache.pages).length) ? getAllLoaded(cache) : [];
}

/* ★ 恢复渲染当前源已缓存的搜索结果（用于搜索框编辑后删回原词，避免空白） */
function restoreCachedSearchResults() {
    const cache = searchPageCache[currentSource];
    if (!cache || !Object.keys(cache.pages).length) return;
    const loaded = getAllLoaded(cache);
    if (!loaded.length) return;
    searchResultsCache = loaded;
    globalThis.searchPage = cache.curPage || 1;
    renderSearchResults(loaded);
    setHint(`已加载 ${loaded.length} 首`);
}
globalThis.__restoreCachedSearchResults = restoreCachedSearchResults;

async function fetchSourcePage(source, word, page) {
    /* ★ 不再静默切换到其它源：
       用户选"QQ音乐"就是想搜 QQ 的歌——接口无结果/失败时明确报错提示，由用户自行切换音源，
       避免"搜索接到酷我里"(接到酷我后还常遇到 VIP 播不了、没歌词的双重问题)。 */
    if (source === 'kugou') {
        const r = await searchKugouSongs(word, page, SOURCE_PAGE_SIZE.kugou);
        if (r && r.success && r.list && r.list.length) return r.list;
        logWarn('searchEngine', '[Search] 酷狗搜索无结果，不自动切换到其它源');
        throw new Error('酷狗搜索暂无结果，可尝试点击顶部音源切换');
    }
    if (source === 'kuwo') return await fetchKuwoSearch(word, SOURCE_PAGE_SIZE.kuwo, page);
    /* ★ 自建 vendor 优先（2026-09-22）：vkeys.cn 公网上游极不稳定（超时/限流/QQ单页
       从 100 缩水到 60），用户登录自建服务后搜索走本机 vendor——毫秒级回包、
       登录态稳定、单页 100 首足量；失败/未在线静默回退公网 vkeys。 */
    const vendorHit = await fetchVendorSearchPage(source, word, page, 100);
    if (vendorHit && vendorHit.length) {
        logInfo('searchEngine', `[Vendor] ${source} 搜索走自建服务: 第${page}页 ${vendorHit.length} 首`);
        return vendorHit;
    }
    /* netease / tencent：走本地代理拉取 vkeys（避免浏览器直连跨域被拦），code!=200 或 data 为空时明确报错 */
    let json = { code: 0 };
    try {
        const res = await proxyFetch(`${API_BASE}/${source}?word=${encodeURIComponent(word)}&num=${SOURCE_PAGE_SIZE[source]}&page=${page}`, { timeout: 4500 });
        json = await res.json().catch(() => ({ code: 0 }));
    } catch (_) { /* 见下方统一报错 */ }
    const okList = (json.code === 200 && json.data) ? (Array.isArray(json.data) ? json.data : [json.data]) : [];
    if (okList.length) return okList;
    const srcName = source === 'tencent' ? 'QQ音乐' : '网易云';
    logWarn('searchEngine', `[Search] ${source} vkeys 无结果(code=${json.code})，不自动切换到其它源`);
    throw new Error(`${srcName}搜索${json.code === 503 ? '服务暂时不可用(503)' : '暂无结果'}，可尝试点击顶部音源切换`);
}

/* ★ 自建 vendor 搜索：QQ=/getSearchByKey（KuGouMusicApi 同系）、网易=/search（NeteaseCloudMusicApi）。
   统一规范化为搜索页标准字段 {id, mid, song, singer, album, cover, interval, source}。
   任何失败（副进程离线/超时/无结果）返回 null，由调用方回退公网 vkeys。 */
async function fetchVendorSearchPage(source, word, page, want) {
    try {
        let path;
        if (source === 'tencent') {
            path = `/getSearchByKey?key=${encodeURIComponent(word)}&num=${want}&page=${page}`;
        } else if (source === 'netease') {
            path = `/search?keywords=${encodeURIComponent(word)}&limit=${want}&offset=${(page - 1) * want}&type=1`;
        } else {
            return null;
        }
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(`/api/selfhost/${source}/proxy?path=${encodeURIComponent(path)}`, { signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const j = await res.json();
        let list = [];
        if (source === 'tencent') {
            const raw = (((j.response || {}).data || {}).song || {}).list || [];
            list = raw.map(it => ({
                id: it.songmid,
                mid: it.songmid,
                song: it.songname || '',
                singer: Array.isArray(it.singer) ? it.singer.map(s => s.name).join('/') : (it.singer || ''),
                album: it.albumname || '',
                cover: it.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${it.albummid}.jpg` : '',
                interval: parseInt(it.interval) || 0,
                source: 'tencent'
            }));
        } else {
            const raw = ((j.result || {}).songs) || [];
            list = raw.map(it => ({
                id: String(it.id),
                song: it.name || '',
                singer: Array.isArray(it.artists) ? it.artists.map(a => a.name).join('/') : '',
                album: (it.album && it.album.name) || '',
                cover: (it.album && it.album.picUrl) || '',
                interval: Math.round((it.duration || 0) / 1000),
                source: 'netease'
            }));
        }
        return list.length ? list : null;
    } catch (e) {
        return null;  /* vendor 未在线/超时/结构不符 → 静默回退公网 */
    }
}

async function goToSearchPage(p) {
    const cache = searchPageCache[currentSource];
    if (!cache || !cache.keyword || searchPagingBusy) return;
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
        setHint(`已加载 ${searchResultsCache.length} 首`);
        return;
    }
    searchPagingBusy = true;
    setHint(`第 ${p} 页搜索中...`);
    /* ★ 竞态守卫快照：await 期间用户可能切音源/改关键词——旧响应不得渲染进新视图
       （结果仍写入原 cache.pages，切回时缓存命中照常显示，只是不渲染） */
    const reqSource = currentSource;
    const reqWord = cache.keyword;
    try {
        const list = await fetchSourcePage(currentSource, cache.keyword, p);
        const stale = currentSource !== reqSource ||
                      !searchPageCache[reqSource] ||
                      searchPageCache[reqSource].keyword !== reqWord;
        cache.lastFull = (list || []).length >= cache.pageSize;
        if (list && list.length) {
            cache.pages[p] = list;
        } else if (p > 1) {
            /* 空页不落缓存，末页回退到上一有内容页 */
            cache.curPage = prevPage;
        }
        if (stale) { searchPagingBusy = false; return; }   /* 旧响应：只落缓存不渲染 */
        searchResultsCache = getAllLoaded(cache);
        globalThis.searchPage = cache.curPage;
        if (searchResultsCache.length) renderSearchResults(searchResultsCache);
        setHint((list && list.length) ? `已加载 ${searchResultsCache.length} 首` : (p === 1 ? '无搜索结果' : '没有更多结果了'));
    } catch (err) {
        logError('searchEngine', '搜索出错:', err);
        cache.curPage = prevPage;
        /* 展示 fetchSourcePage 抛出的具体原因（如"QQ音乐服务暂时不可用"），否则通用提示 */
        setHint((err && err.message && String(err.message).length < 60) ? err.message : '搜索失败，请检查网络');
    } finally {
        searchPagingBusy = false;
    }
}

sourceBtns?.forEach(btn => {
            btn?.addEventListener('click', () => {
                if (btn.dataset.source === currentSource) return;
                sourceBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentSource = btn.dataset.source;
                searchInput.value = lastSearchKeyword[currentSource] || '';
                searchInput.placeholder = currentSource === 'tencent' ? '搜索QQ音乐歌曲...' : (currentSource === 'kugou' ? '搜索酷狗音乐歌曲...' : (currentSource === 'kuwo' ? '搜索酷我音乐歌曲...' : '搜索网易云歌曲...'));
                const loaded = getLoadedSearchResults();
                if (loaded.length) {
                    searchResultsCache = loaded;
                    renderSearchResults(loaded);
                    setHint(`已加载 ${loaded.length} 首`);
                } else {
                    searchResultsEl.innerHTML = '';
                    setHint('');
                    /* ★ 切换音源且无缓存结果时，渲染该音源的历史搜索 */
                    updateSearchView();
                }
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
            lastSearchKeyword[currentSource] = word;
            addSearchHistory(currentSource, word);
            hideSearchHistory();
            searchBtn.disabled = true;
            setHint('搜索中...');
            /* ★ 原为 hideResults()（清空 = 1~3 秒纯空白）。改为列表骨架，
               并走 005-skeleton 的时序规范：本机/缓存快响应不会闪骨架。 */
            showResultsSkeleton(8);
            try {
                searchPageCache[currentSource] = {
                    keyword: word,
                    pages: {},
                    pageSize: SOURCE_PAGE_SIZE[currentSource],
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

/* 收藏/取消收藏搜索结果中的歌曲（不依赖当前播放） */
function toggleSearchResultFav(idx) {
            const item = searchResultsCache[idx];
            if (!item) return;
            const src = item.source || currentSource;
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
            if (currentSongData && currentSongData.id === item.id && (currentSongData.source === src || currentSongData.source === currentSource)) {
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

function renderSearchResults(list) {
            /* ★ 渲染结果前隐藏历史区：切换音源走缓存渲染的路径不经过
               searchSongs 的 hideSearchHistory，历史会残留显示在结果上方 */
            hideSearchHistory();
            const favs = getFavorites();
            const total = list.length;
            const cache = searchPageCache[currentSource];
            const curPage = (cache && cache.curPage) || 1;
            /* data-idx 为合并列表偏移：当前页之前各已缓存页长度累加 */
            const offset = (cache && Object.keys(cache.pages).length)
                ? Object.keys(cache.pages).map(Number).filter(k => k < curPage)
                    .reduce((acc, k) => acc + cache.pages[k].length, 0)
                : 0;
            const pageList = (cache && cache.pages[curPage]) || list;
            let html = '';
            /* 播放全部 */
            html += `
                <div class="play-all-btn" id="searchPlayAllBtn">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M6 4l14 8-14 8V4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path></svg>
                    <span>播放全部（${total}）</span>
                </div>`;
            pageList.forEach((item, i) => {
                const idx = offset + i;
                const song = escapeHtml(item.song || '未知歌曲');
                const singer = escapeHtml(item.singer || '未知歌手');
                const cover = escapeHtml(item.cover || '');
                const src = item.source || currentSource;
                const songKey = `${src}:${item.id}`;
                const isFav = favs.some(f => f.key === songKey);
                const isCurrent = (currentSongData && currentSongData.id === item.id && (currentSongData.source === src || currentSongData.source === currentSource));
                const statusText = isCurrent ? '正在播放' : '';
                html += `<div class="result-item" data-idx="${idx}">
                    <img class="result-cover" src="${cover}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
                    <div class="result-info">
                        <div class="result-title">${song}</div>
                        <div class="result-artist">${singer}${item.album ? ' · ' + escapeHtml(item.album) : ''}</div>
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
                source: currentSource,
                id: item.id,
                mid: item.mid || ''
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
                source: currentSource,
                id: item.id,
                mid: item.mid || ''
            }));
            currentTrackIndex = 0;
            await loadPlaylistTrack(0);
        }

export { addSearchResultToNowPlaying, addSearchResultToPlaylist, getLoadedSearchResults, playEntireSearchResults, renderSearchResults, searchSongs, toggleSearchResultFav };