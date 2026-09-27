/* ============================================================
 * 282-zen-mode.js — 专注模式（隐藏控件，封面居中，歌词留在画面）
 *
 * 一句话：把「控件在不在」与「歌词长什么样」拆成两个正交维度。
 * 视图模式是 .player-container 上的 view-*；专注模式是 <html id="ariaRoot"> 上
 * 叠加的 is-zen + data-zen-scope="top bottom info …"，样式全在 styles/zen.css。
 * 因此本分片不新增 view-*、也不碰 220 的 switchView。
 *
 * 三个不显然的决定：
 *  1. 偏好存 appSettings.interface.zen 而不是 appSettings.zen：
 *     180 的 loadSettings() 用固定键白名单整体重建 appSettings，只有 interface
 *     是 `{...DEFAULT_SETTINGS.interface, ...saved.interface}` 全量展开的，
 *     新键不藏进 interface 就会在下次启动时被静默丢掉（改白名单=改现有文件，不做）。
 *     快捷键例外：appSettings.shortcuts 本身就是全量展开，所以键位直接放
 *     shortcuts.zen —— 顺带白拿 220 的按键冲突检测与 refreshShortcutUI。
 *  2. ★ 2026-09-27 重设计（用户要求）：删掉整套「鼠标/事件静止检测」——不再
 *     自动进入、不再移动唤回。进入/退出只有两个显式开关：右上角按钮与 Z 键。
 *     进入后 zen.css 豁免 #zenModeBtn 的隐藏，它就是专注态唯一的常驻退出入口。
 *     旧配置里的 interface.zen.enabled / idleSeconds 读到了也忽略。
 *  3. 封面不随 info 隐藏：进入专注时 .cover-area 由 coverShiftToCenter 以
 *     FLIP 方式平移到视口中心（带轻微过冲的非线性曲线），退出回到原位；
 *     隐藏范围里 info 只负责歌名歌手与主控制按钮。
 * ============================================================ */
import { saveSettings } from './180-boot-config.js';
import { esc } from '../utils/formatters.js';
import { logCatch, logInfo } from '../services/log.js';

const TAG = 'zenMode';
const ZEN_CLASS = 'is-zen';
const DEFAULT_ZEN_KEY = 'z';

/* 隐藏范围（token 写进 <html data-zen-scope>，zen.css 逐 token 一条规则）。
   默认开：顶栏图标组 / 底栏控制条 / 歌名歌手与主控制区 / 播放队列 —— 封面不藏
   （进入专注时由 coverShiftToCenter 平移到视口中心）。 */
const ZEN_SCOPES = [
    { token: 'top', label: '右上角图标组（专注按钮除外）', labelEn: 'Top icon row (focus btn stays)', defaultOn: true },
    { token: 'bottom', label: '底部控制条', labelEn: 'Bottom control bar', defaultOn: true },
    { token: 'info', label: '歌名歌手与主控制区', labelEn: 'Title, artist & main controls', defaultOn: true },
    { token: 'titlebar', label: '桌面端标题栏', labelEn: 'Desktop title bar', defaultOn: false },
    { token: 'offset', label: '歌词延时控件', labelEn: 'Lyric offset control', defaultOn: false },
    { token: 'queue', label: '当前播放队列', labelEn: 'Playback queue panel', defaultOn: true }
];

/* 有这些弹窗开着时不进入专注：控件淡出了、弹窗还杵在原地，只会显得像坏了。
   （退出专注永远允许，所以不存在进得去出不来的状态。） */
const MODAL_SELECTOR = [
    '.search-overlay.visible', '.settings-overlay.visible', '.view-mode-overlay.visible',
    '.eq-panel.visible', '.lyric-source-overlay.visible', '.color-picker-overlay.visible',
    '.ctx-menu.visible', '.ctx-confirm.visible', '.aria-dialog-overlay',
    '.ai-models-overlay.visible', '#sleepTimerOverlay.visible', '#ariaOobeOverlay',
    '#welcomeOverlay:not(.hidden)'
].join(', ');

