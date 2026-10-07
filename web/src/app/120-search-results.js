/* ============================================================
 * 120-search-results.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3542-3659 行 | 单元数: 15
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { FAV_STORAGE_KEY } from '../config/constants.js';
import { favoriteBtn, favoritesHintEl, favoritesOverlay, openSearchBtn, searchCloseBtn, searchInput, searchOverlay, searchResultsEl, sourceBtns } from './30-dom-refs.js';
import { kbExitNavMode } from './110-keyboard-nav.js';
import { renderFavoritesList } from './125-favorites.js';
import { ensureSearchExtras, getLoadedSearchResults, renderSearchResults } from './150-search-engine.js';
import { debouncedSaveConfigToBackend } from './180-boot-config.js';
import { updateSearchView } from './157-search-history.js';
import { logInfo, logWarn, logError } from '../services/log.js';

/* 点击页面时退出导航模式（用户改用鼠标了） */
if (typeof document !== "undefined") document.addEventListener('mousedown', function() {
            if (kbNavActive) kbExitNavMode();
        });

function setHint(text) {
            if (!searchHintEl) {
                searchHintEl = document.getElementById('searchHint');
            }
            if (searchHintEl) {
                searchHintEl.textContent = text;
                searchHintEl.style.opacity = text ? '1' : '0';
            }
        }

function openSearch() {
searchOverlay.classList.add('visible');
/* ★ 打开面板时校正搜索音源（2026-10-03）：
     · 用户还没自己选过源 → 采纳「正在播放的平台」（合法时）；
     · 用户选过 → 保持他用过的那个，播放/切歌一律不改写搜索页。
   此前这里直接拿 currentSource 当音源：正在播本地文件时它是 'local'，五个音源按钮
   一个都不亮，搜索又拿 'local' 去查 → 必然搜不出任何东西（用户报的
   「有时没有源被选中，这时搜索没有任何内容，但历史区有词」）。见 150 的搜索页音源段。 */
if (typeof Aria !== 'undefined' && typeof Aria.resolveSearchSource === 'function') {
    Aria.resolveSearchSource(currentSource);
}
const src = (globalThis.searchSource) || 'tencent';
sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === src));
searchInput.value = lastSearchKeyword[src] || '';
/* ★ 占位文案不再在这里手写第二份：单一真相是 150 的 sourcePlaceholder，
   上面的 Aria.resolveSearchSource 已经通过 syncSearchSourceUI 设好了。
   （此前这里维护着另一张表，出现过「停在酷我页签却显示网易文案」的漂移。） */
const cached = getLoadedSearchResults();
const cacheObj = globalThis.searchPageCache ? globalThis.searchPageCache[src] : null;
if (cached.length > 0) {
searchResultsCache = cached;
renderSearchResults(cached);
}
/* ★ 先把视图交给 updateSearchView（它负责「输入词与缓存不一致时显示历史」），
   再补结果与数量标签（2026-10-03）：
     · 上一次点歌播放时 loadOnlineSong 写下的「加载中...」会一直挂在顶部 hint 上，
       于是「明明搜完了，关掉再打开却显示加载中」——这里必须清掉；
     · 「已加载 N 首」现在由 renderSearchResults 画在歌曲列表头部（歌手/MV 卡片
       之下），不再走顶部 hint，所以下面只需保证结果区有内容即可；
     · 顺序放在 updateSearchView **之后**是关键：它有「关键词对不上就清空结果区 +
       清空 hint + 铺历史」的分支，写在它前面会被整段抹掉（真机复现过）。 */
updateSearchView();
if (cached.length > 0 && cacheObj && cacheObj.keyword === searchInput.value.trim()) {
searchResultsCache = cached;
if (searchResultsEl && searchResultsEl.children.length === 0) renderSearchResults(cached);
setHint('');
/* ★ 歌曲有缓存、但歌手/MV 卡片从没拉过时补拉（ensureSearchExtras 自带去重，
   已拉过的同一关键词会立刻返回，不会重复请求）。 */
if (cacheObj.keyword) ensureSearchExtras(src, cacheObj.keyword, cached);
}
setTimeout(() => searchInput.focus(), 50);
}

function closeSearch() {
            searchOverlay.classList.remove('visible');
        }

openSearchBtn?.addEventListener('click', openSearch);

searchCloseBtn?.addEventListener('click', closeSearch);

/* 点击遮罩空白处关闭 */
searchOverlay?.addEventListener('click', (e) => {
            if (e.target === searchOverlay) closeSearch();
        });

