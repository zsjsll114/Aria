/**
 * PVEngine.js
 * PV 模式主调度控制器：
 * 1. 调度 PVLyricLayout (全语言 4 大海报构图模版与长竖排大柱排版)
 * 2. 调度 PVCamera (3D 景深缓动与多轴长镜头极度平滑漫游)
 * 3. 调度 PVRendering (字素三态生命周期、情感词动态形变呼吸与居中准心框)
 * 4. 调度 PVDecorations (底层巨型镂空描边字与几何视差)
 * 5. 调度 PVBackground (深邃星芒暗夜流体)
 * 6. 实现全量 applySettings 设置热生效 (字体、字号、阻尼、HUD、粒子)
 */

import { PVCamera } from './PVCamera.js';
import { PVLyricLayout } from './PVLyricLayout.js';
import { PVBackground } from './PVBackground.js';
import { PVDecorations } from './PVDecorations.js';
import { PVRendering } from './PVRendering.js';

export class PVEngine {
  constructor(container) {
    this.container = container || null;
    this.layout = new PVLyricLayout();
    this.camera = new PVCamera();
    this.background = null;
    this.decorations = null;
    this.rendering = null;

    // DOM 分层引用
    this.viewContainer = null;
    this.bgLayer = null;
    this.decoLayer = null;
    this.stageLayer = null;
    this.hudLayer = null;
    this.translationArea = null;

    // 状态数据
    this.nodes = [];
    this.currentNodeIndex = -1;
    this.lastActiveLineData = null;
    this.themeColor = '#ffcc33';
    this.isRunning = false;
    this.rafId = null;
    this.aiColorSync = true; // ★ AI 情感词多色发光联动开关
    this.cameraZoom = 1.0;   // ★ 摄像机默认焦距/特写倍率（用户可调：0.8x~3.0x，放大可实现单屏两三词特写）
  }

  /**
   * 初始化 DOM 图层与子模块
   * @param {HTMLElement} [container] 宿主容器
   */
  init(container) {
    if (container) {
      this.container = container;
    }
    if (!this.container && typeof document !== 'undefined') {
      this.container = document.querySelector('.pv-view-container') || document.getElementById('pvViewContainer') || document.querySelector('.player-container');
    }
    if (!this.container) return this;

    // 1. 确定 PV 根视图容器
    let view = (this.container.classList && this.container.classList.contains('pv-view-container'))
      ? this.container
      : this.container.querySelector('.pv-view-container');

    if (!view) {
      view = document.createElement('div');
      view.className = 'pv-view-container';
      this.container.appendChild(view);
    }
    this.viewContainer = view;
    this.viewContainer.innerHTML = '';
    this.viewContainer.style.display = 'block';

    // 2. 创建 3D 分层舞台
    // Layer -1: ★ 流体背景层（上游参考项目 思路：模糊封面 + 漂浮光斑，DOM/CSS 合成驱动；置于 silk 画布之下）
    this.fluidLayer = document.createElement('div');
    this.fluidLayer.className = 'pv-fluid-bg';
    this.fluidLayer.dataset.active = 'a';
    this.fluidLayer.innerHTML =
      '<img class="pv-fluid-img" alt="" loading="lazy">' +
      '<img class="pv-fluid-img" alt="" loading="lazy">' +
      '<div class="pv-fluid-blob pv-fluid-blob-a"></div>' +
      '<div class="pv-fluid-blob pv-fluid-blob-b"></div>' +
      '<div class="pv-fluid-blob pv-fluid-blob-c"></div>';
    this.viewContainer.appendChild(this.fluidLayer);
    this._fluidCover = null;   // 内层重建后封面缓存失效，下次 update 重新同步

    // Layer 0: 流体背景层
    this.bgLayer = document.createElement('div');
    this.bgLayer.className = 'pv-layer pv-parallax-layer pv-layer-bg';
    this.viewContainer.appendChild(this.bgLayer);

    // Layer 1: 背景巨型描边文字与几何视差层 (Parallax 0.35x)
    this.decoLayer = document.createElement('div');
    this.decoLayer.className = 'pv-layer pv-parallax-layer pv-layer-deco pv-layer-outline';
    this.viewContainer.appendChild(this.decoLayer);

    // Layer 2: 核心歌词排版舞台 (Parallax 1.0x)
    this.stageLayer = document.createElement('div');
    this.stageLayer.className = 'pv-layer pv-parallax-layer pv-layer-stage';
    this.viewContainer.appendChild(this.stageLayer);

    // Layer 3: HUD 标尺与星芒微粒层 (固定层)
    this.hudLayer = document.createElement('div');
    this.hudLayer.className = 'pv-layer pv-layer-hud';
    this.viewContainer.appendChild(this.hudLayer);

    // 3. PV 模式底栏翻译组件 (复用飞入模式相同的文本样式与动效)
    let transArea = this.viewContainer.querySelector('.pv-translation-area');
    if (!transArea) {
      transArea = document.createElement('div');
      transArea.className = 'pv-translation-area flyin-translation-area';
      transArea.innerHTML = `
        <div class="flyin-translation-text"></div>
        <div class="flyin-romaji-text"></div>
      `;
      this.viewContainer.appendChild(transArea);
    }
    this.translationArea = transArea;

    // 4. 实例化子模块
    this.background = new PVBackground(this.bgLayer, this.hudLayer);
    this.decorations = new PVDecorations(this.decoLayer);
    this.rendering = new PVRendering(this.stageLayer);

    this.background.init();

    return this;
  }

