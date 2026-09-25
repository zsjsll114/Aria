/* ============================================================
 * 285-bilingual-cycle.js — 双语排版一键循环（todos #4）
 *
 * 四态（只看原文 → 原文+译文 → 原文+音译 → 三行）全部落在既有的
 * appSettings.lyrics.showTranslation / showRomaji 两个键上，渲染完全复用
 * 设置面板那两个开关走的那条路：写两个键 → renderLyrics（其尾部会把新值
 * 转投 PV / 隧道 / mainVisManager）→ updateLyricsHighlight 复位滚动。
 * 本分片不新增任何渲染分支，也不引入新的设置键。
 *
 * 按钮自建自挂：优先底栏 .bottom-controls-row（多数视觉模式下的常显面），
 * 退化到右上角 .top-action-buttons；两者都不存在时整套 UI 静默缺席、不报错，
 * 因此接线前也允许本分片先行 import。快捷键 T（Shift+T 反向）无条件生效。
 * ============================================================ */
import { setHint } from './120-search-results.js';
import { showToast } from './155-random-toast-match.js';
import { saveSettings } from './180-boot-config.js';
import { renderLyrics } from './20-lyrics-render.js';
import { updateLyricsHighlight } from './57-wordcloud-camera.js';
import { state } from '../infrastructure/state.js';
import { logCatch } from '../services/log.js';

const TAG = 'bilingualCycle';
const BTN_ID = 'bilingualCycleBtn';
const STYLE_ID = 'bilingual-cycle-style';
const HOTKEY = 't';

/* 与 syncPreviewToMain 同一份名单：名单外的 view-* 一律按 cover 处理，
   否则会写进一个 applyModeSettings 认不出来的模式键 */
const KNOWN_MODES = ['dimension', 'letterpress', 'neon', 'pv', 'tunnel', 'flyin', 'wordcloud', 'lyrics', 'cover'];

/* 四态定义：trans → showTranslation，roma → showRomaji（顺序即循环顺序） */
const LAYOUTS = [
    { trans: false, roma: false },
    { trans: true, roma: false },
    { trans: false, roma: true },
    { trans: true, roma: true },
];

const ICONS = [
    '<line x1="4" y1="12" x2="20" y2="12"></line>',
    '<line x1="4" y1="8.5" x2="20" y2="8.5"></line><line x1="4" y1="15.5" x2="16" y2="15.5" stroke-opacity=".6"></line>',
    '<line x1="4" y1="8.5" x2="20" y2="8.5"></line><line x1="4" y1="15.5" x2="16" y2="15.5" stroke-opacity=".6" stroke-dasharray="2.6 2.4"></line>',
    '<line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12" stroke-opacity=".8"></line><line x1="4" y1="18" x2="15" y2="18" stroke-opacity=".6"></line>',
];

/* 动态拼串的 i18n observer 翻不到（底栏不在 UI_ROOT_SELECTOR 内），按 280 的做法自组 */
const STR = {
    tip: ['双语排版 · 当前：{l}（按 {k} 循环，Shift+{k} 反向）', 'Bilingual layout · {l} (press {k} to cycle, Shift+{k} backwards)'],
    label: [
        ['原文', 'Original'],
        ['原文+译文', 'Orig + Trans'],
        ['原文+音译', 'Orig + Romaji'],
        ['三行', 'All 3 lines'],
    ],
    hint: [
        ['歌词排版：只看原文', 'Lyrics layout: original only'],
        ['歌词排版：原文 + 译文', 'Lyrics layout: original + translation'],
        ['歌词排版：原文 + 音译', 'Lyrics layout: original + romaji'],
        ['歌词排版：三行全显示', 'Lyrics layout: all three lines'],
    ],
    skipNoTrans: ['这首歌没有译文，已跳过带译文的排版', 'This song has no translation, so that layout was skipped'],
    skipNoRoma: ['这首歌没有音译，已跳过带音译的排版', 'This song has no romaji, so that layout was skipped'],
    skipNoBoth: ['这首歌既没有译文也没有音译，已跳过带它们的排版', 'This song has neither translation nor romaji, so those layouts were skipped'],
    skipNone: ['这首歌只有原文，没有可叠加的译文或音译', 'This song only has the original line, nothing to layer on'],
    noLyrics: ['当前没有歌词，排版偏好已保存（下一首生效）', 'No lyrics loaded; layout preference saved (applies to the next song)'],
};

