/**
 * TunnelEngine.js — 「流光隧道」歌词样式主时间线
 * 依据 PV-技术方案.md 完整落地的程序化文字 PV（与 PV 海报模式分离）：
 *
 * 架构对应文档章节：
 * - 第 2 章 四层架构：CONTENT(TunnelDirector.build) → DIRECTOR(三级层级+参数化)
 *   → WORLD(词块世界坐标) → CAMERA(TunnelCameraTrack 马达混合) → RENDER(DOM+CSS3D+WAAPI)
 * - 第 3 章 连续性三支柱：
 *   A 速度积分（弹簧摄像机，目标只改期望值）
 *   B 时间窗口混合（组间 300ms 轨道衔接 blend）
 *   C 前瞻调度（整组预渲染 + seek 恢复沿轨道跟踪）
 * - 第 17 章 渲染管线：Timeline 主循环 findShotAt → 三级过渡检测 → 摄像机 → 渲染
 * - 第 18 章 三级连贯层级：Shot(行)切换只换词块；Group(句组)共享场景+连续轨道+蒙版扫入；
 *   Section(段落)闪白+深度清理+预设全换
 * - 第 19 章 3D 深度堆叠：演完句组推入 Z 轴背景层（视差/涟漪/拉伸/聚光/景深/粒子）
 * - 第 7/8/9/10/11 章：四维样式合成、ShotParams 参数化、速度自适应、逐字动画库、几何蒙版
 */

import { TunnelDirector } from './TunnelDirector.js';
import { buildMosaicPatterns, applyPalette, MOSAIC_COLOR_SETS } from './mondrianTemplates.js';
import { TunnelCameraController } from './TunnelCameraTrack.js';
import { TunnelDepthStack, TunnelParticle3DLayer } from './TunnelDepthStack.js';
import { playEnterAnimation, playExitAnimation, playMaskTransition, playFlashOverlay, buildDecorationComboSVG } from './TunnelAnimations.js';
import { logCatch } from '../../services/log.js';

export class TunnelEngine {
  constructor(container) {
    this.container = container || null;

    this.director = new TunnelDirector();
    this.cameraCtl = new TunnelCameraController();
    this.cameraCtl.setFrozen(true);

    this.viewContainer = null;
    this.bgLayer = null;
    this.textureLayer = null;
    this.depthLayer = null;
    this.stageLayer = null;
    this.decoLayerEl = null;
    this.particleCanvas = null;
    this.flashOverlay = null;
    this.translationArea = null;
    this.mosaicLayer = null;

    this.sections = [];
    this.currentSectionId = -1;
    this.currentGroupId = -1;
    this.currentShotId = null;
    this.currentGroupEl = null;
    this.currentShotEl = null;
    this.currentGroup = null;
    this.currentShot = null;

    this.chars = [];
    this._wcCacheEl = null;
    this._wcCacheCenter = null;
    this._lastTransLine = null;
    this._lastTransKey = null;
    this._mosaicPatterns = this._generateMosaicPatterns();

    this.themeColor = '#ffcc33';
    this.aiColorSync = true;
    this.isRunning = false;
    this.rafId = null;
    this.settings = {};
    this.lastRawLyrics = null;
    this.lastAiData = null;

    this.mosaicMode = true;
    this.currentAlignment = 'center';
  }

  _generateMosaicPatterns() {
    /* ★ 实现迁移至 mondrianTemplates.js（手工预设布局表，参考实现 tempera 式）：
       每个版面都是设计过的固定几何（直线分割/黄金比例/重心平衡），不再程序化
       随机切割——随机比例是用户反馈「丑」的根源。五族 20 幅：classic×4 /
       colorField×4 / bands×4 / frame×4 / diagonal×4；选取层按 section.type→mood
       分池 + 哈希 + 不与上一段同族（见 _updateMosaicBackground）。 */
    return buildMosaicPatterns((b) => this._normMosaicBlock(b));
  }

  /* ★ 块规范化：默认字段补齐 + 透明度近实心（v2 满屏色板：tempera 色块
     alpha 0.94~0.96——半透明块叠深底是旧版「脏/乱」感来源，已弃） */
  _normMosaicBlock(b) {
    const nb = {
      isGrid: false, isBar: false, invertText: false, gap: 0, rotation: 0,
      gridAngle: 10, gridSpacing: 24, gridLineWidth: 1.5, gridColor: '',
      barAngle: -20, barSpacing: 20, barColor: '', opacity: 0.92,
      ...b,
    };
    nb.opacity = Math.min(0.96, Math.max(0.86, nb.opacity));
    return nb;
  }