/* 动态拼串（嵌秒数）i18n observer 翻不到，UI 自己按当前语言组句 */
const STR = {
    groupTitle: ['专注模式', 'Focus Mode'],
    scopeLabel: ['隐藏范围', 'What gets hidden'],
    scopeDesc: ['隐藏控件与播放队列；封面与歌词留在画面', 'Hide controls and the queue; the cover and lyrics stay'],
    keyLabel: ['快捷键', 'Shortcut'],
    keyDesc: ['点击按键后按下新键，Esc 取消', 'Click the chip, then press a new key; Esc cancels'],
    keyRecording: ['按下按键...', 'Press a key...'],
    keyConflict: ['该按键已被其它功能占用', 'That key is already bound to another action'],
    btnLabel: ['专注模式', 'Focus mode'],
    tipOn: ['退出专注模式（控件已隐藏，封面居中）', 'Exit focus mode (controls hidden, cover centered)'],
    tipOff: ['进入专注模式（隐藏控件，封面移到中央）', 'Enter focus mode (hide controls, center the cover)']
};

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

function doc() { return typeof document !== 'undefined' ? document : null; }
function q(sel) { const d = doc(); return d && d.querySelector ? d.querySelector(sel) : null; }
function qsa(sel) { const d = doc(); return d && d.querySelectorAll ? Array.from(d.querySelectorAll(sel)) : []; }

