// 移植自 scratch/folia-major/src/components/visualizer/sonnet/sonnetThemedShotMgPrimitives.ts
// 逐行保真机械移植：仅删除类型标注（interface/type 均为纯类型，无运行时值），不改任何逻辑。
// src/components/visualizer/sonnet/sonnetThemedShotMgPrimitives.ts
// Shared path recipes keep themed shot MG motifs consistent and inexpensive to construct.

const tracePolygon = (target, points) => {
    points.forEach(([x, y], index) => {
        if (index === 0) target.moveTo(x, y);
        else target.lineTo(x, y);
    });
    return target.lineTo(points[0][0], points[0][1]);
};

export const fillPolygon = (
    target,
    points,
    color,
    alpha,
) => tracePolygon(target, points).fill({ color, alpha });

export const strokePolygon = (
    target,
    points,
    color,
    alpha,
    width = 1.5,
) => tracePolygon(target, points).stroke({ color, alpha, width });

export const drawLeaf = (
    target,
    x,
    y,
    length,
    width,
    angle,
    color,
    fillAlpha,
) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const nx = -dy;
    const ny = dx;
    const tipX = x + dx * length;
    const tipY = y + dy * length;
    target.moveTo(x, y)
        .quadraticCurveTo(x + dx * length * 0.45 + nx * width, y + dy * length * 0.45 + ny * width, tipX, tipY)
        .quadraticCurveTo(x + dx * length * 0.45 - nx * width, y + dy * length * 0.45 - ny * width, x, y)
        .fill({ color, alpha: fillAlpha });
    target.moveTo(x, y)
        .quadraticCurveTo(x + dx * length * 0.45 + nx * width, y + dy * length * 0.45 + ny * width, tipX, tipY)
        .quadraticCurveTo(x + dx * length * 0.45 - nx * width, y + dy * length * 0.45 - ny * width, x, y)
        .stroke({ color, alpha: Math.min(0.8, fillAlpha * 3.2), width: 1.5 });
    target.moveTo(x, y).lineTo(tipX, tipY).stroke({ color, alpha: 0.32, width: 1 });
};

export const drawPetal = (
    target,
    cx,
    cy,
    length,
    width,
    angle,
    color,
    fillAlpha,
) => drawLeaf(target, cx, cy, length, width, angle, color, fillAlpha);
