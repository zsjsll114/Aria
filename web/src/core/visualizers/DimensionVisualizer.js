/**
 * DimensionVisualizer.js
 * 浮空模式 (Dimension / 统一 3D 空间纵深体系与真实摄像机透视运镜)
 * 深度重构：
 * 1. 单个字符染色（逐字符渲染，而非整词染色）；
 * 2. 染色时平滑渐变（0.18s 快速平滑进入主题色/情感色）；
 * 3. 唱过停留 0.15s 后快速渐变恢复纯白（0.45s 快速平滑变白）；
 * 4. 零发光（纯粹平整高级排版质感，去除文字发光）；
 * 5. 确保主题色 100% 正确注入，独立实体空格元素（.dim-space）；
 * 6. 摄像机实时平滑追踪唱到的单字符中心。
 */

import { VisualizerBase } from './VisualizerBase.js';
import { DimensionBackground } from './dimension/DimensionBackground.js';
import { DimensionShapes } from './dimension/DimensionShapes.js';
import { DimensionCamera } from './dimension/DimensionCamera.js';
import { DimensionAudio } from './dimension/DimensionAudio.js';
import { logCatch } from '../../services/log.js';

// 内置情感词与专属配色字典（兜底保障所有歌曲都有丰富情感着色）
const BUILTIN_EMOTIONS = [

];

const LINE_DEPTH_SPACING = 700; // 每行在 3D 纵深空间的固定距离

export class DimensionVisualizer extends VisualizerBase {
    constructor(container, options = {}) {
        super(container, options);
        this.modeId = 'dimension';
        this.themeColor = options.themeColor || '#ffcc33';
        this.bgEngine = null;
        this.shapesEngine = null;
        this.camera = null;
        this.audio = null;

        this.bgCanvas = null;
        this.shapesCanvas = null;
        this.shapesCtx = null;
        this.lyricStage = null;

        this.entities = [];
        this.currentLineIndex = 0;
        this.rafId = null;
        this.lastFrameTime = performance.now();
        this.audioTime = 0;

        // 摄像机追踪词/字符中心偏移量
        this.wordTrackingX = 0;
        this.wordTrackingY = 0;
        this.targetWordTrackingX = 0;
        this.targetWordTrackingY = 0;

        // 每行随机角度缓存
        this.lineAngles = [];
    }

    getModeId() {
        return 'dimension';
    }

