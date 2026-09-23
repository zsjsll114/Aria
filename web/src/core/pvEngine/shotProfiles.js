/**
 * shotProfiles.js — PV 构图表（对齐 参考实现 tempera/temperaShotProfiles.ts）
 *
 * 每个 shot（场景）一个构图 profile：
 * - region：歌词排版区域（视口百分比 + 对齐 + 旋转 + 场景字号缩放）
 * - enter：字块入场向量（倍率 × 当前字号 → em）
 * - camera：镜头 travel 与 zoom 斜坡（zoomStart → zoomEnd，随场景进度插值）
 * - mood：构图响度（quiet/neutral/loud）——由场景 kind 决策构图池：
 *   呼吸/尾声(kind=breath/outro) 只用 quiet；副歌/上扬(chorus/lift) 不落 quiet。
 *
 * 纯数据模块：无 DOM、无 Math.random，同一次输入永远同一次输出（确定性）。
 * （数值取自 参考实现 temperaShotProfiles.ts 的真实构图参数）
 */

/** 构图 profile 表：key → { region, enter, camera, mood } */
export const SHOT_PROFILES = {
  'duo-split':       { region: { cx: 0.50, cy: 0.52, w: 0.86, h: 0.46, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: 1.3 }, camera: { travel: 0.11, zoomStart: 1.06, zoomEnd: 1.13 }, mood: 'neutral' },
  'quad-split':      { region: { cx: 0.50, cy: 0.50, w: 0.82, h: 0.40, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0.9, y: 0.9 }, camera: { travel: 0.09, zoomStart: 1.08, zoomEnd: 1.16 }, mood: 'loud' },
  'tri-column':      { region: { cx: 0.50, cy: 0.50, w: 0.70, h: 0.50, align: 'center', rotation: 0, fontScale: 0.95 }, enter: { x: -1.2, y: 0 }, camera: { travel: 0.12, zoomStart: 1.04, zoomEnd: 1.12 }, mood: 'neutral' },
  'thirds-stack':    { region: { cx: 0.50, cy: 0.50, w: 0.80, h: 0.28, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: 1.1 }, camera: { travel: 0.13, zoomStart: 1.03, zoomEnd: 1.11 }, mood: 'neutral' },
  'checker-quad':    { region: { cx: 0.50, cy: 0.50, w: 0.76, h: 0.36, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0.8, y: -0.8 }, camera: { travel: 0.10, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'loud' },
  'corner-wedge':    { region: { cx: 0.44, cy: 0.56, w: 0.68, h: 0.40, align: 'left', rotation: -0.03, fontScale: 1.00 }, enter: { x: -1.4, y: 0.5 }, camera: { travel: 0.10, zoomStart: 1.05, zoomEnd: 1.14 }, mood: 'loud' },
  'diagonal-halves': { region: { cx: 0.50, cy: 0.50, w: 0.78, h: 0.40, align: 'center', rotation: -0.075, fontScale: 1.00 }, enter: { x: 1.1, y: 1.1 }, camera: { travel: 0.12, zoomStart: 1.06, zoomEnd: 1.14 }, mood: 'neutral' },
  'cross-axis':      { region: { cx: 0.50, cy: 0.50, w: 0.66, h: 0.30, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: 1.2 }, camera: { travel: 0.08, zoomStart: 1.12, zoomEnd: 1.03 }, mood: 'loud' },
  'offset-halves':   { region: { cx: 0.50, cy: 0.50, w: 0.80, h: 0.40, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0.9, y: 0.6 }, camera: { travel: 0.11, zoomStart: 1.05, zoomEnd: 1.13 }, mood: 'neutral' },
  'stair-blocks':    { region: { cx: 0.50, cy: 0.50, w: 0.72, h: 0.38, align: 'center', rotation: -0.03, fontScale: 1.00 }, enter: { x: -1, y: 0.8 }, camera: { travel: 0.12, zoomStart: 1.06, zoomEnd: 1.14 }, mood: 'loud' },
  'pillar-gap':      { region: { cx: 0.50, cy: 0.50, w: 0.34, h: 0.62, align: 'center', rotation: 0, fontScale: 0.80 }, enter: { x: 0, y: 1.2 }, camera: { travel: 0.07, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'loud' },
  'corner-quad':     { region: { cx: 0.46, cy: 0.46, w: 0.68, h: 0.36, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: -0.9, y: -0.9 }, camera: { travel: 0.10, zoomStart: 1.07, zoomEnd: 1.15 }, mood: 'neutral' },
  'sliver-stack':    { region: { cx: 0.50, cy: 0.50, w: 0.76, h: 0.30, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 1.2, y: 0 }, camera: { travel: 0.13, zoomStart: 1.04, zoomEnd: 1.12 }, mood: 'neutral' },
  'band-strip':      { region: { cx: 0.50, cy: 0.52, w: 0.78, h: 0.26, align: 'center', rotation: 0, fontScale: 0.92 }, enter: { x: 0.5, y: 1.05 }, camera: { travel: 0.12, zoomStart: 1.03, zoomEnd: 1.10 }, mood: 'neutral' },
  'horizon-band':    { region: { cx: 0.50, cy: 0.36, w: 0.80, h: 0.30, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: -1.1 }, camera: { travel: 0.14, zoomStart: 1.02, zoomEnd: 1.10 }, mood: 'neutral' },
  'deep-dive':       { region: { cx: 0.50, cy: 0.58, w: 0.76, h: 0.34, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: 1.6 }, camera: { travel: 0.16, zoomStart: 1.04, zoomEnd: 1.14 }, mood: 'neutral' },
  'tone-ramp':       { region: { cx: 0.50, cy: 0.50, w: 0.82, h: 0.38, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 1.2, y: 0.4 }, camera: { travel: 0.11, zoomStart: 1.05, zoomEnd: 1.12 }, mood: 'neutral' },
  'double-band':     { region: { cx: 0.50, cy: 0.50, w: 0.78, h: 0.22, align: 'center', rotation: 0, fontScale: 0.88 }, enter: { x: 0.8, y: 0 }, camera: { travel: 0.12, zoomStart: 1.03, zoomEnd: 1.11 }, mood: 'neutral' },
  'tilt-band':       { region: { cx: 0.50, cy: 0.50, w: 0.80, h: 0.26, align: 'center', rotation: -0.10, fontScale: 1.00 }, enter: { x: -1.1, y: 0.5 }, camera: { travel: 0.13, zoomStart: 1.05, zoomEnd: 1.13 }, mood: 'neutral' },
  'edge-rails':      { region: { cx: 0.50, cy: 0.50, w: 0.74, h: 0.40, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: 1 }, camera: { travel: 0.09, zoomStart: 1.02, zoomEnd: 1.09 }, mood: 'quiet' },
  'gradient-wall':   { region: { cx: 0.50, cy: 0.44, w: 0.82, h: 0.36, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0.5, y: -0.9 }, camera: { travel: 0.15, zoomStart: 1.04, zoomEnd: 1.13 }, mood: 'neutral' },
  'terrace':         { region: { cx: 0.46, cy: 0.52, w: 0.72, h: 0.34, align: 'left', rotation: 0, fontScale: 1.00 }, enter: { x: -1.2, y: 0.4 }, camera: { travel: 0.14, zoomStart: 1.05, zoomEnd: 1.12 }, mood: 'neutral' },
  'frame-window':    { region: { cx: 0.50, cy: 0.50, w: 0.64, h: 0.50, align: 'center', rotation: 0, fontScale: 0.95 }, enter: { x: 0, y: 0.95 }, camera: { travel: 0.05, zoomStart: 1.14, zoomEnd: 1.03 }, mood: 'neutral' },
  'double-frame':    { region: { cx: 0.50, cy: 0.50, w: 0.58, h: 0.40, align: 'center', rotation: 0, fontScale: 0.90 }, enter: { x: 0.6, y: 0.6 }, camera: { travel: 0.06, zoomStart: 1.12, zoomEnd: 1.02 }, mood: 'neutral' },
  'circle-window':   { region: { cx: 0.50, cy: 0.50, w: 0.50, h: 0.34, align: 'center', rotation: 0, fontScale: 0.88 }, enter: { x: 0, y: 0.8 }, camera: { travel: 0.05, zoomStart: 1.16, zoomEnd: 1.04 }, mood: 'quiet' },
  'ladder-frame':    { region: { cx: 0.52, cy: 0.50, w: 0.60, h: 0.40, align: 'left', rotation: 0, fontScale: 0.90 }, enter: { x: -0.9, y: 0.6 }, camera: { travel: 0.07, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'quiet' },
  'corner-brackets': { region: { cx: 0.50, cy: 0.50, w: 0.56, h: 0.30, align: 'center', rotation: 0, fontScale: 0.85 }, enter: { x: 0, y: 0.6 }, camera: { travel: 0.04, zoomStart: 1.06, zoomEnd: 1.01 }, mood: 'quiet' },
  'inset-box':       { region: { cx: 0.50, cy: 0.50, w: 0.60, h: 0.42, align: 'center', rotation: 0, fontScale: 0.92 }, enter: { x: 0, y: 0.8 }, camera: { travel: 0.06, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'quiet' },
  'bracket-pair':    { region: { cx: 0.50, cy: 0.50, w: 0.54, h: 0.34, align: 'center', rotation: 0, fontScale: 0.88 }, enter: { x: 1, y: 0 }, camera: { travel: 0.05, zoomStart: 1.08, zoomEnd: 1.01 }, mood: 'quiet' },
  'arch-window':     { region: { cx: 0.50, cy: 0.54, w: 0.50, h: 0.34, align: 'center', rotation: 0, fontScale: 0.86 }, enter: { x: 0, y: 0.9 }, camera: { travel: 0.06, zoomStart: 1.14, zoomEnd: 1.03 }, mood: 'quiet' },
  'grid-cells':      { region: { cx: 0.50, cy: 0.50, w: 0.72, h: 0.22, align: 'center', rotation: 0, fontScale: 0.80 }, enter: { x: 0.7, y: 0.7 }, camera: { travel: 0.07, zoomStart: 1.06, zoomEnd: 1.13 }, mood: 'neutral' },
  'keyhole':         { region: { cx: 0.50, cy: 0.60, w: 0.42, h: 0.30, align: 'center', rotation: 0, fontScale: 0.78 }, enter: { x: 0, y: 1 }, camera: { travel: 0.05, zoomStart: 1.12, zoomEnd: 1.02 }, mood: 'quiet' },
  'poster-panel':    { region: { cx: 0.40, cy: 0.50, w: 0.58, h: 0.62, align: 'left', rotation: -0.045, fontScale: 1.00 }, enter: { x: -1.5, y: 0.35 }, camera: { travel: 0.08, zoomStart: 1.05, zoomEnd: 1.12 }, mood: 'loud' },
  'diamond-stack':   { region: { cx: 0.54, cy: 0.50, w: 0.60, h: 0.42, align: 'right', rotation: 0.035, fontScale: 1.00 }, enter: { x: 1.3, y: -0.5 }, camera: { travel: 0.09, zoomStart: 1.07, zoomEnd: 1.15 }, mood: 'loud' },
  'slash-poster':    { region: { cx: 0.46, cy: 0.50, w: 0.66, h: 0.44, align: 'left', rotation: -0.09, fontScale: 1.00 }, enter: { x: -1.2, y: 1 }, camera: { travel: 0.11, zoomStart: 1.06, zoomEnd: 1.14 }, mood: 'loud' },
  'arrow-wedge':     { region: { cx: 0.50, cy: 0.34, w: 0.72, h: 0.26, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0, y: -1.2 }, camera: { travel: 0.13, zoomStart: 1.04, zoomEnd: 1.13 }, mood: 'loud' },
  'edge-bleed':      { region: { cx: 0.56, cy: 0.50, w: 0.60, h: 0.44, align: 'left', rotation: 0, fontScale: 1.00 }, enter: { x: 1.4, y: 0.3 }, camera: { travel: 0.10, zoomStart: 1.05, zoomEnd: 1.13 }, mood: 'neutral' },
  'triangle-mass':   { region: { cx: 0.50, cy: 0.42, w: 0.68, h: 0.30, align: 'center', rotation: 0, fontScale: 1.00 }, enter: { x: 0.8, y: -1 }, camera: { travel: 0.12, zoomStart: 1.05, zoomEnd: 1.14 }, mood: 'loud' },
  'ribbon-cross':    { region: { cx: 0.50, cy: 0.50, w: 0.62, h: 0.30, align: 'center', rotation: 0.05, fontScale: 1.00 }, enter: { x: -1, y: -0.8 }, camera: { travel: 0.11, zoomStart: 1.08, zoomEnd: 1.16 }, mood: 'loud' },
  'half-disc':       { region: { cx: 0.44, cy: 0.44, w: 0.60, h: 0.34, align: 'left', rotation: 0, fontScale: 1.00 }, enter: { x: -1.3, y: 0.4 }, camera: { travel: 0.10, zoomStart: 1.06, zoomEnd: 1.14 }, mood: 'loud' },
  'stacked-slabs':   { region: { cx: 0.52, cy: 0.50, w: 0.62, h: 0.40, align: 'center', rotation: -0.05, fontScale: 1.00 }, enter: { x: 1.1, y: 0.6 }, camera: { travel: 0.10, zoomStart: 1.07, zoomEnd: 1.15 }, mood: 'loud' },
  'wedge-pair':      { region: { cx: 0.50, cy: 0.50, w: 0.44, h: 0.44, align: 'center', rotation: 0, fontScale: 0.82 }, enter: { x: 0, y: 1.1 }, camera: { travel: 0.09, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'loud' },
  'quiet-line':      { region: { cx: 0.50, cy: 0.50, w: 0.60, h: 0.28, align: 'center', rotation: 0, fontScale: 0.58 }, enter: { x: 0, y: 0.7 }, camera: { travel: 0.03, zoomStart: 1.00, zoomEnd: 1.04 }, mood: 'quiet' },
  'starfield-dots':  { region: { cx: 0.50, cy: 0.50, w: 0.62, h: 0.26, align: 'center', rotation: 0, fontScale: 0.66 }, enter: { x: 0.4, y: 0.5 }, camera: { travel: 0.04, zoomStart: 1.02, zoomEnd: 1.08 }, mood: 'quiet' },
  'ripple-lines':    { region: { cx: 0.50, cy: 0.46, w: 0.66, h: 0.28, align: 'center', rotation: 0, fontScale: 0.72 }, enter: { x: 0, y: 0.9 }, camera: { travel: 0.06, zoomStart: 1.03, zoomEnd: 1.10 }, mood: 'quiet' },
  'hair-grid':       { region: { cx: 0.50, cy: 0.50, w: 0.64, h: 0.26, align: 'center', rotation: 0, fontScale: 0.62 }, enter: { x: 0.4, y: 0.6 }, camera: { travel: 0.04, zoomStart: 1.01, zoomEnd: 1.06 }, mood: 'quiet' },
  'margin-rule':     { region: { cx: 0.54, cy: 0.50, w: 0.62, h: 0.26, align: 'left', rotation: 0, fontScale: 0.66 }, enter: { x: -0.8, y: 0.3 }, camera: { travel: 0.05, zoomStart: 1.02, zoomEnd: 1.07 }, mood: 'quiet' },
  'dot-drift':       { region: { cx: 0.50, cy: 0.48, w: 0.60, h: 0.26, align: 'center', rotation: 0, fontScale: 0.68 }, enter: { x: 0.6, y: 0.6 }, camera: { travel: 0.05, zoomStart: 1.03, zoomEnd: 1.09 }, mood: 'quiet' },
  'arc-sweep':       { region: { cx: 0.50, cy: 0.50, w: 0.60, h: 0.26, align: 'center', rotation: 0, fontScale: 0.70 }, enter: { x: 0, y: 0.8 }, camera: { travel: 0.06, zoomStart: 1.04, zoomEnd: 1.10 }, mood: 'quiet' },
  'blank-page':      { region: { cx: 0.50, cy: 0.50, w: 0.56, h: 0.24, align: 'center', rotation: 0, fontScale: 0.60 }, enter: { x: 0, y: 0.5 }, camera: { travel: 0.03, zoomStart: 1.00, zoomEnd: 1.03 }, mood: 'quiet' },
  // cinema：遮幅窗口，歌词排在保守区域内（任何画幅都不出框）
  'cinema-scope':    { region: { cx: 0.50, cy: 0.50, w: 0.74, h: 0.22, align: 'center', rotation: 0, fontScale: 0.86 }, enter: { x: 0.9, y: 0 }, camera: { travel: 0.09, zoomStart: 1.04, zoomEnd: 1.11 }, mood: 'neutral' },
  'cinema-wide':     { region: { cx: 0.50, cy: 0.50, w: 0.70, h: 0.30, align: 'center', rotation: 0, fontScale: 0.90 }, enter: { x: 0, y: 0.9 }, camera: { travel: 0.08, zoomStart: 1.06, zoomEnd: 1.13 }, mood: 'neutral' },
  'cinema-academy':  { region: { cx: 0.50, cy: 0.50, w: 0.50, h: 0.40, align: 'center', rotation: 0, fontScale: 0.88 }, enter: { x: 0, y: 0.8 }, camera: { travel: 0.06, zoomStart: 1.10, zoomEnd: 1.02 }, mood: 'quiet' },
  'cinema-square':   { region: { cx: 0.50, cy: 0.50, w: 0.42, h: 0.40, align: 'center', rotation: 0, fontScale: 0.84 }, enter: { x: 0.7, y: 0.7 }, camera: { travel: 0.05, zoomStart: 1.12, zoomEnd: 1.03 }, mood: 'quiet' },
  'cinema-portrait': { region: { cx: 0.50, cy: 0.50, w: 0.32, h: 0.46, align: 'center', rotation: 0, fontScale: 0.80 }, enter: { x: 0, y: 1 }, camera: { travel: 0.06, zoomStart: 1.08, zoomEnd: 1.16 }, mood: 'neutral' },
  'cinema-tall':     { region: { cx: 0.50, cy: 0.50, w: 0.24, h: 0.50, align: 'center', rotation: 0, fontScale: 0.72 }, enter: { x: 0.8, y: 0.4 }, camera: { travel: 0.07, zoomStart: 1.05, zoomEnd: 1.14 }, mood: 'neutral' },
  'cinema-twin':     { region: { cx: 0.33, cy: 0.50, w: 0.30, h: 0.32, align: 'center', rotation: 0, fontScale: 0.76 }, enter: { x: -0.9, y: 0.3 }, camera: { travel: 0.08, zoomStart: 1.06, zoomEnd: 1.13 }, mood: 'neutral' },
  // charm 圆滑族：圆泡/云窗/心/星光/花瓣
  'bubble-drift':    { region: { cx: 0.50, cy: 0.50, w: 0.72, h: 0.36, align: 'center', rotation: 0, fontScale: 0.92 }, enter: { x: 0.5, y: 1 }, camera: { travel: 0.09, zoomStart: 1.05, zoomEnd: 1.12 }, mood: 'neutral' },
  'cloud-window':    { region: { cx: 0.50, cy: 0.52, w: 0.46, h: 0.30, align: 'center', rotation: 0, fontScale: 0.84 }, enter: { x: 0, y: 0.8 }, camera: { travel: 0.05, zoomStart: 1.14, zoomEnd: 1.03 }, mood: 'quiet' },
  'heart-burst':     { region: { cx: 0.50, cy: 0.52, w: 0.50, h: 0.30, align: 'center', rotation: 0, fontScale: 0.95 }, enter: { x: 0.8, y: 0.8 }, camera: { travel: 0.10, zoomStart: 1.08, zoomEnd: 1.16 }, mood: 'loud' },
  'sparkle-field':   { region: { cx: 0.50, cy: 0.48, w: 0.64, h: 0.26, align: 'center', rotation: 0, fontScale: 0.70 }, enter: { x: 0.4, y: 0.6 }, camera: { travel: 0.04, zoomStart: 1.02, zoomEnd: 1.08 }, mood: 'quiet' },
  'petal-arc':       { region: { cx: 0.50, cy: 0.60, w: 0.70, h: 0.30, align: 'center', rotation: 0, fontScale: 0.90 }, enter: { x: 0, y: 1.1 }, camera: { travel: 0.10, zoomStart: 1.04, zoomEnd: 1.12 }, mood: 'neutral' },
};

/** 按 mood 分池：kind → 构图池（确定性轮换用） */
export const SHOT_PROFILE_POOLS = (() => {
  const byMood = { quiet: [], neutral: [], loud: [] };
  for (const key of Object.keys(SHOT_PROFILES)) {
    const p = SHOT_PROFILES[key];
    byMood[p.mood || 'neutral'].push({ key, ...p });
  }
  // 每个 mood 池内确定性顺序：按 key 排序（跨平台一致）
  for (const k of Object.keys(byMood)) byMood[k].sort((a, b) => (a.key < b.key ? -1 : 1));
  return byMood;
})();

/**
 * ★ 构图方向（用户反馈：排版方向与构图选取原本是两套独立轮换，看起来没规律）。
 * 对齐 参考实现 sonnet/tempera：方向是构图（shot）自身的属性，不再单独决策。
 * 自动派生：region 宽高比 ≤ 1.15 的窄高区域 → vertical（竖排行住窄高窗），
 * 其余 → horizontal。与 SHOT_PROFILE_POOLS 同步派生一次。
 */
export const SHOT_PROFILE_POOLS_ORIENTED = (() => {
  const out = {};
  for (const [mood, pool] of Object.entries(SHOT_PROFILE_POOLS)) {
    out[mood] = pool.map(p => ({
      ...p,
      orientation: ((p.region.w || 1) / (p.region.h || 1)) <= 1.15 ? 'vertical' : 'horizontal',
    }));
  }
  return out;
})();

/** FNV-1a 32 位哈希（参考实现 temperaRandom 同款思路）：确定性、跨平台一致 */
export function hashShotSeed(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * ★ 池内确定性选取 + 不与上一镜重复（参考实现 temperaRandom.chooseWithoutRepeat 同款）：
 * 哈希定起点线性扫描，跳过 previous——同一首歌每次重播版式完全一致（seek 安全），
 * 相邻两镜不重样（用户感知为「有规律但会变」）。
 */
export function chooseShotWithoutRepeat(candidates, seed, previousKey) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const start = hashShotSeed(seed) % candidates.length;
  for (let off = 0; off < candidates.length; off++) {
    const c = candidates[(start + off) % candidates.length];
    if (c.key !== previousKey) return c;
  }
  return candidates[start];
}

/** 场景 kind → 允许的 mood 集合（上游参考项目：呼吸/尾声只用 quiet；副歌/上扬绝不用 quiet） */
const KIND_MOODS = {
  chorus: ['loud', 'neutral'],
  lift: ['loud', 'neutral'],
  break: ['neutral', 'loud'],
  verse: ['neutral', 'quiet'],
  breath: ['quiet', 'neutral'],
  outro: ['quiet', 'neutral'],
};

/**
 * ★ 确定性选取构图（可跨场景轮换）
 * @param {number} sceneIndex 场景序号
 * @param {string} kind 场景 kind（chorus/verse/breath/outro/lift/break）
 * @returns {Object} { key, region, enter, camera, mood }
 */
export function pickShotProfile(sceneIndex, kind = 'verse') {
  const moods = KIND_MOODS[kind] || KIND_MOODS.verse;
  const pool = SHOT_PROFILE_POOLS[moods[sceneIndex % moods.length]] || SHOT_PROFILE_POOLS.neutral;
  return pool[Math.abs(sceneIndex) % pool.length];
}

/**
 * ★ 新版选取（参考实现 sonnet/tempera 对齐）：语义分池 + 方向闸门 + 内容哈希 + 不重复。
 * - 候选 = kind 允许的全部 mood 池并集；
 * - allowVertical=false（行过长放不下竖排窗）时剔除 vertical 构图——闸门本身确定，
 *   同一行文本永远同一判定；
 * - seed = 歌曲标识:段落序:段落文本（调用方拼），FNV 哈希定起点，跳过 prevKey。
 * @returns {Object|null} { key, region, enter, camera, mood, orientation }
 */
export function pickShotProfileV2(sceneIndex, kind, opts = {}) {
  const moods = KIND_MOODS[kind] || KIND_MOODS.verse;
  const oriented = SHOT_PROFILE_POOLS_ORIENTED;
  let candidates = [];
  const seen = new Set();
  for (const m of moods) {
    for (const p of (oriented[m] || [])) {
      if (!seen.has(p.key)) { seen.add(p.key); candidates.push(p); }
    }
  }
  if (candidates.length === 0) candidates = oriented.neutral || [];
  if (opts.allowVertical === false) {
    const horiz = candidates.filter(p => p.orientation === 'horizontal');
    if (horiz.length > 0) candidates = horiz;
  }
  const seed = `${opts.songSeed || ''}:${sceneIndex}:${opts.seedText || ''}`;
  return chooseShotWithoutRepeat(candidates, seed, opts.prevKey || null);
}

/** handoff 时长（上游参考项目：shot 时长 × 0.3，钳 0.4~1.1s） */
export const handoffDurationSec = (shotDurationMs) => {
  const d = Math.max(200, shotDurationMs || 1000);
  return Math.max(0.4, Math.min(1.1, d / 1000 * 0.3));
};