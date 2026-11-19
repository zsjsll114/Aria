/* ============================================================
 * sonnetViewportFit.js — 诗境 (Sonnet) 竖排 / 高焦距安全区适配纯函数
 *
 * 根因修复（verse_now.png）：
 *   1) fitContentToSafeArea 此前在桌面端设定 minFit=0.7，且仅 rawScale<0.8 才缩放，
 *      导致纵向竖排汉字高度超屏时仍被强行放回 0.7~1.0x，叠加 shot.camera.zoom(最高1.48)
 *      后上下两端彻底裁出视口，画面只剩零散装饰符号。
 *   2) 桌面端 zoomComp 曾截断在 1.2，无法抵消高焦距与 vertical 列的真实放大倍率。
 *   3) pivot 直接锚在偏心 heroPlacement 上，竖排或分栏偏移较大时会把半截词推到屏外。
 *
 * 全部纯数值计算，零 DOM / Pixi 依赖，供 SonnetEngine 与 Node 单测共享。
 * ============================================================ */

/**
 * 判断该镜头是否存在竖排主体（竖排汉字堆叠、vertical layoutDirection 或 ≈90° 旋转词块）。
 * @param {Array<Record<string, any>>} placements
 * @returns {boolean}
 */
export function hasVerticalSonnetContent(placements) {
    if (!Array.isArray(placements) || placements.length === 0) return false;
    return placements.some((b) => {
        if (!b || b.role === 'decoration') return false;
        if (b.vertical === true || b.layoutDirection === 'vertical') return true;
        const rot = Number(b.rotation) || 0;
        return Math.abs(Math.abs(rot) - Math.PI / 2) < 0.25;
    });
}

/**
 * 计算非装饰语义词块的联合包围盒。
 * @param {Array<Record<string, any>>} boxes
 * @returns {{minX:number, maxX:number, minY:number, maxY:number, boxW:number, boxH:number, centerX:number, centerY:number}|null}
 */
