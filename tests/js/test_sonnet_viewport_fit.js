import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../web/src/core/visualizers/sonnet/sonnetViewportFit.js');
const {
    hasVerticalSonnetContent,
    computeSonnetContentBounds,
    fitSonnetPlacementsToSafeArea,
    clampSonnetPivotToViewport,
    clampSonnetScreenContainerTransform,
} = mod;

test('hasVerticalSonnetContent：识别 vertical 竖排与 90° 旋转词块并排除装饰巨字', () => {
    assert.equal(hasVerticalSonnetContent([]), false);
    assert.equal(hasVerticalSonnetContent([
        { role: 'decoration', vertical: true, x: 0, y: 0, measuredWidth: 100, measuredHeight: 500 },
        { role: 'hero', vertical: false, rotation: 0, x: 0, y: 0, measuredWidth: 200, measuredHeight: 60 },
    ]), false);
    assert.equal(hasVerticalSonnetContent([
        { role: 'hero', vertical: true, rotation: 0, x: 0, y: 0, measuredWidth: 90, measuredHeight: 700 },
    ]), true);
    assert.equal(hasVerticalSonnetContent([
        { role: 'support', vertical: false, layoutDirection: 'vertical', x: 0, y: 0, measuredWidth: 80, measuredHeight: 400 },
    ]), true);
    assert.equal(hasVerticalSonnetContent([
        { role: 'hero', vertical: false, rotation: Math.PI / 2, x: 0, y: 0, measuredWidth: 60, measuredHeight: 500 },
    ]), true);
});

test('fitSonnetPlacementsToSafeArea：高焦距竖排汉字列不得被 0.7/1.2 截断放大出视口', () => {
    const boxes = [
        { role: 'hero', vertical: true, x: 0, y: -120, measuredWidth: 120, measuredHeight: 920, fontScale: 4.4, enterX: 0, enterY: 80 },
        { role: 'support', vertical: false, x: 180, y: 310, measuredWidth: 260, measuredHeight: 80, fontScale: 1.2, enterX: 0, enterY: 40 },
        { role: 'decoration', vertical: false, x: -300, y: -400, measuredWidth: 800, measuredHeight: 800, fontScale: 5.5, enterX: -50, enterY: -50 },
    ];
    const width = 1440;
    const height = 900;
    const cameraZoom = 1.48;
    const res = fitSonnetPlacementsToSafeArea(boxes, {
        width,
        height,
        cameraZoom,
        cameraZoomScale: 1,
        isCompactStage: false,
    });

    assert.equal(res.hasVertical, true);
    assert.ok(res.scale < 0.7, `竖排高堆叠在 1.48x 焦距下必须允许缩至 0.7 以下，实得 scale=${res.scale}`);
    const bounds = res.bounds;
    assert.ok(bounds);
    const renderedH = bounds.boxH * cameraZoom;
    assert.ok(renderedH <= height * 0.86, `放大后竖排总高 ${renderedH.toFixed(1)} 不得越过视口高度 ${height}`);
});

test('clampSonnetPivotToViewport：偏心竖排 hero 不得把语义主体推出画布边缘', () => {
    const boxes = [
        { role: 'hero', vertical: true, x: -40, y: -220, measuredWidth: 110, measuredHeight: 500, fontScale: 3.0, enterX: 0, enterY: 0 },
        { role: 'support', vertical: false, x: 90, y: 210, measuredWidth: 220, measuredHeight: 60, fontScale: 1.1, enterX: 0, enterY: 0 },
    ];
    const width = 1440;
    const height = 900;
    const cameraZoom = 1.45;
    fitSonnetPlacementsToSafeArea(boxes, {
        width,
        height,
        cameraZoom,
        cameraZoomScale: 1,
        isCompactStage: false,
    });
    const bounds = computeSonnetContentBounds(boxes);
    assert.ok(bounds);

    const hero = boxes[0];
    const piv = clampSonnetPivotToViewport({
        boxes,
        heroPlacement: hero,
        isPosterBlocks: false,
        width,
        height,
        rawHeight: height,
        cameraX: -0.05,
        cameraY: -0.25,
        cameraZoom,
        cameraZoomScale: 1,
        isCompactStage: false,
    });

    const topScreen = piv.baseY + (bounds.minY - piv.focusY) * cameraZoom;
    const bottomScreen = piv.baseY + (bounds.maxY - piv.focusY) * cameraZoom;
    const leftScreen = piv.baseX + (bounds.minX - piv.focusX) * cameraZoom;
    const rightScreen = piv.baseX + (bounds.maxX - piv.focusX) * cameraZoom;

    assert.ok(topScreen >= 0, `顶部 ${topScreen.toFixed(1)} 被裁出画面`);
    assert.ok(bottomScreen <= height, `底部 ${bottomScreen.toFixed(1)} > ${height} 被裁出画面`);
    assert.ok(leftScreen >= 0, `左侧 ${leftScreen.toFixed(1)} 被裁出画面`);
    assert.ok(rightScreen <= width, `右侧 ${rightScreen.toFixed(1)} > ${width} 被裁出画面`);
});

test('clampSonnetScreenContainerTransform：动态相机缩放与负偏移后仍把四角 clamp 在安全边距内', () => {
    const bounds = { minX: -520, maxX: 520, minY: -360, maxY: 360 };
    const width = 1440;
    const height = 804;
    const marginX = 64;
    const marginY = 44;
    const res = clampSonnetScreenContainerTransform(bounds, {
        width,
        height,
        marginX,
        marginY,
        pivotX: 160,
        pivotY: 40,
        x: 340,
        y: 120,
        scale: 1.65,
        rotation: 0.04,
    });
    assert.ok(res.scale < 1.65, '超宽/超高镜头叠加倍率后必须缩放进可用画框');
    const cos = Math.cos(0.04);
    const sin = Math.sin(0.04);
    for (const [cx, cy] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.minX, bounds.maxY], [bounds.maxX, bounds.maxY]]) {
        const dx = (cx - 160) * res.scale;
        const dy = (cy - 40) * res.scale;
        const sx = res.x + dx * cos - dy * sin;
        const sy = res.y + dx * sin + dy * cos;
        assert.ok(sx >= marginX - 1 && sx <= width - marginX + 1, `X=${sx.toFixed(1)} 越界`);
        assert.ok(sy >= marginY - 1 && sy <= height - marginY + 1, `Y=${sy.toFixed(1)} 越界`);
    }
});
