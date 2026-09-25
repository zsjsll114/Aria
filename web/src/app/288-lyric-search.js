/* ============================================================
 * 288-lyric-search.js — 歌词内搜索（todos #2）
 *
 * 输入一句歌词 → 定位到「哪首歌的哪一句」→ 点一下就播到那一句。
 * 范围：当前歌 + 收藏 + 自建歌单 + 最近播放；索引在 services/lyricIndex.js
 * （IndexedDB 独立库，不进 user_config.json——那份已经 161KB）。
 *
 * 分工：本分片只管「取词、排期、渲染、跳转」，匹配/排序/增量算法都在
 * lyricIndex 里（纯函数，tests/js/test_lyric_index.js 覆盖）。
 * 取词是网络请求，所以后台扫描按 requestIdleCallback 一片一次、一片一首歌；
 * 播放加载中（state.isLoadingSong）与窗口隐藏时自动让路。稳态每 8s 复查一次
 * 来源指纹，收藏/歌单变了才补建，没变就只是几个字符串比较。
 *
 * 浮层复用 .search-overlay / .search-modal 两个类根（约束 15：显隐走共享的
 * opacity+visibility 机制；约束 16：毛玻璃照搜索页配方，样式在
 * styles/lyric-search.css）。入口按钮自建自挂，index.html 不接线也能用。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { getFavorites, setHint } from './120-search-results.js';
import { getPlaylists } from './130-playlists.js';
import { getRecentHistory } from './258-rankings.js';
import { loadOnlineSong } from './175-track-index-online.js';
import { sanitizeImageUrl } from './100-cover-background.js';
import { showToast } from './155-random-toast-match.js';
import { sourceBtns } from './30-dom-refs.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { state } from '../infrastructure/state.js';
import { esc, formatTime } from '../utils/formatters.js';
import { logCatch, logInfo } from '../services/log.js';
import { detectAndParseLyrics, mergeLyrics } from '../parsers/lyricMerger.js';
import { fetchLyricWithFallback } from '../services/musicApi.js';
import {
    buildDoc,
    buildEmptyDoc,
    clearIndex,
    getCachedDocs,
    indexStats,
    isLoaded,
    lineTextOf,
    loadIndex,
    mergeDesired,
    normText,
    planSync,
    probeStore,
    putDocs,
    removeDocs,
    search,
    songKeyOf,
} from '../services/lyricIndex.js';

const TAG = 'lyricSearch';
const ROOT_ID = 'lyricSearchOverlay';
const INPUT_ID = 'lyricSearchInput';
const BTN_ID = 'lyricSearchBtn';

const PUMP_STEADY_MS = 8000;
const PUMP_FAST_MS = 1500;
const FETCH_GAP_MS = 140;
const PLAN_MIN_MS = 1500;
const MAX_INFLIGHT = 3;
const BUSY_BACKOFF_MS = 1200;
const HIDDEN_BACKOFF_MS = 5000;
const SEARCH_DEBOUNCE_MS = 180;
const RESULT_LIMIT = 80;
const FAST_TRIES = 6;

/* 中文串在这里各出现一次，英文由 core/i18n.js 的 STATIC_PHRASE_MAP 负责
   （约束 7：单一登记处，分片不另建双语表）。带数字的句子把数字拆成独立 <b>
   节点、单位留在相邻的静态 span 里，否则整句命中不了词表的精确匹配。 */
const T = {
    title: '歌词内搜索',
    close: '关闭',
    placeholder: '输入一句歌词，查找是哪首歌的哪一句',
    ariaInput: '输入歌词',
    go: '搜索',
    clear: '清空',
    tipIdle: '歌词内搜索',
    tipBuilding: '歌词内搜索 · 索引建立中',
    reindex: '重新索引',
    tipReindex: '清空并重建歌词索引（会重新向音源取词）',
    scopeTitle: '范围',
    stateInputTitle: '输入一句歌词',
    stateInputDesc: '在当前歌曲、收藏、歌单、最近播放里找它的出处',
    stateNoMatch: '没有匹配的歌词',
    stateNoMatchHint: '换个说法试试：少打几个字、去掉标点也能命中',
    stateEmptyIndexHint: '还没有可搜索的歌词，先收藏几首歌或让索引在后台跑一会儿',
    stateBuilding: '正在后台建立歌词索引',
    stateReady: '索引就绪',
    stateUnavailable: '浏览器禁用了本地存储，歌词索引不可用',
    labelIndexed: '已索引',
    labelUnit: '首',
    labelLines: '歌词行',
    labelScanned: '查询范围',
    labelHits: '命中歌词行',
    labelSongs: '歌曲',
    tipHits: '命中句数',
    loadingJump: '正在跳转到那一句…',
    unplayable: '这首歌没有可用的在线来源，请手动播放后再跳',
    jumpFailed: '跳转失败',
    reindexDone: '歌词索引已清空，正在重新建立',
};

