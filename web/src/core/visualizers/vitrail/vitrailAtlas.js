/**
 * web/src/core/visualizers/vitrail/vitrailAtlas.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— 线性时间 O(N) 欧氏距离场（EDT）3D 雕刻字体图集
 *
 * 特性：
 * 1. 基于 Felzenszwalb & Huttenlocher 1D 可分离抛物线下包络精确欧氏距离变换；
 * 2. RGBA8 输出：R = 归一化有符号距离场（0.5 为笔画边界），G/B = 笔画立体倒角法线 (nx, ny)，A = 原始抗锯齿覆盖度；
 * 3. 自适应包围盒缩放入框（actualBoundingBox*）+ 充足 spread 留白，彻底杜绝自定义字体裁切；
 * 4. 帧预算分摊烘焙 + LRU 复用，切句与跳转均不掉帧。
 */

import { clamp } from './vitrailProfiles.js';
import { logCatch } from '../../../services/log.js';

const INF = 1e9;

/**
 * 1D Felzenszwalb-Huttenlocher squared Euclidean distance transform
 * @param {Float32Array} f 输入值数组（长度 n）
 * @param {Float32Array} out 输出最小平方距离数组（长度 >= n）
 * @param {Int32Array} v 抛物线顶点位置缓冲
 * @param {Float32Array} z 抛物线交点缓冲
 * @param {number} n 数组长度
 */
export function edt1d(f, out, v, z, n) {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const dx = q - v[k];
        out[q] = dx * dx + f[v[k]];
    }
}

export class SdfScratch {
    /** @param {number} size 单元格像素边长 */
    constructor(size = 88) {
        this.size = size;
        const n = size * size;
        this.outerGrid = new Float32Array(n);
        this.innerGrid = new Float32Array(n);
        this.tmpGrid = new Float32Array(n);
        this.f = new Float32Array(size);
        this.d = new Float32Array(size);
        this.v = new Int32Array(size);
        this.z = new Float32Array(size + 1);
        this.rgba = new Uint8Array(n * 4);
    }
}

/**
 * 从灰度/Alpha 遮罩计算精确 RGBA8 有符号距离场 + 3D 雕刻倒角斜坡法线
 * @param {Uint8Array|Uint8ClampedArray} alphaBuf 长度 w * h 的单通道 alpha [0..255]
 * @param {number} w 宽度
 * @param {number} h 高度
 * @param {number} spread 距离场半宽（像素），决定光晕与倒角过渡半径
 * @param {SdfScratch} [scratch] 复用内存缓冲
 * @returns {Uint8Array} RGBA8 缓冲（R=SDF [0..255, 128=边缘], G=dX, B=dY, A=原始覆盖）
 */
export function computeSdfFromAlpha(alphaBuf, w, h, spread = 12, scratch = null) {
    const buf = scratch && scratch.size === w && w === h ? scratch : new SdfScratch(Math.max(w, h));
    const n = w * h;
    const { outerGrid, innerGrid, tmpGrid, f, d, v, z, rgba } = buf;

    // 亚像素边界权重：Alpha=128 附近用 (a - 0.5)^2 做精确亚像素偏移，消除锯齿阶梯
    for (let i = 0; i < n; i++) {
        const a = alphaBuf[i] / 255;
        if (a <= 0.002) {
            outerGrid[i] = INF;
            innerGrid[i] = 0;
        } else if (a >= 0.998) {
            outerGrid[i] = 0;
            innerGrid[i] = INF;
        } else {
            const dEdge = 0.5 - a;
            outerGrid[i] = dEdge > 0 ? dEdge * dEdge : 0;
            innerGrid[i] = dEdge < 0 ? dEdge * dEdge : 0;
        }
    }

    const transform2D = (grid) => {
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
            edt1d(f, d, v, z, h);
            for (let y = 0; y < h; y++) tmpGrid[y * w + x] = d[y];
        }
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) f[x] = tmpGrid[row + x];
            edt1d(f, d, v, z, w);
            for (let x = 0; x < w; x++) grid[row + x] = Math.sqrt(d[x]);
        }
    };

    transform2D(outerGrid);
    transform2D(innerGrid);

    const invSpread = 1 / Math.max(2, spread);
    // 先写出 signed distance 浮点图以便求光滑中心差分法线
    for (let i = 0; i < n; i++) {
        tmpGrid[i] = innerGrid[i] - outerGrid[i]; // >0 在笔画内部，<0 在外部
    }

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const sd = tmpGrid[idx];
            const val = clamp(0.5 + sd * invSpread * 0.5, 0, 1);

            const xm = Math.max(0, x - 1);
            const xp = Math.min(w - 1, x + 1);
            const ym = Math.max(0, y - 1);
            const yp = Math.min(h - 1, y + 1);
            const gx = (tmpGrid[y * w + xp] - tmpGrid[y * w + xm]) * 0.5;
            const gy = (tmpGrid[yp * w + x] - tmpGrid[ym * w + x]) * 0.5;
            const gLen = Math.hypot(gx, gy);
            const nx = gLen > 0.005 ? gx / gLen : 0;
            const ny = gLen > 0.005 ? gy / gLen : 0;

            const o = idx * 4;
            rgba[o + 0] = Math.round(val * 255);
            rgba[o + 1] = Math.round((-nx * 0.5 + 0.5) * 255); // 世界 +X 右侧边缘斜面向外法线为 +X (对应 -gx)
            rgba[o + 2] = Math.round((ny * 0.5 + 0.5) * 255);  // 世界 +Y 顶部边缘斜面向外法线为 +Y (对应 +gy)
            rgba[o + 3] = alphaBuf[idx];
        }
    }

    return rgba.subarray(0, n * 4);
}

