/* ============================================================
 * 280-sleep-timer.js — 睡眠定时器 UI（右上角入口按钮 + 弹出选择层）
 *
 * 定时/斜坡/暂停全在 core/sleepTimer.js，本分片只做渲染、事件与 appSettings 持久化。
 * 依赖的 DOM 在 index.html 静态写死（#sleepTimerBtn / #sleepTimerOverlay），
 * 缺失时整套 UI 静默不绑定，不报错——接线前也允许本分片先行 import。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { setHint } from './120-search-results.js';
import { saveSettings } from './180-boot-config.js';
import { esc, formatTime } from '../utils/formatters.js';
import { logCatch } from '../services/log.js';
import {
    SLEEP_FADE_MS,
    SLEEP_MAX_MINUTES,
    SLEEP_MIN_MINUTES,
    SLEEP_PRESET_MINUTES,
    cancelSleepTimer,
    getSleepMinutes,
    getSleepRemainingMs,
    initSleepTimer,
    isSleepActive,
    isSleepFading,
    onSleepTimerChange,
    startSleepTimer,
} from '../core/sleepTimer.js';

initSleepTimer(audio);

const FADE_MINUTES = Math.max(1, Math.round(SLEEP_FADE_MS / 60000));

/* 动态拼串（嵌倒计时数字）i18n observer 翻不到，UI 自己按当前语言组句 */
const STR = {
    tipIdle: ['睡眠定时器', 'Sleep timer'],
    tipActive: ['睡眠定时器 · 剩余 {t}', 'Sleep timer · {t} left'],
    statusIdle: ['未设置', 'Not set'],
    statusActive: ['剩余 {t}', '{t} left'],
    statusFading: ['剩余 {t} · 正在渐弱', '{t} left · fading out'],
    hintStart: ['睡眠定时器已启动，{m} 分钟后停止播放', 'Sleep timer set: pausing in {m} min'],
    hintCancel: ['睡眠定时器已取消', 'Sleep timer cancelled'],
    hintFire: ['睡眠定时器到点，已暂停播放（队列已保留）', 'Sleep timer: playback paused (queue kept)'],
    hintFade: ['进入最后 {n} 分钟，音量将逐渐减弱', 'Final {n} minute: volume fading out'],
    hintInvalid: ['请输入 {min}~{max} 之间的分钟数', 'Enter minutes between {min} and {max}'],
    presetUnit: ['分钟', 'min'],
};

function el(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }

function langIsEn() {
    try {
        const i18n = (typeof globalThis !== 'undefined' && globalThis.AriaI18n) || null;
        return !!(i18n && typeof i18n.getLanguage === 'function' && i18n.getLanguage() === 'en-US');
    } catch (e) { logCatch('sleepTimerUI', e); return false; }
}

function fmt(entry, vars) {
    const tpl = entry[langIsEn() ? 1 : 0];
    return String(tpl).replace(/\{(\w+)\}/g, (all, key) => {
        const v = vars && vars[key];
        return v === undefined || v === null ? all : String(v);
    });
}

function hint(entry, vars) {
    if (typeof setHint === 'function') setHint(fmt(entry, vars));
}

/* ---------- 偏好持久化 ----------
 * 只记档位、不跨会话续跑倒计时：睡眠定时绑的是「这一次」的收听，
 * 重启后自动续上会把用户刚开的歌在莫名其妙的时刻淡掉。 */
