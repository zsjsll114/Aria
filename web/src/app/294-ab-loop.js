/* ============================================================
 * 294-ab-loop.js — 单句 / A-B 循环（todos #3，学唱歌场景）
 *
 * 三种状态：off / line（循环当前这一句）/ ab（循环用户标的 A→B 区间）。
 *
 * ★ 为什么自成一个分片、且只挂 audio 事件：
 *   循环的判定逻辑全在 core/abLoop.js（纯函数，可脱离浏览器测），
 *   这里只做接线。不碰 65/70 那些逐帧热路径文件——它们已经背了 rAF、
 *   淡入淡出、失速检测，再塞一个循环进去会让两条路径互相踩。
 * ★ 入口走「更多」菜单 + 快捷键，不加常驻按钮：
 *   默认（cover）模式下底栏是 display:none（见 AGENTS 约束 14），
 *   往 .player-controls-wrapper 再塞一个按钮会和已有 5 个控件抢宽度。
 *
 * 快捷键 L：无条件生效，但让位给「正在录入快捷键」和已被占用的键（同 285 的做法）。
 * ============================================================ */
import { audio } from './20-lyrics-render.js';
import { setHint } from './120-search-results.js';
import { saveSettings } from './180-boot-config.js';
import { t } from '../core/i18n.js';
import { logCatch, logInfo } from '../services/log.js';
import { lineRangeMs, seekCancelsLoop, shouldRewind } from '../core/abLoop.js';

const TAG = 'abLoop';
const HOTKEY = 'l';

/** off | line | ab */
const loop = { mode: 'off', startMs: 0, endMs: 0, pendingA: null, songSig: '' };

const songSig = () => {
    const csd = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
    return `${csd.source || ''}|${csd.id || csd.mid || csd.title || ''}`;
};

export function abLoopState() {
    return { mode: loop.mode, startMs: loop.startMs, endMs: loop.endMs, pendingA: loop.pendingA };
}

function hint(msg) { try { if (typeof setHint === 'function') setHint(msg); } catch (e) { logCatch(TAG, e); } }

export function clearAbLoop({ silent = false } = {}) {
    const was = loop.mode;
    loop.mode = 'off'; loop.startMs = 0; loop.endMs = 0; loop.pendingA = null;
    if (!silent && was !== 'off') hint(t('已取消循环', 'Loop cleared'));
    syncUi();
}

/** 换歌必须清循环：上一句的时间戳对到新歌上是错的，而且会立刻把新歌拽回旧区间 */
function dropIfSongChanged() {
    const sig = songSig();
    if (loop.mode !== 'off' && sig !== loop.songSig) clearAbLoop({ silent: true });
    if (loop.mode === 'off') loop.songSig = sig;
}

function activate(mode, startMs, endMs) {
    if (!(endMs > startMs)) { hint(t('循环区间无效', 'Invalid loop range')); return false; }
    loop.mode = mode; loop.startMs = startMs; loop.endMs = endMs; loop.pendingA = null;
    loop.songSig = songSig();
    syncUi();
    return true;
}

/** 循环当前正在高亮的那一句 */
export function toggleLineLoop() {
    dropIfSongChanged();
    if (loop.mode === 'line') { clearAbLoop(); return; }
    const lyrics = (typeof globalThis !== 'undefined' && globalThis.lyrics) || [];
    const idx = (typeof globalThis !== 'undefined' ? globalThis.activeLineIndex : -1);
    const range = lineRangeMs(lyrics, idx);
    if (!range) { hint(t('当前没有可循环的歌词行', 'No lyric line to loop')); return; }
    if (activate('line', range.start, range.end)) {
        try { audio.currentTime = range.start / 1000; } catch (e) { logCatch(TAG, e); }
        hint(t('单句循环已开启', 'Line loop on'));
    }
}

/** 标 A → 标 B → 进入 ab 循环；再按一次清除 */
export function markBoundary() {
    dropIfSongChanged();
    if (loop.mode === 'ab') { clearAbLoop(); return; }
    const now = (audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0) * 1000;
    if (loop.pendingA === null) {
        loop.pendingA = now;
        hint(t('A 点已标记，再按一次标记 B', 'A set — press again to set B'));
        syncUi();
        return;
    }
    const a = loop.pendingA, b = now;
    if (b <= a) { loop.pendingA = null; hint(t('B 必须晚于 A，已重置', 'B must come after A')); syncUi(); return; }
    if (activate('ab', a, b)) hint(t('A-B 循环已开启', 'A-B loop on'));
}

function syncUi() {
    try {
        const el = typeof document !== 'undefined' ? document.getElementById('abLoopStatus') : null;
        if (el) {
            el.textContent = loop.mode === 'line' ? t('单句循环中', 'Line looping')
                : loop.mode === 'ab' ? t('A-B 循环中', 'A-B looping')
                : loop.pendingA !== null ? t('已标记 A，等待 B', 'A marked') : '';
            el.classList.toggle('active', loop.mode !== 'off' || loop.pendingA !== null);
        }
    } catch (e) { logCatch(TAG, e); }
}

/* ---------- 接线：只听 audio 事件，不进逐帧循环 ---------- */
function onTimeUpdate() {
    if (loop.mode === 'off') return;
    dropIfSongChanged();
    if (loop.mode === 'off') return;
    const cur = (audio.currentTime || 0) * 1000;
    if (shouldRewind(cur, loop.startMs, loop.endMs)) {
        try {
            audio.currentTime = loop.startMs / 1000;
            logInfo(TAG, `[abLoop] 回到 ${Math.round(loop.startMs)}ms`);
        } catch (e) { logCatch(TAG, e); }
    }
}

/* 用户手动拖走就取消循环——否则进度条永远拖不出区间，观感上像卡死 */
function onSeeked() {
    if (loop.mode === 'off') return;
    const cur = (audio.currentTime || 0) * 1000;
    if (seekCancelsLoop(cur, loop.startMs, loop.endMs)) clearAbLoop();
}

function onHotKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.key || e.key.toLowerCase() !== HOTKEY) return;
    const act = e.target && e.target.tagName;
    if (act === 'INPUT' || act === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (typeof globalThis !== 'undefined' && globalThis.recordingShortcut) return;
    /* 用户把 L 绑给了别的功能就让位，不抢已配置的快捷键 */
    const sc = (typeof globalThis !== 'undefined' && globalThis.appSettings && globalThis.appSettings.shortcuts) || {};
    for (const name in sc) { if (String(sc[name]).toLowerCase() === HOTKEY) return; }
    e.preventDefault();
    try { toggleLineLoop(); } catch (err) { logCatch(TAG, err); }
}

if (typeof document !== 'undefined') {
    if (audio) {
        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('seeked', onSeeked);
    }
    document.addEventListener('keydown', onHotKey);
}

if (typeof window !== 'undefined' && typeof Aria !== 'undefined') {
    Aria.abLoop = {
        state: abLoopState, toggleLineLoop, markBoundary, clearAbLoop,
        hotkey: HOTKEY,
    };
}