/**
 * 动态 3D 雕刻文字图集管理器（支持 WebGL2 增量 TexSubImage2D 上传 + LRU 槽位淘汰）
 */
export class VitrailSdfAtlas {
    /**
     * @param {{ cellSize?: number, cols?: number, spread?: number }} [opts]
     */
    constructor({ cellSize = 88, cols = 14, spread = 12 } = {}) {
        this.cellSize = cellSize;
        this.cols = cols;
        this.rows = cols;
        this.maxSlots = cols * cols;
        this.texSize = cellSize * cols;
        this.spread = spread;

        this.scratch = new SdfScratch(cellSize);
        this.alphaBuf = new Uint8Array(cellSize * cellSize);
        this.entries = new Map(); // key -> { slot, uvRect, advanceRatio, ascRatio, descRatio, glyphW, glyphH, lastUsed }
        this.freeSlots = [];
        for (let i = this.maxSlots - 1; i >= 0; i--) this.freeSlots.push(i);

        this.tick = 1;
        this.fontStack = "'Noto Sans SC', 'Microsoft YaHei', sans-serif";
        this.canvas = null;
        this.ctx = null;
        this.texture = null;
        this.gl = null;
        this._dirtyUploads = [];
        this.needsFullReset = true;
    }

    _ensureCanvas() {
        if (this.canvas) return true;
        if (typeof document === 'undefined') return false;
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.cellSize;
        this.canvas.height = this.cellSize;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        return Boolean(this.ctx);
    }

    setFontStack(stack) {
        const clean = String(stack || "'Noto Sans SC', sans-serif");
        if (clean === this.fontStack) return false;
        this.fontStack = clean;
        this.reset();
        return true;
    }

    reset() {
        this.entries.clear();
        this.freeSlots = [];
        for (let i = this.maxSlots - 1; i >= 0; i--) this.freeSlots.push(i);
        this._dirtyUploads = [];
        this.needsFullReset = true;
    }

    _allocSlot() {
        if (this.freeSlots.length > 0) return this.freeSlots.pop();
        // LRU 淘汰最久未使用的字形槽
        let oldestKey = null;
        let oldestTick = Infinity;
        for (const [k, ent] of this.entries) {
            if (ent.lastUsed < oldestTick) {
                oldestTick = ent.lastUsed;
                oldestKey = k;
            }
        }
        if (oldestKey !== null) {
            const slot = this.entries.get(oldestKey).slot;
            this.entries.delete(oldestKey);
            return slot;
        }
        return 0;
    }

