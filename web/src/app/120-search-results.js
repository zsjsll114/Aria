/* ============================================================
 * 120-search-results.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 3542-3659 行 | 单元数: 15
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { FAV_STORAGE_KEY } from '../config/constants.js';
import { favoriteBtn, favoritesHintEl, favoritesOverlay, openSearchBtn, searchCloseBtn, searchInput, searchOverlay, searchResultsEl, sourceBtns } from './30-dom-refs.js';
import { kbExitNavMode } from './110-keyboard-nav.js';
import { renderFavoritesList } from './125-favorites.js';
import { getLoadedSearchResults, renderSearchResults } from './150-search-engine.js';
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
/* 同步源按钮状态，确保 UI 与 currentSource 一致 */
sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === currentSource));
searchInput.value = lastSearchKeyword[currentSource] || '';
searchInput.placeholder = currentSource === 'tencent' ? '搜索QQ音乐歌曲...' : (currentSource === 'kugou' ? '搜索酷狗音乐歌曲...' : '搜索网易云歌曲...');
const cached = getLoadedSearchResults();
if (cached.length > 0) {
searchResultsCache = cached;
renderSearchResults(cached);
}
/* ★ 打开面板时同步渲染该音源的搜索历史（无缓存结果时展示历史，避免重启后历史"消失"） */
updateSearchView();
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

/* ESC 关闭 */
if (typeof document !== "undefined") document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && searchOverlay.classList.contains('visible')) {
                closeSearch();
            }
        });

function showResults(html) {
/* ★ 走骨架时序规范（005-skeleton.js）：骨架没出现过就同步写入（与旧行为一致），
   出现过则补足最短展示时长再替换，避免"闪一下"。 */
if (Aria.skeleton) Aria.skeleton.settle(searchResultsEl, html);
else searchResultsEl.innerHTML = html;
/* 搜索结果滚动复位到顶端 */
searchResultsEl.scrollTop = 0;
}

/* ★ 搜索中骨架：原先这里是 hideResults() 把面板清空，而搜索要过第三方接口
   （常 1~3s），用户面对的是纯空白。改成列表骨架，让等待有明确形状。 */
function showResultsSkeleton(n) {
if (!searchResultsEl) return;
const num = n || 8;
if (Aria.skeleton) Aria.skeleton.load(searchResultsEl, 'list', num);
else searchResultsEl.innerHTML = (typeof Aria.__skeleton === 'function') ? Aria.__skeleton('list', num) : '';
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