/* ESC 关闭 —— ★ 2026-10-05（P3-b）移到 150-search-engine.js 的「逐层 ESC」链。
   此处原有一份独立 handler，与 150 的那份**同一次 ESC 会连关两层**：
   document(本处) 先于 window(150) 触发，本处关掉搜索页后，150 的逐层链
   继续往下判到更底层的浮层（如收藏页）再关一次。
   现在 ESC 只有一处实现：150 的逐层链（顺序即层序）。 */

function showResults(html) {
/* ★ 走骨架时序规范（005-skeleton.js）：骨架没出现过就同步写入（与旧行为一致），
   出现过则补足最短展示时长再替换，避免"闪一下"。 */
if (Aria.skeleton) Aria.skeleton.settle(searchResultsEl, html);
else searchResultsEl.innerHTML = html;
/* 搜索结果滚动复位到顶端 */
searchResultsEl.scrollTop = 0;
}

/* ★ 搜索中骨架：原先这里是 hideResults() 把面板清空，而搜索要过第三方接口
   （常 1~3s），用户面对的是纯空白。改成列表骨架，让等待有明确形状。
   `prefix` 用来在歌曲列表骨架**之上**再铺「歌手 / MV」两排卡片骨架（150 传进来）——
   只铺歌曲那一段会让顶部两排要等 extras 回来才出现，三块不同时到位（用户 2026-10-04 报）。 */
function showResultsSkeleton(n, prefix) {
if (!searchResultsEl) return;
const num = n || 8;
const pre = prefix || '';
if (Aria.skeleton) Aria.skeleton.load(searchResultsEl, 'list', num, { prefix: pre });
else searchResultsEl.innerHTML = pre + ((typeof Aria.__skeleton === 'function') ? Aria.__skeleton('list', num) : '');
}

function hideResults() {
/* ★ 必须先取消挂起的骨架定时器：否则 150ms 后骨架会把清空的面板又填回来 */
if (Aria.skeleton) Aria.skeleton.cancel(searchResultsEl);
searchResultsEl.innerHTML = '';
}

/* ========== 收藏功能（localStorage 持久化） ========== */
function getFavorites() {
            try {
                return JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
            } catch (e) { return []; }
        }

function saveFavorites(list) {
            try {
                localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(list));
                if (typeof debouncedSaveConfigToBackend === 'function') debouncedSaveConfigToBackend();
            } catch (e) { logError('searchResults', '保存收藏失败:', e); }
        }

/* 生成当前歌曲的唯一标识：在线歌曲用 source+id，本地文件用 url */
function makeSongKey(song) {
            if (!song) return '';
            if (song.source && song.id) return `${song.source}:${song.id}`;
            return 'local:' + (song.url || song.title || '');
        }

/* 更新标题旁收藏按钮的激活状态 */
function updateFavoriteBtn() {
            const favs = getFavorites();
            const isFav = favs.some(f => f.key === currentSongKey);
            favoriteBtn.classList.toggle('active', isFav);
            favoriteBtn.dataset.tooltip = isFav ? '取消收藏' : '收藏';
        }

/* ★ 收藏切换核心（120/130/245/258/259 五处调用点统一）：
   按 key 查（兼容历史收藏无 key 字段，用 makeSongKey 重算兜底）→ 移除/新增 → 持久化。
   新增项统一标准字段并 unshift 置顶（收藏列表新收藏在最上）。
   返回 { idx, faved }（faved=是否新增），调用方各自做 UI 副反应。 */
function toggleFavCore(song, opts) {
            const favs = getFavorites() || [];
            const key = (opts && opts.key) || makeSongKey(song);
            const idx = favs.findIndex(f => f.key === key || (f && makeSongKey(f) === key));
            if (idx >= 0) {
                favs.splice(idx, 1);
            } else {
                favs.unshift({
                    key,
                    title: song.title || song.song || song.name || '',
                    artist: song.artist || song.singer || '',
                    cover: song.cover || '',
                    source: song.source || '',
                    id: song.id != null ? String(song.id) : '',
                    mid: song.mid || ''
                });
            }
            saveFavorites(favs);
            return { idx, faved: idx < 0 };
        }

/* 切换当前歌曲收藏状态 */
function toggleFavorite() {
            if (!currentSongData) { favoritesHintEl.textContent = '请先播放歌曲'; return; }
            toggleFavCore(currentSongData, { key: currentSongKey });
            updateFavoriteBtn();
            if (favoritesOverlay.classList.contains('visible')) renderFavoritesList();
        }

export { closeSearch, getFavorites, hideResults, makeSongKey, openSearch, saveFavorites, setHint, showResults, showResultsSkeleton, toggleFavCore, toggleFavorite, updateFavoriteBtn };