function readPrefs() {
    try {
        const s = (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
        return (s && s.sleepTimer) || {};
    } catch (e) { logCatch('sleepTimerUI', e); return {}; }
}

function persistPrefs(patch) {
    try {
        const s = (typeof globalThis !== 'undefined' && globalThis.appSettings) || null;
        if (!s) return;
        s.sleepTimer = Object.assign({}, s.sleepTimer || {}, patch);
        saveSettings();
    } catch (e) { logCatch('sleepTimerUI', e); }
}

/* ---------- 渲染 ---------- */
let _lastFading = false;

function renderPresets() {
    const grid = el('sleepTimerPresets');
    if (!grid) return;
    const unit = esc(fmt(STR.presetUnit));
    const active = isSleepActive();
    const curMin = active ? getSleepMinutes() : (Number(readPrefs().lastMinutes) || 0);
    grid.innerHTML = SLEEP_PRESET_MINUTES.map(m =>
        `<button type="button" class="st-preset${m === curMin ? ' active' : ''}" data-sleep-min="${m}">${m}<span class="st-preset-unit">${unit}</span></button>`
    ).join('');
}

function syncUI() {
    const active = isSleepActive();
    const fading = isSleepFading();
    const remain = formatTime(getSleepRemainingMs());

    const btn = el('sleepTimerBtn');
    if (btn) {
        btn.classList.toggle('on', active);
        btn.setAttribute('data-tooltip', active ? fmt(STR.tipActive, { t: remain }) : fmt(STR.tipIdle));
    }

    const status = el('sleepTimerStatus');
    if (status) {
        status.textContent = active
            ? (fading ? fmt(STR.statusFading, { t: remain }) : fmt(STR.statusActive, { t: remain }))
            : fmt(STR.statusIdle);
    }

    const cancelBtn = el('sleepTimerCancelBtn');
    if (cancelBtn) cancelBtn.disabled = !active;

    const grid = el('sleepTimerPresets');
    if (grid) {
        const cur = active ? getSleepMinutes() : 0;
        grid.querySelectorAll('[data-sleep-min]').forEach(b => {
            b.classList.toggle('active', cur > 0 && Number(b.getAttribute('data-sleep-min')) === cur);
        });
    }

    if (fading && !_lastFading) hint(STR.hintFade, { n: FADE_MINUTES });
    _lastFading = fading;
}

/* ---------- 动作 ---------- */
function startMinutes(m) {
    if (!startSleepTimer(m)) {
        hint(STR.hintInvalid, { min: SLEEP_MIN_MINUTES, max: SLEEP_MAX_MINUTES });
        return false;
    }
    const minutes = Math.round(Number(m));
    const isPreset = SLEEP_PRESET_MINUTES.indexOf(minutes) >= 0;
    persistPrefs({ lastMinutes: minutes, lastCustomMinutes: isPreset ? 0 : minutes });
    hint(STR.hintStart, { m: minutes });
    closeOverlay();
    syncUI();
    return true;
}

function openOverlay() {
    const overlay = el('sleepTimerOverlay');
    if (!overlay) return;
    renderPresets();
    syncUI();
    overlay.classList.add('visible');
}

function closeOverlay() {
    el('sleepTimerOverlay')?.classList.remove('visible');
}

/* ---------- 绑定 ---------- */
let _bound = false;

function bindUI() {
    if (_bound) return;
    const btn = el('sleepTimerBtn');
    const overlay = el('sleepTimerOverlay');
    if (!btn || !overlay) return;  /* HTML 未接线：整套 UI 静默缺席 */
    _bound = true;

    btn.addEventListener('click', () => {
        if (overlay.classList.contains('visible')) closeOverlay();
        else openOverlay();
    });
    el('sleepTimerCloseBtn')?.addEventListener('click', closeOverlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeOverlay();
    });

    el('sleepTimerPresets')?.addEventListener('click', (e) => {
        const target = e.target && e.target.closest ? e.target.closest('[data-sleep-min]') : null;
        if (target) startMinutes(Number(target.getAttribute('data-sleep-min')));
    });

    const customInput = el('sleepTimerCustomInput');
    el('sleepTimerCustomBtn')?.addEventListener('click', () => {
        if (customInput) startMinutes(Number(customInput.value));
    });
    customInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startMinutes(Number(customInput.value));
    });

    el('sleepTimerCancelBtn')?.addEventListener('click', () => {
        if (cancelSleepTimer()) hint(STR.hintCancel);
        renderPresets();
        syncUI();
    });

    renderPresets();
    syncUI();
}

onSleepTimerChange((snap) => {
    try {
        if (snap.fired) hint(STR.hintFire);
        syncUI();
        if (!snap.active) renderPresets();
    } catch (e) { logCatch('sleepTimerUI', e); }
});

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindUI);
    } else {
        bindUI();
    }
}

export { closeOverlay, openOverlay };
