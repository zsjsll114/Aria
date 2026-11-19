/**
 * web/src/core/visualizers/AstrolabeVisualizer.js
 * 「画册 · Folio」（mode: astrolabe）—— 瑞士国际主义平面构成 · 54 镜巨幅破框正负形反色引擎
 *
 * 核心特性：
 * 1. 零 AI 廉价发光味：100% 不透明实色纸张块面（Opaque Flat Masses）+ 版画平行排线 + 硬墨接缝；
 * 2. 8 种瑞士海报级排版拓扑（swiss-editorial / staircase-cascade / celestial-chord / fulcrum-pivot /
 *    antiphony-split / vertical-manuscript / orbital-stagger / monolith-banner），视口宽度等比例无上限放大；
 * 3. 轴对齐双底板单次文字预渲染（_plateLight + _plateDark），切面内仅 1 次 GPU drawImage 实现日食级正负形一刀切反色；
 * 4. 连续线性时钟外推 + 提前 25% 预热下一镜，60/120/144fps 全屏切镜零掉帧。
 */

import { VisualizerBase } from './VisualizerBase.js';
import {
    ASTROLABE_PALETTES,
    ASTROLABE_TYPO_CONFIG,
    ASTROLABE_MOTION_TUNING,
    easeAstrolabeEnter,
    easeAstrolabeInOut,
    astrolabeCreep,
    astrolabeChapterIndex,
} from './astrolabe/astrolabeProfiles.js';
import {
    buildAstrolabeShotGeometry,
    astrolabeHash01,
} from './astrolabe/astrolabeCompositions.js';
import {
    compileAstrolabeProgram,
    findActiveAstrolabeShot,
} from './astrolabe/astrolabeProgram.js';
import { ensureEmotionContrast } from '../../utils/colorUtils.js';
import { logCatch, logInfo } from '../../services/log.js';

const BUILTIN_FONT_MAP = {
    default: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    serif: "Georgia, 'Times New Roman', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif",
    kai: "Georgia, 'Times New Roman', 'Kaiti SC', 'STKaiti', 'KaiTi', '楷体', serif",
    hei: "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', 'SimHei', sans-serif",
    fangsong: "Georgia, 'Times New Roman', 'STFangsong', 'FangSong', '仿宋', serif",
    mono: "'JetBrains Mono', 'Consolas', 'Courier New', 'Microsoft YaHei', monospace",
};

/**
 * 解析 Astrolabe 当前字体栈（全面兼容模式独立字体、全局字体设置、内置 5 类字体与用户导入自定义字体）
 */
export function resolveAstrolabeFont(ff) {
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
            return BUILTIN_FONT_MAP.default;
        } else {
            return BUILTIN_FONT_MAP.default;
        }
    }
    if (BUILTIN_FONT_MAP[key]) {
        return BUILTIN_FONT_MAP[key];
    }
    if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
        try {
            const resolved = window.resolveFontFamily(key);
            if (resolved) return resolved;
        } catch {
            // fallback below
        }
    }
    if (String(key).includes(',') || String(key).includes("'")) {
        return String(key);
    }
    return `'${key}', 'Noto Sans SC', 'Microsoft YaHei', sans-serif`;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
}

