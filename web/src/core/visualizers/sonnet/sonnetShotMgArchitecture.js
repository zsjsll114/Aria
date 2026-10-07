/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetShotMgArchitecture.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
import { fillPolygon, strokePolygon } from './sonnetThemedShotMgPrimitives.js';
import { resolveSonnetShotMgBleed } from './sonnetShotMgViewport.js';

// src/components/visualizer/sonnet/sonnetShotMgArchitecture.ts
// Draws architectural elevations with blueprint outlines and differently shaded structural planes.
export const drawSonnetGreenhouseMg = ({ target, radius, width, height, seed, primary, secondary }) => {
    const direction = seed % 2 === 0 ? 1 : -1;
    const bleed = resolveSonnetShotMgBleed(width, height, radius);
    const shell = [
        [-radius * 0.7, radius * 0.58], [-radius * 0.7, -radius * 0.12],
        [0, -radius * 0.62], [radius * 0.7, -radius * 0.12], [radius * 0.7, radius * 0.58],
    ];
    fillPolygon(target, shell, primary, 0.055);
    strokePolygon(target, shell, primary, 0.68, 3);
    target.moveTo(0, -radius * 0.62).lineTo(0, radius * 0.58).stroke({ color: secondary, width: 2, alpha: 0.5 });
    for (let pane = -3; pane <= 3; pane += 1) {
        const x = pane * radius * 0.18;
        target.moveTo(x, radius * 0.58).lineTo(x * 0.38, -radius * (0.58 - Math.abs(pane) * 0.04))
            .stroke({ color: pane % 2 ? secondary : primary, width: 1, alpha: 0.32 });
    }
    const doorX = radius * 0.2 * direction;
    target.rect(doorX - radius * 0.13, radius * 0.08, radius * 0.26, radius * 0.5)
        .fill({ color: secondary, alpha: 0.1 });
    target.rect(doorX - radius * 0.13, radius * 0.08, radius * 0.26, radius * 0.5)
        .stroke({ color: secondary, width: 2, alpha: 0.62 });
    target.moveTo(-bleed.x, radius * 0.58).lineTo(-radius * 0.7, radius * 0.58)
        .stroke({ color: primary, width: 1, alpha: 0.3 });
    target.moveTo(radius * 0.7, radius * 0.58).lineTo(bleed.x, radius * 0.58)
        .stroke({ color: primary, width: 1, alpha: 0.3 });
};

export const drawSonnetPagodaMg = ({ target, radius, width, height, seed, primary, secondary }) => {
    const lean = seed % 2 === 0 ? 1 : -1;
    const bleed = resolveSonnetShotMgBleed(width, height, radius);
    for (let floor = 0; floor < 4; floor += 1) {
        const y = radius * (0.47 - floor * 0.27);
        const halfWidth = radius * (0.5 - floor * 0.075);
        const roof = [
            [-halfWidth * 1.18, y], [-halfWidth, y - radius * 0.11],
            [0, y - radius * 0.19], [halfWidth, y - radius * 0.11], [halfWidth * 1.18, y],
        ];
        fillPolygon(target, roof, floor % 2 ? secondary : primary, 0.07 + floor * 0.025);
        strokePolygon(target, roof, floor % 2 ? secondary : primary, 0.58, 2);
        target.rect(-halfWidth * 0.68, y, halfWidth * 1.36, radius * 0.17)
            .fill({ color: primary, alpha: 0.035 + floor * 0.018 });
        target.rect(-halfWidth * 0.68, y, halfWidth * 1.36, radius * 0.17)
            .stroke({ color: primary, width: 1, alpha: 0.36 });
    }
    target.moveTo(0, -radius * 0.62).lineTo(radius * 0.035 * lean, -radius * 0.78)
        .stroke({ color: secondary, width: 3, alpha: 0.65 });
    target.moveTo(-bleed.x, radius * 0.64).lineTo(-radius * 0.52, radius * 0.64)
        .stroke({ color: secondary, width: 1, alpha: 0.22 });
    target.moveTo(radius * 0.52, radius * 0.64).lineTo(bleed.x, radius * 0.64)
        .stroke({ color: secondary, width: 1, alpha: 0.22 });
};

export const drawSonnetCityFacadeMg = ({ target, radius, width, height, seed, primary, secondary }) => {
    const bleed = resolveSonnetShotMgBleed(width, height, radius);
    const heights = [0.52, 0.88, 0.66, 1.08, 0.74, 0.94, 0.58];
    const buildingWidth = radius * 0.205;
    heights.forEach((heightRatio, index) => {
        const x = radius * (-0.73 + index * 0.24);
        const height = radius * heightRatio;
        const color = index % 3 === 1 ? secondary : primary;
        target.rect(x, radius * 0.62 - height, buildingWidth, height)
            .fill({ color, alpha: 0.045 + (index % 3) * 0.035 });
        target.rect(x, radius * 0.62 - height, buildingWidth, height)
            .stroke({ color, width: index === 3 ? 3 : 1.5, alpha: 0.5 });
        for (let row = 0; row < Math.floor(heightRatio * 6); row += 1) {
            for (let column = 0; column < 2; column += 1) {
                if ((row + column + index + seed) % 3 === 0) {
                    target.rect(x + radius * (0.035 + column * 0.085), radius * 0.53 - height + row * radius * 0.13, radius * 0.045, radius * 0.055)
                        .fill({ color: column ? secondary : primary, alpha: 0.2 });
                }
            }
        }
    });
    target.moveTo(-bleed.x, radius * 0.63).lineTo(bleed.x, radius * 0.63)
        .stroke({ color: primary, width: 4, alpha: 0.48 });
};
