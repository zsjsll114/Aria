/* ============================================================
 * 289-next-up.js — 下一首预告 + 一键否决（todos #5）
 *
 * 一句话：切歌前 ~5 秒，在底栏上方浮出「下一首：XXX · 点击换一首」，
 * 点它是换一首（确定候选列表，不是随机），不点它自动消失、照常播。
 *
 * 「播谁」的判定全在 core/nextUp.js（纯函数，tests/js/test_next_up.js 覆盖），
 * 本分片只做：读状态 → 判定 → 渲染 → 事件撤销。
 *
 * 三个不显然的决定：
 *  1. 偏好藏在 appSettings.interface.nextUp：180 的 loadSettings() 按固定键白名单
 *     整体重建 appSettings，只有 interface 是全量展开的，新键不藏进去就会被静默丢掉
 *     （AGENTS 约束 11）。默认开 = `enabled !== false`，所以不用改 defaults.js。
 *  2. 状态一律读 `state.*`（infrastructure/state.js 是唯一存储），不写任何裸全局
 *     （约束 11）；需要给别的分片留撤销入口时用 `Aria.set('__nextUpCancel', …)`，
 *     与 232/135 的命名空间协议一致，不新增 globalThis 裸键。
 *  3. 外部数据（歌名/歌手/封面）全部走 `textContent` + `sanitizeImageUrl()` 建 DOM，
 *     本分片没有一处 innerHTML 插值（约束 8 的更强形态：模板零插值，见 281-osd.js
 *     的同一手法）。设置面板的骨架模板是写死的，插进去的静态中文也先过
 *     translatePhrase() 再过 esc()。
 *
 * 撤销可靠性（要求 3）：`timeupdate` 每帧都用「代际 + 队列索引 + audio.src」三要素
 * 签名比对，任一变化即 hide；另外 play/pause/seeking/seeked/ended/loadstart/
 * durationchange/emptied 各自直接触发一次判定。随机模式压根不报名（见 core 文件头）。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { audio } from './20-lyrics-render.js';
import { loadPlaylistTrack } from './135-crossfade.js';
import { sanitizeImageUrl } from './100-cover-background.js';
import { saveSettings } from './180-boot-config.js';
import { translatePhrase } from '../core/i18n.js';
import { esc } from '../utils/formatters.js';
import { logCatch, logInfo, logWarn } from '../services/log.js';
import {
    ACTION,
    KIND,
    LEAD_MAX_SECONDS,
    LEAD_MIN_SECONDS,
    evaluateNextUp,
    normalizeNextUpPrefs,
    resolveNextUp,
    songSignature,
    describeDecision,
} from '../core/nextUp.js';

const TAG = 'nextUp';
const SETTING_KEY = 'nextUp';
/* 快路径容差：离切歌还远得很时（一首歌 99% 的时间）什么都不用算 */
const FAST_PATH_SLACK = 0.5;
/* 专注模式的标记（282-zen-mode.js 挂在 <html id="ariaRoot"> 上） */
const ZEN_CLASS = 'is-zen';

/* 有这些开着时不浮出：底栏/浮层被弹窗盖住或语义被改写，报个没人看得到的预告没意义。
   与 282-zen-mode.js 的 MODAL_SELECTOR 同一份口径（那边是「不进专注」，这边是「不浮出」）。 */
const BLOCKING_SELECTOR = [
    '.search-overlay.visible', '.settings-overlay.visible', '.view-mode-overlay.visible',
    '.eq-panel.visible', '.lyric-source-overlay.visible', '.color-picker-overlay.visible',
    '.ai-models-overlay.visible', '.ctx-menu.visible', '.ctx-confirm.visible',
    '.aria-dialog-overlay', '#sleepTimerOverlay.visible', '.plm-panel.visible',
    /* 首屏欢迎层：它盖在整窗上（实测 z-index 高于本浮层），预告条浮在它背后等于没浮 */
    '#welcomeOverlay:not(.hidden)', '#ariaOobeOverlay',
].join(', ');

