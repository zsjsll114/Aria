/* ============================================================
 * 283-readability.js — 歌词可读性一键增强（开关面；样式在 styles/readability.css）
 *
 * 形态选「右上角工具栏单按钮」而不是设置项：糊字是当场发生、当场要修的事，
 * 而设置面板在三层点击之后，且那条路上摆着背景糊度/背景亮度/歌词模糊/情感词
 * 发光/玻璃强度五个互不相干的滑杆——正是要绕开的东西。
 *
 * 三条不变量：
 *  1. 只挂/摘 body 上的叠加类，绝不写任何元素的内联样式，也不回写用户任何
 *     vfx / blurLevel / bgBlur / 颜色设置键（getPerfVfx 与 appSettings 只读）。
 *     关档 = remove 四个类，100% 回到原状。
 *  2. 亮/暗自适配读 100-cover-background.extractDominantColor 的产物
 *     globalThis.dominantColor；重算由事件驱动（封面取色写 documentElement 样式、
 *     背景层 style 变化、视觉模式类变化），无轮询、不进逐帧路径。
 *  3. 偏好藏在 appSettings.interface.readability：180 的 loadSettings() 用固定键
 *     白名单整体重建 appSettings，只有 interface 是全量展开的，新键不藏这里会在
 *     下次启动被静默丢掉（与 282-zen-mode 同一处决定）。
 *
 * 按钮自建自挂（.top-action-buttons 缺失时整套按钮静默缺席，但导出的开关仍可用）；
 * 若日后把 #readabilityBtn 写进 index.html，本分片直接复用、不会重复插一个。
 * ============================================================ */
import { showToast } from './155-random-toast-match.js';
import { getPerfVfx, saveSettings } from './180-boot-config.js';
import { state } from '../infrastructure/state.js';
import { logCatch } from '../services/log.js';

const TAG = 'readability';
const BTN_ID = 'readabilityBtn';

const CLS_BOOST = 'readability-boost';
const CLS_LIGHT = 'readability-on-light';
const CLS_DARK = 'readability-on-dark';
const CLS_DIM = 'readability-dim-bg';
const SWITCH_CLASSES = [CLS_BOOST, CLS_LIGHT, CLS_DARK, CLS_DIM];

/* 「背景把歌词洗白到什么程度」= 封面主色亮度 × 背景亮度（0~1）。
   旧版是两个互不相干的阈值（主色 >= 0.48 或 亮度 >= 0.55 任一命中即亮档），
   于是「白封面 + 默认 0.35 压暗」也被判成亮档 —— 可那层底其实只有 RGB≈89，
   白字压上去清清楚楚，加深底衬纯属自己把画面糊住（用户说的「有点丑」有一半是这里）。
   乘起来才是歌词真正面对的那层底有多亮。 */
const WASH_LIGHT = 0.42;
const WASH_DARK = 0.16;
/* 高斯半径小于此值时封面结构仍清晰可辨（能看出是张照片），细节会穿过字缝，
   等效再按更亮一档算。 */
const SHARP_BG_PX = 24;
const SHARP_BG_WASH = 0.12;

/* 自带深色舞台的模式。名单里两类，理由不同但结论一样：都不挂压暗膜。
   ① 活字/霓虹/格律/穿行/PV —— 舞台是不透明底（#0e0e10 / #0b0d12 / 生成的色块场），
      而 body::after 的压暗膜在 z 轴上位于 .player-container 之下，
      挂上去会被整块舞台盖住：白扣一层合成，什么都看不见。
   ② 飞入/词云 —— 这两档的背景亮度是 viewmode.css 用 !important 写死的
      （.view-flyin .blur-background{filter:blur(80px) brightness(.12)!important}、
      .view-wordcloud 同理 .1，外加一层 ::before 暗遮罩），
      封面主色根本不参与最终背景有多亮 —— 所以它们既不该挂压暗膜，
      也不该按封面主色去走「亮档」的厚底衬+提字色（上一版就是这么错的：
      词云实测被叠了 0.40 的压暗膜，压在本就 0.82 的舞台遮罩上，糊成一片）。
   两类统一走暗档：底衬收到最弱、投影单层、不出描边、不提字色。 */
