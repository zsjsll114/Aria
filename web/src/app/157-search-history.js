/* ============================================================
 * 157-search-history.js — 搜索历史（按音源分开存储）
 * - 搜索框为空 / 改动关键词时显示历史；点击历史词一键搜索并置顶
 * - localStorage 持久化，按最近搜索时间倒序
 * ============================================================ */
import { searchBtn, searchInput, searchOverlay, searchResultsEl } from './30-dom-refs.js';

const SEARCH_HISTORY_KEY = 'aria_search_history_v1';
const MAX_ITEMS = 20;

const searchHistoryEl = typeof document !== 'undefined' ? document.getElementById('searchHistory') : null;

function getHistory() {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '{}'); } catch (e) { return {}; }
}
function saveHistory(h) {
    try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
}
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* 记录一次搜索：去重后置顶，按音源分开存储 */
function addSearchHistory(source, word) {
    word = (word || '').trim();
    if (!word) return;
    const h = getHistory();
    let arr = h[source] || [];
    arr = arr.filter(k => k !== word);
    arr.unshift(word);
    h[source] = arr.slice(0, MAX_ITEMS);
    saveHistory(h);
}

function hideSearchHistory() {
    if (searchHistoryEl) searchHistoryEl.style.display = 'none';
}

function renderHistory(source) {
    if (!searchHistoryEl) return;
    const h = getHistory();
    const arr = h[source] || [];
    if (!arr.length) { hideSearchHistory(); return; }
    searchHistoryEl.innerHTML = '<div class="search-history-label">历史搜索</div>' +
        arr.map(kw => `<div class="history-chip" data-kw="${esc(kw)}">${esc(kw)}</div>`).join('');
    searchHistoryEl.style.display = 'block';
}

/* 结果与当前输入一致 → 保留结果；否则清空结果区显示历史 */
function updateSearchView() {
    if (!searchOverlay || !searchOverlay.classList.contains('visible')) return;
    const word = searchInput.value.trim();
    const cache = globalThis.searchPageCache ? searchPageCache[currentSource] : null;
    if (cache && cache.keyword === word && Object.keys(cache.pages).length > 0) {
        hideSearchHistory();
        return;
    }
    if (searchResultsEl) searchResultsEl.innerHTML = '';
    const hintEl = document.getElementById('searchHint');
    if (hintEl) { hintEl.textContent = ''; hintEl.style.opacity = '0'; }
    renderHistory(currentSource);
}

searchInput?.addEventListener('input', updateSearchView);

/* 点击历史词 → 一键搜索并置顶（searchSongs 会自动记录并隐藏历史） */
searchHistoryEl?.addEventListener('click', (e) => {
    const chip = e.target.closest('.history-chip');
    if (!chip) return;
    const kw = chip.dataset.kw || '';
    searchInput.value = kw;
    if (searchBtn) searchBtn.click();
});

export { addSearchHistory, hideSearchHistory, updateSearchView };
