/* Portions ported from chthollyphile/folia-major (AGPL-3.0) — Copyright (c) chthollyphile and contributors. See THIRD_PARTY_NOTICES.md */
// 移植自 scratch/folia-fresh/src/components/visualizer/sonnet/sonnetShotFrame.ts
// 逐行保真机械移植：仅删除类型标注，不改任何逻辑/数值/分支。
//
// 集成约定（本仓与上游的四处结构性差异，只在文件头集中适配，函数体逐行一致）：
//   1) MG 束：上游把 mgLayer / mgParticleLayer / mgFixedGeoLayer 平铺在 ShotView 上；
//      本仓挂在 shotView.mg（buildSonnetShotMg 返回的容器）上。下方 SHOT_MG_LAYERS
//      一次性取值，其余逐行一致。
//   2) audioBands / audioPower：上游是 framer-motion 的 MotionValue（`.get()`）；
//      本仓无那条 React 链路，由 SonnetEngine 传同形垫片（值来自 setAudioLevels 的 0~255 电平）。
//   3) mod(key)：上游走 Folium tunable（`options.modulation`）；本仓无 Folium，
//      调用方传 `() => 1`——与上游「缺省 1 = 不改变这一帧」完全等价。
//   4) zoomScale / focusSmoothingWindow：本仓设置面板的两条本地旋钮（「默认焦距」与
//      「运镜平滑速度」），上游没有对应物。默认值 1 / 0.12 保证与上游数值逐一相同。

import {
    clamp01,
    easeSonnetInOut,
    resolveSegmentProgress,
    resolveSonnetAnimationScale,
    resolveSonnetBreathWeight,
    resolveSonnetCameraBreath,
    resolveSonnetFocusWeights,
    resolveSonnetSmoothedCameraFocus,
    resolveShotMotionFrame,
    resolveShotProgress,
    resolveTimelineShake,
} from './sonnetMotion.js';
import { hashSonnetSeed } from './sonnetRandom.js';
import { isSonnetEmphasisRole } from './sonnetTypographyLayout.js';
import { resolveSonnetSegmentCameraFocus } from './sonnetCameraTracking.js';
import { clampSonnetScreenContainerTransform } from './sonnetViewportFit.js';

// src/components/visualizer/sonnet/sonnetShotFrame.ts
// 单个 shot 的逐帧姿态：镜头运动、间隙漂移与呼吸、逐段落焦点跟踪、MG / 引导线 / 开放画框时间，
// 以及逐字入场、视差、色差与回声。只按绝对播放时间和传入的设置写 view，不持有状态。

/** Reads a mod modulation key, falling back to 1 so the frame is unchanged when absent. */
export const readSonnetModulation = (modulation, key) => {
    const value = modulation?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 1;
};

/// 集成约定 1：上游三个平铺字段在本仓挂 shotView.mg 上。
const SHOT_MG_LAYERS = (view) => {
    const mg = view.mg || null;
    return {
        mgLayer: view.mgLayer || mg,
        mgParticleLayer: view.mgParticleLayer || (mg && mg.particleLayer) || null,
        mgFixedGeoLayer: view.mgFixedGeoLayer || (mg && mg.fixedGeoLayer) || null,
    };
};

// The camera-tracked segments and their focus windows are fixed once a shot is built, so they
// are worked out on the shot's first frame and reused for the rest of its life.
const shotTrackingCache = new WeakMap();

const resolveShotTracking = (view) => {
    const cached = shotTrackingCache.get(view);
    if (cached) return cached;
    let trackSegments = view.segments.filter(s => s.role !== 'decoration' && s.trackingGlyphs.length > 0);
    if (trackSegments.length === 0) {
        trackSegments = view.segments.filter(s => s.trackingGlyphs.length > 0);
    }
    const revealDoneTime = trackSegments.length > 0
        ? Math.max(...trackSegments.map(segment => segment.trackingGlyphs.at(-1)?.startTime ?? view.shot.endTime))
        : view.shot.endTime;
    const focusRanges = trackSegments.map(segment => ({
        startTime: segment.trackingGlyphs[0]?.startTime ?? view.shot.startTime,
        endTime: segment.trackingGlyphs.at(-1)?.startTime ?? view.shot.endTime,
    }));
    const tracking = { trackSegments, revealDoneTime, focusRanges };
    shotTrackingCache.set(view, tracking);
    return tracking;
};