  /**
   * 应用外观设置 (字体、字号、阻尼、HUD、粒子、半调网点)
   * @param {Object} s 设置对象
   */
  applySettings(s = {}) {
    // 0. 预设风格联动
    if (s.preset) {
      const PRESETS = {
        'dream':   { primary: { r: 52, g: 22, b: 84 }, secondary: { r: 72, g: 18, b: 58 }, accent: '#ffcc33', halftone: 6 },
        'anime':   { primary: { r: 78, g: 14, b: 38 }, secondary: { r: 84, g: 42, b: 12 }, accent: '#ff3366', halftone: 8 },
        'cyber':   { primary: { r: 12, g: 24, b: 68 }, secondary: { r: 68, g: 10, b: 78 }, accent: '#00ffcc', halftone: 4 },
        'minimal': { primary: { r: 24, g: 24, b: 28 }, secondary: { r: 36, g: 36, b: 42 }, accent: '#ffffff', halftone: 5 }
      };
      const p = PRESETS[s.preset];
      if (p) {
        if (this.background) this.background.updateTheme(p.primary, p.secondary, p.accent);
        /* ★ 预设联动网点：halftoneSize 完全未设置时才采用预设密度；
           （2026-09-22 修复：旧条件把「值为 6」也视为未自定义——用户把滑杆
           拖回默认 6 时设置值反被 preset 覆盖，「改了没用」的帮凶之一） */
        if (this.viewContainer && !s.halftoneSize) {
          this.viewContainer.style.setProperty('--halftone-size', `${p.halftone}`);
        }
      }
    }

    if (this.viewContainer) {
      // 1. 字体应用
      if (s.fontFamily) {
        const resolved = (typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function')
          ? window.resolveFontFamily(s.fontFamily)
          : s.fontFamily;
        this.viewContainer.style.setProperty('--pv-font-family', resolved);
      }
      // 2. 基础字号
      if (s.fontSize) {
        this.viewContainer.style.setProperty('--pv-base-font-size', `${s.fontSize}px`);
      }
      // 3. 半调大小
      if (s.halftoneSize) {
        this.viewContainer.style.setProperty('--halftone-size', `${s.halftoneSize}px`);
      }
      // 4. 高亮颜色
      if (s.highlightColor) {
        this.viewContainer.style.setProperty('--pv-highlight-color', s.highlightColor);
      }
      // 5. 情感词发光强度
      if (s.emotionGlow !== undefined) {
        this.viewContainer.style.setProperty('--emotion-glow', `${parseFloat(s.emotionGlow) || 10}px`);
      }
    }

    // 4. 运镜速度、阻尼与焦距缩放
    if (s.cameraZoom !== undefined) {
      this.cameraZoom = Math.max(0.6, Math.min(3.5, parseFloat(s.cameraZoom) || 1.0));
      /* ★ 焦距落点改为「渲染字号预乘」（2026-09-22）：此前把 zoom 乘进摄像机
         scale——CSS transform scale>1 是栅格后插值，字体边缘必然模糊，且跟焦
         tanh 的视口半宽没按 zoom 折算导致新词对齐偶发偏移。现在 zoom 只作用于
         --pv-user-zoom（字号体系预乘，原生矢量渲染清晰），摄像机 scale 保持
         原始 shot 斜坡（1.0~1.16 推进感），跟焦/对齐回到已调优行为。 */
      if (this.viewContainer) {
        this.viewContainer.style.setProperty('--pv-user-zoom', String(this.cameraZoom));
      }
    }
    if (this.camera) {
      if (s.cameraSpeed !== undefined) {
        this.camera.speedMultiplier = parseFloat(s.cameraSpeed) || 1.0;
      }
      if (s.cameraDamping !== undefined) {
        this.camera.setDamping(parseFloat(s.cameraDamping));
      }
    }

    // 5. 显示开关：HUD 标尺
    if (this.hudLayer) {
      this.hudLayer.style.display = (s.showHud !== false) ? '' : 'none';
    }

    // 6. 显示开关：巨型背景描边字与几何装饰
    if (this.decoLayer) {
      this.decoLayer.style.display = (s.showDecorations !== false) ? '' : 'none';
    }

    // 7. 显示开关：星芒微粒
    if (this.background && this.background.particleContainer) {
      this.background.particleContainer.style.display = (s.showParticles !== false) ? '' : 'none';
    }

    // 7.4 流体背景开关（默认开；视觉开销关可关）
    if (this.fluidLayer) {
      this.fluidLayer.style.display = (s.showFluidBg === false) ? 'none' : '';
    }

    // 7.5 AI 情感词多色发光联动开关
    if (s.aiColorSync !== undefined) {
      this.aiColorSync = !!s.aiColorSync;
      // 实时更新：如果已有歌词数据，重新装载以应用/取消情感词多色
      if (this.nodes && this.nodes.length > 0 && this.lastRawLyrics) {
        this.setLyrics(this.lastRawLyrics, this.lastAiData);
      }
    }

    // 8. 主题色
    if (s.themeColor || s.highlightColor) {
      const color = s.highlightColor || s.themeColor;
      this.themeColor = color;
      if (this.viewContainer) {
        this.viewContainer.style.setProperty('--pv-emotion-color', color);
        if (s.highlightColor) {
          this.viewContainer.style.setProperty('--pv-highlight-color', s.highlightColor);
        }
      }
      /* ★ 主题色变更即时注入背景绸缎 */
      if (this.background && typeof this.background.applyThemeHex === 'function') {
        this.background.applyThemeHex(color);
      }
    }
    // 9. ★ 背景图形颜色 (graphicColor)
    if (s.graphicColor) {
      this.graphicColor = s.graphicColor;
      if (this.viewContainer) {
        this.viewContainer.style.setProperty('--pv-graphic-color', s.graphicColor);
      }
    }
  }

  /**
   * 装载新歌词与 AI 情感主题数据
   */
  shiftHue(hex, deg) {
    if (!hex || hex[0] !== '#') hex = '#ffcc33';
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0, l = (max + min) / 2, d = max - min;
    if (d !== 0) { s = l > 0.5 ? d / (2 - max - min) : d / (max + min); if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; }
    h = (h + deg / 360) % 1; if (h < 0) h += 1;
    const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, to8 = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return '#' + to8(f(p, q, h + 1 / 3)) + to8(f(p, q, h)) + to8(f(p, q, h - 1 / 3));
  }

  setLyrics(rawLyrics = [], aiData = {}) {
    // ★ 保存原始数据，供 aiColorSync 切换时重新装载
    this.lastRawLyrics = rawLyrics;
    this.lastAiData = aiData;

    if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) {
      this.nodes = [];
      this.clear();
      return;
    }

    // 优先使用用户已配置的主题色或界面全局主题色，其次使用 AI/封面提取色，最后回退 #ffcc33
    const globalCssColor = (typeof document !== 'undefined') ? document.documentElement.style.getPropertyValue('--theme-color') : null;
    this.themeColor = (this.themeColor && this.themeColor !== '#ffcc33') 
      ? this.themeColor 
      : ((this.settings && this.settings.themeColor && this.settings.themeColor !== '#ffcc33') 
        ? this.settings.themeColor 
        : (globalCssColor && globalCssColor.trim() && globalCssColor.trim() !== '#ffcc33')
          ? globalCssColor.trim()
          : (aiData && aiData.accent_color) || (typeof window !== 'undefined' && window.coverPalette ? window.coverPalette.accent : null) || this.themeColor || '#ffcc33');

    // ★ 主题色注入背景绸缎（上游参考项目 duo 调色板对齐：背景跟随歌曲主题又保持深底）
    if (this.background && typeof this.background.applyThemeHex === 'function') {
      this.background.applyThemeHex(this.themeColor);
    }

    // ★ 根据 aiColorSync 开关决定是否使用 AI 情感词多色
    // 关闭时：清空 emotion_words 的颜色信息，让所有情感词回退为主题色
    let effectiveAiData = aiData;
    if (!this.aiColorSync && aiData && Array.isArray(aiData.emotion_words)) {
      effectiveAiData = { ...aiData, emotion_words: aiData.emotion_words.map(w => {
        if (typeof w === 'string') return w;
        // 保留情感词标记但去除自定义颜色，使其回退到主题色
        return { ...w, color: undefined };
      }) };
    }

    // ★ 预览/PV 发出的情感词若为无颜色普通字符串，依据 accent 色相偏移为其分配不同颜色，使情感词在 PV 中可见补色
    if (effectiveAiData && Array.isArray(effectiveAiData.emotion_words)) {
      const accent = effectiveAiData.accent_color || this.themeColor || '#ffcc33';
      /* ★ 箭头函数保持 this（普通 function 在严格模式 this===undefined，
         shiftHue 访问失败 → setLyrics 中断 → 无海报 → “PV 预览只有背景没有歌词”） */
      effectiveAiData.emotion_words = effectiveAiData.emotion_words.map((item, idx) => {
        if (typeof item === 'string') {
          return { word: item, color: this.shiftHue(accent, idx * 42) };
        }
        if (!item.color) return { ...item, color: this.shiftHue(accent, idx * 42) };
        return item;
      });
    }

    // 排版计算
    this.nodes = this.layout.process(rawLyrics, effectiveAiData);
    this.currentNodeIndex = -1;
    this.lastActiveLineData = null;
    this.camera.reset();

    // 预备加载首句海报骨架
    if (this.nodes.length > 0) {
      this._updateActiveNode(0);
    }
  }