function doc() { return typeof document !== 'undefined' ? document : null; }

function settings() {
    try {
        return state.appSettings || (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
    } catch (e) { logCatch(TAG, e); return null; }
}

function langIsEn() {
    try {
        const i18n = (typeof globalThis !== 'undefined' && globalThis.AriaI18n) || null;
        return !!(i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === 'en-US');
    } catch (e) { logCatch(TAG, e); return false; }
}

function fmt(entry, vars) {
    const tpl = entry[langIsEn() ? 1 : 0];
    return String(tpl).replace(/\{(\w+)\}/g, (all, key) => {
        const v = vars && vars[key];
        return v === undefined || v === null ? all : String(v);
    });
}

function notify(entry, vars) {
    const text = fmt(entry, vars);
    setHint(text);
    showToast(text, 2000);
}

/* ---------- 状态读写 ---------- */

function readFlags(s) {
    const ly = (s && s.lyrics) || {};
    return { trans: !!ly.showTranslation, roma: !!ly.showRomaji };
}

function layoutIndexOf(flags) {
    for (let i = 0; i < LAYOUTS.length; i++) {
        if (LAYOUTS[i].trans === flags.trans && LAYOUTS[i].roma === flags.roma) return i;
    }
    return 0;
}

function currentMode() {
    const d = doc();
    const pc = d && d.querySelector('.player-container:not(.preview-player)');
    if (pc) {
        for (const m of KNOWN_MODES) if (pc.classList.contains('view-' + m)) return m;
    }
    const g = typeof globalThis !== 'undefined' ? globalThis.currentViewMode : null;
    return KNOWN_MODES.indexOf(g) >= 0 ? g : 'cover';
}

/* 无翻译/无音译的歌不能往「+译文 / +音译 / 三行」上跳。
   歌词还没加载时判不出可用性，按「四种都可」处理——否则用户切歌瞬间按键会被误当成不支持。 */
function availability() {
    const list = state.lyrics;
    if (!Array.isArray(list) || list.length === 0) return { known: false, hasTrans: true, hasRoma: true };
    let hasTrans = false;
    let hasRoma = false;
    for (let i = 0; i < list.length; i++) {
        const line = list[i] || {};
        if (!hasTrans) {
            const tr = typeof line.translation === 'string' ? line.translation.trim() : '';
            if (tr && tr !== '//') hasTrans = true;
        }
        if (!hasRoma && typeof line.romaji === 'string' && line.romaji.trim()) hasRoma = true;
        if (hasTrans && hasRoma) break;
    }
    return { known: true, hasTrans, hasRoma };
}

function isLayoutUsable(index, av) {
    const l = LAYOUTS[index];
    return (!l.trans || av.hasTrans) && (!l.roma || av.hasRoma);
}

function applyLayout(index) {
    const s = settings();
    if (!s || !s.lyrics) return false;
    const layout = LAYOUTS[index];
    const mode = currentMode();
    s.lyrics.showTranslation = layout.trans;
    s.lyrics.showRomaji = layout.roma;
    const ms = s.modeSettings && s.modeSettings[mode];
    if (ms) {
        ms.showTranslation = layout.trans;
        ms.showRomaji = layout.roma;
    }
    /* 设置面板 appearance 区读的是预览引擎打开那一刻的 modeVars 快照，
       不同步一次的话面板里的两个开关会显示成切换前的旧值 */
    const pe = typeof globalThis !== 'undefined' ? globalThis.previewEngineInstance : null;
    if (pe && pe.modeVars && pe.modeVars[mode]) {
        pe.modeVars[mode].showTranslation = layout.trans;
        pe.modeVars[mode].showRomaji = layout.roma;
    }
    const list = state.lyrics;
    try {
        if (Array.isArray(list) && list.length > 0) {
            renderLyrics(list);
            updateLyricsHighlight();
        }
    } catch (e) { logCatch(TAG, e); }
    try { saveSettings(); } catch (e) { logCatch(TAG, e); }
    refreshUI();
    return true;
}

export function cycleBilingualLayout(opts) {
    const s = settings();
    if (!s || !s.lyrics) return -1;
    const av = availability();
    const step = (opts && opts.reverse) ? -1 : 1;
    const from = layoutIndexOf(readFlags(s));
    let target = -1;
    let blockedTrans = false;
    let blockedRoma = false;
    for (let n = 1; n < LAYOUTS.length; n++) {
        const idx = (((from + n * step) % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length;
        if (isLayoutUsable(idx, av)) { target = idx; break; }
        const l = LAYOUTS[idx];
        if (l.trans && !av.hasTrans) blockedTrans = true;
        if (l.roma && !av.hasRoma) blockedRoma = true;
    }
    if (target < 0) {
        notify(STR.skipNone);
        refreshUI();
        return from;
    }
    if (!applyLayout(target)) return -1;
    if (!av.known) notify(STR.noLyrics);
    else if (blockedTrans && blockedRoma) notify(STR.skipNoBoth);
    else if (blockedTrans) notify(STR.skipNoTrans);
    else if (blockedRoma) notify(STR.skipNoRoma);
    else notify(STR.hint[target]);
    return target;
}

/* ---------- UI ---------- */

function tipText(index) {
    return fmt(STR.tip, { l: STR.label[index][langIsEn() ? 1 : 0], k: HOTKEY.toUpperCase() });
}

function refreshUI() {
    const d = doc();
    const btn = d && d.getElementById(BTN_ID);
    if (!btn) return;
    const s = settings();
    const index = s ? layoutIndexOf(readFlags(s)) : 0;
    const svg = btn.querySelector('.bc-icon');
    if (svg) svg.innerHTML = ICONS[index];
    const text = btn.querySelector('.bc-text');
    if (text) text.textContent = STR.label[index][langIsEn() ? 1 : 0];
    btn.classList.toggle('is-active', index > 0);
    btn.dataset.layout = String(index);
    const tip = tipText(index);
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('title', tip);
    btn.setAttribute('aria-label', tip);
    /* 这首歌既没译文也没音译时，四个态里只有第 0 个可达 —— 按钮按下去不可能有任何变化，
       就该整个收起。原先只查「能不能跳过去」（cycleBilingualLayout 里 skipNone），
       没收尾可见性，于是大量中文歌上摆着一个永远不变化的「原文」，看着就是坏了。
       歌词还没加载（known=false）时保持可见，避免切歌瞬间闪没。 */
    const av = availability();
    const hasAlt = !av.known || LAYOUTS.some((l, i) => i > 0 && isLayoutUsable(i, av));
    btn.style.display = hasAlt ? '' : 'none';
}

const BTN_HTML = '<svg class="bc-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" '
    + 'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"></svg>'
    + '<span class="bc-text bottom-mode-text"></span>';

const STYLE_CSS = [
    'html#ariaRoot .bilingual-cycle-btn .bc-icon{flex:0 0 auto;}',
    'html#ariaRoot .bilingual-cycle-btn.is-active{color:var(--theme-color,#ffcc33);'
        + 'border-color:color-mix(in srgb,var(--theme-color,#ffcc33) 40%,transparent);'
        + 'background:color-mix(in srgb,var(--theme-color,#ffcc33) 13%,transparent);}',
    'html#ariaRoot .top-action-buttons .bilingual-cycle-btn .bc-text{display:none;}',
].join('\n');

function injectStyle(d) {
    if (d.getElementById(STYLE_ID)) return;
    const style = d.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    d.head.appendChild(style);
}

function buildButton(d) {
    const row = d.querySelector('#bottomControlBar .bottom-controls-row');
    const top = d.querySelector('.top-action-buttons');
    const host = row || top;
    if (!host) return null;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = row ? 'bottom-btn bilingual-cycle-btn' : 'icon-action-btn bilingual-cycle-btn';
    btn.innerHTML = BTN_HTML;
    if (row && row.querySelector('.more-menu-wrapper')) host.insertBefore(btn, row.querySelector('.more-menu-wrapper'));
    else host.appendChild(btn);
    return btn;
}

let _bound = false;

/* 切歌之后必须重算按钮可见性（availability() 读的是 state.lyrics，新歌的译文情况不一样）。
   全仓没有「歌词渲染完」这类事件可订阅，所以退到观察歌词容器的 childList——
   它只在 renderLyrics 重建列表时变化，不是逐帧回调；再叠一层 120ms 合并 +
   签名比对，避免一次重建触发多次。刻意不改 20-lyrics-render.js：那是共享热路径。 */
function bindLyricRecompute(d) {
    const host = d.getElementById('lyricsScroll') || d.querySelector('.lyrics-container');
    if (!host || typeof MutationObserver === 'undefined') return;
    let last = null;
    let timer = null;
    try {
        new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                const song = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
                const sig = `${(state.lyrics && state.lyrics.length) || 0}|${song.songId || song.id || song.title || ''}`;
                if (sig === last) return;
                last = sig;
                try { refreshUI(); } catch (e) { logCatch(TAG, e); }
            }, 120);
        }).observe(host, { childList: true });
    } catch (e) { logCatch(TAG, e); }
}

