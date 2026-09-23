/**
 * TunnelDepthStack.js — 「流光隧道」3D 深度堆叠与背景化
 * 忠实落地 PV-技术方案.md 第 19 章：
 *
 * 1. 19.2 DepthStackManager：演完的句组推到 Z 轴深处成为背景层；
 *    所有已有层再往深处推一层；超过 maxLayers 丢弃最老层
 * 2. 19.3 深度参数表：Z -300/-600/-900/-1200，缩放 0.7/0.5/0.35/0.2，
 *    模糊 2/4/6/8px，透明度 0.5/0.35/0.2/0.1
 * 3. 19.4 视差 + 19.12 Z 轴涟漪旋转 + 运动拉伸（运动模糊感）
 * 4. 19.15 深度光照（方向光近亮远暗 + 聚光灯）
 * 5. 19.16 景深 DOF（焦点跟随当前演出层，镜头快时扩域）
 * 6. 19.6 段落切换深度清理（所有层快速向远处消散）
 * 7. 19.20 背景层生命周期状态机 active→transitioning→settled→drifting→fading→cleared
 *
 * ★ 深度推移动画不使用 WAAPI fill:forwards（会冻结 transform 覆盖每帧视差写入），
 *   改为帧内目标插值（tz/tScale/tBlur/tOpacity 逐帧 lerp），保证与视差/涟漪共存。
 */

const DEPTH_TABLE = [
  /* idx: z, scale, blur, opacity */
  { z: 0,     scale: 1.0,  blur: 0, opacity: 1.0  },  // 当前演出层
  { z: -300,  scale: 0.7,  blur: 2, opacity: 0.5  },  // 第 1 层背景
  { z: -600,  scale: 0.5,  blur: 4, opacity: 0.35 },  // 第 2 层背景
  { z: -900,  scale: 0.35, blur: 6, opacity: 0.2  },  // 第 3 层背景
  { z: -1200, scale: 0.2,  blur: 8, opacity: 0.1  }   // 第 4 层背景
];

export class TunnelDepthStack {
  /**
   * @param {HTMLElement} container 深度层容器（3D 透视空间内、舞台层之后）
   */
  constructor(container) {
    this.container = container;
    this.layers = [];   // {el, z,tz, scale,tScale, blur,tBlur, opacity,tOpacity, state}
    this.maxLayers = 4; // 性能预算（19.11 分级 medium）
    this.performanceTier = 'medium';
    this.focusZ = 0;
    this.focusRange = 400;
    this._clearTimer = null;
  }

  setPerformanceTier(tier) {
    this.performanceTier = tier;
    this.maxLayers = tier === 'high' ? 5 : (tier === 'medium' ? 4 : 2);
    while (this.layers.length > this.maxLayers) this._fadeOutOldest();
  }

  _blurCss(px) {
    return this.performanceTier === 'low' ? 'none' : `blur(${px.toFixed(1)}px)`;
  }

  /**
   * 19.2 句组结束时调用：快照推入背景层
   * @param {HTMLElement} groupEl 演完的句组 DOM（含文字+装饰）
   */
  pushGroupToBackground(groupEl) {
    if (!groupEl || !this.container) return;

    if (groupEl.parentNode !== this.container) {
      this.container.appendChild(groupEl);
    }
    groupEl.classList.add('tunnel-depth-layer');
    groupEl.classList.remove('tunnel-group-active');

    const layer = {
      el: groupEl,
      z: 0, tz: 0,
      scale: 1, tScale: 1,
      blur: 0, tBlur: 0,
      opacity: 1, tOpacity: 1,
      state: 'transitioning'
    };
    this.layers.push(layer);

    // 19.2 shiftAllLayersDeeper：所有已有背景层再往深处推一档
    for (let i = 0; i < this.layers.length - 1; i++) {
      const l = this.layers[i];
      const idx = Math.min(i + 1, DEPTH_TABLE.length - 1);
      const t = DEPTH_TABLE[idx];
      l.tz = t.z; l.tScale = t.scale; l.tBlur = t.blur; l.tOpacity = t.opacity;
      l.state = 'drifting';
      this._writeStaticStyle(l); // filter/opacity 目标立即写入（transition 平滑）
    }

    // 最新层推到第 1 档背景
    const t1 = DEPTH_TABLE[1];
    layer.tz = t1.z; layer.tScale = t1.scale; layer.tBlur = t1.blur; layer.tOpacity = t1.opacity;
    this._writeStaticStyle(layer);

    // 19.2 超过最大层数 → 丢弃最老的（渐隐消失）
    while (this.layers.length > this.maxLayers) this._fadeOutOldest();
  }