const SCOPE_LABEL = { current: '当前', favorite: '收藏', playlist: '歌单', recent: '最近' };
const SOURCE_LABEL = { tencent: 'QQ', netease: '网易', kugou: '酷狗', kuwo: '酷我' };

function d() { return typeof document !== 'undefined' ? document : null; }
function byId(id) { const dd = d(); return dd ? dd.getElementById(id) : null; }
function num(v) { return String(Math.max(0, Math.round(Number(v) || 0))); }

/* ---------- 来源读取 ---------- */

function safeList(fn) {
    try {
        const v = typeof fn === 'function' ? fn() : null;
        return Array.isArray(v) ? v : [];
    } catch (e) { logCatch(TAG, e); return []; }
}

function playlistSongs() {
    const out = [];
    for (const pl of safeList(getPlaylists)) {
        if (pl && Array.isArray(pl.songs)) out.push(...pl.songs);
    }
    return out;
}

/* 只有 source + 平台 id 的歌取得到词；本地 blob 文件（url 刷新即失效）不排进队列 */
function indexable(song) {
    if (!song || !song.source) return false;
    return !!(song.id || song.mid || song.hash);
}

function currentPair() {
    const song = state.currentSongData || null;
    const lyrics = Array.isArray(state.lyrics) ? state.lyrics : [];
    return { song, lyrics, key: song ? songKeyOf(song) : '' };
}

function buildDesired() {
    const cur = currentPair();
    const lists = [];
    if (cur.key) lists.push({ scope: 'current', items: [cur.song], lines: cur.lyrics });
    lists.push({ scope: 'favorite', items: safeList(getFavorites).filter(indexable) });
    lists.push({ scope: 'playlist', items: playlistSongs().filter(indexable) });
    lists.push({ scope: 'recent', items: safeList(getRecentHistory).filter(indexable) });
    return mergeDesired(lists);
}

function hashKeys(desired) {
    let h = 2166136261;
    for (const d2 of desired) {
        const s = d2.key + ',' + d2.scopes.join('+');
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    }
    return h >>> 0;
}

/* ---------- 后台索引泵 ---------- */

let _queue = [];
let _lastSig = '';
let _force = false;
let _running = false;
let _started = false;
let _pumpTimer = null;
let _phase = 'building';
let _fastTries = FAST_TRIES;
let _lastPlanAt = 0;
let _inflight = 0;
let _pruneArm = null;
const _flight = new Set();

function schedule(delayMs) {
    if (!d()) return;
    if (_pumpTimer) clearTimeout(_pumpTimer);
    _pumpTimer = setTimeout(() => { _pumpTimer = null; idle(tick); }, delayMs);
}

function idle(cb) {
    const w = typeof window !== 'undefined' ? window : null;
    if (w && typeof w.requestIdleCallback === 'function') {
        w.requestIdleCallback(deadline => cb(deadline), { timeout: 2500 });
        return;
    }
    setTimeout(() => cb({ timeRemaining: () => 6, didTimeout: false }), 120);
}

function setPhase(p) {
    if (_phase === p) return;
    _phase = p;
}

function pendingCount() { return _queue.length + _inflight; }

/** 当前歌已切换但歌词还没渲染出来：快查几轮，别让它等满 8 秒 */
function needsFastPass() {
    const cur = currentPair();
    return !!(cur.key && !cur.lyrics.length && _fastTries > 0);
}

async function ensureLoaded() {
    if (isLoaded()) return true;
    if (!(await probeStore())) { setPhase('unavailable'); return false; }
    await loadIndex();
    if (!isLoaded()) { setPhase('unavailable'); return false; }
    return true;
}

