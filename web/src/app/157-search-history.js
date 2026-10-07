/* ============================================================
 * 157-search-history.js — 搜索页「空白态面板」：热词 + 历史 + 联想词
 *
 * 2026-10-04 用户需求：「想在搜索页加热词和联想词，跟历史搜索放一起。逻辑是
 *   输入框空着显示热词和历史，输入内容就切成联想词，清空再切回热词。」
 *
 * 面板语义（三态，全在一个容器 #searchHistory 里）：
 *   · 输入为空      → 热门搜索（chips） + 历史搜索（chips，带单条删除/整组清空）
 *   · 输入有内容    → 联想词（竖排列表，命中片段高亮）
 *   · 联想词拿不到  → 退回只显示历史（宁可给用户一份能点的东西，也不留空白）
 *
 * 三条实现约定：
 *   1. **本地优先**：历史在 localStorage（按音源分开）；热词也在 localStorage
 *      缓存 24h —— 打开面板瞬间就有内容，网络回来才刷新，绝不让用户干等。
 *   2. **防抖 + 竞态**：输入停 200ms 才发请求；每次请求带自增序号，回包时若
 *      序号已被顶替 / 输入框内容已变 / 面板已关，一律丢弃 → 只显示最新一次的结果。
 *   3. **渲染与请求分离**：请求与解析在 services/searchSuggest.js（纯函数可单测）。
 * ============================================================ */
import { escapeHtml } from '../utils/formatters.js';
import { searchBtn, searchInput, searchOverlay, searchResultsEl } from './30-dom-refs.js';
import { fetchHotWords, fetchSuggestions, suggestSupported } from '../services/searchSuggest.js';
import { logCatch } from '../services/log.js';

const SEARCH_HISTORY_KEY = 'aria_search_history_v1';
const SEARCH_HOT_KEY = 'aria_search_hot_v1';
const MAX_ITEMS = 20;
const HOT_TTL = 24 * 60 * 60 * 1000;   /* 热词本地缓存有效期 */
const SUGGEST_DEBOUNCE = 200;          /* ms：输入停这么久才发联想请求 */

const searchHistoryEl = typeof document !== 'undefined' ? document.getElementById('searchHistory') : null;

/* ---------- 本地存储 ---------- */

function getHistory() {
    try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(h) {
    try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h)); } catch (e) { logCatch('searchHistory', e); }
}
function getHotCache() {
    try {
        const o = JSON.parse(localStorage.getItem(SEARCH_HOT_KEY) || '{}');
        return (o && typeof o === 'object') ? o : {};
    } catch { return {}; }
}
function saveHotCache(o) {
    try { localStorage.setItem(SEARCH_HOT_KEY, JSON.stringify(o)); } catch (e) { logCatch('searchHistory', e); }
}

/* ---------- 面板状态 ---------- */

let _hotWords = [];        /* 当前源已在内存里的热词 */
let _hotSource = '';
let _hotFetching = false;
let _suggestSeq = 0;       /* 联想词竞态序号：只认最后一次输入 */
let _suggestTimer = 0;

function isEn() {
    return Boolean(globalThis.AriaI18n && globalThis.AriaI18n.getLanguage() === 'en-US');
}
function currentWord() {
    return (searchInput && searchInput.value || '').trim();
}
function panelAlive() {
    return Boolean(searchHistoryEl && searchOverlay && searchOverlay.classList.contains('visible'));
}

/* ---------- 渲染 ---------- */

function labelHtml(text, extraHtml) {
    return `<div class="search-history-label"><span>${escapeHtml(text)}</span>${extraHtml || ''}</div>`;
}