  /**
   * ★ 流体背景封面同步（上游参考项目 FluidBackground 思路）：封面变化时预加载后交叉淡入。
   * 双 <img> 栈：新封面落到非激活 img 并升 opacity，旧 img 同步降 opacity → 1.5s easeInOut。
   * 幂等：同一 URL 只处理一次；cover 为空时保持暗底，不打扰。
   */
  _syncFluidCover(coverForce) {
    const layer = this.fluidLayer;
    if (!layer) return;
    const cover = (coverForce !== undefined)
      ? coverForce
      : ((typeof window !== 'undefined' && window.currentSongData && window.currentSongData.cover) || '');
    if (!cover || cover === this._fluidCover) return;
    this._fluidCover = cover;

    const children = layer.children;
    if (children.length < 2) return;
    const active = layer.dataset.active === 'b' ? 1 : 0;
    const incoming = children[1 - active];
    const outgoing = children[active];
    const pre = new Image();
    const apply = () => {
      if (!incoming.isConnected) return;
      incoming.src = cover;
      // 强制 reflow 使 opacity transition 生效
      void incoming.offsetWidth;
      incoming.style.opacity = '1';
      outgoing.style.opacity = '0';
      layer.dataset.active = String(1 - active);
    };
    pre.onload = apply;
    pre.onerror = apply;   // 封面加载失败也切走，避免占位图挂起
    pre.src = cover;
  }