const SELF_DARK_STAGES = ['view-letterpress', 'view-neon', 'view-tunnel', 'view-dimension', 'view-pv', 'view-flyin', 'view-wordcloud'];

/* 动态拼串（i18n observer 只扫 UI 弹层根，右上角按钮不在内）按 280/285 的做法自组。
   措辞刻意不再列「描边、底衬、压暗背景」——那三件套是上一版的做法，
   现在按模式与亮档给不同手段（见 readability.css 文件头的覆盖面表），
   toast 里点名反而会让人以为每种模式都会压暗整屏。 */
const STR = {
    tipOff: ['歌词可读性增强', 'Lyrics readability boost'],
    tipOn: ['歌词可读性增强 · 已开启（点击关闭）', 'Readability boost on (click to turn off)'],
    on: ['歌词可读性增强已开启', 'Readability boost on'],
    off: ['歌词可读性增强已关闭', 'Readability boost off'],
};

const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">'
    + '<circle cx="12" cy="12" r="9"></circle>'
    + '<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"></path></svg>';

/* ---------- 小工具 ---------- */
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

function fmt(entry) { return String(entry[langIsEn() ? 1 : 0]); }

function numOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

function hasAny(el, names) {
    if (!el || !el.classList) return false;
    for (const n of names) { if (el.classList.contains(n)) return true; }
    return false;
}

/* ---------- 偏好读写（appSettings.interface.readability） ---------- */
function readPref() {
    try {
        const s = settings();
        const r = s && s.interface && s.interface.readability;
        return !!(r && r.on === true);
    } catch (e) { logCatch(TAG, e); return false; }
}