async function fetchAndIndex(entry) {
    const song = entry.song;
    let next = null;
    let reason = '';
    try {
        const data = await fetchLyricWithFallback(song, song.source || state.currentSource || '');
        const parsed = detectAndParseLyrics(data);
        const merged = mergeLyrics(parsed.originals || [], parsed.translations || [], parsed.romaji || []);
        next = buildDoc(song, merged, entry.scopes, { key: entry.key });
        if (!next) reason = 'no-lyric';
    } catch (e) {
        reason = (e && e.message) || 'error';
        logCatch(TAG, e);
    }
    await putDocs([next || buildEmptyDoc(song, entry.scopes, reason)]);
}

function sameKeys(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (const k of a) { if (!b.includes(k)) return false; }
    return true;
}

/**
 * 删除是不可逆的，而 boot 期 localStorage 可能还没从 user_config.json 同步回来——
 * 那一刻「期望集合」近乎为空，直接 prune 会把整份索引抹掉（表现为「昨天还能搜，
 * 今天全空」）。所以 prune 必须「同一指纹连续两轮给出同一批 key」才动手。
 */
async function applyPrune(keys, sig, desiredCount, now) {
    if (!keys.length || !desiredCount) { _pruneArm = null; return; }
    const arm = _pruneArm;
    if (arm && arm.sig === sig && sameKeys(arm.keys, keys) && (now - arm.at) >= PLAN_MIN_MS) {
        _pruneArm = null;
        await removeDocs(keys);
        logInfo(TAG, `移出索引 ${keys.length} 首（来源里已不存在）`);
        return;
    }
    _pruneArm = { sig, keys: keys.slice(), at: now };
}

async function replan(now, forced) {
    const desired = buildDesired();
    const cur = currentPair();
    const sig = `${hashKeys(desired)}|${desired.length}|${cur.key}|${cur.lyrics.length}`;
    const changed = forced || sig !== _lastSig;
    _lastPlanAt = now;
    const plan = planSync(desired, getCachedDocs(), { forceRefetch: forced });
    _lastSig = sig;
    if (forced) _pruneArm = null;
    if (plan.put.length) await putDocs(plan.put);
    await applyPrune(plan.prune, sig, desired.length, now);
    if (changed || (!_queue.length && !_inflight)) {
        _queue = plan.fetch.filter(e => e && !_flight.has(e.key));
        if (changed && _queue.length) logInfo(TAG, `待补歌词索引 ${_queue.length} 首`);
    }
}

/** 一次空闲切片里最多发 MAX_INFLIGHT 个取词请求；播放加载中与窗口隐藏时让路 */
function launchFetches() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (state.isLoadingSong) return;
    while (_inflight < MAX_INFLIGHT && _queue.length) {
        const entry = _queue.shift();
        if (!entry || _flight.has(entry.key)) continue;
        _flight.add(entry.key);
        _inflight++;
        fetchAndIndex(entry)
            .catch(e => logCatch(TAG, e))
            .then(() => {
                _flight.delete(entry.key);
                _inflight--;
                schedule(FETCH_GAP_MS);
            });
    }
}

async function pass() {
    if (!(await ensureLoaded())) return;
    const now = Date.now();
    if (_force || !_lastSig || (now - _lastPlanAt) >= PLAN_MIN_MS) await replan(now, _force);
    _force = false;
    launchFetches();
}

async function tick() {
    if (_running) { schedule(BUSY_BACKOFF_MS); return; }
    _running = true;
    let failed = false;
    try {
        await pass();
    } catch (e) {
        failed = true;
        logCatch(TAG, e);
    } finally {
        _running = false;
    }
    const fast = needsFastPass();
    if (fast) _fastTries--;
    else _fastTries = FAST_TRIES;
    if (_phase !== 'unavailable') {
        if (pendingCount()) setPhase('building');
        else if (!failed) setPhase(indexStats().docs ? 'ready' : 'empty');
    }
    renderStatus();
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) schedule(HIDDEN_BACKOFF_MS);
    else if (state.isLoadingSong) schedule(BUSY_BACKOFF_MS);
    else if (pendingCount()) schedule(FETCH_GAP_MS);
    else schedule(needsFastPass() ? PUMP_FAST_MS : PUMP_STEADY_MS);
}

function startPump() {
    if (_started) return;
    _started = true;
    schedule(0);
    if (typeof window !== 'undefined') {
        /* 另一个标签页改了收藏/歌单（同一份 localStorage）：立刻复查 */
        window.addEventListener('storage', () => { _fastTries = FAST_TRIES; schedule(0); });
    }
    if (audio && typeof audio.addEventListener === 'function') {
        audio.addEventListener('play', () => { _fastTries = FAST_TRIES; schedule(400); });
    }
}