/* ---------- 偏好读写 ---------- */
function appSettingsOf() {
    return (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
}

/** 当前生效的专注模式配置（缺省项按保守默认补齐）
 *  ★ 2026-09-27：enabled/idleSeconds 随「静止自动进入」机制一起删除，
 *    旧配置里的这两个键读到了也忽略。 */
export function getZenSettings() {
    let saved = null;
    try {
        const s = appSettingsOf();
        saved = (s && s.interface && s.interface.zen) || null;
    } catch (e) { logCatch(TAG, e); }
    const stored = saved && typeof saved === 'object' ? saved : {};
    const scopePrefs = stored.scopes && typeof stored.scopes === 'object' ? stored.scopes : {};
    const scopes = {};
    ZEN_SCOPES.forEach(item => {
        scopes[item.token] = typeof scopePrefs[item.token] === 'boolean'
            ? scopePrefs[item.token] : item.defaultOn;
    });
    return { scopes };
}

function persistZen(patch) {
    try {
        const s = appSettingsOf();
        if (!s) return;
        if (!s.interface) s.interface = {};
        s.interface.zen = Object.assign({}, s.interface.zen || {}, patch);
        if (typeof saveSettings === 'function') saveSettings();
    } catch (e) { logCatch(TAG, e); }
}

/** 专注模式开关键：与其余快捷键同处 appSettings.shortcuts，
   所以 220 的录制器与冲突检测天然覆盖它（键位缺失时回退 'z'） */
function getZenKey() {
    try {
        const s = appSettingsOf();
        const k = s && s.shortcuts && s.shortcuts.zen;
        return typeof k === 'string' && k ? k : DEFAULT_ZEN_KEY;
    } catch (e) { logCatch(TAG, e); return DEFAULT_ZEN_KEY; }
}

function keyDisplay(k) {
    if (k === ' ') return 'Space';
    if (k === 'ArrowLeft') return '←';
    if (k === 'ArrowRight') return '→';
    if (k === 'ArrowUp') return '↑';
    if (k === 'ArrowDown') return '↓';
    return k && k.length === 1 ? k.toUpperCase() : String(k || '');
}

/* ===== 按键录制（兜底） =====
   胶囊用的是 .shortcut-key + data-shortcut="zen"，220 的录制器（bootApp 里按类名全局绑）
   正常能接管它。但本分片若晚于 boot 才引入（例如只被设置页按需 import），220 那一轮已经
   跑完，胶囊就成了只能看的。下面这份兜底与 220 以「defaultPrevented」互斥：
   谁先处理这次按键，另一方就让位，两条路写的都是同一个 appSettings.shortcuts.zen。 */
function bindZenKeyRecorder(chip) {
    if (!chip) return;
    chip.addEventListener('click', () => {
        /* 220 的录制器已经在等键：不抢，也别改它的文案 */
        if (typeof globalThis !== 'undefined' && globalThis.recordingShortcut) return;
        _recordingKey = !_recordingKey;
        chip.classList.toggle('recording', _recordingKey);
        chip.textContent = _recordingKey ? fmt(STR.keyRecording) : keyDisplay(getZenKey());
    });
}

function onRecordKey(e) {
    if (!_recordingKey) return;
    const chip = q('#zenShortcutKey');
    if (e.defaultPrevented || (typeof globalThis !== 'undefined' && globalThis.recordingShortcut)) {
        _recordingKey = false;   /* 220 已接管：它的 refreshShortcutUI + 自身收尾会刷新文案 */
        return;
    }
    _recordingKey = false;
    if (chip) chip.classList.remove('recording');
    if (e.key === 'Escape') {
        if (chip) chip.textContent = keyDisplay(getZenKey());
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const s = appSettingsOf();
    if (!s) return;
    if (!s.shortcuts) s.shortcuts = {};
    for (const k in s.shortcuts) {
        /* 与 220 同款策略：撞键就拒绝写入，不改任何已有绑定 */
        if (s.shortcuts[k] === e.key && k !== 'zen') {
            toast(STR.keyConflict);
            if (chip) chip.textContent = keyDisplay(getZenKey());
            return;
        }
    }
    s.shortcuts.zen = e.key;
    try {
        if (typeof saveSettings === 'function') saveSettings();
    } catch (err) { logCatch(TAG, err); }
    if (chip) chip.textContent = keyDisplay(e.key);
}

/* ---------- 状态机（2026-09-27 重设计）----------
   ★ 删掉整套「鼠标/事件静止检测」：不再自动进入、不再移动唤回。
   交互收敛为两个显式开关：右上角按钮 / Z 键。进入后右上角按钮就是退出入口
   （zen.css 豁免它在 top scope 的隐藏）。封面在进入时 FLIP 平移到视口中心，
   退出时回到原位——只隐藏控件，封面与歌词留在画面。 */
let _zen = false;
let _recordingKey = false;

export function isZenActive() { return _zen; }

function hasBlockingModal() {
    try { return !!q(MODAL_SELECTOR); } catch (e) { logCatch(TAG, e); return true; }
}

/* 现在播放被系统接管（Now Playing 只读模式）时，110 把全部快捷键让位，
   本键跟着让位。 */
function inReadTakeover() {
    try {
        const A = (typeof globalThis !== 'undefined' && globalThis.Aria) || null;
        return !!(A && typeof A.__npActive === 'function' && A.__npActive());
    } catch (e) { logCatch(TAG, e); return false; }
}

function activeScopeTokens(cfg) {
    return ZEN_SCOPES.filter(item => cfg.scopes[item.token]).map(item => item.token);
}

/* 值不变不写：documentElement 上的属性写入会触发全树 style recalc */
function applyScopeAttr() {
    const root = doc() && doc().documentElement;
    if (!root) return;
    const v = activeScopeTokens(getZenSettings()).join(' ');
    if (root.getAttribute('data-zen-scope') !== v) root.setAttribute('data-zen-scope', v);
}

/* ---------- 封面 FLIP 平移（进入 → 视口中心，退出 → 原位） ----------
   非线性用带轻微过冲的弹簧曲线；坐标按进入瞬间的 getBoundingClientRect 计算，
   只在这一刻读一次布局（避免每帧回流）。resize 时若仍在专注态就重新对位。 */
const COVER_EASE_IN = 'transform 0.9s cubic-bezier(0.22, 1.2, 0.36, 1)';
const COVER_EASE_OUT = 'transform 0.7s cubic-bezier(0.33, 0, 0.2, 1)';

function coverShiftToCenter() {
    const cover = q('.cover-area');
    if (!cover) return;
    const r = cover.getBoundingClientRect();
    const dx = (window.innerWidth / 2) - (r.left + r.width / 2);
    const dy = (window.innerHeight / 2) - (r.top + r.height / 2);
    cover.style.transition = COVER_EASE_IN;
    cover.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
}

function coverShiftReset() {
    const cover = q('.cover-area');
    if (!cover) return;
    cover.style.transition = COVER_EASE_OUT;
    cover.style.transform = '';
}

/**
 * 进入专注模式。
 * @param {'manual'|'idle'} [reason] manual 才给一次性提示
 * @returns {boolean} 调用后是否处于专注态（被开关/弹窗挡下时 false；已在专注态算 true）
 */
export function enterZen() {
    if (_zen) return true;
    const d = doc();
    if (!d || !d.documentElement) return false;
    if (!activeScopeTokens(getZenSettings()).length) return false;
    if (hasBlockingModal()) return false;
    applyScopeAttr();
    d.documentElement.classList.add(ZEN_CLASS);
    _zen = true;
    coverShiftToCenter();
    syncZenSettingsUI();
    return true;
}

/** 退出专注模式（无条件可用，杜绝「控件永久消失」） */
export function exitZen() {
    const d = doc();
    if (!_zen || !d || !d.documentElement) return false;
    d.documentElement.classList.remove(ZEN_CLASS);
    _zen = false;
    coverShiftReset();
    syncZenSettingsUI();
    return true;
}

export function toggleZen() {
    return _zen ? exitZen() : enterZen();
}

/* 一次性提示（Z 键/按钮进入时给一句「动一下鼠标就回来」）。
   刻意不 import 155 的 showToast：那个分片在本分片之后加载，反向依赖会成环，
   所以走 globalThis 上已经挂好的实现，取不到就当没提示。 */
function toast(entry) {
    try {
        const fn = (typeof globalThis !== 'undefined' && globalThis.showToast) || null;
        if (typeof fn === 'function') fn(fmt(entry));
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 「先记下意图，等浮层关掉再进」 ----------
   启用开关长在设置面板里，而设置面板本身就是 MODAL_SELECTOR 的一条：
   「有弹窗开着就不进入」这条规则会把自己绊倒——用户在设置里点亮开关，
   enterZen 当场拒绝，关掉面板后又没有任何东西再触发一次（自动进入默认是关的），
   于是看到的就是「开了也不隐藏任何控件」。所以开关点下去时要留一次待进入意图。 */

/* ---------- 按键（Z 键 = 显式开关；其余按键不参与状态机） ---------- */

function inTextEntry(target) {
    const tag = target && target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!(target && target.isContentEditable);
}

function onKeydown(e) {
    /* 设置页的按键录制（220 或本分片的兜底录制）正在等一个键：让位，
       别把这次按键当播放快捷键用 */
    if (_recordingKey) return;
    if (typeof globalThis !== 'undefined' && globalThis.recordingShortcut) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.defaultPrevented) return;
    if (!inTextEntry(e.target) && e.key === getZenKey() && !inReadTakeover()) {
        /* 弹窗挡路时不吞按键，交回原有快捷键派发 */
        if (!_zen && hasBlockingModal()) return;
        e.preventDefault();
        toggleZen();
    }
}

/* .player-container 上的 view-* 令牌集合（可视化引擎会加自己的 view-* 类） */
function viewTokensOf(el) {
    try {
        const cls = typeof el.className === 'string' ? el.className : '';
        return cls.split(/\s+/).filter(c => c.indexOf('view-') === 0).sort().join(' ');
    } catch (e) { logCatch(TAG, e); return ''; }
}

/* 视图模式切换的瞬间退出专注：is-zen 与 view-* 正交，但 view-* 分支里
   大量 !important 的定位/显示规则会改变控件语义，留在专注态下最容易撞上
   「控件再也不回来」的死状态。退出是无条件且无害的。
   ★ 只比对 view-* 令牌集合：.player-container 是别人的公共画布，
   任何无关类名变化（将来加的 is-xxx / perf 标记）都不该把用户从专注里踢出去。 */
function bindViewModeGuard() {
    const pc = q('.player-container');
    if (!pc || typeof MutationObserver === 'undefined') return;
    try {
        let last = viewTokensOf(pc);
        new MutationObserver(() => {
            const now = viewTokensOf(pc);
            if (now === last) return;
            last = now;
            if (_zen) exitZen();
        }).observe(pc, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 样式接线兜底 ----------
   正解是 index.html 里加一条 <link>；这条兜底让「只 import 分片、还没改
   index.html」的中间状态也能看到效果，已存在（不论相对还是绝对 href）就不重复注入。 */
function ensureStylesheet() {
    const d = doc();
    if (!d || !d.head) return;
    try {
        const existing = Array.from(d.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of existing) {
            if (link.href && link.href.indexOf('/styles/zen.css') >= 0) return;
        }
        if (d.getElementById('zenModeStyles')) return;
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.id = 'zenModeStyles';
        link.href = new URL('../styles/zen.css', import.meta.url).href;
        d.head.appendChild(link);
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 设置页 UI（自建，不改 index.html 也能配） ---------- */
function scopeRowHTML(item) {
    return `<div class="setting-row">
        <div><div class="setting-label">${esc(fmt([item.label, item.labelEn]))}</div></div>
        <div class="setting-control"><button type="button" class="setting-toggle" data-zen-scope="${esc(item.token)}"></button></div>
    </div>`;
}

function rowHTML(labelEntry, descEntry, controlHTML) {
    return `<div class="setting-row">
        <div>
            <div class="setting-label">${esc(fmt(labelEntry))}</div>
            <div class="setting-desc">${esc(fmt(descEntry))}</div>
        </div>
        <div class="setting-control">${controlHTML}</div>
    </div>`;
}

/** 把「专注模式」设置组挂进设置 → 界面；缺容器时静默跳过（不报错、不影响快捷键入口） */
export function mountZenSettingsUI() {
    const d = doc();
    if (!d || d.getElementById('zenSettingsGroup')) return;
    const host = q('[data-section="interface"]') || q('#settingsBody');
    if (!host) return;
    try {
        const group = d.createElement('div');
        group.className = 'settings-group';
        group.id = 'zenSettingsGroup';
        const title = langIsEn() ? STR.groupTitle[1] : STR.groupTitle[0];
        group.innerHTML = `
            <div class="settings-group-title">${esc(title)}</div>
            ${rowHTML(STR.scopeLabel, STR.scopeDesc, '')}
            ${ZEN_SCOPES.map(scopeRowHTML).join('')}
            ${rowHTML(STR.keyLabel, STR.keyDesc,
                `<div class="shortcut-key" id="zenShortcutKey" data-shortcut="zen">${esc(keyDisplay(getZenKey()))}</div>`)}`;
        host.appendChild(group);

        group.querySelectorAll('[data-zen-scope]').forEach(btn => {
            btn.addEventListener('click', () => {
                const cfg2 = getZenSettings();
                const token = btn.getAttribute('data-zen-scope');
                cfg2.scopes[token] = !cfg2.scopes[token];
                persistZen({ scopes: cfg2.scopes });
                syncZenSettingsUI();
                applyScopeAttr();
            });
        });
        /* 「恢复默认快捷键」会把 shortcuts 整个换成 DEFAULT_SHORTCUTS（不含 zen），
           此处只负责把按键胶囊刷回真正生效的键位，不改 200 的行为 */
        d.getElementById('setResetShortcuts')?.addEventListener('click', syncZenSettingsUI);
        bindZenKeyRecorder(group.querySelector('#zenShortcutKey'));

        /* 设置面板每次打开都重刷一遍：bootApp 里 loadSettings() 是 await 之后的事，
           面板上的值必须以当时生效的配置为准，不能用启动瞬间的快照 */
        const overlay = d.getElementById('settingsOverlay');
        if (overlay && typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => {
                if (overlay.classList.contains('visible')) syncZenSettingsUI();
            }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }
        syncZenSettingsUI();
        applyScopeAttr();
    } catch (e) { logCatch(TAG, e); }
}

export function syncZenSettingsUI() {
    const cfg = getZenSettings();
    const on = (el, v) => { if (el) el.classList.toggle('on', !!v); };
    syncButtonState();
    qsa('[data-zen-scope]').forEach(el => on(el, cfg.scopes[el.getAttribute('data-zen-scope')]));
    const chip = q('#zenShortcutKey');
    if (chip && !chip.classList.contains('recording')) chip.textContent = keyDisplay(getZenKey());
}


/* ---------- 顶栏按钮（用户要求：可进「自定义按钮栏」，隐藏后收进「更多」） ---------- */
const BTN_ID = 'zenModeBtn';

/* 按钮的统一行为（2026-09-27 重设计：跟随设置、无隐藏门槛）：
   屏幕在专注 → 退出；否则立即进入。无 enabled 门槛（它随 idle 检测一起删了）。 */
function zenButtonClick() {
    toggleZen();
}

/* 取景框四角 + 中心点：「只剩内容」的隐喻。线宽与其它顶栏图标一致，
   不用任何 unicode 字符当图标（缺字会掉豆腐块，线宽也对不齐）。 */
const BTN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"></path>'
    + '<path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"></path>'
    + '<path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"></path>'
    + '<path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"></path>'
    + '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"></circle></svg>';

function ensureButton() {
    const d = doc();
    if (!d) return null;
    const existing = d.getElementById(BTN_ID);
    if (existing) return existing;
    const host = d.querySelector('.top-action-buttons');
    if (!host) return null;
    const btn = d.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = 'icon-action-btn';
    btn.innerHTML = BTN_ICON;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zenButtonClick();
    });
    /* 排在「 readabilityBtn / 切换样式」之前：同属外观一族。
       两个都可能在或都不在，所以逐个兜底。 */
    const anchor = d.getElementById('readabilityBtn') || d.getElementById('openViewModeBtn');
    host.insertBefore(btn, anchor && anchor.parentNode === host ? anchor : null);
    return btn;
}

function syncButtonState() {
    const btn = ensureButton();
    if (!btn) return;
    const active = isZenActive();
    btn.classList.toggle('on', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.setAttribute('aria-label', fmt(STR.btnLabel));
    btn.setAttribute('data-tooltip', fmt(active ? STR.tipOn : STR.tipOff));
}

/* ---------- 装配 ---------- */
let _inited = false;

export function initZenMode() {
    const d = doc();
    if (_inited || !d) return;
    _inited = true;
    ensureStylesheet();
    mountZenSettingsUI();
    ensureButton();

    d.addEventListener('keydown', onKeydown);
    d.addEventListener('keydown', onRecordKey);
    bindViewModeGuard();

    /* 顶栏入口按钮：index.html 里有 #openZenBtn 就自动接上（没有则完全跳过） */
    q('#openZenBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zenButtonClick();
    });

    applyScopeAttr();
    /* 专注态下窗口尺寸变化会破坏封面居中，重算一次 */
    window.addEventListener('resize', () => { if (_zen) coverShiftToCenter(); });
}

/* 分片按 index.js 顺序在文档解析后求值，正常这里 DOM 已就绪；
   万一被更早引入（或改成 async），退到 DOMContentLoaded，不在半棵树上建 UI。 */
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initZenMode, { once: true });
    } else {
        initZenMode();
    }
}
