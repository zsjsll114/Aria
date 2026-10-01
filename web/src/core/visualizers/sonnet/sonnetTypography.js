/**
 * sonnetTypography.js — folia sonnet 排版系统（三合一移植）
 *
 * 上游（chthollyphile/folia-major sonnet/）：
 *   sonnetTypographyRoles.ts（角色评分）+ sonnetTypographyLayout.ts（测量与调度）
 *   + sonnetShotFlowLayouts.ts（7 种镜头的流式布局）。
 * 差异：上游用 @chenglou/pretext 测量，这里用离屏 canvas 2D measureText（误差 <2%）。
 * 坐标系：舞台中心为原点，x 右 y 下，单位 px。
 */

import { hashSonnetSeed } from './sonnetRandom.js';

/* ===================== Roles（sonnetTypographyRoles.ts） ===================== */

export const isSonnetEmphasisRole = (role) => role === 'hero' || role === 'semi-hero';

/** 角色字重：手动配置优先；否则 hero/semi 900、support 700、decoration 300 */
export const resolveSonnetRoleFontWeight = (configuredFontWeight, role) => {
    const manual = typeof configuredFontWeight === 'number' ? configuredFontWeight : null;
    if (manual !== null) return manual;
    if (isSonnetEmphasisRole(role)) return 900;
    return role === 'decoration' ? 300 : 700;
};

export const getSonnetVisibleSegmentLength = (segment) => (
    segment.graphemes.filter(item => item.char.trim().length > 0).length
);

export const scoreSonnetHeroSegment = (segment) => {
    const lengthScore = Math.min(getSonnetVisibleSegmentLength(segment), 8) * 14;
    const durationScore = Math.min(2.5, Math.max(0, segment.endTime - segment.startTime)) * 18;
    return lengthScore + durationScore;
};

export const findSonnetHeroSegmentIndex = (segments) => {
    let bestIndex = segments.findIndex(segment => segment.isWordLike);
    let bestScore = -Infinity;
    segments.forEach((segment, index) => {
        if (!segment.isWordLike || getSonnetVisibleSegmentLength(segment) === 0) return;
        const score = scoreSonnetHeroSegment(segment);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return Math.max(0, bestIndex);
};

const SEMI_HERO_MIN_GAP = 2;
const SEMI_HERO_MIN_VISIBLE_LENGTH = 2;
const SEMI_HERO_MIN_LINE_WORDS = 4;
const SEMI_HERO_SCORE_RATIO = 0.35;
const SEMI_HERO_MULTI_WORD_COUNT = 9;

export const findSonnetSemiHeroSegmentIndices = (segments, heroIndex) => {
    const hero = segments[heroIndex];
    if (!hero) return [];
    const wordLikeCount = segments.filter(segment => (
        segment.isWordLike && getSonnetVisibleSegmentLength(segment) > 0
    )).length;
    if (wordLikeCount < SEMI_HERO_MIN_LINE_WORDS) return [];

    const threshold = scoreSonnetHeroSegment(hero) * SEMI_HERO_SCORE_RATIO;
    const candidates = segments
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment, index }) => (
            index !== heroIndex
            && segment.isWordLike
            && getSonnetVisibleSegmentLength(segment) >= SEMI_HERO_MIN_VISIBLE_LENGTH
            && Math.abs(index - heroIndex) >= SEMI_HERO_MIN_GAP
            && scoreSonnetHeroSegment(segment) >= threshold
        ));
    if (candidates.length === 0) return [];

    const bestOf = (list) => list.reduce((best, item) => (
        !best || scoreSonnetHeroSegment(item.segment) > scoreSonnetHeroSegment(best.segment)
            ? item : best
    ), null);

    const heroLeansEarly = heroIndex <= (segments.length - 1) / 2;
    const primarySide = candidates.filter(({ index }) => (heroLeansEarly ? index > heroIndex : index < heroIndex));
    const secondarySide = candidates.filter(({ index }) => (heroLeansEarly ? index < heroIndex : index > heroIndex));

    const picks = [];
    const primary = bestOf(primarySide) ?? bestOf(secondarySide);
    if (primary) picks.push(primary.index);
    if (wordLikeCount >= SEMI_HERO_MULTI_WORD_COUNT && primary) {
        const secondary = bestOf(secondarySide.filter(({ index }) => (
            Math.abs(index - primary.index) >= SEMI_HERO_MIN_GAP
        )));
        if (secondary) picks.push(secondary.index);
    }
    return picks.sort((first, second) => first - second);
};

/* ===================== 测量（pretext 替代：离屏 canvas） ===================== */

const MEASURE_CACHE_LIMIT = 20000;
const measureCache = new Map();
let measureCtx = null;

/** 离屏 2D 测量（fontSpec = "900 96px Family" 形式，与上游 pretext 键一致） */
export const measureText = (text, fontSpec, fontSize) => {
    const key = `${fontSpec}|${fontSize}|${text}`;
    const cached = measureCache.get(key);
    if (cached !== undefined) return cached;
    if (!measureCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        measureCtx = canvas.getContext('2d');
    }
    let width;
    try {
        measureCtx.font = fontSpec;
        width = measureCtx.measureText(text || ' ').width;
    } catch {
        width = (text || ' ').length * fontSize * 0.6;
    }
    if (measureCache.size >= MEASURE_CACHE_LIMIT) {
        const oldest = measureCache.keys().next();
        if (!oldest.done) measureCache.delete(oldest.value);
    }
    measureCache.set(key, width);
    return width;
};

/* ===================== FlowLayouts（sonnetShotFlowLayouts.ts） ===================== */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const resolveSonnetFlowGaps = (baseFontSize) => {
    const flowGap = clamp(baseFontSize * 0.35, 16, 40);
    return { flowGap, stackGap: Math.max(24, flowGap * 1.35) };
};

