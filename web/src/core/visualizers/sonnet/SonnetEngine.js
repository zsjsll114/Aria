/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * SonnetEngine.js — folia sonnet 的 PixiJS 运行时（文字管线 + 7 shot 布局 + 场景/转场/片尾）
 *
 * 上游：chthollyphile/folia-major createSonnetPixiRuntime.ts。**分层与上游对齐**：
 *   - 逐帧姿态（相机 / 焦点 / 间隙漂移 / 呼吸 / MG 含粒子层游动 / 引导线 / 开放画框 /
 *     逐字入场·色差·残影）→ `sonnetShotFrame.js`（上游 sonnetShotFrame.ts 的机械移植）
 *   - 片尾模糊 → `sonnetOutroBlur.js`（上游 sonnetOutroBlur.ts 的机械移植）
 *   - 本文件只管：App/ticker 生命周期、场景懒建缓存（激活 ±1）、转场帧、逐镜显隐、
 *     credits 帧、宿主背景。转场帧与逐镜显隐按上游 createSonnetPixiRuntime 场景循环的
 *     顺序内联（上游的 sonnetSceneFrame.ts 是同一批纯函数，未独立成文件、行为一致）。
 * 架构对应：
 *   - Pixi App + ticker；渲染帧率与歌词时间解耦（ticker 渲染，update(t) 供时间）
 *   - 场景按段落懒建/缓存（激活 ±1），每帧严格只绘激活 shot
 *   - 所有运动是 currentTime 的纯函数；seek/暂停天然连续
 */

import { Application, Container, Graphics, Text, TextStyle, BlurFilter, Color, ColorMatrixFilter, NoiseFilter, Filter, GlProgram, UniformGroup, Texture } from '../../../../vendor/pixi/pixi.mjs';
import { compileSonnetProgram, findSonnetParagraphIndexAtTime } from './sonnetProgram.js';
/* ★ 2026-09-29 高保真切换：排版/文字视图从「近似重写版」切到上游机械移植版
   （sonnetTypographyLayout/sonnetTextViewBuilder + pretext 排版 + 全套 flowLayouts）。
   近似版（sonnetTypography.js/sonnetTextView.js）保留不再被 Engine 引用。 */
import { resolveSonnetTypographyLayout } from './sonnetTypographyLayout.js';
import { buildSonnetTextView } from './sonnetTextViewBuilder.js';
/* ★ 2026-09-30 MG 全量切换（上游 814 行 100 变体，简化版 sonnetShotMg.js 退役） */
import { buildSonnetShotMg } from './sonnetShotMgFull.js';
/* ★ 2026-09-30 滤镜链（lens→noise→contrast→print）+ halo 发光层 */
import { resolveSonnetPostProcessProfile, applySonnetScenePostProcess, createSonnetHaloLayer } from './sonnetPostProcess.js';
import {
    resolveSonnetShotTransitionFrame, resolveSonnetEnterTransitionFrame,
    resolveSonnetExitTransitionFrame, resolveSonnetTransitionEffectFrame,
    IDLE_SONNET_TRANSITION_FRAME,
} from './sonnetTransitions.js';
import { unloadPixiDisplayTree } from '../pixiDisplayResources.js';
/* ★ 2026-10-11 Aria 扩展：`♪` 谱面的判定（默认与上游等价；可选放宽到间奏标记） */
import { isSonnetStaffSegment } from '../instrumentalLines.js';
import { createSonnetGlitchEffect } from './sonnetGlitchFilter.js';
import { resolveSonnetCreditsFrame, hasSonnetCreditsMetadata, buildSonnetCreditsPoster } from './sonnetCredits.js';
/* ★ 2026-10-11 逐帧姿态整体移入 sonnetShotFrame.js（上游 sonnetShotFrame.ts 的机械移植）：
   相机/焦距/间隙漂移/呼吸、MG（粒子层游动）、引导线、开放画框、逐字入场·色差·残影
   全由 updateSonnetShot 消费，本文件不再直接调用这些运动学纯函数。 */
import { updateSonnetShot } from './sonnetShotFrame.js';
/* ★ 2026-10-11 片尾模糊（上游 sonnetOutroBlur.ts）：此前把片尾 blur 叠进**转场**
   blurFilter（`scene.blurFilter.blur += lyricBlur`），两件事共用一个强度位互相覆盖 */
import { SonnetOutroBlur } from './sonnetOutroBlur.js';
/* ★ 2026-10-11 画框角标层（上游 sonnetFrameOverlay.ts）：屏幕坐标系的静态画框，
   挂在 stage 上与场景容器并列，不随运镜/转场移动 */
import { drawSonnetFrameOverlay } from './sonnetFrameOverlay.js';
import { hashSonnetSeed } from './sonnetRandom.js';
import { computeSonnetContentBounds, fitSonnetPlacementsToSafeArea, clampSonnetPivotToViewport, hasVerticalSonnetContent } from './sonnetViewportFit.js';
import { sanitizeCssFontFamily } from '../../../utils/fontStacks.js';

const FALLBACK_FONT = '"Noto Sans SC", "Microsoft YaHei", sans-serif';
/* CJK 判定（汉字/假名/谚文）——中文歌词的 hero 归一处理用 */
const CJK_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** 封面主色 → 背景色派生：主色混入 75% 黑（保 hue、压亮度，背景不被正文压住）。
    sonnetMode 与 Engine 共用 */
export const deriveCoverBackground = (palette) => {
    const hex = palette && (palette.primary || '');
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return '#09090b';
    const n = parseInt(m[1], 16);
    const r = Math.round(((n >> 16) & 255) * 0.25);
    const g = Math.round(((n >> 8) & 255) * 0.25);
    const b = Math.round((n & 255) * 0.25);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
};

