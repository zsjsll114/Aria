/* ============================================================
 * 282-zen-mode.js — 专注模式（只留歌词）
 *
 * 一句话：把「控件在不在」与「歌词长什么样」拆成两个正交维度。
 * 视图模式是 .player-container 上的 view-*；专注模式是 <html id="ariaRoot"> 上
 * 叠加的 is-zen + data-zen-scope="top bottom info …"，样式全在 styles/zen.css。
 * 因此本分片不新增 view-*、也不碰 220 的 switchView。
 *
 * 两个不显然的决定：
 *  1. 偏好存 appSettings.interface.zen 而不是 appSettings.zen：
 *     180 的 loadSettings() 用固定键白名单整体重建 appSettings，只有 interface
 *     是 `{...DEFAULT_SETTINGS.interface, ...saved.interface}` 全量展开的，
 *     新键不藏进 interface 就会在下次启动时被静默丢掉（改白名单=改现有文件，不做）。
 *     快捷键例外：appSettings.shortcuts 本身就是全量展开，所以键位直接放
 *     shortcuts.zen —— 顺带白拿 220 的按键冲突检测与 refreshShortcutUI。
 *  2. 静止判定用「活动事件 + 单发 setTimeout」，不常驻 interval；退出专注后立即
 *     重新武装，所以「静止 N 秒 → 淡出 → 动一下 → 淡回」是同一个循环。
 * ============================================================ */
import { saveSettings } from './180-boot-config.js';
import { esc } from '../utils/formatters.js';
import { logCatch, logInfo } from '../services/log.js';

const TAG = 'zenMode';
const ZEN_CLASS = 'is-zen';
const DEFAULT_ZEN_KEY = 'z';
const DEFAULT_IDLE_SECONDS = 4;
const MIN_IDLE_SECONDS = 1;
const MAX_IDLE_SECONDS = 60;
/* 活动事件的重新计时节流：静止判定最多比真实值早这么久触发，换取
   mousemove（每秒几十次）不会次次去 clearTimeout/setTimeout。 */
const ARM_THROTTLE_MS = 400;

/* 隐藏范围（token 写进 <html data-zen-scope>，zen.css 逐 token 一条规则）。
   默认开前三个：顶栏图标组 / 底栏控制条 / 播放信息列 —— 歌词与背景一律不动。 */