function historyHtml(arr) {
    /* ★ 2026-10-04：渲染前去重。addSearchHistory 本身有去重，但历史是跨版本
       留在 localStorage 里的（老版本没去重的数据、以及同一词在不同音源各存一份
       后被合并的情况），用户的截图里就出现「茶汤」连着两条、「三角洲」两条。 */
    const list = Array.isArray(arr) ? arr.filter((v, i) => v && arr.indexOf(v) === i) : [];
    if (!list.length) return '';
    const clearLabel = isEn() ? 'Clear' : '清空';
    const delTitle = isEn() ? 'Remove' : '删除';
    return labelHtml(isEn() ? 'Search History' : '历史搜索',
        `<button class="search-history-clear" data-action="clear-all">${escapeHtml(clearLabel)}</button>`)
        + list.map(kw => `<div class="history-chip" data-kw="${escapeHtml(kw)}">${escapeHtml(kw)}`
            + `<span class="history-chip-del" data-action="del" data-kw="${escapeHtml(kw)}" title="${escapeHtml(delTitle)}">×</span></div>`).join('');
}

function hotHtml(words) {
    if (!words.length) return '';
    return labelHtml(isEn() ? 'Trending' : '热门搜索', '')
        + words.map(kw => `<div class="history-chip hot-chip" data-kw="${escapeHtml(kw)}">${escapeHtml(kw)}</div>`).join('');
}

/** 命中的片段包一层 <em>。按 indexOf 切分，不做正则（关键词里可能有正则元字符）。 */
function highlightHtml(text, word) {
    const t = String(text == null ? '' : text);
    const k = String(word == null ? '' : word);
    if (!k) return escapeHtml(t);
    const i = t.toLowerCase().indexOf(k.toLowerCase());
    if (i < 0) return escapeHtml(t);
    return escapeHtml(t.slice(0, i))
        + '<em>' + escapeHtml(t.slice(i, i + k.length)) + '</em>'
        + escapeHtml(t.slice(i + k.length));
}

/** 联想词面板：竖排列表 + 放大镜 + 命中高亮。 */
function renderSuggest(word, list) {
    if (!panelAlive()) return;
    let html = labelHtml(isEn() ? 'Suggestions' : '联想词', '');
    html += list.map(kw => `<div class="suggest-item" data-kw="${escapeHtml(kw)}">`
        + '<svg class="suggest-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" '
        + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">'
        + '<circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>'
        + `<span class="suggest-text">${highlightHtml(kw, word)}</span></div>`).join('');
    searchHistoryEl.innerHTML = html;
    searchHistoryEl.style.display = 'block';
}

/** 只显示历史区（联想词为空时的兜底 / 联想词不可用时的降级）。 */
function renderHistoryOnly() {
    if (!panelAlive()) return;
    const arr = getHistory()[searchSource] || [];
    if (!arr.length) { hideSearchHistory(); return; }
    searchHistoryEl.innerHTML = historyHtml(arr);
    searchHistoryEl.style.display = 'block';
}

/** 空白态：热词（本地缓存优先）+ 历史。 */
function renderIdle() {
    if (!panelAlive()) return;
    const hot = hotWordsFor(searchSource);
    const arr = getHistory()[searchSource] || [];
    if (hot.length || arr.length) {
        searchHistoryEl.innerHTML = hotHtml(hot) + historyHtml(arr);
        searchHistoryEl.style.display = 'block';
    } else {
        /* 本地真的一无所有（首次打开搜索页就是这样）——先收起面板，但**不能**
           在这里 return 掉下面的拉取：那是唯一一次能拿到热词的机会。
           ★ 这个 early-return 是本功能第一版真实写出来的缺陷（探针实测：
           空白态 display:none 且永不恢复）。 */
        hideSearchHistory();
    }
    /* 本地没有 / 过期了才回头打网络（见 refreshHotWords）；打完会再进 renderIdle 一次 */
    refreshHotWords(searchSource);
}

function hideSearchHistory() {
    if (searchHistoryEl) searchHistoryEl.style.display = 'none';
}

/* ---------- 热词：本地优先 + 后台刷新 ---------- */

function hotWordsFor(source) {
    if (_hotSource === source) return _hotWords;
    const c = getHotCache()[source];
    if (c && Array.isArray(c.words) && c.words.length) {
        _hotSource = source;
        _hotWords = c.words;
        return _hotWords;
    }
    _hotSource = source;
    _hotWords = [];
    return _hotWords;
}

