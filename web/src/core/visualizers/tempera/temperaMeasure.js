/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * temperaMeasure.js — 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaMeasure.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * '@chenglou/pretext' → 本项目 vendor 化的 ../../../../vendor/pretext/layout.js。
 */

import { layoutWithLines, prepareWithSegments } from '../../../../vendor/pretext/layout.js';

// src/components/visualizer/tempera/temperaMeasure.ts
// pretext-backed text metrics for the Tempera collage. Words come from the Intl.Segmenter
// split done at compile time; measuring the whole word and then normalising the per-grapheme
// advances to that width keeps shaping/kerning intact while still allowing per-char placement.
// (接口 TemperaMeasureContext / TemperaWordGlyph / TemperaWordUnit 已随 TypeScript 类型标注一并移除。)

/**
 * Measurement is shared across every layout call, not scoped to one. A cache key names the
 * whole spec (`weight size family|text`), so nothing about a scene, a shot or a song can make
 * two entries with the same key disagree - and the same graphemes recur constantly: the fit
 * loop re-measures a shot up to four times, a paragraph has several shots, and consecutive
 * songs share most of their character set. A per-call cache threw all of that away and made a
 * song change re-measure everything from scratch on the frame it landed.
 */
const MEASURE_CACHE_LIMIT = 20000;
const measureCache = new Map();

const readMeasureCache = (key) => measureCache.get(key);

const writeMeasureCache = (key, width) => {
    // Plain FIFO eviction: entries are equally cheap to recompute, so the eviction policy only
    // has to bound memory, not predict reuse.
    if (measureCache.size >= MEASURE_CACHE_LIMIT) {
        const oldest = measureCache.keys().next();
        if (!oldest.done) measureCache.delete(oldest.value);
    }
    measureCache.set(key, width);
};

export const createTemperaMeasureContext = (
    fontFamily,
    fontWeight,
) => ({ cache: measureCache, fontFamily, fontWeight });

const measureText = (ctx, text, fontSize) => {
    const fontSpec = `${ctx.fontWeight} ${fontSize}px ${ctx.fontFamily}`;
    const key = `${fontSpec}|${text}`;
    const cached = readMeasureCache(key);
    if (cached !== undefined) return cached;
    let measured;
    try {
        const layout = layoutWithLines(prepareWithSegments(text, fontSpec), 99999, fontSize * 1.2);
        measured = layout.lines[0]?.width ?? text.length * fontSize * 0.6;
    } catch {
        measured = text.length * fontSize * 0.6;
    }
    const width = Math.max(fontSize * 0.08, measured);
    writeMeasureCache(key, width);
    return width;
};

export const measureTemperaGrapheme = (ctx, char, fontSize) => (
    char.trim().length === 0 ? fontSize * 0.3 : measureText(ctx, char, fontSize)
);

// Measures one word and lays its graphemes out inside the shaped width, so the sum of the
// per-glyph advances always equals what pretext reports for the whole word.
export const buildTemperaWordUnit = (
    ctx,
    segment,
    lineIndex,
    segmentIndex,
    fontSize,
    scale,
) => {
    const glyphs = segment.graphemes.filter(grapheme => grapheme.char.length > 0);
    if (glyphs.length === 0) return null;
    const scaledSize = fontSize * scale;
    const raw = glyphs.map(grapheme => measureTemperaGrapheme(ctx, grapheme.char, scaledSize));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const shaped = measureText(ctx, segment.text.replace(/\s+$/u, ''), scaledSize);
    // Distribute the shaping difference proportionally instead of nudging a single glyph.
    const correction = rawTotal > 0 ? shaped / rawTotal : 1;
    let offset = 0;
    const placed = glyphs.map((grapheme, index) => {
        const width = raw[index] * correction;
        const glyph = {
            char: grapheme.char,
            startTime: grapheme.startTime,
            endTime: grapheme.endTime,
            offset,
            width,
        };
        offset += width;
        return glyph;
    });
    return {
        lineIndex,
        segmentIndex,
        text: segment.text,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        leadingGap: 0,
        scale,
        width: offset,
        glyphs: placed,
        startTime: placed[0].startTime,
        endTime: placed[placed.length - 1].endTime,
    };
};
