/* ============================================================
 * 286-tempo-boost.js — 长按临时加速 UI 接线（todos #13）
 *
 * 状态机与所有「恢复原速」的路径都在 core/tempoBoost.js，本分片只做三件事：
 *   ① 把现有倍速链路（85-rate-download 的 applyPlaybackRate / applyPreservesPitch）
 *      注入给 core —— core 不 import app/*，这是项目分层约定；
 *   ② 可见反馈：复用现有提示条 setHint（搜索面板内）+ showSettingsHint（底部提示条），
 *      并在 html#ariaRoot 上挂 is-tempo-boost 类供样式侧后续消费，不新造浮层
 *      （OSD 属另一位 agent 的活；web/src/core/osd.js 已预留 showRate()，
 *        接法写进交付报告，这里不额外加一条跨模块硬依赖）；
 *   ③ 长按播放按钮 = 临时加速，并在松手时吃掉那一次 click，
 *      避免「长按完顺手把歌暂停了」。全挂本分片自己的监听上，未改 30/65 分片。
 *
 * 键位默认 x：现有绑定是 Space / ArrowLeft / ArrowRight / F2 / F3 / f / l / m
 * （config/defaults.js DEFAULT_SHORTCUTS），Shift 被歌单多选占用、Ctrl 被
 * Ctrl+←/→ 逐段跳转占用、T 被双语排版循环占用（285 分片），故都不作默认值。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { playBtn } from './30-dom-refs.js';
import { applyPlaybackRate, applyPreservesPitch } from './85-rate-download.js';
import { setHint } from './120-search-results.js';
import { showSettingsHint } from './220-shortcuts-viewmode.js';
import { logCatch } from '../services/log.js';
import {
    TEMPO_BOOST_HOLD_MS,
    engageTempoBoost,
    installTempoBoost,
    onTempoBoostChange,
    releaseTempoBoost,
} from '../core/tempoBoost.js';

/* 动态拼串（嵌倍速数字）i18n observer 翻不到，UI 自己按当前语言组句 */
const STR = {
    boosting: ['⏩ 临时加速 {r}× · 松开恢复', '⏩ Temporarily {r}× · release to restore'],
};

function el(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }

function langIsEn() {
    try {
        const i18n = (typeof globalThis !== 'undefined' && globalThis.AriaI18n) || null;
        return !!(i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === 'en-US');
    } catch (e) { logCatch('tempoBoostUI', e); return false; }
}

function fmt(entry, vars) {
    const tpl = entry[langIsEn() ? 1 : 0];
    return String(tpl).replace(/\{(\w+)\}/g, (all, key) => {
        const v = vars && vars[key];
        return v === undefined || v === null ? all : String(v);
    });
}

function rateText(r) {
    const n = Math.round(Number(r) * 100) / 100;
    return Number.isFinite(n) ? String(n) : '?';
}

/* ---- ① 注入现有倍速链路 ---- */

function readRate() {
    const r = (typeof globalThis !== 'undefined' && typeof globalThis.currentPlaybackRate === 'number')
        ? globalThis.currentPlaybackRate : 1;
    return r > 0 ? r : 1;
}

/** 变速不变调跟随当前设置重写一遍：加速本身就是最容易听出音高漂移的时刻，
    显式补一次比依赖「audio 元素会记住 preservesPitch」更可靠 */
function pitchOn() {
    try {
        const g = typeof globalThis !== 'undefined' ? globalThis.preservesPitch : undefined;
        if (typeof g === 'boolean') return g;
        const s = globalThis.appSettings;
        return !!(s && s.playback && s.playback.preservesPitch);
    } catch (e) {
        logCatch('tempoBoostUI', e);
        return true;
    }
}

function setRate(rate) {
    applyPlaybackRate(rate);
    applyPreservesPitch(pitchOn());
}

/* ---- ② 可见反馈 ---- */

function markRoot(on) {
    try {
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        if (root) root.classList.toggle('is-tempo-boost', !!on);
    } catch (e) { logCatch('tempoBoostUI', e); }
}

