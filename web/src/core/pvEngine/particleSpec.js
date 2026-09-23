/**
 * particleSpec.js — PV 逐字迸发粒子（参考实现 sonnet shapeBurst）的纯参数生成
 *
 * 与 PVRendering._spawnCharParticles 共用：给定随机源 rnd 与循环序号 i，
 * 产出一颗粒子的全部随机参数（形状/角度/距离/时长/大小/白尘概率/旋转），
 * 不含任何 DOM 操作 —— 因此可被 node --test 直接单测（纯装饰、不影响布局）。
 * 随机消耗顺序与旧实现逐位一致（count → kind → angle → dist → dur → size →
 * bl → 白尘 → rotate），更换实现时勿打乱，否则渲染分布会变。
 */

export const PARTICLE_KINDS = ['dot', 'square', 'cross', 'dia'];
export const WHITE_DUST = 'rgba(255, 255, 255, 0.85)';

/** 每字符迸发颗粒数：3~5 颗（先消耗一次随机） */
export function burstCount(rnd) {
    return 3 + Math.floor(rnd() * 3);
}

/**
 * 生成一颗粒子的完整随机规格（纯函数）。
 * @param {() => number} rnd       随机源（[0,1)）；生产传 Math.random，测试传 seeded
 * @param {number} i               循环序号（保证四形状轮转混排）
 * @param {string} [highlight]     行高亮基准色
 * @returns {{kind:string, angle:number, dist:number, dur:number, size:number,
 *            bl:number, color:string, tx:number, ty:number, alpha:number, rotateDeg:number}}
 */
export function buildBurstParticle(rnd, i, highlight = '#ffcc33') {
    const kind = PARTICLE_KINDS[(Math.floor(rnd() * PARTICLE_KINDS.length) + i) % PARTICLE_KINDS.length];
    const angle = rnd() * Math.PI * 2;              /* 任意方位角 */
    const dist = 0.55 + rnd() * 1.5;                /* 迸发距离 0.55~2.05em（随字号缩放） */
    const dur = 0.9 + rnd() * 0.5;                  /* 单向寿命 0.9~1.4s */
    const size = 1.8 + rnd() * 2.8;                 /* 细尘 1.8~4.6px */
    const bl = 0.02 + rnd() * 0.05;                 /* 微错峰 */
    const color = (kind !== 'cross' && rnd() < 0.22) ? WHITE_DUST : highlight;  /* 22% 白尘 */
    return {
        kind,
        angle, dist, dur, size, bl, color,
        tx: Math.cos(angle) * dist,                 /* 上游参考项目 终态：直线终点（渲染层 toFixed(2)em） */
        ty: Math.sin(angle) * dist,
        alpha: kind === 'cross' ? 0.65 : 0.85,
        rotateDeg: (rnd() - 0.5) * 60,              /* 小角度扫旋 ±30° */
    };
}

/** 可复现随机源（mulberry32），供单测注入确定性种子 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}