function bindUI() {
    const d = doc();
    if (!d) return;
    if (!_bound) {
        _bound = true;
        d.addEventListener('keydown', onHotKey);
        if (typeof window !== 'undefined') {
            window.addEventListener('aria:languagechange', () => { try { refreshUI(); } catch (e) { logCatch(TAG, e); } });
        }
        bindLyricRecompute(d);
    }
    let btn = d.getElementById(BTN_ID);
    if (!btn) btn = buildButton(d);
    if (!btn) {
        refreshUI();
        return;
    }
    if (!btn._bcClickBound) {
        btn._bcClickBound = true;
        btn.addEventListener('click', () => {
            try { cycleBilingualLayout(); } catch (e) { logCatch(TAG, e); }
        });
    }
    injectStyle(d);
    refreshUI();
}

function onHotKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.key || e.key.toLowerCase() !== HOTKEY) return;
    const d = doc();
    const act = d && d.activeElement;
    const tag = act && act.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (act && act.isContentEditable)) return;
    if (typeof globalThis !== 'undefined' && globalThis.recordingShortcut) return;
    if (keyClaimed()) return;
    e.preventDefault();
    try { cycleBilingualLayout({ reverse: e.shiftKey }); } catch (err) { logCatch(TAG, err); }
}

/* 用户可在设置里把任意键绑到既有动作上；T 被占时让位，不抢已配置的快捷键 */
function keyClaimed() {
    const sc = (settings() && settings().shortcuts) || {};
    for (const name in sc) {
        if (String(sc[name]).toLowerCase() === HOTKEY) return true;
    }
    return false;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
    else bindUI();
}

if (typeof window !== 'undefined' && typeof Aria !== 'undefined') {
    Aria.__bilingualCycle = {
        cycle: cycleBilingualLayout,
        current: () => layoutIndexOf(readFlags(settings())),
        availability,
        bind: bindUI,
    };
}
