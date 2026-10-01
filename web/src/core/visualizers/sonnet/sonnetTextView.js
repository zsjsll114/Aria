/**
 * sonnetTextView.js — folia sonnet 文字视图构建（sonnetTextViewBuilder + sonnetGlyphLayout 移植）
 *
 * 每个字素一个 Pixi.Text（anchor 0.5）套 Container；hero/support 色彩分层、
 * CA 色散（cyan/red screen 混合）、semi-hero 残影 ghosts。M1 不含 guide/frameDecor/staff。
 */

import { isSonnetEmphasisRole, measureText, resolveSonnetRoleFontWeight } from './sonnetTypography.js';
import { resolveSonnetSegmentDepth, resolveSonnetSegmentNormalOffset } from './sonnetMotion.js';
import { hashSonnetSeed } from './sonnetRandom.js';

/** 逐字坐标与入场向量（上游 buildSonnetGlyphLayout） */
export const buildSonnetGlyphLayout = (segment, placement, fontSize, measureGlyph, motionWindow) => {
    const fallbackChars = Array.from(segment.text);
    const graphemes = segment.graphemes.length
        ? segment.graphemes
        : fallbackChars.map((char, index) => ({
            char,
            startTime: segment.startTime
                + (segment.endTime - segment.startTime) * index / Math.max(1, fallbackChars.length),
            endTime: segment.startTime
                + (segment.endTime - segment.startTime) * (index + 1) / Math.max(1, fallbackChars.length),
        }));
    const advances = graphemes.map(item => (
        placement.vertical ? fontSize * 0.9 : Math.max(fontSize * 0.2, measureGlyph(item.char))
    ));
    const totalAdvance = advances.reduce((sum, advance) => sum + advance, 0);
    const shotDuration = Math.max(0.001, motionWindow.endTime - motionWindow.startTime);
    /* ★ 2026-09-30 入场提速（用户实测「歌词文本入场过慢」）：上游 0.65-1.8s 偏慢，
       压缩到 0.45-1.0s，占比 0.42→0.32 */
    const preferred = Math.min(1.0, Math.max(0.45, shotDuration * 0.32));
    const motionDuration = Math.min(preferred, shotDuration * 0.55);
    let cursor = -totalAdvance / 2;
    return graphemes.map((grapheme, index) => {
        const advance = advances[index];
        const localX = placement.vertical ? 0 : cursor + advance / 2;
        const localY = placement.vertical ? cursor + advance / 2 : 0;
        cursor += advance;
        const cosine = Math.cos(placement.rotation);
        const sine = Math.sin(placement.rotation);
        const stagger = index % 2 === 0 ? -1 : 1;
        const startTime = grapheme.startTime;
        const settleTime = startTime + motionDuration;
        return {
            char: grapheme.char,
            baseX: placement.x + localX * cosine - localY * sine,
            baseY: placement.y + localX * sine + localY * cosine,
            enterX: placement.enterX + (placement.vertical ? stagger * fontSize * 0.28 : 0),
            enterY: placement.enterY + (placement.vertical ? 0 : stagger * fontSize * 0.24),
            entryRotation: stagger * (isSonnetEmphasisRole(placement.role) ? 0.055 : 0.035),
            startTime,
            settleTime: Math.max(startTime, settleTime),
        };
    });
};

/**
 * 构建一个 segment 的文字视图。
 * @returns {SegmentView} {glyphs, trackingGlyphs, ...placement}
 */