export function computeSonnetContentBounds(boxes) {
    if (!Array.isArray(boxes) || boxes.length === 0) return null;
    const content = boxes.filter((b) => b && b.role !== 'decoration');
    if (content.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const b of content) {
        const halfW = (Number(b.measuredWidth) || 0) / 2;
        const halfH = (Number(b.measuredHeight) || 0) / 2;
        const x = Number(b.x) || 0;
        const y = Number(b.y) || 0;
        minX = Math.min(minX, x - halfW);
        maxX = Math.max(maxX, x + halfW);
        minY = Math.min(minY, y - halfH);
        maxY = Math.max(maxY, y + halfH);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    const boxW = Math.max(1, maxX - minX);
    const boxH = Math.max(1, maxY - minY);
    return {
        minX,
        maxX,
        minY,
        maxY,
        boxW,
        boxH,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
    };
}

/**
 * 原地居中并将词块整体缩放进相机逆补偿后的安全区。
 * 保证竖排与长句在不失真的前提下完整落入视野。
 * @param {Array<Record<string, any>>} boxes
 * @param {{width:number, height:number, cameraZoom?:number, cameraZoomScale?:number, isCompactStage?:boolean}} opts
 * @returns {{scale:number, hasVertical:boolean, bounds:ReturnType<typeof computeSonnetContentBounds>}}
 */
export function fitSonnetPlacementsToSafeArea(boxes, opts = {}) {
    const width = Math.max(1, Number(opts.width) || 1280);
    const height = Math.max(1, Number(opts.height) || 720);
    const isCompactStage = Boolean(opts.isCompactStage);
    const hasVertical = hasVerticalSonnetContent(boxes);
    const camZoom = Math.max(0.5, Number(opts.cameraZoom) || 1);
    const userZoom = Math.max(0.5, Number(opts.cameraZoomScale) || 1);
    const zoomFactor = camZoom * userZoom * (isCompactStage ? 1.26 : (hasVertical ? 1.14 : 1.1));
    /* 紧凑屏或竖排堆栈不做 1.2 截断，否则高焦距会把竖排汉字顶底裁出画面 */
    const zoomComp = (isCompactStage || hasVertical)
        ? Math.max(1, zoomFactor)
        : Math.min(Math.max(1.2, zoomFactor * 0.88), Math.max(1, zoomFactor));

    const safeW = width * (isCompactStage ? 0.78 : (hasVertical ? 0.84 : 0.88)) / zoomComp;
    const safeH = height * (isCompactStage ? 0.74 : (hasVertical ? 0.80 : 0.84)) / zoomComp;

    const bounds = computeSonnetContentBounds(boxes);
    if (!bounds) return { scale: 1, hasVertical, bounds: null };

    const minFit = isCompactStage ? 0.22 : (hasVertical ? 0.34 : 0.55);
    const rawScale = Math.min(1, safeW / bounds.boxW, safeH / bounds.boxH);
    const trigger = (isCompactStage || hasVertical) ? 0.98 : 0.94;
    const scale = rawScale < trigger ? Math.max(rawScale, minFit) : 1;

    for (const b of boxes) {
        b.x = (b.x - bounds.centerX) * scale;
        b.y = (b.y - bounds.centerY) * scale;
        b.measuredWidth *= scale;
        b.measuredHeight *= scale;
        b.fontScale *= scale;
        b.enterX *= scale;
        b.enterY *= scale;
    }
    return { scale, hasVertical, bounds: computeSonnetContentBounds(boxes) };
}

/**
 * 夹紧镜头 pivot 与容器基点，防止以偏心 hero 为中心放大时把竖排主体推出画面边缘。
 * @param {{
 *   boxes: Array<Record<string, any>>,
 *   heroPlacement?: Record<string, any>|null,
 *   isPosterBlocks?: boolean,
 *   width: number,
 *   height: number,
 *   rawHeight?: number,
 *   cameraX?: number,
 *   cameraY?: number,
 *   cameraZoom?: number,
 *   cameraZoomScale?: number,
 *   isCompactStage?: boolean,
 * }} opts
 * @returns {{focusX:number, focusY:number, baseX:number, baseY:number}}
 */
export function clampSonnetPivotToViewport(opts) {
    const width = Math.max(1, Number(opts.width) || 1280);
    const height = Math.max(1, Number(opts.height) || 720);
    const rawHeight = Math.max(1, Number(opts.rawHeight) || height);
    const isCompactStage = Boolean(opts.isCompactStage);
    const isPosterBlocks = Boolean(opts.isPosterBlocks);
    const effScale = Math.max(0.5, (Number(opts.cameraZoom) || 1) * (Number(opts.cameraZoomScale) || 1));

    const hero = opts.heroPlacement || null;
    const rawFocusX = isPosterBlocks ? 0 : (hero ? Number(hero.x) || 0 : 0);
    const rawFocusY = isPosterBlocks ? 0 : (hero ? Number(hero.y) || 0 : 0);
    let focusX = isCompactStage ? rawFocusX * 0.35 : rawFocusX;
    let focusY = isCompactStage ? rawFocusY * 0.35 : rawFocusY;

    const camX = Number(opts.cameraX) || 0;
    const camY = Number(opts.cameraY) || 0;
    let baseX = width * (isPosterBlocks ? 0.5 : 0.5 + camX * (isCompactStage ? 0.35 : 1));
    let baseY = isPosterBlocks
        ? height / 2
        : (isCompactStage ? height / 2 : rawHeight / 2) + camY * height * (isCompactStage ? 0.1 : 0.2);

    const bounds = computeSonnetContentBounds(opts.boxes);
    if (!bounds) return { focusX, focusY, baseX, baseY, fxMin: -Infinity, fxMax: Infinity, fyMin: -Infinity, fyMax: Infinity };

    const marginX = width * 0.05;
    const marginY = height * 0.07;

    let fxMin = -Infinity;
    let fxMax = Infinity;
    const spanX = (bounds.maxX - bounds.minX) * effScale;
    const availW = Math.max(1, width - marginX * 2);
    if (spanX >= availW) {
        focusX = bounds.centerX;
        baseX = width / 2;
        fxMin = bounds.centerX;
        fxMax = bounds.centerX;
    } else {
        fxMin = bounds.maxX - (width - marginX - baseX) / effScale;
        fxMax = bounds.minX + (baseX - marginX) / effScale;
        if (fxMin <= fxMax) {
            focusX = Math.max(fxMin, Math.min(fxMax, focusX));
        } else {
            focusX = bounds.centerX;
            baseX = width / 2;
            fxMin = bounds.maxX - (width - marginX - baseX) / effScale;
            fxMax = bounds.minX + (baseX - marginX) / effScale;
        }
    }

    let fyMin = -Infinity;
    let fyMax = Infinity;
    const spanY = (bounds.maxY - bounds.minY) * effScale;
    const availH = Math.max(1, height - marginY * 2);
    if (spanY >= availH) {
        focusY = bounds.centerY;
        baseY = height / 2;
        fyMin = bounds.centerY;
        fyMax = bounds.centerY;
    } else {
        fyMin = bounds.maxY - (height - marginY - baseY) / effScale;
        fyMax = bounds.minY + (baseY - marginY) / effScale;
        if (fyMin <= fyMax) {
            focusY = Math.max(fyMin, Math.min(fyMax, focusY));
        } else {
            focusY = bounds.centerY;
            baseY = height / 2;
            fyMin = bounds.maxY - (height - marginY - baseY) / effScale;
            fyMax = bounds.minY + (baseY - marginY) / effScale;
        }
    }

    return { focusX, focusY, baseX, baseY, fxMin, fxMax, fyMin, fyMax };
}

/**
 * 终帧屏幕包围盒安全夹紧：在叠加动态 cameraFrame.scale / pan / rotation 之后，
 * 检查内容四角的真实屏幕投影；若越出安全边距则先等比微缩 scale，再平移 x/y 回框内，
 * 保证主词与长句绝不被推离屏幕左上/右下边缘。
 * @param {{minX:number, maxX:number, minY:number, maxY:number}|null} bounds
 * @param {{width:number, height:number, marginX?:number, marginY?:number, pivotX:number, pivotY:number, x:number, y:number, scale:number, rotation?:number}} opts
 * @returns {{scale:number, x:number, y:number}}
 */
export function clampSonnetScreenContainerTransform(bounds, opts) {
    let scale = Math.max(0.05, Number(opts.scale) || 1);
    let x = Number(opts.x) || 0;
    let y = Number(opts.y) || 0;
    if (!bounds) return { scale, x, y };

    const width = Math.max(1, Number(opts.width) || 1280);
    const height = Math.max(1, Number(opts.height) || 720);
    const rawMX = Number(opts.marginX);
    const rawMY = Number(opts.marginY);
    const marginX = Math.max(0, Number.isFinite(rawMX) ? rawMX : width * 0.045);
    const marginY = Math.max(0, Number.isFinite(rawMY) ? rawMY : height * 0.055);
    const px = Number(opts.pivotX) || 0;
    const py = Number(opts.pivotY) || 0;
    const rot = Number(opts.rotation) || 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    const project = (sc, cx, cy) => {
        const corners = [
            [bounds.minX, bounds.minY],
            [bounds.maxX, bounds.minY],
            [bounds.minX, bounds.maxY],
            [bounds.maxX, bounds.maxY],
        ];
        let sMinX = Infinity;
        let sMaxX = -Infinity;
        let sMinY = Infinity;
        let sMaxY = -Infinity;
        for (let i = 0; i < corners.length; i++) {
            const dx = (corners[i][0] - px) * sc;
            const dy = (corners[i][1] - py) * sc;
            const sx = cx + dx * cos - dy * sin;
            const sy = cy + dx * sin + dy * cos;
            if (sx < sMinX) sMinX = sx;
            if (sx > sMaxX) sMaxX = sx;
            if (sy < sMinY) sMinY = sy;
            if (sy > sMaxY) sMaxY = sy;
        }
        return { sMinX, sMaxX, sMinY, sMaxY };
    };

    const availW = Math.max(1, width - marginX * 2);
    const availH = Math.max(1, height - marginY * 2);
    let rect = project(scale, x, y);
    const spanW = rect.sMaxX - rect.sMinX;
    const spanH = rect.sMaxY - rect.sMinY;
    if (spanW > availW || spanH > availH) {
        const fitK = Math.min(availW / Math.max(1, spanW), availH / Math.max(1, spanH));
        scale *= Math.max(0.25, Math.min(1, fitK));
        rect = project(scale, x, y);
    }

    const rW = rect.sMaxX - rect.sMinX;
    const rH = rect.sMaxY - rect.sMinY;
    if (rW >= availW) {
        x += width * 0.5 - (rect.sMinX + rect.sMaxX) * 0.5;
    } else if (rect.sMinX < marginX) {
        x += marginX - rect.sMinX;
    } else if (rect.sMaxX > width - marginX) {
        x -= rect.sMaxX - (width - marginX);
    }

    if (rH >= availH) {
        y += height * 0.5 - (rect.sMinY + rect.sMaxY) * 0.5;
    } else if (rect.sMinY < marginY) {
        y += marginY - rect.sMinY;
    } else if (rect.sMaxY > height - marginY) {
        y -= rect.sMaxY - (height - marginY);
    }

    return { scale, x, y };
}
