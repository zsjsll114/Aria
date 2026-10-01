/**
 * 机械移植自 chthollyphile/folia-major src/components/visualizer/sonnet/sonnetTextViewBuilder.ts
 * TS → ES Module JS 机械转换：删类型标注/类型 import，Pixi 实例经首参 pixi = { Container, Text, TextStyle } 注入。
 * 所有数值、公式、分支与上游逐行一致，未做任何优化。
 */

/* pretext 已 vendor 化（Aria 无构建管线，裸包名浏览器解析不了）——
   dist 全量拷贝至 web/vendor/pretext/，含 generated/bidi-data.js */
import { layoutWithLines, prepareWithSegments } from '../../../../vendor/pretext/layout.js';
/* 上游 import 'pixi.js/advanced-blend-modes'（注册高级混合模式）——Aria 用 vendor 全量
   pixi.mjs bundle，高级混合模式已内置，无需侧效应导入 */
// 上游 ./sonnetGlyphLayout —— 目标目录中 buildSonnetGlyphLayout 位于既有模块 sonnetTextView.js
import { buildSonnetGlyphLayout } from './sonnetTextView.js';
import { resolveSonnetSegmentDepth, resolveSonnetSegmentNormalOffset } from './sonnetMotion.js';
import { hashSonnetSeed } from './sonnetRandom.js';
import { buildSonnetStaffView } from './sonnetStaffView.js';
import { buildSonnetTextFixedGeo } from './sonnetTextFixedGeo.js';
import { resolveSonnetCameraTrackingGlyphs } from './sonnetCameraTracking.js';
// 上游 ./sonnetGuides（createSonnetGuide）
import { createSonnetGuide } from './sonnetGuides.js';
// 上游 ./sonnetFrameDecor（buildSonnetFrameDecor / resolveSonnetFrameDecorSpec）
import { buildSonnetFrameDecor, resolveSonnetFrameDecorSpec } from './sonnetFrameDecor.js';
// 上游 ./sonnetTypographyLayout（isSonnetEmphasisRole）与 ./sonnetTypographyRoles（resolveSonnetRoleFontWeight）
// —— 目标目录中二者均并入既有模块 sonnetTypography.js
import {
    isSonnetEmphasisRole,
} from './sonnetTypography.js';
import { resolveSonnetRoleFontWeight } from './sonnetTypography.js';

// src/components/visualizer/sonnet/sonnetTextViewBuilder.ts
// Creates parser-timed core/halo glyph pairs and their semantic guide view.

export const measureText = (text, fontSpec, fontSize) => {
    try {
        const layout = layoutWithLines(prepareWithSegments(text || ' ', fontSpec), 99999, fontSize * 1.2);
        return layout.lines[0]?.width ?? text.length * fontSize * 0.6;
    } catch {
        return text.length * fontSize * 0.6;
    }
};