  /** filter / opacity 仅在目标变化时写入（避免每帧 filter 重绘） */
  _writeStaticStyle(layer) {
    if (!layer.el) return;
    // 19.15 方向光：Z=0 → 1.0，Z=-1200 → 0.4（近亮远暗）
    const brightness = 1 - Math.min(Math.abs(layer.tz) / 1200, 1) * 0.6;
    layer.el.style.filter = `${this._blurCss(layer.tBlur)} brightness(${brightness.toFixed(2)})`;
    layer.el.style.opacity = String(layer.tOpacity);
  }

  _fadeOutOldest() {
    const layer = this.layers.shift();
    if (!layer) return;
    layer.state = 'fading';
    layer.tz = -2200; layer.tScale = 0.08; layer.tBlur = 14; layer.tOpacity = 0;
    this._writeStaticStyle(layer);
  }

  /**
   * 逐帧更新（每帧调用）：
   * - 深度推移：z/scale 向目标插值（transitioning/drifting）
   * - 19.4 视差：越深的层随镜头移动幅度越小
   * - 19.12 Z 轴涟漪：每层不同速度绕 Z 微旋
   * - 19.12 运动拉伸：镜头快速移动时沿运动方向拉伸（限幅 0.15）
   * - 19.16 景深 DOF：焦点 Z=0，镜头快时扩域（影响最深几层的衰减）
   */
  update(camState, timeSec) {
    const vx = camState.vx || 0, vy = camState.vy || 0;
    const speed = Math.hypot(vx, vy);
    const stretch = Math.min(speed * 0.002, 0.15);

    // 19.16 焦点跟随当前演出层；镜头快时扩大景深范围减少模糊感
    this.focusZ = 0;
    this.focusRange = 400 + speed * 2;

    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer.el) { this.layers.splice(i, 1); continue; }

      // 深度插值（settled 后 tz==z 为零成本）
      layer.z += (layer.tz - layer.z) * 0.07;
      layer.scale += (layer.tScale - layer.scale) * 0.07;
      if (layer.state === 'transitioning' && Math.abs(layer.tz - layer.z) < 4) layer.state = 'settled';
      if (layer.state === 'drifting' && Math.abs(layer.tz - layer.z) < 4) layer.state = 'settled';

      // fading 完成 → 清除
      if (layer.state === 'fading' && layer.tOpacity === 0 && layer.opacity < 0.02) {
        layer.state = 'cleared';
        if (layer.el && layer.el.parentNode) layer.el.remove();
        this.layers.splice(i, 1);
        continue;
      }
      layer.opacity += (layer.tOpacity - layer.opacity) * 0.07;
      if (layer.state !== 'fading' && layer.el) layer.el.style.opacity = layer.opacity.toFixed(3);

      // 19.4 视差（越深幅度越小）+ 19.12 涟漪旋转 + 运动拉伸
      const depthFactor = Math.max(1 - Math.abs(layer.z) / 1500, 0);
      const parallaxX = -camState.x * depthFactor * 0.3;
      const parallaxY = -camState.y * depthFactor * 0.3;
      const rotSpeed = 0.3 + depthFactor * 0.7;
      const rotAmp = 2 + depthFactor * 6;
      const rotZ = Math.sin(timeSec * rotSpeed) * rotAmp;

      layer.el.style.transform =
        `translate3d(${parallaxX.toFixed(1)}px, ${parallaxY.toFixed(1)}px, ${layer.z.toFixed(0)}px) ` +
        `rotateZ(${rotZ.toFixed(2)}deg) ` +
        `scaleX(${(layer.scale * (1 + stretch)).toFixed(3)}) ` +
        `scaleY(${(layer.scale * (1 - stretch * 0.4)).toFixed(3)})`;
    }
  }

  /** 兼容旧接口名 */
  updateParallax(camState, timeSec) { this.update(camState, timeSec); }
  updateFocus() {}

  /**
   * 19.15 聚光灯：当前演出位置最亮，向外衰减（节流调用）
   */
  spotlight(fgCenter) {
    if (this.performanceTier === 'low') return;
    const layer = this.layers[this.layers.length - 1];
    if (!layer || !layer.el || layer.state === 'cleared' || layer.state === 'fading') return;
    const dx = 0 - (fgCenter ? fgCenter.x : 0);
    const dy = 0 - (fgCenter ? fgCenter.y : 0);
    const dist = Math.hypot(dx, dy);
    const maxBeam = 600;
    const lightFactor = dist < maxBeam ? 1.0 : Math.max(1 - (dist - maxBeam) / 300, 0.3);
    layer.el.style.filter = `${this._blurCss(layer.tBlur)} brightness(${lightFactor.toFixed(2)}) contrast(${(1 + (1 - lightFactor) * 0.2).toFixed(2)})`;
  }

  /**
   * 19.6 段落切换：所有背景层快速向远处消散（cleared）
   */
  clearAllForSectionTransition() {
    for (const layer of this.layers) {
      layer.state = 'fading';
      layer.tz = -3000; layer.tScale = 0.05; layer.tBlur = 20; layer.tOpacity = 0;
      this._writeStaticStyle(layer);
    }
    if (this._clearTimer) clearTimeout(this._clearTimer);
    this._clearTimer = setTimeout(() => {
      for (const layer of this.layers) {
        if (layer.el && layer.el.parentNode) layer.el.remove();
      }
      this.layers = [];
    }, 650);
  }

  clear() {
    if (this._clearTimer) clearTimeout(this._clearTimer);
    for (const layer of this.layers) {
      if (layer.el && layer.el.parentNode) layer.el.remove();
    }
    this.layers = [];
  }
}