  /**
   * 逐帧时钟驱动：检测活跃场景 + 光束扫描推进 + 3D 摄像机平滑锁定 + 底部翻译同步
   * @param {number} currentTimeSec 当前播放秒数
   */
  update(currentTimeSec = 0) {
    // 0. 流体封面同步（低成本字符串比较；无封面/未变则跳过）
    this._syncFluidCover();

    if (!this.nodes || this.nodes.length === 0) return;

    const timeMs = currentTimeSec * 1000;

    // 1. 查找当前活跃的海报场景索引
    const activeIdx = this.layout.getActiveIndex(timeMs);
    if (activeIdx >= 0 && activeIdx !== this.currentNodeIndex) {
      this._updateActiveNode(activeIdx);
    }

    // 2. 光束扫描驱动，获取当前活跃词块中心与当前活跃子句数据
    if (this.rendering) {
      const { activeBlockCenter, activeLineData, truckHint } = this.rendering.updateTime(timeMs);

      if (activeBlockCenter && activeBlockCenter.worldX !== undefined && this.nodes[this.currentNodeIndex]) {
        const node = this.nodes[this.currentNodeIndex];
        /* ★ 参考实现 tempera camera：shot 内 zoom 斜坡 zoomStart→zoomEnd 随场景进度插值，
           配合活跃字符中心跟焦，画面在 shot 持续期内有缓推/缓拉的推进感。
           （cameraZoom 用户焦距不再乘在这里——它已移至 --pv-user-zoom 字号预乘，
           避免 transform scale 放大造成的字体模糊与跟焦偏移） */
        let shotScale = node.pos.scale || 1.02;
        const cam = node.cam;
        if (cam && node.duration > 0) {
          const p = Math.max(0, Math.min(1, (timeMs - node.start) / node.duration));
          shotScale = (node.pos.scale || 1) * (cam.zoomStart + (cam.zoomEnd - cam.zoomStart) * p);
        }
        /* ★ diorama resolveReadHeadTruck：tanh 饱和跟焦——
           行宽远小于视口时几乎不动（避免短句被跟得乱晃），行长超出视野时
           才沿行平滑跟踪，且始终把词留在安全框内（无 kink、无越界） */
        let targetX = activeBlockCenter.worldX;
        if (truckHint && truckHint.lineSpan > 0) {
          const viewportW = (this.viewContainer && this.viewContainer.getBoundingClientRect
            ? this.viewContainer.getBoundingClientRect().width
            : (typeof window !== 'undefined' ? window.innerWidth : 1280)) || 1280;
          const visibleHalfW = Math.max(viewportW / 2, 100);
          const allowed = Math.max(Math.abs(visibleHalfW - truckHint.lineSpan / 2), 0.001);
          const offset = truckHint.charX - truckHint.lineCenterX;
          targetX = truckHint.charX - allowed * Math.tanh(offset / allowed);
        }
        // 摄像机平滑锁定当前活跃词块中心，并结合场景的 3D 景深参数
        this.camera.setTarget(
          targetX, 
          activeBlockCenter.worldY, 
          shotScale,
          node.pos.z || 0, 
          node.pos.pitch || 0, 
          node.pos.roll || 0
        );
      } else {
        // ★ bridge-drift：当前场景唱毕、下一场景未开始（间隙）时，摄像机沿两场景锚点
        //   做缓动预卷漂移 + 中段呼吸，避免间奏冷场（借鉴 上游参考项目 bridge shot 的预卷理念）
        this._updateBridgeDrift(timeMs);
      }

      // 同步更新多句场景内部当前正在唱的子句翻译
      if (activeLineData && activeLineData !== this.lastActiveLineData) {
        this.lastActiveLineData = activeLineData;
        this._updateTranslation(activeLineData.translation, activeLineData.romaji);
      }
    }
  }