export const buildSonnetTextView = (
    pixi,
    options,
) => {
    const { Text, TextStyle } = pixi;
    const { segment, placement: originalPlacement } = options;
    const placement = { ...originalPlacement };

    const fontSize = options.baseFontSize * placement.fontScale;
    const normalOffsetSeed = hashSonnetSeed([
        segment.text,
        segment.startOffset,
        segment.endOffset,
        options.segmentIndex,
        'normal-offset',
    ].join(':'));
    const normalOffset = resolveSonnetSegmentNormalOffset(
        placement.role,
        placement.layoutDirection,
        placement.rotation,
        fontSize,
        normalOffsetSeed / 0xffffffff,
    );
    placement.x += normalOffset.x;
    placement.y += normalOffset.y;
    /* ★ 2026-09-30 匹配放宽为子串双向：词块聚合后 segment 可能是「曾盼望」三字块，
       情感词「盼望」整词相等匹配会漏——双向包含即命中 */
    const keywordHit = (options.theme.wordColors || []).find(w => {
        const kw = (w.word || '').toLowerCase();
        if (!kw) return false;
        const st = segment.text.toLowerCase();
        return st === kw || st.includes(kw) || kw.includes(st);
    });
    const isKeyword = keywordHit;

    /* ★ Aria 适配（2026-09-30）：情感词不只染 glow——**字身也用情感色**，
       否则白字上 glow 色变几乎不可感知（用户实测「情感词没有显示」）。
       上游 bodyColor 恒主字色（上游情感词走 wordColors 但主界面观感不同）。 */
    const bodyColor = isKeyword ? isKeyword.color : options.theme.primaryColor;

    // The glow and decoration edges use keyword colors, or accent colors for support text
    const glowColor = isKeyword
        ? isKeyword.color
        : (isSonnetEmphasisRole(placement.role) ? options.theme.primaryColor : options.theme.accentColor);

    const isDecoration = placement.role === 'decoration';
    const renderWeight = resolveSonnetRoleFontWeight(options.fontWeight, placement.role);
    const fontSpec = `${renderWeight} ${fontSize}px ${options.fontFamily}`;

    // Parallax depth assignment
    const zDepth = resolveSonnetSegmentDepth(placement.role);

    const blurAmount = Math.abs(zDepth) * fontSize * 0.12;
    const isBlurry = blurAmount > 2;

    const baseDropShadow = options.glowEnabled && !isDecoration ? {
        color: glowColor,
        alpha: 0.8,
        blur: Math.max(12, fontSize * 0.18),
        distance: 0,
    } : undefined;

    const style = new TextStyle({
        fontFamily: options.fontFamily,
        fontWeight: String(renderWeight),
        fontSize,
        fill: (isDecoration ? 'transparent' : bodyColor),
        stroke: isDecoration ? { color: glowColor, width: Math.max(1, Math.min(8, fontSize * 0.006)) } : undefined,
        align: 'center',
        dropShadow: baseDropShadow,
        padding: baseDropShadow ? Math.max(20, baseDropShadow.blur * 2.5) : 0,
    });

    // Semi-hero echo ghosts: hollow (stroke-only) copies that split along the
    // normal of the layout flow direction, fade in and vanish quickly. Peak alpha
    // is kept low so they read as a faint afterimage, never competing with the core.
    const isSemiHero = placement.role === 'semi-hero';
    const ghostStyle = isSemiHero ? new TextStyle({
        fontFamily: options.fontFamily,
        fontWeight: String(renderWeight),
        fontSize,
        fill: 'transparent',
        stroke: { color: glowColor, width: Math.max(1, Math.min(8, fontSize * 0.006)) },
        align: 'center',
    }) : undefined;
    // Normal of the flow direction in screen space, converted into wrapper-local
    // coordinates so the ghosts inherit the wrapper's rotation correctly.
    const ghostNormal = (() => {
        const screen = placement.layoutDirection === 'vertical' ? { x: 1, y: 0 } : { x: 0, y: 1 };
        const cosine = Math.cos(-placement.rotation);
        const sine = Math.sin(-placement.rotation);
        return {
            x: screen.x * cosine - screen.y * sine,
            y: screen.x * sine + screen.y * cosine,
        };
    })();
    const ghostSpread = fontSize * 0.85;
    const ghostDuration = Math.min(
        0.7,
        Math.max(0.4, (options.shotEndTime - options.shotStartTime) * 0.12 + 0.1),
    );

    if (segment.text === '♪') {
        const staffView = buildSonnetStaffView(
            pixi,
            placement,
            options.theme,
            options.baseFontSize,
            options.shotStartTime,
            options.width,
            options.textLayer
        );
        const guide = createSonnetGuide(
            pixi,
            segment,
            placement,
            options.theme,
            fontSize,
            staffView.startTime,
        );
        if (!isDecoration) {
            options.guideLayer.addChild(guide.container);
        }
        return {
            segmentIndex: options.segmentIndex,
            displayText: segment.text,
            role: placement.role,
            fontScale: placement.fontScale,
            x: placement.x,
            y: placement.y,
            rotation: placement.rotation,
            enterX: placement.enterX,
            enterY: placement.enterY,
            vertical: placement.vertical,
            timingPhase: placement.timingPhase,
            guide,
            glyphs: [staffView],
            trackingGlyphs: [staffView],
        };
    }

    const glyphs = buildSonnetGlyphLayout(
        segment,
        placement,
        fontSize,
        char => measureText(char, fontSpec, fontSize),
        {
            startTime: options.shotStartTime,
            endTime: options.shotEndTime,
        },
    ).map(glyph => {
        const display = new Text({ text: glyph.char, style });
        display.anchor.set(0.5);
        if (isDecoration) display.alpha = 0.2;

        const wrapper = new pixi.Container();
        wrapper.rotation = placement.rotation;
        wrapper.position.set(glyph.baseX, glyph.baseY);
        wrapper.alpha = 0;

        // Chromatic Aberration (Dispersion) Effect
        let caWrapperNode;
        let caCyanNode;
        let caRedNode;
        let caOffsetValue;

        if (!isDecoration) {
            const isHero = isSonnetEmphasisRole(placement.role);
            const offset = fontSize * (isHero ? 0.025 : 0.010);
            caOffsetValue = offset;

            const caCyan = new Text({ text: glyph.char, style });
            caCyan.tint = 0x00ffff;
            caCyan.blendMode = 'screen';
            caCyan.anchor.set(0.5);
            caCyan.alpha = isHero ? 0.8 : 0.5;

            const caRed = new Text({ text: glyph.char, style });
            caRed.tint = 0xff0044;
            caRed.blendMode = 'screen';
            caRed.anchor.set(0.5);
            caRed.alpha = isHero ? 0.8 : 0.5;

            const caWrapper = new pixi.Container();
            caWrapper.rotation = wrapper.rotation;
            caWrapper.position.copyFrom(wrapper.position);
            caWrapper.alpha = 0;
            caWrapper.addChild(caCyan, caRed);
            options.caLayer.addChild(caWrapper);
            caWrapperNode = caWrapper;
            caCyanNode = caCyan;
            caRedNode = caRed;
        }

        wrapper.addChild(display);

        // Echo ghosts sit behind the core glyph; per-ghost dir/alpha precomputed.
        // Both echoes stack on one normal side (deterministic per segment) so the
        // afterimage reads as a directional streak rather than a symmetric blur.
        let ghosts;
        if (ghostStyle) {
            ghosts = [];
            const side = normalOffsetSeed % 2 === 0 ? 1 : -1;
            for (let layer = 1; layer <= 2; layer++) {
                const ghost = new Text({ text: glyph.char, style: ghostStyle });
                ghost.anchor.set(0.5);
                ghost.alpha = 0;
                ghost.visible = false;
                wrapper.addChildAt(ghost, 0);
                const factor = layer === 1 ? 1 : 1.7;
                ghosts.push({
                    node: ghost,
                    dirX: ghostNormal.x * side * factor * ghostSpread,
                    dirY: ghostNormal.y * side * factor * ghostSpread,
                    alphaBase: layer === 1 ? 0.3 : 0.16,
                });
            }
        }

        options.textLayer.addChild(wrapper);

        return {
            display: wrapper,
            halo: null,
            caWrapper: caWrapperNode,
            caCyan: caCyanNode,
            caRed: caRedNode,
            caOffset: caOffsetValue,
            ghosts,
            ghostDuration: ghosts ? ghostDuration : undefined,
            baseX: glyph.baseX,
            baseY: glyph.baseY,
            enterX: glyph.enterX,
            enterY: glyph.enterY,
            entryRotation: glyph.entryRotation,
            finalRotation: placement.rotation,
            startTime: glyph.startTime,
            settleTime: glyph.settleTime,
            zDepth,
            isTextGlyph: true,
        };
    });


    // Randomized background geometry accompanying specific text segments.
    // Kept rarer than before and mutually exclusive with the frame decor so the
    // two outline-style layers never stack on the same segment.
    const isChorusParagraph = options.paragraphKind === 'chorus';
    const textSeed = segment.text.split('').reduce((a, b) => a + b.charCodeAt(0), 0) + options.segmentIndex * 13;
    const isChorusEffect = isChorusParagraph || ((textSeed % 100) < 35);
    const shapeThreshold = isChorusEffect ? 26 : 15; // Higher chance in chorus effect
    const hasFrameDecor = resolveSonnetFrameDecorSpec(segment).applied;
    const shouldAddBgShape = options.showFixedGeo
        && (textSeed % 100) < shapeThreshold
        && !isDecoration
        && segment.isWordLike
        && !hasFrameDecor
        && glyphs.length > 0;

    if (shouldAddBgShape) {
        const bgWrapper = new pixi.Container();
        bgWrapper.position.set(placement.x, placement.y);
        bgWrapper.rotation = placement.rotation;
        bgWrapper.alpha = 0;

        const bgShape = buildSonnetTextFixedGeo(pixi, {
            seed: textSeed,
            isChorusEffect,
            fontSize,
            layoutWidth: options.width,
            theme: options.theme,
        });

        bgWrapper.addChild(bgShape);
        options.textLayer.addChildAt(bgWrapper, 0); // Ensure it stays behind the text

        const firstGlyph = glyphs[0];
        const bgGlyph = {
            display: bgWrapper,
            halo: null,
            baseX: placement.x,
            baseY: placement.y,
            enterX: placement.enterX,
            enterY: placement.enterY,
            entryRotation: 0,
            finalRotation: placement.rotation,
            startTime: firstGlyph.startTime,
            settleTime: firstGlyph.settleTime,
            zDepth: -0.5 - (textSeed % 5) * 0.1, // background depth for parallax
            isBackgroundShape: true,
            isTextGlyph: false,
        };
        glyphs.unshift(bgGlyph);
    }

    const guide = createSonnetGuide(
        pixi,
        segment,
        placement,
        options.theme,
        fontSize,
        glyphs[0]?.startTime ?? options.shotStartTime,
    );
    if (!isDecoration) {
        options.guideLayer.addChild(guide.container);
    }

    // Decorative open frame (30% of segments), kept behind the glyphs.
    const frameDecor = buildSonnetFrameDecor(pixi, {
        segment,
        placement,
        theme: options.theme,
        fontSize,
        shotStartTime: options.shotStartTime,
        shotEndTime: options.shotEndTime,
        firstGlyphStartTime: glyphs.find(glyph => glyph.isTextGlyph !== false)?.startTime
            ?? segment.startTime,
    });
    if (frameDecor) options.textLayer.addChildAt(frameDecor.container, 0);

    return {
        segmentIndex: options.segmentIndex,
        displayText: segment.text,
        role: placement.role,
        fontScale: placement.fontScale,
        x: placement.x,
        y: placement.y,
        rotation: placement.rotation,
        enterX: placement.enterX,
        enterY: placement.enterY,
        vertical: placement.vertical,
        timingPhase: placement.timingPhase,
        guide,
        frameDecor,
        glyphs,
        trackingGlyphs: resolveSonnetCameraTrackingGlyphs(glyphs),
    };
};