/** 全局等比重试：按 [1→0.52] 梯子整体缩放直到所有盒子进安全区 */
export const placeWithGlobalFit = (ctx, place) => {
    const snapshot = ctx.boxes.map(box => ({
        fontScale: box.fontScale,
        measuredWidth: box.measuredWidth,
        measuredHeight: box.measuredHeight,
    }));
    const safeHalfW = ctx.width * 0.48;
    const safeHalfH = ctx.height * 0.46;
    for (const globalScale of [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52]) {
        ctx.boxes.forEach((box, index) => {
            box.fontScale = snapshot[index].fontScale * globalScale;
            box.measuredWidth = snapshot[index].measuredWidth * globalScale;
            box.measuredHeight = snapshot[index].measuredHeight * globalScale;
        });
        place(globalScale);
        const fits = ctx.boxes.every(box => (
            Math.abs(box.x) + box.measuredWidth / 2 <= safeHalfW + 0.5
            && Math.abs(box.y) + box.measuredHeight / 2 <= safeHalfH + 0.5
        ));
        if (fits) return;
    }
};

/** 安静定格：竖列/横卡，前词向上后词向下，溢出换列 */
export const layoutQuietTableau = (ctx, variant) => {
    const { boxes, heroIndex, height, stackGap } = ctx;
    const heroBox = boxes[heroIndex];
    const horizontalCard = variant === 2 || variant === 3;
    boxes.forEach(box => { box.layoutDirection = horizontalCard ? 'horizontal' : 'vertical'; });
    const safeHalfH = height * 0.46;
    placeWithGlobalFit(ctx, () => {
        heroBox.x = 0;
        heroBox.y = horizontalCard ? 0 : -height * 0.1;
        const stagger = variant === 3 ? 70 : 0;
        const columnStep = Math.max(...boxes.map(box => box.measuredWidth)) + stackGap + stagger;
        const xFor = (box, index) => {
            if (variant === 1) return heroBox.x - heroBox.measuredWidth / 2 + box.measuredWidth / 2;
            if (variant === 3) return heroBox.x + ((index % 2 === 0) ? 1 : -1) * 35;
            return heroBox.x;
        };
        let column = 0;
        let currentY = heroBox.y - heroBox.measuredHeight / 2 - stackGap;
        for (let i = heroIndex - 1; i >= 0; i--) {
            const box = boxes[i];
            if (currentY - box.measuredHeight < -safeHalfH) {
                column += 1;
                currentY = safeHalfH;
            }
            box.x = xFor(box, i) + column * columnStep;
            box.y = currentY - box.measuredHeight / 2;
            currentY -= box.measuredHeight + stackGap;
            if (variant === 1) { box.enterX = 20; box.enterY = 0; }
            else if (variant === 3) { box.enterX = box.x > heroBox.x ? 30 : -30; box.enterY = 0; }
            else { box.enterX = 0; box.enterY = 20; }
        }
        column = 0;
        currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
        for (let i = heroIndex + 1; i < boxes.length; i++) {
            const box = boxes[i];
            if (currentY + box.measuredHeight > safeHalfH) {
                column += 1;
                currentY = -safeHalfH;
            }
            box.x = xFor(box, i) - column * columnStep;
            box.y = currentY + box.measuredHeight / 2;
            currentY += box.measuredHeight + stackGap;
            if (variant === 1) { box.enterX = -20; box.enterY = 0; }
            else if (variant === 3) { box.enterX = box.x > heroBox.x ? 30 : -30; box.enterY = 0; }
            else { box.enterX = 0; box.enterY = -20; }
        }
    });
};

/** 横移缎带：单横排，hero 前词向左、后词向右（严格阅读顺序） */
export const layoutTrackingRibbon = (ctx, variant) => {
    const { boxes, heroIndex, flowGap } = ctx;
    const heroBox = boxes[heroIndex];
    boxes.forEach(box => { box.layoutDirection = 'horizontal'; });
    placeWithGlobalFit(ctx, () => {
        heroBox.x = 0;
        heroBox.y = 0;
        const alignY = (box, index) => (
            variant === 1
                ? heroBox.y + heroBox.measuredHeight / 2 - box.measuredHeight / 2
                : variant === 2
                    ? heroBox.y - heroBox.measuredHeight / 2 + box.measuredHeight / 2
                    : heroBox.y + (index % 2 === 0 ? 10 : -10)
        );
        const enter = variant === 2 ? 20 : 30;
        let currentX = heroBox.x - heroBox.measuredWidth / 2 - flowGap;
        for (let i = heroIndex - 1; i >= 0; i--) {
            const box = boxes[i];
            box.x = currentX - box.measuredWidth / 2;
            box.y = alignY(box, i);
            currentX -= box.measuredWidth + flowGap;
            box.enterX = enter; box.enterY = 0;
        }
        currentX = heroBox.x + heroBox.measuredWidth / 2 + flowGap;
        for (let i = heroIndex + 1; i < boxes.length; i++) {
            const box = boxes[i];
            box.x = currentX + box.measuredWidth / 2;
            box.y = alignY(box, i);
            currentX += box.measuredWidth + flowGap;
            box.enterX = -enter; box.enterY = 0;
        }
    });
};

