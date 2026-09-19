/**
 * DimensionBackground.js
 * 3D 空间高阶流体丝绸 / 大理石烟波 (Fluid Silk Wave & Marbling Canvas Engine)
 * 完美还原 3d style.mp4 中流动丝绸缎面、波纹流体与光斑质感
 */

export class DimensionBackground {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d') : null;
        this.width = 0;
        this.height = 0;
        this.time = 0;
        this.speed = 0.8;
        
        // 配色主题（RGB 数组）
        this.theme = {
            base: [8, 12, 16],          // 深邃丝绸暗底
            silkLight: [220, 240, 235], // 丝绸高光
            silkMid: [50, 95, 90],      // 丝绸中间调
            silkDark: [15, 30, 32],     // 丝绸暗褶皱
            accent: [255, 204, 51]      // 能量光芒
        };
        
        this.targetTheme = JSON.parse(JSON.stringify(this.theme));
        this.noiseCanvas = null;
        this.initNoisePattern();
    }

    initNoisePattern() {
        if (typeof document === 'undefined') return;
        const nc = document.createElement('canvas');
        nc.width = 128;
        nc.height = 128;
        const nctx = nc.getContext('2d');
        const imgData = nctx.createImageData(128, 128);
        for (let i = 0; i < imgData.data.length; i += 4) {
            const v = Math.random() * 255;
            imgData.data[i] = v;
            imgData.data[i + 1] = v;
            imgData.data[i + 2] = v;
            imgData.data[i + 3] = 20; // 细腻织物颗粒感
        }
        nctx.putImageData(imgData, 0, 0);
        this.noiseCanvas = nc;
    }

    resize(w, h) {
        this.width = w;
        this.height = h;
        if (this.canvas) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    }

    setTheme(colorHex, aiTheme = {}) {
        if (!colorHex) return;
        const rgb = this.hexToRgb(colorHex);
        if (rgb) {
            this.targetTheme.accent = rgb;
            this.targetTheme.silkLight = [
                Math.min(255, Math.round(rgb[0] * 0.8 + 80)),
                Math.min(255, Math.round(rgb[1] * 0.8 + 80)),
                Math.min(255, Math.round(rgb[2] * 0.8 + 80))
            ];
            this.targetTheme.silkMid = [
                Math.round(rgb[0] * 0.45),
                Math.round(rgb[1] * 0.45),
                Math.round(rgb[2] * 0.45)
            ];
            this.targetTheme.silkDark = [
                Math.round(rgb[0] * 0.15),
                Math.round(rgb[1] * 0.15),
                Math.round(rgb[2] * 0.18)
            ];
        }
    }

    hexToRgb(hex) {
        if (!hex || typeof hex !== 'string') return null;
        const clean = hex.replace('#', '');
        if (clean.length === 3) {
            return [
                parseInt(clean[0] + clean[0], 16),
                parseInt(clean[1] + clean[1], 16),
                parseInt(clean[2] + clean[2], 16)
            ];
        }
        if (clean.length === 6) {
            return [
                parseInt(clean.substring(0, 2), 16),
                parseInt(clean.substring(2, 4), 16),
                parseInt(clean.substring(4, 6), 16)
            ];
        }
        return null;
    }

    /**
     * 每帧渲染流体丝绸缎面波纹
     * @param {number} dt 时间增量
     * @param {object} audioData 音频能量数据
     */
    render(dt, audioData = {}) {
        if (!this.ctx || !this.width || !this.height) return;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        const bass = audioData.bass || 0;
        this.time += dt * this.speed * (1.0 + bass * 0.6);

        // 主题色平滑渐变
        for (const k of ['base', 'silkLight', 'silkMid', 'silkDark', 'accent']) {
            for (let c = 0; c < 3; c++) {
                this.theme[k][c] += (this.targetTheme[k][c] - this.theme[k][c]) * 0.04;
            }
        }

        const t = this.time;

        // 1. 深色基底
        const [br, bg, bb] = this.theme.base.map(Math.round);
        ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
        ctx.fillRect(0, 0, w, h);

        const [slr, slg, slb] = this.theme.silkLight.map(Math.round);
        const [smr, smg, smb] = this.theme.silkMid.map(Math.round);
        const [sdr, sdg, sdb] = this.theme.silkDark.map(Math.round);

        // 2. 核心流体丝绸缎面波纹（Silk Ribbon Flow）
        // 渲染 6 层宏大的流动丝绸曲面
        const numRibbons = 6;
        for (let r = 0; r < numRibbons; r++) {
            ctx.save();
            const rPhase = t * 0.5 + r * 1.3;
            const yBase = h * 0.5 + Math.sin(rPhase * 0.7) * (h * 0.15);
            const thickness = h * (0.28 + r * 0.08) * (1.0 + bass * 0.2);

            // 丝绸曲面渐变
            const grad = ctx.createLinearGradient(0, yBase - thickness, w, yBase + thickness);
            const alphaLight = (0.35 - r * 0.04 + bass * 0.15).toFixed(3);
            const alphaMid = (0.22 - r * 0.02).toFixed(3);
            const alphaDark = (0.08).toFixed(3);

            if (r % 2 === 0) {
                grad.addColorStop(0, `rgba(${sdr}, ${sdg}, ${sdb}, ${alphaDark})`);
                grad.addColorStop(0.35, `rgba(${smr}, ${smg}, ${smb}, ${alphaMid})`);
                grad.addColorStop(0.7, `rgba(${slr}, ${slg}, ${slb}, ${alphaLight})`);
                grad.addColorStop(1, `rgba(${sdr}, ${sdg}, ${sdb}, 0)`);
            } else {
                grad.addColorStop(0, `rgba(${slr}, ${slg}, ${slb}, ${alphaLight})`);
                grad.addColorStop(0.5, `rgba(${smr}, ${smg}, ${smb}, ${alphaMid})`);
                grad.addColorStop(0.85, `rgba(${sdr}, ${sdg}, ${sdb}, ${alphaDark})`);
                grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            }

            ctx.fillStyle = grad;
            ctx.beginPath();

            // 上边缘曲线 (Top Silk Crest)
            const step = Math.max(20, Math.floor(w / 35));
            ctx.moveTo(0, h + 50);
            ctx.lineTo(0, yBase - thickness * 0.5);

            for (let x = 0; x <= w + step; x += step) {
                const nx = x / w;
                // 复杂域扭曲波动方程 (Domain-warped wave formula)
                const wave1 = Math.sin(nx * 3.5 + rPhase * 0.9) * 80;
                const wave2 = Math.cos(nx * 7.0 - rPhase * 1.4) * 45;
                const wave3 = Math.sin(nx * 12.0 + rPhase * 2.2) * 20;
                const silkY = yBase - thickness * 0.5 + wave1 + wave2 + wave3;
                ctx.lineTo(x, silkY);
            }

            // 下边缘闭合
            ctx.lineTo(w, h + 50);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        // 3. 丝绸细致高光纹理线条 (Silk Sheen Ribs)
        ctx.save();
        for (let s = 0; s < 5; s++) {
            ctx.beginPath();
            const sPhase = t * 0.6 + s * 1.5;
            const startY = h * (0.25 + s * 0.14);
            const step = Math.max(15, Math.floor(w / 40));

            for (let x = 0; x <= w + step; x += step) {
                const nx = x / w;
                const wave = Math.sin(nx * 4.0 + sPhase) * 90 + Math.cos(nx * 8.5 - sPhase * 1.3) * 50;
                const sy = startY + wave;
                if (x === 0) ctx.moveTo(x, sy);
                else ctx.lineTo(x, sy);
            }

            ctx.lineWidth = 1.8 + s * 0.5;
            const lineAlpha = (0.18 + (audioData.treble || 0) * 0.25).toFixed(3);
            ctx.strokeStyle = `rgba(${slr}, ${slg}, ${slb}, ${lineAlpha})`;
            ctx.stroke();
        }
        ctx.restore();

        // 4. 四周暗角 (Vignette Shadow)
        const vigGrad = ctx.createRadialGradient(
            w * 0.5, h * 0.5, Math.min(w, h) * 0.35,
            w * 0.5, h * 0.5, Math.max(w, h) * 0.75
        );
        vigGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vigGrad.addColorStop(0.65, 'rgba(0, 0, 0, 0.35)');
        vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
        ctx.fillStyle = vigGrad;
        ctx.fillRect(0, 0, w, h);

        // 5. 织物细腻胶质颗粒
        if (this.noiseCanvas) {
            ctx.save();
            ctx.globalAlpha = 0.38;
            ctx.fillStyle = ctx.createPattern(this.noiseCanvas, 'repeat');
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    }
}
