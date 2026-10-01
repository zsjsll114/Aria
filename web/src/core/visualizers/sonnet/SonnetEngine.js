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
    resolveSonnetTransitionEffectFrame, IDLE_SONNET_TRANSITION_FRAME,
} from './sonnetTransitions.js';
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
        const rw = this.app.renderer.width / this.app.renderer.resolution;
        const rh = this.app.renderer.height / this.app.renderer.resolution;
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

        // 场景懒建：激活段落 ±1 预建；其余剪除
        this._ensureScene(paragraphIndex);
        if (paragraphIndex + 1 < this.program.paragraphs.length) this._ensureScene(paragraphIndex + 1);

        /* ★ 2026-09-30 段落切换交叉淡化（用户实测「有一段东西突然消失的真空时间」）：
           硬切 + 新段 0.3s 淡入 = 旧词瞬间消失后画面近乎全空。保留上一段落场景 0.35s
           同步淡出，与新段淡入交叠。 */
        if (this.activeParagraphIndex !== paragraphIndex) {
            const outgoing = this.activeParagraphIndex >= 0 ? this.scenes.get(this.activeParagraphIndex) : null;
            if (outgoing) {
                this._fadeScene = outgoing;
                this._fadeStart = time;
                /* ★ 2026-10-02 闪黑根修（用户实测「歌词行闪黑而不是渐隐」）：段尾
                   textFade 已把文本层压到 0.45，fadeScene 的容器 alpha 再 ramp
                   1→0.45——两层相乘 ≈0.2，观感即「突然黑掉」。接管时把 outgoing
                   的文本层复位 1，明暗全部交给容器 alpha 单层承担。 */
                outgoing.shots.forEach(sv => {
                    if (sv.textLayer) sv.textLayer.alpha = 1;
                    if (sv.guideLayer) sv.guideLayer.alpha = 1;
                });
                /* ★ 2026-10-01 真空根治（用户视频实测「最后一个词没唱完就闪黑，黑 1.5s+」）：
                   新段 startTime=line.start，但首个字形按 WORD 时间入场——首词可能比行头晚
                   1s+（yrc 行头早于人声 / LRC 时间戳偏移）。旧逻辑固定 0.35s 淡出 = 新段
                   首字入场前全黑。改为：旧场景先压暗到 0.45 **保持**，直到新段首个字形
                   真正入场才开始退场（上限 3.5s 防超长间奏悬挂）。 */
                const incomingFirst = this._getParagraphFirstGlyphTime(paragraph, paragraphIndex);
                this._fadeHoldUntil = Math.min(time + 2, Math.max(time + 0.35, incomingFirst));
            }
            // 离开旧段落：剪除远端缓存（正在淡出的场景保住不剪）
            this.scenes.forEach((scene, index) => {
                if (Math.abs(index - paragraphIndex) > 1 && scene !== this._fadeScene) {
                    this._destroyScene(scene);
                    this.scenes.delete(index);
                }
            });
            this.activeParagraphIndex = paragraphIndex;
        }
        let fadeScene = this._fadeScene;
        if (fadeScene && (!this.scenes.has(fadeScene.index) || time - this._fadeStart >= 0.35 && time > (this._fadeHoldUntil || 0))) {
            fadeScene = this._fadeScene = null;
        }
        if (fadeScene) {
            /* 两段式退场：0.35s 内 1→0.45 压暗保持；holdUntil 后 0.45→0 退场 */
            const holdAlpha = 0.45;
            const holdUntil = this._fadeHoldUntil || (this._fadeStart + 0.35);
            const rampP = clamp01((time - this._fadeStart) / 0.35);
            fadeScene.container.alpha = time <= holdUntil
                ? 1 - rampP * (1 - holdAlpha)
                : holdAlpha * (1 - clamp01((time - holdUntil) / 0.35));
        }
        this.scenes.forEach((scene, index) => {
            const visible = index === paragraphIndex || scene === fadeScene;
            scene.container.visible = visible;
        });

        // 激活 shot（findIndex 供转场 API 使用）
        let shotIndex = paragraph.shots.findIndex(s => time >= s.startTime && time < s.endTime);
        if (shotIndex < 0) {
            /* ★ 2026-09-30 修「真空/跳镜」：shot 间隙（prev.endTime ≤ t < next.startTime）
               落到这里时旧代码 fallback 到 shot 0——画面跳回第一个镜头的文本（用户实测
               「东西突然消失」的观感来源之一）。改为取时间线上最后一个已开始的 shot。 */
            for (let i = paragraph.shots.length - 1; i >= 0; i--) {
                if (time >= paragraph.shots[i].startTime) { shotIndex = i; break; }
            }
            if (shotIndex < 0) shotIndex = 0;
        }
        const shot = paragraph.shots[shotIndex];
        if (!shot) return;
        const scene = this.scenes.get(paragraphIndex);
        if (!scene) return;

        // shot 边界转场（上游 resolveSonnetShotTransitionFrame 等价）
        const sceneSeed = hashSonnetSeed(`${this.program.seed}:${paragraph.id}`);
        let transition = this.transitionsEnabled
            ? resolveSonnetShotTransitionFrame(paragraph.shots, shotIndex, time, true, sceneSeed)
            : IDLE_SONNET_TRANSITION_FRAME;

        /* ★ 2026-09-30 段落级转场 + 段尾文本退场（真空修复核心）：
           - 段尾唱完后：文本层（text/guide）在 exitDur 内淡出并**保持 0**——MG/背景
             续存，不再「突然消失」也不弹回；exitDur 与段间 gap 挂钩。
           - 新段开头：上一段 transitionKind 的 enter 只出 blur/glitch（alpha 明暗全部
             由段落交叉淡化 + shot 进入淡入承担——此前 enter alpha 叠加 shot 淡入造成
             双重压暗，切换点画面近乎全空）。 */
        scene.textFade = 1;
        if (transition === IDLE_SONNET_TRANSITION_FRAME && this.transitionsEnabled) {
            const paraAge = time - paragraph.startTime;
            if (paragraphIndex > 0 && paraAge >= 0 && paraAge <= 0.45) {
                const prevPara = this.program.paragraphs[paragraphIndex - 1];
                if (prevPara && prevPara.transitionKind) {
                    transition = resolveSonnetEnterTransitionFrame(
                        prevPara.transitionKind, paraAge, 0.45, true, sceneSeed + 31);
                }
            }
        }
        if (time > paragraph.endTime) {
            const nextPara = this.program.paragraphs[paragraphIndex + 1];
            const gap = nextPara ? Math.max(0.2, nextPara.startTime - paragraph.endTime) : 1.2;
            const exitDur = Math.min(1.2, Math.max(0.35, gap * 0.5));
            /* ★ 真空修复（用户实测「两句间隔过大时会有真空」）：文本只收到 0.45 并
               保持——唱完的句子留在画面上变暗（歌词软件惯例），MG/背景续存。
               此前收到 0 = 间隔越长空屏越久。 */
            scene.textFade = 0.45 + 0.55 * clamp01(1 - (time - paragraph.endTime) / exitDur);
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
        /* 布局未就绪（容器 0 尺寸）不建场景——坐标按 0 烘焙会固化（见 _tickInner 守卫） */
        const width = this.app.renderer.width / this.app.renderer.resolution;
        const rawHeight = this.app.renderer.height / this.app.renderer.resolution;
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
               2026-09-29 下限 24→30、上限 112→126（用户实测 support 词太小） */
            const wordCount = Math.max(1, flatSegments.filter(s => s.isWordLike !== false && s.text.trim()).length);
            const heroScale = shot.kind === 'type-impact' ? 1.55 : shot.kind === 'quiet-tableau' ? 0.82 : 1;
            const shotFontSize = Math.max(30, Math.min(126,
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

            /* ★ 上游摆位（sceneBuilder 295-307）：pivot=hero 焦点、position=相机偏移 */
            const heroPlacement = placements.find(p => p.role === 'hero');
            const focusX = shot.kind === 'poster-blocks'
                ? 0
                : heroPlacement ? heroPlacement.x : width / 2;
            const focusY = shot.kind === 'poster-blocks'
                ? 0
                : heroPlacement ? heroPlacement.y : height / 2;
            shotContainer.pivot.set(focusX, focusY);
            shotContainer.position.set(
                width * (shot.kind === 'poster-blocks' ? 0.5 : 0.5 + shot.camera.x),
                height * (shot.kind === 'poster-blocks'
                    ? 0.5
                    : 0.48 + shot.camera.y + (shotIndex % 2 ? 0.025 : -0.025)),
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
           镜头路径 motion + 呼吸 + shake + 转场帧
           ★ 2026-10-02 行尾停滞根修（用户实测「最后一个字播完整句动画冻结，
           根本不像 folia」）：shotProgress 用 shot.endTime 归一——最后一句词唱完
           progress=1，运镜/焦点流全部冻结到下一镜接管。运镜窗延伸到下一镜
           startTime（或 +1.2s 兜底），镜头流动覆盖整段悬挂期。 */
        const nextShotForFlow = paragraph.shots[shotIndex + 1];
        const motionEnd = nextShotForFlow
            ? Math.max(shot.endTime, nextShotForFlow.startTime)
            : shot.endTime + 1.2;
        const shotProgress = resolveShotProgress({ ...shot, endTime: motionEnd }, time);
        const motion = resolveShotMotionFrame(shot.kind, shotProgress);

        let trackSegments = shotView.segments.filter(s => s.role !== 'decoration' && s.trackingGlyphs && s.trackingGlyphs.length > 0);
        if (trackSegments.length === 0) {
            trackSegments = shotView.segments.filter(s => s.trackingGlyphs && s.trackingGlyphs.length > 0);
        }
        const revealDoneTime = trackSegments.length > 0
            ? Math.max(...trackSegments.map(segment => segment.trackingGlyphs.at(-1)?.startTime ?? shot.endTime))
            : shot.endTime;
        const breathWeight = resolveSonnetBreathWeight(time, revealDoneTime);
        const breathPhase = (hashSonnetSeed(shot.id) % 1024) / 1024 * Math.PI * 2;
        const breath = resolveSonnetCameraBreath(time, breathPhase);

        let focusX = shotView.basePivotX;
        let focusY = shotView.basePivotY;
        if (trackSegments.length > 0) {
            const focusRanges = trackSegments.map(segment => ({
                startTime: segment.trackingGlyphs[0]?.startTime ?? shot.startTime,
                endTime: segment.trackingGlyphs.at(-1)?.startTime ?? shot.endTime,
            }));
            const resolveFocusAtTime = (focusTime) => {
                let fx = 0;
                let fy = 0;
                const focusWeights = resolveSonnetFocusWeights(focusRanges, focusTime);
                for (let i = 0; i < trackSegments.length; i++) {
                    const seg = trackSegments[i];
                    if (seg.trackingGlyphs.length === 0) continue;
                    const weight = focusWeights[i] ?? 0;
                    const pos = resolveSonnetSegmentCameraFocus(seg.trackingGlyphs, focusTime);
                    fx += pos.x * weight;
                    fy += pos.y * weight;
                }
                return { x: fx, y: fy };
            };
            const focusTime = Math.max(shot.startTime, Math.min(time, shot.endTime));
            const smoothWindow = 0.12 / (this.cameraSpeed || 1);
            const smoothed = resolveSonnetSmoothedCameraFocus(
                focusTime, shot.startTime, shot.endTime, resolveFocusAtTime, smoothWindow,
            );
            focusX = smoothed.x;
            focusY = smoothed.y;
        }

        const shake = resolveTimelineShake(time, 0);
        const camera = 1; // 上游 tuning mod('camera') 强度，默认 1
        const zoomScale = this.cameraZoomScale || 1; // 「默认焦距(镜头特写)」滑条

        shotView.container.pivot.set(
            shotView.basePivotX + (focusX - shotView.basePivotX) * camera,
            shotView.basePivotY + (focusY - shotView.basePivotY) * camera,
        );
        shotView.container.scale.set(
            shot.camera.zoom * zoomScale * (1 + ((motion.scale + breath.scale * breathWeight) - 1) * camera),
        );
        shotView.container.rotation = (
            shot.camera.rotation + motion.rotation + breath.rotation * breathWeight + shake.rotation
        ) * camera;
        shotView.container.x = shotView.baseX + ((motion.x + breath.x * breathWeight) * width + shake.x * width) * camera;
        shotView.container.y = shotView.baseY + ((motion.y + breath.y * breathWeight) * height + shake.y * height) * camera;

        /* MG 全量驱动：updateTime 传播到 bg/geo/fixed/particle 全部件。
           ★ 2026-09-30 修「背景图形不会自己做动画」：Full 版 updateTime 签名是
           (绝对time, cues, shotStart, shotEnd, bass, power, vocal)——内部自算
           (time-start)/drawDuration；此前喂 shot 相对时间 → rawProgress 恒 0，
           背景贝塞尔曲线/几何生长从不动。 */
        if (shotView.mg && typeof shotView.mg.updateTime === 'function') {
            const audio = (typeof globalThis !== 'undefined' && globalThis.__sonnetAudioLevels) || null;
            shotView.mg.updateTime(
                time, shot.cues, shot.startTime, motionEnd,
                audio ? audio.bass || 0 : 0,
                audio ? audio.power || 0 : 0,
                audio ? audio.vocal || 0 : 0,
            );
        }

        /* 转场帧：blur/glitch 作用于段落容器。★ alpha 不再压场景（2026-09-30 真空修复）：
           此前 exit 1→0 + enter 0.18→1 串行，每次切镜 0.6-1s 的低亮度真空。
           现在段内明暗全部由 per-shot 容器交叉淡化承担，场景恒 1（credits 仍可乘）。 */
        scene.container.alpha = 1;
        scene.container.position.set(width / 2, height / 2);
        scene.container.scale.set(tf.scale);
        scene.container.pivot.set(0, 0);
        scene.blurFilter.blur = tf.blur;
        if (scene.transitionGlitchEffect && scene.transitionGlitchEffect.filter) {
            scene.transitionGlitchEffect.update(tf.glitch, tf.glitchSeed);
            scene.transitionGlitchEffect.filter.enabled = tf.glitch > 0.01;
        }

        // 逐 shot 显隐 + 设置开关（HUD/粒子/装饰，PV 设置区直连）
        // ★ 2026-09-30 交叉淡化（用户实测「前个词都没展示完就隐藏了」+ 真空感）：
        //   硬切瞬间旧词消失、新镜 0.3s 从 0 淡入 → 切换点前后画面近乎全空。
        //   进入窗口内保留上一 shot 容器同步淡出，与新镜淡入交叠成真正的 cross-fade。
        const flags = this.settingsFlags || {};
        let prevShotView = null;
        let prevShot = null;
        let crossFadeP = 1;
        {
            const enterAge = time - shot.startTime;
            if (shotIndex > 0 && enterAge >= 0) {
                const prevShotCand = paragraph.shots[shotIndex - 1];
                const cand = scene.shots.get(prevShotCand.id);
                if (cand && cand !== shotView) {
                    prevShot = prevShotCand;
                    /* ★ 动态淡出窗口（2026-09-30 夜，用户实测「尾词显示不全就突然
                       停止动画一阵内隐藏」）：窗口覆盖到上一镜头最后一个字形定格
                       为止（0.3–1.0s），窗口内旧镜字形继续播完动画（下方
                       updateGlyphs 复用）——即上游「继续播放 + 渐隐切镜」的观感。 */
                    let settleEnd = prevShot.endTime;
                    cand.segments.forEach(sv => sv.glyphs.forEach(g => {
                        if (g.settleTime > settleEnd) settleEnd = g.settleTime;
                    }));
                    /* ★ 2026-10-01 真空根治（同段落级）：新镜 startTime=line.start 但
                       首个字形按词时间入场，可能晚 1s+——旧镜 1.0s 窗口淡到 0 后全黑。
                       改三段式：1→0.45 压暗 → 保持到新镜首字形入场（上限 +4s）→
                       0.45→0 退场。
                       ★ 2026-10-02 调优（用户实测「切句后上一句词语不消失，叠在新句上」）：
                       holdEnd 不再取 max(settleEnd, incomingFirst)——settleEnd 是旧镜
                       自身入场动画的定格点，会把重叠拖进新句演唱期；旧镜动画在渐隐期
                       由 updateGlyphs(prev) 继续播，无须为此延长 hold。退场一律锚
                       incomingFirst（真空防护由场景字形真实时间保证）。 */
                    const incomingFirst = this._getShotFirstGlyphTime(paragraph, shot, scene);
                    const holdEnd = Math.min(shot.startTime + 3, incomingFirst);
                    const holdAlpha = 0.45;
                    const enterDur = Math.min(1.0, Math.max(0.3, settleEnd - shot.startTime));
                    const fadeTail = 0.35;
                    if (enterAge <= enterDur) {
                        prevShotView = cand;
                        crossFadeP = clamp01(enterAge / enterDur) * (1 - holdAlpha);
                    } else if (time <= holdEnd) {
                        prevShotView = cand;
                        crossFadeP = 1 - holdAlpha;
                    } else if (time <= holdEnd + fadeTail) {
                        prevShotView = cand;
                        crossFadeP = 1 - holdAlpha * (1 - (time - holdEnd) / fadeTail);
                    }
                }
            }
        }
        scene.shots.forEach((sv, shotId) => {
            const isActive = shotId === shot.id;
            const isPrev = sv === prevShotView;
            sv.container.visible = isActive || isPrev;
            if (isActive) {
                /* ★ 2026-09-30 夜：容器进入淡入退役——它与字形入场基础 alpha 叠加
                   （0.35 × 0.16 ≈ 0.06），切句瞬间正文几乎不可见（用户实测仍有真空）。
                   过渡感由旧镜 0.3s 交叉淡化独自承担，新镜文字立即以入场亮度出现。 */
                sv.container.alpha = 1;
                /* ★ 段尾文本退场：text/guide 淡出并保持 0，MG/背景续存 */
                const textFade = scene.textFade === undefined ? 1 : scene.textFade;
                if (sv.textLayer) sv.textLayer.alpha = textFade;
                if (sv.guideLayer) sv.guideLayer.alpha = textFade;
                if (sv.mg) {
                    if (sv.mg.bgLayer) sv.mg.bgLayer.visible = flags.showHud !== false;
                    if (sv.mg.particleLayer) sv.mg.particleLayer.visible = flags.showParticles !== false;
                    if (sv.mg.geoLayer) sv.mg.geoLayer.visible = flags.showDecorations !== false;
                    if (sv.mg.fixedGeoLayer) sv.mg.fixedGeoLayer.visible = flags.showDecorations !== false;
                }
            } else if (isPrev) {
                sv.container.alpha = 1 - crossFadeP;
            }
        });

        /* ★ 2026-10-02 旧镜续动（用户实测「切句后上一句整句动画停滞，不像 folia」）：
           容器 transform（pivot/scale/rotation/position）此前只驱动激活镜——交叉淡化
           窗口内的旧镜整句冻结成贴图。给它自己的呼吸/震颤 + 自身 motion 帧，
           MG 也继续 updateTime，旧镜在淡出期保持 folia 的「继续活着」观感。 */
        if (prevShotView && prevShot) {
            const prevMotion = resolveShotMotionFrame(prevShot.kind, resolveShotProgress(prevShot, time));
            const prevBreathPhase = (hashSonnetSeed(prevShot.id) % 1024) / 1024 * Math.PI * 2;
            const prevBreath = resolveSonnetCameraBreath(time, prevBreathPhase);
            const prevBreathWeight = resolveSonnetBreathWeight(time, prevShot.endTime);
            prevShotView.container.pivot.set(prevShotView.basePivotX, prevShotView.basePivotY);
            prevShotView.container.scale.set(
                prevShot.camera.zoom * zoomScale * (1 + ((prevMotion.scale + prevBreath.scale * prevBreathWeight) - 1) * camera),
            );
            prevShotView.container.rotation = (
                prevShot.camera.rotation + prevMotion.rotation + prevBreath.rotation * prevBreathWeight + shake.rotation
            ) * camera;
            prevShotView.container.x = prevShotView.baseX + ((prevMotion.x + prevBreath.x * prevBreathWeight) * width + shake.x * width) * camera;
            prevShotView.container.y = prevShotView.baseY + ((prevMotion.y + prevBreath.y * prevBreathWeight) * height + shake.y * height) * camera;
            if (prevShotView.mg && typeof prevShotView.mg.updateTime === 'function') {
                const audio = (typeof globalThis !== 'undefined' && globalThis.__sonnetAudioLevels) || null;
                prevShotView.mg.updateTime(
                    time, prevShot.cues, prevShot.startTime, Math.max(prevShot.endTime, time + 0.5),
                    audio ? audio.bass || 0 : 0,
                    audio ? audio.power || 0 : 0,
                    audio ? audio.vocal || 0 : 0,
                );
            }
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
        /* ★ 交叉淡化窗口内的旧镜头：字形继续播完入场动画再淡出，而非冻结帧硬隐 */
        if (prevShotView) updateGlyphs(prevShotView);
        /* ★ 2026-10-01 夜（用户实测「一句播完后 2.5D 透视/移动/回弹全消失，只剩运镜」）：
           播完的 shot 此后不再跑 updateGlyphs——parallax/深度缩放是相机运动的函数，
           冻结即「上一句变成贴图」。段内所有可见 shot 每帧都更新（当前句逐字、
           已唱句只动视差项），成本为每帧多 1-2 个 shot 的 glyph 循环。 */
        scene.shots.forEach(sv => {
            if (sv.container.visible && sv !== shotView && sv !== prevShotView) updateGlyphs(sv);
        });
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