/** 编辑部双柱家族：5 变体（传统竖排/右缘栏/刊头/双行阶梯/Logo Badge） */
export const layoutEditorialColumn = (ctx, variant, secondaryHeroIndex) => {
    const { boxes, heroIndex, width, height, flowGap, stackGap } = ctx;
    const heroBox = boxes[heroIndex];

    if (variant === 0) {
        boxes.forEach(box => { box.layoutDirection = 'vertical'; });
        placeWithGlobalFit(ctx, () => {
            heroBox.x = -width * 0.15;
            heroBox.y = 0;
            let currentY = heroBox.y - heroBox.measuredHeight / 2 + stackGap * 0.5;
            for (let i = 0; i < heroIndex; i++) {
                const box = boxes[i];
                box.x = heroBox.x + heroBox.measuredWidth / 2 + flowGap + box.measuredWidth / 2;
                box.y = currentY + box.measuredHeight / 2;
                currentY += box.measuredHeight + stackGap;
                box.enterX = -20; box.enterY = 0;
            }
            currentY = heroBox.y - heroBox.measuredHeight / 2 + stackGap * 0.5;
            for (let i = heroIndex + 1; i < boxes.length; i++) {
                const box = boxes[i];
                box.x = heroBox.x - heroBox.measuredWidth / 2 - flowGap - box.measuredWidth / 2;
                box.y = currentY + box.measuredHeight / 2;
                currentY += box.measuredHeight + stackGap;
                box.enterX = 20; box.enterY = 0;
            }
        });
    } else if (variant === 1) {
        boxes.forEach(box => { box.layoutDirection = 'vertical'; });
        placeWithGlobalFit(ctx, () => {
            const rightEdge = width * 0.28;
            const safeHalfH = height * 0.46;
            const railStep = Math.max(...boxes.map(box => box.measuredWidth)) + stackGap;
            const totalHeight = boxes.reduce((sum, box) => sum + box.measuredHeight, 0)
                + stackGap * (boxes.length - 1);
            const fitsSingleRail = boxes.reduce((sum, box) => sum + box.measuredHeight, 0) * 0.52
                + stackGap * (boxes.length - 1) <= safeHalfH * 2;
            if (fitsSingleRail) {
                let currentY = -totalHeight / 2;
                boxes.forEach(box => {
                    box.x = rightEdge - box.measuredWidth / 2;
                    box.y = currentY + box.measuredHeight / 2;
                    currentY += box.measuredHeight + stackGap;
                    box.enterX = 20; box.enterY = 0;
                });
                return;
            }
            let rail = 0;
            let currentY = -safeHalfH;
            boxes.forEach(box => {
                if (currentY + box.measuredHeight > safeHalfH) {
                    rail += 1;
                    currentY = -safeHalfH;
                }
                box.x = (rightEdge - rail * railStep) - box.measuredWidth / 2;
                box.y = currentY + box.measuredHeight / 2;
                currentY += box.measuredHeight + stackGap;
                box.enterX = 20; box.enterY = 0;
            });
        });
    } else if (variant === 2) {
        boxes.forEach(box => { box.layoutDirection = 'horizontal'; });
        placeWithGlobalFit(ctx, () => {
            heroBox.x = 0;
            heroBox.y = -height * 0.25;
            const before = boxes.slice(0, heroIndex);
            const after = boxes.slice(heroIndex + 1);
            if (before.length > 0) {
                const kickerHeight = Math.max(...before.map(box => box.measuredHeight));
                const kickerWidth = before.reduce((sum, box) => sum + box.measuredWidth, 0)
                    + flowGap * (before.length - 1);
                const kickerY = heroBox.y - heroBox.measuredHeight / 2 - stackGap - kickerHeight / 2;
                let currentX = heroBox.x - kickerWidth / 2;
                before.forEach(box => {
                    box.x = currentX + box.measuredWidth / 2;
                    box.y = kickerY;
                    currentX += box.measuredWidth + flowGap;
                    box.enterX = 0; box.enterY = -20;
                });
            }
            const leftAnchor = heroBox.x - heroBox.measuredWidth * 0.25 - flowGap;
            const rightAnchor = heroBox.x + heroBox.measuredWidth * 0.25 + flowGap;
            let currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
            for (let pair = 0; pair < after.length; pair += 2) {
                const left = after[pair];
                const right = after[pair + 1];
                const rowHeight = Math.max(left.measuredHeight, right ? right.measuredHeight : 0);
                left.x = leftAnchor - left.measuredWidth / 2;
                left.y = currentY + left.measuredHeight / 2;
                left.enterX = -20; left.enterY = 0;
                if (right) {
                    right.x = rightAnchor + right.measuredWidth / 2;
                    right.y = currentY + right.measuredHeight / 2;
                    right.enterX = 20; right.enterY = 0;
                }
                currentY += rowHeight + stackGap;
            }
        });
    } else if (variant === 3) {
        boxes.forEach(box => { box.layoutDirection = 'horizontal'; });
        placeWithGlobalFit(ctx, () => {
            heroBox.x = 0;
            heroBox.y = 0;
            const firstHero = Math.min(heroIndex, secondaryHeroIndex);
            const line1 = boxes.slice(0, firstHero + 1);
            const line2 = boxes.slice(firstHero + 1);
            const line1Height = Math.max(...line1.map(box => box.measuredHeight));
            const line2Height = Math.max(...line2.map(box => box.measuredHeight));
            const totalHeight = line1Height + stackGap + line2Height;
            const line1Y = heroBox.y - totalHeight / 2 + line1Height / 2;
            const line2Y = line1Y + line1Height / 2 + stackGap + line2Height / 2;
            const layLine = (line, lineY, enterX) => {
                const lineWidth = line.reduce((sum, box) => sum + box.measuredWidth, 0)
                    + flowGap * Math.max(0, line.length - 1);
                let currentX = -lineWidth / 2;
                line.forEach(box => {
                    box.x = currentX + box.measuredWidth / 2;
                    box.y = lineY;
                    currentX += box.measuredWidth + flowGap;
                    box.enterX = enterX; box.enterY = 0;
                });
                return lineWidth;
            };
            const line1Width = layLine(line1, line1Y, 30);
            const line2Width = layLine(line2, line2Y, -30);
            const offsetAmount = Math.max(line1Width, line2Width) * 0.12;
            line1.forEach(box => { box.x -= offsetAmount; });
            line2.forEach(box => { box.x += offsetAmount; });
        });
    } else if (variant === 4) {
        boxes.forEach((box, index) => {
            box.layoutDirection = index === heroIndex ? 'vertical' : 'horizontal';
        });
        placeWithGlobalFit(ctx, () => {
            const heroOnRight = heroIndex === boxes.length - 1;
            const blockLeft = -width * 0.40;
            const blockRight = width * 0.40;
            let currentY = -height * 0.34;

            const flowWords = (indices, regionFor) => {
                let region = regionFor(currentY);
                let left = region[0];
                let right = region[1];
                let currentX = left;
                let rowHeight = 0;
                indices.forEach(index => {
                    const box = boxes[index];
                    if (currentX > left && currentX + box.measuredWidth > right) {
                        currentY += rowHeight + stackGap;
                        region = regionFor(currentY);
                        left = region[0];
                        right = region[1];
                        currentX = left;
                        rowHeight = 0;
                    }
                    box.x = currentX + box.measuredWidth / 2;
                    box.y = currentY + box.measuredHeight / 2;
                    box.enterX = heroOnRight ? -25 : 25;
                    box.enterY = 0;
                    currentX += box.measuredWidth + flowGap;
                    rowHeight = Math.max(rowHeight, box.measuredHeight);
                });
                if (indices.length > 0) currentY += rowHeight;
            };

            const beforeIndices = boxes.slice(0, heroIndex).map(box => box.index);
            const afterIndices = boxes.slice(heroIndex + 1).map(box => box.index);
            flowWords(beforeIndices, () => [blockLeft, blockRight]);
            currentY += stackGap;

            const pillarLeft = heroOnRight ? blockRight - heroBox.measuredWidth : blockLeft;
            heroBox.x = pillarLeft + heroBox.measuredWidth / 2;
            heroBox.y = currentY + heroBox.measuredHeight / 2;
            const pillarBottom = currentY + heroBox.measuredHeight + stackGap;
            const besideLeft = heroOnRight ? blockLeft : pillarLeft + heroBox.measuredWidth + flowGap;
            const besideRight = heroOnRight ? pillarLeft - flowGap : blockRight;
            flowWords(afterIndices, rowTop => (
                rowTop < pillarBottom - 0.5 ? [besideLeft, besideRight] : [blockLeft, blockRight]
            ));
        });
    }
};

