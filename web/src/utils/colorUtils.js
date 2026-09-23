/** utils/colorUtils.js — 颜色空间转换 & 饱和度/亮度优化 */
export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return [h, s, l];
}

export function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return [r * 255, g * 255, b * 255];
}

export function hexToRgb(hex) {
    if (!hex || !hex.startsWith('#')) return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
}

export function adjustColorLightness(hex, targetLightness) {
    if (!hex || !hex.startsWith('#')) return hex;
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const [r, g, b] = rgb;
    const [h, s] = rgbToHsl(r, g, b);
    const [newR, newG, newB] = hslToRgb(h, s, targetLightness);
    return '#' + [newR, newG, newB].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

/** 降低颜色饱和度到 75% 以下，保持亮度不变，使 AI 主题色更高级 */
export function refineColor(hex) {
    if (!hex || !hex.startsWith('#')) return hex;
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const [r, g, b] = rgb;
    const hsl = rgbToHsl(r, g, b);
    const refinedHsl = [hsl[0], Math.min(hsl[1], 0.75), hsl[2]];
    const refinedRgb = hslToRgb(refinedHsl[0], refinedHsl[1], refinedHsl[2]);
    return '#' + refinedRgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}


/**
 * 从封面图片提取 3 色调色盘（主色、副色、强调色）并优化饱和度
 * @param {HTMLImageElement} img 
 * @returns {{ primary: string, secondary: string, accent: string }}
 */
export function extractCoverPalette(img) {
    if (!img) return { primary: '#3a86ff', secondary: '#ff006e', accent: '#ffbe0b' };
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const w = 40, h = 40;
        canvas.width = w; canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        
        let r1 = 0, g1 = 0, b1 = 0, c1 = 0;
        let r2 = 0, g2 = 0, b2 = 0, c2 = 0;
        let r3 = 0, g3 = 0, b3 = 0, c3 = 0;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                if (data[idx + 3] < 128) continue;
                const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                if (y < h / 2 && x < w / 2) {
                    r1 += r; g1 += g; b1 += b; c1++;
                } else if (y > h / 3 && y < 2 * h / 3 && x > w / 3 && x < 2 * w / 3) {
                    r2 += r; g2 += g; b2 += b; c2++;
                } else {
                    r3 += r; g3 += g; b3 += b; c3++;
                }
            }
        }

        const toHex = (r, g, b, count, def) => {
            if (count === 0) return def;
            const avgR = Math.round(r / count);
            const avgG = Math.round(g / count);
            const avgB = Math.round(b / count);
            return '#' + [avgR, avgG, avgB].map(x => x.toString(16).padStart(2, '0')).join('');
        };

        const primary = toHex(r1, g1, b1, c1, '#3a86ff');
        const secondary = toHex(r2, g2, b2, c2, '#ff006e');
        const accent = toHex(r3, g3, b3, c3, '#ffbe0b');

        return { primary, secondary, accent };
    } catch (e) {
        return { primary: '#3a86ff', secondary: '#ff006e', accent: '#ffbe0b' };
    }
}
