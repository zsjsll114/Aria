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

/* ===================== 感知亮度（全仓唯一一份，2026-09-26） =====================
 * 为什么不能用 (0.2126R + 0.7152G + 0.0722B) / 255：那是把 sRGB 的**编码值**当光强算，
 * 而 sRGB 通道本身是 gamma 编码的。实测中灰 (128,128,128) 用这条式子得 0.504，
 * 看起来"一半亮"于是判成亮背景 → 深色墨；但它真实的相对亮度只有 0.216，
 * 背景其实偏暗，深色字直接糊在一起（标题栏三大金刚键「不变色」就是这个）。
 * WCAG 的解码 + 加权才是和人眼对齐的量，所以这里是全仓唯一实现，别再抄第四份。
 * ============================================================================== */

/** sRGB 单通道（0~255）→ 线性光强（0~1） */
export function srgbToLinear(channel8) {
    const c = Math.min(255, Math.max(0, Number(channel8) || 0)) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 相对亮度（0~1，非线性）。入参 0~255 的 r/g/b */
export function relativeLuminance(r, g, b) {
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 对比度（1~21）；两个都传亮度时直接算 */
export function contrastRatio(lumA, lumB) {
    const hi = Math.max(lumA, lumB), lo = Math.min(lumA, lumB);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * 一块背景上该用亮墨还是暗墨。
 * ★ 用「两个候选墨各自的对比度谁更高」判，而不是「亮度过没过某个阈值」：
 *   阈值法在中间调会来回翻，对比度法天然单调、且能给出"其实两边都不够"的信号。
 * ★ 迟滞（hysteresis）：只有**领先幅度反向超过 margin** 才换边，避免封面主色微动时按钮闪。
 *   注意是"想换边时要求更明确的理由"，不是"永远偏向某一边"——写错成后者会让很亮的背景
 *   仍然判成亮墨（第一版就踩了：`if (currentLight && lead < margin) light = true`
 *   在 lead=-11.6 时把 light 又按回 true）。
 * @param {number} bgLuminance 背景相对亮度（0~1）
 * @param {boolean} [currentLight] 当前是亮墨还是暗墨（用于迟滞）
 * @param {number} [margin] 换边所需的对比差，默认 1.6
 * @returns {{light:boolean, lightRatio:number, darkRatio:number, lead:number}}
 */
export function pickInk(bgLuminance, currentLight = true, margin = 1.6) {
    /* 亮墨取近白、暗墨取近黑，和 --titlebar-fg 的两个取值对齐 */
    const lightRatio = contrastRatio(0.96, bgLuminance);
    const darkRatio = contrastRatio(bgLuminance, 0.012);
    const lead = lightRatio - darkRatio;
    let light = lead > 0;
    if (currentLight && lead < 0 && lead > -margin) light = true;
    if (!currentLight && lead > 0 && lead < margin) light = false;
    return { light, lightRatio, darkRatio, lead };
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

/**
 * 名字 → 稳定色相（0~359）。同一个人每次都是同一个颜色。
 *
 * 用途：没有头像的歌手的占位字母牌底色（搜索页歌手卡 + 歌手页头部）。
 * 为什么不用随机色：同一排卡每次搜索颜色都不一样，看起来像没做完；
 * 稳定散列还能让"同一个人在不同页面颜色一致"。
 * 31 是经典的字符串散列乘子（同类实现见 Java String.hashCode 的简化版），
 * 取模 360 直接落在 HSL 色相环上。
 * @param {string} name
 * @returns {number} 0~359
 */
export function hueOfName(name) {
    let h = 0;
    const s = String(name == null ? '' : name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
}