  /**
   * ★ 相对亮度判定（Rec.709）：块背景亮度 > 0.5 视为亮块 → 歌词反色深墨。
   * 莫奈色板提亮后白字在 tone1/tone2 亮块上对比度不足，此判定恢复可读性。
   * 支持 6/8 位 hex（8 位时忽略 alpha）与 rgba() 前缀色。
   */
  _isLightColor(color) {
    try {
      let c = String(color || '').trim();
      const m = c.match(/^#([0-9a-fA-F]{6})/);
      if (!m) return false;
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luma > 0.5;
    } catch (e) { return false; }
  }

  /**
   * ★ 将 6 位 / 8 位 hex 颜色与透明度合成 8 位 hex；rgb() / hsl() 原样返回。
   * - 6 位 hex：直接按 opacity 追加 alpha
   * - 8 位 hex：颜色自带的 alpha 与 opacity 相乘后再烘焙（不再原样返回——
   *   ★否则中性块默认色 colors+alpha 会把块的可见度永远钉死在颜色自带的低透明上）
   * 用途：蒙德里安块把「块透明度」烘焙进 background-color，使块元素保持 opacity:1——
   * 否则父块 opacity(0.15~0.65) 会把子层栅格线连带压暗到几乎不可见，表现为「纯色背景无方格」。
   */
  _hexWithAlpha(color, opacity) {
    if (!color || opacity == null) return color;
    const c = String(color).trim();
    const m = c.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
    if (m) {
      const colorAlpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
      const a = Math.round(Math.max(0, Math.min(1, colorAlpha * opacity)) * 255);
      return '#' + m[1] + a.toString(16).padStart(2, '0');
    }
    return c;
  }

  /* ================= 初始化 DOM 分层（19.7 3D 空间结构） ================= */
  init(container) {
    if (container) this.container = container;
    if (!this.container && typeof document !== 'undefined') {
      this.container = document.getElementById('tunnelViewContainer') || document.querySelector('.tunnel-view-container') || document.querySelector('.player-container');
    }
    if (!this.container) return this;

    let view = (this.container.classList && this.container.classList.contains('tunnel-view-container'))
      ? this.container
      : this.container.querySelector('.tunnel-view-container');
    if (!view) {
      view = document.createElement('div');
      view.className = 'tunnel-view-container';
      this.container.appendChild(view);
    }
    this.viewContainer = view;
    this.viewContainer.innerHTML = '';
    this.viewContainer.style.display = 'block';

    /* ★ 重入修复（蒙德里安概率性无背景的根因）：复用实例二次 init（220-shortcuts-viewmode
       切回隧道模式时 L864 无守卫再 init）会在这里 innerHTML='' 丢弃整个图层树，
       而 _mosaicBlockPool/_mosaicBgEl 若不清空会永远指向旧图层的孤儿节点——
       之后所有背景样式都刷在不可见 DOM 上，表现为「有歌词没色块」：
       首次进入模式正常（新实例），退出重进必现。与图层树一起重置全部
       绑定 DOM 的蒙德里安运行时状态；消费点（_renderShot 等）均有哈希兜底，置 null 安全。 */
    this._mosaicBlockPool = null;
    this._mosaicBgEl = null;
    this._mosaicDecoEl = null;
    this._lastMosaicFamily = null;
    this._lastBgCacheKey = null;
    this._currentMosaicPattern = null;
    this._currentMosaicEdges = null;
    this._lastPatternBlocks = null;

    // Layer 0: 底色 + 流光扫射
    this.bgLayer = document.createElement('div');
    this.bgLayer.className = 'tunnel-layer tunnel-layer-bg';
    this.bgLayer.innerHTML = '<div class="tunnel-bg-streaks"></div><div class="tunnel-bg-vignette"></div>';
    this.viewContainer.appendChild(this.bgLayer);

    // Layer 0.5: Mosaic background layer (color blocks/grids/shapes)
    this.mosaicLayer = document.createElement('div');
    this.mosaicLayer.className = 'tunnel-layer tunnel-layer-mosaic';
    this.viewContainer.appendChild(this.mosaicLayer);

    // Layer 1: 组级纹理层（组内共享，纹理类型切换时重建）
    this.textureLayer = document.createElement('div');
    this.textureLayer.className = 'tunnel-layer tunnel-layer-texture';
    this.viewContainer.appendChild(this.textureLayer);

    // Layer 2: ★ 3D 深度堆叠背景层容器（19.7：从远到近叠放）
    this.depthLayer = document.createElement('div');
    this.depthLayer.className = 'tunnel-layer tunnel-layer-depth';
    this.viewContainer.appendChild(this.depthLayer);
    this.depthStack = new TunnelDepthStack(this.depthLayer);

    // Layer 3: 当前演出层（前景组：词块+装饰）
    this.stageLayer = document.createElement('div');
    this.stageLayer.className = 'tunnel-layer tunnel-layer-stage';
    this.viewContainer.appendChild(this.stageLayer);

    // Layer 4: 19.14 3D 粒子画布
    this.particleCanvas = document.createElement('canvas');
    this.particleCanvas.className = 'tunnel-particle-canvas';
    this.viewContainer.appendChild(this.particleCanvas);
    this.particles = new TunnelParticle3DLayer(this.particleCanvas);
    this.particles.init(60);

    // Layer 5: 段落切换白闪（18.8 画面のキレ：柔和白闪非故障）
    this.flashOverlay = document.createElement('div');
    this.flashOverlay.className = 'tunnel-flash-overlay';
    this.viewContainer.appendChild(this.flashOverlay);

    // Layer 6: 底部翻译区（复用飞入样式）
    let transArea = this.viewContainer.querySelector('.tunnel-translation-area');
    if (!transArea) {
      transArea = document.createElement('div');
      transArea.className = 'tunnel-translation-area flyin-translation-area';
      transArea.innerHTML = '<div class="flyin-translation-text"></div><div class="flyin-romaji-text"></div>';
      this.viewContainer.appendChild(transArea);
    }
    this.translationArea = transArea;

    /* ★ 首帧兜底：进入模式即铺出蒙德里安背景色块（默认 pattern），
       不依赖歌词/Shots/AI 分析是否就绪——避免"没等 AI 分析完就进入"时背景全黑无方格。 */
    try {
      if (this._mosaicPatterns && this._mosaicPatterns.length > 0) {
        this._updateMosaicBackground({ sectionId: 0, groupId: 0, params: { alignment: this.currentAlignment || 'center' } });
        this._lastBgCacheKey = null;   // 放行第一句组更新覆盖默认 pattern
      }
    } catch (_e) { logCatch('TunnelEngine', _e); }

    /* ★ 窗口尺寸变化 → 当前分镜按新视口重建（用户反馈：蒙德里安大字叠字，
       不随窗口变化调整字号/换行——字号缩放是入镜时按当时视口算的）。
       防抖 180ms；复用 _buildShotBlocks 重建当前 shot（换行/适配按新尺寸）。 */
    if (typeof window !== 'undefined' && !this._onWinResize) {
      this._onWinResize = () => {
        clearTimeout(this._rszT);
        this._rszT = setTimeout(() => {
          try {
            const shot = this.currentShot;
            if (!shot || !this.currentShotEl) return;
            const sec = (this.director && this.director.sections) ? this.director.sections[shot.sectionId] : null;
            const group = sec ? sec.groups.find(g => g.id === shot.groupId) : null;
            if (!group) return;
            this.currentShotEl.remove();
            this.currentShotEl = null;
            this._buildShotBlocks(shot, group, performance.now());
          } catch (_e) { /* 重建失败保持现状，下一分镜自然按新尺寸排布 */ }
        }, 180);
      };
      window.addEventListener('resize', this._onWinResize);
    }

    return this;
  }

  /* ================= 设置应用 ================= */
  applySettings(s = {}) {
    this.settings = s;
    // ★ 装饰层默认关闭：用户明确不再需要几何/图案装饰，仅在显式开启时恢复
    this.settings.showEcho = (s.showEcho === true);
    // ★ 横平竖直（默认）/ 活泼倾斜（mosaicTilt 开）切换：直排模式禁用一切词块旋转
    this.allowTilt = (s.mosaicTilt === true);
    const vc = this.viewContainer;
    if (vc) {
      if (s.fontSize) vc.style.setProperty('--tunnel-font-size', `${parseFloat(s.fontSize) || 1.0}`);
      if (s.highlightColor) vc.style.setProperty('--tunnel-highlight-color', s.highlightColor);
      if (s.emotionGlow !== undefined) vc.style.setProperty('--tunnel-glow', `${parseFloat(s.emotionGlow) || 12}px`);
      if (s.transitDuration !== undefined) vc.style.setProperty('--tunnel-transit-duration', `${Math.max(150, parseFloat(s.transitDuration) || 450)}ms`);
      if (s.rowGap !== undefined) vc.style.setProperty('--tunnel-row-gap', `${parseFloat(s.rowGap) || 90}px`);
    }
    if (this.cameraCtl) {
      if (s.cameraSpeed !== undefined) this.cameraCtl.setSpeed(parseFloat(s.cameraSpeed) || 1.0);
      if (s.cameraDamping !== undefined) this.cameraCtl.setDamping(parseFloat(s.cameraDamping) || 0.05);
    }
    if (s.themeColor || s.highlightColor) {
      this.themeColor = s.highlightColor || s.themeColor;
      if (vc) vc.style.setProperty('--tunnel-emotion-color', this.themeColor);
    }
    if (s.graphicColor && vc) vc.style.setProperty('--tunnel-graphic-color', s.graphicColor);

    if (this.bgLayer) {
      const streaks = this.bgLayer.querySelector('.tunnel-bg-streaks');
      if (streaks) streaks.style.display = (s.showStreaks !== false) ? '' : 'none';
    }
    if (this.particles) {
      this.particles.setColor(this._particleColor());
    }
    if (s.aiColorSync !== undefined) {
      this.aiColorSync = !!s.aiColorSync;
      if (this.lastRawLyrics) this.setLyrics(this.lastRawLyrics, this.lastAiData);
    }
  }

  /**
   * ★ 性能分档消费：流光隧道粒子预算/DPR/开关 + 装饰降级
   * 由 180-boot-config.applyPerformanceProfile 与 220-shortcuts-viewmode 创建引擎后调用。
   * @param {Object} cfg { tunnel: { particleCount, depthDpr, decorLevel }, vfx: { tunnelParticles, renderScale } }
   */
  setPerfConfig(cfg = {}) {
    const t = cfg.tunnel || {};
    const v = cfg.vfx || {};
    this._perfTunnel = t;
    this._perfVfx = v;
    if (this.particles) {
      const enabled = v.tunnelParticles !== false;
      const count = enabled ? Math.max(0, Math.round(t.particleCount ?? 60)) : 0;
      const dpr = parseFloat(t.depthDpr) || 2;
      this.particles.setPerf({ dpr, count });
      if (this.particleCanvas) {
        this.particleCanvas.style.display = count <= 0 ? 'none' : '';
      }
    }
    if (this.viewContainer) {
      const decorLevel = Math.max(0, Math.min(3, parseInt(t.decorLevel) || 3));
      this.viewContainer.classList.toggle('tunnel-perf-decor-off', decorLevel <= 0);
      this.viewContainer.classList.toggle('tunnel-perf-decor-low', decorLevel <= 1 && decorLevel > 0);
    }
  }

  _particleColor() {
    const g = this.viewContainer && this.viewContainer.style.getPropertyValue('--tunnel-graphic-color');
    if (g && g.trim()) {
      // hex → rgba 前缀
      const hex = g.trim();
      if (/^#[0-9a-f]{6}$/i.test(hex)) {
        const r = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${gg},${b},`;
      }
    }
    return 'rgba(255,255,255,';
  }

  /* ================= 装载歌词（构建三级层级） ================= */
  setLyrics(rawLyrics = [], aiData = {}) {
    this.lastRawLyrics = rawLyrics;
    this.lastAiData = aiData;

    /* ★ RTL 检测（与 VisualizerBase/PVRendering 同款正则）：蒙德里安等隧道子模式
       的词块排布方向随之翻转（tunnel 引擎不在 VisualizerBase 继承链内，单独挂） */
    this.isRtlLyrics = Array.isArray(rawLyrics) && rawLyrics.some(l =>
      /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufbff\ufb50-\ufdff\ufe70-\ufeff]/.test(
        String(l.original || l.text || '')));
    if (this.container && this.container.classList) {
      this.container.classList.toggle('tunnel-is-rtl', !!this.isRtlLyrics);
    }

    if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) {
      this.director.sections = [];
      this.director.shotList = [];
      this.clear();
      return;
    }

    let effectiveAiData = aiData;
    if (!this.aiColorSync && aiData && Array.isArray(aiData.emotion_words)) {
      effectiveAiData = { ...aiData, emotion_words: aiData.emotion_words.map(w => (typeof w === 'string' ? w : { ...w, color: undefined })) };
    }

    const { sections } = this.director.build(rawLyrics, effectiveAiData);
    this.sections = sections;

    // 重置三级运行时状态
    this.currentSectionId = -1;
    this.currentGroupId = -1;
    this.currentShotId = null;
    this.cameraCtl.reset();
    if (this.depthStack) this.depthStack.clear();
    if (this.currentGroupEl && this.currentGroupEl.parentNode) this.currentGroupEl.remove();
    this.currentGroupEl = null;
    this.currentShotEl = null;
    this.currentGroup = null;
    this.currentShot = null;
    this.chars = [];
    this._wcCacheEl = null;
    this._focusBlockEl = null;
    this._wcCacheCenter = null;
    this._lastTransLine = null;
    // ★ 新歌强制重建背景色块：清掉上一个 section/group 的缓存键，避免首屏因键碰撞被
    //    _updateMosaicBackground 提前 return 而漏掉蒙德里安色块（出现“只有歌词没色块”）。
    this._lastBgCacheKey = null;
  }

  /* ================= 逐帧主循环（第 17.1 PVTimeline） ================= */
  update(currentTimeSec = 0) {
    if (!this.director.shotList.length) return;
    const timeMs = currentTimeSec * 1000;
    const now = performance.now();

    // 1. 找到当前 shot（支持 seek）
    const shot = this.director.findShotAt(timeMs);
    if (!shot) return;
    const group = this.director.sections[shot.sectionId]?.groups.find(g => g.id === shot.groupId) || null;
    const section = this.director.sections[shot.sectionId] || null;
    if (!group) return;

    // 2. Level 3 段落切换（18.8：闪白 + 深度清理 + 预设全换）
    if (section && section.id !== this.currentSectionId) {
      const isFirst = this.currentSectionId === -1;
      this.currentSectionId = section.id;
      if (!isFirst) {
        playFlashOverlay(this.flashOverlay, 260);
        if (this.depthStack) this.depthStack.clearAllForSectionTransition();
      }
      this._applySectionTheme(section);
    }

    // 3. Level 2 句组切换（18.8：蒙版扫入 + 旧组推入深度堆叠 + 场景共享重建）
    if (group.id !== this.currentGroupId) {
      const oldGroupEl = this.currentGroupEl;
      const oldGroup = this.currentGroup;
      this.currentGroupId = group.id;
      this.currentGroup = group;

      // ★ 19.2 旧组推入 3D 背景层（不删除，纵深堆叠形成历史感）
      if (oldGroupEl && oldGroup) {
        this.depthStack.pushGroupToBackground(oldGroupEl);
      }
      this._buildGroupLayer(group, shot);
    }

    // 4. Level 1 分镜切换（18.8：镜头不停，只换词块 + 逐字动画 + 装饰同族变体微调）
    if (shot.id !== this.currentShotId) {
      this.currentShotId = shot.id;
      this._buildShotBlocks(shot, group, timeMs);   // ★ 传当前音频时刻，入场动画对齐唱响时刻
      this._updateDecoVariant(shot, group);
      this._applyShotShift(shot); // ★ 分镜感：shot 间背景色相微偏移
    }

    // 5. 摄像机更新（复杂三轴旋转 + ★焦点锁定最新唱响词，第 14/18.6 章）
    //    先算活跃词中心，再喂给摄像机作为弹簧目标
    const charState = this._updateChars(timeMs);
    const activeCenter = charState.activeCenter;
    const camState = this.cameraCtl.update(group, shot, timeMs, now, activeCenter);
    const activeLineData = charState.activeLineData;

    // 7. 深度堆叠更新（19.4 视差 + 19.12 涟漪/拉伸 + 19.16 景深）
    if (this.depthStack) {
      this.depthStack.updateFocus(camState);
      this.depthStack.updateParallax(camState, timeMs / 1000);
      // ★ 聚光灯按时间节流（每 500ms 一次，避免随机概率导致过稀疏）
      if (activeCenter && now - this._lastSpotlightAt > 500) {
        this._lastSpotlightAt = now;
        this.depthStack.spotlight(activeCenter);
      }
    }

    // 8. 3D 粒子（19.14）
    if (this.particles) this.particles.update(camState, timeMs / 1000);

    // 9. 前景变换（摄像机层 transform）
    if (this.stageLayer) this.stageLayer.style.transform = this._stageTransform(camState);

    // 10. 翻译同步
    // ★ 用「内容键」而非对象引用判断：翻译补齐异步到达后，即使同一行对象不变，
    //   只要译文内容有变（例如后端补译刚返回）也会立刻刷新，避免当前行译文空窗
    if (activeLineData) {
      const transKey = activeLineData.id + '|' + (activeLineData.translation || '') + '|' + (activeLineData.romaji || '');
      if (transKey !== this._lastTransKey) {
        this._lastTransKey = transKey;
        this._updateTranslation(activeLineData.translation, activeLineData.romaji);
      }
    }
  }

  _stageTransform(cam) {
    const px = Math.round(-cam.x * 100) / 100;
    const py = Math.round(-cam.y * 100) / 100;
    const pz = Math.round(-cam.z * 10) / 10;
    const s = Math.round(cam.scale * 1000) / 1000;
    // ★ 复杂三轴旋转（rotateX/rotateY/rotateZ），焦点锁定由弹簧目标保证
    const rx = Math.abs(cam.rotX || 0) > 0.05 ? ` rotateX(${Math.round(cam.rotX * 100) / 100}deg)` : '';
    const ry = Math.abs(cam.rotY || 0) > 0.05 ? ` rotateY(${Math.round(cam.rotY * 100) / 100}deg)` : '';
    const rz = Math.abs(cam.rotZ || 0) > 0.02 ? ` rotateZ(${Math.round(cam.rotZ * 100) / 100}deg)` : '';
    return `translate3d(${px}px, ${py}px, ${pz}px)${rx}${ry}${rz} scale(${s})`;
  }

  /* ================= 段落主题（Level 3：预设/色板/纹理全换） =================
   * ★ 深浅背景转变 + 文本反色：
   *   低能段落（intro/outro/verse）→ 深背景 + 白字（亮墨）
   *   高能段落（chorus）→ 段落插入浅色背景幕 → 文本反色为深墨
   *   墨色由 --tunnel-ink 控制，浅幕由 --tunnel-veil 控制，过渡 1.2s 平滑 */
  _applySectionTheme(section) {
    if (!this.viewContainer) return;
    const vc = this.viewContainer;
    const energy = section.energy;
    // 深浅转变：能量决定浅幕强度（0 深底 → 0.85 副歌浅幕）
    const veil = Math.min(0.12 + energy * 0.55, 0.75);
    const ink = veil > 0.45 ? 'rgba(16,12,28,0.92)' : '#ffffff';   // 浅幕时文本反色深墨
    const inkDim = veil > 0.45 ? 'rgba(16,12,28,0.62)' : 'rgba(255,255,255,0.92)';
    vc.style.setProperty('--section-energy', energy.toFixed(2));
    vc.style.setProperty('--tunnel-veil', veil.toFixed(2));
    vc.style.setProperty('--tunnel-ink', ink);
    vc.style.setProperty('--tunnel-ink-dim', inkDim);
    vc.dataset.sectionType = section.type;
  }

  /* ================= 构建句组层（Level 2：场景共享 + 蒙版扫入） ================= */
  _buildGroupLayer(group, firstShot) {
    const vc = this.viewContainer;

    // 组容器（前景演出层）
    const gEl = document.createElement('div');
    gEl.className = 'tunnel-group';
    gEl.dataset.groupId = group.id;

    // 场景共享：组级色板 + 纹理 + 装饰族（18.4 SceneState）
    const scene = group.scene || {};
    gEl.style.setProperty('--group-accent', (scene.palette && scene.palette.accent) || this.themeColor);

    // ★★ 背景多态：按组主题切背景色板/流光/纹理（组间渐变夹杂，不再"一种背景"）
    this._applyGroupBackdrop(group);

    // 装饰层（★ 第 8.3 节：37 种装饰中选 3-5 个交错融合；shot 切换时同组变体微调）
    const deco = document.createElement('div');
    deco.className = 'tunnel-group-deco';
    if (this.settings.showEcho !== false) {
      const variantIdx = firstShot ? firstShot.indexInGroup : 0;
      deco.innerHTML = buildDecorationComboSVG(
        scene.decoCombo || ['brackets'], scene.decorationSeed || 0,
        (scene.palette && scene.palette.accent) || this.themeColor, variantIdx);
    }
    gEl.appendChild(deco);

    // 词块挂载点
    const wordsHost = document.createElement('div');
    wordsHost.className = 'tunnel-group-words';
    gEl.appendChild(wordsHost);

    this.stageLayer.appendChild(gEl);
    this.currentGroupEl = gEl;
    this.currentWordsHost = wordsHost;

    // 组级纹理切换（19.10：组内纹理类型不变；'none' → 纯背景，与带纹理的组夹杂）
    this._applyGroupTexture(scene.textureType || 'halftone', scene.textureParams || {});

    // ★ 确定性渲染背景色块：新建句组时立即更新蒙德里安色块（不依赖 shot 切换时刻的 _applyShotShift），
    //   确保色块与歌词同步出现，避免“只有歌词没色块”的残缺状态。
    try { if (firstShot) this._updateMosaicBackground(firstShot); } catch (_e) { logCatch('TunnelEngine', _e); }

    // ★ 和缓化：组的能量越低 → 过渡时长越长（--tunnel-slow>1）、运动幅度越小（--tunnel-slow-motion<1），顿挫感弱
    if (this.viewContainer) {
      const gen = Math.min((group.energy || 0.5) + 0.22, 1);           // 和缓系数（低能量组 ≈0.27 ~ 高能量 → 1）
      this.viewContainer.style.setProperty('--tunnel-slow', (1 + (1 - gen) * 0.6).toFixed(3));
      this.viewContainer.style.setProperty('--tunnel-slow-motion', Math.max(gen, 0.35).toFixed(3));
    }

    // Level 2 蒙版扫入（18.8：200-400ms clip-path 扫入）
    const maskShape = (firstShot && firstShot.params && firstShot.params.transition && firstShot.params.transition.shape) || 'wipe-left';
    const dur = (firstShot && firstShot.timing && firstShot.timing.transitionDuration) || 260;
    playMaskTransition(gEl, maskShape, Math.max(200, Math.min(400, dur)));
    void vc;
  }

  /* ★★ 背景多态：把组的背景主题色板写到 CSS 变量（bg 层渐变 1.2s 过渡），流光色同步 */
  _applyGroupBackdrop(group) {
    if (!this.viewContainer) return;
    const theme = (group.scene && group.scene.backgroundTheme) || TunnelDirector.BG_THEMES[0];
    const vc = this.viewContainer;
    vc.style.setProperty('--tunnel-bg-a', theme.a);
    vc.style.setProperty('--tunnel-bg-b', theme.b);
    vc.style.setProperty('--tunnel-bg-c', theme.c);
    vc.style.setProperty('--tunnel-bg-glow', theme.glow);
    vc.style.setProperty('--tunnel-bg-streak', theme.streak);
  }

  _applyGroupTexture(type, params = {}) {
    if (!this.textureLayer) return;
    if (!type || type === 'none') {
      // ★ 纯背景（无纹理）：与带纹理的组夹杂，丰富背景层次
      this.textureLayer.className = 'tunnel-layer tunnel-layer-texture';
      this.textureLayer.style.backgroundImage = 'none';
      this.textureLayer.style.opacity = '0';
      return;
    }
    // ★ 降噪：纹理层整体透明度减半（深浅幕才是背景主角）
    this.textureLayer.className = `tunnel-layer tunnel-layer-texture tunnel-texture-${type}`;
    this.textureLayer.style.opacity = String(Math.min((params.opacity ?? 0.35) * 0.5, 0.2));
  }

  /**
   * ★ 分镜感：每个 shot 切入给背景幕加轻微色相偏移（同段落内也有"换镜"的变化感知）
   */
  _applyShotShift(shot) {
    if (!this.viewContainer) return;
    const hue = (((shot.sectionId * 47 + shot.indexInGroup * 31) % 60) - 30) * 0.6;
    this.viewContainer.style.setProperty('--hue-jitter', hue.toFixed(1) + 'deg');
    this._updateMosaicBackground(shot);
  }

  /**
   * ★ 蒙德里安背景装饰（风格派点缀 v5）：PV 式 SVG 图形装饰，不再画黑色横竖线
   * - 用色块自身莫兰迪色 + 强调色绘制 圆环/光斑/菱形/括号弧/同心弧 等几何图形
   * - 图形只落在色块内部、端点贴块边，形成"图形拼色"的蒙德里安装饰感
   * - 全部低透明度（0.1~0.38）低描边，干净不抢歌词；不影响色块布局，每次分镜微变体
   * @private
   */
  _renderMosaicDecoration(pattern, seed) {
    if (!this._mosaicDecoEl) return;
    const blocks = (pattern && Array.isArray(pattern.blocks)) ? pattern.blocks : [];
    const accent = (pattern && pattern.accentColor) || '#ffcc33';
    const baseColor = (pattern && pattern.background) || '#8A9BAF';

    // 伪随机（固定 seed → 同组分镜装饰稳定）
    let s = (seed || 7) >>> 0 || 7;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };

    // 百分比数字保留两位
    const px = (v) => (Math.round(v * 100) / 100).toFixed(2);

    /** v5：全部为几何图形（圆/环/菱形/括号/弧），零 <line> 元素。
        颜色只在 块色(莫兰迪) / 强调色 / 白色 三者中取，低透明度叠加 */
    const shapes = [];

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b) continue;
      if (b.w < 12 || b.h < 10) continue;
      const cx = b.x + b.w * (0.28 + rnd() * 0.44);
      const cy = b.y + b.h * (0.28 + rnd() * 0.44);
      const c = b.color || baseColor;
      const col = rnd() < 0.45 ? accent : c;
      const small = Math.min(b.w, b.h);
      const k = rnd();

      if (k < 0.22) {
        // 圆环（嵌套描边圆）：半径占块高 16%~30%
        const r = small * (0.16 + rnd() * 0.14);
        shapes.push(`<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" fill="none" stroke="${col}" stroke-width="${(0.8 + rnd() * 0.8).toFixed(2)}" opacity="${(0.28 + rnd() * 0.20).toFixed(2)}"/>`);
        if (rnd() < 0.45) {
          shapes.push(`<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r * (0.55 + rnd() * 0.2))}" fill="none" stroke="${col}" stroke-width="0.6" opacity="${(0.22 + rnd() * 0.12).toFixed(2)}"/>`);
        }
      } else if (k < 0.40) {
        // 实心光斑（柔和圆点）
        const r = small * (0.05 + rnd() * 0.09);
        shapes.push(`<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" fill="${col}" opacity="${(0.18 + rnd() * 0.20).toFixed(2)}"/>`);
      } else if (k < 0.58) {
        // 菱形（旋转方形描边）
        const d = small * (0.18 + rnd() * 0.14);
        shapes.push(`<rect x="${px(cx - d / 2)}" y="${px(cy - d / 2)}" width="${px(d)}" height="${px(d)}" fill="none" stroke="${col}" stroke-width="${(0.8 + rnd() * 0.6).toFixed(2)}" opacity="${(0.28 + rnd() * 0.18).toFixed(2)}" transform="rotate(45 ${px(cx)} ${px(cy)})"/>`);
      } else if (k < 0.76) {
        // 括号弧（PV 式 L 形角标）：贴色块角
        const L = small * (0.10 + rnd() * 0.10);
        const corner = Math.floor(rnd() * 4);
        let mx = b.x, my = b.y, dx = 1, dy = 1;
        if (corner === 1) { mx = b.x + b.w; dx = -1; }
        else if (corner === 2) { my = b.y + b.h; dy = -1; }
        else if (corner === 3) { mx = b.x + b.w; my = b.y + b.h; dx = -1; dy = -1; }
        shapes.push(`<path d="M ${px(mx + dx * L)} ${px(my)} L ${px(mx)} ${px(my)} L ${px(mx)} ${px(my + dy * L)}" fill="none" stroke="${col}" stroke-width="${(1.0 + rnd() * 0.6).toFixed(2)}" opacity="${(0.30 + rnd() * 0.18).toFixed(2)}"/>`);
      } else {
        // 同心弧（3/4 圆弧，或带点断的弧）
        const r = small * (0.14 + rnd() * 0.10);
        const dash = rnd() < 0.35 ? ` stroke-dasharray="2 2"` : '';
        shapes.push(`<path d="M ${px(cx - r)} ${px(cy)} A ${px(r)} ${px(r)} 0 1 1 ${px(cx + r * 0.999)} ${px(cy)}" fill="none" stroke="${col}" stroke-width="${(0.8 + rnd() * 0.6).toFixed(2)}"${dash} opacity="${(0.26 + rnd() * 0.18).toFixed(2)}"/>`);
      }
    }

    // 少量大图形点缀（PV 风格白描边，画面不空）
    const bigN = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < bigN; i++) {
      const b = blocks[Math.floor(rnd() * blocks.length)];
      if (!b) continue;
      const cx = b.x + b.w * (0.3 + rnd() * 0.4);
      const cy = b.y + b.h * (0.3 + rnd() * 0.4);
      const r = Math.min(b.w, b.h) * (0.20 + rnd() * 0.15);
      shapes.push(`<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" fill="none" stroke="#ffffff" stroke-width="1" opacity="${(0.18 + rnd() * 0.12).toFixed(2)}"/>`);
    }

    const svg = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" class="t-m-deco-svg">
        ${shapes.join('')}
    </svg>`;

    // 交叉淡入：避免突兀（利用 CSS transition）
    this._mosaicDecoEl.style.opacity = '0';
    const self = this;
    setTimeout(() => {
      if (!self._mosaicDecoEl) return;
      self._mosaicDecoEl.innerHTML = svg;
      // 强制 reflow 使 transition 生效
      void self._mosaicDecoEl.offsetWidth;
      self._mosaicDecoEl.style.opacity = '1';
    }, 120);
  }

  _updateMosaicBackground(shot) {
    if (!this.mosaicLayer) return;
    /* ★ 背景图案按「段落(section)」稳定：同一段内所有句组共用同一幅蒙德里安拼画，
       色块只在换段时经 1.6s CSS 过渡平滑变形 —— 原先按句组(groupId)每几秒换一幅图案，
       方格与色块频繁跳变，看起来「背景方格切换不连贯」。 */
    /* ★★ 背景按「句组」切换（用户反馈：按段落稳定时 6~7 句才换一幅，太懒——
       改为每句组一幅，通常 2~4 句换一次）。块池样式经 1.6s CSS transition
       平滑变形到目标值，不会重现旧按句组重建 innerHTML 时的突兀跳变；
       mood 分池 + family 不重复逻辑不变（相邻句组版式族必不同）。 */
    const cacheKey = `g${shot.groupId != null ? shot.groupId : 's' + shot.sectionId}`;
    if (this._lastBgCacheKey === cacheKey) return; // 同句组不重建，保持已渐变到位的状态

    /* ★★ 版式选取（用户反馈：模板化后要有规律）——与 PV 的 pickShotProfileV2
       同一套思想：段落 type → mood 分池（intro/outro=quiet、verse/bridge=neutral、
       chorus=loud）→ 哈希定起点 → 跳过上一段用过的 family。同一首歌每次重播
       版式序列完全一致，相邻段不重样。 */
    const section = (this.director && this.director.sections) ? this.director.sections[shot.sectionId] : null;
    const secType = (section && section.type) || 'verse';
    const MOOD_BY_TYPE = { intro: 'quiet', verse: 'neutral', chorus: 'loud', bridge: 'neutral', outro: 'quiet' };
    const mood = MOOD_BY_TYPE[secType] || 'neutral';
    const moodPool = this._mosaicPatterns.filter(p => p.mood === mood);
    const usePool = (moodPool.length >= 2) ? moodPool : this._mosaicPatterns;
    /* ★ 版式哈希加 groupId（2026-09-24 用户反馈「背景 6 句才换」）：原先只哈希
       sectionId——同段落内 idx 恒定，色板与版式整段不变。加入 groupId 后每句组
       （1~2 句）都在换，符合 2~4 句切换的预期节奏。 */
    let idx = ((shot.sectionId * 2654435761 + (shot.groupId || 0) * 40503) >>> 0) % usePool.length;
    if (this._lastMosaicFamily && usePool[idx].family === this._lastMosaicFamily && usePool.length > 1) {
      idx = (idx + 1) % usePool.length;
    }
    /* ★ 色板随句组轮换：版式池里色板是启动期绑死的（(i*3)%10），同段落反复命中
       同一幅就是同一套灰暗色。现在按 sectionId*3+groupId 轮换 10 套莫奈色板，
       同段落相邻句组必不同板，整首歌色彩持续流动。 */
    let pattern = usePool[idx];
    try {
      const csIdx = (shot.sectionId * 3 + (shot.groupId || 0)) % MOSAIC_COLOR_SETS.length;
      if (pattern.paletteIdx !== csIdx || true) {
        pattern = applyPalette(pattern, csIdx, (b) => this._normMosaicBlock(b));
      }
    } catch (_e) { /* 换色失败退回原 pattern */ }
    this._lastMosaicFamily = pattern.family;
    /* ★ 当前段选中的幅面存档：歌词贴靠/反色判定（_renderShot）必须用同一幅，
       否则文字贴靠的块与实际背景块对不上 */
    this._currentMosaicPattern = pattern;
    const shotAlignment = (shot && shot.params && shot.params.alignment) || this.currentAlignment || 'center';
    this.currentAlignment = shotAlignment;
    this._currentMosaicEdges = this._computeMosaicEdges(pattern);

    // ★★ 稳定块池：一次性创建固定数量的块，之后每次只更新目标样式（颜色/位置/尺寸/透明度），
    //     由 CSS transition 平滑过渡到目标值 —— 不再重新生成 innerHTML。多余块淡出隐藏。
    const MAX_BLOCKS = 6;
    if (!this._mosaicBlockPool) this._mosaicBlockPool = [];
    while (this._mosaicBlockPool.length < MAX_BLOCKS) {
      const el = document.createElement('div');
      el.className = 't-m-block t-m-rect-mondrian';
      const gridInner = document.createElement('div');
      gridInner.className = 't-m-grid-inner';
      el.appendChild(gridInner);
      this.mosaicLayer.appendChild(el);
      this._mosaicBlockPool.push(el);
    }

    // 背景底层固定一个元素，只切换背景渐变
    if (!this._mosaicBgEl) {
      this._mosaicBgEl = document.createElement('div');
      this._mosaicBgEl.className = 't-m-bg';
      this.mosaicLayer.insertBefore(this._mosaicBgEl, this.mosaicLayer.firstChild);
    }
    this._mosaicBgEl.style.background = pattern.bgGradient || pattern.background;

    // ★★ 蒙德里安装饰层已移除（用户觉得难看），只保留矩形色块拼画，画面干净

    let blocks = pattern.blocks || [];
    /* ★ 渲染期保底（生成期保底外的第二道防线）：块透明度设下限，
       杜绝「整屏块 opacity 过低 → 深色底上整层隐形」的根因。
       ★ 不再强制最大块带栅格：原先每组必有一大块方格网格，视觉上"栅格过多"；
         装饰交给生成期的 pattern 决定，这里只做透明度保底。 */
    if (blocks.length > 0) {
      for (const b of blocks) {
        /* ★ v2 满屏色板：块近实心（保底线 0.86），杜绝任何「半透明飘块」残留 */
        const op = b.opacity != null ? b.opacity : 0.92;
        b.opacity = Math.max(op, 0.86);
      }
    }
    blocks.forEach((b, i) => {
      const el = this._mosaicBlockPool[i];
      const gridInner = el.querySelector('.t-m-grid-inner');
      if (!gridInner) return;
      const opacity = b.opacity != null ? b.opacity : (b.isGrid ? 0.5 : 0.35);
      el.classList.toggle('t-m-invert-text', !!b.invertText);
      el.dataset.invert = b.invertText ? '1' : '0';
      el.style.left = `${b.x.toFixed(3)}%`;
      el.style.top = `${b.y.toFixed(3)}%`;
      el.style.width = `${b.w.toFixed(3)}%`;
      el.style.height = `${b.h.toFixed(3)}%`;
      /* 对角体量族的斜置块：transform 旋转（mosaicLayer overflow hidden 裁掉溢出） */
      el.style.transform = b.rotation ? `rotate(${b.rotation}deg)` : '';
      /* ★ 透明度烘焙进背景色，块保持 opacity:1 —— 栅格子层不再被父 opacity 连带压暗 */
      el.style.backgroundColor = this._hexWithAlpha(b.color, opacity);
      el.style.opacity = '1';
      // ★ 栅格/条形线条渲染：绝大多数色块显示【方格】网格（横+竖交叉线，用户明确要求
      //   方格而非斜纹条纹），少量条线，其余无装饰
      if (b.isGrid) {
        el.classList.add('is-grid-block');
        gridInner.style.opacity = '1';
        const gcolor = b.gridColor || 'rgba(255,255,255,0.5)';
        const gline = (b.gridLineWidth != null ? b.gridLineWidth : 1.5);
        const gsp = (b.gridSpacing != null && b.gridSpacing > 0) ? b.gridSpacing : 22;
        /* ★ 方格 = 两组垂直的 repeating-linear-gradient（0°/90°）交叉，可读的棋格网格 */
        gridInner.style.backgroundImage =
          `repeating-linear-gradient(0deg, ${gcolor} 0 ${gline}px, transparent ${gline}px ${gsp}px), ` +
          `repeating-linear-gradient(90deg, ${gcolor} 0 ${gline}px, transparent ${gline}px ${gsp}px)`;
      } else if (b.isBar) {
        el.classList.remove('is-grid-block');
        gridInner.style.opacity = '1';
        gridInner.style.backgroundImage =
          `repeating-linear-gradient(${b.barAngle}deg, ${b.barColor} 0 2px, transparent 2px ${b.barSpacing}px)`;
      } else {
        el.classList.remove('is-grid-block');
        gridInner.style.opacity = '0';
      }
    });
    // 新 pattern 块数少于池容量：多余块淡出隐藏（保持位置以便平滑回收）
    for (let i = blocks.length; i < MAX_BLOCKS; i++) {
      this._mosaicBlockPool[i].style.opacity = '0';
    }

    this._lastBgCacheKey = cacheKey;
    this.mosaicLayer.style.setProperty('--mosaic-accent', pattern.accentColor);
  }

  /**
   * ★ 分析蒙德里安的矩形，找出左侧和右侧的「主边矩形」位置，
   * 供歌词排版贴靠（左对齐贴左矩形右边线、右对齐贴右矩形左边线）
   * 返回：{ leftEdgePct, rightEdgePct, topEdgePct, bottomEdgePct, textAnchorLeft, textAnchorRight }
   */
  _computeMosaicEdges(pattern) {
    if (!pattern || !pattern.blocks) {
      return { leftEdgePct: 8, rightEdgePct: 92, topEdgePct: 15, bottomEdgePct: 85, centerX: 50, centerY: 50 };
    }

    // 按区域（左/右/上/下四象限）找面积最大的矩形
    let leftLargest = null, rightLargest = null, topLargest = null, bottomLargest = null;
    const blocks = pattern.blocks;

    blocks.forEach(b => {
      const area = b.w * b.h;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      if (bx < 40) {
        if (!leftLargest || area > leftLargest._area) leftLargest = { ...b, _area: area };
      }
      if (bx > 60) {
        if (!rightLargest || area > rightLargest._area) rightLargest = { ...b, _area: area };
      }
      if (by < 40) {
        if (!topLargest || area > topLargest._area) topLargest = { ...b, _area: area };
      }
      if (by > 60) {
        if (!bottomLargest || area > bottomLargest._area) bottomLargest = { ...b, _area: area };
      }
    });

    // 如果某边没有最大矩形，就用默认值
    // 左对齐：文本起始 x = 左侧矩形右边界 + 2% 边距（如果左矩形存在）
    const leftEdgePct = leftLargest
      ? Math.min(leftLargest.x + leftLargest.w + 2, 30)
      : 10;
    // 右对齐：文本结束 x = 右侧矩形左边界 - 2% 边距
    const rightEdgePct = rightLargest
      ? Math.max(rightLargest.x - 2, 70)
      : 90;

    const topEdgePct = topLargest
      ? Math.min(topLargest.y + topLargest.h + 2, 40)
      : 20;
    const bottomEdgePct = bottomLargest
      ? Math.max(bottomLargest.y - 2, 60)
      : 80;

    return {
      leftEdgePct,
      rightEdgePct,
      topEdgePct,
      bottomEdgePct,
      centerX: (leftEdgePct + rightEdgePct) / 2,
      centerY: (topEdgePct + bottomEdgePct) / 2,
      // ★ 传入色块矩形列表，供排版「以色块为对齐依据」做阅读顺序排布
      cells: blocks
    };
  }

  /**
   * ★ 计算整个 section 共用的「稳定锚定 cell」（0~1 百分比坐标）。
   * 以画面中部偏上的视觉重心为锚，锁定一个横向 0.12~0.88、高约 0.38 的排版带，
   * 让本节所有页面（分镜）的歌词都居中锁定在此带内 → 换页不跳变、整体像连续的编辑排版。
   */
  _computeSectionStableCell(edges) {
    const midY = (edges && edges.centerY != null) ? edges.centerY / 100 : 0.5;
    const bh = 0.38;
    // 把带的中心夹在 0.38~0.58，既让歌词有编辑排版的重心感，又避开顶部标题栏与底部控制栏
    const bandCenter = Math.max(0.40, Math.min(0.56, midY));
    let y0 = bandCenter - bh / 2;
    y0 = Math.max(0.20, Math.min(0.46, y0));
    const y1 = y0 + bh;
    return { x0: 0.12, y0, x1: 0.88, y1, w_: 0.76, h_: bh };
  }

  /**
   * ★ 18.12 组内装饰变体微调：shot 切换时同族变体（seed 相同、variantIdx 递进），
   * 装饰风格不跳变，只是数量/角度/大小略变（Level 1 过渡：极轻）
   */
  _updateDecoVariant(shot, group) {
    if (!this.currentGroupEl) return;
    const decoEl = this.currentGroupEl.querySelector('.tunnel-group-deco');
    if (!decoEl || this.settings.showEcho === false) return;
    const scene = (group && group.scene) || {};
    decoEl.innerHTML = buildDecorationComboSVG(
      scene.decoCombo || ['brackets'], scene.decorationSeed || 0,
      (scene.palette && scene.palette.accent) || this.themeColor,
      shot ? shot.indexInGroup : 0);
  }

  /* ================= 构建分镜词块（Level 1） =================
   * ★ 词级独立排版（13.2 节人类 PV 构图）：每个词块绝对定位在画面槽位，
   *   竖排(writing-mode)/横排/斜排(rotate)交织，绝不是"一个句子一整行"。
   * ★ 未唱到的文本完全隐藏（waiting = opacity:0 + visibility:hidden），
   *   只有唱响瞬间才出现——无任何提前预览的未高亮部分。
   * ★ 拆字粒度三档（10.1）：phrase 整词揭示 / word 一下爆出 / char 每字独立轨迹。
   */
  _buildShotBlocks(shot, group, buildTimeMs) {
    if (!this.currentWordsHost) return;

    // ★★★ 分镜位置接力：退出旧 shot 前，记录最后一个词块的中心位置（百分比坐标）
    // 新 shot 的首个词从该位置「接力」飞入，消除分镜切换的跳变感
    let relayAnchorX = null, relayAnchorY = null;
    if (this.currentShotEl) {
      const oldBlocks = this.currentShotEl.querySelectorAll('.tunnel-block');
      if (oldBlocks && oldBlocks.length > 0) {
        // 取最后一个块的位置
        const lastBlock = oldBlocks[oldBlocks.length - 1];
        const lp = parseFloat(lastBlock.style.left) / 100;
        const tp = parseFloat(lastBlock.style.top) / 100;
        if (isFinite(lp) && isFinite(tp)) {
          relayAnchorX = lp;
          relayAnchorY = tp;
        }
      }
    }

    if (this.currentShotEl) {
      const oldEl = this.currentShotEl;
      const exitType = (this.currentShot && this.currentShot.params && this.currentShot.params.exit && this.currentShot.params.exit.type) || 'fade-out';
      const oldChars = oldEl.querySelectorAll('.tunnel-char');
      oldChars.forEach((c, i) => playExitAnimation(c, exitType, i * 18, i, oldChars.length));
      // ★★ 延长退出动画等待时间：与入场重叠 150ms，形成「接力融合」感
      setTimeout(() => { if (oldEl && oldEl.parentNode) oldEl.remove(); }, 520);
    }

    const P = shot.params || {};
    const L = P.layout || {};
    const T = shot.timing || {};
    const gran = shot.granularity || 'char';
    const buildT = (typeof buildTimeMs === 'number' && isFinite(buildTimeMs)) ? buildTimeMs : (shot.start || 0);
    const MAX_DELAY = 700;  // 再收紧：唱起来 0.7s 内必须显示

    const shotEl = document.createElement('div');
    // ★ 整页所有歌词整体居中：蒙德里安模式强制居中排版（用户明确要求）。
    //   原有的 left/right 对齐会令歌词贴边、视觉失衡，这里统一解析为 center。
    const shotAlignment = (shot && shot.params && shot.params.alignment) || this.currentAlignment || 'center';
    const effectiveAlignment = 'center'; // ★ 用户要求：整页所有歌词整体居中
    const lineBreaks = (shot && shot.params && shot.params.lineBreaks) || [];
    shotEl.className = `tunnel-shot tunnel-gran-${gran} tunnel-align-${shotAlignment}`;
    // ★ 横平竖直模式整镜角度归零（活泼模式才用 L.angle 倾斜分镜）
    shotEl.style.setProperty('--shot-angle', `${(this.allowTilt ? (L.angle || 0) : 0).toFixed(1)}deg`);
    shotEl.style.setProperty('--shot-scale', ((Math.max(L.scale || 1, 0.8)) * (shot.__fitScale || 1)).toFixed(3));
    shotEl.style.setProperty('--mosaic-accent-var', this.mosaicLayer ? getComputedStyle(this.mosaicLayer).getPropertyValue('--mosaic-accent') || '#ffcc33' : '#ffcc33');

    this.chars = [];
    const blocks = (shot.line && shot.line.blocks) || [];
    const activeAccent = (group.scene && group.scene.palette && group.scene.palette.accent) || this.themeColor;
    const wordStagger = (P.enter && P.enter.stagger) || 0;

    // ★ AI 分页：计算行分组，用于行内换行排版
    const rowsGroups = this._computeRowsWithBreaks(blocks, lineBreaks);

    // ★ 保存 pattern blocks 供后续查找（必须在 findRectForBlock 之前设置）
    //   ★ 必须复用 _updateMosaicBackground 已选中的同一幅（_currentMosaicPattern）——
    //     背景块与歌词贴靠/反色判定共用一套块数据；无值时才退回哈希兜底。
    if (this._mosaicPatterns && this._mosaicPatterns.length > 0) {
      const pat = this._currentMosaicPattern ||
        this._mosaicPatterns[Math.abs(shot.sectionId * 5 + shot.groupId * 13) % this._mosaicPatterns.length];
      this._lastPatternBlocks = pat.blocks;
    }

    // ★ 计算每个词块所在的矩形区域（用于反色效果）
    const mosaicBlocks = this._lastPatternBlocks || [];
    const findRectForBlock = (xPct, yPct) => {
      if (!mosaicBlocks.length) return null;
      for (const mb of mosaicBlocks) {
        if (xPct >= mb.x && xPct <= mb.x + mb.w &&
            yPct >= mb.y && yPct <= mb.y + mb.h) {
          return mb;
        }
      }
      return null;
    };

    // ★ 以色块为对齐依据的真实排版：Director 阶段用的是占位边缘，
    //   这里在拿到实际「蒙德里安色块」后用真实条带重新排版（左→右、上→下，少则居中）
    {
      let edges = this._currentMosaicEdges;
      if (!edges || !Array.isArray(edges.cells)) {
        const p = this._currentMosaicPattern ||
          this._mosaicPatterns[Math.abs(shot.sectionId * 5 + shot.groupId * 13) % this._mosaicPatterns.length];
        edges = this._computeMosaicEdges(p);
        this._currentMosaicEdges = edges;
      }
      if (edges && Array.isArray(edges.cells)) {
        const compType = (shot.params && shot.params.layout && shot.params.layout.type) || 'band';
        const reSeed = Math.abs((shot.sectionId + 1) * 13 + (shot.groupId + 1) * 29 + (shot.indexInGroup || 0) * 7) || 5;
        // ★ 排版稳定性：同一 section 内所有页面共用一个「锚定安全区 cell」，
        //   换页始终锁定在同一条垂直带内居中（参考图风格：歌词像连续分栏的编辑排版，不撒得到处都是）。
        if (this._stableCellSection !== shot.sectionId) {
          this._stableCellSection = shot.sectionId;
          this._sectionStableCell = this._computeSectionStableCell(edges);
        }
        TunnelDirector.assignWordLayouts(blocks, reSeed, compType, {}, true, effectiveAlignment, edges, {
          // ★ 横平竖直：无旋转 + 按 AI line_breaks 语义断行（分词效果可见）
          straight: !this.allowTilt,
          lineBreaks,
          cell: this._sectionStableCell,
          /* ★ 与 CSS 渲染字号同源：CSS 是 6.4vw × --tunnel-font-size(设置档 fontSize)，
             排版数学必须吃同一个系数，否则布局盒与渲染盒错位（词距虚大/邻词重叠） */
          fontScale: (parseFloat(this.settings && this.settings.fontSize) || 1)
        });
      }
    }

    // ★ 直接使用重排版后的位置（左→右、上→下、以色块为对齐依据）
    const blockFinalPos = blocks.map((b) => {
      const wl = b.__wordLayout || { x: 0.5, y: 0.5 };
      return { fx: wl.x, fy: wl.y };
    });

    // ★ 检查词块所在矩形是否需要反色（使用修正后的位置）
    blocks.forEach((b, bi) => {
      const emphasis = b.__emphasis || { scale: 1, glow: 0.4, effect: 'none' };
      const wl = b.__wordLayout || { x: 0.5, y: 0.5, dir: 'h', angle: 0, relSize: 1 };
      const rowInfo = rowsGroups[bi] || { rowIdx: 0, colIdx: bi, totalCols: blocks.length };

      // ★ 使用 Director 计算的位置（直接坐标，不做重映射）
      const pos = blockFinalPos[bi] || { fx: wl.x, fy: wl.y };
      const finalX = pos.fx;
      const finalY = pos.fy;

      // ★ 检查词块所在矩形是否需要反色
      const rectForText = findRectForBlock(finalX * 100, finalY * 100);
      /* ★ 反色判定 v2（用户反馈：莫奈色板提亮后字体与背景融为一体）：不再只依赖
         模板 invertText 标志（v2 满屏色板模板全为 false → 永不反色），改为按词块
         所落色块的背景色相对亮度自动判定——亮块(Rec.709 亮度>0.5)上用深墨字。 */
      const shouldInvert = !!(rectForText && (rectForText.invertText || this._isLightColor(rectForText.color)));

      // ★ 文字倾斜：每行基准角度 + 微调，限制在 ±5°；
      //   横平竖直模式（allowTilt=false）强制 0°，不多旋转
      let textTilt = 0;
      if (this.allowTilt) {
        const rowBaseTilt = ((rowInfo.rowIdx % 3) - 1) * 2.5;
        const blockJitter = ((bi % 5) - 2) * 0.5;
        const layoutAngle = (wl.angle || 0) * 0.3;
        textTilt = rowBaseTilt + blockJitter + layoutAngle;
        textTilt = Math.max(-5, Math.min(5, textTilt));
      }

      const blockEl = document.createElement('div');
      blockEl.className = 'tunnel-block' +
        (b.isEmotion ? ' tunnel-block-emotion' : '') +
        (wl.dir === 'v' ? ' tunnel-block-v' : ' tunnel-block-h') +
        ' tunnel-block-mosaic-enter' +
        (rowInfo.rowIdx > 0 ? ' tunnel-block-row-' + rowInfo.rowIdx : '') +
        (shouldInvert ? ' tunnel-block-invert' : '');

      blockEl.dataset.start = b.start;
      blockEl.dataset.end = b.end;
      blockEl.dataset.blockIdx = bi;
      blockEl.dataset.totalBlocks = blocks.length;
      blockEl.dataset.rowIdx = rowInfo.rowIdx;
      blockEl.dataset.colIdx = rowInfo.colIdx;
      blockEl.dataset.invert = shouldInvert ? '1' : '0';

      // ★ 反色设置
      if (shouldInvert) {
        blockEl.style.setProperty('--tunnel-ink', '#1e1e2e');
        blockEl.style.setProperty('--tunnel-ink-dim', 'rgba(30,30,46,0.65)');
        blockEl.style.setProperty('--tunnel-ink-invert', '#1e1e2e');
        blockEl.style.setProperty('--tunnel-ink-invert-dim', 'rgba(30,30,46,0.55)');
        blockEl.style.setProperty('--tunnel-char-color', '#2a2a3e');
      }

      // ★ 设置位置
      blockEl.style.left = `${(finalX * 100).toFixed(2)}%`;
      blockEl.style.top = `${(finalY * 100).toFixed(2)}%`;
      blockEl.style.rotate = `${textTilt.toFixed(2)}deg`;
      blockEl.style.setProperty('--text-tilt', `${textTilt.toFixed(2)}deg`);

      // ★ 装饰文字已移除（用户决定去掉底层装饰文字，保持歌词清晰）

      let translateFrom;
      const vw = (typeof window !== 'undefined') ? window.innerWidth : 1280;
      const vh = (typeof window !== 'undefined') ? window.innerHeight : 720;
      if (bi === 0 && relayAnchorX != null && relayAnchorY != null) {
        const dxPct = (finalX - relayAnchorX) * 100;
        const dyPct = (wl.y - relayAnchorY) * 100;
        translateFrom = {
          x: -dxPct * vw / 100,
          y: -dyPct * vh / 100
        };
      } else {
        translateFrom = this._computeTranslateFrom(bi, blocks.length, effectiveAlignment, finalX);
      }
      blockEl.style.setProperty('--t-from-x', `${translateFrom.x}px`);
      blockEl.style.setProperty('--t-from-y', `${translateFrom.y}px`);
      // ★ 入场进一步加速：词块级 stagger 收紧到 12ms（原 24ms），首词不滞后；
      //   消除切页时"先唱响，等 0.5s 再出字"——允许首个词稍早入场。
      const firstDelayBias = (bi === 0 && relayAnchorX != null) ? -40 : 0;
      blockEl.style.setProperty('--t-enter-delay', `${Math.max(0, bi * 12 + firstDelayBias)}ms`);

      // ★ 词块放大上限收紧：避免当前唱词的 scale 把字块撑出布局槽位而与邻词重叠
      // ★ 字号必须与布局槽位一致：布局只按 relSize 预留槽位，而 emphasis 的
      //   功能词 0.72 / 情感词 1.45 缩放若作用于字号，功能词会比槽位小 28%
      //   （留下的大洞=用户看到的"词距虚大"），情感词放大 1.32 倍会压住邻词
      //   （=hero 重叠）。直排模式的强调改由 墨色+辉光 承担（上游参考项目：单腔强调）；
      //   倾斜模式是散点构图、可容忍缩放，保留。
      // ★ 必须乘 __fitScale：布局把整镜按 fitScale 缩小后排位，若渲染字号不跟着缩，
      //   渲染盒会比布局盒大 1/fitScale 倍。scale 围绕词块中心缩放，不动已排定坐标。
      const __ws = this.allowTilt
        ? Math.min(wl.relSize * (emphasis.scale || 1), 1.32)
        : Math.min(wl.relSize, 1.15);
      blockEl.style.setProperty('--word-scale', (__ws * (wl.__fitScale || 1)).toFixed(3));
      blockEl.style.setProperty('--word-glow', (emphasis.glow * (parseFloat(this.viewContainer.style.getPropertyValue('--tunnel-glow')) || 12)).toFixed(1) + 'px');
      blockEl.style.setProperty('--text-tilt', `${textTilt.toFixed(2)}deg`);
      // ★ 情感词独立高饱和暖色：AI 给了独立情感色就用；若退化成主题 accent
      //   （emotionColor 未赋值/等于 accent → 与普通词同色分不清），回退暖粉高饱和色保证一眼可辨
      const emotionCharColor = (b.isEmotion && b.emotionColor && b.emotionColor !== activeAccent)
        ? b.emotionColor
        : '#ff5c7a';
      blockEl.style.setProperty('--tunnel-block-color', b.isEmotion ? emotionCharColor : activeAccent);
      if (b.isEmotion) blockEl.dataset.emotion = '1';

      const wordAt = (typeof b.start === 'number') ? b.start : shot.start;
      // ★ 切页入场加速：收紧上限 ENTER_MAX 到 300ms，唱响 300ms 内必须开始动；
      //   进入时长默认降到 120ms，让字"基本唱出来=已经显示"。
      const ENTER_MAX = 300;
      const wordDelay = Math.min(Math.max(wordAt - buildT, 0), ENTER_MAX);
      const slowFactor = parseFloat(this.viewContainer.style.getPropertyValue('--tunnel-slow')) || 1;

      (b.chars || []).forEach((ch, ci) => {
        const span = document.createElement('span');
        span.className = 'tunnel-char waiting';
        /* ★ 英文空格回填的可视化：空格字符渲染为 &nbsp;（inline 折叠会吞宽），
           并用 word-space 类确保词间留白 */
        if (ch.char === ' ') {
          span.textContent = '\u00A0';
          span.classList.add('tunnel-word-space');
        } else {
          span.textContent = ch.char;
        }
        span.dataset.start = ch.start;
        span.dataset.end = ch.end;
        if (b.isEmotion) {
          // ★ 情感词：非反色块给高饱和情感色 + 发光类；反色（浅底）块保持深墨保证可读
          if (!shouldInvert) {
            span.style.setProperty('--tunnel-char-color', emotionCharColor);
            span.classList.add('tunnel-char-emotion');
          }
        } else {
          // ★★ 非情感字使用当前色系柔和高光（莫兰迪风格），不再与主色全一致导致单调
          //    在 accent 的 hsl 上让亮度 +12%、饱和度 -18%，保持同色系但有层次
          span.style.setProperty('--tunnel-char-color', activeAccent);
          span.classList.add('tunnel-char-nonemotion-morandi');
        }

        if (gran === 'char' && b.__charAnims && b.__charAnims[ci]) {
          const ca = b.__charAnims[ci];
          span.style.setProperty('--char-scale', ca.scaleJitter.toFixed(3));
          span.style.setProperty('--char-rotate', `${(this.allowTilt ? (ca.rotation || 0) : 0)}deg`);
          const charAt = (typeof ch.start === 'number') ? ch.start : wordAt;
          const sungDelay = Math.min(Math.max(charAt - buildT, 0), ENTER_MAX);
          const stagger = Math.min(ca.delay || 0, 12);
          playEnterAnimation(span, ca.type, sungDelay + stagger, (T.enterDuration || 160) * slowFactor, ca.dir);
        } else {
          const wa = b.__wordAnim || { type: 'scale-burst', dir: 0 };
          let wRot = 0;
          if (wl.charRotations && wl.charRotations[ci] != null) {
            wRot = wl.charRotations[ci];
          } else if (this.allowTilt) {
            /* 横平竖直模式不生成随机字符旋转 */
            const rotSeed = (wl.slotIdx || 0) * 31 + ci * 17;
            const wRnd = ((Math.sin(rotSeed + 1) * 10000) % 1 + 1) % 1;
            wRot = (wRnd - 0.5) * 8 * (ci === 0 ? 0.4 : 1);
            wRot = Math.max(-5, Math.min(5, wRot));
          }
          span.style.setProperty('--char-rotate', `${wRot.toFixed(2)}deg`);
          // ★ 字间 stagger 收紧至 10ms/字（上限 40ms），整行迅速显形
          playEnterAnimation(span, wa.type, wordDelay + Math.min(ci * 10, 40), (T.enterDuration || 150) * slowFactor, wa.dir);
        }

        blockEl.appendChild(span);
        const st = (typeof ch.start === 'number' && isFinite(ch.start)) ? ch.start : wordAt;
        const en = (typeof ch.end === 'number' && isFinite(ch.end)) ? ch.end : (st + 160);
        this.chars.push({ el: span, start: st, end: en, block: b, blockEl, lineData: shot.line, shot });
      });

      // ★★ 西文/英文词间空格由排版层 assignWordLayouts 的 wordGap 处理（对称空白），
      //     不再在词块内追加 &nbsp;（绝对定位下会被当成词内字符、使文字偏离中心）

      shotEl.appendChild(blockEl);
    });

    if (shot.line && shot.line.bracketText) {
      const br = document.createElement('div');
      br.className = 'tunnel-bracket-text';
      br.textContent = shot.line.bracketText;
      shotEl.appendChild(br);
    }

    this.currentWordsHost.appendChild(shotEl);
    this.currentShotEl = shotEl;
    this.currentShot = shot;
  }

  _computeTranslateFrom(blockIdx, totalBlocks, alignment, finalX) {
    const vw = (typeof window !== 'undefined') ? window.innerWidth : 1280;
    const vh = (typeof window !== 'undefined') ? window.innerHeight : 720;
    // ★ 入场方向与对齐方式保持一致：
    // 左对齐 → 从左外飞入（与排版位置一致，视觉更连贯）
    // 右对齐 → 从右外飞入
    // 居中  → 从上方飘落
    if (alignment === 'left') {
      // 从左侧矩形方向飞来
      const depth = 0.25 + ((totalBlocks - blockIdx) / totalBlocks) * 0.1;
      return { x: -vw * depth, y: (blockIdx % 2 === 0 ? -16 : 12) };
    } else if (alignment === 'right') {
      const depth = 0.25 + (blockIdx / totalBlocks) * 0.1;
      return { x: vw * depth, y: (blockIdx % 2 === 0 ? -16 : 12) };
    }
    // 居中：从上方飘入
    return { x: (Math.sin(blockIdx * 1.3) * vw * 0.08), y: -vh * (0.14 + blockIdx * 0.015) };
  }

  /**
   * ★ AI 分页辅助：根据 lineBreaks 计算每个词块的行列信息
   * lineBreaks: 词块索引数组，表示在这些索引处开始新行
   * 返回：每个词块的 { rowIdx, colIdx, totalCols }
   */
  _computeRowsWithBreaks(blocks, lineBreaks) {
    const total = blocks.length;
    const result = new Array(total);

    if (!lineBreaks || lineBreaks.length === 0) {
      for (let i = 0; i < total; i++) {
        result[i] = { rowIdx: 0, colIdx: i, totalCols: total };
      }
      return result;
    }

    const sortedBreaks = [...new Set(lineBreaks)].sort((a, b) => a - b);
    const rowStartIndices = [0, ...sortedBreaks.filter(b => b > 0 && b < total)];

    for (let i = 0; i < total; i++) {
      let rowIdx = 0;
      for (let r = rowStartIndices.length - 1; r >= 0; r--) {
        if (i >= rowStartIndices[r]) {
          rowIdx = r;
          break;
        }
      }
      const rowStart = rowStartIndices[rowIdx];
      const rowEnd = (rowIdx + 1 < rowStartIndices.length) ? rowStartIndices[rowIdx + 1] : total;
      result[i] = {
        rowIdx,
        colIdx: i - rowStart,
        totalCols: rowEnd - rowStart
      };
    }

    return result;
  }

  /* ================= 字符三态 + 活跃词中心（渲染管线第 5 步） =================
   * ★ 防抖要点：镜头焦点目标只读【预计算的词块槽位】(__wordLayout)，绝不 getBoundingClientRect——
   *   rect 受摄像机 transform 影响，会形成"镜头动→坐标变→目标变→镜头再动"的反馈振荡。
   *   且只在词块切换时更新目标（同词块内共用同一中心，逐字不抖）。 */
  _updateChars(timeMs) {
    let activeCenter = null;
    let latestActiveCharTime = -1;
    let latestActiveLineData = null;
    let latestPassedLineData = null;

    for (let i = 0; i < this.chars.length; i++) {
      const item = this.chars[i];
      const el = item.el;
      const { start, end } = item;

      if (timeMs >= start && timeMs <= end) {
        if (!el.classList.contains('active')) {
          el.classList.remove('waiting', 'passed', 'sung');
          el.classList.add('active');
        }
        if (start >= latestActiveCharTime) {
          latestActiveCharTime = start;
          // ★ 词块级焦点：仅活跃词块变化时重算目标（纯计算，无 DOM 反馈）
          if (this._focusBlockEl !== item.blockEl) {
            this._focusBlockEl = item.blockEl;
            this._wcCacheCenter = this._blockCenter(item.block);
          }
          activeCenter = this._wcCacheCenter;
          latestActiveLineData = item.lineData;
        }
      } else if (timeMs > end) {
        if (!el.classList.contains('passed')) {
          el.classList.remove('waiting', 'active');
          el.classList.add('passed', 'sung');
        }
        latestPassedLineData = item.lineData;
      } else {
        if (!el.classList.contains('waiting')) {
          el.classList.remove('active', 'passed', 'sung');
          el.classList.add('waiting');
        }
      }
    }

    // 情感词唱响呼吸（7.4 burst 微放大，围绕自身 word-scale 呼吸，不覆盖大小强调）
    for (const item of this.chars) {
      const b = item.block;
      if (!b || !b.isEmotion || !item.blockEl) continue;
      const el = item.blockEl;
      if (timeMs >= b.start && timeMs <= b.end && b.end > b.start) {
        const p = Math.min(Math.max((timeMs - b.start) / (b.end - b.start), 0), 1);
        const base = parseFloat(el.style.getPropertyValue('--word-scale')) || 1;
        el.style.scale = (base * (1 + Math.sin(p * Math.PI) * 0.08)).toFixed(3);
      } else if (el.style.scale) {
        el.style.scale = '';
      }
    }

    if (!latestActiveLineData) {
      latestActiveLineData = latestPassedLineData || (this.currentShot ? this.currentShot.line : null);
    }
    return { activeCenter, activeLineData: latestActiveLineData };
  }

  /**
   * ★ 词块中心：从预计算槽位(__wordLayout.x/y 百分比)换算世界坐标，
   * 完全不读 DOM rect —— 杜绝摄像机 transform 反馈振荡（抖动根因）
   * @private
   */
  _blockCenter(block) {
    const wl = block && block.__wordLayout;
    if (!wl || !this.viewContainer) return null;
    try {
      const vw = this.viewContainer.clientWidth || window.innerWidth || 1280;
      const vh = this.viewContainer.clientHeight || window.innerHeight || 720;
      const wx = Math.round((wl.x - 0.5) * vw);
      const wy = Math.round((wl.y - 0.5) * vh);
      return { x: wx, y: wy, worldX: wx, worldY: wy };
    } catch (e) { return null; }
  }

  /* ================= 翻译同步 ================= */
  _updateTranslation(transText, romaText) {
    const area = this.translationArea || (typeof document !== 'undefined' ? document.getElementById('flyinTranslationArea') : null);
    if (!area) return;
    const tEl = area.querySelector('.flyin-translation-text');
    const rEl = area.querySelector('.flyin-romaji-text');
    const validTrans = (transText && transText.trim() !== '//') ? transText.trim() : '';
    const validRoma = (romaText && romaText.trim() !== '//') ? romaText.trim() : '';
    area.style.opacity = '0';
    setTimeout(() => {
      if (tEl) tEl.textContent = validTrans;
      if (rEl) rEl.textContent = validRoma;
      if (validTrans || validRoma) {
        /* ★ .flyin-translation-area 基类 display:none 会覆盖 display:''，
           必须显式用 display:'block'（内联优先于样式表）才能显示翻译 */
        area.style.display = 'block';
        area.style.opacity = '1';
      }
      /* ★ 兜底：若外部可见的是全局 fly-in 翻译区（视图切换瞬间），同步写入，
         避免蒙德里安切换后翻译区仍空 */
      if (typeof document !== 'undefined') {
        const gArea = document.getElementById('flyinTranslationArea');
        if (gArea && gArea !== area) {
          const gt = gArea.querySelector('.flyin-translation-text');
          const gr = gArea.querySelector('.flyin-romaji-text');
          if (gt) gt.textContent = validTrans;
          if (gr) gr.textContent = validRoma;
        }
      }
    }, 200);
  }

  /* ================= 启动渲染循环 ================= */
  start() {
    if (this.translationArea) this.translationArea.style.display = 'block';
    if (this.isRunning) return;
    this.isRunning = true;
    if (this.particles) {
      this.particles.setColor(this._particleColor());
      this.particles.resize();
    }

    // ★ 原为空转 rAF 循环（循环体无逐帧逻辑，深度堆叠/粒子/运镜均由 audio timeupdate → update() 驱动），
    //   已删除以省掉每帧占用的 rAF 调度；stop() 里 cancelAnimationFrame(rafId=null) 无副作用。
  }

  handleResize() {
    if (this.particles) this.particles.resize();
  }

  stop() {
    this.isRunning = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.translationArea) {
      this.translationArea.style.opacity = '0';
      this.translationArea.style.display = 'none';
    }
  }

  clear() {
    if (this.stageLayer) this.stageLayer.innerHTML = '';
    if (this.depthStack) this.depthStack.clear();
    if (this.textureLayer) this.textureLayer.innerHTML = '';
    if (this.particles) this.particles.clear();
    if (this.translationArea) {
      const t = this.translationArea.querySelector('.flyin-translation-text');
      const r = this.translationArea.querySelector('.flyin-romaji-text');
      if (t) t.textContent = '';
      if (r) r.textContent = '';
      this.translationArea.style.opacity = '0';
      this.translationArea.style.display = 'none';
    }
    this.chars = [];
    this.currentGroupEl = null;
    this.currentShotEl = null;
    this.currentGroup = null;
    this.currentShot = null;
    this.currentGroupId = -1;
    this.currentSectionId = -1;
    this.currentShotId = null;
    this._focusBlockEl = null;
    this._wcCacheCenter = null;
    this._wcCacheEl = null;
    this._lastSpotlightAt = 0;
    this.lastRawLyrics = null;
    this.lastAiData = null;
  }

  destroy() {
    this.stop();
    this.clear();
    if (this.viewContainer && this.viewContainer.parentNode) this.viewContainer.remove();
    this.viewContainer = null;
  }
}
