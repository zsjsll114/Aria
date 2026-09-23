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
    /* ★ 单条删除 + 清空（2026-09-22 操作性自查）：此前历史只能整体存在，
       删掉某一条必须进 localStorage 手改——每条 chip 加 × ，标签行加「清空」 */
    const isEn = (globalThis.AriaI18n && globalThis.AriaI18n.getLanguage() === 'en-US');
    const clearLabel = isEn ? 'Clear' : '清空';
    searchHistoryEl.innerHTML = '<div class="search-history-label">' + (isEn ? 'Search History' : '历史搜索') +
        '<button class="search-history-clear" data-action="clear-all">' + clearLabel + '</button></div>' +
        arr.map(kw => `<div class="history-chip" data-kw="${esc(kw)}">${esc(kw)}<span class="history-chip-del" data-action="del" data-kw="${esc(kw)}" title="${isEn ? 'Remove' : '删除'}">×</span></div>`).join('');
    searchHistoryEl.style.display = 'block';
}

/* 结果与当前输入一致 → 保留结果；否则清空结果区显示历史 */
function updateSearchView() {
    if (!searchOverlay || !searchOverlay.classList.contains('visible')) return;
    const word = searchInput.value.trim();
    const cache = globalThis.searchPageCache ? searchPageCache[currentSource] : null;
    if (cache && cache.keyword === word && Object.keys(cache.pages).length > 0) {
        hideSearchHistory();
        /* ★ 修复：输入变动后删回原词，若结果区已被清空则立即恢复渲染已缓存的结果，避免空白 */
        if (searchResultsEl && searchResultsEl.children.length === 0) {
            if (typeof globalThis.__restoreCachedSearchResults === 'function') {
                globalThis.__restoreCachedSearchResults();
            }
        }
        return;
    }
    if (searchResultsEl) searchResultsEl.innerHTML = '';
    const hintEl = document.getElementById('searchHint');
    if (hintEl) { hintEl.textContent = ''; hintEl.style.opacity = '0'; }
    renderHistory(currentSource);
}

/* ★ 清空输入按钮：在输入框内部右端，焦点进入且有内容、或输入内容时显示 */
const searchClearBtn = typeof document !== 'undefined' ? document.getElementById('searchClearBtn') : null;

function syncSearchClearBtn() {
    if (!searchClearBtn || !searchInput) return;
    const hasVal = Boolean(searchInput.value && searchInput.value.length > 0);
    searchClearBtn.style.display = hasVal ? 'inline-flex' : 'none';
}

searchInput?.addEventListener('input', () => { updateSearchView(); syncSearchClearBtn(); });
searchInput?.addEventListener('focus', () => { syncSearchClearBtn(); });
searchInput?.addEventListener('blur', () => {
    /* 延迟少许同步，避免点击清空按钮时因失焦提前隐藏导致 click 未触发 */
    setTimeout(syncSearchClearBtn, 200);
});

searchClearBtn?.addEventListener('mousedown', (e) => {
    /* 阻止 mousedown 默认行为，防止 input 提前失焦 */
    e.preventDefault();
});

searchClearBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    searchInput.value = '';
    syncSearchClearBtn();
    updateSearchView();
    searchInput.focus();
});
syncSearchClearBtn();

/* 点击历史词 → 一键搜索并置顶（searchSongs 会自动记录并隐藏历史）；
   点 × 删除单条，点「清空」清掉当前音源全部历史（★ 均不触发搜索） */
searchHistoryEl?.addEventListener('click', (e) => {
    const del = e.target.closest('.history-chip-del');
    if (del) {
        e.stopPropagation();
        const kw = del.dataset.kw || '';
        const h = getHistory();
        h[currentSource] = (h[currentSource] || []).filter(k => k !== kw);
        saveHistory(h);
        renderHistory(currentSource);
        return;
    }
    if (e.target.closest('[data-action="clear-all"]')) {
        e.stopPropagation();
        const h = getHistory();
        delete h[currentSource];
        saveHistory(h);
        renderHistory(currentSource);
        return;
    }
    const chip = e.target.closest('.history-chip');
    if (!chip) return;
    const kw = chip.dataset.kw || '';
    searchInput.value = kw;
    if (searchBtn) searchBtn.click();
});

export { addSearchHistory, hideSearchHistory, updateSearchView };