export const buildSonnetTextView = (pixi, options) => {
    const { Text, TextStyle } = pixi;
    const { segment } = options;
    const placement = { ...options.placement };

    const fontSize = options.baseFontSize * placement.fontScale;
    const normalOffsetSeed = hashSonnetSeed([
        segment.text, segment.startOffset, segment.endOffset,
        options.segmentIndex, 'normal-offset',
    ].join(':'));
    const normalOffset = resolveSonnetSegmentNormalOffset(
        placement.role, placement.layoutDirection, placement.rotation,
        fontSize, (normalOffsetSeed % 10000) / 10000,
    );
    placement.x += normalOffset.x;
    placement.y += normalOffset.y;

    const theme = options.theme || {};
    const primaryColor = theme.primaryColor || '#FFFFFF';
    const accentColor = theme.accentColor || theme.primaryColor || '#FFFFFF';
    /* ★ 2026-09-30 匹配放宽为子串双向：词块聚合后 segment 可能是「曾盼望」三字块，
       情感词「盼望」整词相等匹配会漏——双向包含即命中（上游 segment=词粒度时
       等价于原行为） */
    const keywordHit = (theme.wordColors || []).find(w => {
        const kw = (w.word || '').toLowerCase();
        if (!kw) return false;
        const st = segment.text.toLowerCase();
        return st === kw || st.includes(kw) || kw.includes(st);
    });
    const isKeyword = keywordHit;

    const bodyColor = primaryColor;
    const glowColor = isKeyword
        ? isKeyword.color
        : (isSonnetEmphasisRole(placement.role) ? primaryColor : accentColor);

    const isDecoration = placement.role === 'decoration';
    const renderWeight = resolveSonnetRoleFontWeight(options.fontWeight, placement.role);
    const fontSpec = `${renderWeight} ${fontSize}px ${options.fontFamily}`;

    const zDepth = resolveSonnetSegmentDepth(placement.role);

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
        fill: isDecoration ? 'transparent' : bodyColor,
        stroke: isDecoration
            ? { color: glowColor, width: Math.max(1, Math.min(8, fontSize * 0.006)) }
            : undefined,
        align: 'center',
        dropShadow: baseDropShadow,
        padding: baseDropShadow ? Math.max(20, baseDropShadow.blur * 2.5) : 0,
    });

    const isSemiHero = placement.role === 'semi-hero';
    const ghostStyle = isSemiHero ? new TextStyle({
        fontFamily: options.fontFamily,
        fontWeight: String(renderWeight),
        fontSize,
        fill: 'transparent',
        stroke: { color: glowColor, width: Math.max(1, Math.min(8, fontSize * 0.006)) },
        align: 'center',
    }) : undefined;
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
    const ghostDuration = Math.min(0.7, Math.max(0.4, (options.shotEndTime - options.shotStartTime) * 0.12 + 0.1));

    const glyphs = buildSonnetGlyphLayout(
        segment, placement, fontSize,
        char => measureText(char, fontSpec, fontSize),
        { startTime: options.shotStartTime, endTime: options.shotEndTime },
    ).map(glyph => {
        const display = new Text({ text: glyph.char, style });
        display.anchor.set(0.5);
        if (isDecoration) display.alpha = 0.2;

        const wrapper = new pixi.Container();
        wrapper.rotation = placement.rotation;
        wrapper.position.set(glyph.baseX, glyph.baseY);
        wrapper.alpha = 0;

        let caWrapper = undefined;
        let caCyan = undefined;
        let caRed = undefined;
        let caOffset = undefined;
        if (!isDecoration) {
            const isEmphasis = isSonnetEmphasisRole(placement.role);
            const offset = fontSize * (isEmphasis ? 0.025 : 0.010);
            caOffset = offset;
            /* ★ CA 层必须用纯白基底：tint 是乘法——上游 theme.primaryColor 是纯白，
               白 × cyan/red = 纯净青/红；Aria 的 primaryColor 是专辑取色（彩色），
               彩色 × tint 会得到暗彩色叠在字上（表现为字符一侧发暗）。
               独立 caStyle：fill 纯白、无 dropShadow（避免 glow 重影）。 */
            const caStyle = new TextStyle({
                fontFamily: options.fontFamily,
                fontWeight: String(renderWeight),
                fontSize,
                fill: '#FFFFFF',
                align: 'center',
            });
            caCyan = new Text({ text: glyph.char, style: caStyle });
            caCyan.tint = 0x00ffff;
            caCyan.blendMode = 'screen';
            caCyan.anchor.set(0.5);
            caCyan.alpha = isEmphasis ? 0.8 : 0.5;
            caRed = new Text({ text: glyph.char, style: caStyle });
            caRed.tint = 0xff0044;
            caRed.blendMode = 'screen';
            caRed.anchor.set(0.5);
            caRed.alpha = isEmphasis ? 0.8 : 0.5;
            const caWrapperNode = new pixi.Container();
            caWrapperNode.rotation = wrapper.rotation;
            caWrapperNode.position.copyFrom(wrapper.position);
            caWrapperNode.alpha = 0;
            caWrapperNode.addChild(caCyan, caRed);
            options.caLayer.addChild(caWrapperNode);
            caWrapper = caWrapperNode;
        }

        wrapper.addChild(display);

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
            caWrapper,
            caCyan,
            caRed,
            caOffset,
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
        glyphs,
        trackingGlyphs: glyphs,
    };
};
