/* ============================================================
 * focalcutPalette.js — 「镜幕 · FocalCut」专辑取色 & 双极电影级光学色板
 *
 * 从当前专辑封面抽取主色与辅色，生成两极高质感光学舞台令牌：
 *   - dark  (曜石暗房): 极深色染曜石底 + 暖白主字 + 封面流光主色 + 副视口反色暖纸
 *   - light (银盐画廊): 暖灰棉纸底 + 炭黑精印主字 + 高对比主色 + 副视口反色曜石
 * 不写死单一主题色；无封面或跨域受限时安全回退 CSS 变量 / 传入主题色。
 * ============================================================ */

import { getCoverLayers } from '../../../infrastructure/dom.js';

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

function normalizeAccent(rgb, forLightWall) {
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const ns = clamp(s < 0.24 ? 0.58 : s * 1.18, 0.44, 0.92);
  const nl = forLightWall ? clamp(l, 0.34, 0.46) : clamp(l, 0.60, 0.74);
  const out = hslToRgb(h, ns, nl);
  return rgbToHex(out[0], out[1], out[2]);
}

function contrastOnHex(hex) {
  const rgb = parseHex(hex) || [232, 190, 106];
  const luma = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luma > 0.56 ? '#121318' : '#f7f4ee';
}

/**
 * 从 DOM 封面图采样主色与辅色；安全降级到 CSS 变量 / 传入主题色
 */
export function extractCoverColors(fallbackHex = '#E8BE6A') {
  const rootStyle = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const cssAccent = rootStyle
    ? (rootStyle.getPropertyValue('--cover-accent').trim() || rootStyle.getPropertyValue('--aria-accent').trim())
    : '';
  const baseRgb = parseHex(cssAccent) || parseHex(fallbackHex) || [232, 190, 106];

  let primaryRgb = baseRgb;
  let secondaryRgb = null;

  try {
    if (typeof document !== 'undefined') {
      const layers = getCoverLayers ? getCoverLayers() : null;
      const candidates = [
        layers && layers.main,
        document.getElementById('coverImage'),
        document.querySelector('.album-cover img'),
        document.querySelector('.preview-cover-area img'),
      ].filter(Boolean);

      for (const img of candidates) {
        if (!img || !img.complete || !(img.naturalWidth > 0)) continue;
        const cv = document.createElement('canvas');
        cv.width = 24;
        cv.height = 24;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 160) continue;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const [, s, l] = rgbToHsl(r, g, b);
          if (l < 0.09 || l > 0.92 || s < 0.14) continue;
          const key = `${r >> 5}_${g >> 5}_${b >> 5}`;
          const prev = buckets.get(key) || { score: 0, r: 0, g: 0, b: 0, n: 0 };
          prev.score += (0.5 + s * 1.6);
          prev.r += r; prev.g += g; prev.b += b; prev.n += 1;
          buckets.set(key, prev);
        }
        const sorted = [...buckets.values()].sort((a, b) => b.score - a.score);
        if (sorted.length > 0) {
          const p = sorted[0];
          primaryRgb = [p.r / p.n, p.g / p.n, p.b / p.n];
          if (sorted.length > 1) {
            const q = sorted[1];
            secondaryRgb = [q.r / q.n, q.g / q.n, q.b / q.n];
          }
          break;
        }
      }
    }
  } catch { /* 跨域封面图片无法读像素时静默回退 CSS 变量色 */ }

  if (!secondaryRgb) {
    const [h, s, l] = rgbToHsl(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
    secondaryRgb = hslToRgb((h + 0.44) % 1, clamp(s, 0.46, 0.85), clamp(l, 0.48, 0.68));
  }

  return {
    primaryHex: rgbToHex(primaryRgb[0], primaryRgb[1], primaryRgb[2]),
    secondaryHex: rgbToHex(secondaryRgb[0], secondaryRgb[1], secondaryRgb[2]),
  };
}

function buildSinglePole(isLight, pRgb, sRgb) {
  const accent = normalizeAccent(pRgb, isLight);
  const secondary = normalizeAccent(sRgb, isLight);
  const [h] = rgbToHsl(pRgb[0], pRgb[1], pRgb[2]);
  const [h2] = rgbToHsl(sRgb[0], sRgb[1], sRgb[2]);

  if (isLight) {
    const [wr, wg, wb] = hslToRgb(h, 0.12, 0.915);
    const [sr, sg, sb] = hslToRgb(h, 0.14, 0.865);
    const [er, eg, eb] = hslToRgb(h2, 0.10, 0.82);
    return {
      polarity: 'light',
      wallBg: rgbToHex(wr, wg, wb),
      wallSurface: rgbToHex(sr, sg, sb),
      wallEdge: rgbToHex(er, eg, eb),
      gridLine: 'rgba(18, 20, 26, 0.065)',
      crosshair: 'rgba(18, 20, 26, 0.44)',
      unlitText: 'rgba(18, 20, 26, 0.21)',
      etchStroke: 'rgba(18, 20, 26, 0.22)',
      litText: '#13151b',
      pastText: 'rgba(18, 20, 26, 0.34)',
      accent,
      accentInk: contrastOnHex(accent),
      secondary,
      beamColor: `color-mix(in srgb, ${accent} 18%, transparent)`,
      slitColor: `color-mix(in srgb, ${accent} 58%, transparent)`,
      shutterBg: 'rgba(14, 15, 20, 0.88)',
    };
  }

  const [wr, wg, wb] = hslToRgb(h, 0.20, 0.055);
  const [sr, sg, sb] = hslToRgb(h, 0.22, 0.105);
  const [er, eg, eb] = hslToRgb(h2, 0.24, 0.032);
  return {
    polarity: 'dark',
    wallBg: rgbToHex(wr, wg, wb),
    wallSurface: rgbToHex(sr, sg, sb),
    wallEdge: rgbToHex(er, eg, eb),
    gridLine: 'rgba(247, 244, 238, 0.052)',
    crosshair: 'rgba(247, 244, 238, 0.42)',
    unlitText: 'rgba(247, 244, 238, 0.24)',
    etchStroke: 'rgba(247, 244, 238, 0.24)',
    litText: '#f7f4ee',
    pastText: 'rgba(247, 244, 238, 0.35)',
    accent,
    accentInk: contrastOnHex(accent),
    secondary,
    beamColor: `color-mix(in srgb, ${accent} 22%, transparent)`,
    slitColor: `color-mix(in srgb, ${accent} 74%, #ffffff 26%)`,
    shutterBg: 'rgba(6, 7, 11, 0.90)',
  };
}

/**
 * 构建双极墙面主题令牌（同时产出副视口反色令牌 inv，用于 62/38 双机位分屏）
 * @param {'dark'|'light'} polarity
 * @param {{primaryHex:string, secondaryHex:string}} coverColors
 */
export function buildFocalCutTheme(polarity, coverColors) {
  const isLight = polarity === 'light';
  const pRgb = parseHex(coverColors?.primaryHex) || [232, 190, 106];
  const sRgb = parseHex(coverColors?.secondaryHex) || [104, 174, 232];
  const main = buildSinglePole(isLight, pRgb, sRgb);
  const inv = buildSinglePole(!isLight, pRgb, sRgb);
  return { ...main, inv };
}