function pumpNow(reason) {
    _fastTries = FAST_TRIES;
    if (reason === 'rebuild') showToast(T.reindexDone, 2200);
    schedule(0);
}

async function rebuildIndex() {
    try {
        await clearIndex();
        _lastSig = '';
        _queue = [];
        _force = true;
        setPhase('building');
        renderStatus();
        pumpNow('rebuild');
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 浮层骨架 ---------- */

const OVERLAY_HTML = `
    <div class="search-modal lyric-search-modal" role="document">
        <div class="ls-head">
            <div class="ls-title">${esc(T.title)}</div>
            <button type="button" class="ls-close" id="lyricSearchCloseBtn" title="${esc(T.close)}" aria-label="${esc(T.close)}">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>
                </svg>
            </button>
        </div>
        <div class="ls-box">
            <input type="text" id="${INPUT_ID}" autocomplete="off" spellcheck="false"
                   aria-label="${esc(T.ariaInput)}" placeholder="${esc(T.placeholder)}">
            <button type="button" class="ls-clear" id="lyricSearchClearBtn" title="${esc(T.clear)}"
                    aria-label="${esc(T.clear)}" style="display:none">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>
                </svg>
            </button>
            <button type="button" class="search-btn ls-go" id="lyricSearchGoBtn">${esc(T.go)}</button>
        </div>
        <div class="ls-status" id="lyricSearchStatus"></div>
        <div class="ls-results" id="lyricSearchResults"></div>
        <div class="ls-foot">
            <span class="ls-scopes"><span class="ls-i18n">${esc(T.scopeTitle)}</span>
                <span class="ls-chip">${esc(SCOPE_LABEL.current)}</span><span class="ls-chip">${esc(SCOPE_LABEL.favorite)}</span>
                <span class="ls-chip">${esc(SCOPE_LABEL.playlist)}</span><span class="ls-chip">${esc(SCOPE_LABEL.recent)}</span>
            </span>
            <button type="button" class="ls-reindex" id="lyricSearchReindexBtn" title="${esc(T.tipReindex)}">${esc(T.reindex)}</button>
        </div>
    </div>`;

let _overlay = null;
let _results = null;
let _status = null;
let _input = null;
let _clearBtn = null;
let _rows = [];
let _sel = -1;
let _searchTimer = null;
let _lastStatusHtml = '';

function ensureOverlay() {
    const dd = d();
    if (!dd) return null;
    if (_overlay && dd.body.contains(_overlay)) return _overlay;
    let root = dd.getElementById(ROOT_ID);
    if (!root) {
        root = dd.createElement('div');
        root.className = 'search-overlay lyric-search-overlay';
        root.id = ROOT_ID;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', T.title);
        root.innerHTML = OVERLAY_HTML;
        dd.body.appendChild(root);
    }
    _overlay = root;
    _results = byId('lyricSearchResults');
    _status = byId('lyricSearchStatus');
    _input = byId(INPUT_ID);
    _clearBtn = byId('lyricSearchClearBtn');
    if (!root._lsBound) { root._lsBound = true; bindOverlay(root); }
    return root;
}

function visible() {
    return !!_overlay && _overlay.classList.contains('visible');
}

function openPanel() {
    const root = ensureOverlay();
    if (!root) return;
    root.classList.add('visible');
    startPump();
    pumpNow('open');
    renderStatus();
    runSearch();
    if (_input) {
        setTimeout(() => { try { _input.focus(); _input.select(); } catch (e) { logCatch(TAG, e); } }, 60);
    }
}

function closePanel() {
    if (_overlay) _overlay.classList.remove('visible');
}

function togglePanel() {
    if (visible()) closePanel();
    else openPanel();
}

/* ---------- 索引状态行 ---------- */

function buildingBits() {
    const st = indexStats();
    return `<b class="ls-num">${num(st.docs)}</b><span class="ls-sep">/</span>`
        + `<b class="ls-num">${num(st.docs + pendingCount())}</b>`
        + `<span class="ls-unit ls-i18n">${esc(T.labelUnit)}</span>`;
}

function renderStatus() {
    if (!_status) return;
    const st = indexStats();
    let html;
    if (_phase === 'unavailable') {
        html = `<span class="ls-state is-bad ls-i18n">${esc(T.stateUnavailable)}</span>`;
    } else if (_phase === 'building') {
        html = `<span class="ls-dot"></span><span class="ls-state is-busy ls-i18n">${esc(T.stateBuilding)}</span>${buildingBits()}`;
    } else {
        html = `<span class="ls-state is-ok ls-i18n">${esc(T.stateReady)}</span>`
            + `<span class="ls-sep">·</span><span class="ls-i18n">${esc(T.labelIndexed)}</span>`
            + `<b class="ls-num">${num(st.docs)}</b><span class="ls-unit ls-i18n">${esc(T.labelUnit)}</span>`
            + `<span class="ls-sep">·</span><span class="ls-i18n">${esc(T.labelLines)}</span><b class="ls-num">${num(st.lines)}</b>`;
    }
    /* 内容没变就不重写：重建 innerHTML 会让 .ls-dot 的 CSS 动画从头再来，
       取词期间每 140ms 一次的话指示灯会一直闪在第一帧 */
    if (html !== _lastStatusHtml) {
        _lastStatusHtml = html;
        _status.innerHTML = html;
    }
    const btn = byId(BTN_ID);
    if (btn) {
        const tip = (_phase === 'building') ? T.tipBuilding : T.tipIdle;
        btn.setAttribute('data-tooltip', tip);
        btn.setAttribute('title', tip);
        btn.classList.toggle('is-busy', _phase === 'building');
    }
}

/* ---------- 结果渲染 ---------- */

function highlightHtml(text, ranges) {
    const t = String(text == null ? '' : text);
    if (!ranges || !ranges.length) return esc(t);
    let out = '';
    let pos = 0;
    for (const r of ranges) {
        const s = Math.max(0, Number(r[0]) || 0);
        const e = Math.min(t.length, Number(r[1]) || 0);
        if (e <= pos || e <= s) continue;
        if (s > pos) out += esc(t.slice(pos, s));
        out += '<mark class="ls-mark">' + esc(t.slice(s, e)) + '</mark>';
        pos = e;
    }
    return out + esc(t.slice(pos));
}

function rowHtml(row, i) {
    const idx = String(i);
    const cover = row.cover ? sanitizeImageUrl(row.cover) : '';
    const art = cover
        ? `<img class="ls-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="ls-cover ls-cover-empty"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-opacity=".55"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></span>`;
    const src = SOURCE_LABEL[row.source] || '';
    const scope = SCOPE_LABEL[row.scope] || '';
    const context = row.prev || row.next || '';
    return `<div class="ls-row" data-i="${idx}" role="button" tabindex="-1">
        ${art}
        <div class="ls-body">
            <div class="ls-top">
                <span class="ls-song">${esc(row.title)}</span>
                <span class="ls-artist">${esc(row.artist)}</span>
                ${src ? `<span class="ls-src">${esc(src)}</span>` : ''}
            </div>
            <div class="ls-line">${highlightHtml(row.text, row.ranges)}</div>
            ${context ? `<div class="ls-context">${esc(context)}</div>` : ''}
        </div>
        <div class="ls-meta">
            <span class="ls-time">${esc(formatTime(row.time))}</span>
            ${row.songHits > 1 ? `<span class="ls-hits" title="${esc(T.tipHits)}">${num(row.songHits)}</span>` : ''}
            ${scope ? `<span class="ls-chip ls-chip-scope">${esc(scope)}</span>` : ''}
        </div>
    </div>`;
}

function stateBox(title, desc, extra) {
    return `<div class="ls-state-box empty-hint"><div class="ls-state-title ls-i18n">${esc(title)}</div>`
        + (desc ? `<div class="ls-state-desc ls-i18n">${esc(desc)}</div>` : '')
        + (extra || '') + `</div>`;
}

function renderRows(res, query) {
    if (!_results) return;
    _rows = res.rows;
    _sel = -1;
    if (!query) {
        _results.innerHTML = stateBox(T.stateInputTitle, T.stateInputDesc);
        return;
    }
    const building = pendingCount()
        ? `<div class="ls-inline-build"><span class="ls-dot"></span><span class="ls-i18n">${esc(T.stateBuilding)}</span>${buildingBits()}</div>`
        : '';
    if (!res.rows.length) {
        const extra = pendingCount() ? building
            : `<div class="ls-state-sub ls-i18n">${esc(T.stateEmptyIndexHint)}</div>`;
        _results.innerHTML = stateBox(T.stateNoMatch, T.stateNoMatchHint, extra);
        return;
    }
    const head = `<div class="ls-sum"><span class="ls-i18n">${esc(T.labelHits)}</span><b class="ls-num">${num(res.total)}</b>`
        + `<span class="ls-sep">·</span><span class="ls-i18n">${esc(T.labelSongs)}</span><b class="ls-num">${num(res.songs)}</b>`
        + `<span class="ls-sep">·</span><span class="ls-i18n">${esc(T.labelScanned)}</span><b class="ls-num">${num(res.scanned)}</b>`
        + `<span class="ls-unit ls-i18n">${esc(T.labelUnit)}</span></div>`;
    _results.innerHTML = head + building + res.rows.map(rowHtml).join('');
    _results.scrollTop = 0;
}

function runSearch() {
    if (!_input) return;
    const q = String(_input.value || '').trim();
    if (_clearBtn) _clearBtn.style.display = q ? '' : 'none';
    let res = { rows: [], total: 0, songs: 0, scanned: 0 };
    try {
        res = search(q, { limit: RESULT_LIMIT });
    } catch (e) { logCatch(TAG, e); }
    renderRows(res, q);
}

function scheduleSearch() {
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { _searchTimer = null; runSearch(); }, SEARCH_DEBOUNCE_MS);
}

/* ---------- 跳转：播这首歌并 seek 到那一句 ---------- */

function sameAsCurrent(key) {
    const cur = state.currentSongData;
    return !!cur && !!key && songKeyOf(cur) === key;
}

/** 索引里的时间戳可能来自另一个歌词源；先在真正渲染出来的歌词里按文本找一遍 */
function liveTimeFor(row) {
    const list = Array.isArray(state.lyrics) ? state.lyrics : [];
    const want = normText(row.original || row.text || '');
    if (!list.length || !want) return null;
    let fuzzy = null;
    for (let i = 0; i < list.length; i++) {
        const text = lineTextOf(list[i]);
        if (!text) continue;
        const n = normText(text);
        if (n === want) return Number(list[i].start);
        if (fuzzy === null && n && n.includes(want)) fuzzy = Number(list[i].start);
    }
    return fuzzy;
}

function seekToRow(row) {
    const live = liveTimeFor(row);
    const ms = (live === null || !Number.isFinite(live)) ? (Number(row.time) || 0) : live;
    const offset = (typeof lyricOffset === 'number' && Number.isFinite(lyricOffset)) ? lyricOffset : 0;
    const target = Math.max(0, ms - offset);
    try {
        audio.currentTime = target / 1000;
    } catch (e) { logCatch(TAG, e); }
    state.currentTime = target;
    try {
        if (typeof updateLyricsHighlight === 'function') updateLyricsHighlight();
    } catch (e) { logCatch(TAG, e); }
    if (audio.paused) {
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(e => logCatch(TAG, e));
    }
    setHint('');
}

async function jumpToRow(row) {
    if (!row) return;
    closePanel();
    if (!sameAsCurrent(row.key)) {
        const id = row.id || row.mid || row.hash || '';
        if (!row.source || !id) { setHint(T.unplayable); return; }
        const info = {
            source: row.source,
            id,
            mid: row.mid || '',
            hash: row.hash || '',
            song: row.title,
            singer: row.artist,
            cover: row.cover || '',
        };
        state.currentSource = row.source;
        try {
            if (Array.isArray(sourceBtns)) {
                sourceBtns.forEach(b => b.classList.toggle('active', b.dataset.source === row.source));
            }
        } catch (e) { logCatch(TAG, e); }
        setHint(T.loadingJump);
        try {
            await loadOnlineSong(info, true);
        } catch (e) {
            logCatch(TAG, e);
            setHint(T.jumpFailed);
            return;
        }
    }
    seekToRow(row);
    _fastTries = FAST_TRIES;
    schedule(400);
}

/* ---------- 交互 ---------- */

function moveSel(delta) {
    if (!_results || !_rows.length) return;
    const items = _results.querySelectorAll('.ls-row');
    if (!items.length) return;
    _sel = Math.min(items.length - 1, Math.max(0, _sel + delta));
    items.forEach((n, i) => n.classList.toggle('is-sel', i === _sel));
    const cur = items[_sel];
    if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
}

function markSel(i) {
    if (!_results) return;
    _sel = i;
    _results.querySelectorAll('.ls-row').forEach((n, k) => n.classList.toggle('is-sel', k === i));
}

function bindOverlay(root) {
    const dd = d();
    if (!dd) return;
    byId('lyricSearchCloseBtn')?.addEventListener('click', closePanel);
    byId('lyricSearchGoBtn')?.addEventListener('click', runSearch);
    byId('lyricSearchReindexBtn')?.addEventListener('click', () => {
        try { rebuildIndex(); } catch (e) { logCatch(TAG, e); }
    });
    _clearBtn?.addEventListener('click', () => {
        if (!_input) return;
        _input.value = '';
        runSearch();
        _input.focus();
    });
    _input?.addEventListener('input', scheduleSearch);
    _input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (_rows.length) jumpToRow(_rows[Math.max(0, _sel)]);
            else runSearch();
        } else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    });
    _results?.addEventListener('click', (e) => {
        const node = e.target && e.target.closest ? e.target.closest('.ls-row') : null;
        if (!node) return;
        const i = Number(node.dataset.i);
        if (Number.isFinite(i) && _rows[i]) jumpToRow(_rows[i]);
    });
    _results?.addEventListener('mousemove', (e) => {
        const node = e.target && e.target.closest ? e.target.closest('.ls-row') : null;
        if (!node) return;
        const i = Number(node.dataset.i);
        if (!Number.isFinite(i) || i === _sel) return;
        markSel(i);
    });
    root.addEventListener('click', (e) => { if (e.target === root) closePanel(); });
    dd.addEventListener('keydown', (e) => {
        if (!visible()) return;
        if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
        if (dd.activeElement === _input) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (_rows.length) jumpToRow(_rows[Math.max(0, _sel)]);
        }
    });
}