/* ---------- 静态骨架：模板里零插值 ---------- */
const LAYER_HTML = `
    <div class="next-up-bar" data-nu-role="bar" role="status" aria-live="polite" aria-atomic="true">
        <span class="next-up-tag" data-nu-role="tag"></span>
        <img class="next-up-cover" data-nu-role="cover" alt="">
        <span class="next-up-song">
            <span class="next-up-title" data-nu-role="title"></span>
            <span class="next-up-artist" data-nu-role="artist"></span>
            <span class="next-up-note" data-nu-role="note"></span>
        </span>
        <span class="next-up-count">
            <span class="next-up-count-num" data-nu-role="count"></span>
            <span class="next-up-count-unit" data-nu-role="countUnit"></span>
        </span>
        <button type="button" class="next-up-cta" data-nu-role="cta"></button>
        <button type="button" class="next-up-dismiss" data-nu-role="dismiss">&times;</button>
        <div class="next-up-panel" data-nu-role="panel">
            <div class="next-up-panel-title" data-nu-role="panelTitle"></div>
            <div class="next-up-list" data-nu-role="list"></div>
        </div>
    </div>`;

function doc() { return typeof document !== 'undefined' ? document : null; }

/* ---------- 偏好读写 ---------- */
function readPrefs() {
    try {
        const iface = state.appSettings && state.appSettings.interface;
        return normalizeNextUpPrefs(iface && iface[SETTING_KEY]);
    } catch (e) { logCatch(TAG, e); return normalizeNextUpPrefs(null); }
}