export class SonnetEngine {
    constructor(container) {
        this.container = container;
        this.app = null;
        this.sceneRoot = null;
        this.program = null;
        this.currentTime = 0;
        this.paused = false;
        this.lines = [];
        this.theme = {};
        /* 上游这两个值是 props 直达运行时的（audioBands / audioPower）；本仓没有那条
           React 链路，改由 sonnetMode 的逐帧循环经 setAudioLevels() 灌进来。
           刻度 0~255（见 sonnetAudioLevels.js 与 sonnetShotMgFull 的 normalizeAudioLevel）。 */
        this.audioLevels = { bass: 0, power: 0, vocal: 0 };
        this.destroyed = false;
        this.scenes = new Map();          // paragraphIndex → scene bundle
        this.activeParagraphIndex = -1;
        this.glowEnabled = true;
        this.transitionsEnabled = true;   // shot 边界转场（fast-blur/mono-glitch/camera-pull）
        /* ★ 2026-10-11 Aria 扩展（不放进 tuning：它不是上游 SonnetTuning 的键）：
           间奏标记也走 `♪` 谱面。默认 false = 上游行为（只认 `♪`）。 */
        this.interludeStaff = false;
        this.lyricsFontScale = 1;         // 上游 tuning.lyricsFontScale 等价项
        /* 上游 tuning 消费字段默认档（sonnetPostProcess profile 计算）：
           后期滤镜全开、动效强度标准档。用户可调项后续接设置面板 */
        this.tuning = {
            typographyMotion: 1,
            /* ★ 2026-10-11 补齐上游 DEFAULT_SONNET_TUNING（folia types.ts:560-572）里
               sonnetShotFrame 与场景构建消费的字段。此前只有 postProcess* 一族，于是
               updateSonnetShot 读到的 `tuning.cameraIntensity` 是 undefined →
               `camera = undefined * … = NaN`（相机矩阵被 NaN 污染）、
               `tuning.showGuide` / `tuning.showFixedGeo` 是 falsy → 引导线与开放画框
               **永久不可见**、`showBackgroundDecor`/`showGiantDecorativeText` 同理。
               默认值与上游逐字相同；本仓暂无对应面板项，先钉死默认档。 */
            cameraIntensity: 1,
            mgDensity: 1,
            showOnlyText: false,
            showGuide: true,
            showBackgroundMg: true,
            showFixedGeo: true,
            showGiantDecorativeText: true,
            showBackgroundDecor: true,
            outerFrameMode: 'full',
            textureResolution: 1.5,
            /* ★ 2026-10-11 后期处理对齐上游默认档（folia types.ts:573-580）：上游的**主开关
               默认就是 false** —— `resolveSonnetPostProcessProfile` 里 noise / contrast /
               lens* / printEffects(rgbShift·halftone·vignette) 全部被 `postEnabled` 门控，
               一个都不跑。本仓此前硬编码 `true` + rgbShift 0.3 / halftone 0.35 /
               grain 0.5 / contrast 0.3：等于**默认开着「胶片噪点 + RGB 分离 + 网点 + 对比」**。
               薄线装饰（MG / 画框 / 引导线）在没有文字压场的时刻（开场、长间隔）经这几层
               滤镜就是一团"雪花/故障感"——用户原话「为什么现在还没分镜就有错误特效」。
               注意发光不受主开关门控（profile 的 glowStrength/glowAlpha 独立计算），
               所以 folia 的辉光签名保留 ✓；转场 blur/glitch 也是独立链路 ✓。
               用户可在诗镜面板的「后期处理」组逐项打开/调强度（applySettings 里的
               postProcess* 映射写回本对象的这些键）。 */
            postProcessEnabled: false,
            postProcessGrain: 0.2,
            postProcessContrast: 0,
            postProcessRgbShift: 0,
            postProcessHalftone: 0,
            postProcessVignette: 0.85,
            postProcessLensDistortion: 0.3,
            postProcessLensDispersion: 0.6,
        };
        this.canvas = null;
        this.bgEl = null;           // 宿主背景层（主题底色，见 _syncHostBackground）
        this.outroBlur = null;      // 片尾模糊（init 里建，挂最后一段场景）
        this.creditsLayer = null;   // 片尾海报层（init 里建，independent of scenes）
        this._creditsSig = '';      // 海报重建指纹（尺寸 + 元数据 + 字号 + 仅文字）
        this._creditsError = null;  // 海报构建失败痕迹（此前被 try/catch + _lastError=null 吃干净）
        this.overlayLayer = null;   // 画框角标层（init 里建，屏幕坐标系静态层）
        this._overlaySig = '';      // 画框重建指纹（尺寸 + 主色 + outerFrameMode + 仅文字）
        this._overlayError = null;  // 画框绘制失败痕迹（它会带走整帧，不能静默）
        this.cameraZoomScale = 1;   // 「默认焦距(镜头特写)」滑条
        this.cameraSpeed = 1;       // 运镜平滑速度
        this.settingsFlags = null;  // showHud/showParticles/showDecorations/aiColorSync
        const isPreviewHost = Boolean(container && typeof container.closest === 'function' && container.closest('.preview-player'));
        this.bottomInset = isPreviewHost ? 52 : 96;      // 底部播放器/预览栏高度（布局安全区）
        this._onResize = this.handleResize.bind(this);
    }

    async init() {
        this.app = new Application();
        await this.app.init({
            backgroundAlpha: 0,
            antialias: true,
            resolution: Math.min(window.devicePixelRatio || 1, 2),
            autoDensity: true,
            resizeTo: this.container,
            powerPreference: 'high-performance',
        });
        if (this.destroyed) {
            this.app.destroy(false, { children: true });
            this.app = null;
            return;
        }
        this.canvas = this.app.canvas;
        this.canvas.style.position = 'absolute';
        this.canvas.style.inset = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.container.appendChild(this.canvas);
        /* ★ 2026-10-11 片尾模糊（上游 sonnetOutroBlur.ts 的机械移植件）：挂最后一段场景 */
        this.outroBlur = new SonnetOutroBlur({ BlurFilter });
        /* ★ 2026-10-11 「切镜闪黑」根因修复：上游的背景由**宿主页面**提供（画布
           backgroundAlpha=0，createSonnetPixiRuntime.ts:143；换歌时才用主题底色铺一层），
           而本仓场景背景只是主题色的 0.10 tint（_ensureScene 的 bgTint）。于是段落
           入场/出场窗口里场景 alpha 下潜（入场自 0.18 起，与上游同式）时，透出的是
           .player-container.view-pv 的近黑底 #09090b（viewmode.css:979）→ 观感"闪黑"。
           把主题底色铺到 verse 容器上（同上游外壳语义），下潜即沉入主题色而非黑。 */
        this._syncHostBackground();
        this.sceneRoot = new Container();
        /* ★ 2026-10-11 片尾海报改为**独立一层**（上游 createSonnetPixiRuntime.ts:153-157：
           `stage.addChild(sceneContainer, creditsContainer, overlayContainer)`）。
           此前它被加进**场景容器**里，于是片尾帧的 `scene.container.alpha *= lyricAlpha`
           （lyricAlpha 收到 0 = 歌词已淡尽）把海报一起乘成透明：海报永远看不见，
           而且构建包在 try/catch 里、紧接着 `_lastError = null`，**一点痕迹都不留**。
           探针实测：海报本身建得出来（3 个子节点）、时间线也对 —— 纯粹是被父节点 alpha 连坐。 */
        this.creditsLayer = new Container();
        /* 画框角标层也在 stage 上（上游 `addChild(sceneContainer, creditsContainer, overlayContainer)`），
           位于海报之上：它是屏幕坐标系的静态画框，不随运镜/转场/淡出移动 */
        this.overlayLayer = new Container();
        this.app.stage.addChild(this.sceneRoot, this.creditsLayer, this.overlayLayer);
        this.app.ticker.add(this._tick);
        window.addEventListener('resize', this._onResize);
        if (this.lines.length > 0) this._rebuildProgram();
    }

    /* ---------- Aria 对接接口（VisualizerManager 契约） ---------- */

    setLyrics(lines) {
        this.lines = Array.isArray(lines) ? lines : [];
        this._rebuildProgram();
    }

    /** Aria 主循环每帧调用（audio.currentTime 秒） */
    update(currentTimeSec) {
        this.currentTime = currentTimeSec || 0;
    }

    /** 同步驱动到指定时间并立即刷一帧舞台（海报截帧补态用） */
    renderAtTimeSync(timeSec) {
        if (!this.app || this.destroyed || !this.program) return false;
        this.currentTime = Number.isFinite(Number(timeSec)) ? Number(timeSec) : 0;
        try {
            this._tickInner();
            if (this.app.renderer && this.app.stage) {
                this.app.renderer.render(this.app.stage);
            }
            return true;
        } catch (e) {
            this._lastError = String(e && e.stack ? e.stack : e).slice(0, 400);
            return false;
        }
    }