/** 碎片拼贴：顺时针极轨 + 碰撞回避扫掠 */
export const layoutFragmentCollage = (ctx, variant) => {
    const { boxes, heroIndex, flowGap, stackGap } = ctx;
    const heroBox = boxes[heroIndex];
    const rectSeparation = (a, b) => Math.max(
        Math.max(a.left - b.right, b.left - a.right),
        Math.max(a.top - b.bottom, b.top - a.bottom),
    );
    boxes.forEach((box, index) => {
        if (index === heroIndex) return;
        if (Math.abs(Math.round(box.rotation / (Math.PI / 2)) % 2) === 1) {
            const rotatedWidth = box.measuredHeight;
            box.measuredHeight = box.measuredWidth;
            box.measuredWidth = rotatedWidth;
        }
        box.rotation = 0;
    });
    placeWithGlobalFit(ctx, (globalScale) => {
        heroBox.x = 0;
        heroBox.y = 0;
        const baseRadius = Math.hypot(heroBox.measuredWidth, heroBox.measuredHeight) / 2 + stackGap;
        const count = Math.max(1, boxes.length - 1);
        const squash = 0.65;
        const placed = [{
            left: heroBox.x - heroBox.measuredWidth / 2,
            right: heroBox.x + heroBox.measuredWidth / 2,
            top: heroBox.y - heroBox.measuredHeight / 2,
            bottom: heroBox.y + heroBox.measuredHeight / 2,
        }];
        let angle = Math.PI / 4;
        let supportIndex = 0;
        for (let i = 0; i < boxes.length; i++) {
            if (i === heroIndex) continue;
            const box = boxes[i];
            let radius = baseRadius;
            if (variant === 1) {
                radius += (35 + (supportIndex / count) * 150) * globalScale;
            } else if (variant === 2) {
                radius += ((supportIndex % 2 === 1) ? 140 : 50) * globalScale;
            } else {
                radius += (45 + ((supportIndex * 23) % 90)) * globalScale;
            }
            supportIndex += 1;
            let candidate = angle;
            let resolvedRadius = radius;
            let placedClear = false;
            for (let ring = 0; ring < 14 && !placedClear; ring += 1) {
                for (let attempt = 0; attempt < 400; attempt++) {
                    const rect = {
                        left: Math.cos(candidate) * resolvedRadius - box.measuredWidth / 2,
                        right: Math.cos(candidate) * resolvedRadius + box.measuredWidth / 2,
                        top: Math.sin(candidate) * resolvedRadius * squash - box.measuredHeight / 2,
                        bottom: Math.sin(candidate) * resolvedRadius * squash + box.measuredHeight / 2,
                    };
                    if (placed.every(entry => rectSeparation(entry, rect) >= flowGap)) {
                        placedClear = true;
                        break;
                    }
                    candidate += 0.07;
                }
                if (!placedClear) resolvedRadius += (36 + ring * 12) * globalScale;
            }
            angle = candidate + 0.02;
            placed.push({
                left: Math.cos(candidate) * resolvedRadius - box.measuredWidth / 2,
                right: Math.cos(candidate) * resolvedRadius + box.measuredWidth / 2,
                top: Math.sin(candidate) * resolvedRadius * squash - box.measuredHeight / 2,
                bottom: Math.sin(candidate) * resolvedRadius * squash + box.measuredHeight / 2,
            });
            box.x = heroBox.x + Math.cos(candidate) * resolvedRadius;
            box.y = heroBox.y + Math.sin(candidate) * resolvedRadius * squash;
            box.layoutDirection = Math.abs(Math.cos(candidate)) >= Math.abs(Math.sin(candidate))
                ? 'vertical' : 'horizontal';
            box.enterX = Math.cos(candidate) * -60;
            box.enterY = Math.sin(candidate) * -60;
        }
    });
};

