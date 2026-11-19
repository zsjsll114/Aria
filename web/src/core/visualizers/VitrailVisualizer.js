/**
 * web/src/core/visualizers/VitrailVisualizer.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— 原生 WebGL2 3D 光学圣殿与雕刻立体歌词视觉引擎
 */

import { VisualizerBase } from './VisualizerBase.js';
import {
    resolveVitrailSongProfile,
    computeVitrailCameraPose,
    lerpVitrailPalette,
    smootherstep01,
    hexToVec3,
    mixHex,
    clamp,
} from './vitrail/vitrailProfiles.js';
import {
    compileVitrailProgram,
    findActiveVitrailShot,
    resolveVitrailSceneAtTime,
    resolveShotEmotionColors,
    wrapVitrailShotLines,
    vitrailEmotionStamp,
} from './vitrail/vitrailProgram.js';
import { composeVitrailArchitecture } from './vitrail/vitrailGeometry.js';
import { VitrailSdfAtlas } from './vitrail/vitrailAtlas.js';
import { VitrailWebGLRenderer } from './vitrail/vitrailRenderer.js';
import { sanitizeCssFontFamily } from '../../utils/fontStacks.js';
import { ensureEmotionContrast } from '../../utils/colorUtils.js';
import {
    INSTRUMENTAL_GRACE_SEC,
    buildVirtualInstrumentalLines,
    advanceInstrumental,
    instrumentalSongKey,
} from './instrumentalLines.js';
import { logCatch, logInfo } from '../../services/log.js';

const BUILTIN_FONT_MAP = {
    default: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    serif: "Georgia, 'Times New Roman', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif",
    kai: "Georgia, 'Times New Roman', 'Kaiti SC', 'STKaiti', 'KaiTi', serif",
    hei: "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', 'SimHei', sans-serif",
    fangsong: "Georgia, 'Times New Roman', 'STFangsong', 'FangSong', serif",
    mono: "'JetBrains Mono', 'Consolas', 'Courier New', 'Microsoft YaHei', monospace",
};

export function resolveVitrailFont(ff) {
    let key = ff;
    if (!key || key === 'default' || key === 'inherit') {
        const gFont = (typeof globalThis !== 'undefined' && globalThis.appSettings?.interface?.fontFamily) || '';
        if (gFont && gFont !== 'default' && gFont !== 'inherit') {
            key = gFont;
        } else if (typeof document !== 'undefined') {
            const pc = document.querySelector('.player-container');
            const inlineVis = pc?.style?.getPropertyValue('--vis-font-family')?.trim()
                || document.documentElement?.style?.getPropertyValue('--app-font-family')?.trim();
            if (inlineVis) return sanitizeCssFontFamily(inlineVis, BUILTIN_FONT_MAP.default);
            return BUILTIN_FONT_MAP.default;
        } else {
            return BUILTIN_FONT_MAP.default;
        }
    }
    if (BUILTIN_FONT_MAP[key]) return BUILTIN_FONT_MAP[key];
    if (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
        try {
            const resolved = window.resolveFontFamily(key);
            if (resolved) return sanitizeCssFontFamily(resolved, BUILTIN_FONT_MAP.default);
        } catch (e) {
            logCatch('vitrailFont', e);
        }
    }
    return sanitizeCssFontFamily(key, BUILTIN_FONT_MAP.default);
}

export class VitrailVisualizer extends VisualizerBase {
    constructor(container, options = {}) {
        super(container, options);
        this.opts = {
            fontSize: 1.0,
            highlightColor: '#f3d58b',
            themeColor: '#E8BE6A',
            fontFamily: 'default',
            showTranslation: true,
            showRomaji: true,
            vitrailPreset: 'auto',
            vitrailArchitecture: 'auto',
            vitrailCamera: 0.85,
            vitrailLighting: 0.90,
            vitrailReflection: true,
            vitrailParticles: true,
            vitrailParallax: true,
            vitrailQuality: 'auto',
        };

        /** @type {HTMLCanvasElement|null} */ this._canvas = null;
        /** @type {CanvasRenderingContext2D|null} */ this._fallbackCtx = null;
        /** @type {VitrailWebGLRenderer|null} */ this._renderer = null;
        /** @type {VitrailSdfAtlas|null} */ this._atlas = null;
        /** @type {HTMLElement|null} */ this._subtitlesEl = null;
        /** @type {HTMLElement|null} */ this._subSlotEl = null;
        /** @type {HTMLElement|null} */ this._subGhostEl = null;
        /** @type {HTMLElement|null} */ this._subRomajiEl = null;
        /** @type {HTMLElement|null} */ this._subTransEl = null;
        /** @type {HTMLElement|null} */ this._subGhostRomajiEl = null;
        /** @type {HTMLElement|null} */ this._subGhostTransEl = null;
        this._lastRenderedSub = { roma: '', trans: '' };
        /** @type {ResizeObserver|null} */ this._ro = null;

        this._songProfile = null;
        this._program = null;
        this._programDirty = true;
        this._lastEmotionStamp = '';
        this._lastBuiltArch = '';
        this._lastFontStack = '';
        this._lastDomSubKey = '';
        this._lastCoverKey = '';

        this._destroyed = false;
        this._useFallback2d = false;
        this._raf = 0;
        this._perfTier = 'high';
        this._adaptiveScale = 1.0;
        this._slowFrameStreak = 0;

        this._lastFramePerf = 0;
        this._lastRawPerf = 0;
        this._lastRawMediaMs = 0;
        this._smoothMediaMs = 0;
        this._lastSyncTimeMs = 0;

        this._ptrTargetX = 0;
        this._ptrTargetY = 0;
        this._ptrX = 0;
        this._ptrY = 0;
        this._onPointerMove = null;
        this._onPointerLeave = null;

        this._freqBuf = new Uint8Array(64);
        this._audio = { bass: 0, mid: 0, treble: 0, energy: 0 };
        this._instState = { instrumental: false, watch: null };
        this._hasVocals = false;
        this._shotEmotionCache = new Map();
        this._sceneBundleCache = new Map();
        this._manualTransition = null;
        this._manualRaf = 0;
        this._activeVisualArch = '';
        this._activeVisualPalette = null;
        this._camSmooth = null;
        this._lightSmooth = null;
        this._cameraSnapPending = true;
        this._lastCamPerf = 0;
        this._lastRenderPerf = 0;
        this._scrimAnim = null;
        this._subEnterRaf = 0;
        this._subGhostRaf = 0;
        this._subGhostTimer = 0;
        this._lastRenderWidth = 0;
        this._lastRenderHeight = 0;
    }

    getModeId() {
        return 'vitrail';
    }

    _isPreviewStage() {
        return Boolean(this.viewContainer && this.viewContainer.closest('.preview-player'));
    }

