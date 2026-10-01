// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetExtendedShotMg.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
import { SONNET_CELESTIAL_DRAWERS, SONNET_CELESTIAL_GEO_VARIANTS } from './sonnetShotMgCelestial.js';
import { SONNET_MARINE_DRAWERS, SONNET_MARINE_GEO_VARIANTS } from './sonnetShotMgMarine.js';
import { SONNET_MUSIC_DRAWERS, SONNET_MUSIC_GEO_VARIANTS } from './sonnetShotMgMusic.js';
import { SONNET_CRAFT_DRAWERS, SONNET_CRAFT_GEO_VARIANTS } from './sonnetShotMgCraft.js';
import { SONNET_KINETIC_DRAWERS, SONNET_KINETIC_GEO_VARIANTS } from './sonnetShotMgKinetic.js';

// src/components/visualizer/sonnet/sonnetExtendedShotMg.ts
// Registers the 52 extended themed backgrounds (geo variants 48-99) as one
// deterministic range, dispatched to the per-topic drawer tables.

export const SONNET_EXTENDED_GEO_VARIANT_START = 48;
export const SONNET_EXTENDED_GEO_VARIANT_COUNT = 52;

export const SONNET_EXTENDED_GEO_VARIANTS = [
    ...SONNET_CELESTIAL_GEO_VARIANTS,
    ...SONNET_MARINE_GEO_VARIANTS,
    ...SONNET_MUSIC_GEO_VARIANTS,
    ...SONNET_CRAFT_GEO_VARIANTS,
    ...SONNET_KINETIC_GEO_VARIANTS,
];

const EXTENDED_DRAWERS = [
    ...SONNET_CELESTIAL_DRAWERS,
    ...SONNET_MARINE_DRAWERS,
    ...SONNET_MUSIC_DRAWERS,
    ...SONNET_CRAFT_DRAWERS,
    ...SONNET_KINETIC_DRAWERS,
];

export const drawExtendedSonnetShotMg = (options) => {
    const index = options.variant - SONNET_EXTENDED_GEO_VARIANT_START;
    const drawer = EXTENDED_DRAWERS[index];
    if (!drawer) return false;
    drawer(options);
    return true;
};