    /**
     * 音乐驱动的三个量（0~255）：上游是 `audioBands`/`audioPower` 这些 props 直达运行时
     * （VisualizerSonnet → createSonnetPixiRuntime → sonnetShotFrame/sonnetShotMg），
     * 本仓用这个 setter 等价传入。传 null/非法值一律按 0（静音）处理。
     * @param {{bass?:number, power?:number, vocal?:number}|null} levels
     */
    setAudioLevels(levels) {
        const l = levels || {};
        const pick = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return 0;
            return n < 0 ? 0 : n > 255 ? 255 : n;
        };
        this.audioLevels = { bass: pick(l.bass), power: pick(l.power), vocal: pick(l.vocal) };
    }

    _resolveFontStack(rawFont) {
        const liveIntf = (typeof globalThis !== 'undefined' && globalThis.appSettings && globalThis.appSettings.interface)
            ? globalThis.appSettings.interface
            : null;
        const gKey = liveIntf ? liveIntf.fontFamily : null;
        const isFollow = !rawFont || rawFont === 'default' || rawFont === 'inherit';
        const candidate = !isFollow ? rawFont : (gKey || 'default');
        const advMl = (liveIntf && liveIntf.advancedFonts && liveIntf.advancedFonts.enabled
            && typeof globalThis !== 'undefined' && globalThis.Aria && globalThis.Aria.__multilangFamilyList)
            ? String(globalThis.Aria.__multilangFamilyList)
            : '';
        let baseStack = '';
        if (candidate && candidate !== 'default' && candidate !== 'inherit'
            && typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            try {
                const resolved = window.resolveFontFamily(candidate, gKey);
                if (resolved) baseStack = resolved;
            } catch { /* fallback to global or sanitizeCssFontFamily */ }
        }
        if (!baseStack && typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            try {
                const resolvedGlobal = window.resolveFontFamily('default', gKey);
                if (resolvedGlobal) baseStack = resolvedGlobal;
            } catch { /* fallback below */ }
        }
        if (!baseStack) {
            baseStack = candidate === 'default' || candidate === 'inherit' ? FALLBACK_FONT : candidate;
        }
        const combined = advMl ? `${advMl}, ${baseStack}` : baseStack;
        return sanitizeCssFontFamily(combined, FALLBACK_FONT);
    }

    applySettings(settings) {
        if (!settings) return;
        /* ★ 主字色恒定 folia zinc-100（上游主题固定，不能被 modeSettings.pv.themeColor
           覆盖——那是「模式主题色」，语义是装饰/点缀。2026-09-29 实测覆盖后观感崩坏） */
        if (settings.themeColor) this.theme.accentColor = settings.themeColor;
        if (settings.graphicColor) {
            this.theme.secondaryColor = settings.graphicColor; // PV 设置的「图形色」→ MG/装饰主色
            /* 用户显式设置过图形色：封面换色不再覆盖（用户设置优先于封面取色） */
            this._secondaryColorLocked = true;
        }
        if (settings.highlightColor) this.theme.accentColor = settings.highlightColor;
        if (settings.fontFamily !== undefined || !this.fontFamily) {
            this.fontFamily = this._resolveFontStack(settings.fontFamily || 'default');
            if (this.theme) {
                this.theme.fontFamilyStack = this.fontFamily ? [this.fontFamily] : null;
            }
        }
        /* ★ 2026-10-11 接通「动效强度」（上游 Theme.animationIntensity）：
           它被 resolveSonnetAnimationScale 乘进运动与相机的整体幅度（0.65 / 1 / 1.35），
           进而在 sonnetPostProcess 里改 glowStrength/glowAlpha/noise/contrast。
           这些是**建场景时烘焙**进去的，所以换值必须重建场景 —— 本函数末尾已统一
           invalidateScenes() ✓。只认上游的三个合法值，其余（含历史遗留的 'standard'）
           一律当 normal。 */
        if (settings.animationIntensity) {
            const ai = String(settings.animationIntensity);
            this.theme.animationIntensity = (ai === 'calm' || ai === 'chaotic') ? ai : 'normal';
        }
        /* ★ 2026-10-11 后期处理组接通（面板「后期处理」组，上游 SonnetTuning 的 postProcess*）。
           这些强度是**建场景时烘焙**进滤镜链的，改值靠本函数末尾的 invalidateScenes() 生效 ✓。
           默认档 = 上游 DEFAULT_SONNET_TUNING：主开关 **false**（干净画面），
           开启后 grain/contrast/rgbShift/halftone 0..1、vignette/lensDistortion 0..2、
           lensDispersion 0..1（取值域与 vfxRecipe 的 schema 一致，这里再夹一次防手改配置越界）。 */
        if (settings.postProcessEnabled !== undefined) {
            this.tuning.postProcessEnabled = settings.postProcessEnabled !== false;
        }
        for (const [key, min, max] of [
            ['postProcessGrain', 0, 1], ['postProcessContrast', 0, 1], ['postProcessRgbShift', 0, 1],
            ['postProcessHalftone', 0, 1], ['postProcessVignette', 0, 2],
            ['postProcessLensDistortion', 0, 2], ['postProcessLensDispersion', 0, 1],
        ]) {
            const v = Number(settings[key]);
            if (Number.isFinite(v)) this.tuning[key] = Math.min(max, Math.max(min, v));
        }
        /* ★ 2026-10-11 画面元素开关（上游 SonnetTuning 里本仓此前只钉默认值的 4 个）：
           仅文字 / 引导线 / 巨型装饰字 / 装饰画框（文字浮标）。
           默认「开」的三个沿用 `!== false` 语义（缺键 = 保持上游默认档）；
           它们同时被 sonnetShotFrame 的逐帧门控与建场景（文字浮标 shape / 开放画框）消费，
           所以改值要靠本函数末尾的 invalidateScenes() 重建场景才生效 ✓。 */
        for (const key of ['showGuide', 'showGiantDecorativeText', 'showFixedGeo']) {
            if (settings[key] !== undefined) this.tuning[key] = settings[key] !== false;
        }
        if (settings.showOnlyText !== undefined) {
            this.tuning.showOnlyText = settings.showOnlyText === true;
        }
        /* ★ 2026-10-11 三个数值旋钮（上游滑杆域 0..2 / step 0.05）：
           cameraIntensity 乘进相机幅度、typographyMotion 乘进运动幅度与发光强度、
           mgDensity 决定背景短线密度 `round(4 + mgDensity*5)`。这里再夹一次防手改配置越界。 */
        for (const key of ['cameraIntensity', 'typographyMotion', 'mgDensity']) {
            const v = Number(settings[key]);
            if (Number.isFinite(v)) this.tuning[key] = Math.min(2, Math.max(0, v));
        }
        /* ★ 2026-10-11 外层边框三档（上游只认这三个值；其余回落默认档 'full'） */
        if (settings.outerFrameMode !== undefined) {
            const m = String(settings.outerFrameMode);
            this.tuning.outerFrameMode = (m === 'none' || m === 'frame' || m === 'full') ? m : 'full';
        }
        /* ★ 2026-10-11 Aria 扩展：间奏标记也走谱面（默认 false = 上游行为；见 instrumentalLines.js） */
        if (settings.interludeStaff !== undefined) {
            this.interludeStaff = settings.interludeStaff === true;
        }
        if (typeof settings.fontSize === 'number' && settings.fontSize > 0) {
            /* ★ 2026-10-11 回退到上游语义：上游把排版设置里的 lyricsFontScale
               **原样**灌进字号公式（VisualizerSonnet 的 prop → sonnetSceneBuilder.ts:181），
               引擎不做夹取。本地曾软施加 clamp [0.8,1.2] 去压「巨字溢顶」—— 那是
               「基础字号」设置值偏大（1.5）的连带观感，不该由引擎兜。
               现在设置值原样生效：想让观感等同上游默认，把「基础字号」调到 1.00 即可。 */
            this.lyricsFontScale = settings.fontSize;
        }
        /* ★ 2026-09-30：PV 设置区控件全量接通（此前只接 2 项，用户实测「设置项没用」） */
        if (typeof settings.cameraZoom === 'number' && settings.cameraZoom > 0) {
            /* 「默认焦距(镜头特写)」：>1 聚焦当前词超大特写，<1 显示更完整句子 */
            this.cameraZoomScale = Math.min(3, Math.max(0.5, settings.cameraZoom));
        }
        if (typeof settings.cameraSpeed === 'number' && settings.cameraSpeed > 0) {
            this.cameraSpeed = settings.cameraSpeed; // 运镜平滑速度：越大平滑窗口越短跟手
        }
        this.settingsFlags = {
            showHud: settings.showHud !== false,
            showParticles: settings.showParticles !== false,
            showDecorations: settings.showDecorations !== false,
            aiColorSync: settings.aiColorSync !== false,
        };
        if (this.settingsFlags.aiColorSync === false) {
            this.theme.wordColors = []; // 情感词多色联动关 = 不做关键词着色
        }
        this.invalidateScenes();
    }

    /** 场景作废（主题/颜色/字号变化后由 _tick 按新参数重建） */
    invalidateScenes() {
        /* 主题色可能刚变：宿主底色跟着走（本地唯一总钩子，见 init 的「切镜闪黑」说明） */
        this._syncHostBackground();
        /* 海报的配色/字体是建场景时烘焙进去的：换主题必须让它按新色重建
           （上游 drawCredits 在 resize 与 setSongMetadata 时调；本仓把主题变化也并进指纹） */
        this._creditsSig = '';
        this._overlaySig = '';   // 画框角标同样是烘焙的（主色 + outerFrameMode）
        this.scenes.forEach(scene => this._destroyScene(scene));
        this.scenes.clear();
        this.activeParagraphIndex = -1;
    }

    /** 封面取色（100-cover-background）：accent/背景跟随新歌封面。
        文字色/glow 烘焙在 TextStyle 里，清场景让 _ensureScene 用新色重建 */
    applyCoverPalette(palette) {
        if (!palette) return;
        const accent = palette.accent || palette.primary;
        const bg = deriveCoverBackground(palette);
        /* ★ 2026-10-01 背景图形跟随主题色（用户实测「背景图形不跟随主题色」）：
           MG 几何/装饰线/guide 的主色是 secondaryColor——此前恒定 zinc 灰，
           封面换色不变。跟随封面 secondary；用户手动设置过「图形色」则不覆盖。 */
        const secondary = palette.secondary || palette.primary || null;
        if ((accent && accent !== this.theme.accentColor) || (bg && bg !== this.theme.backgroundColor)
            || (secondary && secondary !== this.theme.secondaryColor)) {
            if (accent) this.theme.accentColor = accent;
            if (bg) this.theme.backgroundColor = bg;
            if (secondary && !this._secondaryColorLocked) this.theme.secondaryColor = secondary;
            this.invalidateScenes();
        }
    }

    setPerfConfig() { /* M2：按档降采样/滤镜开关 */ }

    handleResize() {
        if (!this.app) return;
        this.scenes.forEach(scene => this._destroyScene(scene));
        this.scenes.clear();
        this.activeParagraphIndex = -1;
    }

    start() { /* ticker 常驻；由 init 启动 */ }

    /** 暂停/恢复渲染（预览引擎切走时挂起，帧循环仍在但直接返回） */
    setPaused(p) {
        this.paused = !!p;
        /* ★ 2026-10-01 卡顿修复（用户实测「切新模式再切回英文歌词很卡」）：
           此前只置 flag——Pixi Application 的 ticker 仍在每帧跑 renderer.render
           （全屏 WebGL 绘制），隐藏的 sonnet 实例（主引擎 + 设置页预览实例）持续
           烧 GPU，挤占歌词逐字高亮的帧预算。这里真正停/启 ticker；_tickInner 的
           flag 判断保留作双保险。 */
        if (!this.app) return;
        if (this.paused) {
            this.app.stop();
        } else if (!this.app.ticker.started) {
            this.app.start();
        }
    }

    destroy() {
        this.destroyed = true;
        window.removeEventListener('resize', this._onResize);
        if (this.app) {
            this.app.ticker.remove(this._tick);
            this.scenes.forEach(scene => this._destroyScene(scene));
            this.scenes.clear();
            this.app.destroy(false, { children: true });
            this.app = null;
        }
        if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        /* ★ 2026-10-11 撤掉自有的宿主底色层（见 _syncHostBackground 的说明） */
        if (this.bgEl && this.bgEl.parentNode) this.bgEl.parentNode.removeChild(this.bgEl);
        this.bgEl = null;
        this.creditsLayer = null;
        this.overlayLayer = null;
        this.sceneRoot = null;
    }

    /* ---------- 内部 ---------- */

    _rebuildProgram() {
        this.program = compileSonnetProgram(this.lines, 'sonnet');
        this.scenes.forEach(scene => this._destroyScene(scene));
        this.scenes.clear();
        this.activeParagraphIndex = -1;
    }

    _tick = () => {
        if (!this.app || this.destroyed || this.paused) return;
        try {
            if (typeof this.onBeforeTick === 'function') this.onBeforeTick();
            if (!this.program) return;
            this._tickInner();
        } catch (e) {
            /* 帧内异常落到 _lastError 供诊断探针读取；吞掉以保渲染循环存活 */
            this._lastError = String(e && e.stack ? e.stack : e).slice(0, 400);
        }
    };

    _tickInner = () => {
        const time = this.currentTime;

        /* ★ 场景尺寸守卫（2026-09-29）：放歌路径在容器刚挂上、布局未完成时建场景，
           renderer.width=0 → 文字以 24px 烘焙在原点并随 scenes 缓存永久固化
           （Pixi resizeTo 只改 canvas，容器尺寸变化不触发 window.resize）。
           每帧比对 renderer 尺寸，变化即作废缓存，下一帧按新尺寸重建。 */
        /* ★★★ 2026-10-02 场景尺寸源统一为「容器 CSS 尺寸」（用户第八轮「偏左上」的
           真根因）：此前用 renderer.width/resolution 反推布局尺寸——用户窗口从
           1732×564 变成 1138×680 后，renderer 反推值与实际画布显示尺寸脱钩
           （水印实证 pos=(866,282)=1732/2 与 564/2，而画布是 1138×680），场景按旧
           尺寸烘焙 → 布局原点落在画布外 → 内容被裁到左上。容器 clientWidth/Height
           与画布显示尺寸必然一致，作为唯一尺寸源。 */
        const cw = this.container ? this.container.clientWidth : 0;
        const ch = this.container ? this.container.clientHeight : 0;
        const rw = cw || (this.app.renderer.width / this.app.renderer.resolution);
        const rh = ch || (this.app.renderer.height / this.app.renderer.resolution);
        /* ★ 2026-09-30 下限 320×240→160×120：设置页预览窗比旧守卫小，场景永不建立
           （用户实测「verse 的预览框没有歌词」） */
        if ((rw !== this._lastSceneW || rh !== this._lastSceneH) && rw >= 160 && rh >= 120) {
            this.scenes.forEach(scene => this._destroyScene(scene));
            this.scenes.clear();
            this.activeParagraphIndex = -1;
            this._lastSceneW = rw;
            this._lastSceneH = rh;
        }

        const paragraphIndex = findSonnetParagraphIndexAtTime(this.program, time);
        const paragraph = this.program.paragraphs[paragraphIndex];
        if (!paragraph) return;

        /* ★ 2026-10-02 照抄 folia（createSonnetPixiRuntime.ts 707-760）：上游没有
           fadeScene/交叉淡化/textFade——段落间是**硬切**，退场软化只有段落自身的
           transitionOut 时间窗（exit 转场帧）。此前自创的 hold/压暗/文本复位全是
           「闪黑→闪回」的来源。邻居场景每帧只预建一个（上游 718-733：场景构建要
           跑全量字形布局，一帧三个会掉帧）。 */
        if (this.activeParagraphIndex !== paragraphIndex) {
            /* ★★★ 2026-10-03 修「verse 有时没有歌词（~50% 概率）」：此前是
               「先提交 activeParagraphIndex、再 _ensureScene」——而建场景可能失败
               （切模式瞬间容器 clientWidth=0 且布局未就绪 → _ensureScene 返回 null；
               或构建中抛异常被帧级 try 捕获）。失败后索引已提交，下一帧
               activeParagraphIndex === paragraphIndex，**永远不会重试** → 整段无歌词。
               容器就绪时机随机 ⇒ 概率性地「有/没有歌词」。
               改为：场景构建成功才提交索引；失败直接返回本帧（旧场景继续显示，
               比黑屏好），下一帧自动重试。 */
            const built = this._ensureScene(paragraphIndex);
            if (!built) return;
            this.activeParagraphIndex = paragraphIndex;
            this.scenes.forEach((scene, index) => {
                if (Math.abs(index - paragraphIndex) > 1) {
                    this._destroyScene(scene);
                    this.scenes.delete(index);
                }
            });
        } else if (!this.songSwap) {
            const next = paragraphIndex + 1;
            const previous = paragraphIndex - 1;
            if (next < this.program.paragraphs.length && !this.scenes.has(next)) {
                this._ensureScene(next);
            } else if (previous >= 0 && !this.scenes.has(previous)) {
                this._ensureScene(previous);
            }
        }

        /* 上游 740-746：严格只画激活场景。失活场景卸载显示树（释放 GPU 纹理，
           树保留可 seek），并记住当时激活的 shot 以便卸载。 */
        this.scenes.forEach((scene, index) => {
            const isActive = index === paragraphIndex;
            scene.container.visible = isActive;
            if (!isActive) {
                const lastShot = scene.activeShotId != null ? scene.shots.get(scene.activeShotId) : null;
                if (lastShot) unloadPixiDisplayTree(lastShot.container);
                scene.activeShotId = null;
            }
        });

        // 激活 shot（上游 773-781：时间线上最后一个已开始的 shot）
        let shotIndex = 0;
        for (let i = paragraph.shots.length - 1; i >= 0; i--) {
            if (time >= paragraph.shots[i].startTime) { shotIndex = i; break; }
        }
        const shot = paragraph.shots[shotIndex];
        if (!shot) return;
        const scene = this.scenes.get(paragraphIndex);
        if (!scene) return;
        /* 海报层：尺寸/元数据/字号变化时懒重建（上游 drawCredits 的触发点是 resize 与
           setSongMetadata；本仓合成一个指纹，每帧比一次字符串即可自愈） */
        this._ensureCreditsLayer(scene.width, scene.height);
        /* 画框角标层：同样是「指纹变化才重画」（上游 drawOverlay 只在 resize / 换歌时调） */
        this._ensureOverlayLayer(scene.width, scene.height);

        /* 上游 747-766：转场帧 = shot 转场，否则段落转场（enter 窗口取上一段
           transitionOut 时长 0.16-0.3s；非 enter 窗口给段尾 exit 帧）。 */
        const sceneSeed = hashSonnetSeed(`${this.program.seed}:${paragraph.id}`);
        let transition = this.transitionsEnabled
            ? resolveSonnetShotTransitionFrame(paragraph.shots, shotIndex, time, true, sceneSeed)
            : IDLE_SONNET_TRANSITION_FRAME;
        if (transition === IDLE_SONNET_TRANSITION_FRAME) {
            const previousTransition = paragraphIndex > 0
                ? this.program.paragraphs[paragraphIndex - 1]?.transitionOut
                : null;
            const enterDuration = previousTransition
                ? Math.max(0.16, Math.min(0.3, previousTransition.endTime - previousTransition.startTime))
                : 0;
            const entering = this.transitionsEnabled
                && previousTransition != null
                && time >= paragraph.startTime
                && time <= paragraph.startTime + enterDuration;
            transition = entering
                ? resolveSonnetEnterTransitionFrame(
                    previousTransition.kind, time - paragraph.startTime, enterDuration, true, sceneSeed)
                : resolveSonnetExitTransitionFrame(paragraph, time, this.transitionsEnabled, sceneSeed);
        }
        this._updateScene(scene, shot, shotIndex, time, paragraph, transition);

        /* ★ 片尾 credits（上游 createSonnetPixiRuntime.ts:349-354 计算 + 427-434 驱动）：
           最后一段 + 歌曲有元数据 → 歌词淡出模糊、海报浮入。
           ★ 2026-10-11 三处对齐上游：
           ① 时间基用 `paragraph.endTime`（上游传 finalParagraph.endTime）；此前 +1.2s 是本地
              自加，海报（含"切到视图中央"的位移）比 folia 晚 1.2s 升起。
           ② 片尾模糊走 SonnetOutroBlur（独立 BlurFilter，repeatEdgePixels 防 vignette 被撑开）；
              此前写成 `scene.blurFilter.blur += lyricBlur`——与**转场** blur 抢同一个强度位。
           ③ **海报挂独立层 `this.creditsLayer`**（上游把 creditsContainer 与 sceneContainer
              并列加在 stage 上）。此前挂在场景容器里，被上面的 `alpha *= lyricAlpha`（收到 0）
              连坐成透明 → 海报永远看不见，且构建的 try/catch 把痕迹也清了。 */
        const isFinalScene = paragraphIndex === this.program.paragraphs.length - 1;
        const creditsFrame = resolveSonnetCreditsFrame(
            time,
            /* 非末段给 +∞：elapsed ≤ 0 ⇒ inactive，与上游 `finalParagraph?.endTime ?? Infinity` 同义 */
            isFinalScene ? paragraph.endTime : Number.POSITIVE_INFINITY,
        );
        const hasCredits = !!this.creditsLayer && this.creditsLayer.children.length > 0;

        /* 歌词淡出只作用在**场景**上（上游 `lyricAlpha = isFinalScene && hasCredits ? … : 1`） */
        if (isFinalScene && hasCredits && creditsFrame.active) {
            scene.container.alpha *= creditsFrame.lyricAlpha;
        }
        /* 片尾模糊只挂最后一段；其余情形（含非激活段）摘干净。
           strength<=0 时 update 内部就是 clear()，与上游 `!creditsFrame.active` 分支等价。 */
        if (this.outroBlur) {
            if (isFinalScene && hasCredits) this.outroBlur.update(scene, creditsFrame.lyricBlur || 0);
            else this.outroBlur.clear();
        }

        /* 海报层逐帧驱动（上游 428-434 一比一；层自身 pivot/position 已锚在屏幕中心） */
        if (this.creditsLayer) {
            this.creditsLayer.visible = creditsFrame.active && hasCredits
                && this.tuning.showOnlyText !== true;
            this.creditsLayer.alpha = creditsFrame.posterAlpha;
            this.creditsLayer.position.set(
                scene.width / 2,
                scene.height / 2 + (creditsFrame.posterOffsetY || 0) * scene.height,
            );
            this.creditsLayer.scale.set(creditsFrame.posterScale || 1);
        }
    };

    _ensureScene(paragraphIndex) {
        if (this.scenes.has(paragraphIndex)) return this.scenes.get(paragraphIndex);
        const paragraph = this.program.paragraphs[paragraphIndex];
        if (!paragraph) return null;
        /* 布局未就绪（容器 0 尺寸）不建场景——坐标按 0 烘焙会固化（见 _tickInner 守卫）。
           ★★★ 尺寸源 = 容器 CSS 尺寸（与画布显示必然一致）；renderer 反推值在
           DPR/窗口变化后会与实际画布脱钩（用户第八轮偏左上根因）。 */
        const width = (this.container && this.container.clientWidth)
            || (this.app.renderer.width / this.app.renderer.resolution);
        const rawHeight = (this.container && this.container.clientHeight)
            || (this.app.renderer.height / this.app.renderer.resolution);
        if (width < 160 || rawHeight < 120) return null;
        /* ★ 布局高度 = 视口高 − 底部播放器栏（96px）：canvas 全高（halftone 网点等
           滤镜铺满视口），内容安全区收敛到栏之上。 */
        /* 预览小窗不钳 240 下限：按实际高度收敛（bottomInset 仅在有余量时生效） */
        const height = rawHeight > 300 ? Math.max(240, rawHeight - this.bottomInset) : rawHeight;

        const container = new Container();
        const sceneBackgroundLayer = new Container();
        /* ★ 2026-09-30 上游形态重构：每 shot 独立容器（mg → guide → halo → text），
           pivot=hero 焦点、position=相机摆位——运镜/焦点追踪依赖 per-shot 容器。
           此前共享 textLayer + 滞留字压暗是近似架构的 hack，随本次一起退役。 */
        container.addChild(sceneBackgroundLayer);
        this.sceneRoot.addChild(container);

        const fontFamily = this.fontFamily
            ? this._resolveFontStack(this.fontFamily)
            : this._resolveFontStack('default');
        const sceneSeed = hashSonnetSeed(`${this.program.seed}:${paragraph.id}`);

        /* ★ 背景装饰（上游 sonnetSceneBuilder 1:1）：
           theme.backgroundColor 的 0.10 覆盖 + seed 撒点的装饰横线（secondary/accent 交替） */
        const bgTint = new Graphics();
        bgTint.rect(0, 0, width, height)
            .fill({ color: this._colorNumber(this.theme.backgroundColor || '#09090b'), alpha: 0.10 });
        sceneBackgroundLayer.addChild(bgTint);
        /* ★ 2026-10-11 「背景短线密度」接通：上游是 `Math.round(4 + tuning.mgDensity * 5)`
           （sonnetSceneBuilder.ts:106），本仓此前把 mgDensity 硬编码成 0.5 —— 滑杆接上了也没用。
           夹取到 [0,2]（与面板/上游滑杆同域），并且 t/mgDensity 缺失时回落到 1。 */
        const mgDensity = Number.isFinite(Number(this.tuning.mgDensity))
            ? Math.min(2, Math.max(0, Number(this.tuning.mgDensity))) : 1;
        const density = Math.round(4 + mgDensity * 5);
        for (let index = 0; index < density; index++) {
            const x = ((sceneSeed + index * 97) % 997) / 997 * width;
            const y = ((sceneSeed + index * 193) % 991) / 991 * height;
            const length = 32 + ((sceneSeed + index * 43) % 180);
            sceneBackgroundLayer.addChild(new Graphics()
                .moveTo(x, y)
                .lineTo(Math.min(width, x + length), y)
                .stroke({
                    color: this._colorNumber(index % 2 ? this.theme.secondaryColor || '#71717a' : this.theme.accentColor || '#f4f4f5'),
                    width: index % 3 === 0 ? 2 : 1,
                    alpha: 0.12 + (index % 4) * 0.04,
                }));
        }

        /* 侧边竖排元数据（上游 sonnetSceneBuilder.ts:95 的 `showOuterMetadata`
           = 「非仅文字」且 `outerFrameMode === 'full'`。此前本仓**无条件**画，
           于是「外层边框」选 `none`/`frame` 时这行还赖在画面上 —— 半截开关） */
        const showOuterMetadata = this.tuning.showOnlyText !== true
            && this.tuning.outerFrameMode === 'full';
        if (showOuterMetadata && this.theme.name) {
            const metaText = new Text({
                text: `[ THEME ] ${String(this.theme.name).toUpperCase()}`,
                style: new TextStyle({
                    fontFamily,
                    fontWeight: 'bold',
                    fontSize: 14,
                    fill: this.theme.primaryColor || '#f4f4f5',
                    letterSpacing: 4,
                }),
            });
            metaText.alpha = 0.2;
            metaText.rotation = -Math.PI / 2;
            metaText.position.set(20, height - 20);
            metaText.anchor.set(0, 1);
            sceneBackgroundLayer.addChild(metaText);
        }

        /* ★ 后期滤镜链（lens→noise→contrast→print，上游 applySonnetScenePostProcess）
           与转场 blur 并存：container.filters = [blur, ...post] */
        const blurFilter = new BlurFilter({ strength: 0, quality: 2 });
        blurFilter.enabled = false;
        const profile = resolveSonnetPostProcessProfile(this.theme, this.tuning, false);
        const postFilters = applySonnetScenePostProcess(
            { Container, Graphics, Text, TextStyle, BlurFilter, Color, Filter, GlProgram, UniformGroup, NoiseFilter, ColorMatrixFilter, Texture },
            container, profile, sceneSeed,
        );
        /* ★ mono-glitch 专用 shader（上游 transitionGlitchEffect 同款）：转场撕裂 */
        const transitionGlitchEffect = createSonnetGlitchEffect(
            { Filter, GlProgram, UniformGroup, Texture },
            container,
        );
        if (transitionGlitchEffect && transitionGlitchEffect.filter) {
            transitionGlitchEffect.filter.enabled = false;
            postFilters.push(transitionGlitchEffect.filter);
        }
        container.filters = [blurFilter, ...postFilters];

        /* ★ 2026-10-11 片尾海报**不再**建在场景里：它挂独立的 `this.creditsLayer`
           （见 _ensureCreditsLayer 与 init 处的说明）。建在场景容器里会被片尾的
           `scene.container.alpha *= lyricAlpha`（lyricAlpha 收到 0）连坐成透明 ——
           这正是"最后没有歌曲信息分镜"的真因。 */

        const scene = {
            index: paragraphIndex,
            paragraph,
            container,
            blurFilter,
            profile,
            width,
            height,
            shots: new Map(),
            shotOrder: [],
            breathPhase: (hashSonnetSeed(paragraph.id) % 1000) / 1000,
        };
        scene.transitionGlitchEffect = transitionGlitchEffect;

        paragraph.shots.forEach((shot, shotIndex) => {
            const lineGroups = shot.lineIndices.map(sourceIndex => paragraph.lines[sourceIndex].segments);
            const flatSegments = lineGroups.flat();
            /* ★ 字号公式（上游 sonnetSceneBuilder.ts:181 一比一）：
               `Math.max(24, Math.min(112, (width / Math.max(7, wordCount * 2.15)) * heroScale * lyricsFontScale))`
               ★ 2026-10-11 修正一处误记：上限 112 **本来**就是上游值（原注释「126→112 对齐上游」
               是对的），真正偏离上游的只有**下限**——本地抬到了 30，现回 24。 */
            const wordCount = Math.max(1, flatSegments.filter(s => s.isWordLike !== false && s.text.trim()).length);
            const heroScale = shot.kind === 'type-impact' ? 1.55 : shot.kind === 'quiet-tableau' ? 0.82 : 1;
            const isCompactStage = width < 960;
            const minShotFont = isCompactStage ? Math.max(12, Math.round(24 * width / 960)) : 24;
            const maxShotFont = isCompactStage ? Math.max(48, Math.round(112 * width / 960)) : 112;
            const shotFontSize = Math.max(minShotFont, Math.min(maxShotFont,
                (width / Math.max(7, wordCount * 2.15)) * heroScale * (this.lyricsFontScale || 1)));

            /* ★ 上游 per-shot 容器（sceneBuilder 280-316 形态）：
               MG 全量（bg/geo/fixed/particle 内含）→ guide → halo → text(ca) */
            const shotContainer = new Container();
            const guideLayer = new Container();
            const textLayer = new Container();
            const caLayer = new Container();
            textLayer.addChild(caLayer);

            const mg = buildSonnetShotMg({ Container, Graphics, Color }, shot.kind, this.theme,
                width, height, sceneSeed + shotIndex * 97, new Map());
            shotContainer.addChild(mg);

            const { layer: haloLayer } = createSonnetHaloLayer(
                { Container, BlurFilter }, scene.profile,
            );
            shotContainer.addChild(guideLayer);
            shotContainer.addChild(haloLayer);
            shotContainer.addChild(textLayer);

            const placements = resolveSonnetTypographyLayout({
                lines: lineGroups,
                shotKind: shot.kind,
                paragraphKind: paragraph.kind,
                width,
                height,
                baseFontSize: shotFontSize,
                fontFamily,
                fontWeight: null,
            });
            /* ★ 2026-10-02 内容安全区自适应（用户实测「焦点偏左上/画面空荡」）：
               上游布局把词散布在完整画布上（tracking-ribbon x 游走 ±0.28w、长句词链
               更远），运行时 pivot 追当前词后其余词全在画外——画面只剩 1-2 个字 +
               露出的背景 MG 碎片（用户看到「左上角一个方框」）。此处把非装饰词块的
               包围盒在超出安全区（0.88w × 0.84h）时整体等比缩放并平移，使整句内容
               恒完整落在画中；装饰巨字（刻意偏移的背景大字）不参与包围盒但跟随变换，
               以免它们把包围盒撑爆。 */
            fitSonnetPlacementsToSafeArea(placements, {
                width,
                height,
                cameraZoom: shot.camera.zoom,
                cameraZoomScale: this.cameraZoomScale,
                isCompactStage,
            });
            const shotView = {
                shot, container: shotContainer, segments: [], mg,
                textLayer, guideLayer,
                baseFontSize: shotFontSize,
                placementsLen: placements.length, flatLen: flatSegments.length,
            };
            /* ★ 2026-10-11 谱面去重（上游 sonnetSceneBuilder.ts:232-239 一比一）：
               `♪` 行可以多行共用一个镜头，而**整张谱面属于镜头、不属于每一行**——
               不去重就会在同一镜头里叠画多张 La Folia 谱（上游原注释：
               "Virtual instrumental lines can share one shot; the complete staff
               belongs to the shot, not each line."）。 */
            let staffViewAdded = false;
            placements.forEach((placement, segmentIndex) => {
                const segment = flatSegments[placement.segmentIndex];
                if (!segment) return;
                /* ★ 2026-10-11 与 sonnetTextViewBuilder 用**同一个**判定（默认档等价上游的
                   `segment.text === '♪'`；用户在面板打开「间奏标记也走谱面」时一起放宽）——
                   两边若用不同判定，去重会与实际建视图的集合错位。 */
                if (isSonnetStaffSegment(segment.text, this.interludeStaff === true)) {
                    if (staffViewAdded) return;
                    staffViewAdded = true;
                }
                /* pixi 需带 Graphics + Color（Guides/TextFixedGeo/FrameDecor 消费） */
                const view = buildSonnetTextView({ Container, Text, TextStyle, Graphics, Color }, {
                    pixi: { Container, Text, TextStyle, Graphics, Color },
                    segment,
                    placement,
                    segmentIndex,
                    baseFontSize: shotFontSize,
                    shotStartTime: shot.startTime,
                    shotEndTime: shot.endTime,
                    paragraphKind: paragraph.kind,
                    width,
                    fontFamily,
                    fontWeight: null,
                    theme: this.theme,
                    glowEnabled: this.glowEnabled,
                    textLayer,
                    caLayer,
                    guideLayer,
                    /* ★ 2026-10-11 「装饰画框与文字浮标」接通：此前硬编码 true —— 面板/上游的
                       `tuning.showFixedGeo` 只被**逐帧门控**读（开放画框显隐），建场景这一侧的
                       `shouldAddBgShape`（文字浮标图形）永远为真，等于开关只关了一半。
                       上游口径是 `!showOnlyText && tuning.showFixedGeo`（sonnetSceneBuilder.ts:92） */
                    showFixedGeo: this.tuning.showOnlyText !== true
                        && this.tuning.showFixedGeo !== false,
                    /* ★ 2026-10-11 Aria 扩展：间奏标记也走谱面（默认 false = 上游行为） */
                    interludeStaff: this.interludeStaff === true,
                });
                shotView.segments.push(view);
            });

            /* ★ 2026-10-02 摆位终版·锚 hero（水印铁证：shot=(580,345)+pivot=(0,0) 全居中
               但「只是」巨字仍偏左上 235px——偏的不是容器而是内容：pivot 锚「包围盒
               中心」时 bbox 被侧边支撑词拉偏，视觉主体 hero 不在中心。用户语义的
               「中心」= 正在唱的那个大词在中心 ⇒ pivot 直接锚 fit 后的 hero placement，
               hero 恒居画面正中，support/装饰围绕（fit 已保证整体在安全区）。
               追踪出发点=hero（applyShotCamera 里 ×0.2+clamp）。 */
            const heroPlacement = placements.find(p => p.role === 'hero');
            const isPoster = shot.kind === 'poster-blocks';
            const rawFocusX = isPoster ? 0 : (heroPlacement ? heroPlacement.x : 0);
            const rawFocusY = isPoster ? 0 : (heroPlacement ? heroPlacement.y : 0);
            const piv = hasVerticalSonnetContent(placements)
                ? clampSonnetPivotToViewport({
                    boxes: placements,
                    heroPlacement,
                    isPosterBlocks: isPoster,
                    width,
                    height,
                    rawHeight,
                    cameraX: shot.camera.x,
                    cameraY: shot.camera.y,
                    cameraZoom: shot.camera.zoom,
                    cameraZoomScale: this.cameraZoomScale,
                    isCompactStage,
                })
                : {
                    focusX: isCompactStage ? rawFocusX * 0.35 : rawFocusX,
                    focusY: isCompactStage ? rawFocusY * 0.35 : rawFocusY,
                    baseX: width * (isPoster ? 0.5 : 0.5 + shot.camera.x * (isCompactStage ? 0.35 : 1)),
                    baseY: isPoster
                        ? height / 2
                        : (isCompactStage ? height / 2 : rawHeight / 2) + shot.camera.y * height * (isCompactStage ? 0.1 : 0.2),
                };
            shotContainer.pivot.set(piv.focusX, piv.focusY);
            shotContainer.position.set(piv.baseX, piv.baseY);
            shotView.baseX = piv.baseX;
            shotView.baseY = piv.baseY;
            shotView.basePivotX = piv.focusX;
            shotView.basePivotY = piv.focusY;
            shotView.contentBounds = computeSonnetContentBounds(placements);

            shotContainer.visible = false;
            container.addChild(shotContainer);
            scene.shots.set(shot.id, shotView);
            scene.shotOrder.push(shot.id);
        });

        this.scenes.set(paragraphIndex, scene);
        return scene;
    }

    /** css hex → 0xRRGGBB（Pixi Graphics fill 用数字色） */
    _colorNumber(color) {
        const v = String(color || '#FFFFFF').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) return parseInt(v.slice(1), 16);
        if (/^#[0-9a-fA-F]{3}$/.test(v)) return parseInt(v[1] + v[1] + v[2] + v[2] + v[3] + v[3], 16);
        return 0xFFFFFF;
    }

    _pixi() {
        return { Container, Text, TextStyle };
    }

    _updateScene(scene, shot, shotIndex, time, paragraph, transitionFrame) {
        const tf = transitionFrame || IDLE_SONNET_TRANSITION_FRAME;
        const width = scene.width;
        const height = scene.height;
        const shotView = scene.shots.get(shot.id);
        if (!shotView) return;

        /* ★ 2026-10-11 逐帧姿态改调上游 sonnetShotFrame.ts 的机械移植件
           （./sonnetShotFrame.js 的 updateSonnetShot）：相机（motion 路径 / 焦点跟踪 /
           呼吸 / 震颤）、间隙尾段漂移、MG（含粒子层游动与固定几何保持正立）、引导线、
           开放画框、逐字入场·色差·残影**全部在其中**，且与上游逐行一致。
           此前这些在本文件内联且被简化（用户实测「粒子特效像没动」）：粒子层只切
           visible 不游动、guide/frameDecor 从不 update、入场基值 0.16 被抬到 0.45、
           色差只做水平位移、parallaxScale 硬编码 1、间隙漂移漏了 mod 调制。
           audioBands/audioPower 上游是 framer-motion 的 MotionValue（`.get()`），
           这里用同形垫片喂本仓真实电平（setAudioLevels 灌入的 0~255，MG 消费）。 */
        updateSonnetShot(shotView, time, width, height, 0, {
            tuning: this.tuning,
            theme: this.theme,
            audioBands: {
                bass: { get: () => (this.audioLevels && this.audioLevels.bass) || 0 },
                vocal: { get: () => (this.audioLevels && this.audioLevels.vocal) || 0 },
            },
            audioPower: { get: () => (this.audioLevels && this.audioLevels.power) || 0 },
            mod: () => 1,        /* 本仓无 Folium tunable：恒等（等价于上游缺省 1） */
            zoomScale: this.cameraZoomScale || 1,                 /* 本仓「默认焦距」旋钮 */
            focusSmoothingWindow: 0.12 / (this.cameraSpeed || 1), /* 本仓「运镜平滑速度」 */
        });

        /* 转场帧（上游 810-830 一比一）：alpha/位移/缩放/旋转/blur/glitch 全部来自
           转场帧——shot 边界窗口或段落 transitionOut 窗口。这是上游唯一的切镜软化，
           没有第二层压暗。 */
        scene.container.alpha = tf.alpha;
        scene.container.pivot.set(width / 2, height / 2);
        scene.container.position.set(width / 2 + tf.x * width, height / 2 + tf.y * height);
        scene.container.scale.set(tf.scale);
        scene.container.rotation = tf.rotation;
        scene.blurFilter.blur = tf.blur;
        scene.blurFilter.enabled = tf.blur > 0.01;
        if (scene.transitionGlitchEffect && scene.transitionGlitchEffect.filter) {
            scene.transitionGlitchEffect.update(tf.glitch, tf.glitchSeed);
            scene.transitionGlitchEffect.filter.enabled = tf.glitch > 0.01;
        }

        /* 逐 shot 显隐（上游 792-803 一比一）：严格只有激活镜可见，其余直接 return；
           shot 切换时对旧镜 unload 显示树（释放 GPU 纹理，树保留可 seek）。
           ★ 无交叉淡化、无旧镜保留、无文本压暗——上游就是硬切 + 转场帧软化。 */
        const flags = this.settingsFlags || {};
        scene.shots.forEach((sv, shotId) => {
            const isActive = shotId === shot.id;
            sv.container.visible = isActive;
            if (!isActive) return;
            sv.container.alpha = 1;
            if (sv.mg) {
                if (sv.mg.bgLayer) sv.mg.bgLayer.visible = flags.showHud !== false;
                if (sv.mg.particleLayer) sv.mg.particleLayer.visible = flags.showParticles !== false;
                if (sv.mg.geoLayer) sv.mg.geoLayer.visible = flags.showDecorations !== false;
                if (sv.mg.fixedGeoLayer) sv.mg.fixedGeoLayer.visible = flags.showDecorations !== false;
            }
        });
        if (scene.activeShotId !== shot.id) {
            const previousShot = scene.activeShotId != null ? scene.shots.get(scene.activeShotId) : null;
            if (previousShot) unloadPixiDisplayTree(previousShot.container);
            scene.activeShotId = shot.id;
        }

    }

    /* ★ 2026-10-01 真空根治辅助：取段落/镜头首个字形的入场时间（秒）。
       字形按词时间入场，行/段/镜的 startTime 是行头——两者可能差 1s+，
       交叉淡化窗口必须以真实首字形为准，否则切换点全黑。
       ★ 2026-10-02 二次根修（用户复测「最后一个词闪黑→真空半秒→旧句突然重现再渐隐」）：
       编译后的 program 行对象不带 words（probe_units 实测 wordStart=null）→
       旧实现永远 fallback 到 line.start，而 yrc 行头早于人声 → hold 窗口按过早的
       时间结算 → 旧内容 0.7s 内淡光，新首字形（晚 1s+）入场前全黑。改为优先读
       已建场景里的真实字形 startTime（pre-build ±1 保证切换时场景已就绪）。 */
    _sceneFirstGlyphTime(scene) {
        if (!scene) return null;
        let first = null;
        scene.shots.forEach(shotView => {
            shotView.segments.forEach(segmentView => {
                segmentView.glyphs.forEach(glyph => {
                    if (typeof glyph.startTime === 'number'
                        && (first === null || glyph.startTime < first)) first = glyph.startTime;
                });
            });
        });
        return first;
    }

    _getParagraphFirstGlyphTime(paragraph, paragraphIndex) {
        const fromScene = this._sceneFirstGlyphTime(
            typeof paragraphIndex === 'number' ? this.scenes.get(paragraphIndex) : null);
        if (fromScene !== null) return fromScene;
        const first = paragraph && paragraph.lines && paragraph.lines[0];
        if (!first) return paragraph ? paragraph.startTime : 0;
        const line = first.line || first;
        const words = Array.isArray(line.words) ? line.words : [];
        for (const w of words) {
            if (typeof w?.start === 'number') return w.start;
        }
        return typeof line.start === 'number' ? line.start : (paragraph.startTime || 0);
    }

    _getShotFirstGlyphTime(paragraph, shot, scene) {
        const shotView = scene && shot && shot.id !== undefined
            ? scene.shots.get(shot.id) : null;
        const fromScene = this._sceneFirstGlyphTime(shotView ? { shots: [shotView] } : null);
        if (fromScene !== null) return fromScene;
        const idx = shot && shot.lineIndices && shot.lineIndices[0];
        const first = idx !== undefined ? paragraph?.lines?.[idx] : null;
        if (!first) return shot ? shot.startTime : 0;
        const line = first.line || first;
        const words = Array.isArray(line.words) ? line.words : [];
        for (const w of words) {
            if (typeof w?.start === 'number') return w.start;
        }
        return typeof line.start === 'number' ? line.start : (shot.startTime || 0);
    }

    /** ★ 2026-10-11 宿主背景 = 主题底色（上游外壳语义）。见 init 里的「切镜闪黑」说明。
        用**引擎自有的底层 div**、而不是给容器本体上内联背景：容器是共用的
        .pv-view-container，给本体上色会在切走时残留（其他模式会 innerHTML='' 清子节点，
        但清不掉内联样式），而自有 div 只随本引擎的生灭走。 */
    _syncHostBackground() {
        const host = this.container;
        if (!host || typeof document === 'undefined') return;
        if (!this.bgEl || this.bgEl.parentNode !== host) {
            const el = document.createElement('div');
            el.style.position = 'absolute';
            el.style.inset = '0';
            el.style.pointerEvents = 'none';
            /* 插到最前：canvas 是后加的兄弟节点，天然盖在它上面 */
            host.insertBefore(el, host.firstChild);
            this.bgEl = el;
        }
        this.bgEl.style.backgroundColor = this.theme.backgroundColor || '#09090b';
    }

    /** ★ 2026-10-11 片尾海报层：按「尺寸 + 元数据 + 字号 + 仅文字」指纹懒重建。
        上游对应 `drawCredits`（触发点只有 resize 与 setSongMetadata）；本仓合成一个指纹，
        每帧比一次字符串，换歌 / 换尺寸 / 换主题都能自愈。 */
    _ensureCreditsLayer(width, height) {
        if (!this.creditsLayer) return;
        const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
        /* 键名兼容：在线链路写 {title, artist}，本地/早期链路写 {song, singer}（与片尾既有兜底一致） */
        const metadata = {
            title: meta.song || meta.title || null,
            artist: meta.singer || meta.artist || null,
            album: meta.album || null,
        };
        const sig = [
            width, height, metadata.title, metadata.artist, metadata.album,
            this.lyricsFontScale || 1, this.tuning.showOnlyText === true ? 1 : 0,
        ].join('|');
        if (sig === this._creditsSig) return;
        this._creditsSig = sig;

        /* 重建前彻底丢掉旧海报（上游 destroySonnetContainerChildren） */
        for (const child of this.creditsLayer.removeChildren()) child.destroy({ children: true });
        if (this.tuning.showOnlyText === true) return;
        if (!hasSonnetCreditsMetadata(metadata)) return;
        try {
            this.creditsLayer.addChild(buildSonnetCreditsPoster(
                { Container, Text, TextStyle, Graphics, Color },
                this.theme,
                metadata,
                width,
                height,
                this.lyricsFontScale || 1,
            ));
            /* 上游 drawCredits:229-231：容器 pivot/position 锚在屏幕中心，海报子节点用绝对坐标绘制 */
            this.creditsLayer.pivot.set(width / 2, height / 2);
            this.creditsLayer.position.set(width / 2, height / 2);
            this.creditsLayer.visible = false;
            this._creditsError = null;
        } catch (e) {
            /* ★ 不再静默：此前这段 try/catch 后面紧接 `_lastError = null`，海报建不出来毫无痕迹。
               用**独立字段**记（帧级 `_lastError` 的语义是"上一帧整体失败"，不要混在一起）。 */
            this._creditsError = String(e && e.stack ? e.stack : e).slice(0, 300);
        }
    }

    /** ★ 2026-10-11 画框角标层：屏幕坐标系、静态；尺寸 / 主色 / outerFrameMode / 仅文字
        变了才重画。上游对应 `drawOverlay`（在 resize 与换歌时调，
        createSonnetPixiRuntime.ts:207-208 与 250-252）。
        本层一旦抛异常会**带走整帧**（它排在 _updateScene 之前），所以照样就地兜住并留痕。 */
    _ensureOverlayLayer(width, height) {
        if (!this.overlayLayer) return;
        const sig = [
            width, height, this.theme.primaryColor, this.tuning.outerFrameMode,
            this.tuning.showOnlyText === true ? 1 : 0,
        ].join('|');
        if (sig === this._overlaySig) return;
        this._overlaySig = sig;
        try {
            drawSonnetFrameOverlay(
                { Graphics, Text, TextStyle, Color },
                this.overlayLayer,
                width,
                height,
                this.tuning,
                this.theme,
            );
            this._overlayError = null;
        } catch (e) {
            this._overlayError = String(e && e.stack ? e.stack : e).slice(0, 300);
        }
    }

    _destroyScene(scene) {
        /* 片尾模糊挂在本场景的 filters 上：销毁前先摘掉（否则 clear() 会写到已销毁的容器） */
        if (this.outroBlur && this.outroBlur.isOn(scene)) this.outroBlur.clear();
        scene.container.destroy({ children: true });
    }
}
