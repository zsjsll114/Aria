/**
 * PVDecorations.js
 * 远景 3D 巨型连笔空心描边字与 5 种日系建筑几何构图系统
 * 完美还原原版视频：
 * 1. 260~360px 远景巨型连笔空心描边大字 (0.28x 慢视差慢移)
 * 2. 彗星拖尾瞄准圆 (Comet Orbit Reticles)
 * 3. 双同心十字瞄准准心 (Target Crosshairs)
 * 4. 倾斜大细线框与 45° 密集阴影排线 (Tilted Frame & Hatching)
 * 5. 日系手绘微标 (Vector Doodles) 与水平扫描切线
 */
export class PVDecorations {
  constructor(layer) {
    this.layer = layer;
    this.currentOutlineContainer = null;
    this.currentGeoEl = null;
  }

  /**
   * 为当前活动场景渲染远景巨型描边文字与几何构图
   * @param {Object} node 当前排版场景节点
   * @param {string} themeColor 主题强调色
   */
  renderForNode(node, themeColor = '#ffcc33') {
    if (!this.layer || !node) return;

    // 1. 渲染远景 3D 巨型连笔空心描边字 (260~360px)
    if (!this.currentOutlineContainer) {
      this.currentOutlineContainer = document.createElement('div');
      this.currentOutlineContainer.className = 'pv-outline-container';
      this.layer.appendChild(this.currentOutlineContainer);
    }
    this.currentOutlineContainer.innerHTML = '';

    const bgWords = node.backgroundWords || [];
    bgWords.forEach((word, idx) => {
      if (!word) return;
      const wordEl = document.createElement('div');
      wordEl.className = 'pv-giant-outline-word';
      wordEl.textContent = word;

      // 错落坐标：基于场景中心，并在 3D 深度上略微倾斜
      const offsetX = (idx === 0) ? (node.pos.x - 120) : (node.pos.x + 180);
      const offsetY = (idx === 0) ? (node.pos.y - 80) : (node.pos.y + 110);
      const rot = (idx === 0) ? -2.5 : 2.0;

      wordEl.style.transform = `translate3d(${offsetX}px, ${offsetY}px, -120px) rotate(${rot}deg)`;
      wordEl.style.webkitTextStroke = `1.8px ${themeColor}`;
      wordEl.style.setProperty('--pv-stroke-color', themeColor);

      this.currentOutlineContainer.appendChild(wordEl);
    });

    // 2. 渲染 上游式「底部固定几何」（solid fill 实心 + hollow stroke 空心 + hatch 排线）
    //    锚定屏幕底带；元素带描边生长/填充淡入与轻微浮动动画，逐场换构图（8 变体滚播）
    if (!this.currentGeoEl) {
      this.currentGeoEl = document.createElement('div');
      this.currentGeoEl.className = 'pv-geometry-layer';
      this.layer.appendChild(this.currentGeoEl);
    }

    const geoVariants = [
      'classic-blocks', 'twin-pillars', 'disc-ring', 'diamond-pair',
      'stripe-stack', 'corner-els', 'twin-wedges', 'cross-ring'
    ];
    const lineCount = (node.lines && node.lines.length) || 1;
    const variant = geoVariants[Math.abs((node.index || 0) + lineCount) % geoVariants.length];

    this.currentGeoEl.innerHTML = this._buildBottomGeo(variant, themeColor, node);
  }

