/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetThemedShotMg.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
// （循环依赖：sonnetAdditionalShotMg ⇄ 本文件，按上游原样保留。）
import { drawSonnetCityFacadeMg, drawSonnetGreenhouseMg, drawSonnetPagodaMg } from './sonnetShotMgArchitecture.js';
import { drawSonnetClimbingVineMg, drawSonnetFernMg, drawSonnetGinkgoMg } from './sonnetShotMgBotanical.js';
import { drawSonnetCamelliaMg, drawSonnetTulipFieldMg, drawSonnetWildflowerMg } from './sonnetShotMgFlora.js';
import { drawSonnetCoastalCliffMg, drawSonnetMountainLakeMg, drawSonnetTerracesMg } from './sonnetShotMgLandscape.js';

// src/components/visualizer/sonnet/sonnetThemedShotMg.ts
// Registers the twelve themed backgrounds as one deterministic extension range.
export const SONNET_THEMED_GEO_VARIANT_START = 24;
export const SONNET_THEMED_GEO_VARIANT_COUNT = 12;

export const SONNET_THEMED_GEO_VARIANTS = [
    'camellia', 'tulip-field', 'wildflower',
    'fern', 'ginkgo', 'climbing-vine',
    'greenhouse', 'pagoda', 'city-facade',
    'terraces', 'mountain-lake', 'coastal-cliff',
];

const THEMED_DRAWERS = [
    drawSonnetCamelliaMg, drawSonnetTulipFieldMg, drawSonnetWildflowerMg,
    drawSonnetFernMg, drawSonnetGinkgoMg, drawSonnetClimbingVineMg,
    drawSonnetGreenhouseMg, drawSonnetPagodaMg, drawSonnetCityFacadeMg,
    drawSonnetTerracesMg, drawSonnetMountainLakeMg, drawSonnetCoastalCliffMg,
];

export const drawThemedSonnetShotMg = (options) => {
    const index = options.variant - SONNET_THEMED_GEO_VARIANT_START;
    const drawer = THEMED_DRAWERS[index];
    if (!drawer) return false;
    drawer(options);
    return true;
};
