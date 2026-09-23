/**
 * PVBackground.js
 * 3D 深色丝绸流体波浪背景系统 (Deep Obsidian Silk & Satin Waves Shader)
 * 完美还原原版日系 PV：深邃暗夜黑晶背景、3D 丝绸绸缎立体流动折痕、50px 科技蓝图网格与繁星微光
 */

/* ★ 全屏 Canvas 像素预算：限制 w*dpr × h*dpr ≤ MAX_PX，
   高 DPI 屏幕自动下调 DPR，避免单帧物理像素爆炸拖垮独显/核显 */
const MAX_CANVAS_PX = 5500000;
function budgetCanvasDpr(w, h, requestedDpr) {
  if (!w || !h) return Math.max(1, Math.min(2, requestedDpr || 1));
  let dpr = Math.max(1, Math.min(2, requestedDpr || 1));
  const px = w * h * dpr * dpr;
  if (px <= MAX_CANVAS_PX) return dpr;
  return Math.max(1, Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / (w * h))));
}

export class PVBackground {
  constructor(bgLayer, hudLayer) {
    this.bgLayer = bgLayer || null;
    this.hudLayer = hudLayer || null;
    this.container = bgLayer || null;
    this.canvas = null;
    this.ctx = null;
    this.gridEl = null;
    this.particleContainer = null;
    this.hudEl = null;
    this.particles = [];
    this.particleCount = 28;
    /* ★ 上游参考项目 形状场（FumeBackground 对齐）：替代单字符 ✦✧ 闪烁层，
       由 canvas 在 silk 渲染循环里混排 spark/ring/dia/cross/dot 形状 */
    this.fieldShapes = [];
    this._fieldSeedKey = 0;
    this.animId = null;
    this._silkTimer = null;   /* minimal 模式的降频定时器（与 rAF id 分开存，destroy 需分别清理） */
    this.time = 0;
    /* ★ 性能分档：0 = 跟随body perf class 自动；非0 = 强制此档（0.5~2） */
    this._renderDpr = 0;
    this._particleBudget = 0;
    // 深色暗夜丝绸基底配色
    this.primaryColor = { r: 52, g: 22, b: 84 };   // 深邃暗夜紫蓝
    this.secondaryColor = { r: 72, g: 18, b: 58 }; // 深酒红玫瑰
    this.accentColor = { r: 18, g: 36, b: 82 };    // 深海靛蓝
  }

