/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetIcons.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
//
// TODO(集成者)：上游此文件头部 import React / react-dom/server / lucide-react，
// 用于把 Lucide 图标渲染成 SVG data URL 再交 Pixi 建 Texture。目标工程未引入
// React/lucide-react，故改为运行时软注入：
//   - 集成者在 Engine 侧调用 setSonnetIconRuntime({ React, renderToStaticMarkup, LucideIcons })
//     完成注入（Texture 队列/加载调用点由 Engine 侧处理）；
//   - 未注入时 resolveSonnetIconNames / buildSonnetIconDataUrl 的行为与上游在
//     “图标不存在”分支下完全一致（返回 ['Flower'] / null），纯逻辑函数不受影响。
//
// 纯逻辑导出（buildSonnetIconParticleIndices / resolveSonnetIconEntryPhase /
// resolveSonnetIconEntryDuration / resolveSonnetIconEntryDelay /
// buildSonnetIconTextureKey）与上游逐行一致。
// src/components/visualizer/sonnet/sonnetIcons.ts
// Validates theme icon names and produces cacheable SVG data URLs for Pixi.

let sonnetIconRuntime = null; // { React, renderToStaticMarkup, LucideIcons }
export const setSonnetIconRuntime = (runtime) => { sonnetIconRuntime = runtime; };

const resolveLucideIconEntry = (name) => {
    if (!sonnetIconRuntime || !sonnetIconRuntime.LucideIcons) return undefined;
    return sonnetIconRuntime.LucideIcons[name];
};

const listLucideIconNames = () => {
    if (!sonnetIconRuntime || !sonnetIconRuntime.LucideIcons) return [];
    return Object.keys(sonnetIconRuntime.LucideIcons);
};

const LUCIDE_ICON_NAMES = listLucideIconNames().filter(name => {
    const candidate = resolveLucideIconEntry(name);
    return /^[A-Z]/.test(name) && (typeof candidate === 'object' || typeof candidate === 'function');
});
const LUCIDE_ICON_NAMES_BY_LOWERCASE = new Map(LUCIDE_ICON_NAMES.map(name => [name.toLowerCase(), name]));

export const resolveSonnetIconNames = (names) => {
    const resolved = [
        ...new Set((names ?? [])
            .map(name => LUCIDE_ICON_NAMES_BY_LOWERCASE.get(name.toLowerCase()))
            .filter(Boolean)),
    ];
    return resolved.length > 0 ? resolved : ['Flower'];
};

// Spreads icon particles through the scene while guaranteeing every available theme icon is used.
export const buildSonnetIconParticleIndices = (
    iconCount,
    particleCount,
    seed,
) => {
    const safeIconCount = Math.max(0, Math.floor(iconCount));
    const safeParticleCount = Math.max(0, Math.floor(particleCount));
    if (safeIconCount === 0) {
        return Array.from({ length: safeParticleCount }, () => null);
    }

    const iconParticleCount = Math.min(
        safeParticleCount,
        Math.max(Math.ceil(safeParticleCount / 4), safeIconCount),
    );
    let emittedIconCount = 0;
    return Array.from({ length: safeParticleCount }, (_, index) => {
        const previousBand = Math.floor(index * iconParticleCount / safeParticleCount);
        const currentBand = Math.floor((index + 1) * iconParticleCount / safeParticleCount);
        if (currentBand === previousBand) {
            return null;
        }

        const iconIndex = ((seed + emittedIconCount) % safeIconCount + safeIconCount) % safeIconCount;
        emittedIconCount += 1;
        return iconIndex;
    });
};

// Distributes icon starts across most of a shot while reserving time for the final reveal.
export const resolveSonnetIconEntryPhase = (index, iconCount) => {
    const safeCount = Math.max(0, Math.floor(iconCount));
    if (safeCount <= 1) return 0.12;
    const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(index)));
    return 0.04 + (safeIndex / (safeCount - 1)) * 0.82;
};

export const resolveSonnetIconEntryDuration = (sceneDuration, preferredDuration) => {
    const safeSceneDuration = Math.max(0.01, sceneDuration);
    return Math.min(
        Math.max(0.01, preferredDuration),
        Math.max(0.08, safeSceneDuration * 0.18),
        safeSceneDuration,
    );
};

export const resolveSonnetIconEntryDelay = (
    entryPhase,
    sceneDuration,
    entryDuration,
) => Math.min(1, Math.max(0, entryPhase)) * Math.max(0, sceneDuration - entryDuration);

export const buildSonnetIconTextureKey = (
    name,
    color,
    strokeWidth,
    size,
    resolution,
) => `${name}|${color}|${strokeWidth}|${size}|${resolution}`;

export const buildSonnetIconDataUrl = (
    name,
    color,
    strokeWidth,
    size,
) => {
    const Icon = resolveLucideIconEntry(name);
    if (!Icon) return null;
    const markup = sonnetIconRuntime.renderToStaticMarkup(sonnetIconRuntime.React.createElement(Icon, {
        size,
        color,
        strokeWidth,
        absoluteStrokeWidth: true,
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
    }));
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
};