/** 动态十字（type-impact / mask-reveal）：上列→左排→hero→右排→下列 */
export const layoutCrossStack = (ctx) => {
    const { boxes, heroIndex, height, flowGap, stackGap } = ctx;
    const heroBox = boxes[heroIndex];
    const topCount = Math.floor(heroIndex / 2);
    const afterCount = boxes.length - 1 - heroIndex;
    const rightCount = Math.ceil(afterCount / 2);

    const fillColumn = (column) => {
        if (column.length === 0) return 0;
        const available = Math.max(0, height * 0.46 - heroBox.measuredHeight / 2 - stackGap);
        if (available <= 0) return 0;
        const gaps = stackGap * (column.length - 1);
        const contentHeight = column.reduce((sum, box) => sum + box.measuredHeight, 0);
        const target = available * 0.72;
        if (contentHeight + gaps < target) {
            const boost = Math.min(2.2, (target - gaps) / Math.max(1, contentHeight));
            column.forEach(box => {
                const capped = Math.min(boost, (heroBox.fontScale * 0.6) / box.fontScale);
                if (capped > 1.05) {
                    box.fontScale *= capped;
                    box.measuredWidth *= capped;
                    box.measuredHeight *= capped;
                }
            });
        }
        if (column.length < 2) return 0;
        const grown = column.reduce((sum, box) => sum + box.measuredHeight, 0);
        const pitch = (available * 0.95 - grown) / (column.length - 1);
        return Math.max(0, Math.min(stackGap * 2, pitch - stackGap));
    };

    placeWithGlobalFit(ctx, () => {
        heroBox.x = 0;
        heroBox.y = 0;
        const topStretch = fillColumn(boxes.slice(0, topCount));
        const bottomStretch = fillColumn(boxes.slice(heroIndex + rightCount + 1));

        let currentX = heroBox.x - heroBox.measuredWidth / 2 - stackGap;
        for (let i = heroIndex - 1; i >= topCount; i--) {
            const box = boxes[i];
            box.layoutDirection = 'horizontal';
            box.x = currentX - box.measuredWidth / 2;
            box.y = heroBox.y + (i % 2 === 0 ? 10 : -10);
            currentX -= box.measuredWidth + flowGap;
            box.enterX = -30; box.enterY = 0;
        }

        let currentY = heroBox.y - heroBox.measuredHeight / 2 - stackGap;
        for (let i = topCount - 1; i >= 0; i--) {
            const box = boxes[i];
            box.layoutDirection = 'vertical';
            box.x = heroBox.x + (i % 2 === 0 ? 15 : -15);
            box.y = currentY - box.measuredHeight / 2;
            currentY -= box.measuredHeight + stackGap + topStretch;
            box.enterX = 0; box.enterY = -30;
        }

        currentX = heroBox.x + heroBox.measuredWidth / 2 + stackGap;
        for (let i = heroIndex + 1; i <= heroIndex + rightCount; i++) {
            const box = boxes[i];
            box.layoutDirection = 'horizontal';
            box.x = currentX + box.measuredWidth / 2;
            box.y = heroBox.y + (i % 2 === 0 ? 10 : -10);
            currentX += box.measuredWidth + flowGap;
            box.enterX = 30; box.enterY = 0;
        }

        currentY = heroBox.y + heroBox.measuredHeight / 2 + stackGap;
        for (let i = heroIndex + rightCount + 1; i < boxes.length; i++) {
            const box = boxes[i];
            box.layoutDirection = 'vertical';
            box.x = heroBox.x + (i % 2 === 0 ? 15 : -15);
            box.y = currentY + box.measuredHeight / 2;
            currentY += box.measuredHeight + stackGap + bottomStretch;
            box.enterX = 0; box.enterY = 30;
        }
    });
};

/* ===================== 排版主入口（sonnetTypographyLayout.ts） ===================== */

const CJK_TEXT = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

const shouldRotateNonCjkSegment = (segment, vertical) => (
    vertical
    && segment.graphemes.filter(item => item.char.trim().length > 0).length > 1
    && !CJK_TEXT.test(segment.text)
);

const verticalText = (segment) => (
    (segment.graphemes.length ? segment.graphemes.map(item => item.char) : Array.from(segment.text))
        .join('\n')
);

/**
 * 编排一个 shot 的文字排版。
 * @param {Object} opts {lines: segments[][], shotKind, paragraphKind, width, height, baseFontSize, fontFamily, fontWeight}
 * @returns {Array<SonnetTypographyPlacement>}
 */