function parseHexRgb(hex = '#d94e34') {
    const s = String(hex || '').trim().replace(/^#/, '');
    if (s.length === 3) {
        return {
            r: parseInt(s[0] + s[0], 16) || 0,
            g: parseInt(s[1] + s[1], 16) || 0,
            b: parseInt(s[2] + s[2], 16) || 0,
        };
    }
    const n = parseInt(s.slice(0, 6), 16);
    if (Number.isNaN(n)) return { r: 217, g: 78, b: 52 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

function mixHex(hexA, hexB, t = 0.5) {
    const a = parseHexRgb(hexA);
    const b = parseHexRgb(hexB);
    const k = clamp01(t);
    return rgbToHex(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

const HEX6_RE = /^#[0-9a-f]{6}$/i;

/**
 * 归一化 AI 返回的颜色值：只接受合法的 #hex / rgb() / hsl()，并将 #rgb 展开为 #rrggbb 以便后续对比度校准
 */
function normalizeEmotionColor(color) {
    if (typeof color !== 'string') return null;
    const c = color.trim();
    if (HEX6_RE.test(c) || /^#[0-9a-f]{8}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    if (/^rgba?\(/i.test(c) || /^hsla?\(/i.test(c)) return c;
    return null;
}

/**
 * 读取情感词表（与 PV / Letterpress / Dimension 共用全局 aiEmotionWords 契约）
 * ★ 此前读的是 globalThis.currentSongEmotionData —— 全库无人写入该变量，
 *   导致星轨的情感词永远拿不到颜色（本模式成了唯一不上色的全景模式）。
 * 兼容形态：[{ word, color, line }] / ['温柔', ...] / { word: color }
 */
const DEFAULT_EMOTION_FALLBACK_COLOR = '#e6a832';
const HAS_CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_BOUNDARY_CHAR_RE = /^(?!.*[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])[\p{L}\p{N}]$/u;

function hasRawEmotionItems(raw) {
    if (!raw || typeof raw !== 'object') return false;
    return Array.isArray(raw) ? raw.length > 0 : Object.keys(raw).length > 0;
}

function resolveItemEmotionColor(color) {
    if (color === null || color === undefined) return DEFAULT_EMOTION_FALLBACK_COLOR;
    if (typeof color === 'string' && color.trim() === '') return DEFAULT_EMOTION_FALLBACK_COLOR;
    return normalizeEmotionColor(color);
}

function astrolabeEmotionEntries(aiData = null) {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;

    // 尊重「AI 情感词高亮」总开关（与 000-tooltip 写入口径一致）
    if (g && g.appSettings && g.appSettings.lyrics && g.appSettings.lyrics.emotionWords === false) return [];

    // 切歌时 175-track-index-online 会将 aiEmotionWords 重置为 [] 而未清空 currentAiTheme，防止误把上一首的 currentAiTheme 当作当前歌的情感词
    const aiWordsCleared = Boolean(g && Array.isArray(g.aiEmotionWords) && g.aiEmotionWords.length === 0);
    const aiDataRaw = (
        aiData
        && typeof aiData === 'object'
        && !(g && g.currentAiTheme && g.currentAiTheme === aiData && aiWordsCleared)
    )
        ? (hasRawEmotionItems(aiData.emotion_words)
            ? aiData.emotion_words
            : (hasRawEmotionItems(aiData.keywords) ? aiData.keywords : null))
        : null;

    const raw = (g && hasRawEmotionItems(g.aiEmotionWords) && g.aiEmotionWords)
        || aiDataRaw
        || (!aiWordsCleared && g && g.currentAiTheme && hasRawEmotionItems(g.currentAiTheme.emotion_words) && g.currentAiTheme.emotion_words)
        || (g && g.currentSongEmotionData && hasRawEmotionItems(g.currentSongEmotionData.emotion_words) && g.currentSongEmotionData.emotion_words)
        || (g && g.currentSongEmotionData && hasRawEmotionItems(g.currentSongEmotionData.keywords) && g.currentSongEmotionData.keywords)
        || null;
    if (!raw || typeof raw !== 'object') return [];

    const out = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item === 'string') {
                const w = item.trim();
                if (w) out.push({ word: w, color: DEFAULT_EMOTION_FALLBACK_COLOR, line: null });
                continue;
            }
            if (!item || typeof item !== 'object') continue;
            const word = String(item.word || item.text || '').trim();
            if (!word) continue;
            out.push({
                word,
                color: resolveItemEmotionColor(item.color),
                line: Number.isInteger(item.line) ? item.line : null,
            });
        }
    } else {
        for (const [word, color] of Object.entries(raw)) {
            if (!word) continue;
            out.push({ word: String(word), color: resolveItemEmotionColor(color), line: null });
        }
    }
    return out;
}

/**
 * 情感词表指纹：AI 分析是异步回来的，词表或颜色变化时排版缓存必须失效重算
 */
export function astrolabeEmotionStamp(aiData = null) {
    const entries = astrolabeEmotionEntries(aiData);
    if (entries.length === 0) return '0';
    return `${entries.length}|${entries.map(e => `${e.word}:${e.color || ''}`).join(',')}`;
}

/**
 * 为每个字形匹配 AI 情感词颜色（按字形序列扫描，保证下标与 graphemes 严格对齐）
 * ★ 此前用 text.indexOf 定位，遇到 trim/空白差异就会整体错位；改为逐字形比对。
 * 注：Prompt 与去重契约约定同一个词只下发首次出现行，着色必须覆盖全文所有匹配行（忽略 entry.line 过滤）。
 * 对含拉丁/数字的非 CJK 词条强制词边界，并支持去除撇号/连字符的规范化匹配（如 dont 命中 Don't）。
 * @param {string} _text 分镜文本（保留参数用于兼容，匹配以 graphemes 为准）
 * @param {Array<{char:string}>} graphemes
 * @param {number} [_lineIndex] 保留参数用于调用方兼容
 * @param {object|null} [aiData]
 */
export function emotionColorsForGraphemes(_text = '', graphemes = [], _lineIndex = -1, aiData = null) {
    const out = new Array(graphemes.length).fill(null);
    if (!Array.isArray(graphemes) || graphemes.length === 0) return out;
    const entries = astrolabeEmotionEntries(aiData);
    if (entries.length === 0) return out;

    const lower = graphemes.map(g => String((g && g.char) || '').toLowerCase());
    // 剔除撇号与连字符后的字符流，保留原始 grapheme 索引以便完整回填撇号字符
    const stripped = [];
    for (let i = 0; i < lower.length; i++) {
        const ch = lower[i];
        if (ch === "'" || ch === '\u2019' || ch === '-') continue;
        stripped.push({ ch, origIdx: i });
    }

    const sorted = entries
        .filter(e => Boolean(e.color))
        .slice()
        .sort((a, b) => Array.from(b.word).length - Array.from(a.word).length);

    for (const entry of sorted) {
        const color = entry.color;
        const hasCjk = HAS_CJK_RE.test(entry.word);
        if (hasCjk) {
            const kw = Array.from(entry.word).map(c => c.toLowerCase());
            if (kw.length === 0 || kw.length > lower.length) continue;
            const needLeftBoundary = !HAS_CJK_RE.test(kw[0]) && LATIN_BOUNDARY_CHAR_RE.test(kw[0]);
            const needRightBoundary = !HAS_CJK_RE.test(kw[kw.length - 1]) && LATIN_BOUNDARY_CHAR_RE.test(kw[kw.length - 1]);
            for (let i = 0; i + kw.length <= lower.length; i++) {
                let hit = true;
                for (let k = 0; k < kw.length; k++) {
                    if (lower[i + k] !== kw[k]) { hit = false; break; }
                }
                if (!hit) continue;
                if (needLeftBoundary && i > 0 && LATIN_BOUNDARY_CHAR_RE.test(lower[i - 1])) continue;
                if (needRightBoundary && i + kw.length < lower.length && LATIN_BOUNDARY_CHAR_RE.test(lower[i + kw.length])) continue;
                for (let k = 0; k < kw.length; k++) {
                    if (!out[i + k]) out[i + k] = color;
                }
            }
            continue;
        }

        const kwNorm = Array.from(entry.word.toLowerCase()).filter(c => c !== "'" && c !== '\u2019' && c !== '-');
        if (kwNorm.length === 0 || kwNorm.length > stripped.length) continue;
        const needLeftBoundary = LATIN_BOUNDARY_CHAR_RE.test(kwNorm[0]);
        const needRightBoundary = LATIN_BOUNDARY_CHAR_RE.test(kwNorm[kwNorm.length - 1]);
        for (let i = 0; i + kwNorm.length <= stripped.length; i++) {
            let hit = true;
            for (let k = 0; k < kwNorm.length; k++) {
                if (stripped[i + k].ch !== kwNorm[k]) { hit = false; break; }
            }
            if (!hit) continue;
            const origStart = stripped[i].origIdx;
            const origEnd = stripped[i + kwNorm.length - 1].origIdx;
            if (needLeftBoundary && origStart > 0 && LATIN_BOUNDARY_CHAR_RE.test(lower[origStart - 1])) continue;
            if (needRightBoundary && origEnd + 1 < lower.length && LATIN_BOUNDARY_CHAR_RE.test(lower[origEnd + 1])) continue;
            for (let p = origStart; p <= origEnd; p++) {
                if (!out[p]) out[p] = color;
            }
        }
    }
    return out;
}

/**
 * 反色（亮羊皮纸）底上的情感色需要压深，否则浅色字落在米白纸上几乎不可见
 */
function plateEmotionColor(color, invert, palette) {
    if (!color) return null;
    /* 字素实际底色：反色块坐在 paper 上，普通块坐在舞台 bg 上（两种极性都自洽）。
       保色相调亮度到 ≥4.5:1，替换原先只对 invert 档盲混 26% 的做法（亮纸/重彩底撞色根因）。 */
    const bg = invert ? palette.paper : palette.bg;
    return ensureEmotionContrast(color, bg);
}

function hexToRgba(hex, alpha = 1) {
    const { r, g, b } = parseHexRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/**
 * 印刷成品四档参数（纸张颗粒 / 暗角 / 残影水印）
 * - clean     干净：几乎纯平色块，只留极轻纸感
 * - balanced  默认：印刷品，但有呼吸感（≈此前的 22/30 颗粒 + 0.42 暗角）
 * - vintage   复古：颗粒更重、暗角更暖、残影更明显
 * - punch     冲击：暗角更紧更重，视线向中心收
 * ★ 此前纸纹压在所有图层之上（含文字与反色块内的暗墨字），等于在油墨上撒盐；
 *   现在纸纹改用 multiply 合成（白点失效、只压暗），并把暗角换成暖墨色，白底页不再发灰。
 */
export const ASTROLABE_PRINT_LEVELS = Object.freeze({
    clean: { grainMax: 14, paperGrainMul: 0.70, vignette: 0.26, vignettePaperMul: 0.70, watermark: 0.05, tile: 256, innerRatio: 0.30 },
    balanced: { grainMax: 30, paperGrainMul: 0.75, vignette: 0.42, vignettePaperMul: 0.66, watermark: 0.06, tile: 256, innerRatio: 0.28 },
    vintage: { grainMax: 34, paperGrainMul: 1.00, vignette: 0.40, vignettePaperMul: 0.70, watermark: 0.07, tile: 256, innerRatio: 0.30 },
    punch: { grainMax: 30, paperGrainMul: 0.60, vignette: 0.55, vignettePaperMul: 0.58, watermark: 0.10, tile: 256, innerRatio: 0.42 },
});

export function resolveAstrolabePrintParams(level = 'balanced') {
    return ASTROLABE_PRINT_LEVELS[level] || ASTROLABE_PRINT_LEVELS.balanced;
}

export class AstrolabeVisualizer extends VisualizerBase {
    constructor() {
        super();
        this.opts = {
            fontSize: 1.0,
            highlightColor: '#f5efe4',
            themeColor: '#d94e34',
            fontFamily: 'default',
            showTranslation: true,
            showRomaji: true,
            astrolabePreset: 'auto',
            astrolabeCutRate: 'phrase',
            astrolabeInversion: true,
            astrolabeHatch: 0.75,
            astrolabeContrast: 0.80,
            astrolabeCamera: 0.85,
            astrolabeCropMarks: true,
            astrolabeGrain: true,
            astrolabePrintLevel: 'balanced',
        };
        this._stageEl = null;
        this._canvas = null;
        this._ctx = null;
        this._plateLight = null;
        this._plateLightCtx = null;
        this._plateDark = null;
        this._plateDarkCtx = null;
        this._subWrap = null;
        this._subRomajiEl = null;
        this._subTransEl = null;
        this._lastDomSubKey = '';
        this._dpr = 1;
        this._program = null;
        this._programKey = '';
        this._programDirty = true;
        this._lastLinesRef = null;
        this._lastSongRef = '';
        this._geoCache = new Map();
        this._layoutCache = new Map();
        this._vignetteCache = new Map();
        this._grainCache = new Map();
        this._printParams = resolveAstrolabePrintParams('balanced');
        this._printDegraded = '';
        this._printCostSum = 0;
        this._printCostN = 0;
        this._hatchPatternCache = new Map();
        this._coverPalette = null;
        this._lastCoverUrl = '';
        this._smoothMediaMs = 0;
        this._lastRawMediaMs = 0;
        this._lastRawPerf = 0;
        this._lastFramePerf = 0;
        this._lastSyncTimeMs = 0;
        this._raf = 0;
        this._destroyed = false;
        this._ro = null;
    }

    getModeId() { return 'astrolabe'; }

    onInit() {
        const stage = this.viewContainer;
        if (!stage || typeof document === 'undefined') return;
        stage.classList.add('vis-astrolabe-stage');
        stage.innerHTML = '';

        const canvas = document.createElement('canvas');
        canvas.className = 'vis-astrolabe-canvas';
        stage.appendChild(canvas);

        const subWrap = document.createElement('div');
        subWrap.className = 'vis-astrolabe-subtitles';
        const romaEl = document.createElement('div');
        romaEl.className = 'vis-astrolabe-sub-romaji';
        const transEl = document.createElement('div');
        transEl.className = 'vis-astrolabe-sub-trans';
        subWrap.appendChild(romaEl);
        subWrap.appendChild(transEl);
        stage.appendChild(subWrap);

        this._stageEl = stage;
        this._canvas = canvas;
        this._ctx = canvas.getContext('2d', { alpha: false });
        this._plateLight = document.createElement('canvas');
        this._plateLightCtx = this._plateLight.getContext('2d');
        this._plateDark = document.createElement('canvas');
        this._plateDarkCtx = this._plateDark.getContext('2d');
        this._subWrap = subWrap;
        this._subRomajiEl = romaEl;
        this._subTransEl = transEl;
        this._lastDomSubKey = '';

        if (typeof ResizeObserver !== 'undefined') {
            if (this._ro) this._ro.disconnect();
            this._ro = new ResizeObserver(() => this.handleResize());
            this._ro.observe(stage);
        }
        this._extractCoverPalette();
        this._ensureProgram();
    }

    onResize(width, height) {
        if (!this._canvas) return;
        const w = Math.max(320, Math.round(width || (typeof window !== 'undefined' ? window.innerWidth : 1280) || 1280));
        const h = Math.max(240, Math.round(height || (typeof window !== 'undefined' ? window.innerHeight : 720) || 720));
        const lowPerf = this._isLowPerf ? this._isLowPerf() : false;
        this._dpr = lowPerf ? 1 : Math.min(1.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const cw = Math.round(w * this._dpr);
        const ch = Math.round(h * this._dpr);
        if (this._canvas.width !== cw || this._canvas.height !== ch) {
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
            this._geoCache.clear();
            this._layoutCache.clear();
            // 分辨率变了要重新采样合成成本，取消之前的降级结论
            this._printDegraded = '';
            this._printCostSum = 0;
            this._printCostN = 0;
        }
        this._renderFrame(this._extrapolatedTimeMs());
    }

    onLyricsLoaded() {
        this._programDirty = true;
        this._programKey = '';
        this._geoCache.clear();
        this._layoutCache.clear();
        this._lastDomSubKey = '';
        this._extractCoverPalette();
        this._ensureProgram();
        this._renderFrame(this._extrapolatedTimeMs());
    }

    onApplySettings(settings = {}) {
        const s = settings || {};
        const prevCut = this.opts.astrolabeCutRate;
        const prevFont = this.opts.fontFamily;
        const prevScale = this.opts.fontSize;
        Object.assign(this.opts, s);
        if (this.opts.astrolabeCutRate !== prevCut) {
            this._programDirty = true;
            this._programKey = '';
            this._geoCache.clear();
            this._layoutCache.clear();
        }
        if (this.opts.fontFamily !== prevFont || this.opts.fontSize !== prevScale) {
            this._layoutCache.clear();
        }
        this._lastDomSubKey = '';
        if (this._canvas && this._ctx) {
            this._renderFrame(this._extrapolatedTimeMs());
        }
    }

    start() {
        if (this.isRunning) return;
        super.start();
        this._lastFramePerf = 0;
        this._lastRawPerf = 0;
        const loop = (now) => {
            if (!this.isRunning || this._destroyed) return;
            const tMs = this._extrapolatedTimeMs();
            this._renderFrame(tMs, now);
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

    destroy() {
        this._destroyed = true;
        this.stop();
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        this._canvas = null;
        this._ctx = null;
        this._plateLight = null;
        this._plateLightCtx = null;
        this._plateDark = null;
        this._plateDarkCtx = null;
        this._geoCache.clear();
        this._layoutCache.clear();
        this._hatchPatternCache.clear();
        this._vignetteCache.clear();
        this._grainCache.clear();
        super.destroy();
    }

    update(currentTimeSec = 0) {
        const timeMs = Math.max(0, (Number(currentTimeSec) || 0) * 1000);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const deltaMedia = timeMs - this._lastSyncTimeMs;
        this._lastSyncTimeMs = timeMs;
        if (Math.abs(deltaMedia) >= 650) {
            this._smoothMediaMs = timeMs;
            this._lastRawMediaMs = timeMs;
            this._lastRawPerf = now;
            this._lastFramePerf = now;
        }
        if (!this.isRunning) {
            this._renderFrame(timeMs, now);
        }
    }

    /**
     * 海报抓帧前将画册(astrolabe)推进到当前/目标行完全显现的保持时刻，避免只亮头两个字。
     * @param {number} [targetLineIndex]
     * @returns {(() => void)|null}
     */
    stageForPoster(targetLineIndex) {
        if (!this._ctx || !this._canvas || !Array.isArray(this.lines) || !this.lines.length) return null;
        this._ensureProgram();
        const wasRunning = !!this.isRunning;
        if (wasRunning && typeof this.stop === 'function') this.stop();
        const prevSync = this._lastSyncTimeMs;
        const prevSmooth = this._smoothMediaMs;
        const isMs = this.lines.some((l) => l && typeof l.start === 'number' && l.start >= 1000);
        const mult = isMs ? 1 : 1000;
        const fallbackIdx = Math.max(0, Math.min(this.lines.length - 1, Number(globalThis.activeLineIndex) || 0));
        const idx = (Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && targetLineIndex < this.lines.length)
            ? targetLineIndex
            : fallbackIdx;
        const line = this.lines[idx];
        let peakMs = prevSync;
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
                    lineGraphemes: mergedGraphemes,
                    lineGraphemeOffset: 0,
                    startTimeMs: baseShot.startTimeMs,
                    endTimeMs: lastShot.endTimeMs,
                };
            }
            const cw = this._canvas.width;
            const ch = this._canvas.height;
            const w = cw / this._dpr;
            const h = ch / this._dpr;
            if (w > 4 && h > 4) {
                const basePalette = this._resolvePalette();
                const shotPal = this._resolveShotPalette(basePalette, renderShot);
                this._printParams = resolveAstrolabePrintParams(this.opts.astrolabePrintLevel);
                const drawMs = Math.max(renderShot.startTimeMs + 80, renderShot.endTimeMs - 40);
                this._posterFullReveal = true;
                try {
                    const ctx = this._ctx;
                    ctx.save();
                    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
                    ctx.fillStyle = shotPal.bg;
                    ctx.fillRect(0, 0, w, h);
                    this._drawPrintGrain(ctx, w, h, shotPal);
                    this._renderSingleShot(ctx, renderShot, 0.88, drawMs, w, h, shotPal, 1, 0, true);
                    this._drawPrintVignette(ctx, w, h, shotPal);
                    if (this.opts.astrolabeCropMarks) {
                        this._drawCropFrame(ctx, w, h, shotPal);
                    }
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
                    this._lastSyncTimeMs = prevSync;
                    this._smoothMediaMs = prevSmooth;
                    this._renderFrame(prevSync, typeof performance !== 'undefined' ? performance.now() : Date.now());
                    if (wasRunning && typeof this.start === 'function') this.start();
                };
            }
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._posterFullReveal = true;
        try {
            this._renderFrame(peakMs, now);
        } finally {
            this._posterFullReveal = false;
        }
        return () => {
            this._lastSyncTimeMs = prevSync;
            this._smoothMediaMs = prevSmooth;
            this._renderFrame(prevSync, typeof performance !== 'undefined' ? performance.now() : Date.now());
            if (wasRunning && typeof this.start === 'function') this.start();
        };
    }

    _extrapolatedTimeMs() {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const dt = this._lastFramePerf > 0 ? Math.max(0, Math.min(50, now - this._lastFramePerf)) : 16.67;
        this._lastFramePerf = now;

        if (typeof globalThis !== 'undefined' && globalThis.audio) {
            const audioEl = globalThis.audio;
            const offsetMs = Number(globalThis.lyricOffset) || 0;
            const rawMs = Math.max(0, (Number(audioEl.currentTime) || 0) * 1000 + offsetMs);
            if (Math.abs(rawMs - this._lastRawMediaMs) > 0.5) {
                this._lastRawMediaMs = rawMs;
                this._lastRawPerf = now;
            }
            if (!audioEl.paused) {
                const rate = Number(audioEl.playbackRate) || 1;
                const sinceTick = Math.min(340, Math.max(0, now - this._lastRawPerf));
                const targetMs = rawMs + sinceTick * rate;
                const err = targetMs - this._smoothMediaMs;
                if (Math.abs(err) >= 650) {
                    this._smoothMediaMs = targetMs;
                } else {
                    // 对称 PLL 相位锁定：当画面跑在音频前面（err < 0）时允许平滑减速至 0，消除长期提前量偏差且永不倒退
                    const step = Math.max(0, dt * rate + err * 0.14);
                    this._smoothMediaMs += step;
                }
                return this._smoothMediaMs;
            }
            this._smoothMediaMs = rawMs;
            return rawMs;
        }
        return this._lastSyncTimeMs;
    }

    onFrame() {
        const timeMs = this._extrapolatedTimeMs();
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this._renderFrame(timeMs, now);
    }

    _extractCoverPalette() {
        if (typeof document === 'undefined') return;
        const coverUrl = globalThis.currentSongData?.cover || '';
        if (!coverUrl || coverUrl === this._lastCoverUrl) return;
        this._lastCoverUrl = coverUrl;

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const c = document.createElement('canvas');
                c.width = 16;
                c.height = 16;
                const x = c.getContext('2d');
                if (!x) return;
                x.drawImage(img, 0, 0, 16, 16);
                const data = x.getImageData(0, 0, 16, 16).data;
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                    if (lum > 24 && lum < 235) {
                        r += data[i];
                        g += data[i + 1];
                        b += data[i + 2];
                        cnt++;
                    }
                }
                if (cnt > 0) {
                    const mr = r / cnt;
                    const mg = g / cnt;
                    const mb = b / cnt;
                    const avgHex = rgbToHex(mr, mg, mb);
                    // 根据封面冷暖主色相选择匹配的博物馆点睛色基底，拒绝千篇一律混入朱砂红
                    const seedAccent = (mb > mr * 1.12)
                        ? '#2b7fff'
                        : (mg > mr * 1.05 ? '#18b888' : (mr > mg * 1.25 ? '#e63928' : '#e6a832'));
                    const darkBg = mixHex('#0e1218', avgHex, 0.26);
                    const warmPaper = mixHex('#f3efe4', avgHex, 0.10);
                    const accent = mixHex(seedAccent, avgHex, 0.32);
                    this._coverPalette = {
                        bg: darkBg,
                        paper: warmPaper,
                        ink: '#f5efe4',
                        dimInk: 'rgba(245, 239, 228, 0.44)',
                        darkInk: mixHex('#10131a', avgHex, 0.20),
                        dimDarkInk: 'rgba(16, 19, 26, 0.38)',
                        accent,
                        seam: mixHex(darkBg, '#ffffff', 0.15),
                        tones: [
                            mixHex(darkBg, '#ffffff', 0.06),
                            mixHex(darkBg, avgHex, 0.24),
                            mixHex(darkBg, seedAccent, 0.18),
                        ],
                    };
                }
            } catch (e) {
                logCatch('AstrolabeVisualizer.cover', e);
            }
        };
        img.src = coverUrl;
    }

    _resolvePalette() {
        const key = this.opts.astrolabePreset;
        if (key && key !== 'auto' && ASTROLABE_PALETTES[key]) {
            return ASTROLABE_PALETTES[key];
        }
        if (this._coverPalette) return this._coverPalette;
        return ASTROLABE_PALETTES.obsidian;
    }

    /**
     * 按分镜动态派生「画册翻页极性（Stage Polarity）」与跨色相章节色调：
     * - ~55% 分镜：深邃墨色舞台底（dark-stage）+ 象牙羊皮纸反色主块面；
     * - ~28% 分镜：象牙宣纸舞台底（paper-stage）+ 深墨/群青/石绿反色主块面；
     * - ~17% 分镜（含副歌重点镜）：博物馆级普鲁士蓝/朱砂红/天青石绿重彩海报底（poster-stage）。
     */
    _resolveShotPalette(basePalette, shot) {
        if (!shot) return basePalette;
        const h1 = astrolabeHash01(shot.seed, shot.index, 41);
        const secIdx = Number(shot.sectionIndex) || 0;
        const presetKeys = ['obsidian', 'prussian', 'bauhaus', 'vermilion', 'celadon', 'ochre'];
        /* 章节锚点按 section 稳定（astrolabeChapterIndex），去掉逐镜 h2 随机抖动 → 同章节色族连贯 */
        const chapterPal = ASTROLABE_PALETTES[presetKeys[astrolabeChapterIndex(secIdx)]] || basePalette;
        const isAuto = !this.opts.astrolabePreset || this.opts.astrolabePreset === 'auto';
        const src = isAuto ? {
            ...basePalette,
            bg: mixHex(basePalette.bg, chapterPal.bg, 0.65),
            paper: mixHex(basePalette.paper, chapterPal.paper, 0.65),
            accent: mixHex(basePalette.accent, chapterPal.accent, 0.78),
            tones: [
                mixHex(basePalette.tones[0], chapterPal.tones[0], 0.68),
                mixHex(basePalette.tones[1], chapterPal.tones[1], 0.72),
                mixHex(basePalette.tones[2], chapterPal.tones[2], 0.76),
            ],
        } : basePalette;

        // 翻页极性跟随音乐段落（sectionIndex + isChorusEntry / isChorus）呼吸，而非呆板取模：
        // 1. 副歌首镜或副歌内部奇数乐句打开象牙宣纸底（paper-stage），形成豁然开朗的章节翻页感；
        // 2. 非副歌的偶数呼吸段落或至点家族切入宣纸底；
        // 3. 副歌高潮镜/天顶家族切入博物馆重彩海报底（poster-stage）。
        const isPaperStage = shot.isChorusEntry
            || (!shot.isChorus && ((secIdx % 2 === 1 && shot.index % 2 === 1) || (shot.family === 'solstice' && h1 < 0.72)))
            || (shot.isChorus && shot.index % 3 === 2 && h1 < 0.55);
        const isPosterStage = !isPaperStage && (shot.isChorus || shot.family === 'zenith' || (secIdx % 3 === 2 && h1 > 0.62));

        if (isPaperStage) {
            // 象牙羊皮纸全画幅底幕：底字为深邃浓墨，反色块为深墨/普鲁士重块，反色块内文字翻转为亮白象牙色！
            const richDarkBlock = mixHex(src.darkInk, src.tones[2], 0.35);
            return {
                bg: src.paper,
                paper: richDarkBlock,
                ink: src.darkInk,
                dimInk: src.dimDarkInk,
                darkInk: src.ink,
                dimDarkInk: src.dimInk,
                accent: src.accent,
                seam: mixHex(src.paper, src.darkInk, 0.24),
                tones: [
                    mixHex(src.paper, src.darkInk, 0.09),
                    mixHex(src.paper, src.accent, 0.16),
                    mixHex(src.paper, src.darkInk, 0.19),
                ],
                polarity: 'paper',
            };
        }

        if (isPosterStage) {
            // 副歌/重点镜重彩海报底幕：用浓郁色阶或深朱砂/群青压底
            const posterBg = shot.isChorus
                ? mixHex(src.tones[1], src.accent, 0.28)
                : src.tones[2];
            return {
                ...src,
                bg: posterBg,
                seam: mixHex(posterBg, '#ffffff', 0.18),
                tones: [
                    src.bg,
                    mixHex(posterBg, src.accent, 0.32),
                    mixHex(src.tones[0], '#ffffff', 0.08),
                ],
                polarity: 'poster',
            };
        }

        return { ...src, polarity: 'dark' };
    }

    _ensureProgram() {
        const rawLines = (Array.isArray(this.lines) && this.lines.length > 0)
            ? this.lines
            : (Array.isArray(globalThis.lyricsData) && globalThis.lyricsData.length > 0 ? globalThis.lyricsData : null);
        const songTitle = globalThis.currentSongData?.song || '';
        if (
            !this._programDirty
            && this._program
            && this._lastLinesRef === rawLines
            && this._lastSongRef === songTitle
        ) {
            return;
        }
        const lines = rawLines || [{ time: 0, text: songTitle || 'ARIA ASTROLABE' }];
        const firstText = String(lines[0]?.original || lines[0]?.text || '');
        const key = `${lines.length}:${firstText}:${lines[lines.length - 1]?.time || 0}:${this.opts.astrolabeCutRate}`;
        this._programDirty = false;
        this._lastLinesRef = rawLines;
        this._lastSongRef = songTitle;
        if (this._program && this._programKey === key) return;
        this._programKey = key;
        this._program = compileAstrolabeProgram(lines, {
            cutRate: this.opts.astrolabeCutRate || 'phrase',
            seed: `${songTitle}:${firstText}`,
        });
        this._geoCache.clear();
        this._layoutCache.clear();
    }

    _getGeometry(shot, aspect) {
        const key = `${shot.index}:${aspect.toFixed(3)}`;
        let geo = this._geoCache.get(key);
        if (!geo) {
            geo = buildAstrolabeShotGeometry(shot, aspect);
            this._geoCache.set(key, geo);
        }
        return geo;
    }

    /**
     * 8 种瑞士海报级排版拓扑（视口宽度等比例放大，彻底突破固定像素天花板，且每镜仅两档离散字号）
     */
    _getShotLayout(shot, geo, w, h, ctx) {
        const fontStack = resolveAstrolabeFont(this.opts.fontFamily);
        const emoStamp = astrolabeEmotionStamp(this.aiData);
        let cached = this._layoutCache.get(shot.index);
        if (cached && cached.w === w && cached.h === h && cached.fontStack === fontStack && cached.emoStamp === emoStamp) return cached;

        const userScale = Math.max(0.6, Math.min(2.2, Number(this.opts.fontSize) || 1.0));
        const gCount = Math.max(1, shot.graphemes.length);
        const cfg = ASTROLABE_TYPO_CONFIG;

        const maxViewportPx = Math.round(Math.max(96, w * cfg.viewportRatioCap) * userScale);
        const rawBasePx = (w / Math.max(5.0, gCount * 0.94)) * 1.48 * cfg.lyricsFontScale * userScale;
        let fontPx = Math.round(
            Math.max(cfg.minFontPx * userScale, Math.min(maxViewportPx, rawBasePx)) * (shot.isChorus ? 1.08 : 1.0),
        );

        const region = shot.region || { cx: 0.5, cy: 0.46, w: 0.72, h: 0.52, align: 'center' };
        const topology = shot.topology || 'swiss-editorial';
        const maxBoxW = w * (region.w || 0.72);
        const maxBoxH = h * (region.h || 0.52);

        const words = [];
        let curWord = [];
        for (let i = 0; i < shot.graphemes.length; i++) {
            const g = shot.graphemes[i];
            if (/\s/.test(g.char)) {
                if (curWord.length > 0) {
                    words.push(curWord);
                    curWord = [];
                }
            } else {
                curWord.push({ ...g, gIndex: i });
                const code = g.char.codePointAt(0) || 0;
                if (code >= 0x2e80 && curWord.length >= 2) {
                    words.push(curWord);
                    curWord = [];
                }
            }
        }
        if (curWord.length > 0) words.push(curWord);
        if (words.length === 0) {
            words.push(shot.graphemes.map((g, i) => ({ ...g, gIndex: i })));
        }

        const heroIdx = words.length > 1
            ? Math.floor(astrolabeHash01(shot.seed, shot.index, 31) * words.length) % words.length
            : 0;
        const heroScale = words.length > 1 ? cfg.heroWordScale : 1.0;

        ctx.save();
        const measureRows = (basePx) => {
            const cjkTrack = basePx * cfg.cjkTrackingRatio;
            const wordGap = basePx * cfg.latinWordGapRatio;
            const wMetrics = words.map((wChars, wIdx) => {
                const isHero = wIdx === heroIdx;
                const wPx = isHero ? Math.round(basePx * heroScale) : basePx;
                ctx.font = `800 ${wPx}px ${fontStack}`;
                let totalW = 0;
                const cWidths = [];
                for (let c = 0; c < wChars.length; c++) {
                    const cw = Math.max(wPx * 0.32, ctx.measureText(wChars[c].char).width + cjkTrack);
                    cWidths.push(cw);
                    totalW += cw;
                }
                return { wChars, wPx, totalW, cWidths, isHero, wordIndex: wIdx };
            });

            const rows = [];
            let curRow = [];
            let curRowW = 0;
            const baseTargetW = topology === 'monolith-banner' ? maxBoxW * 1.08 : maxBoxW * 0.86;
            for (let i = 0; i < wMetrics.length; i++) {
                const wm = wMetrics[i];
                const rowSalt = 0.78 + astrolabeHash01(shot.seed, shot.index * 17 + rows.length, 53) * 0.24;
                const rowTargetW = baseTargetW * rowSalt;
                const addW = curRow.length > 0 ? wordGap + wm.totalW : wm.totalW;
                if (curRow.length > 0 && curRowW + addW > rowTargetW && rows.length < 4) {
                    rows.push({ items: curRow, width: curRowW });
                    curRow = [wm];
                    curRowW = wm.totalW;
                } else {
                    curRow.push(wm);
                    curRowW += addW;
                }
            }
            if (curRow.length > 0) rows.push({ items: curRow, width: curRowW });
            return { rows, wordGap, wMetrics };
        };

        let packed = measureRows(fontPx);
        const fontFloor = Math.max(28, Math.round(cfg.minFontPx * 0.72 * userScale));
        for (let iter = 0; iter < 8; iter++) {
            const widest = Math.max(...packed.rows.map(r => r.width), 1);
            const tallH = packed.rows.reduce((acc, r) => {
                const rMaxPx = r.items.some(it => it.isHero) ? fontPx * heroScale : fontPx;
                return acc + rMaxPx * cfg.lineHeightRatio;
            }, 0);
            if ((widest > maxBoxW * 0.96 || tallH > Math.min(maxBoxH, h * 0.62)) && fontPx > fontFloor) {
                const ratio = Math.min((maxBoxW * 0.96) / widest, Math.min(maxBoxH, h * 0.62) / tallH, 0.90);
                fontPx = Math.max(fontFloor, Math.round(fontPx * Math.max(0.74, ratio)));
                packed = measureRows(fontPx);
            } else {
                break;
            }
        }

        const focusX = w * (region.cx || 0.5);
        const focusY = h * (region.cy || 0.46);
        const hasLineGraphemes = Array.isArray(shot.lineGraphemes)
            && Number.isInteger(shot.lineGraphemeOffset)
            && shot.lineGraphemeOffset >= 0
            && shot.lineGraphemeOffset + shot.graphemes.length <= shot.lineGraphemes.length;
        const emoColors = hasLineGraphemes
            ? emotionColorsForGraphemes(shot.text, shot.lineGraphemes, shot.lineIndex, this.aiData)
                .slice(shot.lineGraphemeOffset, shot.lineGraphemeOffset + shot.graphemes.length)
            : emotionColorsForGraphemes(shot.text, shot.graphemes, shot.lineIndex, this.aiData);
        const glyphs = [];
        let heroBox = null;

        // 特殊拓扑 A：vertical-manuscript（首词竖立成铭文柱 + 其余词在独立旁栏横排展开，严格分栏绝不重叠）
        const isVerticalTopo = topology === 'vertical-manuscript'
            && packed.wMetrics.length >= 2
            && packed.wMetrics[0].wChars.length <= 8;

        if (isVerticalTopo) {
            const pillarWord = packed.wMetrics[0];
            const pillarOnRight = region.align === 'right';
            const isCjkPillar = pillarWord.wChars.some(ch => (ch.char.codePointAt(0) || 0) >= 0x2e80);

            // 字母语言（英文/拉丁等）整词顺时针横转 90° 沿竖轴连写，绝不一字母一换行；中日韩汉字保持正立竖排
            const maxPillarSpanH = h * 0.54;
            const rawPillarSpan = isCjkPillar
                ? pillarWord.wChars.length * (pillarWord.wPx * 1.06)
                : pillarWord.totalW;
            const pScale = rawPillarSpan > maxPillarSpanH ? (maxPillarSpanH / rawPillarSpan) : 1.0;
            const pPx = Math.max(28, Math.round(pillarWord.wPx * pScale));
            const pillarColW = pPx * 1.32;

            const pillarX = pillarOnRight
                ? Math.min(w * 0.88, Math.max(w * 0.72, focusX + maxBoxW * 0.36))
                : Math.max(w * 0.12, Math.min(w * 0.28, focusX - maxBoxW * 0.36));

            if (isCjkPillar) {
                const pCharStep = pPx * 1.06;
                const pTotalH = pillarWord.wChars.length * pCharStep;
                const pStartY = Math.max(h * 0.16, Math.min(h * 0.76 - pTotalH, focusY - pTotalH * 0.5));
                for (let cIdx = 0; cIdx < pillarWord.wChars.length; cIdx++) {
                    const ch = pillarWord.wChars[cIdx];
                    const cw = pillarWord.cWidths[cIdx] * pScale;
                    glyphs.push({
                        char: ch.char,
                        start: ch.start,
                        end: ch.end,
                        x: pillarX,
                        y: pStartY + (cIdx + 0.5) * pCharStep,
                        w: cw,
                        fontPx: pPx,
                        rowIndex: 0,
                        rotRad: 0,
                        isHero: true,
                        emotionColor: emoColors[ch.gIndex] || null,
                    });
                }
                heroBox = {
                    x: pillarX - pPx * 0.62,
                    y: pStartY - pPx * 0.18,
                    w: pPx * 1.24,
                    h: pTotalH + pPx * 0.36,
                    isVerticalPillar: true,
                };
            } else {
                // 字母语言：整词旋转 90°（Math.PI * 0.5），每个字母按自身真实字宽 cw 沿竖向基线紧密连写
                const pTotalH = pillarWord.totalW * pScale;
                const pStartY = Math.max(h * 0.16, Math.min(h * 0.76 - pTotalH, focusY - pTotalH * 0.5));
                let curPY = pStartY;
                for (let cIdx = 0; cIdx < pillarWord.wChars.length; cIdx++) {
                    const ch = pillarWord.wChars[cIdx];
                    const cw = pillarWord.cWidths[cIdx] * pScale;
                    glyphs.push({
                        char: ch.char,
                        start: ch.start,
                        end: ch.end,
                        x: pillarX,
                        y: curPY + cw * 0.5,
                        w: cw,
                        fontPx: pPx,
                        rowIndex: 0,
                        rotRad: Math.PI * 0.5,
                        isHero: true,
                        emotionColor: emoColors[ch.gIndex] || null,
                    });
                    curPY += cw;
                }
                heroBox = {
                    x: pillarX - pPx * 0.62,
                    y: pStartY - pPx * 0.18,
                    w: pPx * 1.24,
                    h: pTotalH + pPx * 0.36,
                    isVerticalPillar: true,
                };
            }

            // 其余词在铭文柱外侧的专属旁栏 [bodyMinX, bodyMaxX] 内自动分行排布，严禁越界与铭文柱或同行前词重叠
            const colGap = Math.max(24, fontPx * 0.45);
            const bodyMinX = pillarOnRight ? w * 0.08 : (pillarX + pillarColW * 0.62 + colGap);
            const bodyMaxX = pillarOnRight ? (pillarX - pillarColW * 0.62 - colGap) : w * 0.92;
            const availBodyW = Math.max(w * 0.28, bodyMaxX - bodyMinX);

            const remWords = packed.wMetrics.slice(1);
            const bRows = [];
            let curBRow = [];
            let curBW = 0;
            for (let m = 0; m < remWords.length; m++) {
                const wm = remWords[m];
                const addW = curBRow.length > 0 ? packed.wordGap + wm.totalW : wm.totalW;
                if (curBRow.length > 0 && curBW + addW > availBodyW * 0.92 && bRows.length < 3) {
                    bRows.push({ items: curBRow, width: curBW });
                    curBRow = [wm];
                    curBW = wm.totalW;
                } else {
                    curBRow.push(wm);
                    curBW += addW;
                }
            }
            if (curBRow.length > 0) bRows.push({ items: curBRow, width: curBW });

            const bWidest = Math.max(...bRows.map(r => r.width), 1);
            const bScale = bWidest > availBodyW ? (availBodyW / bWidest) : 1.0;
            const bRowH = Math.max(fontPx * 1.22, fontPx * heroScale * 1.12) * bScale;
            const bTotalH = bRows.length * bRowH;
            const bStartY = Math.max(h * 0.16, Math.min(h * 0.76 - bTotalH, focusY - bTotalH * 0.5));

            for (let bIdx = 0; bIdx < bRows.length; bIdx++) {
                const brow = bRows[bIdx];
                const scaledRowW = brow.width * bScale;
                const indent = (bIdx % 2 === 1) ? Math.min(fontPx * 0.45, Math.max(0, availBodyW - scaledRowW)) : 0;
                let cursorX = pillarOnRight
                    ? Math.max(bodyMinX, bodyMaxX - scaledRowW - indent)
                    : Math.min(bodyMaxX - scaledRowW, bodyMinX + indent);
                const rowY = bStartY + (bIdx + 0.5) * bRowH;

                for (let wIdx = 0; wIdx < brow.items.length; wIdx++) {
                    const wm = brow.items[wIdx];
                    const effPx = Math.max(26, Math.round(wm.wPx * bScale));
                    for (let cIdx = 0; cIdx < wm.wChars.length; cIdx++) {
                        const ch = wm.wChars[cIdx];
                        const cw = wm.cWidths[cIdx] * bScale;
                        glyphs.push({
                            char: ch.char,
                            start: ch.start,
                            end: ch.end,
                            x: cursorX + cw * 0.5,
                            y: rowY,
                            w: cw,
                            fontPx: effPx,
                            rowIndex: bIdx + 1,
                            rotRad: 0,
                            isHero: wm.isHero,
                            emotionColor: emoColors[ch.gIndex] || null,
                        });
                        cursorX += cw;
                    }
                    cursorX += packed.wordGap * bScale;
                }
            }
        } else {
            // 计算每一行的真实高度（含 1.38x 核心主词行高余量），整体限制在安全视口 [0.15h .. 0.78h] 内，
            // 严禁逐行单独 clamp 导致底部两行被挤压到同一个 Y 坐标而重叠！
            const rowHeights = packed.rows.map(r => {
                const hasHero = r.items.some(it => it.isHero);
                return (hasHero ? fontPx * heroScale : fontPx) * Math.max(1.24, cfg.lineHeightRatio);
            });
            const blockTotalH = rowHeights.reduce((a, b) => a + b, 0);
            let curRowTopY = Math.max(h * 0.14, Math.min(h * 0.78 - blockTotalH, focusY - blockTotalH * 0.5));
            const maxSafeRowW = w * 0.88;

            for (let rIdx = 0; rIdx < packed.rows.length; rIdx++) {
                const row = packed.rows[rIdx];
                const rH = rowHeights[rIdx];
                const normR = rIdx - (packed.rows.length - 1) * 0.5;
                let rowShiftX = 0;
                let rowRotRad = ((region.tiltDeg || 0) * Math.PI) / 180 * 0.32;

                // 8 种瑞士海报级排版拓扑水平错位（仅做水平阶梯/对位偏移，垂直间距由 rH 严格单调递增保证，绝不撞行）
                if (topology === 'staircase-cascade') {
                    rowShiftX = normR * fontPx * 1.15;
                } else if (topology === 'celestial-chord') {
                    rowShiftX = (rIdx % 2 === 0 ? -1 : 1) * fontPx * 0.88;
                    rowRotRad += (rIdx % 2 === 0 ? -0.018 : 0.018);
                } else if (topology === 'antiphony-split') {
                    rowShiftX = (rIdx % 2 === 0 ? -w * 0.08 : w * 0.08);
                } else if (topology === 'fulcrum-pivot') {
                    rowShiftX = (rIdx % 2 === 0 ? -0.48 : 0.56) * fontPx;
                } else if (topology === 'orbital-stagger') {
                    rowShiftX = Math.sin(rIdx * 1.4 + shot.index) * fontPx * 0.92;
                    rowRotRad += normR * 0.024;
                } else if (topology === 'swiss-editorial') {
                    rowShiftX = (rIdx === 0 ? 0 : fontPx * 0.72 * (region.align === 'right' ? -1 : 1));
                }

                // 若单行总宽超过安全视口宽度，按比例收敛本行字宽与词距，防止长句越界或词间挤压
                const rowFitScale = row.width > maxSafeRowW ? (maxSafeRowW / row.width) : 1.0;
                const effRowW = row.width * rowFitScale;

                let startX = focusX - effRowW * 0.5 + rowShiftX;
                if (region.align === 'left') {
                    startX = Math.max(w * 0.06, focusX - maxBoxW * 0.44 + Math.max(0, rowShiftX));
                } else if (region.align === 'right') {
                    startX = Math.min(w * 0.94 - effRowW, focusX + maxBoxW * 0.44 - effRowW + Math.min(0, rowShiftX));
                }
                startX = Math.max(w * 0.05, Math.min(w * 0.95 - effRowW, startX));
                const baseY = curRowTopY + rH * 0.5;
                curRowTopY += rH;

                let cursorX = startX;
                for (let wIdx = 0; wIdx < row.items.length; wIdx++) {
                    const wm = row.items[wIdx];
                    const salt = rIdx * 31 + wIdx;
                    const wordShiftY = (astrolabeHash01(shot.seed, salt, 73) - 0.5) * fontPx * 0.032;
                    const wordRot = rowRotRad + (astrolabeHash01(shot.seed, salt, 79) - 0.5) * 0.018;
                    const wStartX = cursorX;
                    const effWPx = Math.max(26, Math.round(wm.wPx * rowFitScale));

                    for (let cIdx = 0; cIdx < wm.wChars.length; cIdx++) {
                        const ch = wm.wChars[cIdx];
                        const cw = wm.cWidths[cIdx] * rowFitScale;
                        glyphs.push({
                            char: ch.char,
                            start: ch.start,
                            end: ch.end,
                            x: cursorX + cw * 0.5,
                            y: baseY + wordShiftY,
                            w: cw,
                            fontPx: effWPx,
                            rowIndex: rIdx,
                            rotRad: wordRot,
                            isHero: wm.isHero,
                            emotionColor: emoColors[ch.gIndex] || null,
                        });
                        cursorX += cw;
                    }
                    if (wm.isHero && !heroBox) {
                        heroBox = {
                            x: wStartX - effWPx * 0.12,
                            y: baseY + wordShiftY - effWPx * 0.56,
                            w: wm.totalW * rowFitScale + effWPx * 0.24,
                            h: effWPx * 1.12,
                            isVerticalPillar: false,
                        };
                    }
                    cursorX += packed.wordGap * rowFitScale;
                }
            }
        }
        ctx.restore();

        if (glyphs.length) {
            let gx0 = Infinity;
            let gx1 = -Infinity;
            for (const g of glyphs) {
                gx0 = Math.min(gx0, g.x - (g.w || g.fontPx) * 0.5);
                gx1 = Math.max(gx1, g.x + (g.w || g.fontPx) * 0.5);
            }
            const padEdge = w * 0.055;
            let shiftX = 0;
            if (gx1 - gx0 <= w - padEdge * 2) {
                if (gx0 < padEdge) shiftX = padEdge - gx0;
                else if (gx1 > w - padEdge) shiftX = (w - padEdge) - gx1;
            } else {
                shiftX = w * 0.5 - (gx0 + gx1) * 0.5;
            }
            if (shiftX) {
                for (const g of glyphs) g.x += shiftX;
                if (heroBox) heroBox.x += shiftX;
            }
        }

        let minGX = w, minGY = h, maxGX = 0, maxGY = 0;
        for (let i = 0; i < glyphs.length; i++) {
            const g = glyphs[i];
            const spanMax = Math.max(g.w, g.fontPx);
            // 严密包络 press-stamp (1.26x)、pivot-unfold (0.22rad)、90° 竖排横转词与入场偏移 (0.28*fontPx) 的最大几何外接盒
            const padX = spanMax * 0.96 + g.fontPx * 0.72;
            const padY = spanMax * 1.14;
            if (g.x - padX < minGX) minGX = g.x - padX;
            if (g.y - padY < minGY) minGY = g.y - padY;
            if (g.x + padX > maxGX) maxGX = g.x + padX;
            if (g.y + padY > maxGY) maxGY = g.y + padY;
        }
        if (heroBox) {
            const hPad = 16;
            const hx0 = Math.min(heroBox.x, heroBox.x - heroBox.w * 0.5) - hPad;
            const hy0 = Math.min(heroBox.y, heroBox.y - heroBox.h * 0.5) - hPad;
            const hx1 = Math.max(heroBox.x + heroBox.w, heroBox.x + heroBox.w * 0.5) + hPad;
            const hy1 = Math.max(heroBox.y + heroBox.h, heroBox.y + heroBox.h * 0.5) + hPad;
            if (hx0 < minGX) minGX = hx0;
            if (hy0 < minGY) minGY = hy0;
            if (hx1 > maxGX) maxGX = hx1;
            if (hy1 > maxGY) maxGY = hy1;
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

        // 瑞士海报「网格与字的对话」（Typographic Grid Coupling）：
        // 提取真实排版的基线/行间切缝（horizonY）、主词/词间切分点（seamX）与左齐字干线（stemLeftX），
        // 供正负形反色块面边界与结构基准线精准咬合，杜绝块面与文字随机重叠。
        let horizonY = focusY + fontPx * 0.34;
        let seamX = focusX;
        let stemLeftX = focusX - w * 0.18;
        if (glyphs.length > 0) {
            const firstG = glyphs[0];
            stemLeftX = Math.max(w * 0.06, firstG.x - firstG.w * 0.5 - fontPx * 0.14);
            let row1G = null;
            for (let i = 1; i < glyphs.length; i++) {
                if (glyphs[i].rowIndex !== firstG.rowIndex) {
                    row1G = glyphs[i];
                    break;
                }
            }
            if (row1G) {
                horizonY = (firstG.y + row1G.y) * 0.5;
            } else {
                horizonY = firstG.y + fontPx * 0.34;
            }

            let splitIdx = Math.max(1, Math.min(glyphs.length - 1, Math.floor(glyphs.length * 0.38)));
            for (let i = 0; i < glyphs.length - 1; i++) {
                if (glyphs[i].isHero && !glyphs[i + 1].isHero) {
                    splitIdx = i + 1;
                    break;
                }
            }
            const gL = glyphs[splitIdx - 1];
            const gR = glyphs[splitIdx] || gL;
            seamX = ((gL.x + gL.w * 0.5) + (gR.x - gR.w * 0.5)) * 0.5;
        }
        const typoGrid = {
            mode: shot.gridLockMode || 'word-split',
            horizonY,
            seamX,
            stemLeftX,
        };

        let watermarkCanvas = null;
        const wmText = shot.watermarkText || '◇';
        if (typeof document !== 'undefined' && geo.watermark) {
            watermarkCanvas = document.createElement('canvas');
            watermarkCanvas.width = 280;
            watermarkCanvas.height = 104;
            const wctx = watermarkCanvas.getContext('2d');
            if (wctx) {
                wctx.font = `800 64px ${fontStack}`;
                wctx.textAlign = 'center';
                wctx.textBaseline = 'middle';
                wctx.fillStyle = '#ffffff';
                wctx.fillText(wmText, 140, 52);
            }
        }

        cached = {
            w,
            h,
            fontStack,
            fontPx,
            focusX,
            focusY,
            glyphs,
            heroBox,
            dirtyRect,
            typoGrid,
            watermarkCanvas,
            emoStamp,
        };
        this._layoutCache.set(shot.index, cached);
        return cached;
    }

    _prewarmNextShot(activeShot, w, h, ctx) {
        if (!this._program?.shots || !activeShot) return;
        const nextShot = this._program.shots[activeShot.index + 1];
        if (!nextShot) return;
        const geo = this._getGeometry(nextShot, w / Math.max(1, h));
        this._getShotLayout(nextShot, geo, w, h, ctx);
    }

    _renderFrame(timeMs, _ambientMs) {
        if (!this._ctx || !this._canvas) return;
        this._ensureProgram();
        if (!this._program) return;

        const cw = this._canvas.width;
        const ch = this._canvas.height;
        const w = cw / this._dpr;
        const h = ch / this._dpr;
        if (w <= 4 || h <= 4) return;

        const ctx = this._ctx;
        const basePalette = this._resolvePalette();
        this._printParams = resolveAstrolabePrintParams(this.opts.astrolabePrintLevel);
        const state = findActiveAstrolabeShot(this._program, timeMs);

        ctx.save();
        ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

        if (!state.active) {
            ctx.fillStyle = basePalette.bg;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
            return;
        }

        const activeShotPal = this._resolveShotPalette(basePalette, state.active);
        // 100% 不透明实色版画底幕（随分镜极性在深墨底 / 象牙宣纸底 / 重彩海报底之间画册式翻页！）
        ctx.fillStyle = activeShotPal.bg;
        ctx.fillRect(0, 0, w, h);

        // 纸纹落在底幕之上、所有块面与文字之下 —— 才是「纸有纹理，油墨压在上面」
        const printT0 = this._nowMs();
        this._drawPrintGrain(ctx, w, h, activeShotPal);

        if (state.activeProgress > 0.25) {
            this._prewarmNextShot(state.active, w, h, ctx);
        }

        if (state.prev && state.transitionProgress < 1) {
            const prevShotPal = this._resolveShotPalette(basePalette, state.prev);
            this._renderTransition(
                ctx,
                state.prev,
                state.active,
                state.activeProgress,
                state.transitionProgress,
                timeMs,
                w,
                h,
                prevShotPal,
                activeShotPal,
            );
        } else {
            this._renderSingleShot(ctx, state.active, state.activeProgress, timeMs, w, h, activeShotPal, 1, 0, true);
        }

        // 暗角压在最上层，把视线收回中间（纸纹已在底幕处铺好，这里只贴一张预烘焙图）
        this._drawPrintVignette(ctx, w, h, activeShotPal);
        this._trackPrintCost(this._nowMs() - printT0);

        if (this.opts.astrolabeCropMarks) {
            this._drawCropFrame(ctx, w, h, activeShotPal);
        }
        ctx.restore();
    }

    _nowMs() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    /** 印刷层开关：总开关 + 运行时降级 */
    _printEnabled(kind) {
        if (this.opts.astrolabeGrain === false) return false;
        if (this._printDegraded === 'both-off') return false;
        if (kind === 'grain' && this._printDegraded === 'grain-off') return false;
        return true;
    }

    /**
     * 合成成本自适应：连续 90 帧均值超阈值即降级，只降不升，避免来回抖动
     * （300Hz 屏上两次全屏合成的成本会被放大 5 倍，低配机器上必须能自己退下来）
     */
    _trackPrintCost(ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        this._printCostSum += ms;
        this._printCostN += 1;
        if (this._printCostN < 90) return;
        const avg = this._printCostSum / this._printCostN;
        this._printCostSum = 0;
        this._printCostN = 0;
        if (avg <= 1.6) return;
        const next = this._printDegraded === 'grain-off' ? 'both-off' : 'grain-off';
        if (next === this._printDegraded) return;
        this._printDegraded = next;
        logInfo('Astrolabe.print', `印刷质感合成均值 ${avg.toFixed(2)}ms，降级为 ${next}`);
    }

    /**
     * 纸纹：256px tile 平铺，走 multiply 合成
     * - 白噪点在 multiply 下天然失效（255×底=底），只保留压暗的黑点，等效「油墨吃进纸里」；
     * - 必须在底幕之后、块面与文字之前调用。
     */
    _drawPrintGrain(ctx, w, h, palette) {
        if (typeof document === 'undefined' || !this._printEnabled('grain')) return;
        const pr = this._printParams || resolveAstrolabePrintParams(this.opts.astrolabePrintLevel);
        const isPaper = palette.polarity === 'paper';

        const gKey = `${pr.tile}|${pr.grainMax}`;
        let pat = this._grainCache.get(gKey);
        if (!pat) {
            const gc = document.createElement('canvas');
            gc.width = pr.tile;
            gc.height = pr.tile;
            const gx = gc.getContext('2d');
            if (!gx) return;
            const img = gx.createImageData(pr.tile, pr.tile);
            let s = 0x2f6b1d;
            for (let i = 0; i < img.data.length; i += 4) {
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                const r = s / 0x7fffffff;
                const light = r > 0.5;
                const v = light ? 255 : 0;
                img.data[i] = v;
                img.data[i + 1] = v;
                img.data[i + 2] = v;
                img.data[i + 3] = Math.round(Math.abs(r - 0.5) * 2 * pr.grainMax);
            }
            gx.putImageData(img, 0, 0);
            pat = ctx.createPattern(gc, 'repeat');
            if (!pat) return;
            this._grainCache.set(gKey, pat);
        }

        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = isPaper ? pr.paperGrainMul : 1;
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
    }

    /**
     * 暗角：预烘焙暖墨径向渐变，压在最上层收拢视线
     * - 用 palette.darkInk（暖墨）而不是纯黑，白底页上不发灰；
     * - paper 极性按 vignettePaperMul 减弱，避免米白纸边缘变脏。
     */
    _drawPrintVignette(ctx, w, h, palette) {
        if (typeof document === 'undefined' || !this._printEnabled('vignette')) return;
        const pr = this._printParams || resolveAstrolabePrintParams(this.opts.astrolabePrintLevel);
        const isPaper = palette.polarity === 'paper';

        const vColor = HEX6_RE.test(String(palette.darkInk || '')) ? palette.darkInk : '#12141a';
        const vStrength = Math.max(0, Math.min(1, isPaper ? pr.vignette * pr.vignettePaperMul : pr.vignette));
        const vKey = `${Math.round(w)}x${Math.round(h)}|${vColor}|${vStrength.toFixed(3)}`;
        let vc = this._vignetteCache.get(vKey);
        if (!vc) {
            vc = document.createElement('canvas');
            vc.width = 256;
            vc.height = Math.max(64, Math.round((256 * h) / Math.max(1, w)));
            const vx = vc.getContext('2d');
            if (!vx) return;
            const g = vx.createRadialGradient(
                vc.width * 0.5, vc.height * 0.48, Math.min(vc.width, vc.height) * pr.innerRatio,
                vc.width * 0.5, vc.height * 0.5, Math.hypot(vc.width, vc.height) * 0.56,
            );
            g.addColorStop(0, hexToRgba(vColor, 0));
            g.addColorStop(1, hexToRgba(vColor, vStrength));
            vx.fillStyle = g;
            vx.fillRect(0, 0, vc.width, vc.height);
            this._vignetteCache.set(vKey, vc);
            if (this._vignetteCache.size > 12) {
                this._vignetteCache.delete(this._vignetteCache.keys().next().value);
            }
        }
        ctx.drawImage(vc, 0, 0, w, h);
    }

    _renderTransition(ctx, prevShot, activeShot, activeProg, tp, timeMs, w, h, prevPal, activePal) {
        const linear = clamp01(tp);
        const enter = easeAstrolabeEnter(clamp01(linear / 0.88));
        const exit = easeAstrolabeInOut(linear);
        const prevDur = Math.max(1, prevShot.endTimeMs - prevShot.startTimeMs);
        const prevProg = Math.min(1.42, Math.max(0, (timeMs - prevShot.startTimeMs) / prevDur));

        const transKind = activeShot.transition || 'flow-relay';
        const flowRad = activeShot.flowAngleRad || -0.24;
        const prevFlowRad = prevShot.flowAngleRad || flowRad;
        const flowX = Math.cos(flowRad);
        const flowY = Math.sin(flowRad);
        const prevFlowX = Math.cos(prevFlowRad);
        const prevFlowY = Math.sin(prevFlowRad);
        const travelMul = transKind === 'chorus-imprint' ? 1.38 : 1.0;
        const span = Math.hypot(w, h) * ASTROLABE_MOTION_TUNING.relayTravelRatio * travelMul;

        const outAlpha = Math.pow(Math.max(0, 1 - exit), 1.25);
        const inAlpha = clamp01(enter * 1.14);

        if (outAlpha > 0.01) {
            ctx.save();
            // 当旧镜与新镜底幕极性不同时，连同旧镜实色底幕一并顺流滑出，像实体画册翻页！
            ctx.translate(prevFlowX * exit * span, prevFlowY * exit * span);
            if (prevPal.bg !== activePal.bg) {
                ctx.globalAlpha = outAlpha;
                ctx.fillStyle = prevPal.bg;
                ctx.fillRect(-w * 0.4, -h * 0.4, w * 1.8, h * 1.8);
            }
            this._renderSingleShot(ctx, prevShot, prevProg, timeMs, w, h, prevPal, outAlpha, exit * 0.3, false);
            ctx.restore();
        }

        // 转场专属构成主义快门/色带切分（eclipse-wipe / bauhaus-shear / shutter-split）
        if (linear > 0.04 && linear < 0.82) {
            const bladeEnv = Math.sin((linear / 0.82) * Math.PI);
            ctx.save();
            if (transKind === 'bauhaus-shear' || transKind === 'chorus-imprint') {
                ctx.translate(w * 0.5, h * 0.5);
                ctx.rotate(flowRad);
                const bladeX = (exit - 0.5) * w * 1.35;
                ctx.fillStyle = activePal.accent;
                ctx.fillRect(bladeX - w * 0.045 * bladeEnv, -h, w * 0.09 * bladeEnv, h * 2);
            } else if (transKind === 'shutter-split') {
                const barH = h * 0.04 * bladeEnv;
                ctx.fillStyle = activePal.seam;
                ctx.fillRect(0, h * exit - barH * 0.5, w, barH);
            }
            ctx.restore();
        }

        ctx.save();
        ctx.translate(-flowX * (1 - enter) * span * 0.82, -flowY * (1 - enter) * span * 0.82);
        this._renderSingleShot(ctx, activeShot, activeProg, timeMs, w, h, activePal, inAlpha, -(1 - enter) * 0.24, true);
        ctx.restore();
    }

    _renderSingleShot(ctx, shot, shotProgress, timeMs, w, h, palette, alpha = 1, relayOffset = 0, drawSub = true) {
        const aspect = w / Math.max(1, h);
        const geo = this._getGeometry(shot, aspect);
        const layout = this._getShotLayout(shot, geo, w, h, ctx);

        const elapsedMs = Math.max(0, timeMs - shot.startTimeMs);
        const creep = astrolabeCreep(elapsedMs);
        const camInt = this.opts.astrolabeCamera * (shot.isChorus ? 1.1 : 1.0);
        const pClamped = clamp01(shotProgress);
        const overshoot = Math.max(0, shotProgress - 1) * ASTROLABE_MOTION_TUNING.cameraOvershootMul;
        const ep = pClamped * 0.72 + (0.5 - 0.5 * Math.cos(pClamped * Math.PI)) * 0.28 + overshoot;

        const zoom = 1 + ((shot.cameraZoomStart + (shot.cameraZoomEnd - shot.cameraZoomStart) * ep) - 1) * camInt;
        const dx = shot.cameraDriftX * (ep - 0.5 + relayOffset * 0.35) * w * camInt;
        const dy = shot.cameraDriftY * (ep - 0.5 + relayOffset * 0.35) * h * camInt;
        const rollRad = ((shot.cameraRollStartDeg + (shot.cameraRollEndDeg - shot.cameraRollStartDeg) * ep) * Math.PI / 180) * camInt * 0.55;

        const hasPlates = this._renderShotTextPlates(shot, layout, timeMs, palette);

        ctx.save();
        if (alpha < 0.999) ctx.globalAlpha = clamp01(alpha);
        ctx.translate(w * 0.5 + dx, h * 0.5 + dy);
        if (Math.abs(rollRad) > 0.0005) ctx.rotate(rollRad);
        if (Math.abs(zoom - 1) > 0.0005) ctx.scale(zoom, zoom);
        ctx.translate(-w * 0.5, -h * 0.5);

        // 1. 邻句印刷残影底纹大字（预烘焙 <=64px 纹理等比放大，零 Skia 图集回退）
        if (layout.watermarkCanvas && geo.watermark) {
            const wmScale = (Math.min(w, h) * 0.38) / 64;
            const wmW = layout.watermarkCanvas.width * wmScale;
            const wmH = layout.watermarkCanvas.height * wmScale;
            const wx = (geo.watermark.x / geo.aspect) * w - wmW * 0.5;
            const wy = geo.watermark.y * h - wmH * 0.5;
            ctx.save();
            ctx.globalAlpha *= (this._printParams?.watermark ?? 0.06);
            ctx.drawImage(layout.watermarkCanvas, wx, wy, wmW, wmH);
            ctx.restore();
        }

        const enterWindowMs = Math.max(260, (shot.handoffMs || 420) * 0.92);
        const rawShotEnter = clamp01(elapsedMs / enterWindowMs);
        const allowInversion = Boolean(this.opts.astrolabeInversion);

        // 2. 先绘制不反转文字的深色构成层（Opaque Tone Masses + 零 clip 建筑百叶标尺）
        for (let mIdx = 0; mIdx < geo.masses.length; mIdx++) {
            const mass = geo.masses[mIdx];
            if (mass.invert && allowInversion) continue;
            this._drawSolidMass(ctx, mass, geo, layout, rawShotEnter, creep, w, h, palette, false);
        }

        // 3. 绘制与文字基线/词间切缝精准对齐的瑞士网格基准线与版画母题
        this._drawStructuralMarks(ctx, shot, geo, layout, creep, w, h, palette);

        // 4. 在深色背景与辅助色块之上，单次 GPU drawImage 投射亮色主文字底板（_plateLight）
        if (hasPlates) {
            this._blitPlate(ctx, this._plateLight, layout.dirtyRect);
        } else {
            this._drawShotGlyphsToPlate(ctx, shot, layout, false, timeMs, palette);
        }

        // 5. 绘制正负形反色主块面（Paper Invert Masses）：100% 不透明象牙羊皮纸色块 + 内部单次 clip 投射暗墨文字底板（_plateDark）！
        if (allowInversion) {
            for (let mIdx = 0; mIdx < geo.masses.length; mIdx++) {
                const mass = geo.masses[mIdx];
                if (!mass.invert) continue;
                this._drawInvertedMassWithText(ctx, shot, layout, mass, geo, rawShotEnter, creep, timeMs, w, h, palette, hasPlates);
            }
        }

        ctx.restore();

        if (drawSub) {
            this._updateSubtitles(shot);
        }
    }

    _computeMassOffset(mass, rawShotEnter, creep, w, h, layout = null, geo = null) {
        const localRaw = clamp01((rawShotEnter - (mass.delayFraction || 0)) / (mass.spanFraction || 0.48));
        const mEnter = easeAstrolabeEnter(localRaw);
        let ox = ((1 - mEnter) * (mass.enterDX || 0) + creep * (mass.creepDX || 0)) * w;
        let oy = ((1 - mEnter) * (mass.enterDY || 0) + creep * (mass.creepDY || 0)) * h;

        // 瑞士海报「网格与字的对话」：将正负形反色主块面的切割边界直接锁死在真实排版的词间切缝（seamX）、基线/行间缝（horizonY）或字干（stemLeftX）上
        if (mass.invert && layout?.typoGrid && geo && mass.bbox) {
            const tg = layout.typoGrid;
            const bb = mass.bbox;
            const bx0 = (bb.minX / geo.aspect) * w;
            const bx1 = (bb.maxX / geo.aspect) * w;
            const by0 = bb.minY * h;
            const by1 = bb.maxY * h;
            const maxSnapX = w * 0.24;
            const maxSnapY = h * 0.24;

            if (tg.mode === 'word-split') {
                const distL = Math.abs(tg.seamX - bx0);
                const distR = Math.abs(tg.seamX - bx1);
                const rawShiftX = (distR <= distL ? (tg.seamX - bx1) : (tg.seamX - bx0)) * 0.65;
                ox += Math.max(-maxSnapX, Math.min(maxSnapX, rawShiftX));
            } else if (tg.mode === 'baseline-lock') {
                const distT = Math.abs(tg.horizonY - by0);
                const distB = Math.abs(tg.horizonY - by1);
                const rawShiftY = (distB <= distT ? (tg.horizonY - by1) : (tg.horizonY - by0)) * 0.65;
                oy += Math.max(-maxSnapY, Math.min(maxSnapY, rawShiftY));
            } else {
                const rawShiftX = (tg.stemLeftX - bx0) * 0.55;
                ox += Math.max(-maxSnapX, Math.min(maxSnapX, rawShiftX));
            }
        }
        return { ox, oy };
    }

    _traceMassPath(ctx, mass, geo, ox, oy, w, h) {
        ctx.beginPath();
        const pts = mass.points;
        for (let i = 0; i < pts.length; i++) {
            const px = (pts[i].x / geo.aspect) * w + ox;
            const py = pts[i].y * h + oy;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
    }

    _drawSolidMass(ctx, mass, geo, layout, rawShotEnter, creep, w, h, palette, isPaper = false) {
        const { ox, oy } = this._computeMassOffset(mass, rawShotEnter, creep, w, h, layout, geo);
        ctx.save();
        // 孔版套印错位：点睛色块下先压一版错位的同色深版（几何 ≤12 顶点，成本可忽略）
        // ★ 此前用 rgba(0,0,0,0.38) 纯黑 + 6‰ 屏幕长边偏移 —— 在深底上读起来像投影而非套印；
        //   改为 accent 压暗 55% 的深版油墨，偏移收到 3.5‰，才是纸上"第二次过版"的质感。
        if (mass.isAccent && !isPaper) {
            const reg = Math.max(2.5, Math.min(w, h) * 0.0035);
            this._traceMassPath(ctx, mass, geo, ox + reg, oy + reg, w, h);
            ctx.fillStyle = palette.polarity === 'paper'
                ? mixHex(palette.accent, palette.darkInk, 0.55)
                : mixHex(palette.accent, '#000000', 0.55);
            const prevA = ctx.globalAlpha;
            if (palette.polarity === 'paper') ctx.globalAlpha = prevA * 0.85;
            ctx.fill();
            ctx.globalAlpha = prevA;
        }
        this._traceMassPath(ctx, mass, geo, ox, oy, w, h);

        if (isPaper) {
            ctx.fillStyle = palette.paper;
        } else if (mass.isAccent) {
            ctx.fillStyle = palette.accent;
        } else {
            ctx.fillStyle = palette.tones[mass.tone % palette.tones.length] || palette.tones[0];
        }
        ctx.fill();

        if (mass.hasSeam) {
            ctx.strokeStyle = isPaper ? palette.darkInk : palette.seam;
            ctx.lineWidth = isPaper ? 1.8 : 1.3;
            ctx.stroke();
        }

        // 零 clip 瑞士建筑百叶标尺（彻底消除多边形 ctx.clip + 旋转纹理填充造成的 GPU 掉帧）
        if (mass.hasHatch && this.opts.astrolabeHatch > 0.05 && geo.densityTier !== 'sparse') {
            this._drawMassHatch(ctx, mass, geo, ox, oy, w, h, isPaper ? palette.darkInk : palette.seam);
        }
        ctx.restore();
    }

    _drawInvertedMassWithText(ctx, shot, layout, mass, geo, rawShotEnter, creep, timeMs, w, h, palette, hasPlates) {
        const { ox, oy } = this._computeMassOffset(mass, rawShotEnter, creep, w, h, layout, geo);
        ctx.save();
        this._traceMassPath(ctx, mass, geo, ox, oy, w, h);
        ctx.fillStyle = palette.paper;
        ctx.fill();

        ctx.save();
        ctx.clip();
        // 在反色块 clip 内直接投射暗墨文字底板（不叠加排线栅格，既保持羊皮纸纯净对比度，又彻底消除 clip 内栅格重绘卡顿！）
        if (hasPlates) {
            this._blitPlate(ctx, this._plateDark, layout.dirtyRect);
        } else {
            this._drawShotGlyphsToPlate(ctx, shot, layout, true, timeMs, palette);
        }
        ctx.restore();

        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 2.0;
        ctx.stroke();
        ctx.restore();
    }

    _drawMassHatch(ctx, mass, geo, ox, oy, w, h, strokeColor) {
        // 瑞士国际主义建筑百叶条（7 条等距平行结构标尺，单次 beginPath + stroke，零 clip、零离屏纹理开销）
        const bb = mass.bbox;
        const bx0 = Math.max(w * 0.04, (bb.minX / geo.aspect) * w + ox);
        const by0 = Math.max(h * 0.06, bb.minY * h + oy);
        const bx1 = Math.min(w * 0.96, (bb.maxX / geo.aspect) * w + ox);
        const by1 = Math.min(h * 0.94, bb.maxY * h + oy);
        const cx = (bx0 + bx1) * 0.5;
        const cy = (by0 + by1) * 0.5;
        const barLen = Math.min(Math.max(w, h) * 0.16, Math.hypot(bx1 - bx0, by1 - by0) * 0.28);
        const stepPx = Math.max(10, Math.round(14 / Math.max(0.4, this.opts.astrolabeHatch)));
        const ang = mass.hatchAngle || 0.6;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const nx = -sin;
        const ny = cos;

        ctx.beginPath();
        for (let i = -3; i <= 3; i++) {
            const px = cx + nx * (i * stepPx);
            const py = cy + ny * (i * stepPx);
            ctx.moveTo(px - cos * barLen, py - sin * barLen);
            ctx.lineTo(px + cos * barLen, py + sin * barLen);
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.25;
        ctx.stroke();
    }

    _drawStructuralMarks(ctx, shot, geo, layout, creep, w, h, palette) {
        ctx.save();
        const tg = layout?.typoGrid;

        // 1. 瑞士海报「网格与字的对话」：斜割线不再是网格的替代品，而是底纹张力；
        //    网格线则在文字真实基线（horizonY）与词间切缝（seamX / stemLeftX）处断开成 L 形交点，
        //    避免"在画面之上又盖了一层十字准星"的 overlay 感。
        if (tg && geo.lines.length > 0) {
            ctx.save();
            ctx.globalAlpha *= 0.62;
            for (let i = 0; i < geo.lines.length; i++) {
                const ln = geo.lines[i];
                ctx.beginPath();
                ctx.moveTo((ln.x1 / geo.aspect) * w, ln.y1 * h);
                ctx.lineTo((ln.x2 / geo.aspect) * w, ln.y2 * h);
                ctx.strokeStyle = ln.isAccent ? palette.accent : palette.seam;
                ctx.lineWidth = ln.weight || 1.4;
                ctx.stroke();
            }
            ctx.restore();

            const axisX = tg.mode === 'stem-lock' && Number.isFinite(tg.stemLeftX)
                ? tg.stemLeftX
                : (Number.isFinite(tg.seamX) ? tg.seamX : w * 0.38);
            const horizonY = Number.isFinite(tg.horizonY) ? tg.horizonY : h * 0.52;
            const gap = 9;

            // 基线在切缝处断开（排版规则线被轴切断），而不是贯穿全幅
            ctx.beginPath();
            ctx.moveTo(w * 0.05, horizonY);
            ctx.lineTo(Math.max(w * 0.05, axisX - gap), horizonY);
            ctx.moveTo(Math.min(w * 0.95, axisX + gap), horizonY);
            ctx.lineTo(w * 0.95, horizonY);
            ctx.strokeStyle = palette.seam;
            ctx.lineWidth = 1.2;
            ctx.stroke();

            if (geo.densityTier !== 'sparse') {
                ctx.strokeStyle = palette.accent;
                ctx.lineWidth = 1.1;
                ctx.beginPath();
                if (tg.mode === 'stem-lock') {
                    // 主词左缘的贯穿竖轴（铭文柱）
                    ctx.moveTo(axisX, h * 0.07);
                    ctx.lineTo(axisX, h * 0.93);
                } else if (tg.mode === 'word-split') {
                    // 词间切缝：只从版心上沿落到基线，形成 L 形交点
                    ctx.moveTo(axisX, h * 0.07);
                    ctx.lineTo(axisX, Math.max(h * 0.07, horizonY - gap));
                }
                ctx.stroke();

                if (tg.mode !== 'baseline-lock') {
                    ctx.fillStyle = palette.accent;
                    ctx.fillRect(axisX - 3.5, horizonY - 3.5, 7, 7);
                    ctx.beginPath();
                    ctx.moveTo(axisX, horizonY + 7);
                    ctx.lineTo(axisX, horizonY + 15);
                    ctx.lineWidth = 1.1;
                    ctx.stroke();
                } else {
                    // baseline-lock：只在基线左端压一个实心锚，强调"文字坐在基线上"
                    ctx.fillStyle = palette.accent;
                    ctx.fillRect(w * 0.05 - 1, horizonY - 3, 6, 6);
                }
            }
        } else {
            for (let i = 0; i < geo.lines.length; i++) {
                const ln = geo.lines[i];
                ctx.beginPath();
                ctx.moveTo((ln.x1 / geo.aspect) * w, ln.y1 * h);
                ctx.lineTo((ln.x2 / geo.aspect) * w, ln.y2 * h);
                ctx.strokeStyle = ln.isAccent ? palette.accent : palette.seam;
                ctx.lineWidth = ln.weight || 1.4;
                ctx.stroke();
            }
        }

        // 极简留白镜（sparse）不绘制任何冗余标尺与母题，留出纯粹呼吸空间
        if (geo.densityTier === 'sparse') {
            ctx.restore();
            return;
        }

        for (let i = 0; i < geo.marks.length; i++) {
            const mk = geo.marks[i];
            if (mk.kind === 'cross-row') {
                ctx.strokeStyle = palette.ink;
                ctx.lineWidth = 1.4;
                const arm = Math.min(w, h) * 0.0065;
                ctx.beginPath();
                for (let c = 0; c < mk.count; c++) {
                    const cx = ((mk.x + c * mk.gap) / geo.aspect) * w + creep * 12;
                    const cy = mk.y * h;
                    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
                    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
                }
                ctx.stroke();
            } else if (mk.kind === 'dot-grid' && this.opts.astrolabeHatch > 0.1) {
                // 单次路径绘制瑞士刻度短线阵，替代 24 次独立 fillRect
                ctx.strokeStyle = palette.seam;
                ctx.lineWidth = 2.2;
                ctx.beginPath();
                for (let row = 0; row < mk.rows; row++) {
                    for (let col = 0; col < mk.cols; col++) {
                        const dx = ((mk.x + col * mk.step) / geo.aspect) * w;
                        const dy = (mk.y + row * mk.step) * h;
                        ctx.moveTo(dx - 2, dy);
                        ctx.lineTo(dx + 2, dy);
                    }
                }
                ctx.stroke();
            } else if (mk.kind === 'vernier-arc') {
                const cx = (mk.cx / geo.aspect) * w;
                const cy = mk.cy * h;
                const rad = (mk.r / geo.aspect) * w;
                const ticks = mk.ticks || 16;
                ctx.beginPath();
                for (let t = 0; t <= ticks; t++) {
                    const a = mk.startRad + ((mk.endRad - mk.startRad) * t) / ticks + creep * 0.04;
                    const len = t % 4 === 0 ? 11 : 5;
                    ctx.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
                    ctx.lineTo(cx + Math.cos(a) * (rad + len), cy + Math.sin(a) * (rad + len));
                }
                ctx.strokeStyle = palette.seam;
                ctx.lineWidth = 1.25;
                ctx.stroke();
            }
        }

        // 10 种版画与构成主义母题（shot.decorMotif）
        const motif = shot?.decorMotif || 'crop-marks-swiss';
        const onRight = (shot?.index || 0) % 2 === 0;
        const onBottom = (shot?.index || 0) % 3 !== 0;
        const mx = onRight ? w * 0.84 : w * 0.16;
        const my = onBottom ? h * 0.78 : h * 0.22;

        if (motif === 'stepped-rule-bars') {
            ctx.fillStyle = palette.accent;
            for (let b = 0; b < 5; b++) {
                const bw = (48 - b * 7) * (w / 1280);
                const bh = Math.max(2, (7 - b) * 1.1);
                const bx = onRight ? mx - bw : mx;
                ctx.fillRect(bx, my + b * 11, bw, bh);
            }
        } else if (motif === 'corner-block-frame') {
            const side = Math.min(w, h) * 0.055;
            ctx.fillStyle = palette.accent;
            ctx.fillRect(mx - side * 0.5, my - side * 0.5, side, side * 0.28);
            ctx.strokeStyle = palette.ink;
            ctx.lineWidth = 1.6;
            ctx.strokeRect(mx - side * 0.5 + 6, my - side * 0.5 + 6, side, side);
        } else if (motif === 'tangent-plumb-line') {
            const px = onRight ? w * 0.89 : w * 0.11;
            ctx.strokeStyle = palette.accent;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(px, h * 0.08);
            ctx.lineTo(px, h * 0.86);
            ctx.stroke();
            ctx.fillStyle = palette.ink;
            ctx.fillRect(px - 5, h * (0.28 + creep * 0.06), 10, 10);
        } else if (motif === 'double-chord-secant') {
            ctx.fillStyle = palette.accent;
            ctx.beginPath();
            ctx.arc(mx, my, Math.min(w, h) * 0.018, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = palette.ink;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(mx - 18, my - 18, 36, 36);
        } else if (motif === 'concentric-hairlines') {
            const edgeX = onRight ? w * 1.12 : -w * 0.12;
            const edgeY = onBottom ? h * 1.08 : -h * 0.08;
            const baseR = Math.hypot(w, h) * 0.34;
            ctx.strokeStyle = palette.seam;
            ctx.lineWidth = 1.1;
            for (let r = 0; r < 3; r++) {
                ctx.beginPath();
                ctx.arc(edgeX, edgeY, baseR + r * 22, 0, Math.PI * 2);
                ctx.stroke();
            }
        } else if (motif === 'bauhaus-cross-grid') {
            ctx.strokeStyle = palette.accent;
            ctx.lineWidth = 2.0;
            const s = 11;
            for (let k = -1; k <= 1; k++) {
                const cx = mx + k * 28;
                ctx.beginPath();
                ctx.moveTo(cx - s, my - s); ctx.lineTo(cx + s, my + s);
                ctx.moveTo(cx + s, my - s); ctx.lineTo(cx - s, my + s);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _renderShotTextPlates(shot, layout, timeMs, palette) {
        if (!this._plateLightCtx || !this._plateLight || !layout.dirtyRect) return false;
        const dr = layout.dirtyRect;
        const dpr = this._dpr;

        const lCtx = this._plateLightCtx;
        lCtx.save();
        lCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lCtx.clearRect(dr.x, dr.y, dr.w, dr.h);
        this._drawShotGlyphsToPlate(lCtx, shot, layout, false, timeMs, palette);
        lCtx.restore();

        if (this.opts.astrolabeInversion && this._plateDarkCtx) {
            const dCtx = this._plateDarkCtx;
            dCtx.save();
            dCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            dCtx.clearRect(dr.x, dr.y, dr.w, dr.h);
            this._drawShotGlyphsToPlate(dCtx, shot, layout, true, timeMs, palette);
            dCtx.restore();
        }
        return true;
    }

    _blitPlate(ctx, plate, dr) {
        if (!plate || !dr) return;
        const dpr = this._dpr;
        ctx.drawImage(plate, dr.x * dpr, dr.y * dpr, dr.w * dpr, dr.h * dpr, dr.x, dr.y, dr.w, dr.h);
    }

    _drawShotGlyphsToPlate(ctx, shot, layout, invert, timeMs, palette) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let curPx = -1;

        // 瑞士海报主词压线/铭文竖栏标尺（Hero Word Editorial Rule / Pillar）
        if (layout.heroBox) {
            const hb = layout.heroBox;
            const hbEnter = easeAstrolabeEnter(clamp01((timeMs - shot.startTimeMs) / 380));
            if (hbEnter > 0.02) {
                ctx.save();
                ctx.globalAlpha = hbEnter * 0.92;
                ctx.fillStyle = palette.accent;
                if (hb.isVerticalPillar) {
                    ctx.fillRect(hb.x - 10, hb.y, 4, hb.h * hbEnter);
                    ctx.strokeStyle = invert ? palette.darkInk : palette.ink;
                    ctx.lineWidth = 1.6;
                    ctx.strokeRect(hb.x, hb.y, hb.w, hb.h * hbEnter);
                } else {
                    const barH = Math.max(4, Math.round(layout.fontPx * 0.075));
                    ctx.fillRect(hb.x, hb.y + hb.h - barH * 0.4, hb.w * hbEnter, barH);
                }
                ctx.restore();
            }
        }

        const fullReveal = !!this._posterFullReveal;
        for (let i = 0; i < layout.glyphs.length; i++) {
            const g = layout.glyphs[i];
            const gPx = g.fontPx || layout.fontPx;
            const enterDelay = shot.startTimeMs + i * 20;
            const enterT = fullReveal ? 1 : clamp01((timeMs - enterDelay) / 340);
            if (enterT <= 0.01) continue;
            const easeE = easeAstrolabeEnter(enterT);

            const span = Math.max(140, g.end - g.start);
            const singFrac = fullReveal ? 1 : clamp01((timeMs - (g.start - 35)) / (span + 35));
            const smoothSing = singFrac * singFrac * (3 - 2 * singFrac);
            const afterglow = fullReveal ? 0.65 : (timeMs <= g.end ? smoothSing : clamp01(1 - (timeMs - g.end) / 360));
            const liftEnv = smoothSing * (0.3 + 0.7 * afterglow);

            let ox = 0;
            let oy = 0;
            let extraRot = g.rotRad || 0;
            let scaleMul = 1;
            if (enterT < 1) {
                const inv = 1 - easeE;
                if (shot.enterStyle === 'chord-shear') ox += (g.rowIndex % 2 === 0 ? -1 : 1) * inv * gPx * 0.28;
                else if (shot.enterStyle === 'step-drop') oy -= inv * gPx * 0.28;
                else if (shot.enterStyle === 'pivot-unfold') {
                    extraRot += (i % 2 === 0 ? -1 : 1) * inv * 0.22;
                    oy += inv * gPx * 0.18;
                } else if (shot.enterStyle === 'press-stamp') {
                    scaleMul = 1 + inv * 0.26;
                } else {
                    oy += inv * gPx * 0.24;
                }
            }
            if (liftEnv > 0.005) {
                oy -= liftEnv * gPx * 0.048;
            }

            if (gPx !== curPx) {
                curPx = gPx;
                ctx.font = `800 ${gPx}px ${layout.fontStack}`;
            }

            ctx.save();
            ctx.translate(g.x + ox, g.y + oy);
            if (Math.abs(extraRot) > 0.001) ctx.rotate(extraRot);
            if (Math.abs(scaleMul - 1) > 0.001) ctx.scale(scaleMul, scaleMul);
            ctx.globalAlpha = easeE;

            const halfW = Math.max(gPx * 0.38, g.w * 0.62);
            const emoSung = plateEmotionColor(g.emotionColor, invert, palette);
            const sungColor = emoSung || (invert ? palette.darkInk : palette.ink);
            const plateBg = invert ? palette.paper : palette.bg;
            const emoDim = emoSung
                ? (HEX6_RE.test(emoSung) && HEX6_RE.test(plateBg) ? mixHex(emoSung, plateBg, 0.35) : emoSung)
                : null;
            const dimColor = emoDim || (invert ? palette.dimDarkInk : palette.dimInk);

            // Tempera 同款活版套印错位叠影（Off-Register Print Ghost）：仅在主词或已唱字符下形成微妙第二印版套印感
            if (singFrac > 0.05 || g.isHero) {
                ctx.save();
                ctx.globalAlpha = easeE * (g.isHero ? 0.24 : 0.16);
                ctx.fillStyle = emoSung || (g.isHero ? palette.accent : (invert ? palette.darkInk : palette.ink));
                ctx.fillText(g.char, gPx * 0.045, gPx * 0.055);
                ctx.restore();
            }

            if (singFrac <= 0.01) {
                ctx.fillStyle = dimColor;
                ctx.fillText(g.char, 0, 0);
            } else if (singFrac >= 0.99) {
                ctx.fillStyle = sungColor;
                ctx.fillText(g.char, 0, 0);
            } else {
                const f0 = Math.max(0, smoothSing - 0.26);
                const crest = clamp01(smoothSing);
                const f1 = Math.min(1, smoothSing + 0.24);
                const sweep = ctx.createLinearGradient(-halfW, 0, halfW, 0);
                sweep.addColorStop(0, sungColor);
                sweep.addColorStop(f0, sungColor);
                sweep.addColorStop(crest, palette.accent);
                sweep.addColorStop(f1, dimColor);
                sweep.addColorStop(1, dimColor);
                ctx.fillStyle = sweep;
                ctx.fillText(g.char, 0, 0);
            }
            ctx.restore();
        }
    }

    /** 四角瑞士印刷裁切标（Crop Marks，零科幻文字） */
    _drawCropFrame(ctx, w, h, palette) {
        const padX = Math.max(24, w * 0.028);
        const padY = Math.max(22, h * 0.032);
        const arm = 16;
        ctx.save();
        ctx.strokeStyle = palette.seam;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // 左上
        ctx.moveTo(padX, padY + arm); ctx.lineTo(padX, padY); ctx.lineTo(padX + arm, padY);
        // 右上
        ctx.moveTo(w - padX - arm, padY); ctx.lineTo(w - padX, padY); ctx.lineTo(w - padX, padY + arm);
        // 左下
        ctx.moveTo(padX, h - padY - arm); ctx.lineTo(padX, h - padY); ctx.lineTo(padX + arm, h - padY);
        // 右下
        ctx.moveTo(w - padX - arm, h - padY); ctx.lineTo(w - padX, h - padY); ctx.lineTo(w - padX, h - padY - arm);
        ctx.stroke();
        ctx.restore();
    }

    _updateSubtitles(shot) {
        const srcLine = (this.lines && typeof shot.lineIndex === 'number' && this.lines[shot.lineIndex]) || null;
        const rawTr = shot.translation || (srcLine && (srcLine.translation || srcLine.trans)) || '';
        const rawRo = shot.romaji || (srcLine && (srcLine.romaji || srcLine.roma)) || '';
        const lyCfg = (typeof globalThis !== 'undefined' && globalThis.appSettings && globalThis.appSettings.lyrics) || null;
        const showTr = lyCfg && typeof lyCfg.showTranslation === 'boolean' ? lyCfg.showTranslation : this.opts.showTranslation;
        const showRo = lyCfg && typeof lyCfg.showRomaji === 'boolean' ? lyCfg.showRomaji : this.opts.showRomaji;

        const trans = (showTr && !shot.isInterlude && rawTr && String(rawTr).trim() !== '//') ? String(rawTr).trim() : '';
        const roma = (showRo && !shot.isInterlude && rawRo && String(rawRo).trim() !== '//' && String(rawRo).trim() !== trans)
            ? String(rawRo).trim()
            : '';

        const key = `${shot.lineIndex}:${roma}:${trans}`;
        if (key === this._lastDomSubKey) return;
        this._lastDomSubKey = key;

        if (typeof document !== 'undefined') {
            const flyinArea = document.getElementById('flyinTranslationArea');
            if (flyinArea) {
                const flyinTrans = document.getElementById('flyinTranslation');
                const flyinRoma = document.getElementById('flyinRomaji');
                if (flyinTrans) flyinTrans.textContent = trans;
                if (flyinRoma) flyinRoma.textContent = roma;
                flyinArea.style.opacity = (trans || roma) ? '1' : '0';
                return;
            }
        }

        if (!this._subWrap || !this._subRomajiEl || !this._subTransEl) return;
        this._subRomajiEl.textContent = roma;
        this._subRomajiEl.style.display = roma ? 'block' : 'none';
        this._subTransEl.textContent = trans;
        this._subTransEl.style.display = trans ? 'block' : 'none';
    }

    onDestroy() {
        if (this._stageEl) {
            this._stageEl.remove();
            this._stageEl = null;
        }
        this._canvas = null;
        this._ctx = null;
        this._plateLight = null;
        this._plateLightCtx = null;
        this._plateDark = null;
        this._plateDarkCtx = null;
        this._geoCache.clear();
        this._layoutCache.clear();
        this._vignetteCache.clear();
        this._grainCache.clear();
    }
}

export const astrolabeVisualizer = new AstrolabeVisualizer();