  /**
   * ★ bridge-drift：场景间隙（上一景唱毕、下一景未开唱）摄像机预卷漂移
   * - 仅当时间严格落在 cur.end ~ next.start 之间且间隙 ≥400ms 才启用
   * - 沿两场景世界锚点做 smoothstep 缓动插值，中段加 2% 呼吸缩放，衔接下一笔镜头
   */
  _updateBridgeDrift(timeMs, gapThreshold = 400) {
    const n = this.nodes ? this.nodes.length : 0;
    if (n < 2 || this.currentNodeIndex < 0 || this.currentNodeIndex >= n - 1) return;
    const cur = this.nodes[this.currentNodeIndex];
    const next = this.nodes[this.currentNodeIndex + 1];
    if (!cur || !next) return;
    const gapStart = cur.end;
    const gapEnd = next.start;
    if (timeMs < gapStart || timeMs >= gapEnd) return;
    const gapDur = gapEnd - gapStart;
    if (gapDur < gapThreshold) return;

    /* ★ bridge 柔光脉冲（间隙有可见动画，不再"干等"）：
       一个长间隙只在开始时触发一次（--bridge-key 记忆），CSS 做 2.2s 单发柔光呼吸 */
    if (this.viewContainer) {
      const key = cur.end + '_' + next.start;
      if (this._bridgePulseKey !== key) {
        this._bridgePulseKey = key;
        const vc = this.viewContainer;
        vc.classList.remove('pv-bridge-active');
        void vc.offsetWidth;
        vc.classList.add('pv-bridge-active');
      }
    }

    const p = Math.min(1, Math.max(0, (timeMs - gapStart) / gapDur));
    const ease = p * p * (3 - 2 * p);   // smoothstep 缓动
    // 基准缩放沿线性缓动 0→1 过渡到下一景，另加 ≤0.015 的中段呼吸（符合运镜微调上限）
    const baseScale = (cur.pos.scale || 1) + ((next.pos.scale || 1) - (cur.pos.scale || 1)) * ease;
    this.camera.setTarget(
      cur.pos.x + (next.pos.x - cur.pos.x) * ease,
      cur.pos.y + (next.pos.y - cur.pos.y) * ease,
      baseScale + 0.015 * Math.sin(p * Math.PI),
      cur.pos.z + (next.pos.z - cur.pos.z) * ease,
      cur.pos.pitch + (next.pos.pitch - cur.pos.pitch) * ease,
      cur.pos.roll + (next.pos.roll - cur.pos.roll) * ease
    );
  }