export const resolveSonnetTypographyLayout = (opts) => {
    /* paragraphKind 在上游签名中存在但布局不消费，解构时省略（eslint no-unused-vars） */
    const { lines, shotKind, width, height, baseFontSize, fontFamily, fontWeight } = opts;
    const segments = lines.flat();

    /* shot 级唯一 hero（上游语义：一镜一主体）。此前按每行选 hero——4 行歌词
       产生 4 个巨字 hero + 4 个巨影 decoration 全屏重叠，观感完全崩坏（实测
       46 glyph 29 个在屏外/重叠成一片）。 */
    const heroIndex = findSonnetHeroSegmentIndex(segments);
    const semiHeroIndices = [];
    {
        let offset = 0;
        lines.forEach(lineSegs => {
            const localHero = findSonnetHeroSegmentIndex(lineSegs);
            findSonnetSemiHeroSegmentIndices(lineSegs, localHero)
                .forEach(localSemiHero => {
                    const globalIdx = offset + localSemiHero;
                    if (globalIdx !== heroIndex && !semiHeroIndices.includes(globalIdx)) {
                        semiHeroIndices.push(globalIdx);
                    }
                });
            offset += lineSegs.length;
        });
    }
    const midpoints = segments.map(segment => (segment.startTime + segment.endTime) / 2);
    const timelineStart = Math.min(...midpoints);
    const timelineEnd = Math.max(...midpoints);
    const timelineDuration = timelineEnd - timelineStart;
    const phases = midpoints.map((midpoint, index) => (
        timelineDuration > 0.001
            ? (midpoint - timelineStart) / timelineDuration
            : index / Math.max(1, segments.length - 1)
    ));
    const heroPhase = phases[heroIndex] ?? 0.5;

    const layoutVariantSeed = segments.reduce((acc, seg) => acc + (seg.text.trim().length || 1), 0) + segments.length;
    const posterLayoutSeed = hashSonnetSeed(segments.map(segment => segment.text).join('\u241f'));
    let editorialVariant = layoutVariantSeed % 5;
    const ribbonVariant = layoutVariantSeed % 3;
    const tableauVariant = layoutVariantSeed % 4;
    const collageVariant = layoutVariantSeed % 3;

    let secondaryHeroIndex = -1;
    if (editorialVariant === 3 && segments.length > 2) {
        let bestScore = -Infinity;
        segments.forEach((segment, index) => {
            if (index === heroIndex || !segment.isWordLike || getSonnetVisibleSegmentLength(segment) === 0) return;
            const distanceBonus = Math.abs(index - heroIndex) > 1 ? 50 : 0;
            const score = scoreSonnetHeroSegment(segment) + distanceBonus;
            if (score > bestScore) {
                bestScore = score;
                secondaryHeroIndex = index;
            }
        });
        if (secondaryHeroIndex === -1) editorialVariant = 0;
    } else if (editorialVariant === 3) {
        editorialVariant = 0;
    } else if (editorialVariant === 4 && segments.length < 2) {
        editorialVariant = 2;
    }

    // 1. 角色赋样式 + 测量（hero 全 shot 唯一，见上方 heroIndex）
    const boxes = segments.map((segment, index) => {
        const isHero = index === heroIndex
            || (index === secondaryHeroIndex && shotKind === 'editorial-column' && editorialVariant === 3);
        const isSemiHero = semiHeroIndices.includes(index) && !isHero;
        /* hero/support 字号倍率：switch 全分支覆盖（含 default），故不初始化 */
        let heroFontScale;
        let supportFontScale;
        let vertical = false;
        let rotation = 0;

        switch (shotKind) {
            case 'editorial-column':                if (editorialVariant === 3) {
                    heroFontScale = 3.8; supportFontScale = 1.3;
                } else if (editorialVariant === 4) {
                    heroFontScale = 4.2; supportFontScale = 1.25; vertical = isHero || isSemiHero;
                } else {
                    heroFontScale = editorialVariant === 2 ? 3.2 : 4.0;
                    supportFontScale = 1.2;
                    vertical = (isHero || isSemiHero) && editorialVariant !== 2;
                }
                break;
            case 'type-impact':
                heroFontScale = 5.5; supportFontScale = 1.5;
                break;
            case 'fragment-collage':
                heroFontScale = 3.2; supportFontScale = 1.35;
                vertical = isSemiHero || (index % 4) === 0;
                break;
            case 'tracking-ribbon':
                heroFontScale = 3.5; supportFontScale = 1.5;
                break;
            case 'mask-reveal':
                heroFontScale = 4.5; supportFontScale = 1.6; vertical = isHero || isSemiHero;
                break;
            case 'poster-blocks':
                heroFontScale = 4.4; supportFontScale = 1.15;
                break;
            case 'quiet-tableau':
            default:
                heroFontScale = 3.0; supportFontScale = 1.15;
                vertical = (isHero || isSemiHero) && (tableauVariant === 0 || tableauVariant === 1);
                break;
        }

        let fontScale = isHero
            ? heroFontScale
            : isSemiHero
                ? Math.max(supportFontScale * 1.35, heroFontScale * 0.72)
                : supportFontScale;

        const rotatesNonCjkSegment = shouldRotateNonCjkSegment(segment, vertical);
        if (rotatesNonCjkSegment) {
            vertical = false;
            rotation += Math.PI / 2;
        }

        const displayText = vertical ? verticalText(segment) : segment.text;
        const renderRole = isHero ? 'hero' : isSemiHero ? 'semi-hero' : 'support';
        const renderWeight = resolveSonnetRoleFontWeight(fontWeight, renderRole);

        let targetFontSize = baseFontSize * fontScale;
        const fontSpec = `${renderWeight} ${targetFontSize}px ${fontFamily}`;

        const horizontalAdvance = rotatesNonCjkSegment
            ? segment.graphemes.reduce((sum, item) => (
                item.char.trim().length > 0
                    ? sum + Math.max(targetFontSize * 0.2, measureText(item.char, fontSpec, targetFontSize))
                    : sum
            ), 0)
            : measureText(displayText, fontSpec, targetFontSize);

        let measuredWidth = rotatesNonCjkSegment ? targetFontSize * 1.2 : horizontalAdvance;
        let measuredHeight = rotatesNonCjkSegment ? horizontalAdvance : targetFontSize * 1.2;

        if (vertical) {
            const columnChars = segment.graphemes.length
                ? segment.graphemes.map(item => item.char)
                : Array.from(segment.text);
            const glyphAdvances = columnChars
                .filter(char => char.trim().length > 0)
                .map(char => Math.max(targetFontSize * 0.2, measureText(char, fontSpec, targetFontSize)));
            measuredWidth = glyphAdvances.length ? Math.max(...glyphAdvances) : targetFontSize;
            measuredHeight = Math.max(1, columnChars.length) * targetFontSize * 0.9;
        }

        const maxW = width * 0.82;
        const maxH = height * 0.82;
        let fitScale = 1.0;
        if (measuredWidth > maxW) fitScale = Math.min(fitScale, maxW / measuredWidth);
        if (measuredHeight > maxH) fitScale = Math.min(fitScale, maxH / measuredHeight);
        if (fitScale < 1.0) {
            targetFontSize *= fitScale;
            fontScale *= fitScale;
            measuredWidth *= fitScale;
            measuredHeight *= fitScale;
        }

        let posterVerticalDisplayText;
        let posterVerticalMeasuredWidth;
        let posterVerticalMeasuredHeight;
        let posterVerticalFontScale;
        if (shotKind === 'poster-blocks' && CJK_TEXT.test(segment.text)) {
            const columnChars = segment.graphemes.length
                ? segment.graphemes.map(item => item.char)
                : Array.from(segment.text);
            const glyphAdvances = columnChars
                .filter(char => char.trim().length > 0)
                .map(char => Math.max(targetFontSize * 0.2, measureText(char, fontSpec, targetFontSize)));
            let columnWidth = glyphAdvances.length ? Math.max(...glyphAdvances) : targetFontSize;
            let columnHeight = Math.max(1, columnChars.length) * targetFontSize * 0.9;
            const verticalFit = Math.min(1, maxW / columnWidth, maxH / columnHeight);
            columnWidth *= verticalFit;
            columnHeight *= verticalFit;
            posterVerticalDisplayText = verticalText(segment);
            posterVerticalMeasuredWidth = columnWidth;
            posterVerticalMeasuredHeight = columnHeight;
            posterVerticalFontScale = fontScale * verticalFit;
        }

        return {
            index,
            isHero,
            isSemiHero,
            displayText,
            verticalDisplayText: posterVerticalDisplayText,
            verticalMeasuredWidth: posterVerticalMeasuredWidth,
            verticalMeasuredHeight: posterVerticalMeasuredHeight,
            verticalFontScale: posterVerticalFontScale,
            fontScale,
            vertical,
            layoutDirection: 'horizontal',
            rotation,
            measuredWidth,
            measuredHeight,
            timingPhase: phases[index],
            relativePhase: phases[index] - heroPhase,
            role: undefined,
            x: 0,
            y: 0,
            enterX: 0,
            enterY: 0,
        };
    });

    // 2. 布局 packing
    const heroBox = boxes[heroIndex];
    if (heroBox) {
        if (shotKind === 'poster-blocks') {
            layoutSonnetPosterBlocks(boxes, width, height, baseFontSize, posterLayoutSeed);
        } else {
            const { flowGap, stackGap } = resolveSonnetFlowGaps(baseFontSize);
            const flowCtx = { boxes, heroIndex, width, height, flowGap, stackGap };
            if (shotKind === 'quiet-tableau') layoutQuietTableau(flowCtx, tableauVariant);
            else if (shotKind === 'tracking-ribbon') layoutTrackingRibbon(flowCtx, ribbonVariant);
            else if (shotKind === 'editorial-column') layoutEditorialColumn(flowCtx, editorialVariant, secondaryHeroIndex);
            else if (shotKind === 'fragment-collage') layoutFragmentCollage(flowCtx, collageVariant);
            else layoutCrossStack(flowCtx);
        }

        heroBox.enterX = 0;
        heroBox.enterY = height * 0.15;

        // 2.5 碰撞松弛（2026-09-29）：packing 公式对多词 shot 会把词块压成一坨
    //    （用户实测英文歌词满屏重叠成糊）。fitPass 只管出界不管内部重叠——
    //    这里对非 decoration 框做贪心解重叠：x 有交叠且 y 压叠时把下方框向下推，
    //    保住可读性；x 构图（各 layout 的个性所在）不动。decorations 尚未生成，
    //    在松弛后基于新坐标派生，与 hero 的相对构图保持一致。
    {
        const content = boxes.filter(b => b.role !== 'decoration');
        const gap = Math.max(4, baseFontSize * 0.10);
        for (let iter = 0; iter < 8; iter++) {
            let moved = false;
            const sorted = [...content].sort((a, b) => a.y - b.y);
            for (let i = 0; i < sorted.length; i++) {
                for (let j = i + 1; j < sorted.length; j++) {
                    const a = sorted[i];
                    const b = sorted[j];
                    const xOverlap = Math.min(a.x + a.measuredWidth / 2, b.x + b.measuredWidth / 2)
                        - Math.max(a.x - a.measuredWidth / 2, b.x - b.measuredWidth / 2);
                    const minDist = (a.measuredHeight + b.measuredHeight) / 2 + gap;
                    const yOverlap = minDist - Math.abs(b.y - a.y);
                    if (xOverlap > 0 && yOverlap > 0) {
                        /* ★ 对称推开（各半）：此前只把下方框下推，内容整体下坠——
                           正好坠进底部播放器栏区（用户实测 hero 词被 bar 遮住） */
                        a.y -= yOverlap / 2;
                        b.y += yOverlap / 2;
                        moved = true;
                    }
                }
            }
            if (!moved) break;
        }
    }

    // decoration 层：hero 的巨影重影（M1 保留——它是 type-impact 观感的重要组成）
        if (shotKind !== 'quiet-tableau' && shotKind !== 'poster-blocks') {
            const allHeroes = boxes.filter(b => b.isHero);
            const decorations = [];
            allHeroes.forEach((hBox, idx) => {
                decorations.push({
                    ...hBox,
                    isHero: false,
                    role: 'decoration',
                    fontScale: Math.max(2.8, Math.min(hBox.fontScale * 3.5, 5.5)),
                    vertical: false,
                    x: hBox.x - width * (0.1 - idx * 0.03),
                    y: hBox.y - height * (0.05 - idx * 0.02),
                    rotation: -0.15 + (idx % 2 === 0 ? 0 : 0.05),
                    enterX: -width * 0.05,
                    enterY: -height * 0.05,
                });
            });
            if (boxes.length > 1 && allHeroes.length > 0) {
                const dec2 = boxes[boxes.length - 1].isHero ? boxes[0] : boxes[boxes.length - 1];
                decorations.push({
                    ...dec2,
                    isHero: false,
                    role: 'decoration',
                    fontScale: Math.max(1.8, Math.min(allHeroes[0].fontScale * 2.2, 3.5)),
                    vertical: false,
                    x: allHeroes[0].x + width * 0.25,
                    y: allHeroes[0].y + height * 0.15,
                    rotation: 0.08,
                    enterX: width * 0.05,
                    enterY: height * 0.05,
                });
            }
            boxes.unshift(...decorations);
        }
    }

    // 3. fit-to-safe-area（2026-09-29）：任意布局公式的统一兜底。真实歌词（4 行 × 10+ 词）
    //    在多个 layout 变体下坐标直接出屏（实测 46 glyph 32 个 x<-450），观感是
    //    「只有 hero 词没有原文歌词」。非 decoration 框的 bbox 超出安全区时整体等比
    //    缩放 + 回中（decoration 跟随变换，与 hero 的相对构图保持）；缩放下限 0.5，
    //    宁可少量出血（上游海报风本有 bleed）也不过度缩小。
    {
        /* 安全区取中央 72%：再宽（0.46）时 support 行会贴边被裁（实测 y=-104 处
           整行字一半出画），观感是「没有歌词只有 hero」。
           ★ 不对称（2026-09-29 用户实测）：底部播放器栏会遮住 hero 词——上边界放宽
           0.44、下边界收到 0.28，内容整体偏上，底部 bar 区永不被正文占据。 */
        const safeHalfW = width * 0.36;
        const safeTop = height * 0.44;
        const safeBottom = height * 0.28;
        const content = boxes.filter(b => b.role !== 'decoration');
        let minX = Infinity; let maxX = -Infinity;
        let minY = Infinity; let maxY = -Infinity;
        content.forEach(b => {
            const hw = b.measuredWidth / 2;
            const hh = b.measuredHeight / 2;
            minX = Math.min(minX, b.x - hw);
            maxX = Math.max(maxX, b.x + hw);
            minY = Math.min(minY, b.y - hh);
            maxY = Math.max(maxY, b.y + hh);
        });
        if (content.length > 0 && maxX >= minX) {
            const spanX = maxX - minX;
            const spanY = maxY - minY;
            const overflow = Math.max(spanX / (safeHalfW * 2), spanY / (safeTop + safeBottom));
            const fitScale = overflow > 1 ? Math.max(0.5, 1 / overflow) : 1;
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            /* 回中目标上移 5%：可视重心避开底部 bar。缩放后 bbox 中心落在 0，
               统一再平移 targetY 即把内容重心放到 bar 之上的可视中心。 */
            const targetY = -height * 0.05;
            const applyShiftY = fitScale < 1 || Math.abs(centerY - targetY) > height * 0.02;
            const applyShiftX = fitScale < 1 || Math.abs(centerX) > width * 0.02;
            if (applyShiftX || applyShiftY) {
                boxes.forEach(b => {
                    if (applyShiftX) b.x = (b.x - centerX) * fitScale;
                    if (applyShiftY) b.y = (b.y - centerY) * fitScale + targetY;
                    if (fitScale < 1) {
                        b.measuredWidth *= fitScale;
                        b.measuredHeight *= fitScale;
                        b.fontScale *= fitScale;
                    }
                    b.enterX = (b.enterX || 0) * fitScale;
                    b.enterY = (b.enterY || 0) * fitScale;
                });
            }
        }
    }

    return boxes.map(box => ({
        segmentIndex: box.index,
        displayText: box.displayText,
        role: box.role || (box.isHero ? 'hero' : box.isSemiHero ? 'semi-hero' : 'support'),
        fontScale: box.fontScale,
        measuredWidth: box.measuredWidth,
        measuredHeight: box.measuredHeight,
        x: box.x,
        y: box.y,
        rotation: box.rotation,
        enterX: box.enterX,
        enterY: box.enterY,
        vertical: box.vertical,
        layoutDirection: box.layoutDirection,
        timingPhase: box.timingPhase,
    }));
};

