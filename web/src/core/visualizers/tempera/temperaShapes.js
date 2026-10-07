/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaShapes.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * （type PixiModule / type Graphics / TemperaDisc / TemperaDecorMark / TemperaHatchLine /
 *  TemperaHatchSpec / TemperaGradientFill 等类型导入与接口声明已随 TypeScript 类型一并移除。）
 */

import { mixColors } from '../../../utils/colorMix.js';
import { buildHatchLines } from './temperaHatch.js';

// src/components/visualizer/tempera/temperaShapes.ts
// Pixi Graphics factories for the screentone language. Every factory returns a finished,
// static node: playback only writes transforms and alpha, never geometry.

export const toPixiColor = (pixi, color) => (
    pixi.Color.shared.setValue(color).toNumber()
);

const boundsCenter = (polygon) => {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < polygon.length; index += 2) {
        minX = Math.min(minX, polygon[index]);
        maxX = Math.max(maxX, polygon[index]);
        minY = Math.min(minY, polygon[index + 1]);
        maxY = Math.max(maxY, polygon[index + 1]);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
};

/** Four-colour ramp plus the axis it runs along, supplied by the gradient colour mode. */

/**
 * In gradient mode a shape is filled with the whole four-colour ramp instead of one tone.
 * Each stop is pulled halfway toward the tone the composition asked for, so the ramp carries
 * the cover's hues while the shape keeps the brightness its place in the composition needs.
 */
const buildGradientFill = (pixi, gradient, color) => {
    const half = 0.5;
    const dx = Math.cos(gradient.angle) * half;
    const dy = Math.sin(gradient.angle) * half;
    const stops = gradient.colors.map((stop, index) => ({
        offset: gradient.colors.length > 1 ? index / (gradient.colors.length - 1) : 0,
        color: mixColors(stop, color, 0.5),
    }));
    return new pixi.FillGradient({
        type: 'linear',
        start: { x: half - dx, y: half - dy },
        end: { x: half + dx, y: half + dy },
        colorStops: stops,
        textureSpace: 'local',
    });
};

export const drawPolygonFill = (
    pixi,
    polygon,
    color,
    alpha = 1,
    gradient,
) => {
    const node = new pixi.Graphics().poly(polygon);
    return gradient && gradient.colors.length > 1
        ? node.fill({ fill: buildGradientFill(pixi, gradient, color), alpha })
        : node.fill({ color: toPixiColor(pixi, color), alpha });
};

/**
 * A filled polygon with holes punched through it. The holes are genuinely transparent: the
 * Pixi canvas runs on `backgroundAlpha: 0`, so what shows through is the shell's live
 * background layer (veiled by the scene's paper wash, which is per-paragraph and cannot be
 * cut per shot).
 *
 * The node must hold exactly one fill instruction. `GraphicsContext.cut` walks back over the
 * last two instructions and, once the first hole is attached, keeps going - a second fill or
 * a stroke on the same node would silently collect the holes as well. Outlines for the holes
 * are therefore separate nodes.
 */
export const drawPolygonFillWithHoles = (
    pixi,
    polygon,
    holes,
    color,
    alpha = 1,
    gradient,
) => {
    const node = new pixi.Graphics().poly(polygon);
    if (gradient && gradient.colors.length > 1) {
        node.fill({ fill: buildGradientFill(pixi, gradient, color), alpha });
    } else {
        node.fill({ color: toPixiColor(pixi, color), alpha });
    }
    holes.forEach(hole => {
        if (hole.length >= 6) node.poly(hole).cut();
    });
    return node;
};

export const drawPolygonOutline = (
    pixi,
    polygon,
    color,
    width,
    alpha = 1,
) => new pixi.Graphics()
    .poly(polygon)
    .stroke({ color: toPixiColor(pixi, color), width, alpha });

// Fills a convex polygon with parallel strokes. The node is pivoted on the shape center so
// the caller can open it with a horizontal scale without touching the geometry again.
export const drawHatchFill = (
    pixi,
    polygon,
    spec,
    color,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    const lines = buildHatchLines(polygon, spec);
    lines.forEach(line => {
        node.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2);
    });
    if (lines.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width: spec.width, alpha });
    }
    const center = boundsCenter(polygon);
    node.pivot.set(center.x, center.y);
    node.position.set(center.x, center.y);
    return node;
};