/**
 * 19.14 3D 粒子层：细小几何粒子在 Z 轴不同深度飘浮，镜头移动产生强烈视差
 * Canvas 透视投影（按 Z 排序远的先画，越远越暗）
 */

/* ★ 全屏 Canvas 像素预算（与 PV 层同一策略）：高 DPI 屏自动下调 DPR */
const TUNNEL_MAX_CANVAS_PX = 5500000;
function budgetCanvasDpr(w, h, requestedDpr) {
  if (!w || !h) return Math.max(1, Math.min(2, requestedDpr || 1));
  let dpr = Math.max(1, Math.min(2, requestedDpr || 1));
  const px = w * h * dpr * dpr;
  if (px <= TUNNEL_MAX_CANVAS_PX) return dpr;
  return Math.max(1, Math.min(dpr, Math.sqrt(TUNNEL_MAX_CANVAS_PX / (w * h))));
}

export class TunnelParticle3DLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.particles = [];
    this.perspective = 800;
    this.count = 60;
    this.color = 'rgba(255,255,255,';
    this.dprCap = 2; /* ★ 性能分档：canvas 渲染 DPR 上限（低端设备降采样） */
  }

  setPerf(cfg = {}) {
    if (typeof cfg.dpr === 'number' && cfg.dpr > 0) {
      this.dprCap = Math.max(1, Math.min(2, cfg.dpr));
    }
    if (typeof cfg.count === 'number') {
      this.init(Math.max(0, Math.floor(cfg.count)));
    }
  }

  init(count) {
    if (!this.ctx) return;
    this.count = count || this.count;
    this.particles = [];
    for (let i = 0; i < this.count; i++) {
      this.particles.push({
        x: (Math.random() - 0.5) * 1920,
        y: (Math.random() - 0.5) * 1080,
        z: -(Math.random() * 1200),
        size: Math.random() * 3 + 1,
        speed: Math.random() * 0.5 + 0.1,
        type: Math.random() > 0.5 ? 'dot' : 'line',
        opacity: Math.random() * 0.5 + 0.2
      });
    }
    this.resize();
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const requested = Math.min(window.devicePixelRatio || 1, this.dprCap);
      /* ★ 像素预算钳制：全屏 3D 粒子 Canvas 按 DPR2 绘制在高分屏易过载，自动下调 */
      const dpr = budgetCanvasDpr(rect.width, rect.height, requested);
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
    }
  }

  setColor(rgbaPrefix) { if (rgbaPrefix) this.color = rgbaPrefix; }

  update(camState, timeSec) {
    if (!this.ctx || !this.particles.length) return;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const sorted = [...this.particles].sort((a, b) => a.z - b.z);
    const cx = w / 2, cy = h / 2;

    for (const p of sorted) {
      // 飘浮运动
      p.y += Math.sin(timeSec * p.speed + p.x * 0.01) * 0.4;
      p.x += Math.cos(timeSec * p.speed + p.y * 0.01) * 0.3;

      // 透视投影
      const relZ = p.z - (camState.z || 0);
      if (relZ >= -20) continue; // 镜头后方跳过
      const scale = this.perspective / (this.perspective - relZ);
      const projX = cx + (p.x + (camState.x || 0) * 0.3) * scale;
      const projY = cy + (p.y + (camState.y || 0) * 0.3) * scale;
      if (projX < -20 || projX > w + 20 || projY < -20 || projY > h + 20) continue;
      const projSize = p.size * scale;
      const depthAlpha = p.opacity * Math.max(1 - Math.abs(relZ) / 1500, 0.1);

      if (p.type === 'dot') {
        ctx.fillStyle = `${this.color}${depthAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(projX, projY, Math.max(projSize, 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = `${this.color}${(depthAlpha * 0.7).toFixed(3)})`;
        ctx.lineWidth = Math.max(projSize * 0.4, 0.4);
        ctx.beginPath();
        ctx.moveTo(projX, projY);
        ctx.lineTo(projX + projSize * 4, projY);
        ctx.stroke();
      }
    }
  }

  clear() {
    this.particles = [];
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
