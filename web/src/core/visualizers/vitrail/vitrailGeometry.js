/**
 * web/src/core/visualizers/vitrail/vitrailGeometry.js
 * 「琉璃龛 · Vitrail」（mode: vitrail）—— 精细参数化 3D 建筑构件与倒角网格统一入口
 *
 * 材质 ID 语义：
 *   0 = 主建筑石材/清水混凝土 (triplanarProceduralStone)
 *   1 = 阶梯基座/柱头修饰石材 (accentedStoneTrim)
 *   2 = 金属嵌边/铜棂/浑天仪环 (brushedMetal)
 *   3 = 磨砂彩色琉璃透光面 (stainedGlassAperture)
 *   4 = 中央倒影水镜 (reflectiveWaterBasin, 仅静态地面水池)
 *   5 = 立体光束锥/圣光柱 (volumetricShafts, 半透明加色混合)
 *   6 = 棱面结晶琉璃灯锥 (crystallineFacetPrism, 悬浮棱镜与宝石核心)
 *
 * 零 DOM 依赖，纯函数输出索引网格并自带法线归一化与退化面剔除。
 */

import {
    MAT_STONE,
    MAT_TRIM,
    MAT_METAL,
    MAT_GLASS,
    MAT_WATER,
    MAT_SHAFT,
    MAT_CRYSTAL,
    MeshBuilder,
    addChamferedBox,
} from './vitrailMeshCore.js';

import {
    addLathe,
    addSweptProfile,
    addSculptedColumn,
    addMultiOrderArch,
    addTraceryRoseWindow,
    addRoseApertureSurround,
    addRecessedWindowBay,
    addTurnedBalustrade,
    addEnclosureWallBay,
    addGroinVaultBay,
    buildOrnateGimbalRing,
    buildOrnateLanternMesh,
} from './vitrailPrimitives.js';

import { composeVitrailArchitecture } from './vitrailScenes.js';

export {
    MAT_STONE,
    MAT_TRIM,
    MAT_METAL,
    MAT_GLASS,
    MAT_WATER,
    MAT_SHAFT,
    MAT_CRYSTAL,
    MeshBuilder,
    addChamferedBox,
    addLathe,
    addSweptProfile,
    addSculptedColumn,
    addSculptedColumn as addMonumentalColumn,
    addMultiOrderArch,
    addMultiOrderArch as addVaultedArch,
    addTraceryRoseWindow,
    addTraceryRoseWindow as addStainedGlassRoseWindow,
    addRoseApertureSurround,
    addRecessedWindowBay,
    addRecessedWindowBay as addFramedGlassPanel,
    addTurnedBalustrade,
    addEnclosureWallBay,
    addGroinVaultBay,
    buildOrnateGimbalRing,
    buildOrnateGimbalRing as buildGimbalRingMesh,
    buildOrnateLanternMesh,
    composeVitrailArchitecture,
};

/* ==================== 轻量列主序 4x4 矩阵工具（与 GLSL 一致） ==================== */

export function mat4Identity() {
    const out = new Float32Array(16);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
}

export function mat4Perspective(fovyRad, aspect, near, far) {
    const f = 1.0 / Math.tan(fovyRad * 0.5);
    const out = new Float32Array(16);
    out[0] = f / Math.max(0.1, aspect);
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
}

export function mat4LookAt(eye, target, up) {
    let zx = eye[0] - target[0];
    let zy = eye[1] - target[1];
    let zz = eye[2] - target[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    const out = new Float32Array(16);
    out[0] = xx; out[4] = xy; out[8] = xz; out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[1] = yx; out[5] = yy; out[9] = yz; out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[2] = zx; out[6] = zy; out[10] = zz; out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[3] = 0;  out[7] = 0;  out[11] = 0;  out[15] = 1;
    return out;
}

export function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] =
                a[0 * 4 + r] * b[c * 4 + 0] +
                a[1 * 4 + r] * b[c * 4 + 1] +
                a[2 * 4 + r] * b[c * 4 + 2] +
                a[3 * 4 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

export function mat4ModelTransform(pos, rot) {
    const [tx, ty, tz] = pos;
    const [rx, ry, rz] = rot;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    // Rz * Ry * Rx
    const m00 = cy * cz;
    const m01 = cy * sz;
    const m02 = -sy;
    const m10 = sx * sy * cz - cx * sz;
    const m11 = sx * sy * sz + cx * cz;
    const m12 = sx * cy;
    const m20 = cx * sy * cz + sx * sz;
    const m21 = cx * sy * sz - sx * cz;
    const m22 = cx * cy;

    const out = new Float32Array(16);
    out[0] = m00; out[1] = m01; out[2] = m02; out[3] = 0;
    out[4] = m10; out[5] = m11; out[6] = m12; out[7] = 0;
    out[8] = m20; out[9] = m21; out[10] = m22; out[11] = 0;
    out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
    return out;
}