  /**
   * ★ 上游参考项目 fixedGeo 对齐：底部几何构图生成器
   * - 实心块：class="geo-fill"，填充淡入
   * - 空心描边：class="geo-stroke"，pathLength="1" + stroke-dashoffset 描边生长
   * - 排线：class="geo-soft"，多线错峰淡入
   * - 各元素带 --gd 错峰延迟；SVG 整体带 --gf 浮动延迟（轻微上下漂移 + 微转，
   *   动画走独立 translate/rotate 属性，不覆盖定位 transform）
   */
  _buildBottomGeo(variant, primary, node) {
    const seed = Math.abs((node.index || 0) * 131 + ((node.lines && node.lines.length) || 1));
    const accent = this._shiftHue(primary, seed % 2 === 0 ? 34 : 0);
    const parts = [];
    const gd = (i, j) => `--gd:${(0.10 + Math.abs(i) % 8 * 0.06 + (j || 0) * 0.05).toFixed(2)}s`;
    const W = 'rgba(255,255,255,1)';
    const FO = 'rgba(255,255,255,0.42)';   // faint outline
    const FR = 'rgba(255,255,255,0.16)';   // faint rule

    // —— 图元发射器 ——
    const rectF = (x, y, w, h, color, a, i) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="geo-fill" fill="${color}" fill-opacity="${a}" style="${gd(i)}"/>`;
    const rectS = (x, y, w, h, color, lw, i, a = 0.6) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="geo-stroke" pathLength="1" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${a}" style="${gd(i)}"/>`;
    const circF = (cx, cy, r, color, a, i) =>
      `<circle cx="${cx}" cy="${cy}" r="${r}" class="geo-fill" fill="${color}" fill-opacity="${a}" style="${gd(i)}"/>`;
    const circS = (cx, cy, r, color, lw, i, a = 0.6) =>
      `<circle cx="${cx}" cy="${cy}" r="${r}" class="geo-stroke" pathLength="1" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${a}" style="${gd(i)}"/>`;
    const diamondF = (cx, cy, dr, color, a, i) =>
      `<path d="M ${cx} ${cy - dr} L ${cx + dr} ${cy} L ${cx} ${cy + dr} L ${cx - dr} ${cy} Z" class="geo-fill" fill="${color}" fill-opacity="${a}" style="${gd(i)}"/>`;
    const diamondS = (cx, cy, dr, color, lw, i, a = 0.55) =>
      `<path d="M ${cx} ${cy - dr} L ${cx + dr} ${cy} L ${cx} ${cy + dr} L ${cx - dr} ${cy} Z" class="geo-stroke" pathLength="1" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${a}" style="${gd(i)}"/>`;
    const wedgeUF = (cx, ty, by, half, color, a, i) =>
      `<path d="M ${cx} ${ty} L ${cx + half} ${by} L ${cx - half} ${by} Z" class="geo-fill" fill="${color}" fill-opacity="${a}" style="${gd(i)}"/>`;
    const wedgeDS = (cx, by, ty, half, color, lw, i, a = 0.55) =>
      `<path d="M ${cx} ${by} L ${cx + half} ${ty} L ${cx - half} ${ty} Z" class="geo-stroke" pathLength="1" fill="none" stroke="${color}" stroke-width="${lw}" stroke-opacity="${a}" style="${gd(i)}"/>`;
    const line = (x1, y1, x2, y2, color, lw, i, a = 0.5) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="geo-stroke" pathLength="1" stroke="${color}" stroke-width="${lw}" stroke-opacity="${a}" style="${gd(i)}"/>`;
    const hatch = (x, y, w, h, spacing, color, i, alpha = 0.16) => {
      let s = '';
      for (let k = -w; k < w + h; k += spacing) {
        s += `<line x1="${(x + k).toFixed(1)}" y1="${y}" x2="${(x + k + h).toFixed(1)}" y2="${(y + h).toFixed(1)}" class="geo-soft" stroke="${color}" stroke-width="1.4" stroke-opacity="${alpha}" style="${gd(i, k)}"/>`;
      }
      return s;
    };
    const draw = {
      'classic-blocks': () => {
        parts.push(rectF(120, 118, 150, 34, accent, 0.66, 0));
        parts.push(rectS(330, 96, 150, 84, W, 2, 1));
        parts.push(hatch(560, 92, 120, 90, 6, W, 2));
        parts.push(circS(820, 130, 52, primary, 2, 3, 0.5));
        parts.push(line(60, 176, 940, 176, FO, 1, 4, 0.5));
      },
      'twin-pillars': () => {
        parts.push(rectF(150, 96, 34, 84, accent, 0.6, 0));
        parts.push(rectF(158, 104, 18, 68, primary, 0.35, 1));
        parts.push(rectS(320, 88, 74, 92, W, 2, 2));
        parts.push(hatch(450, 96, 34, 84, 5, W, 3));
        parts.push(rectF(590, 112, 190, 14, accent, 0.5, 4));
        parts.push(line(140, 176, 860, 176, FO, 1, 5, 0.5));
      },
      'disc-ring': () => {
        parts.push(circF(200, 136, 40, accent, 0.66, 0));
        parts.push(circF(200, 136, 15, primary, 0.5, 1));
        parts.push(circS(400, 126, 58, W, 2, 2));
        parts.push(circS(400, 126, 42, W, 1, 3, 0.28));
        parts.push(hatch(520, 108, 76, 46, 5, W, 4));
        parts.push(circS(800, 136, 30, primary, 1.6, 5, 0.4));
        parts.push(line(100, 176, 900, 176, FO, 1, 6, 0.5));
      },
      'diamond-pair': () => {
        const dir = seed % 2 === 0 ? 1 : -1;
        const cx = 300 - 40 * dir;
        parts.push(diamondS(cx, 140, 46, W, 2, 0));
        parts.push(diamondS(cx, 140, 30, W, 1, 1, 0.28));
        parts.push(diamondF(560 + 60 * dir, 122, 18, accent, 0.68, 2));
        parts.push(hatch(560 - 12 * dir, 168, 24, 12, 4, W, 3));
        parts.push(line(80, 176, 920, 176, FO, 1, 4, 0.5));
      },
      'stripe-stack': () => {
        const dir = seed % 2 === 0 ? 1 : -1;
        parts.push(rectF(140 * dir < 0 ? 60 : 380, 108, 150, 22, accent, 0.66, 0));
        parts.push(rectS(300, 138, 160, 40, W, 2, 1));
        parts.push(rectF(420 - 60 * dir, 100, 110, 12, primary, 0.5, 2));
        parts.push(hatch(700, 92, 34, 92, 5, W, 3));
        parts.push(line(80, 176, 920, 176, FO, 1, 4, 0.5));
      },
      'corner-els': () => {
        const dir = seed % 2 === 0 ? 1 : -1;
        const arm = 52, th = 16;
        const x1 = 230 - 34 * dir;
        parts.push(rectF(dir < 0 ? x1 - arm : x1, 102, arm, th, accent, 0.66, 0));
        parts.push(rectF(dir < 0 ? x1 - arm : x1, 102, th, arm, accent, 0.66, 1));
        const x2 = 480 + 34 * dir;
        parts.push(rectF(dir < 0 ? x2 : x2 - arm, 150 - th, arm, th, primary, 0.5, 2));
        parts.push(rectF(dir < 0 ? x2 + arm - th : x2 - th, 150 - arm, th, arm, primary, 0.5, 3));
        parts.push(rectS(610, 110, 70, 70, W, 2, 4));
        parts.push(hatch(740, 132, 24, 26, 4, W, 5));
        parts.push(line(80, 176, 920, 176, FO, 1, 6, 0.5));
      },
      'twin-wedges': () => {
        const dir = seed % 2 === 0 ? 1 : -1;
        const wx = 300 - 30 * dir;
        parts.push(wedgeUF(wx, 96, 150, 52, accent, 0.58, 0));
        parts.push(wedgeDS(500 + 30 * dir, 96, 156, 52, W, 2, 1));
        parts.push(wedgeDS(500 + 30 * dir, 112, 146, 34, W, 1, 2, 0.28));
        parts.push(hatch(700, 100, 26, 46, 5, W, 3));
        parts.push(line(80, 176, 920, 176, FO, 1, 4, 0.5));
      },
      'cross-ring': () => {
        const cx = 300 + ((seed % 3) - 1) * 24;
        const arm = 40, th = 17;
        parts.push(rectF(cx - arm, 132 - th / 2, arm * 2, th, accent, 0.66, 0));
        parts.push(rectF(cx - th / 2, 132 - arm, th, arm * 2, accent, 0.66, 1));
        parts.push(circS(cx, 132, 62, W, 2, 2));
        parts.push(circS(cx, 132, 74, W, 1, 3, 0.22));
        parts.push(hatch(cx + 58, 118, 26, 28, 4, W, 4));
        parts.push(line(80, 176, 920, 176, FO, 1, 5, 0.5));
      }
    };

    (draw[variant] || draw['classic-blocks'])();

    // 屏幕两侧大虚线圈与轨道刻度（上游参考项目 氛围感，慢生长）
    parts.push(`<circle cx="${140}" cy="176" r="10" class="geo-stroke" pathLength="1" fill="none" stroke="${FO}" stroke-width="1" stroke-opacity="0.4" style="${gd(7)}"/>`);
    parts.push(`<circle cx="${860}" cy="176" r="10" class="geo-stroke" pathLength="1" fill="none" stroke="${FO}" stroke-width="1" stroke-opacity="0.4" style="${gd(8)}"/>`);
    for (let t = 0; t < 14; t++) {
      const tx = 90 + t * 61;
      parts.push(`<line x1="${tx}" y1="186" x2="${tx}" y2="${t % 3 === 0 ? 196 : 191}" class="geo-stroke" pathLength="1" stroke="${FR}" stroke-width="1" style="${gd(9, t)}"/>`);
    }

    // 底部几何带：宽幅、锚定屏幕底带；--gf 供整体浮动错峰
    return `<svg class="pv-geo-svg" viewBox="0 0 1000 220" preserveAspectRatio="xMidYMax meet"
      xmlns="http://www.w3.org/2000/svg"
      style="top:auto; bottom:2vh; left:50%; width:min(92vw,1000px); height:auto; transform:translateX(-50%); --gf:${((seed % 9) * 0.8).toFixed(1)}s;">${parts.join('')}
    </svg>`;
  }

  /**
   * ★ HSL 色相偏移：为强调色/次强调色派生同族色（上游参考项目 primary/accent 双色体系）
   */
  _shiftHue(hexColor, deltaDeg) {
    try {
      let c = String(hexColor || '#ffcc33').trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) return c;
      const n = parseInt(c.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      const l = (mx + mn) / 2;
      let h, s;
      if (mx === mn) { h = 0; s = 0; }
      else {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r / 255) h = ((g / 255 - b / 255) / d + (g < b ? 6 : 0)) / 6;
        else if (mx === g / 255) h = ((b / 255 - r / 255) / d + 2) / 6;
        else h = ((r / 255 - g / 255) / d + 4) / 6;
      }
      h = (h * 360 + deltaDeg + 360) % 360;
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p2 = 2 * l - q2;
      const rr = Math.round(hue2rgb(p2, q2, h / 360 + 1 / 3) * 255);
      const gg = Math.round(hue2rgb(p2, q2, h / 360) * 255);
      const bb = Math.round(hue2rgb(p2, q2, h / 360 - 1 / 3) * 255);
      return '#' + ((1 << 24) | (rr << 16) | (gg << 8) | bb).toString(16).slice(1).toUpperCase();
    } catch (e) {
      return hexColor;
    }
  }

  clear() {
    if (this.currentOutlineContainer) this.currentOutlineContainer.innerHTML = '';
    if (this.currentGeoEl) this.currentGeoEl.innerHTML = '';
  }
}