    onInit() {
        const stage = this.viewContainer;
        if (!stage) return;
        stage.classList.add('vis-dimension-stage');

        /* ★ 渲染缩放默认值，setPerfConfig 会按性能档位调整（低性能降采样省 CPU） */
        this._renderScale = 1;

        const effectiveThemeColor = (this.aiData && (this.aiData.accent_color || this.aiData.primary_color)) || this.themeColor || '#ffcc33';
        stage.style.setProperty('--dim-highlight-color', effectiveThemeColor);

        // 1. 创建流体丝绸背景 Canvas
        this.bgCanvas = document.createElement('canvas');
        this.bgCanvas.className = 'dim-bg-canvas';
        stage.appendChild(this.bgCanvas);

        // 2. 创建 3D 几何体 Canvas
        this.shapesCanvas = document.createElement('canvas');
        this.shapesCanvas.className = 'dim-shapes-canvas';
        this.shapesCtx = this.shapesCanvas.getContext('2d');
        stage.appendChild(this.shapesCanvas);

        // 3. 创建 3D 歌词舞台 (CSS 3D Preserve)
        this.lyricStage = document.createElement('div');
        this.lyricStage.className = 'dim-lyric-stage';
        stage.appendChild(this.lyricStage);

        // 4. 实例化各子系统
        this.bgEngine = new DimensionBackground(this.bgCanvas);
        this.shapesEngine = new DimensionShapes();
        this.camera = new DimensionCamera();
        this.audio = new DimensionAudio();

        // 5. 底部悬浮翻译区域 (修复浮空模式无翻译)
        this.transEl = document.createElement('div');
        this.transEl.className = 'vis-dimension-trans';
        stage.appendChild(this.transEl);

        const rect = this.container ? this.container.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
        this.handleResize(rect.width, rect.height);

        // 监听宿主容器大小变化（窗口缩放、分屏、侧边栏折叠等）
        if (typeof ResizeObserver !== 'undefined' && this.container) {
            this.resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const cr = entry.contentRect;
                    if (cr && cr.width > 0 && cr.height > 0) {
                        this.handleResize(cr.width, cr.height);
                    }
                }
            });
            this.resizeObserver.observe(this.container);
        }

        // ★ 字体加载完成后重新测量字符中心（自定义字体异步替换会改变字宽/行高）
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                for (const e of this.entities) {
                    if (e.domEl && e.domEl._dimChars) e.domEl._needMeasure = true;
                }
            }).catch((e) => logCatch('DimensionVisualizer', e));
        }
    }

    start() {
        super.start();
        this.startLoop();
    }

    stop() {
        super.stop();
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    startLoop() {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        const loop = (now) => {
            const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
            this.lastFrameTime = now;

            this.renderFrame(dt);
            if (this.isRunning) {
                this.rafId = requestAnimationFrame(loop);
            }
        };
        this.rafId = requestAnimationFrame(loop);
    }

    onLyricsLoaded() {
        this.currentLineIndex = 0;
        this.wordTrackingX = 0;
        this.wordTrackingY = 0;
        this.targetWordTrackingX = 0;
        this.targetWordTrackingY = 0;
        this.initEntities();
        if (this.lyricStage) this.lyricStage.innerHTML = '';
        
        // ★ 优先使用用户配置的独立模式主题色，避免被 AI 主题默认的红色覆盖
        const effectiveThemeColor = this.themeColor || (this.aiData && (this.aiData.accent_color || this.aiData.primary_color)) || '#ffcc33';
        if (this.viewContainer) {
            this.viewContainer.style.setProperty('--dim-highlight-color', effectiveThemeColor);
        }
        if (this.bgEngine) {
            this.bgEngine.setTheme(effectiveThemeColor, this.aiData);
        }
        this.updateCameraTarget(0, true);
    }

    /**
     * 在统一 3D 空间中初始化所有歌词实体与专属 3D 几何体的世界坐标
     */
    initEntities() {
        this.entities = [];
        this.lineAngles = [];
        if (!this.lines || this.lines.length === 0) return;

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            const isEven = (i % 2 === 0);
            const sideSign = isEven ? 1 : -1;
            const worldZ = -i * LINE_DEPTH_SPACING;

            // 伪随机 3D 姿态角
            const hash1 = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
            const rand1 = hash1 - Math.floor(hash1);
            const hash2 = Math.sin(i * 39.346 + 11.135) * 23421.631;
            const rand2 = hash2 - Math.floor(hash2);
            const hash3 = Math.sin(i * 71.182 + 93.451) * 31234.123;
            const rand3 = hash3 - Math.floor(hash3);

            const yaw = sideSign * (12 + rand1 * 10);
            const pitch = (rand2 - 0.5) * 11;
            const roll = sideSign * (2.5 + rand3 * 4);

            this.lineAngles.push({ yaw, pitch, roll });

            // 根据性能模式动态自适应 3D 几何体数量与点云粒子密度 (极简: 0, 低性能: 1, 高性能: 4)
            const isMinimal = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-minimal');
            const isLow = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-low');

            let shapes = [];
            if (isMinimal) {
                // 极简模式：完全不创建 3D 点阵几何体，专注 3D 悬浮歌词与超高帧率
                shapes = [];
            } else if (isLow) {
                // 低性能模式：每行仅保留 1 个轻量低采样几何体，大幅降低顶点矩阵计算与重绘
                shapes = [
                    {
                        geom: isEven ? this.shapesEngine.createCylinderGeometry(35, 70, 6, 2) : this.shapesEngine.createCubeGeometry(42, 2),
                        worldPos: { x: sideSign * 340, y: isEven ? -20 : 25, z: worldZ + 20 },
                        fixedRot: [0.25, 0.35, 0.1],
                        scale: 0.85
                    }
                ];
            } else {
                // 高性能模式：伴随 4 个全量精致点阵几何体星群
                shapes = [
                    {
                        geom: isEven ? this.shapesEngine.createCylinderGeometry(45, 95) : this.shapesEngine.createCubeGeometry(58),
                        worldPos: { x: sideSign * 380, y: isEven ? -25 : 30, z: worldZ + 20 },
                        fixedRot: [0.28, 0.42, 0.12],
                        scale: 1.0
                    },
                    {
                        geom: isEven ? this.shapesEngine.createCubeGeometry(42) : this.shapesEngine.createCylinderGeometry(34, 70),
                        worldPos: { x: sideSign * 460, y: -115, z: worldZ - 50 },
                        fixedRot: [-0.22, 0.35, -0.15],
                        scale: 0.85
                    },
                    {
                        geom: isEven ? this.shapesEngine.createCylinderGeometry(35, 75) : this.shapesEngine.createCubeGeometry(40),
                        worldPos: { x: -sideSign * 360, y: 100, z: worldZ + 60 },
                        fixedRot: [0.35, -0.28, 0.2],
                        scale: 0.88
                    },
                    {
                        geom: isEven ? this.shapesEngine.createCubeGeometry(35) : this.shapesEngine.createCylinderGeometry(28, 55),
                        worldPos: { x: -sideSign * 280, y: -80, z: worldZ - 120 },
                        fixedRot: [-0.15, -0.4, 0.1],
                        scale: 0.75
                    }
                ];
            }

            this.entities.push({
                index: i,
                line,
                shapes,
                lineWorldPos: { x: 0, y: 0, z: worldZ },
                domEl: null,
                opacity: 0
            });
        }
        if (this.lines.length > 0) {
            this.updateTranslation(0);
        }
    }

    updateTranslation(lineIndex) {
        if (!this.transEl || !this.lines || this.lines.length === 0) return;
        const line = this.lines[lineIndex] || this.lines[0];
        if (!line) return;
        const tr = (line.translation && line.translation.trim() !== '//') ? line.translation.trim() : '';
        const ro = (line.romaji && line.romaji.trim() !== '//') ? line.romaji.trim() : '';
        if (tr || ro) {
            this.transEl.innerHTML = `
                ${tr ? `<div class="vis-dimension-trans-text">${tr}</div>` : ''}
                ${ro ? `<div class="vis-dimension-roma-text">${ro}</div>` : ''}
            `;
            this.transEl.style.display = 'block';
            this.transEl.style.opacity = '1';
        } else {
            this.transEl.innerHTML = '';
            this.transEl.style.display = 'none';
            this.transEl.style.opacity = '0';
        }
    }

    applySettings(settings = {}) {
        super.applySettings(settings);
        /* ★ highlightColor 仅控制文字高亮色 */
        if (settings.highlightColor) {
            if (this.viewContainer) {
                this.viewContainer.style.setProperty('--dim-highlight-color', settings.highlightColor);
            }
        }
        /* ★ bgColor 控制粒子/背景色调，不再与 highlightColor 关联 */
        const bgColor = settings.bgColor || settings.themeColor;
        if (bgColor) {
            this.themeColor = bgColor;
            if (this.bgEngine) {
                this.bgEngine.setTheme(bgColor);
            }
        }
        if (settings.fontSize && this.viewContainer) {
            this.viewContainer.style.setProperty('--dim-font-size', `${Math.max(60, settings.fontSize * 1.8)}px`);
        }
        if (settings.fontFamily && this.viewContainer) {
            const resolved = (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function')
                ? window.resolveFontFamily(settings.fontFamily)
                : settings.fontFamily;
            this.viewContainer.style.setProperty('--dim-font-family', resolved);
            this.viewContainer.style.setProperty('--vis-font-family', resolved);
        }
        if (settings.emotionGlow !== undefined && this.viewContainer) {
            this.viewContainer.style.setProperty('--emotion-glow', `${parseFloat(settings.emotionGlow) || 10}px`);
        }
    }

    handleResize(w, h) {
        if (!w || !h) {
            if (this.container) {
                const r = this.container.getBoundingClientRect();
                w = r.width;
                h = r.height;
            } else if (typeof window !== 'undefined') {
                w = window.innerWidth;
                h = window.innerHeight;
            }
        }
        if (w <= 0 || h <= 0) return;
        if (this.bgEngine) this.bgEngine.resize(w, h);
        if (this.shapesCanvas) {
            /* ★ 按性能档位的渲染缩放降采样：减少每帧绘制的物理像素，省 CPU/无 GPU 友好 */
            const s = this._renderScale || 1;
            this.shapesCanvas.width = Math.max(1, Math.round(w * s));
            this.shapesCanvas.height = Math.max(1, Math.round(h * s));
        }

        // ★ 布局尺寸变化 → 已有行的字符中心缓存全部失效，下一帧惰性重测
        for (const e of this.entities) {
            if (e.domEl && e.domEl._dimChars) e.domEl._needMeasure = true;
        }
    }

    /**
     * ★ 性能分档下发（VisualizerManager → 浮空引擎）：
     * 低性能/无 GPU 设备：canvas 降采样 + 粒子步长 + 关闭阴影
     */
    setPerfConfig(cfg = {}) {
        if (cfg.dimension) this._perfDim = cfg.dimension;
        if (cfg.vfx) this._perfVfx = cfg.vfx;
        const d = this._perfDim || {};
        const vfx = this._perfVfx || {};
        this._renderScale = Math.max(0.4, Math.min(1, parseFloat(vfx.renderScale ?? 1)));
        this._bgLayers = d.bgLayers ?? 3;
        if (this.shapesEngine && typeof this.shapesEngine.setPerf === 'function') {
            this.shapesEngine.setPerf({
                particleScale: d.particleScale ?? 1,
                shadowEnabled: (d.shadowEnabled !== false) && (vfx.dimParticles !== false),
            });
        }
        if (this.container) {
            const r = this.container.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0) this.handleResize(r.width, r.height);
        }
    }

    onLineChange(lineIndex, lineData) {
        if (lineIndex < 0 || lineIndex >= this.entities.length) return;
        this.currentLineIndex = lineIndex;
        this.targetWordTrackingX = 0;
        this.targetWordTrackingY = 0;
        this.updateCameraTarget(lineIndex, false);
        this.updateTranslation(lineIndex);
    }

    onUpdate(timeMs, timeSec, activeIndex) {
        this.audioTime = timeSec;
        this.updateWordHighlight(timeMs);
    }

    /**
     * 3D 摄像机更新目标世界位置与旋转角
     */
    updateCameraTarget(lineIndex, immediate = false) {
        const targetZ = -lineIndex * LINE_DEPTH_SPACING;
        const isEven = (lineIndex % 2 === 0);

        const targetX = (isEven ? -45 : 45) + this.wordTrackingX;
        const targetY = (isEven ? -15 : 15) + this.wordTrackingY;

        const angles = this.lineAngles[lineIndex] || {
            yaw: isEven ? 16 : -16,
            pitch: isEven ? -4 : 4,
            roll: isEven ? 3.5 : -3.5
        };

        if (immediate && this.camera) {
            this.camera.pos.x = targetX;
            this.camera.pos.y = targetY;
            this.camera.pos.z = targetZ;
            this.camera.rot.x = angles.pitch;
            this.camera.rot.y = angles.yaw;
            this.camera.rot.z = angles.roll;
        }

        if (this.camera) {
            this.camera.setTarget(targetX, targetY, targetZ, angles.pitch, angles.yaw, angles.roll);
            this.camera.addImpulse(0.4);
        }
    }

    createLineDOM(line, worldZ) {
        const el = document.createElement('div');
        el.className = 'dim-line';
        el.style.transform = `translate3d(0px, 0px, ${worldZ.toFixed(1)}px)`;
        this.buildHeroWords(el, line);
        return el;
    }

    /**
     * ★ 单个字符染色构建 (Character-by-character DOM & timing)
     */
    buildHeroWords(container, line) {
        container.innerHTML = '';
        /* ★ 预存逐字符时间数组 + 高亮游标 + 布局缓存标记（updateWordHighlight 每帧 O(1)，不再 querySelectorAll/parseFloat） */
        container._dimChars = [];
        container._charCursor = 0;
        container._needMeasure = true;
        if (!line) return;
        const lineStart = line.start !== undefined ? line.start : (line.time || 0);
        const lineEnd = line.end !== undefined ? line.end : (lineStart + 4000);
        const lineDur = Math.max(500, lineEnd - lineStart);

        // 提取 AI 情感词列表并结合内置情感词字典
        const rawEmotionWords = (this.aiData && this.aiData.emotion_words) || 
                                (typeof window !== 'undefined' && window.aiEmotionWords) || [];

        const emotionEntries = [...BUILTIN_EMOTIONS];
        rawEmotionWords.forEach(ew => {
            if (typeof ew === 'string' && ew.trim()) {
                emotionEntries.unshift({ word: ew.trim(), color: '#ff2a6d' });
            } else if (ew && typeof ew === 'object' && ew.word) {
                emotionEntries.unshift({ word: ew.word.trim(), color: ew.color || '#ff2a6d' });
            }
        });

        const isEnglishWord = (str) => /^[a-zA-Z0-9'’\-]+$/.test(str.trim());

        // 收集所有"可见字符"的 span，并按它们在整行中的先后顺序拼接为 fullText。
        // 同时记录每个字符 span 在 fullText 中的全局偏移，便于后续按"子串"匹配情感词，
        // 从而解决整词/整 token 匹配导致的中文短语、英文短语、跨 word 情感词"上色不全"的问题。
        const charSpans = [];   // 与 fullChars 一一对应
        const fullChars = [];   // 整行可见字符序列（不含空格占位）
        const appendCharSpan = (span, ch) => {
            charSpans.push(span);
            fullChars.push(ch);
        };

        /* ★ DocumentFragment：整行一次插入，避免逐词 appendChild 引发多次样式失效 */
        const frag = document.createDocumentFragment();

        // 1. 原生 YRC 逐字歌词：将每个词进一步拆解为单个字符 (Character-Level)，并包裹在 dim-word-wrap 单词容器中
        if (line.words && line.words.length > 0) {
            line.words.forEach((w, wIdx) => {
                const raw = w.text || '';
                const trimmed = raw.trim();
                if (!trimmed) return;

                const wStart = w.start;
                const wEnd = w.end;
                const wDur = Math.max(60, wEnd - wStart);
                const chars = Array.from(trimmed);
                const charCount = chars.length;
                const charDur = wDur / charCount;

                // 创建单词整体容器（禁止折行），确保单词不会被拆成两半
                const wordWrap = document.createElement('span');
                wordWrap.className = 'dim-word-wrap';

                chars.forEach((char, cIdx) => {
                    const span = document.createElement('span');
                    span.className = 'dim-char';
                    span.textContent = char;
                    span.dataset.start = wStart + cIdx * charDur;
                    span.dataset.end = wStart + (cIdx + 1) * charDur;
                    wordWrap.appendChild(span);
                    appendCharSpan(span, char);
                });

                frag.appendChild(wordWrap);

                // 英文单词间或包含空格时，插入独立空格占位元素
                const nextWord = line.words[wIdx + 1];
                const hasExplicitSpace = raw.endsWith(' ') || (nextWord && (nextWord.text || '').startsWith(' '));
                const shouldAddSpace = hasExplicitSpace || (isEnglishWord(trimmed) && nextWord && isEnglishWord(nextWord.text || ''));

                if (shouldAddSpace) {
                    const spaceSpan = document.createElement('span');
                    spaceSpan.className = 'dim-space';
                    spaceSpan.innerHTML = '&nbsp;';
                    frag.appendChild(spaceSpan);
                }
            });
        }
        // 2. 普通 LRC 歌词：智能切分并在字符级别赋予连续时间戳
        else {
            const rawText = line.original || line.text || '';
            const regex = /([a-zA-Z0-9'’\-]+|[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|[\s]+|[^\s\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+)/gu;
            const rawTokens = [];
            let m;
            while ((m = regex.exec(rawText)) !== null) {
                if (m[0]) rawTokens.push(m[0]);
            }
            const tokens = rawTokens.length > 0 ? rawTokens : [rawText];

            // 统计非空格总字符数
            let totalNonSpaceChars = 0;
            tokens.forEach(t => {
                if (!/^\s+$/.test(t)) {
                    totalNonSpaceChars += Array.from(t).length;
                }
            });
            totalNonSpaceChars = Math.max(1, totalNonSpaceChars);
            const charDur = lineDur / totalNonSpaceChars;
            let charIndex = 0;

            tokens.forEach((token) => {
                const isWhitespace = /^\s+$/.test(token);
                if (isWhitespace) {
                    const spaceSpan = document.createElement('span');
                    spaceSpan.className = 'dim-space';
                    spaceSpan.innerHTML = '&nbsp;';
                    frag.appendChild(spaceSpan);
                    return;
                }

                const chars = Array.from(token);
                const wordWrap = document.createElement('span');
                wordWrap.className = 'dim-word-wrap';

                chars.forEach((char) => {
                    const span = document.createElement('span');
                    span.className = 'dim-char';
                    span.textContent = char;
                    span.dataset.start = lineStart + charIndex * charDur;
                    span.dataset.end = lineStart + (charIndex + 1) * charDur;
                    charIndex++;
                    wordWrap.appendChild(span);
                    appendCharSpan(span, char);
                });

                frag.appendChild(wordWrap);
            });
        }

        // 3. 一次插入整行 + 按构建顺序预存字符时间（供 updateWordHighlight 游标推进）
        container.appendChild(frag);
        container._dimChars = charSpans.map(s => ({
            el: s,
            start: parseFloat(s.dataset.start || 0),
            end: parseFloat(s.dataset.end || 0)
        }));

        // 4. 字符级情感词匹配：在整行可见文本上做子串扫描，标记命中区间，再统一上色。
        //    这样无论是 YRC 逐字（词被切碎）还是 LRC（单字被切开），多字情感词都能正确命中。
        const fullText = fullChars.join('');
        if (fullText && emotionEntries.length) {
            const emotionFlags = new Array(fullChars.length).fill(null);
            emotionEntries.forEach(ew => {
                const kw = (ew.word || '').trim().toLowerCase();
                if (!kw) return;
                let from = 0;
                let idx;
                while ((idx = fullText.toLowerCase().indexOf(kw, from)) !== -1) {
                    const to = idx + Array.from(kw).length;
                    for (let i = idx; i < to && i < emotionFlags.length; i++) {
                        emotionFlags[i] = ew.color;
                    }
                    from = idx + 1;
                }
            });
            charSpans.forEach((span, i) => {
                const color = emotionFlags[i];
                if (color) {
                    span.classList.add('dim-char-emotion');
                    span.style.setProperty('--emotion-color', color);
                }
            });
        }
    }

    /**
     * 逐字符点亮 & 摄像机注视唱到的单个字符中心
     */
    updateWordHighlight(timeMs) {
        if (this.currentLineIndex < 0 || !this.entities[this.currentLineIndex]) return;
        const activeEnt = this.entities[this.currentLineIndex];
        if (!activeEnt.domEl) return;

        const el = activeEnt.domEl;
        const chars = el._dimChars;
        if (!chars || chars.length === 0) return;

        /* ★ 游标推进代替每帧全行扫描（O(n) → 均摊 O(1)）：
           歌词时间单调递增，已唱过的字符不会回退，每帧只处理新触发的 0~1 个字符；
           仅 seek（时间回退）时清状态重扫。 */
        let cursor = el._charCursor || 0;
        if (cursor > 0 && timeMs < chars[cursor - 1].start) {
            for (let i = 0; i < cursor; i++) chars[i].el.classList.remove('active', 'sung');
            cursor = 0;
        }
        while (cursor < chars.length && timeMs >= chars[cursor].start) {
            const c = chars[cursor];
            c.el.classList.add('active');
            if (timeMs >= c.end) {
                c.el.classList.add('sung');
                cursor++;
            } else {
                break; // 当前字符正在唱响，等它唱完再推进
            }
        }
        el._charCursor = cursor;

        // 摄像机平滑对准当前唱到的单字符中心（坐标在布局期缓存，帧内零布局读取）
        let cur = (cursor < chars.length && timeMs >= chars[cursor].start && timeMs < chars[cursor].end)
            ? chars[cursor]
            : null;
        if (cur) {
            if (el._needMeasure !== false && !this._measureLineChars(activeEnt)) {
                cur = null; // 布局尚未有效，本帧跳过追踪（等价旧版 width<=0 分支）
            }
            if (cur && cur.cx !== undefined) {
                this.targetWordTrackingX = cur.cx * 0.45;
                this.targetWordTrackingY = cur.cy * 0.25;
            }
        }
    }

    /**
     * ★ 布局期缓存字符中心（相对本行中心），消灭帧内 getBoundingClientRect（Forced reflow）。
     * 相对坐标不随镜头 transform 变化（整行共享同一祖先变换，相减抵消）。
     * 失效时机仅三处：行创建(默认 true)、handleResize、document.fonts.ready。
     * @returns {boolean} 是否测量成功
     */
    _measureLineChars(ent) {
        const el = ent.domEl;
        const chars = el._dimChars;
        if (!chars || chars.length === 0) return false;
        const lineRect = el.getBoundingClientRect();
        if (!(lineRect.width > 0 && lineRect.height > 0)) return false;
        for (let i = 0; i < chars.length; i++) {
            const r = chars[i].el.getBoundingClientRect();
            chars[i].cx = (r.left + r.width * 0.5) - (lineRect.left + lineRect.width * 0.5);
            chars[i].cy = (r.top + r.height * 0.5) - (lineRect.top + lineRect.height * 0.5);
        }
        el._needMeasure = false;
        return true;
    }

    /**
     * 每帧在统一 3D 体系下渲染摄像机视口与 3D 实体
     */
    renderFrame(dt) {
        if (!this.bgEngine || !this.shapesEngine || !this.camera) return;

        // 1. 安全更新音频频谱
        const audioEl = window.audio || document.querySelector('audio');
        const isPlaying = audioEl ? !audioEl.paused : true;
        if (this.audio) {
            this.audio.update(this.audioTime, isPlaying);
        }

        // 2. 字符中心平滑追踪插值
        this.wordTrackingX += (this.targetWordTrackingX - this.wordTrackingX) * 0.09;
        this.wordTrackingY += (this.targetWordTrackingY - this.wordTrackingY) * 0.09;

        // 摄像机更新目标
        const angles = this.lineAngles[this.currentLineIndex] || { yaw: 16, pitch: -4, roll: 3.5 };
        const isEven = (this.currentLineIndex % 2 === 0);
        const targetZ = -this.currentLineIndex * LINE_DEPTH_SPACING;

        // 微小呼吸悬浮摆动
        const breathTime = performance.now() * 0.0015;
        const breathYaw = Math.sin(breathTime * 0.8) * 1.5;
        const breathPitch = Math.cos(breathTime * 0.6) * 1.0;
        const breathRoll = Math.sin(breathTime * 0.5) * 0.8;

        const targetX = (isEven ? -40 : 40) + this.wordTrackingX;
        const targetY = (isEven ? -15 : 15) + this.wordTrackingY;

        this.camera.setTarget(
            targetX, targetY, targetZ,
            angles.pitch + breathPitch,
            angles.yaw + breathYaw,
            angles.roll + breathRoll
        );

        this.camera.update(dt);

        // 3. 渲染流体丝绸背景
        this.bgEngine.render(dt, this.audio || {});

        // 4. 将 3D 摄像机逆变换应用到 3D 歌词舞台世界容器
        if (this.lyricStage) {
            this.lyricStage.style.transform = this.camera.getViewMatrixTransform();
        }

        // 5. 根据摄像机当前 Z 深度更新可见实体的透明度与虚化
        const camZ = this.camera.pos.z;

        for (let i = 0; i < this.entities.length; i++) {
            const ent = this.entities[i];
            const relZ = ent.lineWorldPos.z - camZ;

            // 超出可见范围：隐藏
            if (relZ > 500 || relZ < -2400) {
                if (ent.domEl) {
                    ent.domEl.style.display = 'none';
                }
                ent.opacity = 0;
                continue;
            }

            // A. 已被摄像机穿过的行 (relZ > 0)
            if (relZ > 0) {
                const u = relZ / 450;
                ent.opacity = Math.max(0, 1.0 - Math.pow(u, 1.4));
                const blur = u * 12;
                if (!ent.domEl && this.lyricStage) {
                    ent.domEl = this.createLineDOM(ent.line, ent.lineWorldPos.z);
                    this.lyricStage.appendChild(ent.domEl);
                }
                if (ent.domEl) {
                    ent.domEl.style.display = 'flex';
                    ent.domEl.className = 'dim-line dim-line-past';
                    ent.domEl.style.opacity = ent.opacity.toFixed(3);
                    ent.domEl.style.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : 'none';
                }
            }
            // B. 焦点平面处的活跃行 (relZ ∈ [-250, 0])
            else if (relZ >= -250) {
                ent.opacity = 1.0;
                if (!ent.domEl && this.lyricStage) {
                    ent.domEl = this.createLineDOM(ent.line, ent.lineWorldPos.z);
                    this.lyricStage.appendChild(ent.domEl);
                }
                if (ent.domEl) {
                    ent.domEl.style.display = 'flex';
                    ent.domEl.className = 'dim-line dim-line-active';
                    ent.domEl.style.opacity = '1';
                    ent.domEl.style.filter = 'none';
                }
            }
            // C. 摄像机前方深处的后续各行 (relZ < -250)
            else {
                const depth = -relZ;
                const u = (depth - 250) / 1900;
                ent.opacity = Math.max(0.08, 0.45 * (1.0 - u));
                const blur = Math.min(10, (depth - 250) / 300);

                if (!ent.domEl && this.lyricStage) {
                    ent.domEl = this.createLineDOM(ent.line, ent.lineWorldPos.z);
                    this.lyricStage.appendChild(ent.domEl);
                }
                if (ent.domEl) {
                    ent.domEl.style.display = 'flex';
                    ent.domEl.className = depth < 1000 ? 'dim-line dim-line-next1' : 'dim-line dim-line-next2';
                    ent.domEl.style.opacity = ent.opacity.toFixed(3);
                    ent.domEl.style.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : 'none';
                }
            }
        }

        // 6. 清空并渲染 3D 世界中的小巧伴随纯点阵星群
        if (this.shapesCtx && this.shapesCanvas) {
            this.shapesCtx.clearRect(0, 0, this.shapesCanvas.width, this.shapesCanvas.height);
            this.shapesEngine.render(
                this.shapesCtx,
                this.shapesCanvas.width,
                this.shapesCanvas.height,
                dt,
                this.audio || {},
                this.entities,
                {
                    x: this.camera.pos.x,
                    y: this.camera.pos.y,
                    z: this.camera.pos.z,
                    rx: this.camera.rot.x,
                    ry: this.camera.rot.y,
                    rz: this.camera.rot.z
                },
                this.themeColor || '#ffcc33'
            );
        }
    }

    destroy() {
        this.stop();
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.audio) this.audio.destroy();
        this.entities = [];
        super.destroy();
    }
}