/* ---------- 入口按钮（自建自挂，同 285 的做法） ---------- */

const BTN_HTML = '<svg class="lsq-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" '
    + 'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="15.5" y1="15.5" x2="20" y2="20"></line>'
    + '<line x1="7.8" y1="9" x2="13.2" y2="9"></line><line x1="7.8" y1="12" x2="11.4" y2="12"></line></svg>'
    + `<span class="lsq-text bottom-mode-text">${esc(T.title)}</span>`;

function buildEntry(d2) {
    const row = d2.querySelector('#bottomControlBar .bottom-controls-row');
    const top = d2.querySelector('.top-action-buttons');
    const host = row || top;
    if (!host) return null;
    const btn = d2.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = row ? 'bottom-btn lyric-search-entry' : 'icon-action-btn lyric-search-entry';
    btn.innerHTML = BTN_HTML;
    const more = row && row.querySelector('.more-menu-wrapper');
    if (more) host.insertBefore(btn, more);
    else host.appendChild(btn);
    return btn;
}

function bindEntry() {
    const dd = d();
    if (!dd) return;
    let btn = dd.getElementById(BTN_ID);
    if (!btn) btn = buildEntry(dd);
    if (!btn || btn._lsBound) return;
    btn._lsBound = true;
    btn.addEventListener('click', () => { try { togglePanel(); } catch (e) { logCatch(TAG, e); } });
    btn.setAttribute('data-tooltip', T.tipIdle);
    btn.setAttribute('title', T.tipIdle);
    btn.setAttribute('aria-label', T.tipIdle);
}

function bindHotKey(e) {
    if (e.defaultPrevented || e.altKey) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!e.key || e.key.toLowerCase() !== 'f') return;
    const dd = d();
    const act = dd && dd.activeElement;
    if (act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA' || act.isContentEditable)) return;
    e.preventDefault();
    try { openPanel(); } catch (err) { logCatch(TAG, err); }
}

function boot() {
    bindEntry();
    ensureOverlay();
    renderStatus();
    startPump();
    if (typeof document !== 'undefined') document.addEventListener('keydown', bindHotKey);
    if (typeof window !== 'undefined' && typeof Aria !== 'undefined') {
        Aria.__lyricSearch = {
            open: openPanel,
            close: closePanel,
            toggle: togglePanel,
            rebuild: rebuildIndex,
            query: (q, opts) => search(q, opts),
            stats: () => indexStats(),
            pump: () => pumpNow('manual'),
        };
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
}

export { closePanel, ensureOverlay, jumpToRow, openPanel, rebuildIndex, runSearch, togglePanel };