  /**
   * 切换活跃海报场景
   * @private
   */
  _updateActiveNode(index) {
    this.currentNodeIndex = index;
    const node = this.nodes[index];
    if (!node) return;

    // 1. 3D 摄像机初始定位于场景坐标（zoom 从 shot 的 zoomStart 起手；
    //    cameraZoom 用户焦距已在字号体系预乘，此处不再放大摄像机 scale）
    this.camera.setTarget(
      node.pos.x, 
      node.pos.y, 
      (node.pos.scale || 1.0) * (node.cam ? node.cam.zoomStart : 1.0), 
      node.pos.z || 0, 
      node.pos.pitch || 0, 
      node.pos.roll || 0
    );

    // 2. 舞台海报装载
    if (this.rendering) {
      this.rendering.transitionToNode(node, this.themeColor);
    }

    // 3. 背景巨型镂空描边字与图形场 — ★ graphicColor 控制装饰色；seed 用歌曲标识，
    //    同曲内图形场布局稳定（不随 shot 重建跳变），换歌才重新洗牌
    if (this.decorations) {
      const songData = (typeof window !== 'undefined' && window.currentSongData) || {};
      const songSeed = songData.songMid || songData.songId || songData.id || songData.song || songData.title || 0;
      this.decorations.renderForNode(node, this.graphicColor || this.themeColor, songSeed);
      // ★ P3：装饰层透明度短暂下沉再恢复，呼应海报切换节奏
      if (this.decorations.layer) {
        const decoLayer = this.decorations.layer;
        decoLayer.classList.remove('pv-deco-swap');
        void decoLayer.offsetWidth; // 强制重流以重启动画
        decoLayer.classList.add('pv-deco-swap');
      }
    }

    // 4. 更新底部首句翻译
    const firstLine = (node.lines && node.lines.length > 0) ? node.lines[0] : node;
    this.lastActiveLineData = firstLine;
    this._updateTranslation(firstLine.translation, firstLine.romaji);
  }

  /**
   * 更新底栏翻译歌词 (完全复用飞入模式原生样式与动效)
   * @private
   */
  _updateTranslation(transText, romaText) {
    const flyinArea = this.translationArea || (typeof document !== 'undefined' ? document.getElementById('flyinTranslationArea') : null);
    if (!flyinArea) return;

    const flyinTrans = flyinArea.querySelector('.flyin-translation-text') || (typeof document !== 'undefined' ? document.getElementById('flyinTranslation') : null);
    const flyinRoma = flyinArea.querySelector('.flyin-romaji-text') || (typeof document !== 'undefined' ? document.getElementById('flyinRomaji') : null);

    const validTrans = (transText && transText.trim() !== '//') ? transText.trim() : '';
    const validRoma = (romaText && romaText.trim() !== '//') ? romaText.trim() : '';

    flyinArea.style.opacity = '0';
    /* ★ 防叠加：快速切歌时多次调用，取消上一次未执行的延迟写入 */
    if (this._transTimer) clearTimeout(this._transTimer);
    this._transTimer = setTimeout(() => {
      this._transTimer = null;
      if (flyinTrans) flyinTrans.textContent = validTrans;
      if (flyinRoma) flyinRoma.textContent = validRoma;
      if (validTrans || validRoma) {
        flyinArea.style.opacity = '1';
      }
    }, 200);
  }