async function refreshHotWords(source) {
    const c = getHotCache()[source];
    /* 本地还有效 → 一个请求都不发（用户要求"优先从本地读"） */
    if (c && Array.isArray(c.words) && c.words.length && (Date.now() - (c.at || 0)) < HOT_TTL) return;
    if (_hotFetching) return;
    _hotFetching = true;
    try {
        const words = await fetchHotWords(source);
        if (!words.length) return;
        const all = getHotCache();
        all[source] = { at: Date.now(), words };
        saveHotCache(all);
        if (source !== searchSource) return;      /* 期间切了音源 */
        _hotSource = source;
        _hotWords = words;
        /* 只有面板仍处于"空白态"才重绘：用户已经在打字的话，别把联想词盖掉 */
        if (panelAlive() && !currentWord()) renderIdle();
    } catch (e) {
        logCatch('searchHistory', e);
    } finally {
        _hotFetching = false;
    }
}

/* ---------- 联想词：防抖 + 竞态 ---------- */

function scheduleSuggest(word, source) {
    if (_suggestTimer) clearTimeout(_suggestTimer);
    if (!suggestSupported(source)) { renderHistoryOnly(); return; }
    /* 输入已变 → 先退到历史，别留着上一个词的联想结果 */
    renderHistoryOnly();
    _suggestTimer = setTimeout(async () => {
        const seq = ++_suggestSeq;
        let list = [];
        try { list = await fetchSuggestions(source, word); } catch (e) { logCatch('searchHistory', e); }
        /* ★ 三重竞态守卫（用户明确要求"保证只显示最新一次输入的结果"）：
           ① 期间又发了新请求（seq 被顶替）；② 输入框内容已不是这个词；
           ③ 面板已关闭。任一命中就丢弃这个回包。 */
        if (seq !== _suggestSeq) return;
        if (!panelAlive()) return;
        if (currentWord() !== word) return;
        if (source !== searchSource) return;
        if (!list.length) { renderHistoryOnly(); return; }
        renderSuggest(word, list);
    }, SUGGEST_DEBOUNCE);
}

/* ---------- 记录 / 视图切换 ---------- */

/** 记录一次搜索：去重后置顶，按音源分开存储 */
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

/* 结果与当前输入一致 → 保留结果；否则清空结果区，交给「热词/历史/联想词」面板 */
function updateSearchView() {
    if (!searchOverlay || !searchOverlay.classList.contains('visible')) return;
    const word = currentWord();
    const cache = globalThis.searchPageCache ? searchPageCache[searchSource] : null;
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
    if (word) {
        scheduleSuggest(word, searchSource);
    } else {
        /* 回到空白态：作废所有在飞的联想请求（回包会被 ①/② 两道守卫拦掉，
           这里再递增一次序号，让它们连"内容对得上"的机会都没有） */
        _suggestSeq++;
        if (_suggestTimer) clearTimeout(_suggestTimer);
        renderIdle();
    }
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

/* 点击热词 / 历史词 → 一键搜索并置顶（searchSongs 会自动记录并隐藏面板）；
   点 × 删除单条，点「清空」清掉当前音源全部历史（★ 均不触发搜索） */
searchHistoryEl?.addEventListener('click', (e) => {
    const del = e.target.closest('.history-chip-del');
    if (del) {
        e.stopPropagation();
        const kw = del.dataset.kw || '';
        const h = getHistory();
        h[searchSource] = (h[searchSource] || []).filter(k => k !== kw);
        saveHistory(h);
        renderIdle();
        return;
    }
    if (e.target.closest('[data-action="clear-all"]')) {
        e.stopPropagation();
        const h = getHistory();
        delete h[searchSource];
        saveHistory(h);
        renderIdle();
        return;
    }
    /* 联想词项：点了就搜 */
    const item = e.target.closest('.suggest-item');
    if (item) {
        searchInput.value = item.dataset.kw || '';
        if (searchBtn) searchBtn.click();
        return;
    }
    const chip = e.target.closest('.history-chip');
    if (!chip) return;
    const kw = chip.dataset.kw || '';
    searchInput.value = kw;
    if (searchBtn) searchBtn.click();
});

export { addSearchHistory, hideSearchHistory, updateSearchView };
