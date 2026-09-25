/**
 * wordFxSpec.js — PV 词级（block 级）特效的纯参数生成
 *
 * ★ 为什么要从「字级」改成「词级」：
 *   旧实现 `_spawnCharParticles` 挂在**每个字符**变 active 的那一刻，一行十个字
 *   就是 30~50 颗粒子 —— 用户实测判定「杂、不如 folia」。上游 folia 商籁的迸发
 *   元素根本不挂在 glyph 上，而是挂在 **segment（词）级的 guide** 上
 *   （sonnetGuides.ts:77-103），且 guide 的时间窗是「字前 0.2~0.38s 起、字后 0.65s 止」
 *   （:22-29）—— 也就是**提前起势、拖尾收束**，不是唱到才炸。
 *   所以这里补的三件事：词级发射、提前量、以及词级的「星轨」描边。
 *
 * 本文件不含任何 DOM 操作，可被 node --test 直接单测。
 */

/* 形状种类与白尘色由 particleSpec.js 负责，本文件不重复定义（避免两份事实源） */

/** 词级颗粒数：按词的分级给量（上游 hero 给 6、普通 3） */
export function wordBurstCount(scale, isEmotion) {
  if (scale === 'hero') return 6;
  if (isEmotion) return 5;
  return 3;
}

/** 提前量 200~380ms：唱到之前就起势，这是「有编排」和「被动跟随」的分水岭 */
export function wordLeadMs(rnd) {
  return 200 + rnd() * 180;
}

/** 拖尾 650ms（上游 guide 窗口尾部固定值） */
export const WORD_TAIL_MS = 650;

/**
 * 词级发射的**空间包络乘子**：比字级甩得更远、收得更慢。
 * 刻意不重新定义形状/角度/颜色/距离基准 —— 那些仍出自 particleSpec（单一事实源），
 * 这里只给乘子。观感差异全在这几个数上：字级是原地闪一下，词级是甩出去消散。
 * 收尾缩到 0.6 已经写死在 pv.css 的 pv-burst-fly 终态里，不在这里重复一份。
 * @returns {{distMul:number, durMul:number, sizeMul:number}}
 */
export function wordBurstEnvelope(scale) {
  const hero = scale === 'hero';
  return {
    distMul: hero ? 1.9 : 1.55,
    durMul: hero ? 1.35 : 1.15,
    sizeMul: hero ? 1.3 : 1.1,
  };
}

/**
 * 词级「星轨」：一条三次贝塞尔，从词外的起笔点画到词位（上游
 * sonnetGuides.ts:48-66,160-183 —— 控制点取字的入场向量，终点是字本身）。
 * 只出几何，不碰 DOM；path 归一化交给渲染层的 pathLength="1"。
 * @param {() => number} rnd
 * @param {{w:number,h:number}} box 词的盒子尺寸（用于把偏移量按字号尺度给）
 * @returns {{d:string, durMs:number}}
 */
export function buildStarTrail(rnd, box) {
  const w = (box && box.w) || 60;
  const h = (box && box.h) || 40;
  /* 起笔点在词的左上或右下（交替），距离 1.2~2.2 倍字高 */
  const side = rnd() > 0.5 ? -1 : 1;
  const reach = (1.2 + rnd() * 1.0) * h;
  const x0 = w / 2 + side * reach * 0.9;
  const y0 = h / 2 - side * reach * 0.55;
  const x3 = w / 2, y3 = h / 2;                    /* 终点落在词中心 */
  const cx1 = x0 + (x3 - x0) * 0.2 + side * h * 0.35;
  const cy1 = y0 + (y3 - y0) * 0.15 - h * 0.3;
  const cx2 = x0 + (x3 - x0) * 0.62 - side * h * 0.2;
  const cy2 = y3 + h * 0.18;
  const d = `M${x0.toFixed(2)},${y0.toFixed(2)} C${cx1.toFixed(2)},${cy1.toFixed(2)} `
    + `${cx2.toFixed(2)},${cy2.toFixed(2)} ${x3.toFixed(2)},${y3.toFixed(2)}`;
  return { d, durMs: 420 + Math.round(rnd() * 260) };
}

/** 可复现随机源（与 particleSpec 同一实现，测试注入用） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
