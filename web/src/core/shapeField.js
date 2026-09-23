/**
 * shapeField.js — folia 式全屏图形场（对齐上游 GeometricBackground.tsx 实现）
 * 15 个图形：30% 概率 icon（上限 6 个）+ 圆/方/三角/十字基础几何 + 20 个上浮粒子；
 * 全部极淡（0.11~0.19）、极慢漂移旋转（20~60s linear）、icon 呼吸淡入淡出；
 * 纯 CSS 动画，DOM 歌曲级持久，不随 shot 重建。icon 图形数据来自 lucide-static (ISC)。
 */

const ICON_PATHS = {
  'album': '<svg class="lucide lucide-album" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><polyline points="11 3 11 11 14 8 17 11 17 3" />',
  'audio-waveform': '<svg class="lucide lucide-audio-waveform" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2" />',
  'disc-2': '<svg class="lucide lucide-disc-2" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><path d="M12 12h.01" />',
  'disc-3': '<svg class="lucide lucide-disc-3" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="12" cy="12" r="10" /><path d="M6 12c0-1.7.7-3.2 1.8-4.2" /><circle cx="12" cy="12" r="2" /><path d="M18 12c0 1.7-.7 3.2-1.8 4.2" />',
  'guitar': '<svg class="lucide lucide-guitar" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="m11.9 12.1 4.514-4.514" /><path d="M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z" /><path d="m6 16 2 2" /><path d="M8.2 9.9C8.7 8.8 9.8 8 11 8c2.8 0 5 2.2 5 5 0 1.2-.8 2.3-1.9 2.8l-.9.4A2 2 0 0 0 12 18a4 4 0 0 1-4 4c-3.3 0-6-2.7-6-6a4 4 0 0 1 4-4 2 2 0 0 0 1.8-1.2z" /><circle cx="11.5" cy="12.5" r=".5" fill="currentColor" />',
  'headphones': '<svg class="lucide lucide-headphones" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />',
  'music-2': '<svg class="lucide lucide-music-2" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="8" cy="18" r="4" /><path d="M12 18V2l7 4" />',
  'music-3': '<svg class="lucide lucide-music-3" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="12" cy="18" r="4" /><path d="M16 18V2" />',
  'music-4': '<svg class="lucide lucide-music-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M9 18V5l12-2v13" /><path d="m9 9 12-2" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />',
  'music': '<svg class="lucide lucide-music" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />',
  'piano': '<svg class="lucide lucide-piano" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M18.5 8c-1.4 0-2.6-.8-3.2-2A6.87 6.87 0 0 0 2 9v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8.5C22 9.6 20.4 8 18.5 8" /><path d="M2 14h20" /><path d="M6 14v4" /><path d="M10 14v4" /><path d="M14 14v4" /><path d="M18 14v4" />',
  'radio': '<svg class="lucide lucide-radio" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" /><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />',
  'sparkles': '<svg class="lucide lucide-sparkles" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" />',
  'speaker': '<svg class="lucide lucide-speaker" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><rect width="16" height="20" x="4" y="2" rx="2" /><path d="M12 6h.01" /><circle cx="12" cy="14" r="4" /><path d="M12 14h.01" />'
};

/** mulberry32 确定性伪随机：同一 seed 布局稳定 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SHAPES = ['circle', 'square', 'triangle', 'cross'];
const ICON_KEYS = Object.keys(ICON_PATHS);

/**
 * 生成图形场 HTML。同一 seed 输出完全一致（歌曲级调用一次，不随 shot 重建）。
 * @param {number|string} seed 稳定种子（如歌曲 id hash）
 * @returns {string} 容器 innerHTML
 */
export function buildShapeFieldHTML(seed = 0) {
  const rnd = mulberry32(typeof seed === 'string'
    ? Array.from(String(seed)).reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7)
    : seed);
  const parts = [];
  let iconCount = 0;
  for (let i = 0; i < 15; i++) {
    const wantIcon = rnd() > 0.7 && iconCount < 6;
    if (wantIcon) iconCount++;
    const x = (rnd() * 100).toFixed(2), y = (rnd() * 100).toFixed(2);
    const size = Math.round(40 + rnd() * 100);
    const dur = (wantIcon ? 20 + rnd() * 20 : 30 + rnd() * 30).toFixed(1);
    const delay = (rnd() * 5).toFixed(2);
    const rot = Math.round(rnd() * 360);
    const dx = Math.round(rnd() > 0.5 ? 15 : -15);
    const dy = Math.round(rnd() > 0.5 ? 30 : -30);
    if (wantIcon) {
      const key = ICON_KEYS[Math.floor(rnd() * ICON_KEYS.length)];
      const op = (0.11 + rnd() * 0.08).toFixed(3);
      const breathe = (10 + rnd() * 10).toFixed(1);
      parts.push(`<div class="pv-shape pv-shape--icon" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;--dur:${dur}s;--delay:${delay}s;--rot0:${rot}deg;--dx:${dx}px;--dy:${dy}px;--op:${op};--breathe:${breathe}s;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</svg></div>`);
    } else {
      const type = BASE_SHAPES[Math.floor(rnd() * BASE_SHAPES.length)];
      const op = (0.11 + rnd() * 0.08).toFixed(3);
      const filled = rnd() < 0.3;
      parts.push(`<div class="pv-shape pv-shape--${type}${filled ? ' is-filled' : ''}" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;--dur:${dur}s;--delay:${delay}s;--rot0:${rot}deg;--dx:${dx}px;--dy:${dy}px;--op:${op};"></div>`);
    }
  }
  for (let p = 0; p < 20; p++) {
    const left = (rnd() * 100).toFixed(2), top = (rnd() * 100).toFixed(2);
    const size = (1 + rnd() * 4).toFixed(1);
    const op = (rnd() * 0.3).toFixed(2);
    const dur = (15 + rnd() * 20).toFixed(1);
    const delay = (rnd() * 10).toFixed(1);
    parts.push(`<div class="pv-shape-particle" style="left:${left}%;top:${top}%;width:${size}px;height:${size}px;--op:${op};--dur:${dur}s;--delay:${delay}s;"></div>`);
  }
  return parts.join('');
}
