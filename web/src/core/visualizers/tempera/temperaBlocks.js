/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
/**
 * 机械移植自 chthollyphile/folia-major src/components/visualizer/tempera/temperaBlocks.ts
 * 逐行保真移植：仅删除类型标注，不改任何逻辑/数值/分支。
 * （type PixiModule / type Graphics / TemperaDecorSpec / TemperaShotKind / TemperaPalette /
 *  TemperaBlockOptions / TemperaCompositionContext / TemperaBlocksView / TemperaBlocksOptions /
 *  BlockItem 等类型导入与接口已随 TypeScript 类型一并移除。）
 */

import { clamp01, easeTemperaEnter, easeTemperaInOut, resolveShotPacedDuration } from './temperaMotion.js';
import { temperaHash01 } from './temperaRandom.js';
import { drawTemperaComposition } from './temperaCompositions.js';
import { mvBackdropAlpha } from '../mvBackdrop.js';

// src/components/visualizer/tempera/temperaBlocks.ts
// Screentone MG layer per shot: owns enter/exit motion state and delegates all geometry to
// temperaCompositions. Timings are fractions of the shot's own duration, so the graphics
// advance with the lyric rather than finishing in a fixed fraction of a second. Nothing here
// reacts to audio; a seek repaints exactly the same frame.

/**
 * `shotEnd` is when the shot stops being shown; `lyricEnd` is when its last grapheme stops.
 * The two differ because shot ends are tiled up to the next shot's start. The stagger is
 * paced against the lyric so the graphics land with the words, while the creep runs for the
 * whole visible life so a shot with a long instrumental tail never freezes.
 */
/** Direction the whole composition travels in; shared with the camera and transitions. */
/** Fractions of the shot duration, resolved to seconds at update time. */

export const buildTemperaBlocks = (
    pixi,
    options,
) => {
    const container = new pixi.Container();
    const items = [];
    const flowX = Math.cos(options.flowAngle);
    const flowY = Math.sin(options.flowAngle);
    // Per-item stagger distance only. The bulk of the hand-off travel belongs to the shot
    // container, which moves the type along with the graphics.
    const carry = Math.max(options.width, options.height) * 0.09;

    const add = (node, blockOptions = {}, parent) => {
        items.push({
            node,
            baseX: node.x,
            baseY: node.y,
            baseAlpha: blockOptions.alpha ?? 1,
            enterDX: blockOptions.enterDX ?? 0,
            enterDY: blockOptions.enterDY ?? 0,
            delayFraction: blockOptions.delay ?? 0,
            spanFraction: blockOptions.span ?? 0.45,
            drift: blockOptions.drift ?? false,
            driftPhase: temperaHash01(options.seed, items.length, 173) * Math.PI * 2,
            grow: blockOptions.grow ?? false,
        });
        (parent ?? container).addChild(node);
    };

    // Tilted sub-groups (poster compositions) keep their children in local coordinates.
    const createGroup = (rotation, x, y) => {
        const group = new pixi.Container();
        group.rotation = rotation;
        group.position.set(x, y);
        container.addChild(group);
        return group;
    };

    const context = {
        pixi,
        kind: options.kind,
        palette: options.palette,
        decor: options.decor,
        width: options.width,
        height: options.height,
        seed: options.seed,
        showDecor: options.showDecor,
        flowAngle: options.flowAngle,
        bleed: carry + Math.max(options.width, options.height) * 0.08,
        // Gradient mode only: a per-shot axis so neighbouring compositions do not all ramp
        // the cover colours the same way.
        gradient: options.palette.gradient
            ? { colors: options.palette.gradient, angle: temperaHash01(options.seed, 3, 197) * Math.PI * 2 }
            : null,
        add,
        createGroup,
    };
    drawTemperaComposition(context);

    // Drives block motion from absolute time so seeks render the same frame. There is no exit
    // ramp here: the shot container owns the hand-off slide, so the outgoing composition
    // leaves as one piece with its own type still attached to it.
    const updateTime = (time, shotStart, shotEnd, lyricEnd) => {
        const duration = Math.max(shotEnd - shotStart, 0.2);
        const paceDuration = Math.max((lyricEnd ?? shotEnd) - shotStart, 0.2);
        const progress = clamp01((time - shotStart) / duration);
        // A steady creep along the flow vector for the whole shot; the camera rides the same
        // axis, so the frame is always already moving when the next composition arrives.
        const creep = easeTemperaInOut(progress) * carry * 0.35;
        const budget = Math.max(0.5, paceDuration);
        // 铺了 MV 背景时把构图色块整体压薄，让底下的 MV 透出来。
        // 只乘在这里（= 只乘 Graphics 色块/装饰），**不碰 glyphs**——
        // 歌词字必须保持满不透明，否则 MV 一动字就忽明忽暗。
        // 每帧读一次就够（items 十几个），换模式/开关 MV 立刻生效，无需重建场景。
        // ★ 必须带 host：设置面板里那块预览窗底下没有 MV，压薄只会让它变透明。
        const backdrop = mvBackdropAlpha(options.host);

        for (const item of items) {
            const rawDelay = resolveShotPacedDuration(paceDuration, item.delayFraction, 0, 1.4);
            const rawSpan = resolveShotPacedDuration(paceDuration, item.spanFraction, 0.7, 2.6);
            // Short shots compress the whole stagger instead of dropping the late items.
            const compress = Math.min(1, budget / (rawDelay + rawSpan));
            const enter = easeTemperaEnter((time - shotStart - rawDelay * compress) / (rawSpan * compress));
            item.node.alpha = item.baseAlpha * enter * backdrop;
            item.node.visible = enter > 0.001;
            const behind = (1 - enter) * carry - creep;
            item.node.position.set(
                item.baseX + item.enterDX * (1 - enter) - flowX * behind,
                item.baseY + item.enterDY * (1 - enter) - flowY * behind,
            );
            if (item.drift || item.grow) {
                // A slow float replaces the old audio pulse: deterministic, seek-safe, and it
                // keeps decor from looking frozen once the shot has settled.
                const float = item.drift ? 1 + Math.sin(time * 0.5 + item.driftPhase) * 0.02 : 1;
                item.node.scale.set(item.grow ? Math.max(0.0001, enter) * float : float, float);
                if (item.drift) item.node.rotation = Math.sin(time * 0.33 + item.driftPhase) * 0.012;
            }
        }
    };

    return { container, updateTime };
};
