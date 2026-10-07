/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/compositions/temperaCinemaCompositions.ts
import { temperaHash01 } from '../temperaRandom.js';
import { buildHatchSpec, rectPolygon } from '../temperaHatch.js';
import { drawHatchFill, drawLines, drawPolygonFill, drawPolygonOutline } from '../temperaShapes.js';

// src/components/visualizer/tempera/compositions/temperaCinemaCompositions.ts
// Cinema mattes: a solid frame with a window of a given aspect punched out of the middle. The
// hole is what the lyric sits in, so the surrounding tone reads as a matte rather than as a
// block - and the difference filter has a hard edge to cut the type against.

/**
 * Fits a window of the given aspect inside the frame. Real pixel dimensions are used rather
 * than viewport fractions, because a "square" window has to look square on any display.
 */
const fitWindow = (width, height, aspect, fill) => {
    const maxWidth = width * fill;
    const maxHeight = height * fill;
    const windowWidth = Math.min(maxWidth, maxHeight * aspect);
    const windowHeight = windowWidth / aspect;
    return {
        x: (width - windowWidth) / 2,
        y: (height - windowHeight) / 2,
        width: windowWidth,
        height: windowHeight,
    };
};

/**
 * Draws the matte as four bars rather than a filled shape with a hole: the bars stay convex,
 * which the hatch clipper needs, and they can each carry their own entrance.
 */
const addMatte = (ctx, hole, tone) => {
    const { width, height, bleed } = ctx;
    const bars = [
        { polygon: rectPolygon(-bleed, -bleed, width + bleed * 2, hole.y + bleed), enterDX: 0, enterDY: -height * 0.2 },
        { polygon: rectPolygon(-bleed, hole.y + hole.height, width + bleed * 2, height - hole.y - hole.height + bleed), enterDX: 0, enterDY: height * 0.2 },
        { polygon: rectPolygon(-bleed, hole.y, hole.x + bleed, hole.height), enterDX: -width * 0.2, enterDY: 0 },
        { polygon: rectPolygon(hole.x + hole.width, hole.y, width - hole.x - hole.width + bleed, hole.height), enterDX: width * 0.2, enterDY: 0 },
    ];
    bars.forEach((bar, index) => {
        ctx.add(drawPolygonFill(ctx.pixi, bar.polygon, tone, 0.96, ctx.gradient), {
            delay: index * 0.04,
            span: 0.5,
            enterDX: bar.enterDX,
            enterDY: bar.enterDY,
        });
    });
    // The inner edge is the whole point of a matte, so it gets a line of its own.
    ctx.add(drawPolygonOutline(
        ctx.pixi,
        rectPolygon(hole.x, hole.y, hole.width, hole.height),
        ctx.palette.ink,
        1.6,
        0.5,
    ), { delay: 0.2, span: 0.5 });
};

// Faint tone inside the window so the hole is not simply bare ground.
const addWindowWash = (ctx, hole, alpha) => {
    const polygon = rectPolygon(hole.x, hole.y, hole.width, hole.height);
    ctx.add(drawPolygonFill(ctx.pixi, polygon, ctx.palette.tone1, alpha, ctx.gradient), { span: 0.55 });
    ctx.add(drawHatchFill(ctx.pixi, polygon, buildHatchSpec(ctx.seed, 149, 1.5), ctx.palette.tone4, 0.2),
        { delay: 0.1, span: 0.6, grow: true });
};

const matte = (aspect, fill, washAlpha = 0.35) => ctx => {
    const hole = fitWindow(ctx.width, ctx.height, aspect, fill);
    addWindowWash(ctx, hole, washAlpha);
    addMatte(ctx, hole, ctx.palette.tone4);
    if (!ctx.showDecor) return;
    // Registration ticks on the matte, aligned to the window edges.
    ctx.add(drawLines(ctx.pixi, [
        { x1: hole.x, y1: hole.y - ctx.height * 0.05, x2: hole.x, y2: hole.y - ctx.height * 0.02 },
        { x1: hole.x + hole.width, y1: hole.y + hole.height + ctx.height * 0.02, x2: hole.x + hole.width, y2: hole.y + hole.height + ctx.height * 0.05 },
    ], ctx.palette.paper, 2, 0.6), { delay: 0.26, span: 0.5 });
};

// Two windows side by side; the lyric takes the wider left one.
const cinemaTwin = ctx => {
    const { width, height, palette, bleed } = ctx;
    const inset = height * 0.16;
    const gutter = width * 0.04;
    const left = { x: width * 0.08, y: inset, width: width * 0.5, height: height - inset * 2 };
    const right = {
        x: left.x + left.width + gutter,
        y: inset + height * 0.1,
        width: width * 0.28,
        height: height - inset * 2 - height * 0.2,
    };
    ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2), palette.tone4, 0.96, ctx.gradient),
        { span: 0.5 });
    ([left, right]).forEach((hole, index) => {
        const polygon = rectPolygon(hole.x, hole.y, hole.width, hole.height);
        ctx.add(drawPolygonFill(ctx.pixi, polygon, palette.tone1, index === 0 ? 0.4 : 0.85, ctx.gradient),
            { delay: index * 0.08, span: 0.55, enterDX: (index === 0 ? -1 : 1) * width * 0.14 });
        ctx.add(drawPolygonOutline(ctx.pixi, polygon, palette.ink, 1.6, 0.5), { delay: 0.16 + index * 0.05, span: 0.5 });
    });
    if (!ctx.showDecor) return;
    ctx.add(drawHatchFill(ctx.pixi, rectPolygon(right.x, right.y, right.width, right.height), buildHatchSpec(ctx.seed, 151), palette.tone4, 0.35),
        { delay: 0.24, span: 0.6, grow: true });
};

// A slightly off-square window drifts by seed, so the same aspect never lands identically.
const jitteredFill = (ctx, base) => (
    base + (temperaHash01(ctx.seed, 157, 163) - 0.5) * 0.06
);

export const TEMPERA_CINEMA_COMPOSITIONS = {
    'cinema-scope': ctx => matte(2.39, jitteredFill(ctx, 0.88))(ctx),
    'cinema-wide': ctx => matte(1.85, jitteredFill(ctx, 0.84))(ctx),
    'cinema-academy': ctx => matte(1.33, jitteredFill(ctx, 0.78))(ctx),
    'cinema-square': ctx => matte(1, jitteredFill(ctx, 0.72))(ctx),
    'cinema-portrait': ctx => matte(0.75, jitteredFill(ctx, 0.72))(ctx),
    'cinema-tall': ctx => matte(0.5625, jitteredFill(ctx, 0.72))(ctx),
    'cinema-twin': cinemaTwin,
};
