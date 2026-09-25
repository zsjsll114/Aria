/**
 * PVArcField.js — 演唱进度驱动的长弧笔触（商籁「一笔挥过去」的那一半）
 *
 * 与上一版四层场的区别就是这一层的存在理由（用户实测三条判定）：
 *   ① 不再当整幅底图用，只作**点缀层**叠在 shapeField 的实心块 + icon 之上；
 *   ② 揭示量是 **f(演唱进度)**，不是 f(墙钟)——暂停即停、seek 即跳，
 *      因为它是 `--p` 这个 CSS 变量的纯函数，浏览器自己算，JS 每帧只写一个数；
 *   ③ 只有 3 条**长而连续**的弧（每条张角 ≥130°，一条 path 就是一次挥笔），
 *      不再一次吐十几根短射线。
 *
 * 弧长参数化沿用 shapeField 那套：注入 pathLength="1" 归一化，
 * 于是 dashoffset 直接就是「已画比例」，不需要 getTotalLength()。
 */

const VB_W = 160;
const VB_H = 90;
const MARGIN = 5;

/** 三条弧：一条主笔、两条辅笔。再多就开始「杂」了 */
export const ARC_COUNT = 3;
/** 单条弧最小张角（度）——短弧就没有「挥」的感觉了 */
export const MIN_SPAN_DEG = 130;

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 半径按「到最近边缘的距离」夹住，保证整弧在画面内（上一版就是栽在这里） */
function fitRadius(cx, cy, want) {
  const toEdge = Math.min(cx - MARGIN, VB_W - MARGIN - cx, cy - MARGIN, VB_H - MARGIN - cy);
  return Math.max(4, Math.min(want, Math.max(4, toEdge)));
}

/** 圆心避开画面正中——中间是歌词，笔触叠上去会糊 */
function safeCenter(rnd) {
  let cx = VB_W * (0.14 + rnd() * 0.72);
  let cy = VB_H * (0.16 + rnd() * 0.68);
  if (cx > VB_W * 0.32 && cx < VB_W * 0.68 && cy > VB_H * 0.34 && cy < VB_H * 0.66) {
    cy = cy < VB_H / 2 ? VB_H * (0.1 + rnd() * 0.14) : VB_H * (0.76 + rnd() * 0.14);
  }
  return [cx, cy];
}

function arcPath(cx, cy, r, a0, a1) {
  const rad = (a) => (a * Math.PI) / 180;
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0));
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1));
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

/**
 * 生成三条弧。
 * @param {string|number} seed 歌曲级种子（同曲稳定）
 * @returns {{html:string, arcs:Array<{d:string,a0:number,a1:number,R:number}>}}
 */
export function buildArcFieldHTML(seed = 0) {
  const rnd = mulberry32(hash32(String(seed) + '#arc'));
  const arcs = [];
  /* 三条弧**共用一个圆心**、半径递缩：实测各给一个圆心时，部分揭示的弧
     读起来是几段互不相干的碎线；同心之后才像「同一笔挥过去、挥到一半」。 */
  const [cx, cy] = safeCenter(rnd);
  const R0 = fitRadius(cx, cy, 26 + rnd() * 14);
  /* 时间窗：依次揭开，各占 ~1/3 并留 12% 重叠，避免一段一段冒出来的分段感 */
  const slice = 1 / (ARC_COUNT + (ARC_COUNT - 1) * 0.5);
  const base = rnd() * 360;
  for (let i = 0; i < ARC_COUNT; i++) {
    const R = R0 * (1 - i * 0.22);
    const a0 = base + i * (40 + rnd() * 50);
    const span = MIN_SPAN_DEG + rnd() * (260 - MIN_SPAN_DEG);
    const from = i * slice * 1.5;
    const to = Math.min(1, from + slice * 2);
    const rad = (a) => (a * Math.PI) / 180;
    arcs.push({
      cx, cy, R, span,
      /* 圆点落在**这条弧的起笔处**，不是圆心——同心之后若还用 (cx,cy) 会三点重叠 */
      sx: cx + R * Math.cos(rad(a0)), sy: cy + R * Math.sin(rad(a0)),
      d: arcPath(cx, cy, R, a0, a0 + span),
      a0: +from.toFixed(4),
      a1: +to.toFixed(4),
    });
  }
  const paths = arcs.map(a =>
    `<path d="${a.d}" pathLength="1" style="--a0:${a.a0};--a1:${a.a1}" />`
  ).join('');
  /* 每条弧起笔处一枚实心点：给这一层一点「重量」，不要全是线 */
  const dots = arcs.map(a =>
    `<circle class="pv-arc-dot" cx="${a.sx.toFixed(2)}" cy="${a.sy.toFixed(2)}" r="1.6" />`
  ).join('');
  return {
    html: `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid slice" fill="none" `
      + `stroke="currentColor" aria-hidden="true">${paths}${dots}</svg>`,
    arcs,
  };
}