// Bounds centre of a disc field, so the node can be pivoted on itself like the hatch fills.
const discsCenter = (discs) => {
    if (discs.length === 0) return { x: 0, y: 0 };
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    discs.forEach(disc => {
        minX = Math.min(minX, disc.x - disc.radius);
        maxX = Math.max(maxX, disc.x + disc.radius);
        minY = Math.min(minY, disc.y - disc.radius);
        maxY = Math.max(maxY, disc.y + disc.radius);
    });
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
};

// A whole disc field is one node: a bubble cluster has to enter and breathe as a single item,
// and a Graphics per bubble would put a dozen entries into the block animator instead of one.
// Pivoted on the field centre so `drift` reads as a breath rather than as a slide.
const buildDiscNode = (pixi, discs) => {
    const node = new pixi.Graphics();
    discs.forEach(disc => {
        node.circle(disc.x, disc.y, Math.max(0.5, disc.radius));
    });
    return node;
};

const pivotOnSelf = (node, center) => {
    node.pivot.set(center.x, center.y);
    node.position.set(center.x, center.y);
    return node;
};

export const drawDiscs = (
    pixi,
    discs,
    color,
    alpha = 1,
    gradient,
) => {
    const node = buildDiscNode(pixi, discs);
    if (discs.length > 0) {
        node.fill(gradient && gradient.colors.length > 1
            ? { fill: buildGradientFill(pixi, gradient, color), alpha }
            : { color: toPixiColor(pixi, color), alpha });
    }
    return pivotOnSelf(node, discsCenter(discs));
};

export const drawRings = (
    pixi,
    discs,
    color,
    width,
    alpha = 1,
) => {
    const node = buildDiscNode(pixi, discs);
    if (discs.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width, alpha });
    }
    return pivotOnSelf(node, discsCenter(discs));
};

export const drawLines = (
    pixi,
    lines,
    color,
    width,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    lines.forEach(line => {
        node.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2);
    });
    if (lines.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width, alpha });
    }
    return node;
};

export const drawPolyline = (
    pixi,
    points,
    color,
    width,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    if (points.length < 4) return node;
    node.moveTo(points[0], points[1]);
    for (let index = 2; index < points.length; index += 2) {
        node.lineTo(points[index], points[index + 1]);
    }
    return node.stroke({ color: toPixiColor(pixi, color), width, alpha });
};

// Concentric 45°-rotated frames with alternating stroke weight, thickest on the outside.
export const drawConcentricDiamonds = (
    pixi,
    cx,
    cy,
    rx,
    ry,
    rings,
    color,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    const stroke = toPixiColor(pixi, color);
    for (let ring = 0; ring < Math.max(1, rings); ring += 1) {
        const shrink = 1 - ring * 0.22;
        node
            .poly([cx, cy - ry * shrink, cx + rx * shrink, cy, cx, cy + ry * shrink, cx - rx * shrink, cy])
            .stroke({ color: stroke, width: ring % 2 === 0 ? 3.5 : 1.4, alpha });
    }
    node.pivot.set(cx, cy);
    node.position.set(cx, cy);
    return node;
};

export const drawCrossMarks = (
    pixi,
    marks,
    color,
    width,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    marks.forEach(mark => {
        const cos = Math.cos(mark.rotation + Math.PI / 4) * mark.size;
        const sin = Math.sin(mark.rotation + Math.PI / 4) * mark.size;
        node.moveTo(mark.x - cos, mark.y - sin).lineTo(mark.x + cos, mark.y + sin);
        node.moveTo(mark.x - sin, mark.y + cos).lineTo(mark.x + sin, mark.y - cos);
    });
    if (marks.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width, alpha });
    }
    return node;
};

export const drawSquareMarks = (
    pixi,
    marks,
    color,
    alpha = 1,
) => {
    const node = new pixi.Graphics();
    marks.forEach(mark => {
        node.rect(mark.x - mark.size / 2, mark.y - mark.size / 2, mark.size, mark.size);
    });
    if (marks.length > 0) {
        node.fill({ color: toPixiColor(pixi, color), alpha });
    }
    return node;
};
