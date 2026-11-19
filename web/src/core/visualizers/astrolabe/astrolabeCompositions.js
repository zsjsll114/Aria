/**
 * web/src/core/visualizers/astrolabe/astrolabeCompositions.js
 * 「画册 · Folio」（mode: astrolabe）—— 9 大家族 × 6 镜 = 54 种巨型破框实色平面构成与版画肌理生成器
 *
 * ★ OPUS 5.5 精调说明：
 * - 所有几何体均转为高精多边形顶点列 `points: Array<{x,y}>`（x 范围约为 -0.5*aspect ~ 1.5*aspect，y 范围约为 -0.5 ~ 1.5）；
 * - `invert: true` 的块面代表「亮色羊皮纸反色面（Paper Mass）」，当它扫过文字时，其内部文字一刀切反转为深邃墨色 `darkInk`；
 * - 严禁屏幕正中小圆圈，所有圆弧/圆环的圆心均在画幅边缘或画幅外，形成极具张力的巨幅版画构成。
 */

import { ASTROLABE_FAMILIES, ASTROLABE_SHOT_KINDS } from './astrolabeProfiles.js';

const TAU = Math.PI * 2;

export function hashAstrolabeSeed(str = '') {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

export function astrolabeHash01(seed, a = 0, b = 0) {
    let h = (Number(seed) ^ Math.imul(Number(a) + 1, 374761393) ^ Math.imul(Number(b) + 1, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function computeBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

/** 生成巨型圆盘或扇形多边形 */
export function buildDiscPolygon(cx, cy, r, startRad = 0, endRad = TAU, steps = 44, includeCenter = false) {
    const pts = [];
    if (includeCenter) pts.push({ x: cx, y: cy });
    for (let i = 0; i <= steps; i++) {
        const a = startRad + ((endRad - startRad) * i) / steps;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
}

/** 生成巨型圆环柱/扇环（Annular Ring / Arc Band）多边形 */
export function buildRingBandPolygon(cx, cy, rInner, rOuter, startRad = 0, endRad = TAU, steps = 44) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a = startRad + ((endRad - startRad) * i) / steps;
        pts.push({ x: cx + Math.cos(a) * rOuter, y: cy + Math.sin(a) * rOuter });
    }
    for (let i = steps; i >= 0; i--) {
        const a = startRad + ((endRad - startRad) * i) / steps;
        pts.push({ x: cx + Math.cos(a) * rInner, y: cy + Math.sin(a) * rInner });
    }
    return pts;
}

/** 生成日食月牙镰刀多边形（外弧 + 偏心内弧咬合） */
export function buildCrescentPolygon(cx, cy, rOuter, innerOffsetX, innerOffsetY, rInner, startRad, endRad, steps = 40) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const a = startRad + ((endRad - startRad) * i) / steps;
        pts.push({ x: cx + Math.cos(a) * rOuter, y: cy + Math.sin(a) * rOuter });
    }
    const icx = cx + innerOffsetX;
    const icy = cy + innerOffsetY;
    for (let i = steps; i >= 0; i--) {
        const a = startRad + ((endRad - startRad) * i) / steps;
        pts.push({ x: icx + Math.cos(a) * rInner, y: icy + Math.sin(a) * rInner });
    }
    return pts;
}

/** 生成任意倾角的跨屏色带（Rotated Constructivist Slab） */
export function buildSlabPolygon(cx, cy, length, thickness, angleRad) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const nx = -sin;
    const ny = cos;
    const hl = length * 0.5;
    const ht = thickness * 0.5;
    return [
        { x: cx - cos * hl - nx * ht, y: cy - sin * hl - ny * ht },
        { x: cx + cos * hl - nx * ht, y: cy + sin * hl - ny * ht },
        { x: cx + cos * hl + nx * ht, y: cy + sin * hl + ny * ht },
        { x: cx - cos * hl + nx * ht, y: cy - sin * hl + ny * ht },
    ];
}

/** 生成倾斜菱形/风筝平面构成块（Tilted Poster Diamond） */
export function buildDiamondPolygon(cx, cy, halfW, halfH, angleRad = 0) {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const rot = (dx, dy) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
    return [
        rot(0, -halfH),
        rot(halfW, 0),
        rot(0, halfH),
        rot(-halfW, 0),
    ];
}

/** 生成构成主义V型屋脊/箭头楔块（Chevron Wedge） */
export function buildChevronPolygon(apexX, apexY, spanW, wingDY, thickness, pointUp = true) {
    const dir = pointUp ? 1 : -1;
    return [
        { x: apexX - spanW, y: apexY + dir * wingDY },
        { x: apexX, y: apexY },
        { x: apexX + spanW, y: apexY + dir * wingDY },
        { x: apexX + spanW, y: apexY + dir * (wingDY + thickness) },
        { x: apexX, y: apexY + dir * thickness },
        { x: apexX - spanW, y: apexY + dir * (wingDY + thickness) },
    ];
}