export const updateSonnetShot = (
    view,
    time,
    width,
    height,
    shakeIntensity,
    { tuning, theme, audioBands, audioPower: audioPowerValue, mod, zoomScale = 1, focusSmoothingWindow = 0.12 },
) => {
    const progress = resolveShotProgress(view.shot, time);
    const motion = tuning.typographyMotion * resolveSonnetAnimationScale(theme) * mod('motionScale');
    const camera = tuning.cameraIntensity * resolveSonnetAnimationScale(theme) * mod('cameraScale');
    const cameraFrame = resolveShotMotionFrame(view.shot.kind, progress);

    // Add a slow continuous pan during the time gap to prevent the scene from looking frozen
    const gapTime = Math.max(0, time - view.shot.endTime);
    if (gapTime > 0) {
        // Inherit the movement direction from the tail end of the shot (progress 0.8 to 1.0)
        const tailStart = resolveShotMotionFrame(view.shot.kind, 0.8);
        const dx = cameraFrame.x - tailStart.x;
        const dy = cameraFrame.y - tailStart.y;
        const dScale = cameraFrame.scale - tailStart.scale;
        const dRot = cameraFrame.rotation - tailStart.rotation;

        // Continue drifting in that direction at a slow, relaxed PV pace
        // speed = 0.8 means it takes 1.25 seconds of gap to drift the same distance 
        // the camera covered in the last 20% of the shot.
        const maxDrift = 2.0;
        const driftSpeed = (1 - Math.exp(-gapTime * 0.4)) * maxDrift * mod('driftScale');
        cameraFrame.x += dx * driftSpeed;
        cameraFrame.y += dy * driftSpeed;
        cameraFrame.scale += dScale * driftSpeed;
        cameraFrame.rotation += dRot * driftSpeed;
    }

    const shake = resolveTimelineShake(time, shakeIntensity);

    const { trackSegments, revealDoneTime, focusRanges } = resolveShotTracking(view);

    // Layer a deterministic breathing float once the lyric reveal completes, so the
    // frame never goes fully static while the shot holds or drifts through a gap.
    const breathWeight = resolveSonnetBreathWeight(time, revealDoneTime);
    if (breathWeight > 0) {
        const breathPhase = (hashSonnetSeed(view.shot.id) % 1024) / 1024 * Math.PI * 2;
        const breath = resolveSonnetCameraBreath(time, breathPhase);
        const breathScale = mod('breathScale');
        cameraFrame.x += breath.x * breathWeight * breathScale;
        cameraFrame.y += breath.y * breathWeight * breathScale;
        cameraFrame.scale += breath.scale * breathWeight * breathScale;
        cameraFrame.rotation += breath.rotation * breathWeight * breathScale;
    }

    let currentFocusX = view.basePivotX;
    let currentFocusY = view.basePivotY;

    if (trackSegments.length > 0) {
        const resolveFocusAtTime = (focusTime) => {
            let focusX = 0;
            let focusY = 0;
            const focusWeights = resolveSonnetFocusWeights(focusRanges, focusTime);
            for (let i = 0; i < trackSegments.length; i++) {
                const seg = trackSegments[i];
                if (seg.trackingGlyphs.length === 0) continue;
                const weight = focusWeights[i] ?? 0;
                const pos = resolveSonnetSegmentCameraFocus(seg.trackingGlyphs, focusTime);
                focusX += pos.x * weight;
                focusY += pos.y * weight;
            }
            return { x: focusX, y: focusY };
        };
        const focusTime = Math.max(view.shot.startTime, Math.min(time, view.shot.endTime));
        const smoothedFocus = resolveSonnetSmoothedCameraFocus(
            focusTime,
            view.shot.startTime,
            view.shot.endTime,
            resolveFocusAtTime,
            focusSmoothingWindow,
        );

        currentFocusX = smoothedFocus.x;
        currentFocusY = smoothedFocus.y;
    }

    const pc = view.pivotClamp;
    let px = view.basePivotX + (currentFocusX - view.basePivotX) * camera;
    let py = view.basePivotY + (currentFocusY - view.basePivotY) * camera;
    if (pc) {
        if (Number.isFinite(pc.fxMin) && Number.isFinite(pc.fxMax) && pc.fxMin <= pc.fxMax) {
            px = Math.max(pc.fxMin, Math.min(pc.fxMax, px));
        }
        if (Number.isFinite(pc.fyMin) && Number.isFinite(pc.fyMax) && pc.fyMin <= pc.fyMax) {
            py = Math.max(pc.fyMin, Math.min(pc.fyMax, py));
        }
    }
    view.container.pivot.set(px, py);

    // 集成约定 4：`* zoomScale` 是本仓「默认焦距(镜头特写)」旋钮；上游此处无此因子。
    view.container.scale.set(
        view.shot.camera.zoom
        * zoomScale
        * (1 + (cameraFrame.scale - 1) * camera),
    );
    view.container.rotation = (
        view.shot.camera.rotation + cameraFrame.rotation + shake.rotation
    ) * camera;
    view.container.x = view.baseX + (cameraFrame.x * width + shake.x * width) * camera;
    view.container.y = view.baseY + (cameraFrame.y * height + shake.y * height) * camera;

    if (view.contentBounds) {
        const clamped = clampSonnetScreenContainerTransform(view.contentBounds, {
            width,
            height,
            marginX: Math.max(36, width * 0.065),
            marginY: Math.max(32, height * 0.075),
            pivotX: px,
            pivotY: py,
            x: view.container.x,
            y: view.container.y,
            scale: view.container.scale.x,
            rotation: view.container.rotation,
        });
        view.container.scale.set(clamped.scale);
        view.container.x = clamped.x;
        view.container.y = clamped.y;
    }

    const { mgLayer, mgParticleLayer, mgFixedGeoLayer } = SHOT_MG_LAYERS(view);

    if (mgParticleLayer) {
        // Create a slight time-difference/parallax effect for decorative elements
        const particleParallaxX = (cameraFrame.x * width + shake.x * width) * camera * 0.4 * mod('parallaxScale');
        const particleParallaxY = (cameraFrame.y * height + shake.y * height) * camera * 0.4 * mod('parallaxScale');
        mgParticleLayer.position.set(particleParallaxX, particleParallaxY);

        // Continuous independent rotation based on shot time
        mgParticleLayer.rotation = (time - view.shot.startTime) * 0.05 * mod('mgSwimScale');
        // Slower scale response creates depth illusion
        mgParticleLayer.scale.set(1 + (cameraFrame.scale - 1) * 0.3);
    }

    if (mgFixedGeoLayer) {
        // Keep fixed geometry upright regardless of camera rotation
        mgFixedGeoLayer.rotation = -view.container.rotation;
    }

    const audioBass = audioBands?.bass?.get?.() ?? 0;
    const audioPower = audioPowerValue?.get?.() ?? 0;
    const audioVocal = audioBands?.vocal?.get?.() ?? 0;

    if (mgLayer && mgLayer.updateTime) {
        mgLayer.updateTime(
            time,
            view.shot.cues,
            view.shot.startTime,
            view.shot.endTime,
            audioBass,
            audioPower,
            audioVocal,
        );
    }

    view.segments.forEach(segmentView => {
        const guide = segmentView.guide;
        const guideActive = time >= guide.startTime && time <= guide.endTime;
        guide.container.visible = guideActive && tuning.showGuide && !tuning.showOnlyText;
        if (guideActive) {
            const guideProgress = clamp01(
                (time - guide.startTime) / Math.max(0.001, guide.endTime - guide.startTime),
            );
            if (guide.update) {
                guide.container.alpha = guide.maxAlpha;
                guide.update(guideProgress);
            } else {
                const eased = easeSonnetInOut(guideProgress);
                guide.container.alpha = Math.sin(eased * Math.PI) * guide.maxAlpha;
                guide.container.scale.set(0.76 + eased * 0.24);
            }
        }

        // Decorative open frames share the 文字浮标 (showFixedGeo) toggle.
        const frameDecor = segmentView.frameDecor;
        if (frameDecor) {
            const frameVisible = tuning.showFixedGeo && !tuning.showOnlyText;
            frameDecor.container.visible = frameVisible;
            if (frameVisible) {
                frameDecor.update(clamp01(
                    (time - frameDecor.startTime) / Math.max(0.001, frameDecor.endTime - frameDecor.startTime),
                ));
            }
        }

        segmentView.glyphs.forEach(glyph => {
            const glyphProgress = resolveSegmentProgress(
                glyph.startTime,
                glyph.settleTime,
                time,
            );
            const waiting = time < glyph.startTime;
            const offset = (1 - glyphProgress) * motion;
            const coreAlpha = waiting ? 0 : 0.16 + glyphProgress * 0.84;
            const haloAlpha = waiting ? 0 : 1 - glyphProgress * 0.28;
            const scale = isSonnetEmphasisRole(segmentView.role) && view.shot.kind === 'type-impact'
                ? 0.52 + glyphProgress * 0.48
                : 0.86 + glyphProgress * 0.14;
            const x = glyph.baseX + glyph.enterX * offset;
            const y = glyph.baseY + glyph.enterY * offset;
            const rotation = glyph.finalRotation + glyph.entryRotation * offset;
            const isGiantDecorativeText = segmentView.role === 'decoration';
            const showTextGlyph = glyph.isTextGlyph !== false;
            const glyphVisible = tuning.showOnlyText
                ? showTextGlyph && (!isGiantDecorativeText || tuning.showGiantDecorativeText)
                : (!glyph.isBackgroundShape || tuning.showBackgroundDecor)
                    && (!isGiantDecorativeText || tuning.showGiantDecorativeText);

            // Simulated Parallax 3D effect
            const depth = glyph.zDepth || 0;
            const parallaxScale = mod('parallaxScale');
            // Move faster/slower than camera
            const parallaxX = (cameraFrame.x * width + shake.x * width) * camera * depth * 2.5 * parallaxScale;
            const parallaxY = (cameraFrame.y * height + shake.y * height) * camera * depth * 2.5 * parallaxScale;
            // Scale larger if closer to camera (positive depth)
            const depthScale = 1 + depth * 0.45 * parallaxScale;

            glyph.display.alpha = coreAlpha;
            glyph.display.visible = glyphVisible;
            glyph.display.scale.set(scale * depthScale);
            glyph.display.position.set(x + parallaxX, y + parallaxY);
            glyph.display.rotation = rotation;
            if (glyph.halo) {
                glyph.halo.alpha = haloAlpha;
                glyph.halo.scale.set(scale * (1.08 - glyphProgress * 0.08));
                glyph.halo.position.set(x, y);
                glyph.halo.rotation = rotation;
            }

            // Animate Chromatic Aberration separation and merging
            if (glyph.caWrapper && glyph.caCyan && glyph.caRed && glyph.caOffset) {
                const ca = glyph.caWrapper;
                ca.visible = glyphVisible && !tuning.showOnlyText;
                ca.alpha = coreAlpha;
                ca.scale.copyFrom(glyph.display.scale);
                ca.position.copyFrom(glyph.display.position);
                ca.rotation = rotation;
                // Starts separated (impact), and gently merges to a very subtle base offset
                const mergeEased = easeSonnetInOut(glyphProgress);
                const currentOffset = glyph.caOffset * (1 - mergeEased * 0.8) * mod('caScale'); // 1.0 -> 0.2

                glyph.caCyan.position.set(-currentOffset, currentOffset * 0.5);
                glyph.caRed.position.set(currentOffset, -currentOffset * 0.5);
            }

            // Semi-hero echo ghosts: split along the layout normal on glyph entry,
            // fade in over the first quarter, then quickly vanish. One-shot.
            if (glyph.ghosts && glyph.ghostDuration) {
                const ghostProgress = clamp01((time - glyph.startTime) / glyph.ghostDuration);
                const ghostActive = glyphVisible && ghostProgress > 0 && ghostProgress < 1;
                // Quick fade-in, then a squared falloff so the echo dies fast.
                const envelope = ghostProgress <= 0.2
                    ? ghostProgress / 0.2
                    : Math.pow(1 - (ghostProgress - 0.2) / 0.8, 2);
                const spread = (1 - Math.pow(1 - ghostProgress, 3)) * mod('ghostScale');
                for (const ghost of glyph.ghosts) {
                    ghost.node.visible = ghostActive;
                    if (!ghostActive) continue;
                    ghost.node.position.set(ghost.dirX * spread, ghost.dirY * spread);
                    ghost.node.alpha = envelope * ghost.alphaBase;
                }
            }

            glyph.updateAnimation?.(time);
        });
    });
};