    /**
     * 获取或烘焙单字符 SDF 数据；若预算用完返回 null（供下一帧预热）
     */
    getOrBake(char, immediate = true) {
        const ch = String(char || ' ');
        const key = `${ch}`;
        this.tick++;
        const existing = this.entries.get(key);
        if (existing) {
            existing.lastUsed = this.tick;
            return existing;
        }
        if (!immediate) return null;
        if (!this._ensureCanvas()) return null;

        const slot = this._allocSlot();
        const col = slot % this.cols;
        const row = Math.floor(slot / this.cols);
        const S = this.cellSize;
        const pad = this.spread + 3;
        const boxMax = S - pad * 2;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, S, S);
        let fontPx = Math.round(boxMax * 0.84);
        ctx.font = `700 ${fontPx}px ${this.fontStack}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        const isSpace = ch.trim().length === 0;
        if (isSpace) {
            const ent = {
                slot,
                uvRect: [0, 0, 0, 0],
                advanceRatio: 0.42,
                boxW: 0,
                boxH: 0,
                offsetY: 0,
                isSpace: true,
                lastUsed: this.tick,
            };
            this.entries.set(key, ent);
            return ent;
        }

        const m0 = ctx.measureText(ch);
        const left0 = Math.max(0, m0.actualBoundingBoxLeft || 0);
        const right0 = Math.max(1, m0.actualBoundingBoxRight || m0.width || fontPx * 0.6);
        const asc0 = Math.max(1, m0.actualBoundingBoxAscent || fontPx * 0.78);
        const desc0 = Math.max(0, m0.actualBoundingBoxDescent || fontPx * 0.16);
        const w0 = left0 + right0;
        const h0 = asc0 + desc0;

        // 防止斜体悬挑/自定义艺术字体溢出 SDF 安全边距（自适应缩小入框）
        const overflowScale = Math.min(1, boxMax / Math.max(1, w0), boxMax / Math.max(1, h0));
        if (overflowScale < 0.98) {
            fontPx = Math.max(14, Math.floor(fontPx * overflowScale));
            ctx.font = `700 ${fontPx}px ${this.fontStack}`;
        }

        const m = ctx.measureText(ch);
        const left = Math.max(0, m.actualBoundingBoxLeft || 0);
        const right = Math.max(1, m.actualBoundingBoxRight || m.width || fontPx * 0.6);
        const asc = Math.max(1, m.actualBoundingBoxAscent || fontPx * 0.78);
        const desc = Math.max(0, m.actualBoundingBoxDescent || fontPx * 0.16);
        const inkW = left + right;

        const drawX = S * 0.5 - inkW * 0.5 + left;
        const baselineY = S * 0.5 + (asc - desc) * 0.5;

        ctx.fillStyle = '#ffffff';
        ctx.fillText(ch, drawX, baselineY);

        const imgData = ctx.getImageData(0, 0, S, S).data;
        for (let i = 0; i < S * S; i++) {
            this.alphaBuf[i] = imgData[i * 4 + 3];
        }

        const sdfRgba = computeSdfFromAlpha(this.alphaBuf, S, S, this.spread, this.scratch);
        const copyData = new Uint8Array(sdfRgba);
        this._dirtyUploads.push({ col, row, data: copyData });

        // 记录相对于典型全角字高的几何度量，确保 3D 排布基线齐平！
        const emRef = Math.max(1, fontPx);
        const adv = Math.max(inkW * 1.06, m.width || fontPx * 0.56);
        const u0 = (col * S + 0.5) / this.texSize;
        const v0 = (row * S + 0.5) / this.texSize;
        const u1 = ((col + 1) * S - 0.5) / this.texSize;
        const v1 = ((row + 1) * S - 0.5) / this.texSize;

        const ent = {
            slot,
            uvRect: [u0, v0, u1, v1],
            advanceRatio: clamp(adv / emRef, 0.34, 1.38),
            scaleRatio: clamp(S / emRef, 0.9, 2.8),
            // 字形视觉中心相对于排版基线的世界 Y 偏移（倍于 em）：g/y 自动下沉，汉字/大写字母齐平
            centerYOffsetRatio: clamp(((asc - desc) * 0.5) / emRef, -0.35, 0.75),
            isSpace: false,
            lastUsed: this.tick,
        };
        this.entries.set(key, ent);
        return ent;
    }

    /**
     * 预热即将播放分镜中的字形（按帧预算分摊，避免切换卡顿）
     */
    warmCharacters(chars, budget = 4) {
        let count = 0;
        for (const ch of chars) {
            if (!ch || ch.trim() === '') continue;
            if (!this.entries.has(ch)) {
                this.getOrBake(ch, true);
                count++;
                if (count >= budget) break;
            }
        }
    }

    /**
     * 将待上传的 SDF 块批量同步到 WebGL2 RGBA8 纹理
     * @param {WebGL2RenderingContext} gl
     */
    syncToGpu(gl) {
        this.gl = gl;
        if (!this.texture) {
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.texSize, this.texSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.needsFullReset = false;
        } else if (this.needsFullReset) {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.texSize, this.texSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this.needsFullReset = false;
        }

        if (this._dirtyUploads.length > 0) {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const S = this.cellSize;
            while (this._dirtyUploads.length > 0) {
                const job = this._dirtyUploads.shift();
                gl.texSubImage2D(gl.TEXTURE_2D, 0, job.col * S, job.row * S, S, S, gl.RGBA, gl.UNSIGNED_BYTE, job.data);
            }
        }
    }

    destroy() {
        if (this.gl && this.texture) {
            try { this.gl.deleteTexture(this.texture); } catch (e) { logCatch('vitrailAtlas', e); }
        }
        this.texture = null;
        this.gl = null;
        this.canvas = null;
        this.ctx = null;
        this.entries.clear();
        this._dirtyUploads = [];
    }
}