/* poster-blocks 布局（sonnetPosterBlocksLayout.ts 的紧凑移植） */

export const layoutSonnetPosterBlocks = (boxes, width, height, baseFontSize, seed) => {
    const canvasLeft = -width * 0.42;
    const canvasTop = -height * 0.40;
    const canvasWidth = width * 0.84;
    const canvasHeight = height * 0.80;
    const { flowGap } = resolveSonnetFlowGaps(baseFontSize);
    const lineGap = flowGap * 1.15;
    const leftToRight = seed % 2 === 0;
    const ordered = leftToRight ? boxes : [...boxes].reverse();

    const usableH = canvasHeight * 0.9;
    const totalH = ordered.reduce((sum, box) => sum + box.measuredHeight, 0);
    const fit = Math.min(1, usableH / Math.max(1, totalH));
    ordered.forEach(box => {
        box.measuredWidth *= fit;
        box.measuredHeight *= fit;
        box.fontScale *= fit;
    });

    let cursorY = canvasTop + (canvasHeight - totalH * fit) / 2;
    ordered.forEach((box, index) => {
        const zone = 0.62 + ((seed >> (index + 1)) & 1) * 0.28;
        const zoneW = canvasWidth * zone;
        const alignRight = (((seed >> (index + 3)) & 1) === 1);
        const rowLeft = leftToRight
            ? canvasLeft + (canvasWidth - zoneW) / 2
            : canvasLeft + (canvasWidth - zoneW) / 2 + (canvasWidth - zoneW);
        const rowRight = rowLeft + zoneW;
        const x = alignRight
            ? rowRight - box.measuredWidth / 2
            : rowLeft + box.measuredWidth / 2;
        box.x = x;
        box.y = cursorY + box.measuredHeight / 2;
        box.layoutDirection = 'horizontal';
        box.enterX = alignRight ? 40 : -40;
        box.enterY = 0;
        cursorY += box.measuredHeight + lineGap;
    });
};