    onInit() {
        if (!this.viewContainer || typeof document === 'undefined') return;
        this._destroyed = false;

        const stage = document.createElement('div');
        stage.className = 'vis-vitrail-stage';

        const canvas = document.createElement('canvas');
        canvas.className = 'vis-vitrail-canvas';
        stage.appendChild(canvas);

        const subs = document.createElement('div');
        subs.className = 'vis-vitrail-subtitles';
        const ghost = document.createElement('div');
        ghost.className = 'vis-vitrail-sub-ghost is-leaving';
        ghost.style.display = 'none';
        const ghostRomaji = document.createElement('div');
        ghostRomaji.className = 'vis-vitrail-sub-romaji';
        const ghostTrans = document.createElement('div');
        ghostTrans.className = 'vis-vitrail-sub-trans';
        ghost.appendChild(ghostRomaji);
        ghost.appendChild(ghostTrans);

        const slot = document.createElement('div');
        slot.className = 'vis-vitrail-sub-slot';
        const romajiEl = document.createElement('div');
        romajiEl.className = 'vis-vitrail-sub-romaji';
        const transEl = document.createElement('div');
        transEl.className = 'vis-vitrail-sub-trans';
        slot.appendChild(romajiEl);
        slot.appendChild(transEl);

        subs.appendChild(ghost);
        subs.appendChild(slot);

        stage.appendChild(subs);
        this.viewContainer.appendChild(stage);
        this._canvas = canvas;
        this._subtitlesEl = subs;
        this._subSlotEl = slot;
        this._subGhostEl = ghost;
        this._subRomajiEl = romajiEl;
        this._subTransEl = transEl;
        this._subGhostRomajiEl = ghostRomaji;
        this._subGhostTransEl = ghostTrans;

        // 初始化线性时间 SDF 图集 + WebGL2 多通道管线（不可用时无感切换精致 2D 透视兜底）
        const isPreview = this._isPreviewStage();
        this._atlas = new VitrailSdfAtlas({
            cellSize: isPreview ? 96 : 128,
            cols: isPreview ? 10 : 12,
            spread: isPreview ? 11 : 14,
        });
        this._songProfile = resolveVitrailSongProfile({
            lyrics: this.lines,
            aiData: this.aiData,
            coverPalette: typeof globalThis !== 'undefined' ? globalThis.coverPalette : null,
            songData: typeof globalThis !== 'undefined' ? globalThis.currentSongData : null,
            presetOverride: this.opts.vitrailPreset,
            archOverride: this.opts.vitrailArchitecture,
        });
        const sceneBundle = this._getSceneBundle(this._songProfile.archetype);
        this._lastBuiltArch = this._songProfile.archetype;
        this._activeVisualArch = this._songProfile.archetype;
        this._activeVisualPalette = this._songProfile.palette;

        const renderer = new VitrailWebGLRenderer(canvas);
        const ok = renderer.init(sceneBundle);
        if (ok) {
            this._renderer = renderer;
            this._useFallback2d = false;
            logInfo('vitrail', `WebGL2 光学圣殿就绪（原型: ${this._songProfile.archetype} · 色板: ${this._songProfile.palette.key}）`);
        } else {
            renderer.destroy();
            this._renderer = null;
            this._useFallback2d = true;
            this._fallbackCtx = canvas.getContext('2d');
            logInfo('vitrail', 'WebGL2 不可用，已切换琉璃龛 2D 圣光架构兜底模式');
        }

        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(() => this.handleResize());
            this._ro.observe(this.viewContainer);
        }

        if (!isPreview && this.container) {
            this._onPointerMove = (e) => {
                if (!this.opts.vitrailParallax) return;
                const rect = this.container.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                this._ptrTargetX = clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
                this._ptrTargetY = clamp((0.5 - (e.clientY - rect.top) / rect.height) * 2, -1, 1);
            };
            this._onPointerLeave = () => {
                this._ptrTargetX = 0;
                this._ptrTargetY = 0;
            };
            this.container.addEventListener('pointermove', this._onPointerMove, { passive: true });
            this.container.addEventListener('pointerleave', this._onPointerLeave, { passive: true });
        }

