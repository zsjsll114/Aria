/* ============================================================
 * PrismVisualizer.js — 「棱镜 · Prism」多镜头光学切面视觉引擎
 *
 * 架构（纯 Canvas2D 硬件合成，零重型 WebGL/Pixi 依赖）：
 *   1. 36 种参数化多边形切面构图（6 大家族 × 6 款），跨切面文字折射错位 + 亮面自动反色
 *   2. 棱边 RGB 光谱色散（Chromatic Dispersion）与高光切线描边
 *   3. 8 种歌词几何排版流向 + 6 种逐字入场动效 + AI 情感词多色发光联动
 *   4. 逐字焦散光束（Caustic Beam）扫掠与星芒脉冲
 *   5. 6 种分镜转场（晶面斜切扫掠 / 菱形光阑 / 断层错动 / 光谱闪白 / 晶体翻折 / 光学叠化）
 * ============================================================ */

import { VisualizerBase } from './VisualizerBase.js';
import { PRISM_DEFAULTS } from './prism/prismTypes.js';
import {
    buildPrismFacetGeometry,
    compilePrismProgram,
    findActivePrismShot,
} from './prism/prismProgram.js';
import { hashPrismSeed, prismHash01 } from './prism/prismRandom.js';
import {
    shouldPrewarmNextShot,
    shouldFreezeOutgoingPlate,
    canReuseFrozenPlate,
} from './prism/prismTransition.js';
import { clamp01, emotionColorsForGraphemes } from './lyricRows.js';
import { getCoverLayers } from '../../infrastructure/dom.js';
import { artistOf, titleOf } from '../../services/lyricIndex.js';

const COVER_POLL_MS = 1500;

const PRISM_PALETTE_PRESETS = {
    diamond: {
        bg: '#060911',
        tones: ['#090e1a', '#10192b', '#18263e', '#223656'],
        lightFacet: '#eef6ff',
        darkInk: '#09101d',
        ink: '#f4f8ff',
        dimInk: 'rgba(210, 228, 250, 0.34)',
        accent: '#7ce8ff',
        dispersion: ['#fda4af', '#c4b5fd', '#67e8f9'],
    },
    amber: {
        bg: '#0c0806',
        tones: ['#140d09', '#21150e', '#332015', '#472c1c'],
        lightFacet: '#fff4e4',
        darkInk: '#180f08',
        ink: '#fff6ea',
        dimInk: 'rgba(248, 222, 194, 0.34)',
        accent: '#ffb85c',
        dispersion: ['#fda4af', '#fde68a', '#7dd3fc'],
    },
    obsidian: {
        bg: '#070709',
        tones: ['#0d0d12', '#15161e', '#1f212d', '#2b2e3e'],
        lightFacet: '#f2f3f7',
        darkInk: '#0b0c10',
        ink: '#f5f6fa',
        dimInk: 'rgba(215, 220, 235, 0.32)',
        accent: '#c4b5fd',
        dispersion: ['#f9a8d4', '#c4b5fd', '#93c5fd'],
    },
    aurora: {
        bg: '#050b0e',
        tones: ['#081318', '#0e2028', '#15303b', '#1e4250'],
        lightFacet: '#ebfffb',
        darkInk: '#07151a',
        ink: '#eefcf9',
        dimInk: 'rgba(196, 242, 235, 0.34)',
        accent: '#4ff0c6',
        dispersion: ['#c4b5fd', '#6ee7b7', '#67e8f9'],
    },
};

function parseHexRgb(hex, fallback = [16, 24, 38]) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}

function mixHex(hexA, hexB, t) {
    const a = parseHexRgb(hexA);
    const b = parseHexRgb(hexB);
    const k = clamp01(t);
    return rgbToHex(
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
    );
}

const BUILTIN_PRISM_FONT_MAP = {
    default: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    serif: "Georgia, 'Times New Roman', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif",
    kai: "Georgia, 'Times New Roman', 'Kaiti SC', 'STKaiti', 'KaiTi', '楷体', serif",
    hei: "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', 'SimHei', sans-serif",
    fangsong: "Georgia, 'Times New Roman', 'STFangsong', 'FangSong', '仿宋', serif",
    mono: "'JetBrains Mono', 'Consolas', 'Courier New', 'Microsoft YaHei', monospace",
};

function resolvePrismFont(ff) {
    let key = ff;
    if (!key || key === 'default' || key === 'inherit') {
        const globalKey = (typeof globalThis !== 'undefined' && globalThis.appSettings?.interface?.fontFamily) || '';
        if (globalKey && globalKey !== 'default' && globalKey !== 'inherit') {
            key = globalKey;
        } else if (typeof document !== 'undefined') {
            const pc = document.querySelector('.player-container');
            const inlineVis = pc?.style?.getPropertyValue('--vis-font-family')?.trim()
                || document.documentElement?.style?.getPropertyValue('--app-font-family')?.trim();
            if (inlineVis) return inlineVis;
            return BUILTIN_PRISM_FONT_MAP.default;
        } else {
            return BUILTIN_PRISM_FONT_MAP.default;
        }
    }
    if (BUILTIN_PRISM_FONT_MAP[key]) {
        return BUILTIN_PRISM_FONT_MAP[key];
    }
    if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
        try {
            const resolved = window.resolveFontFamily(key);
            if (resolved) return resolved;
        } catch {
            return String(key);
        }
    }
    return String(key);
}

