/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * SonnetEngine.js — folia sonnet 的 PixiJS 运行时（M1：文字管线 + 7 shot 布局 + 相机 + 呼吸）
 *
 * 上游：chthollyphile/folia-major createSonnetPixiRuntime.ts（48KB）的 M1 子集。
 * 架构对应：
 *   - Pixi App + ticker；渲染帧率与歌词时间解耦（ticker 渲染，update(t) 供时间）
 *   - 场景按段落懒建/缓存（激活 ±1），每帧严格只绘激活 shot
 *   - 所有运动是 currentTime 的纯函数；seek/暂停天然连续
 * M2 待补：三转场滤镜链、MG 族、背景装饰、credits、歌切换 dissolve、焦点追踪。
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
import { createSonnetGlitchEffect } from './sonnetGlitchFilter.js';
import { resolveSonnetCreditsFrame, hasSonnetCreditsMetadata, buildSonnetCreditsPoster } from './sonnetCredits.js';
import {
    resolveShotMotionFrame, resolveShotProgress, resolveSegmentProgress,
    resolveSonnetCameraBreath, resolveSonnetBreathWeight, easeSonnetInOut, clamp01,
    resolveTimelineShake, resolveSonnetSmoothedCameraFocus, resolveSonnetFocusWeights,
} from './sonnetMotion.js';
import { resolveSonnetSegmentCameraFocus } from './sonnetCameraTracking.js';
import { hashSonnetSeed } from './sonnetRandom.js';

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
        this.destroyed = false;
        this.scenes = new Map();          // paragraphIndex → scene bundle
        this.activeParagraphIndex = -1;
        this.glowEnabled = true;
        this.transitionsEnabled = true;   // shot 边界转场（fast-blur/mono-glitch/camera-pull）
        this.lyricsFontScale = 1;         // 上游 tuning.lyricsFontScale 等价项
        /* 上游 tuning 消费字段默认档（sonnetPostProcess profile 计算）：
           后期滤镜全开、动效强度标准档。用户可调项后续接设置面板 */
        this.tuning = {
            typographyMotion: 1,
            postProcessEnabled: true,
            postProcessGrain: 0.5,
            postProcessContrast: 0.3,
            postProcessLensDistortion: 0.35,
            postProcessLensDispersion: 0.4,
            postProcessRgbShift: 0.3,
            postProcessHalftone: 0.35,
            postProcessVignette: 0.5,
        };
        this.canvas = null;
        this.cameraZoomScale = 1;   // 「默认焦距(镜头特写)」滑条
        this.cameraSpeed = 1;       // 运镜平滑速度
        this.settingsFlags = null;  // showHud/showParticles/showDecorations/aiColorSync
        this.bottomInset = 96;      // 底部播放器栏高度（布局安全区）
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
        this.sceneRoot = new Container();
        this.app.stage.addChild(this.sceneRoot);
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
        if (settings.fontFamily) this.fontFamily = settings.fontFamily;
        if (typeof settings.fontSize === 'number' && settings.fontSize > 0) {
            /* ★ 2026-10-02（用户实测「verse 焦点偏上/巨字溢顶」）：fontSize 1.5 原样
               灌进字号公式——自适应基数几乎每个 shot 顶到上限，hero ×4~5.5 后
               500~690px 巨字必然溢出画面（布局 fitScale 只保宽度 82%，高度无保护，
               上游亦然；上游 lyricsFontScale 是 tuning 调试项，用户场景恒为 1）。
               用户设置软施加：clamp [0.8,1.2]，调大能感觉到但不破坏溢出保护。 */
            this.lyricsFontScale = Math.min(1.2, Math.max(0.8, settings.fontSize));
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
        if (!this.app || this.destroyed || this.paused || !this.program) return;
        try {
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

        /* ★ 片尾 credits（上游 createSonnetPixiRuntime 816-837 形态）：
           最后一段 + 歌曲有元数据 → 歌词淡出模糊、海报浮入 */
        if (scene.creditsContainer) {
            const isFinalScene = paragraphIndex === this.program.paragraphs.length - 1;
            const creditsFrame = isFinalScene
                ? resolveSonnetCreditsFrame(time, paragraph.endTime + 1.2)
                : { active: false, lyricAlpha: 1 };
            if (creditsFrame.active) {
                scene.container.alpha *= creditsFrame.lyricAlpha;
                scene.blurFilter.blur += creditsFrame.lyricBlur || 0;
                scene.creditsContainer.visible = true;
                scene.creditsContainer.alpha = creditsFrame.posterAlpha;
                scene.creditsContainer.y = scene.height * (creditsFrame.posterOffsetY || 0);
                scene.creditsContainer.scale.set(creditsFrame.posterScale || 1);
            } else {
                scene.creditsContainer.visible = false;
            }
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

        const fontFamily = this.fontFamily || FALLBACK_FONT;
        const sceneSeed = hashSonnetSeed(`${this.program.seed}:${paragraph.id}`);

        /* ★ 背景装饰（上游 sonnetSceneBuilder 1:1）：
           theme.backgroundColor 的 0.10 覆盖 + seed 撒点的装饰横线（secondary/accent 交替） */
        const bgTint = new Graphics();
        bgTint.rect(0, 0, width, height)
            .fill({ color: this._colorNumber(this.theme.backgroundColor || '#09090b'), alpha: 0.10 });
        sceneBackgroundLayer.addChild(bgTint);
        const density = Math.round(4 + 0.5 * 5);
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

        /* 侧边竖排元数据（上游 THEME name 竖排，outerFrameMode full 的子集） */
        if (this.theme.name) {
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

        /* ★ 片尾 credits 海报（上游 credits 流程）：歌词全部结束且歌曲有元数据时显示 */
        let creditsContainer = null;
        try {
            const meta = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || {};
            if (hasSonnetCreditsMetadata({ title: meta.song || meta.title, artist: meta.singer || meta.artist, album: meta.album })) {
                creditsContainer = buildSonnetCreditsPoster(
                    { Container, Text, TextStyle, Graphics, Color },
                    this.theme,
                    { title: meta.song || meta.title, artist: meta.singer || meta.artist, album: meta.album },
                    width, height, this.lyricsFontScale || 1,
                );
                creditsContainer.visible = false;
                creditsContainer.zIndex = 50;
                container.addChild(creditsContainer);
            }
        } catch (e) {
            this._lastError = String(e && e.stack ? e.stack : e).slice(0, 300);
        }
        this._lastError = null;

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
        scene.creditsContainer = creditsContainer;
        scene.transitionGlitchEffect = transitionGlitchEffect;

        paragraph.shots.forEach((shot, shotIndex) => {
            const lineGroups = shot.lineIndices.map(sourceIndex => paragraph.lines[sourceIndex].segments);
            const flatSegments = lineGroups.flat();
            /* ★ 字号公式（上游 sonnetSceneBuilder 1:1）：按 shot 词数自适应 + heroScale。
               ★ 2026-10-02 上限 126→112 对齐上游（用户 fontSize=1.5 时基数顶格 126，
               hero 巨字溢顶；112 也缓解「support 词太小」的原始诉求——那是缩放被
               clamp 后的连带观感，见 applySettings 的软施加）。 */
            const wordCount = Math.max(1, flatSegments.filter(s => s.isWordLike !== false && s.text.trim()).length);
            const heroScale = shot.kind === 'type-impact' ? 1.55 : shot.kind === 'quiet-tableau' ? 0.82 : 1;
            const shotFontSize = Math.max(30, Math.min(112,
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
            const fitContentToSafeArea = (boxes, safeW, safeH) => {
                const content = boxes.filter(b => b.role !== 'decoration');
                if (content.length === 0) return;
                let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
                content.forEach(b => {
                    minX = Math.min(minX, b.x - b.measuredWidth / 2);
                    maxX = Math.max(maxX, b.x + b.measuredWidth / 2);
                    minY = Math.min(minY, b.y - b.measuredHeight / 2);
                    maxY = Math.max(maxY, b.y + b.measuredHeight / 2);
                });
                const boxW = Math.max(1, maxX - minX);
                const boxH = Math.max(1, maxY - minY);
                /* ★ 2026-10-02 「设置项调了没用」修复：此前一律 fit 到安全区——用户调大
                   字号/焦距后内容变大，fit 又把它缩回去，等于白调。改为只在**严重超界**
                   （>1.25 倍安全区）时才缩放，且保底 0.7（不缩成看不见）；轻微超界只做
                   居中平移（平移永远执行，零副作用）。 */
                const rawScale = Math.min(1, safeW / boxW, safeH / boxH);
                const scale = rawScale < 0.8 ? Math.max(rawScale, 0.7) : 1;
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;
                boxes.forEach(b => {
                    b.x = (b.x - centerX) * scale;
                    b.y = (b.y - centerY) * scale;
                    /* 拟合缩放同步作用于测量框/字号/入场向量：字形按 placement.fontScale
                       生成（大小 = baseFontSize × fontScale × measured），只缩框不缩字号
                       会出现「框缩了字没缩」的溢出。 */
                    b.measuredWidth *= scale;
                    b.measuredHeight *= scale;
                    b.fontScale *= scale;
                    b.enterX *= scale;
                    b.enterY *= scale;
                });
            };
            /* ★ 2026-10-02 安全区按本镜头 zoom 反向补偿（用户截图实锤「巨字顶部被裁」）：
               fit 后内容占 0.88w×0.84h，但相机 zoom 1.02~1.48 × motion.scale ±9% ——
               0.84h × 1.48 ≈ 1.24h，必然顶底溢出。安全区除以 (zoom×1.1) 后，
               内容 × zoom 恰好回到 0.88w/0.84h 内；短句镜头 zoom 低则字更大。 */
            /* ★ 2026-10-02 zoom 补偿上限 1.2（用户实测「歌词有时候很小」）：此前
               安全区 ÷ (zoom×1.1)，zoom 1.48 时安全区只剩 54%，字被缩得很小。
               现在最多 ÷1.2——允许高 zoom 镜头轻微裁切（folia 电影感），保字号。 */
            const zoomComp = Math.min(1.2, Math.max(1, (shot.camera.zoom || 1) * (this.cameraZoomScale || 1) * 1.1));
            fitContentToSafeArea(placements, width * 0.88 / zoomComp, height * 0.84 / zoomComp);
            const shotView = {
                shot, container: shotContainer, segments: [], mg,
                textLayer, guideLayer,
                baseFontSize: shotFontSize,
                placementsLen: placements.length, flatLen: flatSegments.length,
            };
            placements.forEach((placement, segmentIndex) => {
                const segment = flatSegments[placement.segmentIndex];
                if (!segment) return;
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
                    showFixedGeo: true,
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
            const focusX = shot.kind === 'poster-blocks'
                ? 0
                : heroPlacement ? heroPlacement.x : 0;
            const focusY = shot.kind === 'poster-blocks'
                ? 0
                : heroPlacement ? heroPlacement.y : 0;
            shotContainer.pivot.set(focusX, focusY);
            shotContainer.position.set(
                width * (shot.kind === 'poster-blocks' ? 0.5 : 0.5 + shot.camera.x),
                shot.kind === 'poster-blocks'
                    ? height / 2
                    : rawHeight / 2 + shot.camera.y * height * 0.2,
            );
            shotView.baseX = shotContainer.x;
            shotView.baseY = shotContainer.y;
            shotView.basePivotX = focusX;
            shotView.basePivotY = focusY;

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

        /* ★ 上游相机模型（createSonnetPixiRuntime.ts 451-560 形态）：
           per-shot 容器 + pivot 跟随「当前唱到的词」焦点（平滑加权） +
           镜头路径 motion + 呼吸 + shake + 转场帧。
           ★ 2026-10-02 照抄上游 gapTime 尾段漂移（createSonnetPixiRuntime.ts 458-472）：
           行唱完后（gapTime>0）镜头沿尾段（progress 0.8→1.0）的运动方向继续慢速
           漂移——speed = (1-e^(-gap×0.4)) × 2.0，饱和式渐慢。这才是上游「行尾
           不冻结」的实现；此前自创的运镜窗延伸已删。 */
        const shotProgress = resolveShotProgress(shot, time);
        const motion = resolveShotMotionFrame(shot.kind, shotProgress);
        const gapTime = Math.max(0, time - shot.endTime);
        if (gapTime > 0) {
            const tailStart = resolveShotMotionFrame(shot.kind, 0.8);
            const driftSpeed = (1 - Math.exp(-gapTime * 0.4)) * 2.0;
            motion.x += (motion.x - tailStart.x) * driftSpeed;
            motion.y += (motion.y - tailStart.y) * driftSpeed;
            motion.scale += (motion.scale - tailStart.scale) * driftSpeed;
            motion.rotation += (motion.rotation - tailStart.rotation) * driftSpeed;
        }

        let trackSegments = shotView.segments.filter(s => s.role !== 'decoration' && s.trackingGlyphs && s.trackingGlyphs.length > 0);
        if (trackSegments.length === 0) {
            trackSegments = shotView.segments.filter(s => s.trackingGlyphs && s.trackingGlyphs.length > 0);
        }

        const shake = resolveTimelineShake(time, 0);
        const camera = 1; // 上游 tuning mod('camera') 强度，默认 1
        const zoomScale = this.cameraZoomScale || 1; // 「默认焦距(镜头特写)」滑条

        /* ★ 2026-10-02 相机管线抽成闭包（用户实测「切镜突然把上一句内容移动，
           且上一句动画基本没有」）：上一版给旧镜单独写 transform，pivot 被重置成
           basePivot（丢焦点追踪）→ 交接帧跳变。现在激活镜与旧镜走**同一条管线**，
           唯一差异是 motion 帧：激活镜用延伸窗进度（交接瞬间恰 =1.0），旧镜用
           clamp 进度（=1.0）——两者在交接帧数值完全相等，零跳变；此后旧镜的
           呼吸/震颤/焦点（冻结在末词）/MG 全部按自己的时间函数继续，即 folia 的
           「旧构图活着退场」。 */
        const applyShotCamera = (view, shotData, motionFrame) => {
            let segs = view.segments.filter(s => s.role !== 'decoration' && s.trackingGlyphs && s.trackingGlyphs.length > 0);
            if (segs.length === 0) {
                segs = view.segments.filter(s => s.trackingGlyphs && s.trackingGlyphs.length > 0);
            }
            const revealDone = segs.length > 0
                ? Math.max(...segs.map(segment => segment.trackingGlyphs.at(-1)?.startTime ?? shotData.endTime))
                : shotData.endTime;
            const breathW = resolveSonnetBreathWeight(time, revealDone);
            const breathPhase = (hashSonnetSeed(shotData.id) % 1024) / 1024 * Math.PI * 2;
            const breath = resolveSonnetCameraBreath(time, breathPhase);

            let focusX = view.basePivotX;
            let focusY = view.basePivotY;
            if (segs.length > 0) {
                const focusRanges = segs.map(segment => ({
                    startTime: segment.trackingGlyphs[0]?.startTime ?? shotData.startTime,
                    endTime: segment.trackingGlyphs.at(-1)?.startTime ?? shotData.endTime,
                }));
                const resolveFocusAtTime = (focusTime) => {
                    let fx = 0;
                    let fy = 0;
                    const focusWeights = resolveSonnetFocusWeights(focusRanges, focusTime);
                    for (let i = 0; i < segs.length; i++) {
                        const seg = segs[i];
                        if (seg.trackingGlyphs.length === 0) continue;
                        const weight = focusWeights[i] ?? 0;
                        const pos = resolveSonnetSegmentCameraFocus(seg.trackingGlyphs, focusTime);
                        fx += pos.x * weight;
                        fy += pos.y * weight;
                    }
                    return { x: fx, y: fy };
                };
                const focusTime = Math.max(shotData.startTime, Math.min(time, shotData.endTime));
                const smoothWindow = 0.12 / (this.cameraSpeed || 1);
                const smoothed = resolveSonnetSmoothedCameraFocus(
                    focusTime, shotData.startTime, shotData.endTime, resolveFocusAtTime, smoothWindow,
                );
                focusX = smoothed.x;
                focusY = smoothed.y;
            }

            /* ★ 2026-10-02 恢复 folia 原生运镜（用户「运镜不像 folia」）：场景尺寸根因
               已修，收敛不再必要——追踪回满幅（镜头跟词）、motion 回满幅。 */
            view.container.pivot.set(
                view.basePivotX + (focusX - view.basePivotX) * camera,
                view.basePivotY + (focusY - view.basePivotY) * camera,
            );
            view.container.scale.set(
                shotData.camera.zoom * zoomScale * (1 + ((motionFrame.scale + breath.scale * breathW) - 1) * camera),
            );
            view.container.rotation = (
                shotData.camera.rotation + motionFrame.rotation + breath.rotation * breathW + shake.rotation
            ) * camera;
            /* ★ 2026-10-02 运镜满幅（恢复 folia） */
            view.container.x = view.baseX + ((motionFrame.x + breath.x * breathW) * width + shake.x * width) * camera;
            view.container.y = view.baseY + ((motionFrame.y + breath.y * breathW) * height + shake.y * height) * camera;
        };

        applyShotCamera(shotView, shot, motion);

        /* ★ 2026-10-02 闭环自校正已撤除（用户「运镜不像 folia」）：它是「偏左上」
           根因未定位时的权宜（每帧把内容拉回中心），而真根因是场景尺寸脱钩
           （已由 container 尺寸源修复）。留着会把 folia 的镜头游走死死拉回中心，
           运镜变得死板。居中基线改由 fitContentToSafeArea（平移）+ pivot 锚 hero 保证。

        /* MG 全量驱动：updateTime 传播到 bg/geo/fixed/particle 全部件。
           ★ 2026-09-30 修「背景图形不会自己做动画」：Full 版 updateTime 签名是
           (绝对time, cues, shotStart, shotEnd, bass, power, vocal)——内部自算
           (time-start)/drawDuration；此前喂 shot 相对时间 → rawProgress 恒 0，
           背景贝塞尔曲线/几何生长从不动。 */
        if (shotView.mg && typeof shotView.mg.updateTime === 'function') {
            const audio = (typeof globalThis !== 'undefined' && globalThis.__sonnetAudioLevels) || null;
            shotView.mg.updateTime(
                time, shot.cues, shot.startTime, shot.endTime,
                audio ? audio.bass || 0 : 0,
                audio ? audio.power || 0 : 0,
                audio ? audio.vocal || 0 : 0,
            );
        }

        /* 转场帧（上游 810-830 一比一）：alpha/位移/缩放/旋转/blur/glitch 全部来自
           转场帧——shot 边界窗口或段落 transitionOut 窗口。这是上游唯一的切镜软化，
           没有第二层压暗。 */
        scene.container.alpha = tf.alpha;
        scene.container.pivot.set(width / 2, height / 2);
        scene.container.position.set(width / 2 + tf.x * width, height / 2 + tf.y * height);
        scene.container.scale.set(tf.scale);
        scene.container.rotation = tf.rotation;
        scene.blurFilter.blur = tf.blur;
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

        // 激活 shot 的逐字动画（上游 620-660 公式：waiting→0、depth 视差、emphasis 起步更小）
        // ★ 抽成闭包：交叉淡化窗口内的旧镜头复用同一公式继续播完动画再淡出
        const updateGlyphs = (targetView) => {
        targetView.segments.forEach(segmentView => {
            const isEmphasisTypeImpact = (segmentView.role === 'hero' || segmentView.role === 'semi-hero')
                && shot.kind === 'type-impact';
            segmentView.glyphs.forEach(glyph => {
                const waiting = time < glyph.startTime;
                const p = resolveSegmentProgress(glyph.startTime, glyph.settleTime, time);
                const enterEase = easeSonnetInOut(clamp01((time - glyph.startTime) / Math.max(0.001, glyph.settleTime - glyph.startTime)));
                /* ★ 入场基础 0.16→0.45：0.16 在交叉淡化叠加下不可读（真空观感） */
                const coreAlpha = waiting ? 0 : 0.45 + p * 0.55;
                const scale = isEmphasisTypeImpact
                    ? 0.52 + p * 0.48
                    : 0.86 + p * 0.14;
                const offset = (1 - enterEase) * 1;
                const x = glyph.baseX + glyph.enterX * offset;
                const y = glyph.baseY + glyph.enterY * offset;
                const rotation = glyph.finalRotation + glyph.entryRotation * offset;

                // Simulated Parallax 3D：zDepth 越大随相机移动越快、离镜头越近越大
                const depth = glyph.zDepth || 0;
                const parallaxScale = 1;
                const parallaxX = (motion.x * width + shake.x * width) * camera * depth * 2.5 * parallaxScale;
                const parallaxY = (motion.y * height + shake.y * height) * camera * depth * 2.5 * parallaxScale;
                const depthScale = 1 + depth * 0.45 * parallaxScale;

                glyph.display.alpha = coreAlpha;
                glyph.display.visible = coreAlpha > 0.01;
                glyph.display.scale.set(scale * depthScale);
                glyph.display.position.set(x + parallaxX, y + parallaxY);
                glyph.display.rotation = rotation;

                // CA 色散：入场期散开 → 就位时收拢
                if (glyph.caWrapper) {
                    glyph.caWrapper.visible = coreAlpha > 0.01;
                    if (glyph.caWrapper.visible) {
                        glyph.caWrapper.position.set(x + parallaxX, y + parallaxY);
                        glyph.caWrapper.rotation = rotation;
                        glyph.caWrapper.scale.set(scale * depthScale);
                        const spread = 1 - enterEase * 0.8;
                        glyph.caCyan.position.set(-glyph.caOffset * spread, 0);
                        glyph.caRed.position.set(glyph.caOffset * spread, 0);
                        glyph.caWrapper.alpha = coreAlpha;
                    }
                }

                // semi-hero 残影：入场前 20% 线性出现，之后平方衰减
                if (glyph.ghosts) {
                    const ghostAge = time - glyph.startTime;
                    const span = Math.max(0.08, glyph.settleTime - glyph.startTime);
                    const ghostT = clamp01(ghostAge / (glyph.ghostDuration || 0.5));
                    glyph.ghosts.forEach(ghost => {
                        const appear = Math.min(1, ghostAge / Math.max(0.05, span * 0.2));
                        const decay = ghostT < 0.2 ? appear : Math.max(0, 1 - (ghostT - 0.2) / 0.8) ** 2;
                        ghost.node.visible = decay > 0.01 && !waiting;
                        ghost.node.alpha = ghost.alphaBase * decay;
                        ghost.node.position.set(ghost.dirX * ghostT, ghost.dirY * ghostT);
                    });
                }
            });
        });
        };
        updateGlyphs(shotView);
        /* 上游只更新激活 shot（旧镜在切镜时已 unload）。 */
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

    _destroyScene(scene) {
        scene.container.destroy({ children: true });
    }
}
