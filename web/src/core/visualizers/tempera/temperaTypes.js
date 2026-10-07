/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * temperaTypes.js — 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/types.ts
 * 逐行保真移植：仅保留有运行时值的导出（TEMPERA_SHOT_KINDS / TEMPERA_TRANSITION_KINDS /
 * TEMPERA_DECOR_MOTIFS），纯 TypeScript 类型（interface / type）不移植。
 */

// src/components/visualizer/tempera/types.ts
// Public, renderer-independent contracts for the deterministic Tempera block PV program.
/**
 * Every composition Tempera can cut to. Shots are half-phrase sized by default, so the list
 * has to be long enough that a paragraph rarely repeats one; `temperaShotProfiles.ts` carries
 * the layout region / camera / mood for each, and `temperaCompositions.ts` the drawing.
 */
export const TEMPERA_SHOT_KINDS = [
    // Splits and grids
    'duo-split',
    'quad-split',
    'tri-column',
    'thirds-stack',
    'checker-quad',
    'corner-wedge',
    'diagonal-halves',
    'cross-axis',
    'offset-halves',
    'stair-blocks',
    'pillar-gap',
    'corner-quad',
    'sliver-stack',
    // Bands
    'band-strip',
    'horizon-band',
    'deep-dive',
    'tone-ramp',
    'double-band',
    'tilt-band',
    'edge-rails',
    'gradient-wall',
    'terrace',
    // Frames and windows
    'frame-window',
    'double-frame',
    'circle-window',
    'ladder-frame',
    'corner-brackets',
    'inset-box',
    'bracket-pair',
    'arch-window',
    'grid-cells',
    'keyhole',
    // Posters and shapes
    'poster-panel',
    'diamond-stack',
    'slash-poster',
    'arrow-wedge',
    'edge-bleed',
    'triangle-mass',
    'ribbon-cross',
    'half-disc',
    'stacked-slabs',
    'wedge-pair',
    // Sparse fields
    'quiet-line',
    'starfield-dots',
    'ripple-lines',
    'hair-grid',
    'margin-rule',
    'dot-drift',
    'arc-sweep',
    'blank-page',
    // Cinema mattes: a solid frame with a window of a given aspect punched out of it.
    'cinema-scope',
    'cinema-wide',
    'cinema-academy',
    'cinema-square',
    'cinema-portrait',
    'cinema-tall',
    'cinema-twin',
    // Rounded shapes laid on a flat field, after visual novel promo PVs. Every other family
    // cuts the frame with straight edges; these keep the field whole and put curves on it.
    'bubble-drift',
    'cloud-window',
    'heart-burst',
    'sparkle-field',
    'petal-arc',
    'scallop-band',
    'ribbon-loop',
    'round-plate',
    'halo-burst',
    // Punched plates. The opening is cut clean through the tone, so the shell's live
    // background shows in it - see `compositions/temperaCutout.ts`.
    'iris-hole',
    'slot-rail',
    'punch-row',
    'film-gate',
    'cross-vent',
    'louvre-slats',
    'ring-eye',
    'notch-stack',
    'wedge-gap',
    'dot-sieve',
    // Instrument panels: measured geometric decoration around one heavy focal mass.
    'sight-mark',
    'dial-scale',
    'chevron-run',
    'tally-column',
    'grid-focus',
    'axis-caps',
    'strobe-slats',
    'offset-plate',
    'radial-comb',
    'bracket-target',
    // Corridors: openings cut along the flow vector, so the hand-off between two shots keeps
    // the same opening moving instead of cutting to a new one.
    'flow-channel',
    'twin-channel',
    'reed-run',
    'taper-channel',
    'chain-ports',
    'dash-channel',
    'window-run',
    'bridge-span',
    'braid-channel',
    'port-ladder',
    // Brutalist monoliths: one enormous matte solid, cropped by the frame, type on its edge.
    'apex-mass',
    'ziggurat',
    'slab-wall',
    'cantilever',
    'pylon-pair',
    'bunker-slit',
    'plinth-stack',
    'buttress-run',
    'void-core',
    'shear-block',
    // The same language read as ground and structure rather than as objects.
    'ridge-line',
    'chasm',
    'overhang',
    'step-well',
    'pier-row',
    'revetment',
    'tower-crop',
    'lintel',
    'rubble-fan',
    'gnomon',
    // Monogatari-style interstitials: one flat field, type as the whole picture.
    'monogatari-card',
    'monogatari-rule',
    'monogatari-edge',
    'monogatari-stack',
    'monogatari-flash',
];
/**
 * Every transition is led by the large graphics or the camera; nothing dissolves or cuts
 * hard, because a dissolve reads as an edit and Tempera's compositions should hand off.
 */
export const TEMPERA_TRANSITION_KINDS = [
    'block-wipe',
    'camera-pan',
    'shape-carry',
];

export const TEMPERA_DECOR_MOTIFS = [
    'diamonds',
    'hatch-twin',
    'band-cross',
    'poster-diamond',
    'doodle',
];