/** 生成瑞士直角L型折尺梁（6顶点 L-Beam，彻底摆脱圆弧同质化） */
export function buildLBeamPolygon(cx, cy, armW, armH, thickness, rotRad = 0) {
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    const rot = (dx, dy) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
    const t = thickness;
    return [
        rot(0, 0),
        rot(armW, 0),
        rot(armW, t),
        rot(t, t),
        rot(t, armH),
        rot(0, armH),
    ];
}

/** 生成李西茨基 Proun 透视梯形/放射楔形光束（4顶点 Trapezoid Wedge） */
export function buildTrapezoidPolygon(cx, cy, topW, botW, h, rotRad = 0) {
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);
    const rot = (dx, dy) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
    const hh = h * 0.5;
    return [
        rot(-topW * 0.5, -hh),
        rot(topW * 0.5, -hh),
        rot(botW * 0.5, hh),
        rot(-botW * 0.5, hh),
    ];
}

/** 生成硬边正多边形（6角/8角包豪斯门户，非圆弧） */
export function buildRegularNGon(cx, cy, r, sides = 6, rotRad = 0) {
    const pts = [];
    const n = Math.max(3, Math.min(12, sides | 0));
    for (let i = 0; i < n; i++) {
        const a = rotRad + (i / n) * TAU;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
}

/**
 * 构建单个分镜的完整几何构成（54 种分镜各自拥有可辨识的破框构成特征）
 * @param {object} shot
 * @param {number} aspect w / h
 */
export function buildAstrolabeShotGeometry(shot, aspect = 1.7778) {
    const asp = Math.max(0.5, Number(aspect) || 1.7778);
    const seed = hashAstrolabeSeed(`${shot.shotKind || 'eclipse-corona'}:${shot.index || 0}:${shot.seed || 0}`);
    const kindIdx = Math.max(0, ASTROLABE_SHOT_KINDS.indexOf(shot.shotKind));
    const familyIdx = Math.floor(kindIdx / 6);
    const variantIdx = kindIdx % 6;
    const family = ASTROLABE_FAMILIES[familyIdx] || shot.family || 'eclipse';

    const flowRad = typeof shot.flowAngleRad === 'number' ? shot.flowAngleRad : -0.24;
    const flowX = Math.cos(flowRad);
    const flowY = Math.sin(flowRad);

    /** @type {Array<object>} */
    const masses = [];
    /** @type {Array<{x1:number,y1:number,x2:number,y2:number,weight:number,isAccent:boolean}>} */
    const lines = [];
    /** @type {Array<object>} */
    const marks = [];

    const pushMass = (points, opts = {}) => {
        if (!points || points.length < 3) return;
        const idx = masses.length;
        const enterMul = 0.09 + idx * 0.035;
        masses.push({
            points,
            bbox: computeBBox(points),
            invert: Boolean(opts.invert),
            tone: opts.tone ?? (idx % 3),
            isAccent: Boolean(opts.isAccent),
            hasSeam: opts.hasSeam !== false,
            hasHatch: Boolean(opts.hasHatch),
            hatchAngle: opts.hatchAngle ?? (flowRad + Math.PI * 0.25),
            hatchStep: opts.hatchStep ?? 14,
            useCover: Boolean(opts.useCover),
            enterDX: opts.enterDX ?? (-flowX * enterMul),
            enterDY: opts.enterDY ?? (-flowY * enterMul),
            delayFraction: opts.delay ?? Math.min(0.28, idx * 0.07),
            spanFraction: opts.span ?? (0.46 + idx * 0.06),
            creepDX: (astrolabeHash01(seed, idx, 11) - 0.5) * 0.032,
            creepDY: (astrolabeHash01(seed, idx, 17) - 0.5) * 0.032,
        });
    };

    // 偏置锚点：根据 variantIdx 0..5 选择四个破框方位或对角方位，保证同家族 6 个变体构图截然不同
    const corners = [
        { cx: -0.18 * asp, cy: -0.16, sx: 1, sy: 1 },
        { cx: 1.18 * asp,  cy: 1.16,  sx: -1, sy: -1 },
        { cx: 1.16 * asp,  cy: -0.14, sx: -1, sy: 1 },
        { cx: -0.16 * asp, cy: 1.14,  sx: 1, sy: -1 },
        { cx: 0.50 * asp,  cy: -0.42, sx: 0, sy: 1 },
        { cx: 0.50 * asp,  cy: 1.42,  sx: 0, sy: -1 },
    ];
    const c = corners[variantIdx % corners.length];
    const jitterX = (astrolabeHash01(seed, 1, 2) - 0.5) * 0.08 * asp;
    const jitterY = (astrolabeHash01(seed, 3, 4) - 0.5) * 0.08;
    const anchorX = c.cx + jitterX;
    const anchorY = c.cy + jitterY;
    const oppX = asp - anchorX;
    const oppY = 1 - anchorY;

    if (family === 'eclipse') {
        // 01. 日食家族 6 款独立拓扑：日冕环 / 镰刀食既 / 双星咬合 / 金环食 / 半影双切 / 全食十字横梁
        const rMain = 0.78 * asp;
        if (variantIdx === 0) {
            pushMass(buildDiscPolygon(anchorX, anchorY, rMain * 1.15, 0, TAU, 48), { invert: false, tone: 0, hasHatch: true, delay: 0 });
            pushMass(buildDiscPolygon(anchorX + c.sx * 0.08 * asp, anchorY + c.sy * 0.06, rMain * 0.90, 0, TAU, 48), { invert: true, delay: 0.07 });
            pushMass(buildDiscPolygon(oppX - c.sx * 0.20 * asp, oppY - c.sy * 0.16, 0.17 * asp, 0, TAU, 36), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 1) {
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.7, 0.24, flowRad), { invert: false, tone: 1, hasHatch: true, delay: 0 });
            pushMass(buildCrescentPolygon(anchorX, anchorY, rMain * 1.04, c.sx * 0.24 * asp, c.sy * 0.18, rMain * 0.88, 0, TAU, 44), { invert: true, delay: 0.07 });
            pushMass(buildDiamondPolygon(oppX - c.sx * 0.24 * asp, oppY - c.sy * 0.20, 0.14 * asp, 0.14 * asp, flowRad), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 2) {
            // 双巨星对角相切咬合（eclipse-binary）
            pushMass(buildDiscPolygon(-0.08 * asp, 0.28, 0.56 * asp, 0, TAU, 44), { invert: true, delay: 0.03 });
            pushMass(buildDiscPolygon(1.08 * asp, 0.72, 0.56 * asp, 0, TAU, 44), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.5, 0.06, -0.42), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 3) {
            // 金环食：宽幅反色圆环 + 实心核（eclipse-annular）
            pushMass(buildRingBandPolygon(anchorX, anchorY, rMain * 0.52, rMain * 0.96, 0, TAU, 48), { invert: true, delay: 0.03 });
            pushMass(buildDiscPolygon(anchorX, anchorY, rMain * 0.44, 0, TAU, 40), { invert: false, isAccent: true, delay: 0.10 });
            pushMass(buildSlabPolygon(oppX, 0.5, asp * 0.9, 0.28, Math.PI * 0.5), { invert: false, tone: 1, hasHatch: true, delay: 0.16 });
        } else if (variantIdx === 4) {
            // 半影阶梯环切（eclipse-penumbra）
            pushMass(buildDiscPolygon(0.5 * asp, -0.45, 1.05 * asp, 0, TAU, 48), { invert: false, tone: 0, hasHatch: true, delay: 0 });
            pushMass(buildCrescentPolygon(0.5 * asp, -0.32, 0.92 * asp, 0, 0.22, 0.84 * asp, 0, TAU, 44), { invert: true, delay: 0.07 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.78, asp * 1.6, 0.14, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else {
            // 全食天体横梁（eclipse-totality）
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.8, 0.34, 0), { invert: true, delay: 0.03 });
            pushMass(buildDiscPolygon(0.32 * asp, 0.48, 0.32 * asp, 0, TAU, 44), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildRingBandPolygon(0.32 * asp, 0.48, 0.35 * asp, 0.42 * asp, -1.1, 1.1, 32), { invert: false, isAccent: true, delay: 0.15 });
        }
    } else if (family === 'armillary') {
        // 02. 浑天仪家族 6 款独立拓扑：赤道双环 / 黄道斜交 / 陀螺三环 / 至点偏心环 / 回归线双轨 / 天球半弧拱门
        const rBase = 0.82 * asp;
        if (variantIdx === 0) {
            pushMass(buildRingBandPolygon(anchorX, anchorY, rBase * 0.58, rBase * 0.86, 0, TAU, 48), { invert: true, delay: 0.04 });
            pushMass(buildRingBandPolygon(oppX, oppY, rBase * 0.64, rBase * 0.82, 0, TAU, 48), { invert: false, tone: 1, hasHatch: true, delay: 0.11 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.6, 0.08, flowRad), { invert: false, isAccent: true, delay: 0.17 });
        } else if (variantIdx === 1) {
            // 黄道 X 型双斜交宽带 + 破框环（armillary-ecliptic）
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.8, 0.22, -0.34), { invert: true, delay: 0.03 });
            pushMass(buildRingBandPolygon(0.88 * asp, 0.22, 0.32 * asp, 0.52 * asp, 0, TAU, 44), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.54, asp * 1.8, 0.07, 0.34), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 2) {
            // 陀螺三明治同心断环（armillary-gyro）
            const gcx = 0.22 * asp;
            const gcy = 0.50;
            pushMass(buildRingBandPolygon(gcx, gcy, 0.24 * asp, 0.44 * asp, -1.8, 1.8, 36), { invert: true, delay: 0.03 });
            pushMass(buildRingBandPolygon(gcx, gcy, 0.48 * asp, 0.64 * asp, 1.2, 4.8, 36), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildDiscPolygon(gcx, gcy, 0.16 * asp, 0, TAU, 36), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 3) {
            // 顶部天穹拱门环 + 垂直立柱（armillary-solstice）
            pushMass(buildRingBandPolygon(0.5 * asp, 1.18, 0.62 * asp, 0.92 * asp, Math.PI * 1.08, Math.PI * 1.92, 42), { invert: true, delay: 0.04 });
            pushMass(buildSlabPolygon(0.24 * asp, 0.5, 1.4, 0.16 * asp, Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.11 });
            pushMass(buildDiscPolygon(0.76 * asp, 0.32, 0.13 * asp, 0, TAU, 34), { invert: false, isAccent: true, delay: 0.17 });
        } else if (variantIdx === 4) {
            // 南北回归线平行双轨 + 斜切环（armillary-tropics）
            pushMass(buildSlabPolygon(0.5 * asp, 0.28, asp * 1.6, 0.18, 0), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.72, asp * 1.6, 0.18, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildRingBandPolygon(0.5 * asp, 0.5, 0.26 * asp, 0.38 * asp, -0.9, 2.2, 36), { invert: false, isAccent: true, delay: 0.16 });
        } else {
            // 对角双拱门咬合（armillary-celestial）
            pushMass(buildRingBandPolygon(-0.12 * asp, 0.5, 0.46 * asp, 0.72 * asp, -1.2, 1.2, 38), { invert: true, delay: 0.03 });
            pushMass(buildRingBandPolygon(1.12 * asp, 0.5, 0.46 * asp, 0.68 * asp, Math.PI - 1.2, Math.PI + 1.2, 38), { invert: false, tone: 0, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.5 * asp, 0.5, 0.18 * asp, 0.26, 0), { invert: false, isAccent: true, delay: 0.16 });
        }
    } else if (family === 'quadrant') {
        // 03. 象限折尺与包豪斯直角构架家族（零圆弧，纯直角L梁、阶梯折角、正交悬臂与卡尺画框）
        if (variantIdx === 0) {
            pushMass(buildLBeamPolygon(0.14 * asp, 0.16, 0.72 * asp, 0.68, 0.24, 0), { invert: true, delay: 0.02 });
            pushMass(buildSlabPolygon(0.64 * asp, 0.68, 0.68 * asp, 0.22, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildDiamondPolygon(0.76 * asp, 0.30, 0.14 * asp, 0.18, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 1) {
            pushMass(buildLBeamPolygon(0.86 * asp, 0.84, 0.74 * asp, 0.68, 0.24, Math.PI), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.24 * asp, 0.48, 0.86, 0.18 * asp, Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.52 * asp, 0.28, 0.42 * asp, 0.10, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 2) {
            pushMass(buildLBeamPolygon(0.12 * asp, 0.14, 0.56 * asp, 0.54, 0.20, 0), { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.88 * asp, 0.86, 0.56 * asp, 0.54, 0.20, Math.PI), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.4, 0.06, -0.46), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 3) {
            pushMass([{ x: -0.08 * asp, y: -0.08 }, { x: 0.78 * asp, y: -0.08 }, { x: -0.08 * asp, y: 0.88 }], { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.84 * asp, 0.22, 0.62, 0.58 * asp, 0.20, Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildSlabPolygon(0.66 * asp, 0.68, 0.48 * asp, 0.12, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 4) {
            pushMass(buildSlabPolygon(0.28 * asp, 0.5, 1.4, 0.24 * asp, Math.PI * 0.5), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.74 * asp, 0.5, 1.4, 0.15 * asp, Math.PI * 0.5), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildTrapezoidPolygon(0.52 * asp, 0.66, 0.22 * asp, 0.42 * asp, 0.22, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else {
            pushMass(buildSlabPolygon(0.5 * asp, 0.24, asp * 1.6, 0.22, 0), { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.18 * asp, 0.84, 0.64, 0.64 * asp, 0.20, -Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.76 * asp, 0.66, 0.18 * asp, 0.22, 0), { invert: false, isAccent: true, delay: 0.16 });
        }
    } else if (family === 'orrery') {
        // 04. 李西茨基 Proun 悬臂桁架与多边形折板家族（零巨圆，纯透视梯形、悬臂梁、六角核心与天平楔块）
        if (variantIdx === 0) {
            pushMass(buildTrapezoidPolygon(0.38 * asp, 0.46, 0.26 * asp, 0.64 * asp, 0.56, -0.22), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.56 * asp, 0.52, asp * 1.6, 0.16, 0.28), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildRegularNGon(0.74 * asp, 0.34, 0.16 * asp, 6, 0.2), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 1) {
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.8, 0.12, -0.18), { invert: false, tone: 2, hasHatch: true, delay: 0 });
            pushMass(buildRegularNGon(0.24 * asp, 0.56, 0.19 * asp, 6, 0), { invert: false, isAccent: true, delay: 0.06 });
            pushMass(buildTrapezoidPolygon(0.54 * asp, 0.48, 0.34 * asp, 0.52 * asp, 0.48, -0.18), { invert: true, delay: 0.11 });
            pushMass(buildDiamondPolygon(0.82 * asp, 0.40, 0.15 * asp, 0.20, -0.18), { invert: false, tone: 0, delay: 0.16 });
        } else if (variantIdx === 2) {
            pushMass(buildRegularNGon(0.62 * asp, 0.48, 0.36 * asp, 8, Math.PI / 8), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.24 * asp, 0.48, 0.55 * asp, 0.36, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildTrapezoidPolygon(0.62 * asp, 0.48, 0.12 * asp, 0.26 * asp, 0.24, 0.4), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 3) {
            pushMass(buildSlabPolygon(0.36 * asp, 0.34, 0.72 * asp, 0.22, -0.24), { invert: true, delay: 0.02 });
            pushMass(buildSlabPolygon(0.52 * asp, 0.52, 0.68 * asp, 0.18, 0.38), { invert: false, tone: 1, hasHatch: true, delay: 0.08 });
            pushMass(buildSlabPolygon(0.66 * asp, 0.70, 0.72 * asp, 0.22, -0.24), { invert: true, delay: 0.13 });
            pushMass(buildDiamondPolygon(0.24 * asp, 0.68, 0.14 * asp, 0.18, 0), { invert: false, isAccent: true, delay: 0.18 });
        } else if (variantIdx === 4) {
            pushMass(buildChevronPolygon(0.5 * asp, 0.34, 0.76 * asp, 0.34, 0.18, true), { invert: false, tone: 2, hasHatch: true, delay: 0 });
            pushMass(buildTrapezoidPolygon(0.32 * asp, 0.56, 0.22 * asp, 0.48 * asp, 0.46, 0.12), { invert: true, delay: 0.07 });
            pushMass(buildDiamondPolygon(0.76 * asp, 0.38, 0.18 * asp, 0.22, 0.2), { invert: false, isAccent: true, delay: 0.14 });
        } else {
            pushMass(buildTrapezoidPolygon(0.36 * asp, 0.48, 0.48 * asp, 0.20 * asp, 0.62, -0.15), { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.52 * asp, 0.26, 0.44 * asp, 0.54, 0.18, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.4, 0.06, 0.45), { invert: false, isAccent: true, delay: 0.16 });
        }
    } else if (family === 'meridian') {
        // 05. 子午线与刀锋走廊家族（零圆弧，纯对角切带、V型正倒屋脊、级联菱形阵与高塔垂直双柱）
        const ang = -0.32 + (variantIdx - 2.5) * 0.14;
        if (variantIdx === 0) {
            pushMass(buildSlabPolygon(0.46 * asp, 0.48, asp * 1.8, 0.44, ang), { invert: true, delay: 0.04 });
            pushMass(buildSlabPolygon(0.56 * asp, 0.74, asp * 1.8, 0.16, ang), { invert: false, tone: 2, hasHatch: true, delay: 0.11 });
            pushMass(buildTrapezoidPolygon(0.76 * asp, 0.28, 0.18 * asp, 0.36 * asp, 0.32, ang), { invert: false, isAccent: true, delay: 0.17 });
        } else if (variantIdx === 1) {
            pushMass(buildChevronPolygon(0.5 * asp, 0.24, 0.85 * asp, 0.56, 0.24, true), { invert: true, delay: 0.03 });
            pushMass(buildChevronPolygon(0.5 * asp, 0.52, 0.85 * asp, 0.48, 0.14, true), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.5 * asp, 0.78, 0.18 * asp, 0.22, 0), { invert: false, isAccent: true, delay: 0.17 });
        } else if (variantIdx === 2) {
            for (let d = 0; d < 3; d++) {
                const scale = 1 - d * 0.25;
                pushMass(buildDiamondPolygon((0.28 + d * 0.22) * asp, 0.54 - d * 0.12, 0.34 * asp * scale, 0.44 * scale, -0.08 + d * 0.04), {
                    invert: d === 0,
                    isAccent: d === 2,
                    tone: d,
                    hasHatch: d === 1,
                    delay: d * 0.07,
                });
            }
        } else if (variantIdx === 3) {
            pushMass(buildSlabPolygon(0.32 * asp, 0.5, 1.5, 0.28 * asp, Math.PI * 0.5), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.68 * asp, 0.5, 1.5, 0.16 * asp, Math.PI * 0.5), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildLBeamPolygon(0.32 * asp, 0.22, 0.44 * asp, 0.44, 0.14, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 4) {
            pushMass(buildChevronPolygon(0.5 * asp, 0.78, 0.88 * asp, 0.54, 0.22, false), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.36, asp * 1.7, 0.16, 0), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildTrapezoidPolygon(0.5 * asp, 0.36, 0.32 * asp, 0.16 * asp, 0.26, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else {
            pushMass(buildTrapezoidPolygon(0.38 * asp, 0.50, 0.18 * asp, 0.62 * asp, 0.78, 0.34), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.55 * asp, 0.48, asp * 1.8, 0.22, 0.34), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildRegularNGon(0.76 * asp, 0.32, 0.15 * asp, 6, 0.34), { invert: false, isAccent: true, delay: 0.16 });
        }
    } else if (family === 'transit') {
        // 06. 百叶矩阵与阶梯序列家族（零圆弧，纯平行斜带、四阶梯块、梯形快门、剪刀X带與五联琴键柱）
        if (variantIdx === 0) {
            for (let i = 0; i < 3; i++) {
                const offset = (i - 1) * 0.27;
                pushMass(buildSlabPolygon(0.5 * asp + offset * 0.2 * asp, 0.48 + offset, asp * 1.7, 0.19, -0.18), {
                    invert: i === 1,
                    isAccent: i === 2,
                    tone: i,
                    hasHatch: i === 0,
                    delay: i * 0.07,
                });
            }
        } else if (variantIdx === 1) {
            for (let i = 0; i < 4; i++) {
                pushMass(buildSlabPolygon((0.16 + i * 0.22) * asp, 0.22 + i * 0.18, 0.36 * asp, 0.32, 0), {
                    invert: i === 1 || i === 2,
                    isAccent: i === 3,
                    tone: i % 3,
                    hasHatch: i === 0,
                    delay: i * 0.06,
                });
            }
        } else if (variantIdx === 2) {
            pushMass(buildTrapezoidPolygon(0.5 * asp, 0.5, 0.34 * asp, 0.72 * asp, 0.68, 0), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.32, asp * 1.5, 0.11, 0.12), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.68, asp * 1.5, 0.11, 0.12), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 3) {
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.8, 0.26, -0.28), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.52, asp * 1.8, 0.22, 0.28), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.5 * asp, 0.5, 0.16 * asp, 0.22, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 4) {
            pushMass(buildLBeamPolygon(0.22 * asp, 0.22, 0.62 * asp, 0.58, 0.18, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.02 });
            pushMass(buildSlabPolygon(0.54 * asp, 0.48, asp * 1.7, 0.24, -0.22), { invert: true, delay: 0.09 });
            pushMass(buildRegularNGon(0.74 * asp, 0.34, 0.14 * asp, 6, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else {
            for (let i = 0; i < 5; i++) {
                pushMass(buildSlabPolygon((0.18 + i * 0.16) * asp, 0.5 + (i % 2 === 0 ? -0.08 : 0.08), 0.78, 0.11 * asp, Math.PI * 0.5), {
                    invert: i === 1 || i === 3,
                    isAccent: i === 2,
                    tone: i % 3,
                    hasHatch: i === 0 || i === 4,
                    delay: i * 0.05,
                });
            }
        }
    } else if (family === 'constellation') {
        // 07. 瑞士不对称网格与蒙德里安分栏家族（零圆弧，纯直角分栏、三联板块、十字坐标、悬臂折梁与三角桁架）
        const splitX = (0.34 + (variantIdx % 3) * 0.16) * asp;
        const splitY = 0.36 + (variantIdx % 2) * 0.26;
        if (variantIdx === 0) {
            pushMass([{ x: -0.1 * asp, y: -0.1 }, { x: splitX, y: -0.1 }, { x: splitX + 0.08 * asp, y: splitY }, { x: -0.1 * asp, y: splitY }], { invert: true, tone: 0, delay: 0.03 });
            pushMass([{ x: splitX, y: splitY }, { x: 1.1 * asp, y: splitY - 0.06 }, { x: 1.1 * asp, y: 1.1 }, { x: splitX - 0.06 * asp, y: 1.1 }], { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildLBeamPolygon(splitX - 0.16 * asp, splitY - 0.16, 0.34 * asp, 0.34, 0.11, 0), { invert: false, isAccent: true, delay: 0.17 });
        } else if (variantIdx === 1) {
            pushMass(buildSlabPolygon(0.24 * asp, 0.5, 1.2, 0.38 * asp, Math.PI * 0.5), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.72 * asp, 0.28, 0.56 * asp, 0.38, 0), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.72 * asp, 0.76, 0.56 * asp, 0.34, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 2) {
            pushMass(buildSlabPolygon(splitX, 0.5, 1.4, 0.15 * asp, Math.PI * 0.5), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, splitY, asp * 1.4, 0.16, 0), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(asp - splitX, 1 - splitY, 0.36 * asp, 0.34, 0), { invert: true, delay: 0.15 });
            pushMass(buildDiamondPolygon(splitX, splitY, 0.12 * asp, 0.16, 0), { invert: false, isAccent: true, delay: 0.20 });
        } else if (variantIdx === 3) {
            pushMass(buildChevronPolygon(0.46 * asp, 0.34, 0.72 * asp, 0.44, 0.20, true), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.72 * asp, 0.68, 0.48 * asp, 0.32, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.26 * asp, 0.68, 0.16 * asp, 0.22, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 4) {
            pushMass([{ x: -0.1 * asp, y: 1.1 }, { x: 0.58 * asp, y: 0.12 }, { x: 0.88 * asp, y: 1.1 }], { invert: true, delay: 0.03 });
            pushMass(buildTrapezoidPolygon(0.62 * asp, 0.36, 0.18 * asp, 0.42 * asp, 0.36, 0.22), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.72, asp * 1.5, 0.07, -0.16), { invert: false, isAccent: true, delay: 0.16 });
        } else {
            pushMass(buildRegularNGon(0.28 * asp, 0.44, 0.26 * asp, 6, 0), { invert: true, delay: 0.03 });
            pushMass(buildRegularNGon(0.74 * asp, 0.58, 0.22 * asp, 6, Math.PI / 6), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.51 * asp, 0.51, 0.62 * asp, 0.14, 0.28), { invert: true, delay: 0.14 });
            pushMass(buildDiamondPolygon(0.51 * asp, 0.51, 0.12 * asp, 0.16, 0.28), { invert: false, isAccent: true, delay: 0.19 });
        }
    } else if (family === 'solstice') {
        // 08. 至点地平线与折纸山脊家族（零圆弧，纯直边一刀切、折纸山脊、梯形天光束与沙漏双楔）
        if (variantIdx === 0) {
            pushMass([{ x: -0.1 * asp, y: -0.1 }, { x: 0.56 * asp, y: -0.1 }, { x: 0.42 * asp, y: 1.1 }, { x: -0.1 * asp, y: 1.1 }], { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.7, 0.09, flowRad - 0.35), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildTrapezoidPolygon(0.76 * asp, 0.52, 0.14 * asp, 0.32 * asp, 0.34, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 1) {
            pushMass([{ x: 0.44 * asp, y: -0.1 }, { x: 1.1 * asp, y: -0.1 }, { x: 1.1 * asp, y: 1.1 }, { x: 0.58 * asp, y: 1.1 }], { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.18 * asp, 0.24, 0.48 * asp, 0.56, 0.18, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.46 * asp, 0.48, 0.15 * asp, 0.20, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 2) {
            pushMass([{ x: -0.1 * asp, y: -0.1 }, { x: 1.1 * asp, y: -0.1 }, { x: 1.1 * asp, y: 0.28 }, { x: -0.1 * asp, y: 0.76 }], { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.52, asp * 1.8, 0.08, -0.38), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildRegularNGon(0.74 * asp, 0.44, 0.16 * asp, 6, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 3) {
            pushMass(buildTrapezoidPolygon(0.5 * asp, 0.38, 0.26 * asp, 0.92 * asp, 0.84, 0), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.74, asp * 1.6, 0.16, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.10 });
            pushMass(buildDiamondPolygon(0.24 * asp, 0.52, 0.14 * asp, 0.18, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else if (variantIdx === 4) {
            pushMass([{ x: -0.1 * asp, y: 1.1 }, { x: 0.28 * asp, y: 0.38 }, { x: 0.54 * asp, y: 0.58 }, { x: 0.78 * asp, y: 0.28 }, { x: 1.1 * asp, y: 1.1 }], { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.26, asp * 1.6, 0.14, 0), { invert: false, tone: 2, hasHatch: true, delay: 0.10 });
            pushMass(buildRegularNGon(0.78 * asp, 0.28, 0.13 * asp, 8, 0), { invert: false, isAccent: true, delay: 0.16 });
        } else {
            pushMass([{ x: -0.1 * asp, y: -0.1 }, { x: 0.46 * asp, y: 0.5 }, { x: -0.1 * asp, y: 1.1 }], { invert: true, delay: 0.03 });
            pushMass([{ x: 1.1 * asp, y: -0.1 }, { x: 0.54 * asp, y: 0.5 }, { x: 1.1 * asp, y: 1.1 }], { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.4, 0.07, 0), { invert: false, isAccent: true, delay: 0.15 });
        }
    } else {
        // 09. zenith（副歌天顶家族：零圆弧，纯放射楔形光束、硬边八角/六角门户与双V冲击波）
        const zx = (0.42 + (variantIdx % 3) * 0.08) * asp;
        const zy = 0.45 + (variantIdx % 2 === 0 ? -0.04 : 0.04);
        if (variantIdx === 0) {
            pushMass(buildSlabPolygon(zx, zy, asp * 1.9, 0.26, flowRad), { invert: false, tone: 1, hasHatch: true, delay: 0 });
            pushMass(buildRegularNGon(zx, zy, 0.38 * asp, 8, Math.PI / 8), { invert: true, delay: 0.06 });
            pushMass(buildTrapezoidPolygon(zx, zy, 0.14 * asp, 0.52 * asp, 0.42, flowRad + Math.PI * 0.5), { invert: false, isAccent: true, delay: 0.14 });
        } else if (variantIdx === 1) {
            pushMass(buildChevronPolygon(0.5 * asp, 0.5, 0.85 * asp, 0.42, 0.22, true), { invert: true, delay: 0.03 });
            pushMass(buildChevronPolygon(0.5 * asp, 0.5, 0.85 * asp, 0.42, 0.18, false), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildRegularNGon(0.5 * asp, 0.5, 0.19 * asp, 6, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 2) {
            pushMass(buildSlabPolygon(0.36 * asp, 0.5, 1.6, 0.36 * asp, Math.PI * 0.42), { invert: true, delay: 0.03 });
            pushMass(buildLBeamPolygon(0.58 * asp, 0.24, 0.48 * asp, 0.52, 0.18, 0), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.5, asp * 1.8, 0.06, -0.25), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 3) {
            pushMass(buildTrapezoidPolygon(0.28 * asp, 0.5, 0.12 * asp, 0.58 * asp, 0.92, Math.PI * 0.5), { invert: true, delay: 0.03 });
            pushMass(buildTrapezoidPolygon(0.72 * asp, 0.5, 0.12 * asp, 0.58 * asp, 0.92, -Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildDiamondPolygon(0.5 * asp, 0.5, 0.18 * asp, 0.26, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else if (variantIdx === 4) {
            pushMass(buildSlabPolygon(0.5 * asp, 0.46, asp * 1.8, 0.24, 0), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.58 * asp, 0.5, 1.4, 0.20 * asp, Math.PI * 0.5), { invert: false, tone: 2, hasHatch: true, delay: 0.09 });
            pushMass(buildRegularNGon(0.58 * asp, 0.46, 0.26 * asp, 6, 0), { invert: false, isAccent: true, delay: 0.15 });
        } else {
            pushMass(buildDiamondPolygon(0.5 * asp, 0.48, 0.48 * asp, 0.44, -0.06), { invert: true, delay: 0.03 });
            pushMass(buildSlabPolygon(0.5 * asp, 0.48, asp * 1.8, 0.16, 0.32), { invert: false, tone: 1, hasHatch: true, delay: 0.09 });
            pushMass(buildTrapezoidPolygon(0.24 * asp, 0.32, 0.12 * asp, 0.28 * asp, 0.24, 0.32), { invert: false, isAccent: true, delay: 0.15 });
        }
    }

    const densityTier = shot.densityTier || 'dense';

    // 疏密呼吸控制（densityTier）：
    // - sparse（极简留白镜）：仅保留 1 块核心正负形反色面 + 1 条基准线 + 0 标尺 + 无水印，留出 >70% 呼吸负空间；
    // - balanced（标准瑞士海报镜）：保留 2 块核心块面（1 反色面 + 1 点睛配重块）+ 1 条基准线 + 1 组精密对位标 + 无水印；
    // - dense（副歌/高潮满版镜）：保留完整 3~5 块面 + 双基准线 + 标尺组 + 印刷残影底纹大字。
    let finalMasses = masses;
    if (densityTier === 'sparse') {
        const inv = masses.find(m => m.invert) || masses[0];
        finalMasses = inv ? [{ ...inv, hasHatch: false }] : [];
    } else if (densityTier === 'balanced') {
        const inv = masses.find(m => m.invert) || masses[0];
        const acc = masses.find(m => m !== inv && m.isAccent) || masses.find(m => m !== inv);
        finalMasses = [inv, acc].filter(Boolean);
    }

    // 贯穿全画幅的构成主义基准割线（在 _getShotLayout 中将进一步对齐到真实文字基线与词间切缝）
    const chordAng1 = flowRad;
    const chordAng2 = flowRad + (variantIdx % 2 === 0 ? 1.15 : -1.15);
    const span = asp * 1.8;
    const pivotX = (0.35 + astrolabeHash01(seed, 21, 1) * 0.30) * asp;
    const pivotY = 0.32 + astrolabeHash01(seed, 22, 2) * 0.36;
    lines.push({
        x1: pivotX - Math.cos(chordAng1) * span,
        y1: pivotY - Math.sin(chordAng1) * span,
        x2: pivotX + Math.cos(chordAng1) * span,
        y2: pivotY + Math.sin(chordAng1) * span,
        weight: 1.6,
        isAccent: false,
    });
    if (densityTier === 'dense') {
        lines.push({
            x1: pivotX - Math.cos(chordAng2) * span,
            y1: pivotY - Math.sin(chordAng2) * span,
            x2: pivotX + Math.cos(chordAng2) * span,
            y2: pivotY + Math.sin(chordAng2) * span,
            weight: 1.2,
            isAccent: true,
        });
    }

    if (densityTier !== 'sparse') {
        marks.push({
            kind: 'cross-row',
            x: (0.14 + (variantIdx % 4) * 0.22) * asp,
            y: variantIdx % 2 === 0 ? 0.16 : 0.82,
            count: 3 + (variantIdx % 3),
            gap: 0.032 * asp,
            angle: 0,
        });
    }
    if (densityTier === 'dense') {
        if (family === 'eclipse' || family === 'armillary') {
            marks.push({
                kind: 'vernier-arc',
                cx: anchorX,
                cy: anchorY,
                r: 0.82 * asp,
                startRad: -0.75,
                endRad: 0.75,
                ticks: 18,
            });
        } else {
            marks.push({
                kind: 'dot-grid',
                x: (variantIdx % 2 === 0 ? 0.78 : 0.16) * asp,
                y: variantIdx % 3 === 0 ? 0.24 : 0.68,
                cols: 5,
                rows: 3,
                step: 0.020 * asp,
            });
        }
    }

    return {
        aspect: asp,
        family,
        shotKind: shot.shotKind,
        densityTier,
        masses: finalMasses,
        lines,
        marks,
        watermark: densityTier === 'dense' ? {
            x: (variantIdx % 2 === 0 ? 0.24 : 0.76) * asp,
            y: variantIdx % 3 === 0 ? 0.28 : 0.68,
            angle: (variantIdx % 2 === 0 ? -0.04 : 0.04),
        } : null,
    };
}