function easeInOutCubic(t) {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export class PrismVisualizer extends VisualizerBase {
    /**
     * @param {HTMLElement} container
     * @param {Object} [options]
     */
    constructor(container, options = {}) {
        super(container, options);
        this.opts = { ...PRISM_DEFAULTS };
        /** @type {HTMLCanvasElement|null} */
        this._canvas = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._ctx = null;
        /** @type {ResizeObserver|null} */
        this._ro = null;
        this._dpr = 1;
        this._program = null;
        this._programKey = '';
        /** @type {Map<string, any>} */
        this._geoCache = new Map();
        /** @type {Map<number, any>} */
        this._layoutCache = new Map();
        /** @type {Map<string, HTMLCanvasElement>} */
        this._backdropCache = new Map();
        /** @type {Map<string, HTMLCanvasElement>} */
        this._glowSpriteCache = new Map();
        /** @type {Map<string, CanvasGradient>} */
        this._facetGradCache = new Map();
        /** @type {HTMLCanvasElement|null} */
        this._plateLight = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._plateLightCtx = null;
        /** @type {HTMLCanvasElement|null} */
        this._plateDark = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._plateDarkCtx = null;
        /** @type {HTMLCanvasElement|null} */
        this._plateFrozenLight = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._plateFrozenLightCtx = null;
        /** @type {HTMLCanvasElement|null} */
        this._plateFrozenDark = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._plateFrozenDarkCtx = null;
        /** @type {HTMLCanvasElement|null} */
        this._curPlateLight = null;
        /** @type {HTMLCanvasElement|null} */
        this._curPlateDark = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._curPlateLightCtx = null;
        /** @type {CanvasRenderingContext2D|null} */
        this._curPlateDarkCtx = null;
        this._frozenForShotIndex = -1;
        this._emotionRef = null;
        this._coverUrl = '';
        this._coverCheckAt = 0;
        /** @type {HTMLCanvasElement|null} */
        this._coverCanvas = null;
        this._coverGen = 0;
        this._raf = 0;
        this._destroyed = false;
        this._dirty = true;
        this._lastSyncTimeMs = 0;
        this._lastSyncPerf = 0;
        this._lastFramePerf = 0;
        this._smoothMediaMs = 0;
        this._lastRawMediaMs = -1;
        this._lastRawPerf = 0;
        this._lastDomSubKey = '';
        this._causticX = 0;
        this._causticY = 0;
        this._causticAlpha = 0;
        this._causticShotIdx = -1;
        this._causticLastAmb = 0;
        /** @type {boolean|null} */
        this._externalPlaying = null;
    }

    getModeId() { return 'prism'; }

    /** @param {boolean} playing */
    setPlaying(playing) {
        this._externalPlaying = Boolean(playing);
    }

    /** @param {boolean} paused */
    setPaused(paused) {
        this._externalPlaying = !paused;
    }

    _resolveIsPlaying() {
        if (this._externalPlaying !== null) return this._externalPlaying;
        if (!this._isPreviewStage() && typeof globalThis !== 'undefined' && globalThis.audio) {
            return !globalThis.audio.paused;
        }
        return this.isRunning;
    }

    _isPreviewStage() {
        return Boolean(
            this.container
            && this.container.classList
            && this.container.classList.contains('preview-player'),
        );
    }

    onInit() {
        if (!this.viewContainer || typeof document === 'undefined') return;
        const stage = this.viewContainer;
        stage.classList.add('prism-stage');
        stage.innerHTML = `<canvas class="prism-canvas" aria-hidden="true"></canvas>`;
        this._canvas = /** @type {HTMLCanvasElement} */ (stage.querySelector('.prism-canvas'));
        this._ctx = this._canvas ? this._canvas.getContext('2d') : null;
        this._plateLight = document.createElement('canvas');
        this._plateLightCtx = this._plateLight.getContext('2d');
        this._plateDark = document.createElement('canvas');
        this._plateDarkCtx = this._plateDark.getContext('2d');
        /* 转场旧镜冻结底板：独立画布持稳定纹理，避免与新镜共享画布交替覆写引发 GPU 重传 */
        this._plateFrozenLight = document.createElement('canvas');
        this._plateFrozenLightCtx = this._plateFrozenLight.getContext('2d');
        this._plateFrozenDark = document.createElement('canvas');
        this._plateFrozenDarkCtx = this._plateFrozenDark.getContext('2d');
        this._frozenForShotIndex = -1;
        this._curPlateLight = this._plateLight;
        this._curPlateDark = this._plateDark;
        this._curPlateLightCtx = this._plateLightCtx;
        this._curPlateDarkCtx = this._plateDarkCtx;

        if (typeof ResizeObserver !== 'undefined') {
            if (this._ro) this._ro.disconnect();
            this._ro = new ResizeObserver(() => this.handleResize());
            this._ro.observe(stage);
        }

        this._dirty = true;
        this._refreshCover(true);
        this._ensureProgram();
    }

    /** @param {number} width @param {number} height */
    onResize(width, height) {
        if (!this._canvas) return;
        const w = Math.max(1, Math.round(width || 800));
        const h = Math.max(1, Math.round(height || 600));
        const lowPerf = this._isLowPerf();
        const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        this._dpr = lowPerf ? 1 : Math.min(1.5, rawDpr);
        const cw = Math.round(w * this._dpr);
        const ch = Math.round(h * this._dpr);
        this._canvas.width = cw;
        this._canvas.height = ch;
        if (this._plateLight) {
            this._plateLight.width = cw;
            this._plateLight.height = ch;
        }
        if (this._plateDark) {
            this._plateDark.width = cw;
            this._plateDark.height = ch;
        }
        if (this._plateFrozenLight) {
            this._plateFrozenLight.width = cw;
            this._plateFrozenLight.height = ch;
        }
        if (this._plateFrozenDark) {
            this._plateFrozenDark.width = cw;
            this._plateFrozenDark.height = ch;
        }
        this._frozenForShotIndex = -1;
        this._geoCache.clear();
        this._facetGradCache.clear();
        this._layoutCache.clear();
        this._backdropCache.clear();
        this._dirty = true;
        this._renderFrame(this._extrapolatedTimeMs());
    }

    onLyricsLoaded() {
        this._programKey = '';
        this._geoCache.clear();
        this._facetGradCache.clear();
        this._layoutCache.clear();
        this._backdropCache.clear();
        this._lastDomSubKey = '';
        this._causticShotIdx = -1;
        this._causticAlpha = 0;
        this._dirty = true;
        this._refreshCover(true);
        this._ensureProgram();
        this._renderFrame(this._extrapolatedTimeMs());
    }

    /** @param {number} currentTimeSec */
    update(currentTimeSec = 0) {
        const timeMs = Math.max(0, (Number(currentTimeSec) || 0) * 1000);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const deltaMedia = timeMs - this._lastSyncTimeMs;
        this._lastSyncTimeMs = timeMs;
        this._lastSyncPerf = now;
        if (Math.abs(deltaMedia) >= 650) {
            // 仅在真正 Seek（跨度 >= 650ms）时立即重锚，避免常规 timeupdate (200~250ms) 触发阶跃跳变
            this._smoothMediaMs = timeMs;
            this._lastRawMediaMs = timeMs;
            this._lastRawPerf = now;
            this._lastFramePerf = now;
        }
        if (!this.isRunning || this._isPreviewStage()) {
            this._dirty = true;
            this._renderFrame(timeMs, now);
        }
    }

    _extrapolatedTimeMs() {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const dt = this._lastFramePerf > 0 ? Math.max(0, Math.min(50, now - this._lastFramePerf)) : 16.67;
        this._lastFramePerf = now;

        if (!this._isPreviewStage() && typeof globalThis !== 'undefined' && globalThis.audio) {
            const audioEl = globalThis.audio;
            const offsetMs = Number(globalThis.lyricOffset) || 0;
            const rawMs = Math.max(0, (Number(audioEl.currentTime) || 0) * 1000 + offsetMs);
            if (Math.abs(rawMs - this._lastRawMediaMs) > 0.5) {
                this._lastRawMediaMs = rawMs;
                this._lastRawPerf = now;
            }
            if (this._resolveIsPlaying()) {
                const rate = Number(audioEl.playbackRate) || 1;
                const sinceTick = Math.min(340, Math.max(0, now - this._lastRawPerf));
                const targetMs = rawMs + sinceTick * rate;
                const err = targetMs - this._smoothMediaMs;
                if (Math.abs(err) >= 650) {
                    this._smoothMediaMs = targetMs;
                } else {
                    // 对称 PLL：误差正负两向同等收敛（旧版 max(0.82dt, …) 只会追不会等，
                    // 画面跑在音频前面时无法回拉，逐字高亮长期偏「字先亮」）。步长夹在 [0.5, 1.5]×dt 防倒退与跳变
                    const step = dt * rate + err * 0.12;
                    this._smoothMediaMs += Math.max(dt * rate * 0.5, Math.min(dt * rate * 1.5, step));
                }
                return this._smoothMediaMs;
            }
            this._smoothMediaMs = rawMs;
            return rawMs;
        }
        if (!this._resolveIsPlaying() || !this._lastSyncPerf) return this._lastSyncTimeMs;
        const elapsed = Math.max(0, Math.min(340, now - this._lastSyncPerf));
        return this._lastSyncTimeMs + elapsed;
    }

    start() {
        if (this.isRunning) return;
        super.start();
        this._dirty = true;
        this._lastFramePerf = 0;
        this._lastRawPerf = 0;
        const loop = (/** @type {number} */ now) => {
            if (!this.isRunning || this._destroyed) return;
            if (!this._isPreviewStage()) {
                this._refreshCover(false);
                this._syncEmotion();
                const tMs = this._extrapolatedTimeMs();
                this._renderFrame(tMs, now);
            }
            this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    stop() {
        super.stop();
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
    }

    /**
     * 海报抓帧前将棱镜(prism)推进到当前/目标行完整定格时刻并同步刷帧。
     * @param {number} [targetLineIndex]
     * @returns {(() => void)|null}
     */
    stageForPoster(targetLineIndex) {
        if (!this._ctx || !this._canvas || !Array.isArray(this.lines) || !this.lines.length) return null;
        this._ensureProgram();
        const wasRunning = !!this.isRunning;
        if (wasRunning && typeof this.stop === 'function') this.stop();
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const isMs = this.lines.some((l) => l && typeof l.start === 'number' && l.start >= 1000);
        const mult = isMs ? 1 : 1000;
        const fallbackIdx = Math.max(0, Math.min(this.lines.length - 1, Number(globalThis.activeLineIndex) || 0));
        const idx = (Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && targetLineIndex < this.lines.length)
            ? targetLineIndex
            : fallbackIdx;
        const line = this.lines[idx];
        let peakMs = this._extrapolatedTimeMs ? this._extrapolatedTimeMs() : 0;
        if (line) {
            const st = Number(line.start ?? line.time ?? 0) * mult;
            const ed = line.end != null ? Number(line.end) * mult : st + 3500;
            const dur = Math.max(200, ed - st);
            peakMs = st + Math.max(80, Math.min(dur - 120, dur * 0.78));
        }

        const shots = Array.isArray(this._program?.shots) ? this._program.shots : [];
        const lineShots = shots.filter((s) => s && s.lineIndex === idx);
        let tempKey = null;
        if (lineShots.length) {
            const baseShot = lineShots[0];
            const lastShot = lineShots[lineShots.length - 1];
            let renderShot = baseShot;
            if (lineShots.length > 1) {
                const mergedGraphemes = lineShots.flatMap((s) => (Array.isArray(s.graphemes) ? s.graphemes : []));
                tempKey = -1000 - idx;
                renderShot = {
                    ...baseShot,
                    index: tempKey,
                    text: String((line && (line.original || line.text)) || lineShots.map((s) => s.text || '').join('')),
                    graphemes: mergedGraphemes,
                    startTimeMs: baseShot.startTimeMs,
                    endTimeMs: lastShot.endTimeMs,
                };
            }
            const cw = this._canvas.width;
            const ch = this._canvas.height;
            const w = cw / this._dpr;
            const h = ch / this._dpr;
            if (w > 4 && h > 4) {
                const palette = this._resolvePalette();
                const lowPerf = this._isLowPerf();
                const drawMs = Math.max(renderShot.startTimeMs + 80, renderShot.endTimeMs - 30);
                this._posterFullReveal = true;
                try {
                    const ctx = this._ctx;
                    ctx.save();
                    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
                    const g = ctx.createLinearGradient(0, 0, w, h);
                    g.addColorStop(0, mixHex(palette.bg, palette.accent, 0.05));
                    g.addColorStop(0.52, palette.bg);
                    g.addColorStop(1, mixHex(palette.bg, '#020408', 0.45));
                    ctx.fillStyle = g;
                    ctx.fillRect(0, 0, w, h);
                    this._renderSingleShot(ctx, renderShot, 0.88, drawMs, drawMs, w, h, palette, lowPerf, 1, 0, true);
                    this._renderVignetteAndHud(ctx, renderShot, 0.88, drawMs, w, h, palette);
                    ctx.restore();
                } finally {
                    this._posterFullReveal = false;
                    if (tempKey !== null) {
                        this._layoutCache.delete(tempKey);
                        for (const k of this._geoCache.keys()) {
                            if (String(k).startsWith(`${tempKey}:`)) this._geoCache.delete(k);
                        }
                    }
                }
                return () => {
                    this._renderFrame(this._extrapolatedTimeMs ? this._extrapolatedTimeMs() : peakMs, now);
                    if (wasRunning && typeof this.start === 'function') this.start();
                };
            }
        }

        this._posterFullReveal = true;
        try {
            this._renderFrame(peakMs, peakMs);
        } finally {
            this._posterFullReveal = false;
        }
        return () => {
            this._renderFrame(this._extrapolatedTimeMs ? this._extrapolatedTimeMs() : peakMs, now);
            if (wasRunning && typeof this.start === 'function') this.start();
        };
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        this._canvas = null;
        this._ctx = null;
        this._geoCache.clear();
        this._facetGradCache.clear();
        this._layoutCache.clear();
        this._backdropCache.clear();
        this._glowSpriteCache.clear();
        super.destroy();
    }

    /** @param {Object} settings */
    onApplySettings(settings) {
        const s = settings || {};
        const prevCut = this.opts.prismCutRate;
        const prevFont = this.opts.fontFamily;
        const prevSize = this.opts.fontSize;
        const prevPreset = this.opts.prismPreset;
        const prevHl = this.opts.highlightColor;

        if (s.fontSize !== undefined) {
            let n = Number(s.fontSize);
            if (Number.isFinite(n) && n > 3) n /= 24;
            this.opts.fontSize = Number.isFinite(n) && n > 0 ? Math.max(0.5, Math.min(2.2, n)) : 1.0;
        }
        if (s.fontFamily !== undefined) this.opts.fontFamily = String(s.fontFamily || 'default');
        if (s.highlightColor !== undefined) this.opts.highlightColor = String(s.highlightColor || '#7ce8ff');
        if (s.themeColor !== undefined) this.opts.themeColor = String(s.themeColor || '#E8BE6A');
        if (s.showTranslation !== undefined) this.opts.showTranslation = Boolean(s.showTranslation);
        if (s.showRomaji !== undefined) this.opts.showRomaji = Boolean(s.showRomaji);
        if (s.prismPreset !== undefined) this.opts.prismPreset = String(s.prismPreset || 'auto');
        if (s.prismCutRate !== undefined) this.opts.prismCutRate = String(s.prismCutRate || 'phrase');
        if (s.prismRefraction !== undefined) this.opts.prismRefraction = clamp01(Number(s.prismRefraction));
        if (s.prismDispersion !== undefined) this.opts.prismDispersion = clamp01(Number(s.prismDispersion));
        if (s.prismCaustics !== undefined) this.opts.prismCaustics = clamp01(Number(s.prismCaustics));
        if (s.prismCamera !== undefined) {
            const c = Number(s.prismCamera);
            this.opts.prismCamera = Number.isFinite(c) ? Math.max(0, Math.min(1.5, c)) : 0.85;
        }
        if (s.prismHud !== undefined) this.opts.prismHud = Boolean(s.prismHud);

        if (this.opts.prismCutRate !== prevCut) {
            this._programKey = '';
            this._ensureProgram();
        }
        if (this.opts.fontFamily !== prevFont || this.opts.fontSize !== prevSize) {
            this._layoutCache.clear();
            this._backdropCache.clear();
        }
        if (this.opts.prismPreset !== prevPreset || this.opts.highlightColor !== prevHl) {
            this._backdropCache.clear();
        }
        this._dirty = true;
        this._renderFrame(this._extrapolatedTimeMs());
    }

    _isLowPerf() {
        if (typeof document === 'undefined') return false;
        const root = document.documentElement;
        const body = document.body;
        return Boolean(
            (root && root.classList.contains('is-software-renderer'))
            || (body && (body.classList.contains('perf-low') || body.classList.contains('perf-minimal'))),
        );
    }

    _ensureProgram() {
        const song = globalThis.currentSongData || null;
        // 每帧调用：先做引用级快检，只有歌曲对象/歌词数组变化或显式失效（_programKey=''）才拼长字符串 key
        if (this._program && this._programKey && song === this._programSongRef && this.lines === this._programLinesRef) return;
        this._programSongRef = song;
        this._programLinesRef = this.lines;
        const title = titleOf(song) || 'ARIA PRISM';
        const artist = artistOf(song) || '';
        const firstText = this.lines[0] ? String(this.lines[0].original || this.lines[0].text || '') : '';
        const key = `${title}|${artist}|${this.lines.length}|${firstText}|${this.opts.prismCutRate}`;
        if (this._program && this._programKey === key) return;
        this._programKey = key;
        const seed = hashPrismSeed(`${artist}|${title}`);
        this._program = compilePrismProgram(this.lines, {
            seed,
            cutRate: /** @type {any} */ (this.opts.prismCutRate),
            title,
            artist,
        });
        this._geoCache.clear();
        this._facetGradCache.clear();
        this._layoutCache.clear();
        this._backdropCache.clear();
        this._dirty = true;
    }

    _syncEmotion() {
        const list = Array.isArray(globalThis.aiEmotionWords) ? globalThis.aiEmotionWords : null;
        if (list !== this._emotionRef) {
            this._emotionRef = list;
            this._layoutCache.clear();
            this._dirty = true;
        }
    }

    /** @param {boolean} force */
    _refreshCover(force) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!force && now - this._coverCheckAt < COVER_POLL_MS) return;
        this._coverCheckAt = now;
        this._ensureProgram();

        const layers = getCoverLayers().slice().sort((a, b) => {
            const av = a && a.style && a.style.opacity === '1' ? 1 : 0;
            const bv = b && b.style && b.style.opacity === '1' ? 1 : 0;
            return bv - av;
        });
        const url = layers.map(el => (el && (el.getAttribute('src') || el.currentSrc)) || '').find(Boolean) || '';
        if (!force && url === this._coverUrl) return;
        this._coverUrl = url;
        if (!url || typeof document === 'undefined') return;

        const gen = ++this._coverGen;
        let loadUrl = url;
        let isCrossOrigin = false;
        try {
            if (typeof location !== 'undefined' && /^https?:\/\//i.test(url)) {
                const parsed = new URL(url, location.href);
                if (parsed.origin !== location.origin) {
                    isCrossOrigin = true;
                    loadUrl = `/proxy?url=${encodeURIComponent(parsed.href)}`;
                }
            }
        } catch {
            if (/^https?:\/\//i.test(url)) {
                isCrossOrigin = true;
                loadUrl = `/proxy?url=${encodeURIComponent(url)}`;
            }
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (gen !== this._coverGen || this._destroyed) return;
            const off = document.createElement('canvas');
            off.width = 160;
            off.height = 160;
            const octx = off.getContext('2d');
            if (octx) {
                octx.filter = 'blur(8px) saturate(1.25) brightness(0.62)';
                octx.drawImage(img, 0, 0, 160, 160);
                octx.filter = 'none';
            }
            this._coverCanvas = off;
            this._backdropCache.clear();
            this._dirty = true;
        };
        img.onerror = () => {
            /* 代理不可用时不再用未代理跨域 URL 污染主画布（会阻断海报导出 toDataURL） */
            if (gen !== this._coverGen || this._destroyed) return;
            if (isCrossOrigin && loadUrl !== url && typeof location === 'undefined') {
                img.src = url;
            }
        };
        img.src = loadUrl;
    }

    _resolvePalette() {
        // 每帧调用：约 10 次 mixHex 字符串解析 + 对象分配，按输入签名缓存
        const cover = (typeof globalThis !== 'undefined' && globalThis.coverPalette) || null;
        const sig = `${this.opts.prismPreset}|${this.opts.highlightColor}|${cover ? `${cover.primary}|${cover.secondary}|${cover.accent}` : ''}`;
        if (this._paletteSig === sig && this._paletteCache) return this._paletteCache;
        this._paletteSig = sig;
        const base = this._computePalette();
        // 切面体色向底幕收拢 30%：让晶块读作「深色玻璃里的折射」而不是一块块浮起的亮色面板，
        // 层次交给迎光反光带 + 内缘光 + 棱线来表达
        this._paletteCache = {
            ...base,
            tones: base.tones.map(t => mixHex(t, base.bg, 0.3)),
        };
        return this._paletteCache;
    }

    _computePalette() {
        const presetId = this.opts.prismPreset;
        if (presetId && presetId !== 'auto' && PRISM_PALETTE_PRESETS[presetId]) {
            const p = PRISM_PALETTE_PRESETS[presetId];
            const customHl = this.opts.highlightColor && this.opts.highlightColor !== '#7ce8ff' && this.opts.highlightColor !== '#ffffff'
                ? this.opts.highlightColor
                : p.accent;
            return { ...p, accent: customHl };
        }
        const cover = (typeof globalThis !== 'undefined' && globalThis.coverPalette) || {};
        const pri = cover.primary || '#16243a';
        const sec = cover.secondary || '#283d5e';
        const rawAcc = (this.opts.highlightColor && this.opts.highlightColor !== '#ffffff')
            ? this.opts.highlightColor
            : (cover.accent || '#7ce8ff');
        return {
            bg: mixHex(pri, '#04060a', 0.84),
            tones: [
                mixHex(pri, '#05080f', 0.76),
                mixHex(pri, '#0a101d', 0.60),
                mixHex(sec, '#121b2c', 0.48),
                mixHex(sec, rawAcc, 0.24),
            ],
            lightFacet: mixHex('#f5f9ff', rawAcc, 0.12),
            darkInk: mixHex(pri, '#05080e', 0.88),
            ink: '#f5f8ff',
            dimInk: 'rgba(214, 228, 248, 0.34)',
            accent: rawAcc,
            dispersion: [
                mixHex(rawAcc, '#f9a8d4', 0.55),
                mixHex(rawAcc, '#c4b5fd', 0.48),
                mixHex(rawAcc, '#67e8f9', 0.58),
            ],
        };
    }

    _getGeometry(shot, aspect) {
        const bucket = Math.round(aspect * 20) / 20;
        const key = `${shot.index}:${shot.kind}:${bucket}`;
        let geo = this._geoCache.get(key);
        if (!geo) {
            geo = buildPrismFacetGeometry(shot.kind, shot.seed, bucket);
            this._geoCache.set(key, geo);
        }
        return geo;
    }

    _getShotLayout(shot, geo, w, h, ctx) {
        let cached = this._layoutCache.get(shot.index);
        if (cached && cached.w === w && cached.h === h) return cached;

        const fontStack = resolvePrismFont(this.opts.fontFamily);
        const isPreview = w < 380;
        const scaleOpt = this.opts.fontSize || 1.0;
        const gCount = shot.graphemes.length || 1;
        // 对齐 Tempera 视口等比例字号算法：随窗口宽度线性放大，同时允许自适应回缩至安全底限以防长句越界
        const PRISM_LYRICS_FONT_SCALE = isPreview ? 1.0 : 1.72;
        const effScale = PRISM_LYRICS_FONT_SCALE * scaleOpt;
        const maxViewportPx = isPreview ? 38 : Math.max(120, w * 0.088);
        let fontPx = Math.round(
            Math.max(
                isPreview ? 14 : 28,
                Math.min(maxViewportPx, (w / Math.max(5.2, gCount * 0.96)) * 1.42),
            ) * effScale,
        );
        const fontPxFloor = Math.max(isPreview ? 11 : 22, Math.round(w * 0.016 * scaleOpt));

        const emotionList = Array.isArray(globalThis.aiEmotionWords) ? globalThis.aiEmotionWords : null;
        const emotionColors = emotionColorsForGraphemes(shot.graphemes, emotionList);

        // 1. 将字素聚合为 Tempera 式词组单元（英文单词不拆断但超长词拆段，汉字 1~2 字成词，保留真实空格标记）
        /** @type {Array<{items:Array<{char:string,start:number,end:number,emotionColor:string|null,idx:number}>,spaced:boolean,scale:number,width:number,glyphWidths:number[]}>} */
        const wordUnits = [];
        let curItems = [];
        let curIsLatin = false;
        let pendingSpace = false;
        const flushWord = () => {
            if (curItems.length === 0) return;
            wordUnits.push({ items: curItems, spaced: pendingSpace, scale: 1, width: 0, glyphWidths: [] });
            curItems = [];
            pendingSpace = false;
        };
        for (let i = 0; i < gCount; i++) {
            const g = shot.graphemes[i];
            const ch = String(g.char || '');
            if (/^\s+$/.test(ch)) {
                flushWord();
                pendingSpace = true;
                continue;
            }
            const isLat = /[A-Za-z0-9'-]/.test(ch);
            if (curItems.length > 0) {
                if (isLat !== curIsLatin || (!isLat && curItems.length >= 2) || (isLat && curItems.length >= 10)) {
                    flushWord();
                }
            }
            curIsLatin = isLat;
            curItems.push({ char: ch, start: g.start, end: g.end, emotionColor: emotionColors[i], idx: i });
        }
        flushWord();

        // 2. 挑选 1 个主视觉核心词（Hero Word）放大 1.32x，其余词统一 1.0x（全镜仅 2 档字号，杜绝每帧数十次 ctx.font 切换）
        const maxLen = Math.max(1, ...wordUnits.map(u => u.items.length));
        const heroCands = wordUnits.map((u, idx) => (u.items.length >= Math.max(1, maxLen - 1) ? idx : -1)).filter(idx => idx >= 0);
        const heroIdx = heroCands.length > 0
            ? heroCands[Math.floor(prismHash01(shot.seed, shot.index, 101) * heroCands.length) % heroCands.length]
            : 0;
        for (let uIdx = 0; uIdx < wordUnits.length; uIdx++) {
            wordUnits[uIdx].scale = uIdx === heroIdx ? 1.32 : 1.0;
        }

        // 3. 视口安全框与主动多行换行拼贴（允许长句拆至 3~4 行，且超过行宽上限时强制折行）
        const safeMarginX = Math.max(isPreview ? 14 : 48, w * 0.085);
        const safeMinX = safeMarginX;
        const safeMaxX = Math.max(safeMinX + 60, w - safeMarginX);
        const safeMinY = Math.max(isPreview ? 14 : 44, h * 0.12);
        const safeMaxY = isPreview ? Math.max(safeMinY + 40, h - 18) : Math.max(safeMinY + 80, Math.min(h * 0.79, h - 138));
        const safeW = safeMaxX - safeMinX;
        const safeH = safeMaxY - safeMinY;

        const targetRows = (shot.layout === 'vertical-triptych' && gCount <= 7)
            ? 1
            : (gCount >= 18 || wordUnits.length >= 6 ? 4 : (wordUnits.length >= 4 || gCount >= 10 ? 3 : (wordUnits.length >= 2 || gCount >= 5 ? 2 : 1)));

        const maxBoxW = safeW * 0.88;
        const maxBoxH = safeH * 0.86;
        ctx.save();
        /** @type {Array<{words:typeof wordUnits,width:number,height:number}>} */
        let packedRows = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            let totalW = 0;
            let widestWord = 1;
            for (const u of wordUnits) {
                const uPx = Math.round(fontPx * u.scale);
                ctx.font = `700 ${uPx}px ${fontStack}`;
                u.glyphWidths = u.items.map(it => Math.max(uPx * 0.28, ctx.measureText(it.char).width));
                u.width = u.glyphWidths.reduce((a, b) => a + b, 0);
                if (u.width > widestWord) widestWord = u.width;
                totalW += u.width + (u.spaced ? fontPx * 0.28 : fontPx * 0.04);
            }
            const rowBudgetBase = targetRows > 1
                ? Math.min(maxBoxW, Math.max(fontPx * 2.2, (totalW / targetRows) * 1.08))
                : maxBoxW;

            packedRows = [];
            let curRow = [];
            let curW = 0;
            for (let uIdx = 0; uIdx < wordUnits.length; uIdx++) {
                const u = wordUnits[uIdx];
                const gap = curRow.length === 0 ? 0 : (u.spaced ? fontPx * 0.28 : fontPx * 0.04);
                const rowLimit = Math.min(maxBoxW, rowBudgetBase * (0.86 + prismHash01(shot.seed, packedRows.length, 109) * 0.24));
                const remainWords = wordUnits.length - uIdx;
                const remainRows = targetRows - packedRows.length - 1;
                const forceBreak = curRow.length > 0 && remainRows > 0 && remainWords <= remainRows;
                const overMax = curRow.length > 0 && (curW + gap + u.width > maxBoxW);
                const overTarget = curRow.length > 0 && (curW + gap + u.width > rowLimit) && packedRows.length < targetRows - 1;
                if (forceBreak || overMax || overTarget) {
                    packedRows.push({ words: curRow, width: curW, height: 0 });
                    curRow = [];
                    curW = 0;
                }
                curW += (curRow.length === 0 ? 0 : gap) + u.width;
                curRow.push(u);
            }
            if (curRow.length > 0) packedRows.push({ words: curRow, width: curW, height: 0 });

            let blockH = 0;
            let widest = widestWord;
            for (let rIdx = 0; rIdx < packedRows.length; rIdx++) {
                const r = packedRows[rIdx];
                const tallest = Math.max(1, ...r.words.map(u => u.scale));
                r.height = fontPx * tallest * 1.08;
                blockH += r.height;
                if (r.width > widest) widest = r.width;
            }
            const fit = Math.min(1, widest > maxBoxW ? maxBoxW / widest : 1, blockH > maxBoxH ? maxBoxH / blockH : 1);
            if (fit >= 0.96 || fontPx <= fontPxFloor) break;
            fontPx = Math.max(fontPxFloor, Math.floor(fontPx * fit * 0.96));
        }

        const focusX = Math.min(w * 0.68, Math.max(w * 0.32, (geo.focus.x / geo.aspect) * w));
        // 尊重 9 宫不对称银幕锚区（上/下/左/右/对角海报位），同时避开底部播放栏上方翻译区
        const focusY = Math.min(h * 0.60, Math.max(h * 0.30, geo.focus.y * h));
        const regionAlign = (shot.region && shot.region.align) || 'center';
        const regionRotRad = (((shot.region && shot.region.rot) || 0) * Math.PI) / 180;
        /** @type {Array<{char:string,start:number,end:number,x:number,y:number,w:number,fontPx:number,rotRad:number,emotionColor:string|null}>} */
        const glyphs = [];
        const totalRows = packedRows.length;

        if (shot.layout === 'vertical-triptych' && gCount <= 7) {
            const maxStepY = gCount > 1 ? (safeH * 0.82) / (gCount - 1) : fontPx * 1.12;
            const stepY = Math.min(fontPx * 1.12, maxStepY);
            const startY = focusY - ((gCount - 1) * stepY) * 0.5;
            ctx.font = `700 ${fontPx}px ${fontStack}`;
            for (let i = 0; i < gCount; i++) {
                const g = shot.graphemes[i];
                const gw = ctx.measureText(g.char).width;
                const colOffset = (i % 2 === 0 ? -1 : 1) * fontPx * 0.18;
                glyphs.push({
                    char: g.char, start: g.start, end: g.end,
                    x: focusX + colOffset, y: startY + i * stepY,
                    w: gw, fontPx, rotRad: regionRotRad * 0.5, emotionColor: emotionColors[i],
                });
            }
        } else {
            const blockH = packedRows.reduce((s, r) => s + r.height, 0);
            const widestRowW = packedRows.reduce((m, r) => Math.max(m, r.width), 0);
            const baseRot = (shot.layout === 'diagonal-climb' ? (-5.5 * Math.PI) / 180 : 0) + regionRotRad;
            let cursorY = focusY - blockH * 0.5;

            for (let rIdx = 0; rIdx < totalRows; rIdx++) {
                const row = packedRows[rIdx];
                const rowCenterY = cursorY + row.height * 0.5;
                cursorY += row.height;

                // 行级错落缩进（Collage Staggered Indent）+ 左/中/右海报对齐，严格限制在当前行剩余安全宽度内
                let rowShiftX = (prismHash01(shot.seed, rIdx, 127) - 0.5) * (w * 0.045);
                if (shot.layout === 'horizontal-cascade') {
                    rowShiftX = (rIdx - (totalRows - 1) * 0.5) * (fontPx * 0.85);
                } else if (shot.layout === 'stepped-columns' || shot.layout === 'split-antiphony') {
                    rowShiftX = (rIdx % 2 === 0 ? -1 : 1) * (w * 0.05);
                }
                const maxShift = Math.max(0, (safeW - row.width) * 0.36);
                rowShiftX = Math.max(-maxShift, Math.min(maxShift, rowShiftX));

                const rowRot = baseRot + (prismHash01(shot.seed, rIdx, 131) - 0.5) * 0.032;
                let rowStartX = focusX + rowShiftX - row.width * 0.5;
                if (regionAlign === 'left') {
                    rowStartX = focusX - widestRowW * 0.44 + rowShiftX * 0.5;
                } else if (regionAlign === 'right') {
                    rowStartX = focusX + widestRowW * 0.44 - row.width + rowShiftX * 0.5;
                }
                rowStartX = Math.max(safeMinX, Math.min(Math.max(safeMinX, safeMaxX - row.width), rowStartX));
                let cursorX = rowStartX;

                for (let wIdx = 0; wIdx < row.words.length; wIdx++) {
                    const u = row.words[wIdx];
                    const salt = rIdx * 37 + wIdx;
                    const gap = wIdx === 0 ? 0 : (u.spaced ? fontPx * 0.28 : fontPx * 0.04);
                    cursorX += gap;
                    const wordShiftY = (prismHash01(shot.seed, salt, 139) - 0.5) * fontPx * 0.06;
                    const wordRot = (prismHash01(shot.seed, salt, 137) - 0.5) * 0.036;
                    const uFontPx = Math.round(fontPx * u.scale);

                    for (let cIdx = 0; cIdx < u.items.length; cIdx++) {
                        const it = u.items[cIdx];
                        const cw = u.glyphWidths[cIdx];
                        const gx = cursorX + cw * 0.5;
                        let gy = rowCenterY + wordShiftY;
                        let rot = rowRot + wordRot;
                        if (shot.layout === 'arc-orbit') {
                            const normX = row.width > 0 ? (gx - (rowStartX + row.width * 0.5)) / (row.width * 0.5) : 0;
                            gy += (normX * normX - 0.3) * fontPx * 0.30;
                            rot += normX * 0.08;
                        }
                        glyphs.push({
                            char: it.char, start: it.start, end: it.end,
                            x: gx, y: gy, w: cw, fontPx: uFontPx, rotRad: rot,
                            emotionColor: it.emotionColor,
                        });
                        cursorX += cw;
                    }
                }
            }
        }
        ctx.restore();

        // 4. 硬性视口安全框几何收束（100% 杜绝任何字形因偏心锚点、错落缩进、大字号或镜头推拉越出屏幕）
        if (glyphs.length > 0) {
            let rawMinX = Infinity, rawMinY = Infinity, rawMaxX = -Infinity, rawMaxY = -Infinity;
            for (let i = 0; i < glyphs.length; i++) {
                const g = glyphs[i];
                const halfW = g.w * 0.56 + g.fontPx * 0.16;
                const halfH = g.fontPx * 0.64;
                if (g.x - halfW < rawMinX) rawMinX = g.x - halfW;
                if (g.x + halfW > rawMaxX) rawMaxX = g.x + halfW;
                if (g.y - halfH < rawMinY) rawMinY = g.y - halfH;
                if (g.y + halfH > rawMaxY) rawMaxY = g.y + halfH;
            }
            const spanW = Math.max(1, rawMaxX - rawMinX);
            const spanH = Math.max(1, rawMaxY - rawMinY);
            if (spanW > safeW || spanH > safeH) {
                const fitS = Math.min(safeW / spanW, safeH / spanH) * 0.96;
                const cx = (rawMinX + rawMaxX) * 0.5;
                const cy = (rawMinY + rawMaxY) * 0.5;
                fontPx = Math.max(fontPxFloor, Math.round(fontPx * fitS));
                rawMinX = Infinity; rawMinY = Infinity; rawMaxX = -Infinity; rawMaxY = -Infinity;
                for (let i = 0; i < glyphs.length; i++) {
                    const g = glyphs[i];
                    g.x = cx + (g.x - cx) * fitS;
                    g.y = cy + (g.y - cy) * fitS;
                    g.w *= fitS;
                    g.fontPx = Math.max(fontPxFloor, Math.round(g.fontPx * fitS));
                    const halfW = g.w * 0.56 + g.fontPx * 0.16;
                    const halfH = g.fontPx * 0.64;
                    if (g.x - halfW < rawMinX) rawMinX = g.x - halfW;
                    if (g.x + halfW > rawMaxX) rawMaxX = g.x + halfW;
                    if (g.y - halfH < rawMinY) rawMinY = g.y - halfH;
                    if (g.y + halfH > rawMaxY) rawMaxY = g.y + halfH;
                }
            }
            let shiftAllX = 0;
            let shiftAllY = 0;
            if (rawMinX < safeMinX) shiftAllX = safeMinX - rawMinX;
            else if (rawMaxX > safeMaxX) shiftAllX = safeMaxX - rawMaxX;
            if (rawMinY < safeMinY) shiftAllY = safeMinY - rawMinY;
            else if (rawMaxY > safeMaxY) shiftAllY = safeMaxY - rawMaxY;
            if (shiftAllX !== 0 || shiftAllY !== 0) {
                for (let i = 0; i < glyphs.length; i++) {
                    glyphs[i].x += shiftAllX;
                    glyphs[i].y += shiftAllY;
                }
            }
        }

        let minGX = w, minGY = h, maxGX = 0, maxGY = 0;
        for (let i = 0; i < glyphs.length; i++) {
            const g = glyphs[i];
            const span = Math.max(g.w, g.fontPx);
            const padX = span * 1.28;
            const padY = span * 1.38;
            if (g.x - padX < minGX) minGX = g.x - padX;
            if (g.y - padY < minGY) minGY = g.y - padY;
            if (g.x + padX > maxGX) maxGX = g.x + padX;
            if (g.y + padY > maxGY) maxGY = g.y + padY;
        }
        const bx0 = Math.max(0, Math.floor(minGX));
        const by0 = Math.max(0, Math.floor(minGY));
        const bx1 = Math.min(w, Math.ceil(maxGX));
        const by1 = Math.min(h, Math.ceil(maxGY));
        const dirtyRect = {
            x: bx0,
            y: by0,
            w: Math.max(16, bx1 - bx0),
            h: Math.max(16, by1 - by0),
        };
        const hasInvert = geo.facets.some(f => Boolean(f.invert));

        const watermarkChar = Array.from(shot.text.replace(/\s+/g, ''))[0] || '◇';
        const wmText = shot.watermarkText || watermarkChar;
        let watermarkCanvas = null;
        if (geo.watermark && typeof document !== 'undefined') {
            watermarkCanvas = document.createElement('canvas');
            const wmW = wmText.length > 2 ? 320 : 128;
            const wmH = 112;
            watermarkCanvas.width = wmW;
            watermarkCanvas.height = wmH;
            const wctx = watermarkCanvas.getContext('2d');
            if (wctx) {
                wctx.font = `800 ${wmText.length > 2 ? 52 : 72}px ${fontStack}`;
                wctx.textAlign = 'center';
                wctx.textBaseline = 'middle';
                wctx.fillStyle = '#ffffff';
                wctx.fillText(wmText, wmW * 0.5, wmH * 0.5);
            }
        }
        const subY = h - 108;
        cached = { w, h, fontStack, fontPx, focusX, focusY, glyphs, dirtyRect, hasInvert, watermarkChar, watermarkCanvas, subY };
        this._layoutCache.set(shot.index, cached);
        return cached;
    }

    /**
     * 提前预热下一分镜的几何与排版缓存（类似 Tempera ensureScene 预滚），确保切镜第 0 帧零耗时
     */
    _prewarmNextShot(activeShot, w, h, ctx) {
        if (!this._program || !this._program.shots || !activeShot) return;
        const nextShot = this._program.shots[activeShot.index + 1];
        if (!nextShot) return;
        const aspect = w / Math.max(1, h);
        const geo = this._getGeometry(nextShot, aspect);
        this._getShotLayout(nextShot, geo, w, h, ctx);
    }

    /**
     * @param {number} timeMs
     * @param {number} [ambientMs]
     */
    _renderFrame(timeMs, ambientMs) {
        if (!this._ctx || !this._canvas) return;
        this._ensureProgram();
        if (!this._program) return;

        const cw = this._canvas.width;
        const ch = this._canvas.height;
        const w = cw / this._dpr;
        const h = ch / this._dpr;
        if (w <= 4 || h <= 4) return;

        this._dirty = false;
        const amb = typeof ambientMs === 'number' && ambientMs > 0 ? ambientMs : timeMs;

        const ctx = this._ctx;
        const palette = this._resolvePalette();
        const lowPerf = this._isLowPerf();
        const state = findActivePrismShot(this._program, timeMs);

        ctx.save();
        ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

        // 共享舞台深色底幕（只画 1 次，上下游分镜在其上无碰撞顺滑交棒）；渐变对象按 色板+尺寸 缓存，不再每帧分配
        const bgSig = `${palette.bg}|${palette.accent}|${Math.round(w)}x${Math.round(h)}`;
        if (this._bgGradSig !== bgSig) {
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, mixHex(palette.bg, palette.accent, 0.05));
            g.addColorStop(0.52, palette.bg);
            g.addColorStop(1, mixHex(palette.bg, '#020408', 0.45));
            this._bgGrad = g;
            this._bgGradSig = bgSig;
        }
        ctx.fillStyle = this._bgGrad;
        ctx.fillRect(0, 0, w, h);

        if (!state.active) {
            ctx.restore();
            return;
        }

        // 预热阈值降到 0.12（prismTransition）：seek/情绪词到达后更早热下一镜排版
        if (shouldPrewarmNextShot(state.activeProgress)) {
            this._prewarmNextShot(state.active, w, h, ctx);
        }

        if (state.prev && state.transitionProgress < 1) {
            this._renderTransition(
                ctx,
                state.prev,
                state.active,
                state.activeProgress,
                state.transitionProgress,
                timeMs,
                amb,
                w,
                h,
                palette,
                lowPerf,
            );
        } else {
            this._frozenForShotIndex = -1;
            this._renderSingleShot(ctx, state.active, state.activeProgress, timeMs, amb, w, h, palette, lowPerf, 1, 0, true);
        }

        this._renderVignetteAndHud(ctx, state.active, state.activeProgress, amb, w, h, palette);
        ctx.restore();
    }

    /**
     * 预烘焙 64x64 径向柔光精灵并按颜色缓存，避免每帧重复构造几十个 CanvasGradient
     * @param {string} colorHex
     * @returns {HTMLCanvasElement|null}
     */
    _getGlowSprite(colorHex) {
        if (typeof document === 'undefined') return null;
        const key = colorHex || '#7ce8ff';
        let spr = this._glowSpriteCache.get(key);
        if (spr) return spr;
        if (this._glowSpriteCache.size >= 24) {
            const first = this._glowSpriteCache.keys().next().value;
            if (first !== undefined) this._glowSpriteCache.delete(first);
        }
        spr = document.createElement('canvas');
        spr.width = 64;
        spr.height = 64;
        const sctx = spr.getContext('2d');
        if (!sctx) return null;
        const rg = sctx.createRadialGradient(32, 32, 1, 32, 32, 32);
        rg.addColorStop(0, 'rgba(252, 254, 255, 0.92)');
        rg.addColorStop(0.32, `${key}aa`);
        rg.addColorStop(0.68, `${key}38`);
        rg.addColorStop(1, 'rgba(0, 0, 0, 0)');
        sctx.fillStyle = rg;
        sctx.fillRect(0, 0, 64, 64);
        this._glowSpriteCache.set(key, spr);
        return spr;
    }

    _strokePrismSeam(ctx, x1, y1, x2, y2, palette, intensity = 1) {
        if (intensity <= 0.02) return;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 2) return;
        const nx = -dy / len;
        const ny = dx / len;
        const disp = this.opts.prismDispersion;

        // 分段锥化顶点（替代每条棱边 3 次 createLinearGradient 分配，零 GC 压力）
        // 外层发丝线贯通全长（旧版 8%~92% 两端留缺口，在切面顶点处读成「虚线」，像廉价 UI 窗框而非玻璃）
        const ax1 = x1, ay1 = y1;
        const ax2 = x2, ay2 = y2;
        const cx1 = x1 + dx * 0.14, cy1 = y1 + dy * 0.14;
        const cx2 = x1 + dx * 0.86, cy2 = y1 + dy * 0.86;
        const bx1 = x1 + dx * 0.30, by1 = y1 + dy * 0.30;
        const bx2 = x1 + dx * 0.70, by2 = y1 + dy * 0.70;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';

        if (disp > 0.06) {
            const off = 1.1 + disp * 1.3;
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = 0.30 * intensity * disp;
            ctx.strokeStyle = palette.dispersion[0];
            ctx.beginPath();
            ctx.moveTo(cx1 + nx * off, cy1 + ny * off);
            ctx.lineTo(cx2 + nx * off, cy2 + ny * off);
            ctx.stroke();

            ctx.strokeStyle = palette.dispersion[2];
            ctx.beginPath();
            ctx.moveTo(cx1 - nx * off, cy1 - ny * off);
            ctx.lineTo(cx2 - nx * off, cy2 - ny * off);
            ctx.stroke();
        }

        // 外层贯通发丝脊线 + 中段高光晶芯
        ctx.strokeStyle = palette.dispersion[2];
        ctx.globalAlpha = 0.34 * intensity;
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(ax1, ay1);
        ctx.lineTo(ax2, ay2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(248, 253, 255, 0.92)';
        ctx.globalAlpha = 0.56 * intensity;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(bx1, by1);
        ctx.lineTo(bx2, by2);
        ctx.stroke();
        ctx.restore();
    }

    _renderTransition(ctx, prevShot, activeShot, activeProg, tp, timeMs, amb, w, h, palette, lowPerf) {
        const linear = clamp01(tp);
        // Tempera 同款非对称进出场曲线：新镜快速利落切入定焦 (power 3.4)，旧镜柔顺滑向下游消隐
        const enter = 1 - Math.pow(1 - clamp01(linear / 0.88), 3.4);
        const exit = easeInOutCubic(linear);
        const kind = activeShot.transition;
        const prevDur = Math.max(1, prevShot.endTimeMs - prevShot.startTimeMs);
        // 允许旧镜进度自然越过 1.0（Tempera camera overshoot），切镜瞬间绝不急停顿挫
        const prevProg = Math.min(1.45, Math.max(0, (timeMs - prevShot.startTimeMs) / prevDur));
        const seamFade = Math.sin(linear * Math.PI);

        // 连续流向向量（Tempera 顺流交棒：旧镜顺流滑向下游 +x/+y，新镜从上游 -x/-y 顺势接棒）
        const flowRad = typeof activeShot.flowAngleRad === 'number'
            ? activeShot.flowAngleRad
            : (((activeShot.flowAngleDeg || -14) * Math.PI) / 180);
        const prevFlowRad = typeof prevShot.flowAngleRad === 'number' ? prevShot.flowAngleRad : flowRad;
        const flowX = Math.cos(flowRad);
        const flowY = Math.sin(flowRad);
        const prevFlowX = Math.cos(prevFlowRad);
        const prevFlowY = Math.sin(prevFlowRad);
        const span = Math.hypot(w, h);

        const outAlpha = Math.pow(Math.max(0, 1 - exit), 1.28);
        const inAlpha = clamp01(enter * 1.12);

        // 1. Outgoing Shot：顺流推向下游并伴随景深缩放/微旋，决不硬切冻结
        // 旧镜底板首帧冻结到独立画布、后续帧复用冻结纹理（省掉第二份全屏栅格化 + 纹理重传）
        const prevIdx = prevShot.index;
        let outPlateMode = 'live';
        if (canReuseFrozenPlate(prevIdx, this._frozenForShotIndex, linear)) {
            outPlateMode = 'frozen-reuse';
        } else if (shouldFreezeOutgoingPlate(prevIdx, this._frozenForShotIndex, linear)) {
            outPlateMode = 'frozen-render';
        }
        if (outAlpha > 0.01) {
            if (outPlateMode === 'frozen-render') this._frozenForShotIndex = prevIdx;
            const outDist = exit * span * (kind === 'shear-slide' ? 0.42 : 0.30);
            const outZoom = kind === 'iris-refract'
                ? (1 + exit * 0.16)
                : (kind === 'prism-rotate' ? (1 - exit * 0.14) : (1 + exit * 0.05));
            const outRot = kind === 'prism-rotate' ? (-exit * 0.055) : (exit * 0.015);

            ctx.save();
            ctx.translate(prevFlowX * outDist, prevFlowY * outDist);
            ctx.translate(w * 0.5, h * 0.5);
            if (Math.abs(outRot) > 0.001) ctx.rotate(outRot);
            if (Math.abs(outZoom - 1) > 0.001) ctx.scale(outZoom, outZoom);
            ctx.translate(-w * 0.5, -h * 0.5);
            this._renderSingleShot(ctx, prevShot, prevProg, timeMs, amb, w, h, palette, lowPerf, outAlpha, exit * 0.32, false, false, outPlateMode);
            ctx.restore();
        }

        // 2. Incoming Shot：从上游沿流向丝滑涌入，配合切面级视差错峰展开
        const inDist = -(1 - enter) * span * (kind === 'shear-slide' ? 0.32 : 0.22);
        const inZoom = kind === 'iris-refract'
            ? (0.88 + enter * 0.12)
            : (kind === 'prism-rotate' ? (0.86 + enter * 0.14) : (0.95 + enter * 0.05));
        const inRot = kind === 'prism-rotate' ? ((1 - enter) * 0.055) : (-(1 - enter) * 0.012);

        ctx.save();
        ctx.translate(flowX * inDist, flowY * inDist);
        ctx.translate(w * 0.5, h * 0.5);
        if (Math.abs(inRot) > 0.001) ctx.rotate(inRot);
        if (Math.abs(inZoom - 1) > 0.001) ctx.scale(inZoom, inZoom);
        ctx.translate(-w * 0.5, -h * 0.5);
        this._renderSingleShot(ctx, activeShot, activeProg, timeMs, amb, w, h, palette, lowPerf, inAlpha, -(1 - enter) * 0.26, false, true, 'live');
        ctx.restore();

        // 3. 交棒分界光脊与副歌柔焦光谱脉冲
        if (seamFade > 0.04) {
            const perpX = -flowY;
            const perpY = flowX;
            const seamCx = w * 0.5 + flowX * (exit - 0.5) * w * 0.45;
            const seamCy = h * 0.5 + flowY * (exit - 0.5) * h * 0.45;
            this._strokePrismSeam(
                ctx,
                seamCx - perpX * span * 0.45,
                seamCy - perpY * span * 0.45,
                seamCx + perpX * span * 0.45,
                seamCy + perpY * span * 0.45,
                palette,
                seamFade * 0.65,
            );

            if (kind === 'spectral-flash') {
                const flashSpr = this._getGlowSprite(palette.dispersion[2]);
                if (flashSpr) {
                    const fr = span * 0.48;
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha = seamFade * 0.22;
                    ctx.drawImage(flashSpr, w * 0.5 - fr, h * 0.5 - fr, fr * 2, fr * 2);
                    ctx.restore();
                }
            }
        }

        const activeGeo = this._getGeometry(activeShot, w / Math.max(1, h));
        const activeLayout = this._getShotLayout(activeShot, activeGeo, w, h, ctx);
        this._drawSubtitles(ctx, activeShot, activeLayout, w, h, palette);
    }

    _drawDecorMotif(ctx, shot, geo, layout, amb, w, h, palette) {
        const motif = shot.decorMotif || 'astrolabe-rings';
        const fx = layout.focusX;
        const fy = layout.focusY;
        const unit = Math.min(w, h);
        const rot = amb * 0.00018 * (shot.index % 2 === 0 ? 1 : -1);

        ctx.save();
        // 背景光池：焦点后方一团极淡的主色体积光（复用缓存精灵，1 次 drawImage），让纯黑底有景深
        const poolSpr = this._getGlowSprite(palette.accent);
        if (poolSpr) {
            const pr = unit * 0.95;
            ctx.globalAlpha = 0.07;
            ctx.drawImage(poolSpr, fx - pr * 1.25, fy - pr, pr * 2.5, pr * 2);
        }
        ctx.strokeStyle = palette.dispersion[2] || palette.accent;
        ctx.fillStyle = palette.dispersion[0] || palette.accent;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.10;

        if (motif === 'astrolabe-rings' || motif === 'orbit-arcs') {
            const r1 = unit * (motif === 'orbit-arcs' ? 0.34 : 0.26);
            const r2 = unit * (motif === 'orbit-arcs' ? 0.46 : 0.38);
            ctx.beginPath();
            ctx.arc(fx, fy, r1, rot, rot + Math.PI * 1.45);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(fx, fy, r2, -rot * 1.3, -rot * 1.3 + Math.PI * 1.15);
            ctx.stroke();
        } else if (motif === 'reticle-cross' || motif === 'corner-brackets') {
            const arm = unit * 0.32;
            const gap = unit * 0.08;
            ctx.beginPath();
            ctx.moveTo(fx - arm, fy); ctx.lineTo(fx - gap, fy);
            ctx.moveTo(fx + gap, fy); ctx.lineTo(fx + arm, fy);
            ctx.moveTo(fx, fy - arm * 0.75); ctx.lineTo(fx, fy - gap * 0.75);
            ctx.moveTo(fx, fy + gap * 0.75); ctx.lineTo(fx, fy + arm * 0.75);
            ctx.stroke();
        } else if (motif === 'parallel-rulers' || motif === 'diffraction-grating') {
            const count = motif === 'diffraction-grating' ? 7 : 4;
            const spanW = w * 0.42;
            const slant = h * 0.14;
            ctx.beginPath();
            for (let i = 0; i < count; i++) {
                const ox = fx + ((i / (count - 1)) - 0.5) * spanW;
                ctx.moveTo(ox + slant, fy - h * 0.26);
                ctx.lineTo(ox - slant, fy + h * 0.26);
            }
            ctx.stroke();
        } else {
            // crystal-lattice / diamond-grid
            const rx = unit * 0.34;
            const ry = unit * 0.22;
            ctx.beginPath();
            ctx.moveTo(fx, fy - ry);
            ctx.lineTo(fx + rx, fy);
            ctx.lineTo(fx, fy + ry);
            ctx.lineTo(fx - rx, fy);
            ctx.closePath();
            ctx.stroke();
        }

        // 邻句背景大号水印（预烘焙 <=72px 精灵等比放大，避开 Skia 256px 矢量光栅化回退）
        if (geo.watermark && layout.watermarkCanvas) {
            const wmScale = (unit * 0.42) / 72;
            const wmW = layout.watermarkCanvas.width * wmScale;
            const wmH = layout.watermarkCanvas.height * wmScale;
            const wx = fx + (w * 0.5 - fx) * 0.35 - wmW * 0.5;
            const wy = fy + (h * 0.48 - fy) * 0.35 - wmH * 0.5;
            ctx.globalAlpha = 0.038;
            ctx.drawImage(layout.watermarkCanvas, wx, wy, wmW, wmH);
        }
        ctx.restore();
    }

    _renderSingleShot(ctx, shot, shotProgress, timeMs, amb, w, h, palette, lowPerf, alpha = 1, relayOffset = 0, drawSub = true, isPrimary = true, plateMode = 'live') {
        const aspect = w / Math.max(1, h);
        const geo = this._getGeometry(shot, aspect);
        const layout = this._getShotLayout(shot, geo, w, h, ctx);

        // Tempera 同款连续运镜（允许越过 1.0 顺势滑行 overshoot，杜绝切镜瞬间急停）
        const camInt = this.opts.prismCamera * (shot.isChorus ? 1.12 : 1.0);
        const pClamped = clamp01(shotProgress);
        const overshoot = Math.max(0, shotProgress - 1) * 0.35;
        const ep = pClamped * 0.72 + (0.5 - 0.5 * Math.cos(pClamped * Math.PI)) * 0.28 + overshoot;
        const floatX = Math.sin(amb * 0.00055 + shot.index * 1.3) * 0.0045;
        const floatY = Math.cos(amb * 0.00048 + shot.index * 0.9) * 0.0045;
        const baseZoom = shot.cameraZoomStart + (shot.cameraZoomEnd - shot.cameraZoomStart) * ep;
        const zoom = (1 + (baseZoom - 1) * camInt) * (1 + relayOffset * 0.045 * camInt);
        const dx = (shot.cameraDriftX * (ep - 0.5 + relayOffset * 0.35) + floatX) * w * camInt;
        const dy = (shot.cameraDriftY * (ep - 0.5 + relayOffset * 0.35) + floatY) * h * camInt;
        const rollRad = ((shot.cameraRollStartDeg + (shot.cameraRollEndDeg - shot.cameraRollStartDeg) * ep + relayOffset * 0.8) * Math.PI / 180) * camInt;

        const refractAmp = this.opts.prismRefraction * Math.min(w, h) * 0.011;
        const disp = lowPerf ? 0 : this.opts.prismDispersion;
        // 轴对齐光栅化单镜文字底板。live=新镜每帧渲染；frozen-render=旧镜转场首帧渲染到冻结画布；
        // frozen-reuse=旧镜后续帧直接复用冻结纹理，跳过重栅格化（切镜卡顿主因的对策）
        const renderPlate = this._usePlateBuffer(plateMode);
        const hasPlate = renderPlate
            ? this._renderShotTextPlates(shot, layout, disp, timeMs, palette, lowPerf)
            : Boolean(this._curPlateLight && layout.dirtyRect);

        ctx.save();
        if (alpha < 0.999) ctx.globalAlpha = clamp01(alpha);
        ctx.translate(w * 0.5 + dx, h * 0.5 + dy);
        ctx.rotate(rollRad);
        ctx.scale(zoom, zoom);
        ctx.translate(-w * 0.5, -h * 0.5);

        // 1. 舞台光学几何母题底纹 + 柔化连续光谱色散束（零离屏 Canvas 分配）
        if (!lowPerf) {
            this._drawDecorMotif(ctx, shot, geo, layout, amb, w, h, palette);
        }
        if (!lowPerf && (this.opts.prismCaustics > 0.05 || disp > 0.05)) {
            this._drawSpectralRayFan(ctx, geo, pClamped, amb, w, h, palette);
        }

        // 2. 画家算法由后向前逐层绘制切面（每个切面仅 1 次 GPU 纹理 drawImage 折射投射）
        const elapsedMs = Math.max(0, timeMs - shot.startTimeMs);
        const enterWindowMs = Math.max(260, (shot.handoffMs || 460) * 0.92);
        const rawShotEnter = clamp01(elapsedMs / enterWindowMs);
        const flowRad = typeof shot.flowAngleRad === 'number'
            ? shot.flowAngleRad
            : (((shot.flowAngleDeg || -14) * Math.PI) / 180);
        const creepPx = (pClamped - 0.5) * Math.min(w, h) * 0.022;
        const creepX = Math.cos(flowRad) * creepPx;
        const creepY = Math.sin(flowRad) * creepPx;

        /** @type {Array<{x:number,y:number}>} */
        const facetOffsets = new Array(geo.facets.length);

        for (let fIdx = 0; fIdx < geo.facets.length; fIdx++) {
            const facet = geo.facets[fIdx];
            const delayF = facet.delayFraction || 0;
            const spanF = facet.spanFraction || 0.55;
            const localRaw = clamp01((rawShotEnter - delayF) / spanF);
            const facetEnter = 1 - Math.pow(1 - localRaw, 3.2);
            const fOffX = fIdx === 0
                ? 0
                : ((1 - facetEnter) * (facet.enterDX || 0) * w + creepX * (0.65 + fIdx * 0.18));
            const fOffY = fIdx === 0
                ? 0
                : ((1 - facetEnter) * (facet.enterDY || 0) * h + creepY * (0.65 + fIdx * 0.18));
            facetOffsets[fIdx] = { x: fOffX, y: fOffY };

            // 非分割型镜头 (shard/aperture/monolith/corridor) 的第 0 层是全屏底幕：直接画底字，0 次 clip！
            if (fIdx === 0 && !geo.isPartition && !facet.invert) {
                if (hasPlate) {
                    this._blitFacetPlate(ctx, layout, facet, 0, refractAmp, amb);
                } else {
                    this._drawGlyphsInFacet(ctx, shot, layout, geo, facet, 0, refractAmp, disp, timeMs, amb, w, h, palette, lowPerf);
                }
                continue;
            }

            ctx.save();
            if (fOffX !== 0 || fOffY !== 0) {
                ctx.translate(fOffX, fOffY);
            }
            ctx.beginPath();
            for (let pIdx = 0; pIdx < facet.points.length; pIdx++) {
                const pt = facet.points[pIdx];
                const px = (pt.x / geo.aspect) * w;
                const py = pt.y * h;
                if (pIdx === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.clip();

            // 前景晶块不透明切面填充（自然遮挡底层原位字，单次 clip 即实现零双影折射！）
            const bb = facet.bbox || { minX: 0, minY: 0, maxX: geo.aspect, maxY: 1 };
            const bx0 = (bb.minX / geo.aspect) * w;
            const by0 = bb.minY * h;
            const bx1 = (bb.maxX / geo.aspect) * w;
            const by1 = bb.maxY * h;
            const bcx = (bx0 + bx1) * 0.5;
            const bcy = (by0 + by1) * 0.5;
            const bSpan = Math.max(80, Math.hypot(bx1 - bx0, by1 - by0) * 0.55);
            const sRad = ((facet.sheenAngle || 25) * Math.PI) / 180;
            const gx0 = bcx - Math.cos(sRad) * bSpan;
            const gy0 = bcy - Math.sin(sRad) * bSpan;
            const gx1 = bcx + Math.cos(sRad) * bSpan;
            const gy1 = bcy + Math.sin(sRad) * bSpan;

            const baseColor = facet.invert
                ? palette.lightFacet
                : (palette.tones[facet.tone % palette.tones.length] || palette.bg);
            // 切面渐变按 镜×切面×色板×尺寸 缓存：原先每切面每帧 1 次 createLinearGradient + 2 次 mixHex 字符串解析
            const gKey = `${shot.index}:${fIdx}:${baseColor}:${palette.accent}:${Math.round(w)}x${Math.round(h)}`;
            let grad = this._facetGradCache.get(gKey);
            if (!grad) {
                grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
                if (facet.invert) {
                    // 珍珠母贝式亮切面：两端各染一道色散色，替代原「纯白 → 亮面」的刺眼白板
                    grad.addColorStop(0, mixHex(baseColor, palette.dispersion[0], 0.14));
                    grad.addColorStop(0.5, baseColor);
                    grad.addColorStop(1, mixHex(baseColor, palette.dispersion[2], 0.26));
                } else {
                    // 玻璃体：迎光一侧窄带反光 → 迅速沉入与底幕同族的深色体积（旧版整块偏亮海军蓝，像塑料面板）
                    grad.addColorStop(0, mixHex(baseColor, palette.accent, fIdx === 0 ? 0.06 : 0.20));
                    grad.addColorStop(0.16, mixHex(baseColor, palette.accent, fIdx === 0 ? 0.02 : 0.07));
                    grad.addColorStop(0.55, baseColor);
                    grad.addColorStop(1, mixHex(baseColor, '#010205', 0.55));
                }
                if (this._facetGradCache.size >= 96) this._facetGradCache.clear();
                this._facetGradCache.set(gKey, grad);
            }
            ctx.fillStyle = grad;
            ctx.fillRect(bx0 - 24, by0 - 24, (bx1 - bx0) + 48, (by1 - by0) + 48);

            // 内缘光（rim light）：沿切面路径描一道宽描边，clip 只留内侧一半 → 玻璃厚度感。
            // 复用 clip 时的当前路径（Canvas 路径按构建时变换存储，后续 translate 不影响），每切面仅 1 次 stroke
            if (!lowPerf && fIdx > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha *= facet.invert ? 0.30 : 0.16;
                ctx.strokeStyle = facet.invert ? '#ffffff' : palette.dispersion[2];
                ctx.lineWidth = Math.max(6, Math.min(w, h) * 0.012);
                ctx.lineJoin = 'round';
                ctx.stroke();
                ctx.restore();
            }

            // 入场掠光（glint）：晶块滑入时一道沿 sheenAngle 扫过的镜面反光，像玻璃迎光一转；
            // 复用已缓存的白色柔光精灵 + 已存在的 clip，仅入场 ~700ms 内每切面 1 次 drawImage
            if (!lowPerf && fIdx > 0 && elapsedMs < 900) {
                const gp = clamp01((elapsedMs - (facet.delayFraction || 0) * enterWindowMs) / 700);
                if (gp > 0 && gp < 1) {
                    const glintSpr = this._getGlowSprite('#ffffff');
                    if (glintSpr) {
                        const along = (gp * 2 - 1) * bSpan * 1.1;
                        ctx.save();
                        ctx.globalCompositeOperation = 'lighter';
                        ctx.globalAlpha *= Math.sin(gp * Math.PI) * (facet.invert ? 0.22 : 0.34);
                        ctx.translate(bcx + Math.cos(sRad) * along, bcy + Math.sin(sRad) * along);
                        ctx.rotate(sRad + Math.PI * 0.5);
                        ctx.scale(1, 0.12);
                        ctx.drawImage(glintSpr, -bSpan, -bSpan, bSpan * 2, bSpan * 2);
                        ctx.restore();
                    }
                }
            }

            if (facet.useCover && this._coverCanvas && !facet.invert) {
                ctx.save();
                ctx.globalAlpha *= 0.24;
                ctx.drawImage(this._coverCanvas, -w * 0.08, -h * 0.08, w * 1.16, h * 1.16);
                ctx.restore();
            }

            // 将切面内的文字反移回世界坐标后再加折射偏移，使晶块滑入时如真实光学透镜扫过字面
            if (fOffX !== 0 || fOffY !== 0) {
                ctx.translate(-fOffX, -fOffY);
            }
            if (hasPlate) {
                this._blitFacetPlate(ctx, layout, facet, fIdx, refractAmp, amb);
            } else {
                this._drawGlyphsInFacet(ctx, shot, layout, geo, facet, fIdx, refractAmp, disp, timeMs, amb, w, h, palette, lowPerf);
            }
            ctx.restore();
        }

        // 3. 切面棱边色散双色流光与渐隐晶脊高光（随所属晶块同步视差滑移）
        for (const seg of geo.cutSegments) {
            const fo = facetOffsets[seg.facetIndex || 0] || { x: 0, y: 0 };
            const x1 = (seg.x1 / geo.aspect) * w + fo.x;
            const y1 = seg.y1 * h + fo.y;
            const x2 = (seg.x2 / geo.aspect) * w + fo.x;
            const y2 = seg.y2 * h + fo.y;
            this._strokePrismSeam(ctx, x1, y1, x2, y2, palette, 0.55 + disp * 0.45);
        }

        // 4. 3D 视差悬浮晶尘微粒 + 变形宽银幕衍射焦散光束（交棒期间仅主镜绘制，杜绝状态乒乓与双倍消耗）
        if (isPrimary && !lowPerf) {
            this._drawCrystalDust(ctx, geo, layout, timeMs, amb, w, h, palette);
        }
        if (isPrimary && this.opts.prismCaustics > 0.05) {
            this._drawCaustics(ctx, shot, layout, timeMs, amb, w, h, palette);
        }
        ctx.restore();

        // 5. 翻译与罗马音固定在屏幕空间底部播放控件栏正上方（不随镜头晃动）
        if (drawSub) {
            this._drawSubtitles(ctx, shot, layout, w, h, palette);
        }
    }

    /**
     * 每镜仅以轴对齐单位矩阵渲染 1 次文字底板（及反转切面暗墨底板），使 Skia GPU 字形图集 100% 命中
     */
    /**
     * 选定本次渲染使用的底板缓冲对，并返回是否需要重栅格化。
     * @param {'live'|'frozen-render'|'frozen-reuse'} mode
     * @returns {boolean}
     */
    _usePlateBuffer(mode) {
        const frozen = mode !== 'live';
        this._curPlateLight = frozen ? this._plateFrozenLight : this._plateLight;
        this._curPlateDark = frozen ? this._plateFrozenDark : this._plateDark;
        this._curPlateLightCtx = frozen ? this._plateFrozenLightCtx : this._plateLightCtx;
        this._curPlateDarkCtx = frozen ? this._plateFrozenDarkCtx : this._plateDarkCtx;
        return mode !== 'frozen-reuse';
    }

    _renderShotTextPlates(shot, layout, disp, timeMs, palette, lowPerf) {
        if (!this._curPlateLightCtx || !this._curPlateLight || !layout.dirtyRect) return false;
        const dr = layout.dirtyRect;
        const dpr = this._dpr;
        const pCtx = this._curPlateLightCtx;
        pCtx.save();
        pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        pCtx.clearRect(0, 0, layout.w, layout.h);
        this._drawShotGlyphsToPlate(pCtx, shot, layout, false, disp, timeMs, palette, lowPerf);
        pCtx.restore();

        if (layout.hasInvert && this._curPlateDarkCtx) {
            const dCtx = this._curPlateDarkCtx;
            dCtx.save();
            dCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            dCtx.clearRect(0, 0, layout.w, layout.h);
            this._drawShotGlyphsToPlate(dCtx, shot, layout, true, disp, timeMs, palette, lowPerf);
            dCtx.restore();
        }
        return true;
    }

    /** mixHex 记忆化（热路径专用，容量 256 满即清空） */
    _mixMemo(a, b, t) {
        if (!this._mixCache) this._mixCache = new Map();
        const k = `${a}|${b}|${t}`;
        let v = this._mixCache.get(k);
        if (v === undefined) {
            if (this._mixCache.size >= 256) this._mixCache.clear();
            v = mixHex(a, b, t);
            this._mixCache.set(k, v);
        }
        return v;
    }

    _drawShotGlyphsToPlate(ctx, shot, layout, invert, disp, timeMs, palette, lowPerf) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let curPx = -1;
        const fullReveal = !!this._posterFullReveal;
        for (let i = 0; i < layout.glyphs.length; i++) {
            const g = layout.glyphs[i];
            const gPx = g.fontPx || layout.fontPx;
            const enterDelay = shot.startTimeMs + i * 22;
            const enterT = fullReveal ? 1 : clamp01((timeMs - enterDelay) / 380);
            if (enterT <= 0.01) continue;
            const easeE = 1 - Math.pow(1 - enterT, 3);

            const span = Math.max(150, g.end - g.start);
            const singFrac = fullReveal ? 1 : clamp01((timeMs - (g.start - 40)) / (span + 40));
            const smoothSing = singFrac * singFrac * (3 - 2 * singFrac);
            const afterglow = fullReveal ? 0.72 : (timeMs <= g.end ? smoothSing : clamp01(1 - (timeMs - g.end) / 380));
            const liftEnv = smoothSing * (0.28 + 0.72 * afterglow);
            const isActive = singFrac > 0.01 && afterglow > 0.05;

            let ox = 0;
            let oy = 0;
            if (enterT < 1) {
                const inv = 1 - easeE;
                if (shot.enterStyle === 'shard-rise') oy += inv * gPx * 0.28;
                else if (shot.enterStyle === 'shear-lock') ox += (i % 2 === 0 ? -1 : 1) * inv * gPx * 0.22;
                else oy += inv * gPx * 0.20;
            }
            if (liftEnv > 0.005) {
                oy -= liftEnv * gPx * 0.045;
            }

            if (gPx !== curPx) {
                curPx = gPx;
                ctx.font = `700 ${gPx}px ${layout.fontStack}`;
            }

            const drawX = g.x + ox;
            const drawY = g.y + oy;
            ctx.save();
            ctx.translate(drawX, drawY);
            ctx.globalAlpha = easeE;

            if (!lowPerf && !invert && afterglow > 0.08 && singFrac > 0.02) {
                const glowSpr = this._getGlowSprite(g.emotionColor || palette.accent);
                if (glowSpr) {
                    const gr = Math.max(g.w, gPx) * 0.92;
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha = easeE * 0.26 * afterglow * Math.sin(Math.min(1, singFrac * 1.2) * Math.PI * 0.85 + 0.15);
                    ctx.drawImage(glowSpr, -gr, -gr, gr * 2, gr * 2);
                    ctx.restore();
                }
            }

            if (!lowPerf && !invert && disp > 0.08 && (isActive || enterT < 1)) {
                const fringe = 0.85 + (enterT < 1 ? (1 - easeE) * 2.2 : 0) + afterglow * 0.85;
                const fx = 0.68 * fringe * disp;
                const fy = -0.45 * fringe * disp;
                ctx.save();
                ctx.globalAlpha = easeE * (singFrac > 0 ? (0.30 + afterglow * 0.18) : 0.22);
                ctx.fillStyle = palette.dispersion[0];
                ctx.fillText(g.char, -fx, -fy);
                ctx.fillStyle = palette.dispersion[2];
                ctx.fillText(g.char, fx, fy);
                ctx.restore();
            }

            const halfW = Math.max(gPx * 0.38, g.w * 0.64);
            // 未唱字：空心描边 + 极淡实心（旧版 34% 灰实心压在深蓝上发脏发灰）；
            // 唱到一半的字先描边，再由扫光渐变填实，读起来像光把空心玻璃字「灌满」
            if (singFrac < 0.99) {
                ctx.lineWidth = Math.max(1, Math.min(2.6, gPx * 0.012));
                ctx.lineJoin = 'round';
                ctx.strokeStyle = invert ? 'rgba(12, 18, 30, 0.50)' : this._mixMemo(palette.ink, palette.accent, 0.35);
                const prevA = ctx.globalAlpha;
                if (!invert) ctx.globalAlpha = prevA * 0.55;
                ctx.strokeText(g.char, 0, 0);
                ctx.globalAlpha = prevA;
            }
            if (invert) {
                const dimDark = 'rgba(12, 18, 30, 0.10)';
                const sungDark = g.emotionColor ? this._mixMemo(palette.darkInk, g.emotionColor, 0.38) : palette.darkInk;
                if (singFrac <= 0.01) {
                    ctx.fillStyle = dimDark;
                    ctx.fillText(g.char, 0, 0);
                } else if (singFrac >= 0.99) {
                    ctx.fillStyle = sungDark;
                    ctx.fillText(g.char, 0, 0);
                } else {
                    const f0 = Math.max(0, smoothSing - 0.32);
                    const f1 = Math.min(1, smoothSing + 0.26);
                    const sweep = ctx.createLinearGradient(-halfW, 0, halfW, 0);
                    sweep.addColorStop(0, sungDark);
                    sweep.addColorStop(f0, sungDark);
                    sweep.addColorStop(f1, dimDark);
                    sweep.addColorStop(1, dimDark);
                    ctx.fillStyle = sweep;
                    ctx.fillText(g.char, 0, 0);
                }
            } else {
                const sungLit = g.emotionColor
                    // afterglow 量化到 1/24 步进后走记忆化：逐帧逐字的 mixHex 字符串解析变成 Map 命中
                    || (afterglow > 0.02 ? this._mixMemo(palette.ink, palette.accent, Math.round(afterglow * 24) / 24 * 0.78) : palette.ink);
                if (singFrac <= 0.01) {
                    ctx.fillStyle = 'rgba(214, 228, 248, 0.07)';
                    ctx.fillText(g.char, 0, 0);
                } else if (singFrac >= 0.99) {
                    ctx.fillStyle = sungLit;
                    ctx.fillText(g.char, 0, 0);
                } else {
                    const f0 = Math.max(0, smoothSing - 0.30);
                    const crest = clamp01(smoothSing);
                    const f1 = Math.min(1, smoothSing + 0.28);
                    const sweep = ctx.createLinearGradient(-halfW, 0, halfW, 0);
                    sweep.addColorStop(0, sungLit);
                    sweep.addColorStop(f0, sungLit);
                    sweep.addColorStop(crest, '#ffffff');
                    sweep.addColorStop(f1, 'rgba(214, 228, 248, 0.07)');
                    sweep.addColorStop(1, 'rgba(214, 228, 248, 0.07)');
                    ctx.fillStyle = sweep;
                    ctx.fillText(g.char, 0, 0);
                }
            }
            ctx.restore();
        }
    }

    /**
     * 将预渲染文字底板通过 1 次 GPU drawImage 折射投射进当前切面（替代 6x 切面逐字 fillText）
     */
    _blitFacetPlate(ctx, layout, facet, fIdx, refractAmp, amb) {
        const plate = facet.invert ? this._curPlateDark : this._curPlateLight;
        const dr = layout.dirtyRect;
        if (!plate || !dr) return;

        const breath = Math.sin(amb * 0.0011 + (facet.phase || fIdx));
        const shiftX = facet.shiftX * refractAmp * (1 + breath * 0.08);
        const shiftY = facet.shiftY * refractAmp * (1 - breath * 0.08);
        const lensScale = 1 + (facet.lensDelta || 0) * this.opts.prismRefraction * 0.32;
        const dpr = this._dpr;
        const sx = dr.x * dpr;
        const sy = dr.y * dpr;
        const sw = dr.w * dpr;
        const sh = dr.h * dpr;

        ctx.save();
        if (Math.abs(lensScale - 1) > 0.001) {
            ctx.translate(layout.focusX, layout.focusY);
            ctx.scale(lensScale, lensScale);
            ctx.translate(-layout.focusX, -layout.focusY);
        }
        ctx.drawImage(plate, sx, sy, sw, sh, dr.x + shiftX, dr.y + shiftY, dr.w, dr.h);
        ctx.restore();
    }

    _drawGlyphsInFacet(ctx, shot, layout, geo, facet, fIdx, refractAmp, disp, timeMs, amb, w, h, palette, lowPerf) {
        const breath = Math.sin(amb * 0.0011 + (facet.phase || fIdx));
        const shiftX = facet.shiftX * refractAmp * (1 + breath * 0.08);
        const shiftY = facet.shiftY * refractAmp * (1 - breath * 0.08);
        const lensScale = 1 + (facet.lensDelta || 0) * this.opts.prismRefraction * 0.32;

        const bb = facet.bbox || { minX: -0.25 * geo.aspect, minY: -0.25, maxX: 1.25 * geo.aspect, maxY: 1.25 };
        const bx0 = (bb.minX / geo.aspect) * w - 36;
        const by0 = bb.minY * h - 36;
        const bx1 = (bb.maxX / geo.aspect) * w + 36;
        const by1 = bb.maxY * h + 36;

        ctx.save();
        if (Math.abs(lensScale - 1) > 0.001) {
            ctx.translate(layout.focusX, layout.focusY);
            ctx.scale(lensScale, lensScale);
            ctx.translate(-layout.focusX, -layout.focusY);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let curPx = -1;

        const fullReveal = !!this._posterFullReveal;
        for (let i = 0; i < layout.glyphs.length; i++) {
            const g = layout.glyphs[i];
            const gPx = g.fontPx || layout.fontPx;
            const enterDelay = shot.startTimeMs + i * 24;
            const enterT = fullReveal ? 1 : clamp01((timeMs - enterDelay) / 420);
            if (enterT <= 0.01) continue;
            const easeE = 1 - Math.pow(1 - enterT, 3);

            const span = Math.max(150, g.end - g.start);
            const singFrac = fullReveal ? 1 : clamp01((timeMs - (g.start - 40)) / (span + 40));
            const smoothSing = singFrac * singFrac * (3 - 2 * singFrac);
            const afterglow = fullReveal ? 0.72 : (timeMs <= g.end ? smoothSing : clamp01(1 - (timeMs - g.end) / 380));
            const liftEnv = smoothSing * (0.28 + 0.72 * afterglow);
            const isActive = singFrac > 0.01 && afterglow > 0.05;

            let ox = shiftX;
            let oy = shiftY;
            let scale = 1;
            let extraRot = 0;
            if (enterT < 1) {
                const inv = 1 - easeE;
                if (shot.enterStyle === 'shard-rise') oy += inv * gPx * 0.32;
                else if (shot.enterStyle === 'shear-lock') ox += (i % 2 === 0 ? -1 : 1) * inv * gPx * 0.26;
                else if (shot.enterStyle === 'spiral-focus') { scale = 1 + inv * 0.18; extraRot = inv * 0.10; }
                else { ox += inv * shiftX * 1.3; oy += inv * shiftY * 1.3; }
            }
            if (liftEnv > 0.005) {
                scale *= 1 + liftEnv * 0.042;
                oy -= liftEnv * gPx * 0.042;
            }

            const drawX = g.x + ox;
            const drawY = g.y + oy;
            // AABB 快速剔除：不在当前切面包围盒内的字直接跳过绘制
            if (drawX + g.w * 0.85 < bx0 || drawX - g.w * 0.85 > bx1 || drawY + gPx * 0.9 < by0 || drawY - gPx * 0.9 > by1) {
                continue;
            }

            if (gPx !== curPx) {
                curPx = gPx;
                ctx.font = `700 ${gPx}px ${layout.fontStack}`;
            }

            ctx.save();
            ctx.translate(drawX, drawY);
            if (g.rotRad || extraRot) ctx.rotate(g.rotRad + extraRot);
            if (scale !== 1) ctx.scale(scale, scale);
            ctx.globalAlpha *= easeE;

            // 在唱字符背光柔焦光晕（使用预烘焙精灵，丝滑无卡顿）
            if (!lowPerf && !facet.invert && afterglow > 0.08 && singFrac > 0.02) {
                const glowSpr = this._getGlowSprite(g.emotionColor || palette.accent);
                if (glowSpr) {
                    const gr = Math.max(g.w, gPx) * 0.95;
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha *= 0.26 * afterglow * Math.sin(Math.min(1, singFrac * 1.2) * Math.PI * 0.85 + 0.15);
                    ctx.drawImage(glowSpr, -gr, -gr, gr * 2, gr * 2);
                    ctx.restore();
                }
            }

            // 切面文字棱镜色散边缘（冰青与柔玫红微色差，清晰且富有光学质感）
            if (!lowPerf && !facet.invert && disp > 0.08 && (fIdx > 0 || isActive || enterT < 1)) {
                const fringe = (fIdx > 0 ? 1.25 : 0.40) + (enterT < 1 ? (1 - easeE) * 2.4 : 0) + afterglow * 0.85;
                const fx = (facet.shiftX || 0.65) * fringe * disp;
                const fy = (facet.shiftY || -0.45) * fringe * disp;
                ctx.save();
                ctx.globalAlpha *= singFrac > 0 ? (0.28 + afterglow * 0.18) : 0.22;
                ctx.fillStyle = palette.dispersion[0];
                ctx.fillText(g.char, -fx, -fy);
                ctx.fillStyle = palette.dispersion[2];
                ctx.fillText(g.char, fx, fy);
                ctx.restore();
            }

            const halfW = Math.max(gPx * 0.38, g.w * 0.64);
            if (facet.invert) {
                const dimDark = 'rgba(12, 18, 30, 0.36)';
                const sungDark = g.emotionColor ? this._mixMemo(palette.darkInk, g.emotionColor, 0.38) : palette.darkInk;
                if (singFrac <= 0.01) {
                    ctx.fillStyle = dimDark;
                    ctx.fillText(g.char, 0, 0);
                } else if (singFrac >= 0.99) {
                    ctx.fillStyle = sungDark;
                    ctx.fillText(g.char, 0, 0);
                } else {
                    const f0 = Math.max(0, smoothSing - 0.32);
                    const f1 = Math.min(1, smoothSing + 0.26);
                    const sweep = ctx.createLinearGradient(-halfW, 0, halfW, 0);
                    sweep.addColorStop(0, sungDark);
                    sweep.addColorStop(f0, sungDark);
                    sweep.addColorStop(f1, dimDark);
                    sweep.addColorStop(1, dimDark);
                    ctx.fillStyle = sweep;
                    ctx.fillText(g.char, 0, 0);
                }
            } else {
                const sungLit = g.emotionColor
                    // afterglow 量化到 1/24 步进后走记忆化：逐帧逐字的 mixHex 字符串解析变成 Map 命中
                    || (afterglow > 0.02 ? this._mixMemo(palette.ink, palette.accent, Math.round(afterglow * 24) / 24 * 0.78) : palette.ink);
                if (singFrac <= 0.01) {
                    ctx.fillStyle = palette.dimInk;
                    ctx.fillText(g.char, 0, 0);
                } else if (singFrac >= 0.99) {
                    ctx.fillStyle = sungLit;
                    ctx.fillText(g.char, 0, 0);
                } else {
                    // 柔焦羽化渐变扫光（无生硬矩形裁剪刀口，带冰晶高光前缘）
                    const f0 = Math.max(0, smoothSing - 0.30);
                    const crest = clamp01(smoothSing);
                    const f1 = Math.min(1, smoothSing + 0.28);
                    const sweep = ctx.createLinearGradient(-halfW, 0, halfW, 0);
                    sweep.addColorStop(0, sungLit);
                    sweep.addColorStop(f0, sungLit);
                    sweep.addColorStop(crest, '#ffffff');
                    sweep.addColorStop(f1, palette.dimInk);
                    sweep.addColorStop(1, palette.dimInk);
                    ctx.fillStyle = sweep;
                    ctx.fillText(g.char, 0, 0);
                }
            }
            ctx.restore();
        }
        ctx.restore();
    }

    _drawSpectralRayFan(ctx, geo, shotProgress, amb, w, h, palette) {
        if (!geo.rayApex) return;
        const ax = (geo.rayApex.x / geo.aspect) * w;
        const ay = geo.rayApex.y * h;
        const reach = Math.min(w, h) * 0.56;
        const sway = Math.sin(amb * 0.00048) * 0.045 + (shotProgress - 0.5) * 0.09;
        const baseAng = (geo.rayBaseAngle || 0) + sway;
        const disp = this.opts.prismDispersion;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';

        // 1. 窄束准直入射光针（Coherent Incident Beam）：细锐亮芯 + 极窄光晕直抵棱镜切点，而非肥大椭圆糊斑
        const incSpr = this._getGlowSprite('#e8f8ff');
        if (incSpr) {
            ctx.save();
            ctx.translate(ax, ay);
            ctx.rotate(baseAng + Math.PI);
            // 外层微弱准直光晕
            ctx.save();
            ctx.scale(2.8, 0.032);
            ctx.globalAlpha = 0.20;
            const incR = reach * 0.58;
            ctx.drawImage(incSpr, reach * 0.48 - incR, -incR, incR * 2, incR * 2);
            ctx.restore();
            // 中心 1.5px 激光束芯（越靠近切点越亮）
            ctx.save();
            ctx.scale(2.6, 0.009);
            ctx.globalAlpha = 0.46;
            ctx.drawImage(incSpr, reach * 0.42 - incR, -incR, incR * 2, incR * 2);
            ctx.restore();
            ctx.restore();
        }

        // 2. 真实物理阿贝色散楔形锥（Continuous Optical Caustic Wedge）：
        // 预烘焙 280x180 连续光谱发散纹理（每套色板仅生成 1 次，每帧 1 次 drawImage）：
        // 从棱镜顶点极窄的白炽焦点出发，按连续角度展开为无断层、无条纹的光学焦散扇面（暖珀红 → 珍珠白青 → 冰蓝钴紫），
        // 彻底取代原先 6 条分离的卡通彩虹条！
        const wedgeSpr = this._getSpectralWedgeSprite(palette);
        if (wedgeSpr) {
            const fanSpread = 0.52 + disp * 0.68;
            const wedgeLen = reach * 1.18;
            const wedgeHalfH = reach * 0.44 * fanSpread;
            ctx.save();
            ctx.translate(ax, ay);
            ctx.rotate(baseAng);
            ctx.globalAlpha = 0.42 + disp * 0.34;
            ctx.drawImage(wedgeSpr, -wedgeLen * 0.03, -wedgeHalfH, wedgeLen, wedgeHalfH * 2);
            ctx.restore();
        }

        // 3. 晶体全反射副光束（Total Internal Reflection Ghost Ray）+ 切点白炽折光焦点
        const tirSpr = this._getGlowSprite(palette.dispersion[2] || '#7ce8ff');
        if (tirSpr) {
            ctx.save();
            ctx.translate(ax, ay);
            ctx.rotate(baseAng - 0.58);
            ctx.scale(2.1, 0.014);
            ctx.globalAlpha = 0.22 * (0.5 + disp * 0.5);
            const tirR = reach * 0.46;
            ctx.drawImage(tirSpr, tirR * 0.85 - tirR, -tirR, tirR * 2, tirR * 2);
            ctx.restore();
        }
        if (incSpr) {
            const apexR = Math.max(18, reach * 0.085);
            ctx.globalAlpha = 0.48;
            ctx.drawImage(incSpr, ax - apexR, ay - apexR, apexR * 2, apexR * 2);
        }
        ctx.restore();
    }

    /**
     * 预烘焙连续光学色散楔形焦散图（280x180，按色板缓存，零每帧像素计算）：
     * 模拟牛顿棱镜/徕卡光学玻璃中的真实连续光谱色散：顶点白炽汇聚、双侧艾里焦散亮边（Airy Caustic Cusps）、
     * 中段连续波长平滑过渡（无任何条形码式分界）、远端指数衰减融入暗场。
     * @param {any} palette
     * @returns {HTMLCanvasElement|null}
     */
    _getSpectralWedgeSprite(palette) {
        if (typeof document === 'undefined') return null;
        const d0 = (palette && palette.dispersion && palette.dispersion[0]) || '#fda4af';
        const d1 = (palette && palette.dispersion && palette.dispersion[1]) || '#c4b5fd';
        const d2 = (palette && palette.dispersion && palette.dispersion[2]) || '#67e8f9';
        const key = `wedge:${d0}|${d1}|${d2}`;
        let spr = this._glowSpriteCache.get(key);
        if (spr) return spr;

        const W = 280;
        const H = 180;
        spr = document.createElement('canvas');
        spr.width = W;
        spr.height = H;
        const sctx = spr.getContext('2d');
        if (!sctx) return null;

        const img = sctx.createImageData(W, H);
        const data = img.data;
        const pWarm = parseHexRgb(d0, [253, 146, 162]);
        const pCyan = parseHexRgb(d2, [103, 232, 249]);
        const pViolet = parseHexRgb(d1, [168, 132, 252]);
        // 与真实光学色散波长锚点融合，避免 auto 默认色板三色同相时色散扇退化为单色白青
        const cWarm = [
            Math.round(pWarm[0] * 0.45 + 255 * 0.55),
            Math.round(pWarm[1] * 0.45 + 124 * 0.55),
            Math.round(pWarm[2] * 0.45 + 138 * 0.55)
        ];
        const cAmber = [255, 212, 142];
        const cCore = [232, 252, 248];
        const cCyan = [
            Math.round(pCyan[0] * 0.55 + 78 * 0.45),
            Math.round(pCyan[1] * 0.55 + 226 * 0.45),
            Math.round(pCyan[2] * 0.55 + 252 * 0.45)
        ];
        const cViolet = [
            Math.round(pViolet[0] * 0.45 + 152 * 0.55),
            Math.round(pViolet[1] * 0.45 + 118 * 0.55),
            Math.round(pViolet[2] * 0.45 + 255 * 0.55)
        ];
        const stops = [cWarm, cAmber, cCore, cCyan, cViolet];

        const halfH = H * 0.5;
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1);
            // 楔形半宽随距离线性展开：在顶点处仅 2.2px 宽，向远端张开成扇面
            const beamHalf = 2.2 + Math.pow(u, 0.9) * (halfH * 0.84);
            // 轴向能量包络：顶点快速起亮，向远端按幂次柔顺消隐，绝不触碰纹理右边界形成硬切
            const entry = 1 - Math.exp(-x * 0.24);
            const axial = entry * Math.pow(1 - u, 1.7);
            // 顶点附近色光尚未完全分离，保持高纯度钻石白炽核
            const whiteMix = Math.pow(Math.max(0, 1 - u * 4.5), 1.65) * 0.72;

            for (let y = 0; y < H; y++) {
                const dy = y - halfH;
                const v = dy / beamHalf; // 归一化角度坐标 [-1..+1]
                const av = Math.abs(v);
                if (av > 1.45) continue;

                // 连续高斯包络 + 艾里焦散边缘微增亮（真实棱镜扇面两侧边界光子密度略高于内部）
                const body = Math.exp(-Math.pow(Math.max(0, av - 0.72) * 3.1, 2));
                const causticCusp = 1 + 0.34 * Math.exp(-Math.pow((av - 0.68) * 4.2, 2));
                const spine = Math.exp(-v * v * 7.5) * Math.pow(1 - u, 1.4) * 0.45;
                const intensity = clamp01((body * causticCusp * 0.68 + spine) * axial);
                if (intensity <= 0.003) continue;

                // 连续波长插值（5 段平滑混色，无分立色带）
                const s = clamp01((v + 0.88) / 1.76) * (stops.length - 1);
                const idx = Math.min(stops.length - 2, Math.floor(s));
                const frac = s - idx;
                const smoothF = frac * frac * (3 - 2 * frac);
                const cA = stops[idx];
                const cB = stops[idx + 1];

                const r = cA[0] + (cB[0] - cA[0]) * smoothF;
                const g = cA[1] + (cB[1] - cA[1]) * smoothF;
                const b = cA[2] + (cB[2] - cA[2]) * smoothF;

                const p = (y * W + x) * 4;
                data[p] = Math.min(255, Math.round(r + (255 - r) * whiteMix));
                data[p + 1] = Math.min(255, Math.round(g + (255 - g) * whiteMix));
                data[p + 2] = Math.min(255, Math.round(b + (255 - b) * whiteMix));
                data[p + 3] = Math.min(255, Math.round(intensity * 235));
            }
        }
        sctx.putImageData(img, 0, 0);
        this._glowSpriteCache.set(key, spr);
        return spr;
    }

    _drawCrystalDust(ctx, geo, layout, timeMs, amb, w, h, palette) {
        const motes = geo.dustMotes;
        if (!Array.isArray(motes) || motes.length === 0) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < motes.length; i++) {
            const m = motes[i];
            const driftX = Math.sin(amb * 0.00036 * m.depth + m.phase) * w * 0.022 * m.depth;
            const driftY = Math.cos(amb * 0.00030 * m.depth + m.phase * 1.3) * h * 0.022 * m.depth;
            const mx = (m.x / geo.aspect) * w + driftX;
            const my = m.y * h + driftY;
            const twinkle = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(amb * 0.0016 + m.phase));
            const r = m.r * (1.2 + twinkle * 0.6) * 2.2;
            const c = palette.dispersion[m.hueIdx % 3] || palette.accent;
            const spr = this._getGlowSprite(c);
            ctx.globalAlpha = 0.26 * twinkle;
            if (spr) {
                ctx.drawImage(spr, mx - r, my - r, r * 2, r * 2);
            } else {
                ctx.fillStyle = c;
                ctx.beginPath();
                ctx.arc(mx, my, r * 0.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // （已移除逐字触发的椭圆涟漪环：多字同时在 520ms 窗口内时叠成一圈圈「声呐」同心椭圆，
        //   与切面硬边语言冲突；当前字的强调交给焦散光斑）
        ctx.restore();
    }

    _drawCaustics(ctx, shot, layout, timeMs, amb, w, _h, palette) {
        if (!layout.glyphs || layout.glyphs.length === 0) return;
        let activeGlyph = null;
        let singFrac = 0.5;
        for (let i = 0; i < layout.glyphs.length; i++) {
            const g = layout.glyphs[i];
            if (timeMs >= g.start && timeMs <= g.end + 140) {
                activeGlyph = g;
                singFrac = clamp01((timeMs - g.start) / Math.max(80, g.end - g.start));
                break;
            }
        }

        const strength = this.opts.prismCaustics;
        if (this._causticShotIdx !== shot.index) {
            this._causticShotIdx = shot.index;
            const firstG = activeGlyph || layout.glyphs[0];
            this._causticX = firstG.x;
            this._causticY = firstG.y;
            this._causticAlpha = activeGlyph ? 0.6 : 0;
        }

        // 帧率无关的指数平滑：0.16/帧@60Hz 换算成按真实 dt 的系数，144Hz 屏不再跟得更快更飘
        const cdt = this._causticLastAmb > 0 ? Math.max(0, Math.min(100, amb - this._causticLastAmb)) : 16.67;
        this._causticLastAmb = amb;
        const kFollow = 1 - Math.pow(1 - 0.16, cdt / 16.67);
        if (activeGlyph) {
            const targetX = activeGlyph.x + (singFrac - 0.5) * activeGlyph.w * 0.72;
            const targetY = activeGlyph.y;
            this._causticX += (targetX - this._causticX) * kFollow;
            this._causticY += (targetY - this._causticY) * kFollow;
            this._causticAlpha += (1 - this._causticAlpha) * kFollow;
        } else {
            this._causticAlpha *= Math.pow(0.90, cdt / 16.67);
        }

        if (this._causticAlpha <= 0.02) return;

        const leadX = this._causticX;
        const leadY = this._causticY;
        const fade = this._causticAlpha * strength;
        const r = Math.max(44, layout.fontPx * 1.65);
        const tint = (activeGlyph && activeGlyph.emotionColor) || palette.accent;
        const tintSpr = this._getGlowSprite(tint);

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        if (tintSpr) {
            ctx.globalAlpha = 0.34 * fade;
            ctx.drawImage(tintSpr, leadX - r, leadY - r, r * 2, r * 2);
        }

        // 双向椭圆羽化变形宽银幕衍射光束（复用预烘焙精灵，上下左右全羽化无硬边且零 GC 开销）
        const streakR = Math.min(w * 0.34, layout.fontPx * 4.6);
        const angles = [-0.34, 0.48];
        for (let aIdx = 0; aIdx < angles.length; aIdx++) {
            const scaleY = aIdx === 0 ? 0.065 : 0.045;
            const sAlpha = (aIdx === 0 ? 0.38 : 0.22) * fade;
            const edgeCol = aIdx === 0 ? palette.dispersion[2] : palette.dispersion[0];
            const streakSpr = this._getGlowSprite(edgeCol);
            ctx.save();
            ctx.translate(leadX, leadY);
            ctx.rotate(angles[aIdx] + Math.sin(amb * 0.0005) * 0.04);
            ctx.scale(1, scaleY);
            ctx.globalAlpha = sAlpha;
            if (streakSpr) {
                ctx.drawImage(streakSpr, -streakR, -streakR, streakR * 2, streakR * 2);
            }
            ctx.restore();
        }

        // 十字光学微星芒焦点
        const flareLen = Math.max(13, layout.fontPx * 0.46) * (0.88 + 0.12 * Math.sin(amb * 0.004));
        const flareW = Math.max(1.2, flareLen * 0.08);
        ctx.globalAlpha = 0.54 * fade;
        ctx.translate(leadX, leadY - layout.fontPx * 0.14);
        ctx.rotate(amb * 0.0006);
        ctx.fillStyle = 'rgba(245, 252, 255, 0.95)';
        for (let arm = 0; arm < 2; arm++) {
            ctx.beginPath();
            ctx.moveTo(0, -flareLen);
            ctx.lineTo(flareW, 0);
            ctx.lineTo(0, flareLen);
            ctx.lineTo(-flareW, 0);
            ctx.closePath();
            ctx.fill();
            ctx.rotate(Math.PI * 0.5);
        }
        ctx.restore();
    }

    _drawSubtitles(ctx, shot, layout, w, h, _palette) {
        if (w < 360) return;
        const srcLine = (this.lines && typeof shot.lineIndex === 'number' && this.lines[shot.lineIndex]) || null;
        const rawTr = shot.translation || (srcLine && (srcLine.translation || srcLine.trans)) || '';
        const rawRo = shot.romaji || (srcLine && (srcLine.romaji || srcLine.roma)) || '';
        const lyCfg = (typeof globalThis !== 'undefined' && globalThis.appSettings && globalThis.appSettings.lyrics) || null;
        const showTr = lyCfg && typeof lyCfg.showTranslation === 'boolean' ? lyCfg.showTranslation : this.opts.showTranslation;
        const showRo = lyCfg && typeof lyCfg.showRomaji === 'boolean' ? lyCfg.showRomaji : this.opts.showRomaji;

        const tr = (showTr && rawTr && String(rawTr).trim() !== '//') ? String(rawTr).trim() : '';
        const ro = (showRo && rawRo && String(rawRo).trim() !== '//' && String(rawRo).trim() !== tr)
            ? String(rawRo).trim()
            : '';

        // 主播放器优先同步飞入模式同款原生 DOM 悬浮字幕区 (#flyinTranslationArea，位于底部播放栏上方 bottom: 140px)
        if (!this._isPreviewStage() && typeof document !== 'undefined') {
            const flyinArea = document.getElementById('flyinTranslationArea');
            if (flyinArea) {
                const subKey = `${tr}||${ro}`;
                if (this._lastDomSubKey !== subKey) {
                    this._lastDomSubKey = subKey;
                    const flyinTrans = document.getElementById('flyinTranslation');
                    const flyinRoma = document.getElementById('flyinRomaji');
                    if (flyinTrans) flyinTrans.textContent = tr;
                    if (flyinRoma) flyinRoma.textContent = ro;
                    flyinArea.style.opacity = (tr || ro) ? '1' : '0';
                }
                return;
            }
        }

        if (!tr && !ro) return;

        // 兜底 Canvas 绘制（位于底部播放控件栏 135px 高度正上方，绝不被控件栏遮挡）
        const centerX = w * 0.5;
        let baseY = h - (tr && ro ? 168 : 148);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';

        if (tr) {
            ctx.font = `500 15px ${layout.fontStack}`;
            ctx.lineWidth = 3.2;
            ctx.strokeStyle = 'rgba(4, 7, 14, 0.78)';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            ctx.strokeText(tr, centerX, baseY);
            ctx.fillText(tr, centerX, baseY);
            baseY += 22;
        }
        if (ro) {
            ctx.font = `500 13px ${layout.fontStack}`;
            ctx.lineWidth = 2.8;
            ctx.strokeStyle = 'rgba(4, 7, 14, 0.75)';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.strokeText(ro, centerX, baseY);
            ctx.fillText(ro, centerX, baseY);
        }
        ctx.restore();
    }

    _renderVignetteAndHud(ctx, shot, shotProgress, _timeMs, w, h, palette) {
        // 镜头暗角（离屏 256px 烘焙一次、按宽高比重建，每帧 1 次 drawImage）：压暗边角让光束/焦散的对比更强
        if (typeof document !== 'undefined') {
            const vKey = Math.round((w / Math.max(1, h)) * 50);
            if (this._vignetteKey !== vKey) {
                const vc = document.createElement('canvas');
                vc.width = 256;
                vc.height = Math.max(64, Math.round(256 * h / Math.max(1, w)));
                const vx = vc.getContext('2d');
                if (vx) {
                    const rg = vx.createRadialGradient(
                        vc.width * 0.5, vc.height * 0.46, Math.min(vc.width, vc.height) * 0.3,
                        vc.width * 0.5, vc.height * 0.5, Math.hypot(vc.width, vc.height) * 0.56,
                    );
                    rg.addColorStop(0, 'rgba(0,0,0,0)');
                    rg.addColorStop(0.7, 'rgba(1,3,8,0.22)');
                    rg.addColorStop(1, 'rgba(1,3,8,0.55)');
                    vx.fillStyle = rg;
                    vx.fillRect(0, 0, vc.width, vc.height);
                }
                this._vignetteCanvas = vc;
                this._vignetteKey = vKey;
            }
            if (this._vignetteCanvas) ctx.drawImage(this._vignetteCanvas, 0, 0, w, h);
        }
        if (!this.opts.prismHud || w < 380) return;
        const padX = Math.max(22, w * 0.038);
        const padY = Math.max(22, h * 0.055);
        const len = 14;

        ctx.save();
        ctx.strokeStyle = 'rgba(226, 240, 255, 0.28)';
        ctx.lineWidth = 1;
        // 左上与左下光学取景角标
        ctx.beginPath();
        ctx.moveTo(padX, padY + len); ctx.lineTo(padX, padY); ctx.lineTo(padX + len, padY);
        ctx.moveTo(padX, h - padY - len); ctx.lineTo(padX, h - padY); ctx.lineTo(padX + len, h - padY);
        ctx.stroke();

        ctx.font = "500 11px 'JetBrains Mono', Consolas, monospace";
        ctx.fillStyle = 'rgba(226, 240, 255, 0.46)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(shot.hudCode || 'PRM // OPTICS', padX + 8, padY + 6);

        // 镜头内折射刻度条
        const barW = 72;
        const barY = padY + 24;
        ctx.fillStyle = 'rgba(226, 240, 255, 0.16)';
        ctx.fillRect(padX + 8, barY, barW, 2);
        ctx.fillStyle = palette.accent;
        ctx.fillRect(padX + 8, barY, barW * clamp01(shotProgress), 2);
        ctx.restore();
    }
}