function persistNextUp(patch) {
    try {
        const s = state.appSettings;
        if (!s) return;
        if (!s.interface) s.interface = {};
        s.interface[SETTING_KEY] = Object.assign({}, s.interface[SETTING_KEY] || {}, patch);
        if (typeof saveSettings === 'function') saveSettings();
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- DOM ---------- */
let _refs = null;

function ensureRefs() {
    const d = doc();
    if (!d || !d.body) return null;
    if (_refs && _refs.layer && _refs.layer.isConnected) return _refs;
    _refs = null;
    let layer = d.getElementById('nextUpLayer');
    if (!layer) {
        /* 宿主不在 index.html 里就自建（同 281-osd.js）：这样「先 import 后补 HTML」
           的中间状态也能看到效果，而不是静默失效 */
        layer = d.createElement('div');
        layer.id = 'nextUpLayer';
        layer.className = 'next-up-layer';
        layer.setAttribute('aria-hidden', 'true');
        d.body.appendChild(layer);
    }
    layer.className = 'next-up-layer';
    if (!layer.querySelector('[data-nu-role="bar"]')) layer.innerHTML = LAYER_HTML;
    const pick = (role) => layer.querySelector('[data-nu-role="' + role + '"]');
    _refs = {
        layer,
        bar: pick('bar'),
        tag: pick('tag'),
        cover: pick('cover'),
        title: pick('title'),
        artist: pick('artist'),
        note: pick('note'),
        count: pick('count'),
        countUnit: pick('countUnit'),
        cta: pick('cta'),
        dismiss: pick('dismiss'),
        panel: pick('panel'),
        panelTitle: pick('panelTitle'),
        list: pick('list'),
    };
    _refs.dismiss.textContent = '×';
    _refs.dismiss.setAttribute('aria-label', tx('关闭提示'));
    _refs.dismiss.title = tx('关闭提示');
    return _refs;
}

/** 词表唯一登记处是 core/i18n.js 的 STATIC_PHRASE_MAP（约束 7）：
 *  本浮层不在 i18n observer 的 UI 根清单里，所以渲染前逐条查表，不建第二份对照表。 */
function tx(zh) {
    try {
        return translatePhrase(zh);
    } catch (e) { logCatch(TAG, e); return zh; }
}

/* 值不变不写 DOM：同一元素重复赋同一 textContent 也会让 i18n/无障碍树空转 */
function setText(el, value) {
    if (!el) return;
    const next = value == null ? '' : String(value);
    if (el.textContent !== next) el.textContent = next;
}

function toggleClass(el, cls, on) {
    if (el && typeof el.classList !== 'undefined') el.classList.toggle(cls, !!on);
}

/* ---------- 样式接线兜底（正解是 index.html 加一条 <link>） ---------- */
function ensureStylesheet() {
    const d = doc();
    if (!d || !d.head) return;
    try {
        const links = Array.from(d.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of links) {
            if (link.href && link.href.indexOf('/styles/next-up.css') >= 0) return;
        }
        if (d.getElementById('nextUpStyles')) return;
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.id = 'nextUpStyles';
        link.href = new URL('../styles/next-up.css', import.meta.url).href;
        d.head.appendChild(link);
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 抑制条件 ---------- */
function isReadTakeover() {
    try {
        const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
        return !!(A && typeof A.__npActive === 'function' && A.__npActive());
    } catch (e) { logCatch(TAG, e); return false; }
}

function isSuppressed() {
    const d = doc();
    if (!d || !d.documentElement) return true;
    /* 专注模式=「只留歌词与背景」，预告条属于要被淡掉的那一类 */
    if (d.documentElement.classList.contains(ZEN_CLASS)) return true;
    /* 被系统 Now Playing 接管时，175 的 loadOnlineSong 会阻断全部自动切歌：
       那时候报的「下一首」根本不会播，属于纯假预告 */
    if (isReadTakeover()) return true;
    if (state.isLoadingSong === true) return true;
    try {
        return !!d.querySelector(BLOCKING_SELECTOR);
    } catch (e) { logCatch(TAG, e); return true; }
}

/* ---------- 位置：躲开歌词列下方的既有控件 ----------
   底栏在 view-lyrics 是列尾元素、在 view-pv/dimension/wordcloud 是 absolute 居中浮层，
   飞入/词云还在底部让位给翻译区 —— 高度与可见性都不固定，所以每次浮出实测一次上沿，
   把条顶到它们之上。★ 必须用尺寸判定可见性：约束 14① 记录过同类教训
   （display:none 的元素 rect 是 0×0，offsetParent 判定不可靠）。 */
function measureOccupiedLift(d) {
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
    let lift = 0;
    ['bottomControlBar', 'flyinTranslationArea'].forEach((id) => {
        const el = d.getElementById(id);
        if (!el) return;
        try {
            const r = el.getBoundingClientRect();
            if (!r || r.height <= 0 || r.top >= vh || r.bottom <= 0) return;
            const need = vh - r.top + 8;
            if (need > lift) lift = need;
        } catch (e) { logCatch(TAG, e); }
    });
    /* 兜上限：极端布局下宁可让条贴住底部，也不让它爬到屏幕中间挡住歌词主视区 */
    return Math.min(Math.round(lift), Math.round(vh * 0.4));
}

function applyAnchor() {
    const d = doc();
    const refs = _refs;
    if (!d || !refs || !refs.layer) return;
    try {
        /* 横向默认整窗居中；view-cover 下左列（封面+主控制区）占着左半边，
           居中会压到它的底部控件上 → 改成在歌词列里居中 */
        let center = ((typeof window !== 'undefined' && window.innerWidth) || 1280) / 2;
        let avail = center * 2 - 32;
        const wrap = d.querySelector('.lyrics-area-wrapper');
        const r = wrap && wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
        if (r && r.width > 0) {
            center = r.left + r.width / 2;
            avail = r.width - 24;
        }
        refs.layer.style.left = Math.round(center) + 'px';
        refs.layer.style.maxWidth = Math.round(Math.min(560, Math.max(240, avail))) + 'px';
        refs.layer.style.setProperty('--nu-lift', measureOccupiedLift(d) + 'px');
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 渲染 ---------- */
function labelForDecision(decision) {
    if (decision.kind === KIND.REPLAY) return tx('单曲循环');
    if (decision.kind === KIND.RANDOM) return tx('随机播放');
    return tx('下一首');
}

/* 说明行专治三种「预告不能报名」的情况，让语义对用户可见（要求 2） */
function noteForDecision(decision) {
    if (decision.kind === KIND.RANDOM) return tx('随机播放中，下一首不固定');
    if (decision.kind === KIND.REPLAY) return tx('重复播放当前歌曲');
    if (decision.wraps) return tx('队列末尾，回到第一首');
    return '';
}

function renderBar(decision) {
    const refs = ensureRefs();
    if (!refs) return;
    const note = noteForDecision(decision);
    setText(refs.tag, labelForDecision(decision));
    setText(refs.note, note);
    toggleClass(refs.note, 'nu-empty', !note);
    setText(refs.title, decision.namesSong ? decision.title : tx('不指定具体歌曲'));
    setText(refs.artist, decision.namesSong ? decision.artist : '');
    toggleClass(refs.artist, 'nu-empty', !(decision.namesSong && decision.artist));
    const cover = decision.namesSong && decision.cover ? sanitizeImageUrl(decision.cover) : '';
    if (cover) {
        refs.cover.removeAttribute('loading');
        refs.cover.src = cover;
        refs.cover.classList.remove('nu-hidden');
    } else {
        refs.cover.removeAttribute('src');
        refs.cover.classList.add('nu-hidden');
    }
    /* 没有可换的对象时连「点击换一首」都不说，免得点了没反应 */
    setText(refs.cta, decision.clickable ? tx('点击换一首') : '');
    toggleClass(refs.cta, 'nu-empty', !decision.clickable);
    if (decision.clickable) refs.bar.setAttribute('data-nu-clickable', '1');
    else refs.bar.removeAttribute('data-nu-clickable');
    refs.cta.disabled = !decision.clickable;
    refs.bar.setAttribute('aria-label', ariaLabelFor(decision));
    updateCountdown(decision);
}

function ariaLabelFor(decision) {
    if (decision.kind === KIND.RANDOM) return tx('随机播放中，下一首不固定');
    const who = decision.title || tx('未知歌曲');
    return `${labelForDecision(decision)}：${who}`;
}

let _lastCountShown = -1;

function updateCountdown(decision) {
    const refs = _refs;
    if (!refs || !refs.count) return;
    const secs = Math.max(0, Math.ceil(Number(decision.remainingSec) || 0));
    if (secs === _lastCountShown) return;
    _lastCountShown = secs;
    setText(refs.count, String(secs));
    setText(refs.countUnit, tx('秒'));
}

/* 候选行：createElement + textContent，外部数据不进任何 HTML 字符串 */
function renderCandidates(candidates) {
    const refs = _refs;
    if (!refs || !refs.list) return;
    refs.list.textContent = '';
    (candidates || []).forEach((c) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'next-up-item';
        row.setAttribute('data-nu-index', String(c.index));

        const no = document.createElement('span');
        no.className = 'next-up-item-no';
        no.textContent = String(c.index + 1).padStart(2, '0');

        const cover = document.createElement('img');
        cover.className = 'next-up-item-cover';
        cover.alt = '';
        const coverUrl = c.cover ? sanitizeImageUrl(c.cover) : '';
        if (coverUrl) cover.src = coverUrl;
        else cover.classList.add('nu-hidden');

        const song = document.createElement('span');
        song.className = 'next-up-item-song';
        const title = document.createElement('span');
        title.className = 'next-up-item-title';
        title.textContent = c.title;
        const artist = document.createElement('span');
        artist.className = 'next-up-item-artist';
        artist.textContent = c.artist;
        song.appendChild(title);
        if (c.artist) song.appendChild(artist);

        row.appendChild(no);
        row.appendChild(cover);
        row.appendChild(song);
        row.title = c.title + (c.artist ? ' · ' + c.artist : '');
        refs.list.appendChild(row);
    });
    setText(refs.panelTitle, tx('换成下面这首'));
}

/* ---------- 显示 / 撤回 ---------- */
let _revealed = null;        /* { key, signature, summary } —— key/signature 交给 core 做迟滞与比对 */
let _dismissedSignature = '';
let _panelOpen = false;

function closePanel() {
    const refs = _refs;
    _panelOpen = false;
    if (refs && refs.bar) refs.bar.classList.remove('nu-panel-open');
}

function hideNow(reason) {
    const refs = _refs;
    closePanel();
    if (refs && refs.layer) {
        refs.layer.classList.remove('nu-on');
        refs.layer.setAttribute('aria-hidden', 'true');
    }
    if (_revealed) {
        /* 留痕是这条功能的命门：用户反馈「预告 A 实际播 B」时，日志里能立刻对上号 */
        logInfo(TAG, `预告撤回（${reason || 'gone'}）：原预告 ${_revealed.summary}`);
    }
    _revealed = null;
    _lastCountShown = -1;
}

function reveal(decision) {
    const refs = ensureRefs();
    if (!refs) return;
    /* 每次浮出前重建候选：队列可能已经被拖拽排序/续推改过 */
    renderCandidates(decision.candidates);
    renderBar(decision);
    applyAnchor();
    refs.layer.classList.add('nu-on');
    refs.layer.setAttribute('aria-hidden', 'false');
    _revealed = {
        key: decision.key,
        signature: decision.signature,
        summary: describeDecision(decision),
    };
    logInfo(TAG, `预告浮出：${_revealed.summary}`);
}

/* ---------- 每帧判定 ---------- */
let _tickQueued = false;

function takeSnapshot(prefs) {
    const a = audio;
    const src = a ? String(a.currentSrc || a.src || '') : '';
    return {
        playlist: Array.isArray(state.playlist) ? state.playlist : [],
        currentIndex: Number(state.currentTrackIndex),
        playMode: state.playMode,
        generation: state.playbackGeneration,
        src,
        durationSec: a ? a.duration : NaN,
        currentTimeSec: a ? a.currentTime : NaN,
        isPlaying: !!(a && a.paused === false && a.ended === false),
        prefs,
        suppressed: isSuppressed(),
        revealed: _revealed,
    };
}

function tick() {
    try {
        const a = audio;
        const d = doc();
        if (!a || !d) return;
        const prefs = readPrefs();
        if (!prefs.enabled) { if (_revealed) hideNow('off'); return; }

        /* 快路径：没浮出且离切歌还远 → 不查 DOM、不建快照（一首歌 95% 的时间走这条） */
        const dur = Number(a.duration);
        const cur = Number(a.currentTime);
        const remaining = (Number.isFinite(dur) && dur > 0 && Number.isFinite(cur)) ? dur - cur : null;
        if (!_revealed && (remaining === null || remaining > prefs.leadSeconds + FAST_PATH_SLACK)) return;

        const snapshot = takeSnapshot(prefs);
        const sig = songSignature(snapshot);
        if (_dismissedSignature && _dismissedSignature === sig) {
            if (_revealed) hideNow('dismissed');
            return;
        }
        const { action, decision, reason } = evaluateNextUp(snapshot);
        if (action === ACTION.KEEP) { updateCountdown(decision); return; }
        if (action === ACTION.SHOW) { reveal(decision); return; }
        if (action === ACTION.REFRESH) {
            /* 同一首歌但预测变了（改播放模式 / 拖了队列 / 续推追加）：撤回旧的、原地换新，
               绝不让用户带着上一句预告继续看下去 */
            closePanel();
            renderCandidates(decision.candidates);
            renderBar(decision);
            _revealed = {
                key: decision.key,
                signature: decision.signature,
                summary: describeDecision(decision),
            };
            logInfo(TAG, `预告改口（同一首歌但预测变了）：${_revealed.summary}`);
            return;
        }
        if (_revealed) hideNow(reason || decision.reason || 'hide');
    } catch (e) {
        logCatch(TAG, e);
    }
}

/* timeupdate 已经 ~4Hz，但窗口尾段（最后 1.2 秒）可能只剩 4 次回调；
   rAF 合批只是把同一帧内的多次事件并成一次判定，不额外加计时器。
   ★ 同 281-osd.js 补一条 setTimeout 兜底：窗口被压到后台时 rAF 会被节流甚至冻住
     （见 utils/motion.js 关于 WAAPI 时间轴的记录），谁先到算谁，_tickQueued 去重。 */
const TICK_FALLBACK_MS = 64;

function scheduleTick() {
    if (_tickQueued) return;
    _tickQueued = true;
    const run = () => {
        if (!_tickQueued) return;   /* 另一条路径已经跑过了 */
        _tickQueued = false;
        try { tick(); } catch (e) { logCatch(TAG, e); }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    if (typeof setTimeout === 'function') setTimeout(run, TICK_FALLBACK_MS);
    if (typeof requestAnimationFrame !== 'function' && typeof setTimeout !== 'function') run();
}

/* ---------- 否决（一键换一首） ---------- */
function vetoTo(index) {
    const pl = Array.isArray(state.playlist) ? state.playlist : [];
    const target = pl[index];
    if (!target) { logWarn(TAG, `候选索引 ${index} 已不在队列里（队列被改过），放弃换歌`); return; }
    const title = String(target.title || target.song || target.name || '');
    /* 先撤回预告再切歌：loadPlaylistTrack 会把代际 +1，但浮层不能有一帧同时挂着
       「旧预告 + 新歌」——用户会以为预告真的没兑现 */
    hideNow('veto');
    logInfo(TAG, `已按否决改播第 ${index + 1} 首：${title}`);
    try {
        const p = loadPlaylistTrack(index);
        if (p && typeof p.catch === 'function') p.catch((e) => logCatch(TAG, e));
    } catch (e) {
        logCatch(TAG, e);
    }
}

function onLayerClick(e) {
    const refs = _refs;
    if (!refs || !refs.layer) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('[data-nu-role="dismiss"]')) {
        _dismissedSignature = songSignature(takeSnapshot(readPrefs()));
        hideNow('dismissed');
        return;
    }
    const item = t.closest('[data-nu-index]');
    if (item) {
        vetoTo(Number(item.getAttribute('data-nu-index')));
        return;
    }
    /* 面板内的空白处不收起（点了列表项才叫选择） */
    if (t.closest('[data-nu-role="panel"]')) return;
    if (!refs.bar.hasAttribute('data-nu-clickable')) return;
    if (_panelOpen) { closePanel(); return; }
    /* 浮出时已经渲过一遍候选；这里只在面板从未打开过（或队列刚变过）时按纯函数重算一次 */
    renderCandidates(currentCandidates());
    refs.bar.classList.add('nu-panel-open');
    _panelOpen = true;
}

/* 候选在 decision 里，但点击时我们只有 _revealed —— 现算比把整个 decision 长期留住更省
   （走的是同一个纯函数；队列若已变化则正好拿到新的）。alreadyRevealed=true 是因为
   面板只会在条已经浮出之后被打开，别让迟滞门槛把候选算空。 */
function currentCandidates() {
    try {
        const snapshot = takeSnapshot(readPrefs());
        return resolveNextUp({ ...snapshot, alreadyRevealed: true }).candidates || [];
    } catch (e) { logCatch(TAG, e); return []; }
}

function onDocPointerDown(e) {
    if (!_panelOpen) return;
    const refs = _refs;
    const t = e && e.target;
    try {
        if (refs && refs.layer && t && typeof t.closest === 'function' && t.closest('.next-up-layer')) return;
    } catch (err) { logCatch(TAG, err); return; }
    closePanel();
}

function onDocKeydown(e) {
    if (!_panelOpen) return;
    if (e && e.key === 'Escape') closePanel();
}

/* ---------- 对外撤销入口（给别的分片当显式保险；见报告里的插桩清单） ---------- */
export function cancelNextUpPreview(reason) {
    try {
        if (_revealed) hideNow(reason || 'external');
        else closePanel();
    } catch (e) { logCatch(TAG, e); }
}

/** 诊断/自测用快照：现在到底预告了哪首、为什么没浮出 */
export function getNextUpDebug() {
    try {
        const prefs = readPrefs();
        const snapshot = takeSnapshot(prefs);
        const { action, decision, reason } = evaluateNextUp(snapshot);
        return {
            revealed: _revealed,
            panelOpen: _panelOpen,
            dismissed: _dismissedSignature,
            action,
            reason: reason || decision.reason,
            decision: {
                show: decision.show, kind: decision.kind, index: decision.index,
                title: decision.title, remainingSec: decision.remainingSec,
                leadSeconds: decision.leadSeconds, candidates: decision.candidates.map(c => c.index),
            },
        };
    } catch (e) {
        logCatch(TAG, e);
        return { error: String(e && e.message ? e.message : e) };
    }
}

/* ---------- 设置页 UI（自建，不改 index.html / 200 也能配） ---------- */
function rowHTML(labelZh, descZh, controlHTML) {
    return `<div class="setting-row">
        <div>
            <div class="setting-label">${esc(tx(labelZh))}</div>
            <div class="setting-desc">${esc(tx(descZh))}</div>
        </div>
        <div class="setting-control">${controlHTML}</div>
    </div>`;
}

export function mountNextUpSettingsUI() {
    const d = doc();
    if (!d || d.getElementById('nextUpSettingsGroup')) return;
    const host = d.querySelector('[data-section="interface"]') || d.getElementById('settingsBody');
    if (!host) return;
    try {
        const group = d.createElement('div');
        group.className = 'settings-group';
        group.id = 'nextUpSettingsGroup';
        group.innerHTML = `
            <div class="settings-group-title">${esc(tx('下一首预告'))}</div>
            ${rowHTML('启用下一首预告', '切歌前几秒浮出「下一首」提示条，点击可换一首，不点自动消失',
                '<button type="button" class="setting-toggle" id="nuEnabledToggle"></button>')}
            ${rowHTML('提前浮出', '切歌前多少秒浮出提示条（3~15 秒）',
                `<input type="range" class="setting-slider" id="nuLeadSlider" min="${LEAD_MIN_SECONDS}" max="${LEAD_MAX_SECONDS}" step="1">
                 <span class="setting-value"><span id="nuLeadVal">5</span> ${esc(tx('秒'))}</span>`)}`;
        host.appendChild(group);

        group.querySelector('#nuEnabledToggle')?.addEventListener('click', () => {
            const next = !readPrefs().enabled;
            persistNextUp({ enabled: next });
            syncSettingsUI();
            if (!next) cancelNextUpPreview('setting-off');
            else scheduleTick();
        });
        const slider = group.querySelector('#nuLeadSlider');
        slider?.addEventListener('input', () => {
            const n = normalizeLeadValue(slider.value);
            persistNextUp({ leadSeconds: n });
            syncSettingsUI();
            scheduleTick();
        });

        /* 设置面板每次打开都重刷：bootApp 里 loadSettings() 是 await 之后的事，
           面板上的值必须以当时生效的配置为准（同 282） */
        const overlay = d.getElementById('settingsOverlay');
        if (overlay && typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => {
                if (overlay.classList.contains('visible')) syncSettingsUI();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }
        syncSettingsUI();
    } catch (e) { logCatch(TAG, e); }
}

function normalizeLeadValue(raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return normalizeNextUpPrefs(null).leadSeconds;
    return Math.max(LEAD_MIN_SECONDS, Math.min(LEAD_MAX_SECONDS, n));
}

export function syncSettingsUI() {
    const d = doc();
    if (!d) return;
    const prefs = readPrefs();
    const toggle = d.getElementById('nuEnabledToggle');
    if (toggle) toggle.classList.toggle('on', prefs.enabled);
    const slider = d.getElementById('nuLeadSlider');
    /* 用户正在拖这根滑条时不回写 value，否则拖动会被自己的同步打断（同 282） */
    if (slider && d.activeElement !== slider) slider.value = String(prefs.leadSeconds);
    const val = d.getElementById('nuLeadVal');
    if (val && val.textContent !== String(prefs.leadSeconds)) val.textContent = String(prefs.leadSeconds);
}

/* ---------- 装配 ---------- */
let _inited = false;

export function initNextUp() {
    if (_inited) return;
    const d = doc();
    if (!d) return;
    _inited = true;
    ensureStylesheet();
    if (!ensureRefs()) return;
    mountNextUpSettingsUI();

    if (audio) {
        /* 位置类事件：判定的全部依据都在这些事件上（timeupdate 是唯一的「倒计时来源」） */
        audio.addEventListener('timeupdate', scheduleTick);
        audio.addEventListener('play', scheduleTick);
        audio.addEventListener('durationchange', scheduleTick);
        /* 撤销类事件：暂停 / seek / 换歌 / 播完，任一条都必须立刻作废旧预告 */
        audio.addEventListener('pause', () => { hideNow('paused'); });
        audio.addEventListener('ended', () => { hideNow('ended'); scheduleTick(); });
        audio.addEventListener('seeking', () => { hideNow('seeking'); });
        audio.addEventListener('seeked', scheduleTick);
        audio.addEventListener('loadstart', () => { hideNow('loadstart'); });
        audio.addEventListener('emptied', () => { hideNow('emptied'); });
    }

    _refs.layer.addEventListener('click', onLayerClick);
    d.addEventListener('pointerdown', onDocPointerDown, true);
    d.addEventListener('keydown', onDocKeydown);
    if (typeof window !== 'undefined') {
        window.addEventListener('resize', () => {
            if (_revealed) applyAnchor();
        }, { passive: true });
        /* 本浮层不在 i18n observer 的 UI 根清单里，语言切换只能自己原地重写 */
        window.addEventListener('aria:languagechange', () => {
            try {
                if (_revealed) renderBarFromRevealed();
                syncSettingsUI();
            } catch (e) { logCatch(TAG, e); }
        });
    }

    /* 队列被拖拽排序 / 删除 / 续推时不会有事件可听，靠「索引+队列长度」的粗签名在
       下一次 timeupdate 自然对账；这里只处理更明显的两种：手动点队列播放、切歌按钮
       ——它们都会递增 playbackGeneration，被 loadstart/签名比对抓到。 */
    try {
        const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
        if (A && typeof A.set === 'function') {
            A.set('__nextUpCancel', cancelNextUpPreview);
            A.set('__nextUpDebug', getNextUpDebug);
        }
    } catch (e) { logCatch(TAG, e); }

    /* appSettings 可能被 180 的 bootApp 在 DOMContentLoaded 之后整体替换，load 后对齐一次 */
    if (typeof window !== 'undefined') {
        window.addEventListener('load', () => {
            try { syncSettingsUI(); scheduleTick(); } catch (e) { logCatch(TAG, e); }
        }, { once: true });
    }
    logInfo(TAG, '下一首预告已装配');
}

/* 语言切换后按当前预告原地重写文案（不重播入场动画、不改时间） */
function renderBarFromRevealed() {
    if (!_revealed) return;
    const snapshot = takeSnapshot(readPrefs());
    const decision = evaluateNextUp({ ...snapshot, revealed: null }).decision;
    /* 只借文案需要的字段，浮出与否的判断留给下一次 tick，避免切换语言时把条硬撑出来 */
    const refs = _refs;
    if (!refs) return;
    setText(refs.tag, labelForDecision(decision));
    setText(refs.note, noteForDecision(decision));
    setText(refs.cta, decision.clickable ? tx('点击换一首') : '');
    setText(refs.countUnit, tx('秒'));
    refs.dismiss.setAttribute('aria-label', tx('关闭提示'));
    refs.dismiss.title = tx('关闭提示');
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNextUp, { once: true });
    } else {
        initNextUp();
    }
}