const ZEN_SCOPES = [
    { token: 'top', label: '右上角图标组', labelEn: 'Top icon row', defaultOn: true },
    { token: 'bottom', label: '底部控制条', labelEn: 'Bottom control bar', defaultOn: true },
    { token: 'info', label: '播放信息列（封面 / 歌名 / 主控制区）', labelEn: 'Cover & info column', defaultOn: true },
    { token: 'titlebar', label: '桌面端标题栏', labelEn: 'Desktop title bar', defaultOn: false },
    { token: 'offset', label: '歌词延时控件', labelEn: 'Lyric offset control', defaultOn: false },
    { token: 'queue', label: '当前播放队列', labelEn: 'Playback queue panel', defaultOn: false }
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
    enableLabel: ['启用专注模式', 'Enable Focus Mode'],
    enableDesc: ['只留歌词与背景，其余控件淡出', 'Fade everything out but the lyrics and the background'],
    idleLabel: ['静止判定时长', 'Idle delay'],
    idleDesc: ['多少秒无操作后进入专注模式（1~60 秒）', 'Seconds of no activity before entering (1-60s)'],
    idleValue: ['静止 {n} 秒', 'Idle {n}s'],
    scopeLabel: ['隐藏范围', 'What gets hidden'],
    scopeDesc: ['默认只隐藏右上角图标组、底部控制条与播放信息列', 'By default: top icons, bottom bar and the cover/info column only'],
    keyLabel: ['快捷键', 'Shortcut'],
    keyDesc: ['点击按键后按下新键，Esc 取消', 'Click the chip, then press a new key; Esc cancels'],
    keyRecording: ['按下按键...', 'Press a key...'],
    keyConflict: ['该按键已被其它功能占用', 'That key is already bound to another action'],
    toastOn: ['专注模式：动一下鼠标即可唤回控件', 'Focus mode: move the pointer to bring the controls back'],
    toastOff: ['已关闭专注模式', 'Focus mode is off'],
    btnLabel: ['专注模式', 'Focus mode'],
    tipOn: ['专注模式 · 已开启（点击退出，控件立即唤回）', 'Focus mode on — click to bring the controls back'],
    tipOff: ['专注模式（只留歌词，其余控件淡出）', 'Focus mode: hide everything but the lyrics']
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

function clampNumber(v, lo, hi, fallback) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** 当前生效的专注模式配置（缺省项按保守默认补齐） */
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
    return {
        /* ★ 默认**关**。这个功能会自己把控件淡出去，没开过的人不该被它吓到
           （历史上正是 `!== false` 让 zenPref 为空时也算开，静止 4 秒控件自己没了）。
           开了之后「静止 N 秒自动隐藏」就是它的核心行为，所以不再另设 autoEnter 一层。 */
        enabled: stored.enabled === true,
        idleSeconds: clampNumber(stored.idleSeconds, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS, DEFAULT_IDLE_SECONDS),
        scopes
    };
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

/* ---------- 状态机 ---------- */
let _zen = false;
let _idleTimer = null;
let _lastArmAt = 0;
let _armedDelay = 0;
let _recordingKey = false;

export function isZenActive() { return _zen; }

function hasBlockingModal() {
    try { return !!q(MODAL_SELECTOR); } catch (e) { logCatch(TAG, e); return true; }
}

/* 现在播放被系统接管（Now Playing 只读模式）时，110 把全部快捷键让位，
   本键跟着让位，只保留「动一下鼠标唤回控件」这条路。 */
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

function clearIdleTimer() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

/* 当前配置下的静止时长；自动进入关掉或总开关关掉时为 0 */
function idleDelayMs() {
    const cfg = getZenSettings();
    if (!cfg.enabled) return 0;
    return Math.max(MIN_IDLE_SECONDS, cfg.idleSeconds) * 1000;
}

function armIdleTimer() {
    clearIdleTimer();
    _lastArmAt = Date.now();
    const delay = idleDelayMs();
    _armedDelay = delay;
    if (!delay) return;
    _idleTimer = setTimeout(() => {
        _idleTimer = null;
        /* 被弹窗挡下时不自旋重试：下一次鼠标活动会重新武装 */
        enterZen('idle');
    }, delay);
}

/**
 * 进入专注模式。
 * @param {'manual'|'idle'} [reason] manual 才给一次性提示
 * @returns {boolean} 调用后是否处于专注态（被开关/弹窗挡下时 false；已在专注态算 true）
 */
export function enterZen(reason) {
    if (_zen) return true;
    const d = doc();
    if (!d || !d.documentElement) return false;
    const cfg = getZenSettings();
    /* 挡下的理由只在「用户主动按键/点按钮」时留痕：自动进入每首歌都会试，报了就成噪音 */
    const refuse = (why) => {
        if (reason === 'manual') logInfo(TAG, '手动进入被挡下：', why);
        return false;
    };
    if (!cfg.enabled) return refuse('总开关关闭');
    if (!activeScopeTokens(cfg).length) return refuse('隐藏范围为空');
    if (hasBlockingModal()) return refuse('有弹窗开着');
    applyScopeAttr();
    d.documentElement.classList.add(ZEN_CLASS);
    _zen = true;
    clearIdleTimer();
    /* 任何入口（Z 键 / 静止自动 / 按钮）都要回写一次面板与按钮，
       否则会出现「屏幕已经专注了，开关还写着关」。 */
    persistZen({ enabled: true });
    syncZenSettingsUI();
    if (reason === 'manual') toast(STR.toastOn);
    return true;
}

/** 退出专注模式（无条件可用，杜绝「控件永久消失」） */
export function exitZen() {
    const d = doc();
    if (!_zen || !d || !d.documentElement) return false;
    d.documentElement.classList.remove(ZEN_CLASS);
    _zen = false;
    /* 只回写开关显示，**不**改 enabled：动一下鼠标退出专注，不该顺手把 Z 键也禁掉 */
    syncZenSettingsUI();
    armIdleTimer();
    return true;
}

export function toggleZen(reason) {
    return _zen ? exitZen() : enterZen(reason || 'manual');
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

/* ---------- 活动侦测 ---------- */
/* ★ 两类活动分开（用户定的语义）：
     点击/按键 = 真在用软件 → 重置倒计时 + 退出专注；
     鼠标移动/滚轮 = 只是路过 → 在专注态里把控件唤回，但**不重置**进入倒计时；
       唤回之后进入「再进入要连移动都算活动」的严格窗口，避免鼠标一直在动却突然淡出。 */
let _reentryStrict = false;

function onClickActivity() {
    _reentryStrict = false;
    if (_zen) { exitZen(); return; }
    armIdleTimer();
}

function onMoveActivity() {
    if (_zen) {
        exitZen();
        _reentryStrict = true;
        armIdleTimer();
        return;
    }
    /* 非严格窗口里移动不重置倒计时——用户要的是「一段时间没点击就自动隐藏」，
       而不是「必须一动不动」。 */
    if (_reentryStrict) armIdleTimer();
}

function onActivity() {
    if (_zen) { exitZen(); return; }
    /* 秒数被改过（设置面板、或后端配置异步落回）时不能受节流保护，
       否则旧时长的那枚定时器会一直服役到它自己到期 */
    if (Date.now() - _lastArmAt < ARM_THROTTLE_MS && idleDelayMs() === _armedDelay) return;
    armIdleTimer();
}

function inTextEntry(target) {
    const tag = target && target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!(target && target.isContentEditable);
}

function onKeydown(e) {
    /* 设置页的按键录制（220 或本分片的兜底录制）正在等一个键：让位，
       别把这次按键当播放快捷键用 */
    if (_recordingKey) return;
    if (typeof globalThis !== 'undefined' && globalThis.recordingShortcut) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.defaultPrevented) { onActivity(); return; }
    if (!inTextEntry(e.target) && e.key === getZenKey() && !inReadTakeover()) {
        /* 弹窗挡路时不吞按键，交回原有快捷键派发 */
        if (!_zen && hasBlockingModal()) { onActivity(); return; }
        e.preventDefault();
        toggleZen('manual');
        return;
    }
    onActivity();
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
            ${rowHTML(STR.enableLabel, STR.enableDesc,
                '<button type="button" class="setting-toggle" id="zenEnabledToggle"></button>')}
            ${rowHTML(STR.idleLabel, STR.idleDesc,
                `<input type="range" class="setting-slider" id="zenIdleSlider" min="${MIN_IDLE_SECONDS}" max="${MAX_IDLE_SECONDS}" step="1">
                 <span class="setting-value" id="zenIdleVal"></span>`)}
            ${rowHTML(STR.scopeLabel, STR.scopeDesc, '')}
            ${ZEN_SCOPES.map(scopeRowHTML).join('')}
            ${rowHTML(STR.keyLabel, STR.keyDesc,
                `<div class="shortcut-key" id="zenShortcutKey" data-shortcut="zen">${esc(keyDisplay(getZenKey()))}</div>`)}`;
        host.appendChild(group);

        group.querySelector('#zenEnabledToggle')?.addEventListener('click', () => {
            /* 开关只管「这个功能开不开」，**不**立刻进入界面。
               历史上有两版错法：① 只写偏好、点完什么都没发生（用户报「开了也不隐藏任何控件」，
               其实还要再按一次 Z）；② 点完立刻淡出全部控件——设置面板还开着就当场清空界面，
               像坏了。现在：点亮 = 开始按「静止 N 秒」自动进入；要立刻进用按钮或 Z 键。 */
            const next = !getZenSettings().enabled;
            persistZen({ enabled: next });
            /* ★ 点亮开关不等于「立刻进入」：用户要的是「开之后，一段时间没点击就自动隐藏」。
               立刻进入会把界面突然清空，反而像坏了；要马上进有按钮和 Z 键。 */
            if (!next) exitZen();
            _reentryStrict = false;
            syncZenSettingsUI();
            applyScopeAttr();
            armIdleTimer();
        });
        const slider = group.querySelector('#zenIdleSlider');
        slider?.addEventListener('input', () => {
            const n = clampNumber(slider.value, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS, DEFAULT_IDLE_SECONDS);
            persistZen({ idleSeconds: n });
            syncZenSettingsUI();
            armIdleTimer();
        });
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
    /* ★ 这颗开关显示的是「现在是不是专注态」，不是「enabled 偏好」。
       enabled 默认是 true（为了让 Z 键开箱可用），于是旧写法一开机就把开关点亮，
       用户点它 = 关掉 = 什么都不发生，再点一次才进入——这就是「开了也不隐藏任何控件」
       里最迷惑的那一半。开关既然叫「专注模式」，它就该等于屏幕上有没有在专注。 */
    on(q('#zenEnabledToggle'), cfg.enabled);
    syncButtonState();
    qsa('[data-zen-scope]').forEach(el => on(el, cfg.scopes[el.getAttribute('data-zen-scope')]));
    const slider = q('#zenIdleSlider');
    /* 用户正在拖这根滑条时不回写 value，否则拖动会被自己的同步打断 */
    const d = doc();
    if (slider && (!d || d.activeElement !== slider)) slider.value = String(cfg.idleSeconds);
    const val = q('#zenIdleVal');
    if (val) val.textContent = fmt(STR.idleValue, { n: cfg.idleSeconds });
    const chip = q('#zenShortcutKey');
    if (chip && !chip.classList.contains('recording')) chip.textContent = keyDisplay(getZenKey());
}


/* ---------- 顶栏按钮（用户要求：可进「自定义按钮栏」，隐藏后收进「更多」） ---------- */
const BTN_ID = 'zenModeBtn';
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
        /* 按钮是「手动立刻切换」，与开关的偏好语义不同；
           按完之后把静止倒计时重新武装，避免刚退出又马上自动进去。 */
        e.preventDefault();
        e.stopPropagation();
        toggleZen('manual');
        /* 不能再调 onClickActivity()：它看到「已经在专注态」会立刻退出，
           于是按钮变成「按一下没反应」。只在退出的那条路上重新武装倒计时。 */
        if (!_zen) { _reentryStrict = false; armIdleTimer(); }
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

    ['mousemove', 'wheel'].forEach(type => d.addEventListener(type, onMoveActivity, { passive: true }));
    ['mousedown', 'touchstart', 'pointerdown'].forEach(type => d.addEventListener(type, onClickActivity, { passive: true }));
    d.addEventListener('keydown', onKeydown);
    d.addEventListener('keydown', onRecordKey);
    bindViewModeGuard();

    /* 顶栏入口按钮：index.html 里有 #openZenBtn 就自动接上（没有则完全跳过） */
    q('#openZenBtn')?.addEventListener('click', () => toggleZen('manual'));

    applyScopeAttr();
    armIdleTimer();
    /* 180 的 bootApp 会 await 一次后端配置读取，appSettings 可能在 DOMContentLoaded
       之后才被整体替换 —— 空挡期里没有任何鼠标活动可依赖，load 后再对齐一次。 */
    if (typeof window !== 'undefined') {
        window.addEventListener('load', () => {
            applyScopeAttr();
            syncZenSettingsUI();
            armIdleTimer();
        }, { once: true });
    }
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