function writePref(on) {
    try {
        const s = settings();
        if (!s || !s.interface) return;
        s.interface.readability = Object.assign({}, s.interface.readability || {}, { on });
        saveSettings();
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 亮/暗判定 ---------- */
/** 封面主色亮度（Rec.709，与 240 同一公式）；拿不到主色返回 null → 走中性档 */
function coverLuminance() {
    try {
        const d = (typeof globalThis !== 'undefined' && globalThis.dominantColor) || null;
        if (!d || !Number.isFinite(Number(d.r)) || !Number.isFinite(Number(d.g)) || !Number.isFinite(Number(d.b))) return null;
        return (0.2126 * Number(d.r) + 0.7152 * Number(d.g) + 0.0722 * Number(d.b)) / 255;
    } catch (e) { logCatch(TAG, e); return null; }
}

/** 背景这一层的干扰强度（0~1，越大越糊字）：
    封面主色亮度 × 背景亮度，糊度不够（还能看出是张照片）时再补一档。
    appSettings 里没有就用当前性能档 vfx 兜底；拿不到主色时只看背景设置。 */
function backdropWash() {
    try {
        const s = settings() || {};
        const bg = s.background || {};
        const vfx = (typeof getPerfVfx === 'function' && getPerfVfx()) || {};
        const blur = numOr(bg.blur, numOr(vfx.coverBlur, 60));
        const brightness = numOr(bg.brightness, 0.35);
        const sharp = blur <= SHARP_BG_PX ? SHARP_BG_WASH : 0;
        const l = coverLuminance();
        if (l === null) return brightness + sharp;
        return l * brightness + sharp;
    } catch (e) { logCatch(TAG, e); return 0.3; }
}

/* 主播放器容器：设置面板的预览壳同时带 .player-container 与 .preview-player
   （themeEngine 就是按这个判定的），取容器一律排掉它，否则用户在设置里翻预览
   会把全局的亮暗档带跑。 */
function mainPlayerContainer() {
    const d = doc();
    return d && d.querySelector ? d.querySelector('.player-container:not(.preview-player)') : null;
}

/** 当前该挂哪个亮度档类（'' = 中性）+ 要不要压暗背景 */
function readScheme() {
    const pc = mainPlayerContainer();
    if (hasAny(pc, SELF_DARK_STAGES)) return { variant: CLS_DARK, dim: false };
    const w = backdropWash();
    if (w >= WASH_LIGHT) return { variant: CLS_LIGHT, dim: true };
    if (w <= WASH_DARK) return { variant: CLS_DARK, dim: true };
    return { variant: '', dim: true };
}

function applyScheme(b) {
    const cur = readScheme();
    b.classList.toggle(CLS_LIGHT, cur.variant === CLS_LIGHT);
    b.classList.toggle(CLS_DARK, cur.variant === CLS_DARK);
    b.classList.toggle(CLS_DIM, cur.dim);
}

/* ---------- 开关 ---------- */
let enabled = false;

function syncButton() {
    const d = doc();
    const btn = d && d.getElementById ? d.getElementById(BTN_ID) : null;
    if (!btn) return;
    btn.classList.toggle('on', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    const tip = fmt(enabled ? STR.tipOn : STR.tipOff);
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('aria-label', tip);
}

/**
 * 设定开关。persist=false 用于启动回放（不把首帧状态再写一遍盘），
 * silent=true 用于程序化调用（不弹 toast）。
 * @param {boolean} on
 * @param {{persist?: boolean, silent?: boolean}} [opts]
 * @returns {boolean} 生效后的状态
 */
function setReadabilityBoost(on, opts) {
    const d = doc();
    const b = d && d.body;
    if (!b) return enabled;
    const o = opts || {};
    const next = !!on;
    const changed = enabled !== next;
    enabled = next;

    if (!enabled) {
        /* 关档：四个类全摘。CSS 侧没有任何一条规则在类之外生效，故无残留。 */
        for (const c of SWITCH_CLASSES) b.classList.remove(c);
    } else {
        b.classList.add(CLS_BOOST);
        applyScheme(b);
    }
    syncButton();

    if (changed && o.persist !== false) writePref(enabled);
    if (changed && !o.silent) showToast(fmt(enabled ? STR.on : STR.off));
    return enabled;
}

function toggleReadabilityBoost() {
    try { return setReadabilityBoost(!enabled); } catch (e) { logCatch(TAG, e); return enabled; }
}

function isReadabilityBoostOn() { return enabled; }

/** 供设置面板/快捷键调用而不必自己拼类名：只重算亮暗档，不改开关 */
function resyncReadabilityScheme() {
    const b = doc() && doc().body;
    if (!b || !enabled) return;
    applyScheme(b);
}

/* ---------- 按钮自建自挂 ---------- */
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
    btn.innerHTML = ICON;
    /* 排在「切换样式」之前：同属外观一族，但比换模式更常按 */
    const anchor = d.getElementById('openViewModeBtn');
    host.insertBefore(btn, anchor && anchor.parentNode === host ? anchor : null);
    return btn;
}

/* ---------- 事件驱动重算（无轮询） ---------- */
function watchAttributes(el, attr, delayMs, fn) {
    const d = doc();
    if (!el || typeof MutationObserver === 'undefined' || !d) return;
    try {
        let timer = null;
        new MutationObserver(() => {
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                try { fn(); } catch (e) { logCatch(TAG, e); }
            }, delayMs);
        }).observe(el, { attributes: true, attributeFilter: [attr] });
    } catch (e) { logCatch(TAG, e); }
}

function bind() {
    const d = doc();
    if (!d) return;
    const btn = ensureButton();
    if (btn && !btn.dataset.rbBound) {
        btn.dataset.rbBound = '1';
        btn.addEventListener('click', toggleReadabilityBoost);
    }

    /* 封面取色收尾会把 --cover-primary 等写进 documentElement.style（100 分片），
       这就是「主色更新了」的事件信号；背景两层的 style 变化则同时覆盖
       切歌与用户拖背景糊度/亮度滑块。 */
    watchAttributes(d.documentElement, 'style', 240, resyncReadabilityScheme);
    watchAttributes(mainPlayerContainer(), 'class', 140, resyncReadabilityScheme);
    d.querySelectorAll('.blur-background').forEach(l => watchAttributes(l, 'style', 300, resyncReadabilityScheme));

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('aria:languagechange', () => {
            try { syncButton(); } catch (e) { logCatch(TAG, e); }
        });
    }
}

function boot() {
    try {
        bind();
        setReadabilityBoost(readPref(), { persist: false, silent: true });
    } catch (e) { logCatch(TAG, e); }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
}

export { isReadabilityBoostOn, resyncReadabilityScheme, setReadabilityBoost, toggleReadabilityBoost };
