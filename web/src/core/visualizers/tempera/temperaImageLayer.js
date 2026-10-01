/**
 * temperaImageLayer.js — 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaImageLayer.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * pixi 约定：`buildTemperaImageLayer` 首参 pixi 为注入的 pixi.js 模块
 * （{ Container, Sprite, Texture, ... }），与上游签名一致。
 */

import { clamp01, easeTemperaEnter, easeTemperaInOut } from './temperaMotion.js';
import { temperaHash01 } from './temperaRandom.js';

// src/components/visualizer/tempera/temperaImageLayer.ts
// The user's image pool on the canvas. Each shot picks one picture and places it itself, so an
// image carries only a tendency: hand-placing every one of them would defeat the pool. The
// sprite rides the same entrance stagger and flow creep as the composition, so a cut-out
// belongs to the shot rather than floating over it, and a `back` image sits among the artwork
// the lyric inverts against - the type then cuts across it the way it cuts across a tone block.
// (type PixiModule / type Texture 与接口 TemperaImagePlacement / TemperaImageLayerView /
//  TemperaImageLayerOptions 已随 TypeScript 类型标注一并移除。)

/** Horizontal bands each tendency draws from, as fractions of the viewport. */
const ALIGN_BANDS = {
    left: { from: 0.14, to: 0.32 },
    center: { from: 0.4, to: 0.6 },
    right: { from: 0.68, to: 0.86 },
    free: { from: 0.12, to: 0.88 },
};

/** Vertical bands mirror the horizontal grid so fixed positions read as a true 3x3 layout. */
const VERTICAL_ALIGN_BANDS = {
    top: { from: 0.14, to: 0.32 },
    center: { from: 0.4, to: 0.6 },
    bottom: { from: 0.68, to: 0.86 },
    free: { from: 0.12, to: 0.88 },
};

/**
 * Resolves where one picture lands in one shot. Pure and seed-driven, so a seek repaints the
 * identical frame and the same song always composes the same way.
 */
export const resolveTemperaImagePlacement = (
    image,
    seed,
) => {
    const horizontalBand = ALIGN_BANDS[image.align] ?? ALIGN_BANDS.free;
    const verticalBand = VERTICAL_ALIGN_BANDS[image.verticalAlign] ?? VERTICAL_ALIGN_BANDS.bottom;
    return {
        x: horizontalBand.from
            + (horizontalBand.to - horizontalBand.from) * temperaHash01(seed, 1, 251),
        y: verticalBand.from
            + (verticalBand.to - verticalBand.from) * temperaHash01(seed, 2, 257),
        scale: image.scale * (0.9 + temperaHash01(seed, 3, 263) * 0.2),
        rotation: (temperaHash01(seed, 4, 269) - 0.5) * 0.08,
        opacity: image.opacity,
        flip: temperaHash01(seed, 5, 271) > 0.5,
    };
};

/**
 * Picks the picture for a shot, or none at all. `previousId` keeps two neighbouring shots from
 * landing on the same one while the pool has alternatives.
 */
export const resolveTemperaShotImage = (
    pool,
    frequency,
    seed,
    previousId,
) => {
    if (pool.length === 0) return null;
    if (temperaHash01(seed, 6, 277) >= clamp01(frequency)) return null;
    const start = Math.floor(temperaHash01(seed, 7, 281) * pool.length) % pool.length;
    for (let offset = 0; offset < pool.length; offset += 1) {
        const candidate = pool[(start + offset) % pool.length];
        if (candidate.id !== previousId) return candidate;
    }
    return pool[start];
};

export const buildTemperaImageLayer = (
    pixi,
    options,
) => {
    const back = new pixi.Container();
    const front = new pixi.Container();
    const flowX = Math.cos(options.flowAngle);
    const flowY = Math.sin(options.flowAngle);
    const carry = Math.max(options.width, options.height) * 0.09;

    const chosen = resolveTemperaShotImage(options.pool, options.frequency, options.seed, options.previousId);
    const texture = chosen ? options.textures.get(chosen.id) : undefined;
    if (!chosen || !texture) {
        return {
            back,
            front,
            updateTime: () => undefined,
            applyPool: () => undefined,
            chosenId: chosen?.id ?? null,
        };
    }

    const sprite = new pixi.Sprite(texture);
    sprite.anchor.set(0.5);
    (options.depth === 'front' ? front : back).addChild(sprite);
    const creepScale = 0.6 + temperaHash01(options.seed, 8, 283) * 0.8;
    let baseX = 0;
    let baseY = 0;
    let baseAlpha = 1;

    // Height drives the scale so a cut-out keeps its proportions on any viewport.
    const place = (image) => {
        const placement = resolveTemperaImagePlacement(image, options.seed);
        const uniform = texture.height > 0 ? (options.height * placement.scale) / texture.height : 1;
        sprite.scale.set(uniform * (placement.flip ? -1 : 1), uniform);
        sprite.rotation = placement.rotation;
        baseX = placement.x * options.width;
        baseY = placement.y * options.height;
        baseAlpha = placement.opacity;
    };
    place(chosen);
    sprite.position.set(baseX, baseY);

    const applyPool = (pool) => {
        const next = pool.find(image => image.id === chosen.id);
        if (next) place(next);
    };

    const updateTime = (time, shotStart, shotEnd, lyricEnd) => {
        const duration = Math.max(shotEnd - shotStart, 0.2);
        const paceDuration = Math.max((lyricEnd ?? shotEnd) - shotStart, 0.2);
        const progress = clamp01((time - shotStart) / duration);
        // Images creep a little slower than the blocks, which reads as depth rather than as
        // the whole frame sliding as one slab.
        const creep = easeTemperaInOut(progress) * carry * 0.35 * creepScale;
        const enter = easeTemperaEnter((time - shotStart - paceDuration * 0.1) / (paceDuration * 0.5));
        sprite.alpha = baseAlpha * enter;
        sprite.visible = enter > 0.001;
        sprite.position.set(baseX + flowX * creep, baseY + flowY * creep);
    };

    return { back, front, updateTime, applyPool, chosenId: chosen.id };
};