onTempoBoostChange((snap) => {
    try {
        if (snap.kind === 'engage') {
            const text = fmt(STR.boosting, { r: rateText(snap.boostedRate) });
            if (typeof setHint === 'function') setHint(text);
            if (typeof showSettingsHint === 'function') showSettingsHint(text);
            markRoot(true);
        } else {
            if (typeof setHint === 'function') setHint('');
            markRoot(false);
        }
    } catch (e) { logCatch('tempoBoostUI', e); }
});

installTempoBoost({
    setRate,
    readRate,
    env: {
        window: typeof window !== 'undefined' ? window : null,
        document: typeof document !== 'undefined' ? document : null,
        audio,
    },
});

/* ---------- ③ 长按播放按钮 ----------
 * pointerdown 起一个 400ms 计时器：到点才真进加速（免得普通点击也先窜一下 2×）。
 * 松手（pointerup 保证先于 click 到达）：
 *   · 没到阈值 → 只是普通点击，计时器取消，click 原样放行；
 *   · 已到阈值 → 立刻恢复原速，并武装一次性捕获监听吃掉那次 click，否则长按完会顺手
 *                把播放/暂停切了；手移出按钮再松时浏览器根本不发 click，
 *                所以那条监听 300ms 自动过期，绝不吞掉用户的下一次正常点击。 */

let _holdTimer = null;
let _longPress = false;
let _disarmSwallow = null;

function clearHoldTimer() {
    if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
}

function armClickSwallow() {
    if (typeof window === 'undefined' || _disarmSwallow) return;
    let armed = true;
    function onCapture(ev) {
        if (!armed) return;
        armed = false;
        clearTimeout(expire);
        window.removeEventListener('click', onCapture, true);
        _disarmSwallow = null;
        if (ev.isTrusted === false) return;   /* 键盘导航等合成 click 照常放行 */
        ev.stopPropagation();
        ev.preventDefault();
    }
    /* click 不会来（松手位置已移出按钮）时的自动过期 */
    const expire = setTimeout(() => {
        armed = false;
        window.removeEventListener('click', onCapture, true);
        _disarmSwallow = null;
    }, 300);
    window.addEventListener('click', onCapture, true);
    _disarmSwallow = () => {
        armed = false;
        clearTimeout(expire);
        window.removeEventListener('click', onCapture, true);
    };
}

function onPlayPointerDown(ev) {
    if (!ev || ev.isTrusted === false) return;
    if (typeof ev.button === 'number' && ev.button !== 0) return;
    clearHoldTimer();
    if (_disarmSwallow) { const stop = _disarmSwallow; _disarmSwallow = null; stop(); }
    _longPress = false;
    /* 暂停态长按没有「加速」可言（也没声音），保留按钮原本的点击语义 */
    if (!audio || audio.paused) return;
    _holdTimer = setTimeout(() => {
        _holdTimer = null;
        _longPress = engageTempoBoost('press');
    }, TEMPO_BOOST_HOLD_MS);
}

function onPlayPointerUp(ev) {
    clearHoldTimer();
    const wasLongPress = _longPress;
    _longPress = false;
    if (wasLongPress && ev && ev.target && typeof ev.target.closest === 'function'
        && ev.target.closest('#playBtn')) {
        armClickSwallow();
    }
    releaseTempoBoost('press');
}

function onPlayPointerCancel() {
    clearHoldTimer();
    _longPress = false;
    releaseTempoBoost('press');
}

/* 30-dom-refs 求值时 DOM 未必就绪，兜底再探一次 */
const boostBtn = (playBtn && typeof playBtn.addEventListener === 'function') ? playBtn : el('playBtn');
if (boostBtn && typeof window !== 'undefined') {
    boostBtn.addEventListener('pointerdown', onPlayPointerDown);
    /* pointerup/cancel 挂 window + capture：按住后把手指移出按钮再松开也必须恢复 */
    window.addEventListener('pointerup', onPlayPointerUp, true);
    window.addEventListener('pointercancel', onPlayPointerCancel, true);
}