  /**
   * 启动 3D 摄像机与视差平滑补间循环
   */
  start() {
    if (this.translationArea) {
      this.translationArea.style.display = '';
    }
    if (this.isRunning) return;
    this.isRunning = true;

    const renderLoop = (ts) => {
      if (!this.isRunning) return;

      /* ★ diorama 对齐：SmoothDamp 需真实帧间隔（掉帧跟慢、高刷跟快），
         首次帧无上次时间戳时取 1/60 兜底 */
      const dt = (typeof ts === 'number' && this._lastFrameTs != null)
        ? Math.min(Math.max((ts - this._lastFrameTs) / 1000, 0.001), 0.1)
        : 1 / 60;
      this._lastFrameTs = ts;
      this.camera.update(dt);

      // 应用多层视差与 3D 景深透视变换
      if (this.decoLayer) {
        this.decoLayer.style.transform = this.camera.getTransform(0.35);
      }
      if (this.stageLayer) {
        this.stageLayer.style.transform = this.camera.getTransform(1.0);
      }

      this.rafId = requestAnimationFrame(renderLoop);
    };

    this.rafId = requestAnimationFrame(renderLoop);
  }

  /**
   * 暂停
   */
  stop() {
    this.isRunning = false;
    this._lastFrameTs = null;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.translationArea) {
      this.translationArea.style.opacity = '0';
      this.translationArea.style.display = 'none';
    }
  }

  /**
   * ★ 性能分档消费：PV 模式渲染 DPR 降采样、星芒粒子预算、发光(Bloom)开关
   * 由 180-boot-config.applyPerformanceProfile 与 220-shortcuts-viewmode 创建引擎后调用。
   * @param {Object} cfg { pv: { renderDpr, maxParticles, enableBloom }, vfx: { pvBloom, renderScale } }
   */
  setPerformanceConfig(cfg = {}) {
    const pvCfg = cfg.pv || cfg;
    const vfx = cfg.vfx || {};
    this._perfCfg = pvCfg;
    const dpr = parseFloat(pvCfg.renderDpr) || 0;
    const maxParticles = parseInt(pvCfg.maxParticles, 10);
    const bloom = vfx.pvBloom !== undefined ? vfx.pvBloom : pvCfg.enableBloom;

    if (this.background && typeof this.background.setPerf === 'function') {
      const bgCfg = {};
      if (dpr > 0) bgCfg.renderDpr = Math.max(0.5, Math.min(2, dpr));
      if (!isNaN(maxParticles) && maxParticles >= 0) bgCfg.maxParticles = maxParticles;
      this.background.setPerf(bgCfg);
    }
    if (this.viewContainer) {
      this.viewContainer.classList.toggle('pv-no-bloom', bloom === false);
    }
  }

  /**
   * 清空舞台
   */
  clear() {
    if (this.rendering) this.rendering.clear();
    if (this.decorations) this.decorations.clear();
    if (this.translationArea) {
      const transEl = this.translationArea.querySelector('.flyin-translation-text');
      const romaEl = this.translationArea.querySelector('.flyin-romaji-text');
      if (transEl) transEl.textContent = '';
      if (romaEl) romaEl.textContent = '';
      this.translationArea.style.opacity = '0';
      this.translationArea.style.display = 'none';
    }
    this.currentNodeIndex = -1;
    this.lastActiveLineData = null;
    this.lastRawLyrics = null;
    this.lastAiData = null;
  }

  /**
   * 销毁引擎
   */
  destroy() {
    this.stop();
    this.clear();
    if (this.background) this.background.destroy();
    if (this.viewContainer && this.viewContainer.parentNode) {
      this.viewContainer.remove();
    }
    this.viewContainer = null;
  }
}
