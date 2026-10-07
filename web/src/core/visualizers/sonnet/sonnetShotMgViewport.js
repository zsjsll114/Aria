/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetShotMgViewport.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
// src/components/visualizer/sonnet/sonnetShotMgViewport.ts
// Resolves overscan extents so open MG paths continue beyond every viewport edge.
export const resolveSonnetShotMgBleed = (width, height, radius) => ({
    x: Math.max(radius * 0.92, width * 0.64),
    y: Math.max(radius * 0.92, height * 0.64),
});