        this.handleResize();
    }

    setPerfConfig(cfg = {}) {
        if (typeof document !== 'undefined') {
            const root = document.documentElement;
            const body = document.body;
            if (root?.classList.contains('is-software-renderer') || body?.classList.contains('perf-minimal')) {
                this._perfTier = 'low';
                return;
            }
            if (body?.classList.contains('perf-low')) {
                this._perfTier = 'medium';
                return;
            }
        }
        const vfx = cfg?.vfx || {};
        if (vfx.shadows === false && vfx.blur === false) this._perfTier = 'low';
        else this._perfTier = 'high';
    }

    onLyricsLoaded() {
        const real = (this.lines || []).filter((l) => String(l?.original ?? l?.text ?? '').trim().length > 0);
        this._hasVocals = real.length > 0;
        this._programDirty = true;
        this._manualTransition = null;
        this._cameraSnapPending = true;
        this._camSmooth = null;
        this._lightSmooth = null;
        this._scrimAnim = null;
        this._shotEmotionCache.clear();
        this._lastDomSubKey = '';
        this._lastDomTextKey = '';
        this._lastRenderedSub = { roma: '', trans: '' };
        this._instState = { instrumental: false, watch: null };
        this._ensureProgram();
        this._renderCurrentFrame();
    }

    onApplySettings(settings = {}) {
        const s = settings || {};
        const prevArch = this.opts.vitrailArchitecture;
        const prevPreset = this.opts.vitrailPreset;
        const prevFont = this.opts.fontFamily;
        const prevHl = this.opts.highlightColor;
        Object.assign(this.opts, s);

        const sceneSettingChanged = this.opts.vitrailArchitecture !== prevArch || this.opts.vitrailPreset !== prevPreset;
        if (sceneSettingChanged) {
            if (this._activeVisualArch && this._activeVisualPalette) {
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                this._manualTransition = {
                    fromArch: this._activeVisualArch,
                    fromPalette: { ...this._activeVisualPalette },
                    startPerf: now,
                    durationMs: 1650,
                };
            }
            this._programDirty = true;
        }
        if (this.opts.fontFamily !== prevFont && this._atlas) {
            const stack = resolveVitrailFont(this.opts.fontFamily);
            this._atlas.setFontStack(stack);
            this._lastFontStack = stack;
        }
        if (this.opts.highlightColor !== prevHl) {
            this._shotEmotionCache.clear();
        }
        this._lastDomSubKey = '';
        if (!this.isRunning && this._canvas) {
            this._renderCurrentFrame();
            if (sceneSettingChanged) {
                this._driveManualTransitionIfPaused();
            }
        }
    }

    start() {
        if (this.isRunning) return;
        if (this._manualRaf) {
            cancelAnimationFrame(this._manualRaf);
            this._manualRaf = 0;
        }
        super.start();
        this._lastFramePerf = 0;
        this._lastRawPerf = 0;
        this._cameraSnapPending = true;
        const loop = (now) => {
            if (!this.isRunning || this._destroyed) return;
            this._renderCurrentFrame(now);
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
        if (this._manualRaf) {
            cancelAnimationFrame(this._manualRaf);
            this._manualRaf = 0;
        }
    }

    /**
     * 海报抓帧前将琉璃龛定格到当前/目标句完整显形的保持时刻。
     * @param {number} [targetLineIndex]
     * @returns {(() => void)|null}
     */
    stageForPoster(targetLineIndex) {
        if (this._destroyed || !this._canvas) return null;
        const prevRunning = this.isRunning;
        const prevHold = this._posterHoldSec;
        const prevSnap = this._cameraSnapPending;
        const lines = Array.isArray(this.lines) ? this.lines : [];
        const isMs = lines.some((l) => l && typeof l.start === 'number' && l.start >= 1000);
        const div = isMs ? 1000 : 1;
        const curSec = this._extrapolatedTimeSec();
        let holdSec = curSec;
        const fallbackIdx = Math.max(0, Math.min(lines.length - 1, Number(globalThis.activeLineIndex) || 0));
        const line = (Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && lines[targetLineIndex])
            ? lines[targetLineIndex]
            : lines.find((l) => {
                const st = Number(l?.start ?? l?.time ?? 0) / div;
                const ed = l?.end != null ? Number(l.end) / div : st + 3.0;
                return curSec >= st && curSec <= ed;
            }) || lines[fallbackIdx];
        if (line) {
            const st = Number(line.start ?? line.time ?? 0) / div;
            const ed = line.end != null ? Number(line.end) / div : st + 3.0;
            const span = Math.max(0.2, ed - st);
            holdSec = st + Math.max(0.08, Math.min(span - 0.12, span * 0.72));
        }
        if (prevRunning) this.stop();
        this._posterHoldSec = holdSec;
        this._cameraSnapPending = true;
        this._renderCurrentFrame();
        return () => {
            this._posterHoldSec = prevHold;
            this._cameraSnapPending = prevSnap;
            if (prevRunning && !this._destroyed) this.start();
            else if (!this._destroyed) this._renderCurrentFrame();
        };
    }

    update(currentTimeSec = 0) {
        const timeMs = Math.max(0, (Number(currentTimeSec) || 0) * 1000);
        const deltaMedia = timeMs - this._lastSyncTimeMs;
        this._lastSyncTimeMs = timeMs;
        if (Math.abs(deltaMedia) >= 1200 || this._isPreviewStage()) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this._smoothMediaMs = timeMs;
            this._lastRawMediaMs = timeMs;
            this._lastRawPerf = now;
            this._cameraSnapPending = true;
        }
        if (!this.isRunning || this._isPreviewStage()) {
            this._renderCurrentFrame();
        }
    }

    onResize() {
        if (!this.isRunning && this._canvas) {
            this._renderCurrentFrame();
        }
    }

    _extrapolatedTimeSec() {
        if (this._posterHoldSec !== undefined && this._posterHoldSec !== null) {
            return this._posterHoldSec;
        }
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const dt = this._lastFramePerf > 0 ? Math.max(0, Math.min(50, now - this._lastFramePerf)) : 16.67;
        this._lastFramePerf = now;

        if (this._isPreviewStage()) {
            return this._lastSyncTimeMs / 1000;
        }
        if (typeof globalThis !== 'undefined' && globalThis.audio) {
            const audioEl = globalThis.audio;
            const offsetMs = Number(globalThis.lyricOffset) || 0;
            const elMs = Math.max(0, (Number(audioEl.currentTime) || 0) * 1000 + offsetMs);
            const rawMs = (audioEl.readyState === 0 && audioEl.paused && this._lastSyncTimeMs > 0)
                ? this._lastSyncTimeMs
                : elMs;
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
                    this._smoothMediaMs += Math.max(0, dt * rate + err * 0.14);
                }
                return this._smoothMediaMs / 1000;
            }
            this._smoothMediaMs = rawMs;
            return rawMs / 1000;
        }
        return this._lastSyncTimeMs / 1000;
    }

    _resolveQualityTier() {
        if (this._isPreviewStage()) return 'balanced';
        const q = this.opts.vitrailQuality || 'auto';
        if (q === 'high' || q === 'balanced' || q === 'lite') return q;
        if (this._perfTier === 'low') return 'lite';
        if (this._perfTier === 'medium') return 'balanced';
        return 'high';
    }

    _getSceneBundle(arch) {
        const key = arch || 'cathedral';
        if (this._sceneBundleCache.has(key)) {
            return this._sceneBundleCache.get(key);
        }
        const bundle = composeVitrailArchitecture(key);
        this._sceneBundleCache.set(key, bundle);
        return bundle;
    }

    _warmupNextSuiteScene(qualityTier = 'high') {
        if (!this._renderer || !this._renderer.ready || !Array.isArray(this._songProfile?.suite)) return;
        let warmed = false;
        for (const item of this._songProfile.suite) {
            const arch = item?.archetype;
            if (arch && !this._renderer.hasCachedScene(arch)) {
                this._renderer.ensureSceneCached(this._getSceneBundle(arch));
                warmed = true;
                break;
            }
        }
        // 在尚未进入溶解窗口前预先创建 Dual-FBO，消除换幕首帧纹理与深度缓冲分配卡顿
        if (!warmed && qualityTier !== 'lite' && this._songProfile.suite.length > 1) {
            this._renderer.prewarmTransitionFbos();
        }
    }

    _driveManualTransitionIfPaused() {
        if (this.isRunning || this._destroyed || !this._manualTransition || this._manualRaf) return;
        if (typeof requestAnimationFrame !== 'function') return;
        const step = (now) => {
            this._manualRaf = 0;
            if (this.isRunning || this._destroyed || !this._manualTransition) return;
            this._renderCurrentFrame(now);
            if (this._manualTransition) {
                this._manualRaf = requestAnimationFrame(step);
            }
        };
        this._manualRaf = requestAnimationFrame(step);
    }

    _ensureProgram(timeSec = 0) {
        const g = typeof globalThis !== 'undefined' ? globalThis : null;
        const songData = g?.currentSongData || {};
        const cov = g?.coverPalette || null;
        const coverKey = `${songData?.title || ''}|${songData?.artist || ''}|${cov?.primary || ''}|${cov?.accent || ''}|${this.opts.vitrailPreset}|${this.opts.vitrailArchitecture}`;
        const emotionStamp = vitrailEmotionStamp(this.aiData);

        if (emotionStamp !== this._lastEmotionStamp) {
            this._lastEmotionStamp = emotionStamp;
            this._shotEmotionCache.clear();
        }

        // 若无歌词行且持续播放/等待，启用虚拟 ♪ 间奏线保护
        const instNext = advanceInstrumental(this._instState, {
            hasWords: this._hasVocals,
            timeSec,
            songKey: instrumentalSongKey(songData),
            graceSec: INSTRUMENTAL_GRACE_SEC,
        });
        const instFlipped = instNext.instrumental !== this._instState.instrumental;
        this._instState = instNext;

        if (!this._programDirty && coverKey === this._lastCoverKey && !instFlipped && this._program) {
            return;
        }
        this._lastCoverKey = coverKey;
        this._programDirty = false;

        const effectiveLines = this._hasVocals
            ? this.lines
            : buildVirtualInstrumentalLines('virtual-vitrail-', 60, 8, 6);

        this._songProfile = resolveVitrailSongProfile({
            lyrics: effectiveLines,
            aiData: this.aiData,
            coverPalette: cov,
            songData,
            presetOverride: this.opts.vitrailPreset,
            archOverride: this.opts.vitrailArchitecture,
        });

        this._program = compileVitrailProgram({
            lines: effectiveLines,
            aiData: this.aiData,
            songProfile: this._songProfile,
            songData,
        });
        this._shotEmotionCache.clear();

        if (this._renderer && this._songProfile.archetype !== this._lastBuiltArch) {
            this._lastBuiltArch = this._songProfile.archetype;
            const bundle = this._getSceneBundle(this._songProfile.archetype);
            // 若正处于手动过渡中，仅预先缓存新建筑几何而不立即跳切，交由 Dual-FBO 逐帧溶解完成
            if (this._manualTransition) {
                this._renderer.ensureSceneCached(bundle);
            } else {
                this._renderer.uploadSceneGeometry(bundle);
            }
        }
    }

    _sampleAudio(dtFrame = 0.016) {
        const g = typeof globalThis !== 'undefined' ? globalThis : null;
        const analyser = g?.playerAudioAnalyser || null;
        let bass = 0, mid = 0, treble = 0;
        if (analyser && typeof analyser.getByteFrequencyData === 'function') {
            try {
                const len = Math.min(this._freqBuf.length, analyser.frequencyBinCount || 64);
                analyser.getByteFrequencyData(this._freqBuf);
                let bSum = 0, mSum = 0, tSum = 0;
                const bEnd = Math.max(2, Math.floor(len * 0.14));
                const mEnd = Math.max(bEnd + 2, Math.floor(len * 0.48));
                for (let i = 0; i < bEnd; i++) bSum += this._freqBuf[i];
                for (let i = bEnd; i < mEnd; i++) mSum += this._freqBuf[i];
                for (let i = mEnd; i < len; i++) tSum += this._freqBuf[i];
                bass = (bSum / Math.max(1, bEnd)) / 255;
                mid = (mSum / Math.max(1, mEnd - bEnd)) / 255;
                treble = (tSum / Math.max(1, len - mEnd)) / 255;
            } catch (e) {
                logCatch('vitrail.audio', e);
            }
        }
        const a = this._audio;
        const kLow = 1 - Math.exp(-dtFrame * 14.5);
        const kHigh = 1 - Math.exp(-dtFrame * 18.0);
        a.bass += (bass - a.bass) * kLow;
        a.mid += (mid - a.mid) * kLow;
        a.treble += (treble - a.treble) * kHigh;
        a.energy = clamp(a.bass * 0.5 + a.mid * 0.35 + a.treble * 0.15, 0, 1);
        return a;
    }

    /**
     * 为当前歌词分镜构建 3D 雕刻文字四边体与实时光源追踪点（支持前后句立体交叉承接与渐隐柔化）
     */
    _build3dTypography(shot, prevShot, nextShot, timeSec, palette, aspect, dtFrame = 0.016) {
        if (!shot || !this._atlas) return { quads: [], scrim: null, lights: [] };
        const fontStack = resolveVitrailFont(this.opts.fontFamily);
        if (fontStack !== this._lastFontStack) {
            this._lastFontStack = fontStack;
            this._atlas.setFontStack(fontStack);
        }

        // 预热下一镜与下两镜字形，防止快歌连续短句在切句瞬间临时烘焙导致微卡顿
        if (nextShot?.text) {
            this._atlas.warmCharacters(Array.from(nextShot.text), 6);
        }
        const shotAhead2 = this._program?.shots?.[shot.index + 2];
        if (shotAhead2?.text) {
            this._atlas.warmCharacters(Array.from(shotAhead2.text), 3);
        }

        const isPreview = this._isPreviewStage();
        const pal = palette;
        const lightMix = Number.isFinite(pal.lightMix) ? pal.lightMix : (pal.isLight ? 1 : 0);
        const smoothLightT = smootherstep01(clamp((lightMix - 0.25) / 0.50, 0, 1));
        const isLightPal = lightMix >= 0.5;
        const rawHighlight = this.opts.highlightColor || pal.accent;
        const bgRef = mixHex('#12151c', '#efe8da', smoothLightT);
        const safeHighlightHex = ensureEmotionContrast(rawHighlight, bgRef, 5.2);
        const inkBaseRgb = hexToVec3(mixHex('#ebe4d6', '#231e18', smoothLightT));
        const inkSungRgb = hexToVec3(safeHighlightHex);

        const userScale = clamp(Number(this.opts.fontSize ?? 1.0), 0.7, 1.6);
        const prepareShotRows = (targetShot) => {
            if (targetShot.kind === 'interlude' || targetShot.kind === 'colophon') {
                const titleText = String(targetShot.text || 'ARIA').slice(0, 26);
                const chars = Array.from(titleText);
                const items = chars.map((ch) => ({
                    char: ch,
                    start: targetShot.startSec * 1000,
                    end: (targetShot.startSec + 0.8) * 1000,
                    emotionColor: null,
                }));
                return {
                    rows: [{ items, units: chars.length * 0.72 }],
                    extraScale: 0.78,
                };
            }

            let emColors = this._shotEmotionCache.get(targetShot.index);
            if (!emColors) {
                emColors = resolveShotEmotionColors(targetShot, this.aiData, pal);
                this._shotEmotionCache.set(targetShot.index, emColors);
            }
            return {
                rows: wrapVitrailShotLines(targetShot.graphemes, emColors, isPreview ? 11.5 : 14.5),
                extraScale: 1.0,
            };
        };

        const layoutPrepared = (targetShot, prepared, animCfg) => this._layoutRowsTo3d(
            prepared.rows,
            timeSec,
            targetShot,
            inkBaseRgb,
            inkSungRgb,
            isLightPal,
            animCfg,
            aspect,
            isPreview,
            prepared.extraScale,
        );

        const computePairTransition = (sOut, rowsOut, sIn, rowsIn) => {
            const durOut = Math.max(0.35, (sOut.endSec || 0) - (sOut.startSec || 0));
            const durIn = Math.max(0.35, (sIn.endSec || 0) - (sIn.startSec || 0));
            const preLead = !isPreview ? Math.min(0.14, durOut * 0.28) : 0;
            const outDur = clamp(durOut * 0.48, 0.38, 0.56);
            const totalExit = Math.max(0.20, preLead + outDur);
            const inDur = clamp(durIn * 0.38, 0.28, 0.42);
            const pairRows = (Math.max(1, rowsOut) + Math.max(1, rowsIn)) * 0.5;
            const minCenterGap = (pairRows * 0.95 + 0.24) * userScale;
            const upSpan = Math.max(1.32 * userScale, minCenterGap * 1.12);
            const inDropSpan = minCenterGap * 0.90;
            return { preLead, outDur, totalExit, inDur, upSpan, inDropSpan };
        };

        const shotDur = Math.max(0.35, (shot.endSec || 0) - (shot.startSec || 0));
        const isContinuousFromPrev = Boolean(
            prevShot
            && prevShot.index !== shot.index
            && (shot.startSec - prevShot.endSec) < 0.85,
        );
        const isContinuousToNext = Boolean(
            nextShot
            && nextShot.index !== shot.index
            && (nextShot.startSec - shot.endSec) < 0.85,
        );

        const preparedCurr = prepareShotRows(shot);
        const preparedPrev = isContinuousFromPrev ? prepareShotRows(prevShot) : null;
        const preparedNext = isContinuousToNext ? prepareShotRows(nextShot) : null;
        const prevPair = preparedPrev
            ? computePairTransition(prevShot, preparedPrev.rows.length, shot, preparedCurr.rows.length)
            : null;
        const nextPair = preparedNext
            ? computePairTransition(shot, preparedCurr.rows.length, nextShot, preparedNext.rows.length)
            : null;

        // 统一 0.85s 阈值：仅长停顿才淡出当前句尾；连续接下一句则在开唱前 140ms 起柔和上浮，零停顿零碰撞
        let tailFade = 1.0;
        if (!isContinuousToNext && shot.kind !== 'colophon' && timeSec > shot.endSec + 0.08) {
            tailFade = 1.0 - smootherstep01(clamp((timeSec - (shot.endSec + 0.08)) / 0.45, 0, 1));
        }

        let preExitY = 0;
        let preExitZ = 0;
        if (nextPair && !isPreview && nextPair.preLead > 0 && timeSec > (nextShot.startSec - nextPair.preLead)) {
            const uExit = clamp((timeSec - (nextShot.startSec - nextPair.preLead)) / nextPair.totalExit, 0, 1);
            const smoothU = smootherstep01(uExit);
            const exitEase = 1 - Math.pow(1 - smoothU, 1.35);
            const preExitAlpha = Math.pow(clamp(1 - smoothU, 0, 1), 1.25);
            preExitY = nextPair.upSpan * exitEase;
            preExitZ = -0.22 * exitEase;
            tailFade = Math.min(tailFade, preExitAlpha);
        }

        const sinceStart = timeSec - shot.startSec;
        const canOverlapPrev = Boolean(
            prevPair
            && sinceStart >= 0
            && sinceStart < prevPair.outDur,
        );

        const incoming = layoutPrepared(shot, preparedCurr, {
            isExiting: false,
            exitEase: 0,
            zShift: preExitZ,
            yShift: preExitY,
            tailFade,
            enterDelay: 0,
            preRoll: prevPair ? prevPair.preLead : 0,
            inDur: prevPair ? prevPair.inDur : clamp(shotDur * 0.38, 0.28, 0.42),
            yDropSpan: prevPair ? prevPair.inDropSpan : (0.36 * userScale),
        });

        let quads = incoming.quads;
        let lights = incoming.lights;
        let overlapPadW = incoming.bounds.padW;
        let overlapPadH = incoming.bounds.padH;

        if (canOverlapPrev && preparedPrev && prevPair) {
            const uExit = clamp((timeSec - (shot.startSec - prevPair.preLead)) / prevPair.totalExit, 0, 1);
            const smoothU = smootherstep01(uExit);
            const exitEase = 1 - Math.pow(1 - smoothU, 1.35);
            const exitAlpha = Math.pow(clamp(1 - smoothU, 0, 1), 1.25);
            const outgoing = layoutPrepared(prevShot, preparedPrev, {
                isExiting: true,
                exitEase,
                exitAlpha,
                zShift: -0.22 * exitEase,
                yShift: prevPair.upSpan * exitEase,
                tailFade: 1.0,
            });
            quads = outgoing.quads.concat(quads);
            overlapPadW = Math.max(overlapPadW, outgoing.bounds.padW * (1 - exitEase * 0.45));
            overlapPadH = Math.max(overlapPadH, incoming.bounds.padH + 0.16 * (1 - exitEase));
            if (lights.length === 0 && outgoing.lights.length > 0) {
                lights = outgoing.lights;
            }
        }

        const toNext = nextShot ? (nextShot.startSec - timeSec) : 999;
        if (nextPair && !isPreview && nextPair.preLead > 0 && toNext > 0 && toNext < nextPair.preLead) {
            const preNext = layoutPrepared(nextShot, preparedNext, {
                isExiting: false,
                exitEase: 0,
                zShift: 0,
                yShift: 0,
                tailFade: 1.0,
                enterDelay: 0,
                preRoll: nextPair.preLead,
                inDur: nextPair.inDur,
                yDropSpan: nextPair.inDropSpan,
            });
            quads = quads.concat(preNext.quads);
            overlapPadW = Math.max(overlapPadW, preNext.bounds.padW * 0.9);
            overlapPadH = Math.max(overlapPadH, incoming.bounds.padH + 0.12);
        }
        quads = quads.slice(0, 256);

        const targetB = {
            ...incoming.bounds,
            padW: overlapPadW,
            padH: overlapPadH,
        };
        if (!this._scrimAnim || this._cameraSnapPending || isPreview) {
            this._scrimAnim = { ...targetB };
        } else {
            const kScrim = 1 - Math.exp(-dtFrame * 8.5);
            this._scrimAnim.centerY += (targetB.centerY - this._scrimAnim.centerY) * kScrim;
            this._scrimAnim.padW += (targetB.padW - this._scrimAnim.padW) * kScrim;
            this._scrimAnim.padH += (targetB.padH - this._scrimAnim.padH) * kScrim;
            this._scrimAnim.planeZ += (targetB.planeZ - this._scrimAnim.planeZ) * kScrim;
        }
        const sa = this._scrimAnim;
        const scrimZ = sa.planeZ - 0.42;
        const scrim = {
            bl: [-sa.padW, sa.centerY - sa.padH, scrimZ],
            br: [sa.padW, sa.centerY - sa.padH, scrimZ],
            tr: [sa.padW, sa.centerY + sa.padH, scrimZ],
            tl: [-sa.padW, sa.centerY + sa.padH, scrimZ],
        };

        return { quads, scrim, lights };
    }

    _layoutRowsTo3d(rows, timeSec, shot, inkBaseRgb, inkSungRgb, isLightPal, anim, aspect, isPreview, extraScale = 1.0) {
        const quads = [];
        const userScale = clamp(Number(this.opts.fontSize ?? 1.0), 0.7, 1.6);
        const rawEmWorld = (isPreview ? 0.56 : 0.62) * userScale * extraScale * (shot.isChorus ? 1.08 : 1.0);

        // 先度量各行物理总宽，若超出安全视域边界则等比缩进，绝对不截断左右两侧文字
        const measuredRows = [];
        let maxRowWidth = 0.01;
        let totalVisibleChars = 0;
        for (const r of rows) {
            const rowEntries = [];
            let rowW = 0;
            const ordered = this.isRtlLyrics ? [...r.items].reverse() : r.items;
            for (const it of ordered) {
                const ent = this._atlas.getOrBake(it.char, true);
                const adv = ent ? ent.advanceRatio : 0.55;
                rowEntries.push({ it, ent, adv });
                rowW += adv * rawEmWorld;
                if (ent && !ent.isSpace) totalVisibleChars++;
            }
            maxRowWidth = Math.max(maxRowWidth, rowW);
            measuredRows.push({ rowEntries, rowW });
        }

        const maxSafeWorldW = Math.min(6.4, Math.max(2.6, aspect * 3.75));
        const fitFactor = maxRowWidth > maxSafeWorldW ? (maxSafeWorldW / maxRowWidth) : 1.0;
        const emWorld = rawEmWorld * fitFactor;
        const lineHeight = emWorld * 1.48;
        const totalH = Math.max(emWorld, measuredRows.length * lineHeight);

        const planeZ = -2.85 + (anim?.zShift || 0);
        const centerY = (isPreview ? 2.28 : 2.40) + (anim?.yShift || 0);
        const yawAngle = shot.movement === 'gallery' ? ((shot.seed % 2 === 0 ? 1 : -1) * 0.09) : 0;
        const curveStrength = shot.movement === 'altar' ? 0.055 : (shot.movement === 'horizon' ? 0.032 : 0.018);

        const activeLights = [];
        let emotionSpot = null;
        let activeCharSpot = null;
        const timeMs = timeSec * 1000;
        const isExiting = Boolean(anim?.isExiting);
        const exitAlpha = anim?.exitAlpha ?? clamp(1 - (anim?.exitEase || 0), 0, 1);
        const tailFade = anim?.tailFade ?? 1.0;
        const preRoll = Math.max(0, anim?.preRoll || 0);
        const yDropSpan = Math.max(0.24, Number(anim?.yDropSpan ?? 0.36));
        const inLeadStart = (shot.index === 0 ? Math.max(0, shot.startSec - 0.12) : shot.startSec) + (anim?.enterDelay || 0) - preRoll;
        const inDur = Math.max(0.18, (anim?.inDur || 0.34) + preRoll);
        const staggerSpan = Math.min(0.055, totalVisibleChars * 0.0045);
        let visibleIdx = 0;

        for (let rIdx = 0; rIdx < measuredRows.length; rIdx++) {
            const mr = measuredRows[rIdx];
            const actualRowW = mr.rowW * fitFactor;
            const baseY = centerY + (totalH * 0.5) - (rIdx + 0.68) * lineHeight;
            let cursorX = -actualRowW * 0.5;

            for (const cell of mr.rowEntries) {
                const { it, ent, adv } = cell;
                const advWorld = adv * emWorld;
                const gx = cursorX + advWorld * 0.5;
                cursorX += advWorld;

                if (!ent || ent.isSpace) continue;

                let charEnter;
                let charZDrift = 0.0;
                let charYDrift = 0.0;
                if (isExiting) {
                    charEnter = exitAlpha;
                } else {
                    const delay = totalVisibleChars > 1
                        ? (visibleIdx / (totalVisibleChars - 1)) * staggerSpan
                        : 0;
                    visibleIdx++;
                    const rawIn = (timeSec - inLeadStart - delay) / inDur;
                    const charEase = smootherstep01(clamp(rawIn, 0, 1));
                    charEnter = charEase * tailFade;
                    charZDrift = -(1 - charEase) * 0.12;
                    charYDrift = -(1 - charEase) * yDropSpan;
                }

                const quadS = ent.scaleRatio * emWorld;
                const half = quadS * 0.5;
                const gy = baseY + ent.centerYOffsetRatio * emWorld + charYDrift;
                // 凹弧形建筑展厅排布（朝听者温和合抱，既防止广角透视缩小两侧字号，又绝不交叉遮挡）
                const arcZ = planeZ + charZDrift + gx * gx * curveStrength + gx * Math.sin(yawAngle);
                const arcTangentAngle = Math.atan(2 * gx * curveStrength * 0.55 + Math.sin(yawAngle));
                const cosA = Math.cos(arcTangentAngle);
                const sinA = Math.sin(arcTangentAngle);

                const prog = clamp((timeMs - it.start) / Math.max(60, it.end - it.start), 0, 1);

                // 未唱出的情感词也保留 58% 节制着色，唱后饱满点亮（对标 Folio）
                let baseRgb = inkBaseRgb;
                let sungRgb = inkSungRgb;
                if (it.emotionColor) {
                    const emRgb = hexToVec3(it.emotionColor);
                    const tintHex = mixHex(isLightPal ? '#2a241d' : '#ebe4d6', it.emotionColor, 0.58);
                    baseRgb = hexToVec3(tintHex);
                    sungRgb = emRgb;
                    if (!emotionSpot) {
                        emotionSpot = { pos: [gx, gy, arcZ + 0.6], rgb: emRgb };
                    }
                }

                if (!isExiting && prog > 0.02 && prog < 0.98) {
                    activeCharSpot = { pos: [gx, gy, arcZ + 0.85], rgb: sungRgb };
                }

                const rx = half * cosA;
                const rz = half * sinA;
                quads.push({
                    bl: [gx - rx, gy - half, arcZ - rz],
                    br: [gx + rx, gy - half, arcZ + rz],
                    tr: [gx + rx, gy + half, arcZ + rz],
                    tl: [gx - rx, gy + half, arcZ - rz],
                    uvRect: ent.uvRect,
                    baseRgb,
                    sungRgb,
                    baseAlpha: 0.96,
                    sungAlpha: 1.0,
                    prog,
                    enter: charEnter,
                });
            }
        }

        if (activeCharSpot) activeLights.push(activeCharSpot);
        if (emotionSpot) activeLights.push(emotionSpot);

        const padW = Math.min(4.8, maxRowWidth * fitFactor * 0.5 + 1.35);
        const padH = totalH * 0.5 + 0.72;
        return {
            quads,
            rowCount: measuredRows.length,
            bounds: { centerY, padW, padH, planeZ },
            lights: activeLights,
        };
    }

    _updateDomSubtitles(shot, pal) {
        if (!this._subtitlesEl || !this._subRomajiEl || !this._subTransEl) return;
        const isTiny = this._isPreviewStage() || (this.width > 0 && this.width < 360);
        if (isTiny || !shot) {
            if (this._lastDomSubKey !== 'hidden') {
                this._subtitlesEl.style.display = 'none';
                this._lastDomSubKey = 'hidden';
            }
            return;
        }

        const isLightPal = (Number.isFinite(pal.lightMix) ? pal.lightMix >= 0.5 : Boolean(pal.isLight));
        let roma = '';
        let trans;
        if (shot.kind === 'interlude' || shot.kind === 'colophon') {
            trans = shot.subLabel || '';
        } else {
            roma = this.opts.showRomaji !== false ? (shot.romaji || '') : '';
            trans = this.opts.showTranslation !== false ? (shot.translation || '') : '';
        }

        const textKey = `${roma}|${trans}`;
        const key = `${textKey}|${isLightPal ? 'L' : 'D'}`;
        if (key === this._lastDomSubKey) return;
        const textChanged = this._lastDomTextKey !== textKey;
        const prevSub = this._lastRenderedSub || { roma: '', trans: '' };
        this._lastDomSubKey = key;
        this._lastDomTextKey = textKey;

        this._subtitlesEl.style.display = 'flex';
        this._subtitlesEl.classList.toggle('is-light-stone', isLightPal);

        const spawnGhostFade = (oldRoma, oldTrans) => {
            if (!this._subGhostEl || !this._subGhostRomajiEl || !this._subGhostTransEl) return;
            if (!oldRoma && !oldTrans) return;
            if (this._subGhostTimer) {
                clearTimeout(this._subGhostTimer);
                this._subGhostTimer = 0;
            }
            this._subGhostEl.style.display = 'flex';
            this._subGhostEl.classList.remove('is-leaving');
            this._subGhostRomajiEl.textContent = oldRoma;
            this._subGhostRomajiEl.style.display = oldRoma ? 'block' : 'none';
            this._subGhostTransEl.textContent = oldTrans;
            this._subGhostTransEl.style.display = oldTrans ? 'block' : 'none';
            void this._subGhostEl.offsetWidth;
            if (this._subGhostRaf) cancelAnimationFrame(this._subGhostRaf);
            if (typeof requestAnimationFrame === 'function') {
                this._subGhostRaf = requestAnimationFrame(() => {
                    this._subGhostRaf = 0;
                    if (this._subGhostEl) {
                        this._subGhostEl.classList.add('is-leaving');
                    }
                });
            }
            this._subGhostTimer = setTimeout(() => {
                this._subGhostTimer = 0;
                if (this._destroyed || !this._subGhostEl) return;
                this._subGhostEl.style.display = 'none';
                if (this._subGhostRomajiEl) this._subGhostRomajiEl.textContent = '';
                if (this._subGhostTransEl) this._subGhostTransEl.textContent = '';
            }, 250);
        };

        if (!roma && !trans) {
            if (textChanged && !this._cameraSnapPending) {
                spawnGhostFade(prevSub.roma, prevSub.trans);
            }
            this._subtitlesEl.classList.add('is-empty');
            this._lastRenderedSub = { roma: '', trans: '' };
            return;
        }

        if (textChanged && !this._cameraSnapPending && (prevSub.roma || prevSub.trans)) {
            spawnGhostFade(prevSub.roma, prevSub.trans);
        }

        this._subtitlesEl.classList.remove('is-empty');
        this._subRomajiEl.textContent = roma;
        this._subRomajiEl.style.display = roma ? 'block' : 'none';
        this._subTransEl.textContent = trans;
        this._subTransEl.style.display = trans ? 'block' : 'none';
        this._lastRenderedSub = { roma, trans };

        if (textChanged && !this._cameraSnapPending && this._subSlotEl && typeof requestAnimationFrame === 'function') {
            if (this._subEnterRaf) cancelAnimationFrame(this._subEnterRaf);
            this._subSlotEl.classList.add('is-entering');
            void this._subSlotEl.offsetWidth;
            this._subEnterRaf = requestAnimationFrame(() => {
                this._subEnterRaf = 0;
                if (this._subSlotEl) {
                    this._subSlotEl.classList.remove('is-entering');
                }
            });
        }
    }

    _renderCurrentFrame(nowPerf = 0) {
        if (this._destroyed || !this._canvas) return;
        const tStart = typeof performance !== 'undefined' ? performance.now() : 0;
        const framePerf = tStart > 0 ? tStart : (nowPerf > 0 ? nowPerf : Date.now());
        const dtFrame = this._lastRenderPerf > 0
            ? clamp((framePerf - this._lastRenderPerf) / 1000, 0.001, 0.08)
            : 0.016;
        this._lastRenderPerf = framePerf;

        const timeSec = this._extrapolatedTimeSec();
        this._ensureProgram(timeSec);
        const qualityTier = this._resolveQualityTier();
        this._warmupNextSuiteScene(qualityTier);

        // 基于帧间隔指数衰减平滑鼠标 3D 视差阻尼，杜绝不同刷新率下步长不匀
        const pRate = this.opts.vitrailParallax ? 5.5 : 9.0;
        const pLerp = 1 - Math.exp(-dtFrame * pRate);
        const tx = this.opts.vitrailParallax ? this._ptrTargetX : 0;
        const ty = this.opts.vitrailParallax ? this._ptrTargetY : 0;
        this._ptrX += (tx - this._ptrX) * pLerp;
        this._ptrY += (ty - this._ptrY) * pLerp;

        const audio = this._sampleAudio(dtFrame);
        const profile = this._songProfile || resolveVitrailSongProfile({});
        let sceneState = resolveVitrailSceneAtTime(this._program, timeSec, profile, {
            archOverride: this.opts.vitrailArchitecture,
            presetOverride: this.opts.vitrailPreset,
            crossfadeSec: 3.2,
        });

        // 若用户在设置面板手动切换了建筑原型或配色，平滑运行 1.65s GPU 双缓冲溶解
        if (this._manualTransition) {
            const mt = this._manualTransition;
            const nowMs = framePerf;
            const mtMix = smootherstep01(clamp((nowMs - mt.startPerf) / mt.durationMs, 0, 1));
            if (mtMix >= 0.999) {
                this._manualTransition = null;
            } else {
                sceneState = {
                    ...sceneState,
                    fromArch: mt.fromArch,
                    toArch: sceneState.toArch,
                    currentArch: mtMix >= 0.5 ? sceneState.toArch : mt.fromArch,
                    sceneMix: mtMix,
                    inTransition: true,
                    palA: mt.fromPalette,
                    palB: sceneState.palette,
                    palette: lerpVitrailPalette(mt.fromPalette, sceneState.palette, mtMix),
                };
            }
        }

        const pal = sceneState.palette;
        this._activeVisualArch = sceneState.currentArch || sceneState.toArch;
        this._activeVisualPalette = pal;

        const { shot, prevShot, nextShot, nextNextShot } = findActiveVitrailShot(this._program, timeSec);
        this._updateDomSubtitles(shot, pal);

        const cssW = Math.max(120, this.width || this.viewContainer?.clientWidth || 800);
        const cssH = Math.max(90, this.height || this.viewContainer?.clientHeight || 500);
        const aspect = cssW / Math.max(1, cssH);

        const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const maxDpr = qualityTier === 'high' ? Math.min(rawDpr, 2.0) : (qualityTier === 'balanced' ? Math.min(rawDpr, 1.5) : 1.0);
        const renderW = Math.max(120, Math.round(cssW * maxDpr * this._adaptiveScale));
        const renderH = Math.max(90, Math.round(cssH * maxDpr * this._adaptiveScale));

        if (this._useFallback2d || !this._renderer || !this._renderer.ready) {
            this._renderFallback2d(renderW, renderH, timeSec, shot, prevShot, sceneState, audio);
            this._cameraSnapPending = false;
            return;
        }

        const targetCam = computeVitrailCameraPose({
            timeSec,
            shot,
            prevShot,
            nextShot,
            nextNextShot,
            fromArchetype: sceneState.fromArch,
            archetype: sceneState.toArch,
            sceneMix: sceneState.sceneMix,
            cameraAmp: this.opts.vitrailCamera,
            pointerX: this._ptrX,
            pointerY: this._ptrY,
            audioEnergy: audio.energy,
        });

        const dtCam = (nowPerf > 0 && this._lastCamPerf > 0)
            ? clamp((nowPerf - this._lastCamPerf) / 1000, 0.001, 0.08)
            : dtFrame;
        this._lastCamPerf = nowPerf || 0;

        const snapNow = this._cameraSnapPending || this._isPreviewStage();
        if (snapNow || !this._camSmooth) {
            this._camSmooth = {
                eye: [...targetCam.eye],
                target: [...targetCam.target],
                up: [...targetCam.up],
                fovDeg: targetCam.fovDeg,
            };
        } else {
            const k = 1 - Math.exp(-dtCam * 9.0);
            for (let i = 0; i < 3; i++) {
                this._camSmooth.eye[i] += (targetCam.eye[i] - this._camSmooth.eye[i]) * k;
                this._camSmooth.target[i] += (targetCam.target[i] - this._camSmooth.target[i]) * k;
                this._camSmooth.up[i] += (targetCam.up[i] - this._camSmooth.up[i]) * k;
            }
            this._camSmooth.fovDeg += (targetCam.fovDeg - this._camSmooth.fovDeg) * k;
        }
        const cam = this._camSmooth;

        const { quads, scrim, lights } = this._build3dTypography(shot, prevShot, nextShot, timeSec, pal, aspect, dtFrame);
        this._cameraSnapPending = false;
        this._atlas.syncToGpu(this._renderer.gl);
        this._renderer.uploadGlyphQuads(quads, scrim);

        const defaultL0 = { pos: [0, 2.5, -2.5], rgb: hexToVec3(pal.lightColor).map((c) => c * 0.7) };
        const defaultL1 = { pos: [0, 4.6, -10.5], rgb: hexToVec3(pal.glassA).map((c) => c * 0.9) };
        const targetL0 = lights[0] || defaultL0;
        const targetL1 = lights[1] || defaultL1;
        if (snapNow || !this._lightSmooth) {
            this._lightSmooth = [
                { pos: [...targetL0.pos], rgb: [...targetL0.rgb] },
                { pos: [...targetL1.pos], rgb: [...targetL1.rgb] },
            ];
        } else {
            const kL = 1 - Math.exp(-dtFrame * 6.5);
            const tgts = [targetL0, targetL1];
            for (let li = 0; li < 2; li++) {
                const curL = this._lightSmooth[li];
                const tgtL = tgts[li];
                for (let c = 0; c < 3; c++) {
                    curL.pos[c] += (tgtL.pos[c] - curL.pos[c]) * kL;
                    curL.rgb[c] += (tgtL.rgb[c] - curL.rgb[c]) * kL;
                }
            }
        }

        const ok = this._renderer.renderFrame({
            renderWidth: renderW,
            renderHeight: renderH,
            timeSec,
            palette: pal,
            fromArch: sceneState.fromArch,
            toArch: sceneState.toArch,
            sceneMix: sceneState.sceneMix,
            palA: sceneState.palA,
            palB: sceneState.palB,
            getSceneBundle: (a) => this._getSceneBundle(a),
            camera: cam,
            audio,
            lighting: clamp(Number(this.opts.vitrailLighting ?? 0.9), 0, 1.5),
            enableReflection: this.opts.vitrailReflection !== false,
            enableParticles: this.opts.vitrailParticles !== false,
            qualityTier,
            atlasTexture: this._atlas.texture,
            pointLights: this._lightSmooth,
        });

        if (!ok && !this._renderer.contextLost) {
            this._useFallback2d = true;
            this._fallbackCtx = this._canvas.getContext('2d');
        }

        // 自适应分辨率看门狗（保障旧设备无掉帧拖影）
        if ((this.opts.vitrailQuality || 'auto') === 'auto' && nowPerf > 0 && tStart > 0) {
            const elapsed = performance.now() - tStart;
            if (elapsed > 26) {
                this._slowFrameStreak++;
                if (this._slowFrameStreak >= 14 && this._adaptiveScale > 0.68) {
                    this._adaptiveScale = Math.max(0.66, +(this._adaptiveScale - 0.14).toFixed(2));
                    this._slowFrameStreak = 0;
                    logInfo('vitrail', `检测到帧耗时较高，平滑降分辨率至 ${this._adaptiveScale}x 保障流畅度`);
                }
            } else {
                this._slowFrameStreak = Math.max(0, this._slowFrameStreak - 1);
            }
        }
    }

    /**
     * WebGL2 不可用时的 Canvas2D 圣光建筑兜底视图（杜绝黑屏/报错，并支持场景与分句柔和衔接）
     */
    _renderFallback2d(w, h, timeSec, shot, prevShot, sceneState, audio) {
        const ctx = this._fallbackCtx;
        if (!ctx || !this._canvas) return;
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width = w;
            this._canvas.height = h;
        }
        const pal = sceneState?.palette || sceneState;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, pal.bgTop);
        grad.addColorStop(0.65, pal.bgHorizon);
        grad.addColorStop(1, pal.waterTint);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // 透视柱廊轮廓 + 玫瑰彩窗放射光影
        const cx = w * 0.5;
        const horizon = h * 0.56;
        ctx.save();
        const halo = ctx.createRadialGradient(cx, horizon - h * 0.12, 10, cx, horizon, Math.max(w, h) * 0.52);
        halo.addColorStop(0, `${pal.glassA}55`);
        halo.addColorStop(0.5, `${pal.glassB}22`);
        halo.addColorStop(1, 'transparent');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = pal.stoneTrim;
        ctx.lineWidth = Math.max(2, w * 0.004);
        for (let i = 1; i <= 4; i++) {
            const span = w * (0.24 + i * 0.16);
            const archTop = horizon - h * (0.14 + i * 0.08);
            ctx.beginPath();
            ctx.moveTo(cx - span * 0.5, horizon);
            ctx.lineTo(cx - span * 0.5, archTop + 30);
            ctx.quadraticCurveTo(cx, archTop - 40, cx + span * 0.5, archTop + 30);
            ctx.lineTo(cx + span * 0.5, horizon);
            ctx.stroke();
        }
        ctx.restore();

        if (!shot) return;
        const fontStack = resolveVitrailFont(this.opts.fontFamily);
        const px = Math.max(20, Math.round(Math.min(w * 0.048, 56) * clamp(this.opts.fontSize || 1, 0.7, 1.5)));
        const isLightPal = (Number.isFinite(pal.lightMix) ? pal.lightMix >= 0.5 : Boolean(pal.isLight));
        const baseY = h * 0.46 - Math.sin(timeSec * 0.7) * 4 * (1 + audio.energy * 0.5);

        const draw2dLine = (s, alpha, yOff) => {
            if (!s || alpha <= 0.02) return;
            ctx.save();
            ctx.globalAlpha = clamp(alpha, 0, 1);
            ctx.font = `700 ${px}px ${fontStack}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = isLightPal ? 'rgba(23,20,16,0.92)' : pal.ink;
            ctx.shadowColor = isLightPal ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.85)';
            ctx.shadowBlur = 12;
            ctx.fillText(String(s.text || ''), cx, baseY + yOff, w * 0.84);
            ctx.restore();
        };

        const age = timeSec - shot.startSec;
        const inEase = smootherstep01(clamp((age + 0.06) / 0.38, 0, 1));
        if (prevShot && prevShot.index !== shot.index && age >= 0 && age < 0.42 && (shot.startSec - prevShot.endSec) < 0.85) {
            const outEase = smootherstep01(clamp(age / 0.42, 0, 1));
            draw2dLine(prevShot, 1 - outEase, -24 * outEase);
        }
        draw2dLine(shot, inEase, (1 - inEase) * 14);
    }

    destroy() {
        this._destroyed = true;
        this.stop();
        if (this._subEnterRaf) {
            cancelAnimationFrame(this._subEnterRaf);
            this._subEnterRaf = 0;
        }
        if (this._subGhostRaf) {
            cancelAnimationFrame(this._subGhostRaf);
            this._subGhostRaf = 0;
        }
        if (this._subGhostTimer) {
            clearTimeout(this._subGhostTimer);
            this._subGhostTimer = 0;
        }
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        if (this.container) {
            if (this._onPointerMove) this.container.removeEventListener('pointermove', this._onPointerMove);
            if (this._onPointerLeave) this.container.removeEventListener('pointerleave', this._onPointerLeave);
        }
        if (this._renderer) {
            this._renderer.destroy();
            this._renderer = null;
        }
        if (this._atlas) {
            this._atlas.destroy();
            this._atlas = null;
        }
        this._shotEmotionCache.clear();
        this._sceneBundleCache.clear();
        this._canvas = null;
        this._fallbackCtx = null;
        super.destroy();
    }
}
