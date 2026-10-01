// scrollMode.js — 「长卷 · Scroll」模式接入层（独立于诗镜/版画的第三种 PV 形态）。
// 与 sonnetMode/temperaMode 同构：懒加载单例、切走挂起、歌词/字体变化热跟随。

import { ScrollEngine, normalizeScrollLines } from './ScrollEngine.js';
import { sanitizeCssFontFamily } from '../../../utils/fontStacks.js';

let engine = null;
let rafId = null;
let paused = false;
let lastLyricsRef = null;

function audioTime() {
    const audio = document.getElementById('audioPlayer');
    const baseMs = (audio ? audio.currentTime : 0) * 1000;
    const offset = typeof globalThis.lyricOffset === 'number' ? globalThis.lyricOffset : 0;
    return (baseMs + offset) / 1000;
}

function currentLyrics() {
    return (typeof globalThis.lyrics !== 'undefined' && Array.isArray(globalThis.lyrics))
        ? globalThis.lyrics : [];
}

/* Aria 全局字体 key → 真字体栈（与 sonnetMode/temperaMode 同款解析）。
   ★ 2026-10-01 过 sanitizeCssFontFamily：resolveFontFamily 返回整串栈，直接进
   Pixi TextStyle 会被 toFontString 按逗号误拆出引号不配对段，渲染回退 10px 字体。 */
function currentFontStack() {
    try {
        const fontKey = (typeof globalThis !== 'undefined' && globalThis.appSettings
            && globalThis.appSettings.interface && globalThis.appSettings.interface.fontFamily) || 'inherit';
        if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            const stack = window.resolveFontFamily(fontKey);
            return stack ? sanitizeCssFontFamily(stack) : null;
        }
    } catch { /* 字体管理器未就绪 */ }
    return null;
}

function buildTheme() {
    const cover = (typeof globalThis !== 'undefined' && globalThis.coverPalette) || {};
    /* 卷面纸色：封面主色混 72% 黑保色相（同版画的深色域教训） */
    const mixToBlack = (hex, ratio) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m) return '#101014';
        const n = parseInt(m[1], 16);
        const ch = (shift) => Math.round(((n >> shift) & 0xff) * (1 - ratio));
        return '#' + [16, 8, 0].map(shift => ch(shift).toString(16).padStart(2, '0')).join('');
    };
    return {
        paper: mixToBlack(cover.primary || '#101014', 0.72),
        ink: '#f4f4f5',
        accent: cover.accent || '#E8BE6A',
        secondary: cover.secondary || '#4a4e57',
    };
}

function applyTheme(eng) {
    const theme = buildTheme();
    eng.theme.paper = theme.paper;
    eng.theme.accent = theme.accent;
    eng.theme.secondary = theme.secondary;
    const stack = currentFontStack();
    if (stack) eng.fontFamily = stack;
}

/** 进入长卷模式：懒建引擎并接上歌词。返回 Promise<ScrollEngine> */
export async function ensureScrollEngine(container) {
    if (engine) {
        engine.setPaused(false);
        paused = false;
        return engine;
    }
    engine = new ScrollEngine(container);
    applyTheme(engine);
    engine.lyricsFontScale = 1.1;
    await engine.init();
    /* ★ 2026-10-01 设置面板接入：进入模式时下发 modeSettings.scroll */
    try {
        const ms = (typeof globalThis !== 'undefined' && globalThis.appSettings
            && globalThis.appSettings.modeSettings && globalThis.appSettings.modeSettings.scroll) || null;
        if (ms) engine.applySettings(ms);
    } catch (e) { /* ignore */ }
    engine.setLyrics(currentLyrics());
    lastLyricsRef = currentLyrics();
    if (typeof window !== 'undefined') {
        window.__scrollActive = true;
        /* 诊断探针（对齐 __sonnetProbe）：E2E/排查用，只读 */
        window.__scrollProbe = () => engine ? {
            pxPerSec: engine._pxPerSec,
            lastError: engine._lastError,
            lines: engine.lines.map(lv => ({
                x0: Math.round(lv.x0), blockW: Math.round(lv.blockW), cx: Math.round(lv.container.x),
            })),
        } : null;
    }
    startTicker();
    return engine;
}

function startTicker() {
    if (rafId !== null) return;
    const tick = () => {
        if (!engine) { rafId = null; return; }
        if (!paused) {
            const current = currentLyrics();
            if (current !== lastLyricsRef) {
                lastLyricsRef = current;
                engine.setLyrics(current);
            }
            /* 字体/封面变化 → 主题重应用（setLyrics 重建卷面时读取） */
            applyTheme(engine);
            engine.update(audioTime());
        }
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

/** 立即喂时间（备用驱动口） */
export function updateScrollEngine(timeSec) {
    if (engine) engine.update(timeSec);
}

/** 设置下发（190-settings-fontsize 调用） */
export function applyScrollSettings(settings) {
    if (engine && settings) engine.applySettings(settings);
}

/** 切走时挂起：runtime app.stop()，卷面缓存保留（切回秒恢复） */
export function suspendScrollEngine() {
    paused = true;
    if (engine) {
        try { engine.setPaused(true); } catch (e) { /* ignore */ }
    }
}

/** 真正销毁 */
export function destroyScrollEngine() {
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    if (engine) {
        try { engine.destroy(); } catch (e) { /* ignore */ }
        engine = null;
    }
    if (typeof window !== 'undefined') window.__scrollActive = false;
}

/** 独立实例（设置页预览窗）：与主单例互不影响 */
export async function createDetachedScrollEngine(container, lyrics) {
    const eng = new ScrollEngine(container);
    const theme = buildTheme();
    eng.theme.paper = theme.paper;
    eng.theme.accent = theme.accent;
    eng.theme.secondary = theme.secondary;
    const stack = currentFontStack();
    if (stack) eng.fontFamily = stack;
    eng.lyricsFontScale = 0.9;
    await eng.init();
    eng.setLyrics(lyrics || []);
    return {
        engine: eng,
        setTime(t) { eng.update(t); },
        setPaused(p) { eng.setPaused(p); },
        destroy() { eng.destroy(); },
    };
}