  init(bgLayer, hudLayer) {
    if (bgLayer) this.bgLayer = bgLayer;
    if (hudLayer) this.hudLayer = hudLayer;
    this.container = this.bgLayer || this.container;
    if (!this.container && typeof document !== 'undefined') {
      this.container = document.querySelector('.pv-layer-bg') || document.querySelector('.pv-view-container');
    }
    if (!this.container) return;

    this.container.innerHTML = '';

    // 1. 创建 3D 丝绸波浪渲染 Canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pv-silk-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      pointer-events: none;
    `;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // 2. 科技蓝图经纬网格层 (50px 细方格 + 水平微光基准轴)
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'pv-blueprint-grid';
    this.container.appendChild(this.gridEl);

    // 3. 星芒粒子容器
    const particleParent = this.hudLayer || this.container;
    this.particleContainer = document.createElement('div');
    this.particleContainer.className = 'pv-particle-layer';
    particleParent.appendChild(this.particleContainer);
    this._initParticles();

    // 4. 四角科技 HUD 标尺
    const hudParent = this.hudLayer || this.container;
    this.hudEl = document.createElement('div');
    this.hudEl.className = 'pv-hud-overlay';
    this.hudEl.innerHTML = `
      <div class="pv-hud-corner tl">⌜ <span class="pv-hud-sub">SYS.PV // KINETIC</span></div>
      <div class="pv-hud-corner tr"><span class="pv-hud-sub">AUDIO.SYNC</span> ⌝</div>
      <div class="pv-hud-corner bl">⌞ <span class="pv-hud-sub">60 FPS // GPU</span></div>
      <div class="pv-hud-corner br"><span class="pv-hud-sub">TYPOGRAPHY</span> ⌟</div>
      <div class="pv-hud-crosshair"></div>
      <div class="pv-hud-axis-h"></div>
    `;
    hudParent.appendChild(this.hudEl);

    // ★ 上游参考项目 FluidBackground 移植：封面缩图模糊层(最底) + 主题渐变叠层(盖 silk)
    this._buildFluidLayers();

    this._handleResize();
    window.addEventListener('resize', this._onResize = () => this._handleResize());
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      this.resizeObserver = new ResizeObserver(() => this._handleResize());
      this.resizeObserver.observe(this.container);
    }

    // 启动 3D 丝绸波浪渲染循环
    this._startSilkLoop();
  }

  _handleResize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    let cw = rect.width;
    let ch = rect.height;
    if (!cw || !ch) {
      const parent = this.container.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        cw = pr.width;
        ch = pr.height;
      }
    }
    this.width = cw || window.innerWidth || 1280;
    this.height = ch || window.innerHeight || 720;
    /* ★ 渲染 DPR：配置档位 × 像素预算钳制。
       全屏 Canvas 若按 DPR2 绘制，2K/4K 屏物理像素可达 14M+/帧，
       独显也会被拖垮 → 按 MAX_PX 自动下调分辨率 */
    const requested = this._renderDpr || Math.min(window.devicePixelRatio || 1, 2);
    const dpr = budgetCanvasDpr(this.width, this.height, requested);
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    if (this.ctx) {
      this.ctx.scale(dpr, dpr);
    }
  }

  /**
   * 3D 深色丝绸波浪与柔光折痕渲染循环 (支持低配模式节流与极简静态渲染)
   */
  _startSilkLoop() {
    let frameCount = 0;
    const render = () => {
      const isMinimal = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-minimal');
      const isLow = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-low');

      if (isMinimal) {
        // 极简模式：只画一次静态背景，停止高频 rAF 重绘，彻底释放 GPU 占用
        this._renderSilkFrame(true);
        if (this._silkTimer) clearTimeout(this._silkTimer);
        this._silkTimer = setTimeout(() => {
          this._silkTimer = null;
          this.animId = requestAnimationFrame(render);
        }, 1000);
        return;
      }

      frameCount++;
      if (isLow && frameCount % 2 !== 0) {
        // 低性能模式：隔帧渲染 (30fps)，减半计算量
        this.animId = requestAnimationFrame(render);
        return;
      }

      this.time += (isLow ? 0.012 : 0.008);
      this._renderSilkFrame(false);
      this.animId = requestAnimationFrame(render);
    };
    this.animId = requestAnimationFrame(render);
  }

  _renderSilkFrame(staticOnly = false) {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const t = this.time;

    // 清空画布
    ctx.clearRect(0, 0, w, h);

    // 1. 基底底色 (深邃黑曜石暗夜黑晶渐变，确保前景文字对比度拉满)
    const baseGrad = ctx.createLinearGradient(0, 0, w, h);
    baseGrad.addColorStop(0, '#06040a');
    baseGrad.addColorStop(0.5, '#0e0818');
    baseGrad.addColorStop(1, '#050308');
    ctx.fillStyle = baseGrad;
    ctx.fillRect(0, 0, w, h);

    if (staticOnly) return;

    // 2. 绘制 3D 深色丝绸绸缎流动折痕 (3 层多重 S 型曲面与法线微光)
    const p = this.primaryColor;
    const s = this.secondaryColor;
    const a = this.accentColor;

    // Layer 1: 远景深邃丝绸漫射色晕 (Deep Satin Ambient)
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.65;
    const grad1 = ctx.createRadialGradient(
      w * (0.65 + Math.sin(t * 0.4) * 0.15),
      h * (0.35 + Math.cos(t * 0.35) * 0.12),
      w * 0.08,
      w * 0.5,
      h * 0.5,
      w * 0.75
    );
    grad1.addColorStop(0, `rgb(${p.r}, ${p.g}, ${p.b})`);
    grad1.addColorStop(0.5, `rgb(${s.r}, ${s.g}, ${s.b})`);
    grad1.addColorStop(0.8, `rgb(${a.r}, ${a.g}, ${a.b})`);
    grad1.addColorStop(1, 'rgba(5, 3, 8, 0)');
    ctx.fillStyle = grad1;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Layer 2: 主 S 型流体丝绸缎带 (3D Silk Ribbon Waves & Folds)
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.58;

    const ribbonStart = -100;
    const ribbonEnd = w + 100;
    const step = 40;

    // 动态计算丝绸脊线 (Silk Ridge Spine)
    const pointsTop = [];
    const pointsBot = [];

    for (let x = ribbonStart; x <= ribbonEnd; x += step) {
      const normX = x / w;
      // 复合正弦波模拟丝绸在深海/真空中飘逸卷曲
      const wave1 = Math.sin(normX * 3.2 + t * 0.7) * (h * 0.18);
      const wave2 = Math.cos(normX * 1.8 - t * 0.5) * (h * 0.12);
      const wave3 = Math.sin(normX * 5.0 + t * 1.1) * (h * 0.04);

      const centerY = h * 0.45 + wave1 + wave2 + wave3;
      const thickness = (h * 0.34) + Math.sin(normX * 2.5 + t * 0.6) * (h * 0.08);

      pointsTop.push({ x, y: centerY - thickness * 0.5 });
      pointsBot.push({ x, y: centerY + thickness * 0.5 });
    }

    const silkGrad = ctx.createLinearGradient(0, 0, w, h);
    silkGrad.addColorStop(0, `rgba(${p.r + 20}, ${p.g + 10}, ${p.b + 30}, 0.8)`);
    silkGrad.addColorStop(0.35, 'rgba(150, 185, 255, 0.45)'); // 丝绸漫反射柔光脊线
    silkGrad.addColorStop(0.7, `rgba(${s.r + 20}, ${s.g + 10}, ${s.b + 20}, 0.75)`);
    silkGrad.addColorStop(1, `rgba(${a.r + 15}, ${a.g + 15}, ${a.b + 30}, 0.3)`);

    const isMinimal = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-minimal');
    const isLow = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-low');

    /* ★★ 性能优化：原实现对全屏画布每帧执行 ctx.filter='blur(28px)'，
       高分屏单帧就是几百万像素高斯模糊，独显也会被拖垮。
       改为「1/4 低清离屏缓存预模糊 + drawImage 上采样」：小图模糊开销仅为
       原方案几十分之一，观感几乎一致（柔光本就是虚化背景光）。 */
    if (!this._silkCache) this._silkCache = document.createElement('canvas');
    const cache = this._silkCache;
    const cw = Math.max(96, Math.round(w * 0.25));
    const ch = Math.max(96, Math.round(h * 0.25));
    if (cache.width !== cw) {
      cache.width = cw;
      cache.height = ch;
    }
    const cctx = cache.getContext('2d');
    cctx.clearRect(0, 0, cw, ch);
    cctx.save();
    cctx.scale(cw / w, ch / h); /* 保持世界坐标不变，画在小画布上自动裁剪 */

    cctx.beginPath();
    cctx.moveTo(pointsTop[0].x, pointsTop[0].y);
    for (let i = 1; i < pointsTop.length; i++) {
      const xc = (pointsTop[i].x + pointsTop[i - 1].x) / 2;
      const yc = (pointsTop[i].y + pointsTop[i - 1].y) / 2;
      cctx.quadraticCurveTo(pointsTop[i - 1].x, pointsTop[i - 1].y, xc, yc);
    }
    const lastTop = pointsTop[pointsTop.length - 1];
    cctx.lineTo(lastTop.x, lastTop.y);
    const lastBot = pointsBot[pointsBot.length - 1];
    cctx.lineTo(lastBot.x, lastBot.y);
    for (let i = pointsBot.length - 2; i >= 0; i--) {
      const xc = (pointsBot[i].x + pointsBot[i + 1].x) / 2;
      const yc = (pointsBot[i].y + pointsBot[i + 1].y) / 2;
      cctx.quadraticCurveTo(pointsBot[i + 1].x, pointsBot[i + 1].y, xc, yc);
    }
    cctx.closePath();
    cctx.fillStyle = silkGrad;
    /* ★ 低配与极简模式下完全消除 Canvas 2D 实时滤镜（blur），利用 1/4 离屏缓存上采样天然平滑 */
    cctx.filter = (isLow || isMinimal) ? 'none' : 'blur(10px)';
    cctx.fill();
    cctx.restore();

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cache, 0, 0, w, h);
    ctx.restore();

    // Layer 3: 丝绸表面微表面菲涅尔高光带 (Specular Satin Sheen)
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = isLow ? 0.2 : 0.35;
    const sheenGrad = ctx.createRadialGradient(
      w * (0.4 + Math.cos(t * 0.5) * 0.2),
      h * (0.5 + Math.sin(t * 0.6) * 0.15),
      20,
      w * 0.45,
      h * 0.5,
      w * 0.45
    );
    sheenGrad.addColorStop(0, 'rgba(180, 210, 255, 0.55)');
    sheenGrad.addColorStop(0.4, 'rgba(140, 170, 240, 0.25)');
    sheenGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = sheenGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Layer 4: 上游参考项目 形状场微粒（替代旧 ✦✧ span 闪烁层；尊重「星芒微粒」开关，
    //           low 档由 _drawShapeField 内部削减辉光，minimal 档 display:none 不进入）
    const fieldOn = this.particleContainer && this.particleContainer.style.display !== 'none';
    if (fieldOn && !isMinimal) {
      this._drawShapeField(ctx, w, h, t);
    }
  }

  _initParticles() {
    if (!this.particleContainer) return;
    this.particleContainer.innerHTML = '';
    this.particles = [];
    /* ★ 形状场改由 silk canvas 每帧绘制（惰性重建：渲染帧拿到有效宽高后才会生成，
       因此这里只清空并换种子——每首歌/主题变化都会得到一套新布局，不再千篇一律） */
    this.fieldShapes = [];

    const isMinimal = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-minimal');
    if (isMinimal || this._particleBudget === 0) {
      this.particleContainer.style.display = 'none';
      return;
    }
    this.particleContainer.style.display = 'block';
  }

  /* ★ 上游参考项目 FumeBackground 对齐：用确定性 LCG 种子生成形状场布局（位置归一化、
     窗口缩放自适应），kinds 混排避免同构。重构/换歌时重新置种，布景随之刷新。 */
  _buildShapeField() {
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;
    this.fieldShapes = [];
    const isLow = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-low');
    this._fieldSeedKey = 97 + (Date.now() % 100000);
    let s = (this._fieldSeedKey >>> 0) || 97;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const kinds = ['spark', 'ring', 'dia', 'dot', 'ring', 'spark', 'dot', 'cross'];
    const count = isLow ? 8 : 16;
    for (let i = 0; i < count; i++) {
      const tone = rnd();
      this.fieldShapes.push({
        kind: kinds[i % kinds.length],
        nx: rnd(),                       /* 归一化坐标（渲染时乘宽高，随窗口自适应） */
        ny: rnd(),
        size: 0.5 + rnd() * 1.1,         /* 基准大小倍率 */
        rot: rnd() * Math.PI * 2,        /* 初始朝向 */
        rotSpeed: (rnd() - 0.5) * 0.9,   /* 慢速自旋 rad/s（上游参考项目 慢转思路） */
        phase: rnd() * Math.PI * 2,      /* 漂浮/闪烁相位错开 */
        drift: 4 + rnd() * 10,           /* 漂浮幅度 px */
        depth: rnd(),                    /* 景深：决定闪烁快慢与辉光 */
        opacity: kinds[i % kinds.length] === 'spark'
          ? 0.10 + rnd() * 0.12
          : 0.035 + rnd() * 0.11,
        stroke: 0.7 + rnd() * 1.4,
        glow: kinds[i % kinds.length] === 'spark'
          ? 14 + rnd() * 14
          : kinds[i % kinds.length] === 'ring' ? 8 + rnd() * 8 : 4 + rnd() * 6,
        tone: tone < 0.5 ? 'secondary' : (tone < 0.85 ? 'accent' : 'white')
      });
    }
  }

  /* 归一化 0~1 钳制（内部工具） */
  _clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* 主题色 → css 颜色串（兼容 {r,g,b} 与 '#hex' 两种形态） */
  _rgbStr(c) {
    if (!c) return 'rgb(150, 170, 255)';
    if (typeof c === 'string') {
      const rgb = PVBackground._hexToRgb(c);
      return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : c;
    }
    return `rgb(${c.r | 0}, ${c.g | 0}, ${c.b | 0})`;
  }

  /* 形状场取色：secondary → accent → 白尘三档（两者间向白混色提亮，上游参考项目 双色体系） */
  _fieldColor(tone) {
    const mixToWhite = (a, k) => {
      const rgb = (typeof a === 'string') ? PVBackground._hexToRgb(a) : a;
      if (!rgb || typeof rgb.r !== 'number') return 'rgba(235, 240, 255, 0.9)';
      return `rgb(${Math.round(rgb.r + (235 - rgb.r) * k)}, ${Math.round(rgb.g + (240 - rgb.g) * k)}, ${Math.round(rgb.b + (255 - rgb.b) * k)})`;
    };
    if (tone === 'white') return 'rgba(235, 240, 255, 0.92)';
    if (tone === 'accent') return mixToWhite(this.accentColor, 0.22);
    return mixToWhite(this.secondaryColor, 0.1);
  }

  /* ★ 上游参考项目 形状场绘制：spark 四芒星 / ring 缺口环 / cross 十字 / dia 菱形 / dot 尘点，
     每帧自旋 + 漂浮 + 景深闪烁；尊重「星芒微粒」开关与 low/minimal 档降级 */
  _drawShapeField(ctx, w, h, t) {
    if (!this.fieldShapes.length) this._buildShapeField();
    if (!this.fieldShapes.length) return;
    const isLow = typeof document !== 'undefined' && document.body && document.body.classList.contains('perf-low');
    const minDim = Math.min(w, h);
    for (const sh of this.fieldShapes) {
      const px = sh.nx * w + Math.sin(t * 0.42 + sh.phase) * sh.drift;
      const py = sh.ny * h + Math.cos(t * 0.34 + sh.phase * 1.7) * sh.drift;
      const rot = sh.rot + t * sh.rotSpeed;
      const flicker = 0.72 + 0.28 * Math.sin(t * (0.9 + sh.depth * 1.4) + sh.phase);
      const alpha = this._clamp01(sh.opacity * flicker * 1.4);
      const base = Math.max(6, minDim * (0.014 + 0.02 * sh.size));
      const color = this._fieldColor(sh.tone);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = sh.stroke;
      ctx.shadowColor = color;
      ctx.shadowBlur = isLow ? 2 : sh.glow;
      switch (sh.kind) {
        case 'spark': { /* 四芒星（FumeBackground spark 路径） */
          const o = base * 0.5;
          const inn = base * 0.13;
          ctx.beginPath();
          ctx.moveTo(0, -o); ctx.lineTo(inn, -inn); ctx.lineTo(o, 0);
          ctx.lineTo(inn, inn); ctx.lineTo(0, o); ctx.lineTo(-inn, inn);
          ctx.lineTo(-o, 0); ctx.lineTo(-inn, -inn); ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.35;
          ctx.beginPath(); ctx.arc(0, 0, Math.max(1, base * 0.08), 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'ring': { /* 带缺口圆环（上游参考项目 ring gap 慢转） */
          const r = base * 0.5;
          const gap = Math.PI * (0.18 + sh.depth * 0.2);
          ctx.beginPath();
          ctx.arc(0, 0, r, gap + Math.PI * 0.12, Math.PI * 2 - gap * 0.4);
          ctx.lineWidth = sh.stroke * 1.25;
          ctx.stroke();
          break;
        }
        case 'cross': { /* 十字 */
          const arm = base * 0.34;
          ctx.beginPath();
          ctx.moveTo(0, -arm); ctx.lineTo(0, arm);
          ctx.moveTo(-arm, 0); ctx.lineTo(arm, 0);
          ctx.stroke();
          break;
        }
        case 'dia': { /* 菱形 */
          const o = base * 0.42;
          ctx.beginPath();
          ctx.moveTo(0, -o); ctx.lineTo(o, 0); ctx.lineTo(0, o); ctx.lineTo(-o, 0); ctx.closePath();
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha * 0.8;
          ctx.fill();
          break;
        }
        default: { /* dot 尘点 */
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(1, base * 0.09), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /**
   * ★ 性能分档消费：渲染 DPR 降采样 + 星芒粒子预算
   * @param {Object} cfg { renderDpr: 0.5~2, maxParticles: 0=关闭 | N=数量 }
   */
  setPerf(cfg = {}) {
    if (typeof cfg.renderDpr === 'number' && cfg.renderDpr > 0) {
      this._renderDpr = Math.max(0.5, Math.min(2, cfg.renderDpr));
      this._handleResize();
    }
    if (typeof cfg.maxParticles === 'number' && cfg.maxParticles >= 0) {
      this._particleBudget = Math.floor(cfg.maxParticles);
      this._initParticles();
    }
  }

  updateTheme(primary, secondary, accent) {
    if (primary && primary.r !== undefined) {
      this.primaryColor = primary;
    }
    if (secondary && secondary.r !== undefined) {
      this.secondaryColor = secondary;
    }
    if (accent && accent.r !== undefined) {
      this.accentColor = accent;
    }
    if (this.themeOverlay) this._applyOverlayGradient();
  }

  /* ★ 参考实现 tempera duo 调色板对齐：把「主题强调色」注入背景绸缎。
     不直接替换深色基底，而是把主题色按不同强度（25%/40%/55%）与
     深色基底混合，得到同色相系的三档 duo 色——背景跟随歌曲主题，
     又保持深底，前景歌词对比度不受影响。 */
  static _hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return null;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  static _mixRgb(a, b, t) {
    const f = (x, y) => Math.round(x + (y - x) * t);
    return { r: f(a.r, b.r), g: f(a.g, b.g), b: f(a.b, b.b) };
  }

  applyThemeHex(hex) {
    const rgb = PVBackground._hexToRgb(hex);
    if (!rgb) return;
    const darkP = { r: 10, g: 6, b: 24 };   // 深色基底（primary 锚点）
    const darkS = { r: 14, g: 4, b: 26 };   // 深色基底（secondary 锚点）
    this.accentColor = rgb;
    this.primaryColor = PVBackground._mixRgb(darkP, rgb, 0.30);
    this.secondaryColor = PVBackground._mixRgb(darkS, rgb, 0.48);
    /* ★ 换歌/换主题 → 形状场重新置种：布景布局跟着新歌刷新，避免始终同一套 */
    this.fieldShapes = [];
    if (this.themeOverlay) this._applyOverlayGradient();
  }

  /* ===== 上游参考项目 FluidBackground 移植层 =====
     三层结构：封面缩图模糊层(最底,z0) → silk canvas(半透明,z1) → 主题渐变叠层(overlay,z2)。
     silk 波浪降为中层动态，封面与主题色透出 → 打破单一深色（"单调"主因）。 */
  _buildFluidLayers() {
    if (!this.container || this.coverBackdrop) return; /* 幂等：重复 init 不叠加 */
    // 1. 封面世界背景：384px 缩图 + blur(40px) scale(1.5)，切歌交叉淡化
    this.coverBackdrop = document.createElement('div');
    this.coverBackdrop.className = 'pv-cover-backdrop';
    this.coverBackdrop.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    this.coverLayers = [];
    this._coverKey = 0;
    this._currentCoverKey = null;
    this.container.insertBefore(this.coverBackdrop, this.canvas);
    // silk 波浪层降半透明 → 透出封面与主题色层次
    if (this.canvas) this.canvas.style.opacity = '0.6';
    // 2. 主题渐变叠层（overlay 混合，统一色调 + 增加层次）
    this.themeOverlay = document.createElement('div');
    this.themeOverlay.className = 'pv-theme-gradient';
    this.themeOverlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:overlay;opacity:0.7;transition:background 1.6s cubic-bezier(0.22,1,0.36,1);';
    const gridEl = this.gridEl;
    if (gridEl && gridEl.parentNode) gridEl.parentNode.insertBefore(this.themeOverlay, gridEl);
    else this.container.appendChild(this.themeOverlay);
    this._applyOverlayGradient();
  }

  /* 384px 封面缩图（上游参考项目 COVER_BLUR_SOURCE_MAX 对齐）：长边 384/jpeg —
     小纹理单块上传，消除大封面分块上传导致的网格/栅格闪烁；blur(40px) 恰好抹平
     384px 以下细节，视觉与大图模糊一致，GPU 只上传一块小纹理 */
  _buildCoverSource(url) {
    return new Promise((resolve) => {
      if (!url || typeof document === 'undefined') { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          const scale = Math.min(1, 384 / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        } catch (e) { resolve(null); } /* CORS 污染 → 回退原图 URL，由 decode 门控兜底 */
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  /* 设置封面：同 URL 去重；新层 decode 门控后淡入，旧层淡出并在 1.6s 后剪除 */
  setCover(url) {
    if (!url || !this.coverBackdrop) return;
    if (this._currentCoverKey === url) return;
    this._currentCoverKey = url;
    const key = ++this._coverKey;
    const oldTop = this.coverLayers[this.coverLayers.length - 1] || null;
    this._buildCoverSource(url).then((small) => {
      const src = small || url;
      const layerEl = document.createElement('div');
      layerEl.style.cssText = 'position:absolute;inset:0;';
      const imgEl = document.createElement('img');
      imgEl.src = src;
      imgEl.alt = '';
      imgEl.decoding = 'async';
      imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover;filter:blur(40px) saturate(1.15);transform:scale(1.5);opacity:0;transition:opacity 1.5s ease-in-out;will-change:opacity,transform,filter;';
      layerEl.appendChild(imgEl);
      this.coverBackdrop.appendChild(layerEl);
      this.coverLayers.push({ el: layerEl, img: imgEl });
      const reveal = () => requestAnimationFrame(() => {
        imgEl.style.opacity = '1';
        if (oldTop && oldTop.img) oldTop.img.style.opacity = '0';
        setTimeout(() => {
          if (oldTop && oldTop.el && oldTop.el.parentNode) oldTop.el.parentNode.removeChild(oldTop.el);
          this.coverLayers = this.coverLayers.filter((l) => l.el === layerEl || l.el === (oldTop && oldTop.el));
        }, 1600);
      });
      if (typeof imgEl.decode === 'function') { imgEl.decode().then(reveal).catch(() => reveal()); }
      else reveal();
    });
  }

  clearCover() {
    if (!this.coverLayers) return;
    this.coverLayers.forEach((l) => { if (l.el && l.el.parentNode) l.el.parentNode.removeChild(l.el); });
    this.coverLayers = [];
    this._currentCoverKey = null;
  }

  _toRgba(c, a = 0.55) {
    if (!c) return 'rgba(0,0,0,0)';
    if (c.r !== undefined) return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
    if (typeof c === 'string') {
      const rgb = PVBackground._hexToRgb(c);
      if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
    }
    return c;
  }

  /* 主题渐变叠层（上游参考项目 overlay 叠层）：135° 对角主→次渐变 + 高光斑 —— 随主题色实时刷新 */
  _applyOverlayGradient() {
    if (!this.themeOverlay) return;
    this.themeOverlay.style.background =
      `radial-gradient(circle at 78% 22%, ${this._toRgba(this.accentColor, 0.4)} 0%, transparent 46%),` +
      `linear-gradient(135deg, ${this._toRgba(this.primaryColor, 0.62)}, transparent 52%, ${this._toRgba(this.secondaryColor, 0.6)})`;
  }

  destroy() {
    if (this._silkTimer) { clearTimeout(this._silkTimer); this._silkTimer = null; }
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
    }
    if (this.canvas && this.canvas.parentNode) this.canvas.remove();
    if (this.gridEl && this.gridEl.parentNode) this.gridEl.remove();
    if (this.particleContainer && this.particleContainer.parentNode) this.particleContainer.remove();
    if (this.hudEl && this.hudEl.parentNode) this.hudEl.remove();
    if (this.themeOverlay && this.themeOverlay.parentNode) this.themeOverlay.remove();
    if (this.coverBackdrop && this.coverBackdrop.parentNode) this.coverBackdrop.remove();
    this.coverLayers = [];
    this.particles = [];
  }
}
