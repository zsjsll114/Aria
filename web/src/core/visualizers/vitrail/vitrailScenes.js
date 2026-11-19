/**
 * web/src/core/visualizers/vitrail/vitrailScenes.js
 * 「琉璃龛 · Vitrail」—— 8 种高辨识度立体建筑空间原型装配器
 *
 * 彻底打破单一矩形走廊模板同质化：
 *   1. cathedral   — 哥特圣光尖拱大殿（窄高主殿、群柱飞扶肋、烛台长廊、巨大玫瑰窗 + 摆动铜香炉）
 *   2. observatory — 星穹浑天观象台（八角干石铜罗盘地板、赤道仪望远镜、双星宿圆窗、三环浑仪直面星空穹顶）
 *   3. cloister    — 安藤青石水院（宽阔平镜庭院 + 木缘侧平台 + 飞石步汀 + 偏心圆窗「圆悟」与障子风铃）
 *   4. pavilion    — 折光晶体棱阁（锯齿斜切玄武岩平台 + 折纸V形人字桁架 + 菱形折射坛窗 + 八面晶棱）
 *   5. rotunda     — 星穹万神坛（十一柱真半圆弧墙 + 放射穹顶肋 + 天顶开放日轮穹眼 + 圆形水池与青铜圣火鼎）
 *   6. arcade      — 威尼斯水上拱廊（阔水泻湖 + 反曲摩尔尖瓣拱 + 远景石拱桥 + 系泊木桩六角船灯）
 *   7. scriptorium — 秘阁穹廊（干石棋盘读经主步道 + 展开羊皮纸读经台 + 暖光双层藏书阁 + 悬吊星仪）
 *   8. atrium      — 曦光植物水晶花房（曲线园林步道 + 阶梯花坛棕榈铜叶簇 + 通透全玻拱顶 + 三环露珠仪）
 *
 * 严格遵循中央歌词阅读通道无遮挡约束 (|x| < 3.0, y in [1.2, 3.8], z in [-5.0, 2.2])。
 */

import {
    MAT_STONE,
    MAT_TRIM,
    MAT_METAL,
    MAT_GLASS,
    MAT_WATER,
    MAT_SHAFT,
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
    addFacetedChevronTruss,
    addDiamondPrismWindow,
    addCircularMoonAperture,
    addVenetianOgeeArchBay,
    addBotanicalPalmFrondCluster,
    addTelescopePedestal,
    addPantheonTripodBrazier,
    addLecternFolioStand,
    buildZenShojiWindChimeMesh,
    buildFacetedCrystalPrismMesh,
    buildVenetianHexLanternMesh,
    buildBotanicalDewOrbMesh,
} from './vitrailPrimitives.js';

export function addLightShaftQuad(mb, t0, t1, b1, b0) {
    const i0 = mb.addVertex(t0[0], t0[1], t0[2], 0, 0, 1, 0, 1, MAT_SHAFT);
    const i1 = mb.addVertex(t1[0], t1[1], t1[2], 0, 0, 1, 1, 1, MAT_SHAFT);
    const i2 = mb.addVertex(b1[0], b1[1], b1[2], 0, 0, 1, 1, 0, MAT_SHAFT);
    const i3 = mb.addVertex(b0[0], b0[1], b0[2], 0, 0, 1, 0, 0, MAT_SHAFT);
    mb.addQuad(i0, i1, i2, i3);
}

function addFullWaterPlane(waterBuilder, halfW = 5.8, zFront = 9.5, zBack = -14.8) {
    waterBuilder.addFlatQuad(
        [-halfW, 0, zFront],
        [halfW, 0, zFront],
        [halfW, 0, zBack],
        [-halfW, 0, zBack],
        0, 0, 1, 1, MAT_WATER,
    );
}

function addSideTerraceDecks(mb, courtHalfW = 4.35, deckH = 0.22, withCurbMetal = true) {
    addChamferedBox(mb, { cx: -(courtHalfW + 6.0), cy: -0.37 + deckH, cz: -4.2, sx: 12.0, sy: 0.74, sz: 29.0, bevel: 0.055, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: (courtHalfW + 6.0), cy: -0.37 + deckH, cz: -4.2, sx: 12.0, sy: 0.74, sz: 29.0, bevel: 0.055, matId: MAT_STONE, matBevelId: MAT_TRIM });
    if (withCurbMetal) {
        addChamferedBox(mb, { cx: -courtHalfW, cy: deckH * 0.5, cz: -4.2, sx: 0.44, sy: deckH, sz: 26.2, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addChamferedBox(mb, { cx: courtHalfW, cy: deckH * 0.5, cz: -4.2, sx: 0.44, sy: deckH, sz: 26.2, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addChamferedBox(mb, { cx: -courtHalfW - 0.12, cy: deckH + 0.01, cz: -4.2, sx: 0.04, sy: 0.022, sz: 25.4, bevel: 0.004, matId: MAT_METAL });
        addChamferedBox(mb, { cx: courtHalfW + 0.12, cy: deckH + 0.01, cz: -4.2, sx: 0.04, sy: 0.022, sz: 25.4, bevel: 0.004, matId: MAT_METAL });
    }
    addChamferedBox(mb, { cx: 0, cy: 0.12, cz: -14.8, sx: courtHalfW * 2 + 1.2, sy: 0.24, sz: 0.72, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });
}

function addCathedralCandlestick(mb, x, y, z) {
    addLathe(mb, {
        cx: x, cy: y, cz: z,
        segs: 16,
        matId: MAT_METAL,
        profile: [
            [0.24, 0.00, true, MAT_TRIM],
            [0.22, 0.06, false, MAT_METAL],
            [0.10, 0.16, true, MAT_METAL],
            [0.055, 0.42, false, MAT_METAL],
            [0.11, 0.56, false, MAT_METAL],
            [0.05, 0.70, false, MAT_METAL],
            [0.06, 1.05, true, MAT_METAL],
            [0.16, 1.14, true, MAT_METAL],
            [0.08, 1.18, true, MAT_TRIM],
            [0.075, 1.54, true, MAT_TRIM],
            [0.02, 1.62, true, MAT_GLASS],
        ],
    });
}

function addZenStoneLanternToro(mb, x, y, z) {
    addLathe(mb, {
        cx: x, cy: y, cz: z,
        segs: 6,
        matId: MAT_STONE,
        profile: [
            [0.42, 0.00, true, MAT_STONE],
            [0.36, 0.18, true, MAT_TRIM],
            [0.18, 0.26, true, MAT_TRIM],
            [0.15, 0.96, true, MAT_STONE],
            [0.34, 1.12, true, MAT_TRIM],
            [0.26, 1.18, true, MAT_TRIM],
        ],
    });
    addChamferedBox(mb, { cx: x, cy: y + 1.40, cz: z, sx: 0.34, sy: 0.42, sz: 0.34, bevel: 0.02, matId: MAT_GLASS });
    for (const dx of [-0.17, 0.17]) {
        for (const dz of [-0.17, 0.17]) {
            addChamferedBox(mb, { cx: x + dx, cy: y + 1.40, cz: z + dz, sx: 0.06, sy: 0.46, sz: 0.06, bevel: 0.01, matId: MAT_TRIM });
        }
    }
    addLathe(mb, {
        cx: x, cy: y + 1.62, cz: z,
        segs: 6,
        matId: MAT_TRIM,
        profile: [
            [0.54, 0.00, true, MAT_TRIM],
            [0.48, 0.08, false, MAT_TRIM],
            [0.18, 0.28, true, MAT_STONE],
            [0.11, 0.36, false, MAT_METAL],
            [0.02, 0.48, true, MAT_METAL],
        ],
    });
}

function addCraneBracketArm(mb, xWall, xHook, yHook, zPos) {
    const dir = xHook > xWall ? 1 : -1;
    const span = Math.abs(xHook - xWall);
    addChamferedBox(mb, {
        cx: (xWall + xHook) * 0.5, cy: yHook, cz: zPos,
        sx: span + 0.14, sy: 0.08, sz: 0.09, bevel: 0.014, matId: MAT_METAL,
    });
    addSweptProfile(mb, {
        points: [
            [xWall + dir * 0.04, yHook - 0.65, zPos],
            [xWall + dir * span * 0.46, yHook - 0.24, zPos],
            [xHook - dir * 0.06, yHook - 0.02, zPos],
        ],
        section: [[-0.026, 0.026], [0.026, 0.026], [0.026, -0.026], [-0.026, -0.026]],
        matId: MAT_METAL,
        capEnds: true,
    });
    addLathe(mb, {
        cx: xHook, cy: yHook - 0.06, cz: zPos,
        segs: 16,
        matId: MAT_METAL,
        profile: [
            [0.065, -0.06, true, MAT_METAL],
            [0.095, 0.02, true, MAT_TRIM],
            [0.055, 0.10, true, MAT_METAL],
        ],
    });
}

function buildAstrolabeGlobeMesh(outerR = 1.05, suspensionLen = 0) {
    const mb = new MeshBuilder();
    const ringOuter = buildOrnateGimbalRing({ radius: outerR, width: 0.065, thick: 0.11, segments: 56, matId: MAT_METAL });
    const appendBuf = (buf, rx = 0, ry = 0, rz = 0) => {
        const base = mb.positions.length / 3;
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        const rot = (x, y, z) => {
            const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
            const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
            return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2];
        };
        for (let i = 0; i < buf.vertexCount; i++) {
            const p = rot(buf.positions[i * 3], buf.positions[i * 3 + 1], buf.positions[i * 3 + 2]);
            const n = rot(buf.normals[i * 3], buf.normals[i * 3 + 1], buf.normals[i * 3 + 2]);
            mb.addVertex(p[0], p[1], p[2], n[0], n[1], n[2], buf.uvs[i * 2], buf.uvs[i * 2 + 1], buf.matIds[i]);
        }
        for (let i = 0; i < buf.indices.length; i++) {
            mb.indices.push(base + buf.indices[i]);
        }
    };
    appendBuf(ringOuter, 0, 0, 0);
    const ringInner = buildOrnateGimbalRing({ radius: outerR * 0.78, width: 0.055, thick: 0.09, segments: 48, matId: MAT_METAL });
    appendBuf(ringInner, Math.PI * 0.42, 0.35, 0);
    const lanternCore = buildOrnateLanternMesh(outerR * 0.28, outerR * 0.48, 0);
    appendBuf(lanternCore, 0, 0, 0);
    if (suspensionLen > 0.05) {
        addLathe(mb, {
            cx: 0, cy: outerR + 0.06, cz: 0,
            segs: 12,
            matId: MAT_METAL,
            profile: [
                [0.045, 0.0, true, MAT_METAL],
                [0.022, 0.08, false, MAT_METAL],
                [0.020, suspensionLen, true, MAT_METAL],
            ],
        });
    }
    return mb.toBuffers();
}

function buildCathedralScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 1. 哥特圣光尖拱大殿：深邃矩形圣水长廊 + 阶梯圣坛 + 巨型玫瑰窗 + 双对青铜长烛台
    addSideTerraceDecks(mb, 4.25, 0.22, true);
    addFullWaterPlane(waterBuilder, 4.30);
    addChamferedBox(mb, { cx: 0, cy: 0.17, cz: -12.6, sx: 7.4, sy: 0.34, sz: 4.3, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 0.43, cz: -12.9, sx: 5.4, sy: 0.24, sz: 2.9, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 0, cy: 0.64, cz: -13.15, sx: 3.6, sy: 0.20, sz: 1.85, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });

    const zBays = [-12.2, -8.2, -4.2, -0.2, 3.6];
    for (let idx = 0; idx < zBays.length; idx++) {
        const zBay = zBays[idx];
        addSculptedColumn(mb, { x: -4.55, baseY: 0.1, z: zBay, radius: 0.44, height: 7.05, flutes: 16, style: 'gothic_cluster' });
        addSculptedColumn(mb, { x: 4.55, baseY: 0.1, z: zBay, radius: 0.44, height: 7.05, flutes: 16, style: 'gothic_cluster' });
        addMultiOrderArch(mb, {
            span: 9.1, springY: 7.05, apexY: 11.15, z: zBay,
            ribWidth: 0.50, ribDepth: 0.58, pointed: true, withSpandrel: true, withPendant: true,
        });
        if (idx < zBays.length - 1) {
            addGroinVaultBay(mb, {
                spanX: 9.1, zCenter: (zBay + zBays[idx + 1]) * 0.5,
                bayDepth: Math.abs(zBays[idx + 1] - zBay), springY: 7.12, apexY: 11.15, withWebbing: true,
            });
        }
    }
    addChamferedBox(mb, { cx: 0, cy: 11.20, cz: -4.2, sx: 0.42, sy: 0.34, sz: 17.6, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: -4.55, cy: 7.10, cz: -4.2, sx: 0.56, sy: 0.48, sz: 17.6, bevel: 0.045, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 4.55, cy: 7.10, cz: -4.2, sx: 0.56, sy: 0.48, sz: 17.6, bevel: 0.045, matId: MAT_STONE, matBevelId: MAT_TRIM });

    addTurnedBalustrade(mb, { x0: -4.15, z0: -11.15, x1: -1.45, z1: -11.15, y: 0.28, height: 0.88, spacing: 0.40 });
    addTurnedBalustrade(mb, { x0: 1.45, z0: -11.15, x1: 4.15, z1: -11.15, y: 0.28, height: 0.88, spacing: 0.40 });
    addCathedralCandlestick(mb, -2.35, 0.55, -12.6);
    addCathedralCandlestick(mb, 2.35, 0.55, -12.6);
    addCathedralCandlestick(mb, -3.55, 0.22, -8.2);
    addCathedralCandlestick(mb, 3.55, 0.22, -8.2);

    addChamferedBox(mb, { cx: -5.5, cy: 5.2, cz: -14.6, sx: 3.6, sy: 10.8, sz: 0.95, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.5, cy: 5.2, cz: -14.6, sx: 3.6, sy: 10.8, sz: 0.95, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 1.04, cz: -14.55, sx: 7.5, sy: 0.76, sz: 0.88, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 0, cy: 2.02, cz: -14.48, sx: 7.7, sy: 0.19, sz: 0.96, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });
    for (const pxSill of [-2.55, -0.85, 0.85, 2.55]) {
        addSculptedColumn(mb, { x: pxSill, baseY: 1.25, z: -14.44, radius: 0.12, height: 0.85, flutes: 10, style: 'classical' });
    }
    addChamferedBox(mb, { cx: 0, cy: 9.85, cz: -14.6, sx: 14.6, sy: 2.2, sz: 0.95, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addRoseApertureSurround(mb, { cx: 0, cy: 5.55, cz: -14.32, innerRadius: 3.30, halfW: 4.0, halfBot: 3.55, halfTop: 4.1, thickness: 0.72 });
    addTraceryRoseWindow(mb, { cx: 0, cy: 5.55, cz: -14.2, radius: 3.3, spokes: 12 });
    addChamferedBox(mb, { cx: -7.55, cy: 4.8, cz: -12.2, sx: 0.9, sy: 9.8, sz: 1.1, bevel: 0.04, ry: 0.32, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 7.55, cy: 4.8, cz: -12.2, sx: 0.9, sy: 9.8, sz: 1.1, bevel: 0.04, ry: -0.32, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addRecessedWindowBay(mb, { cx: -6.35, cy: 4.65, cz: -13.15, width: 1.9, height: 6.5, depth: 0.62, ry: 0.32, cols: 2, rows: 5, headType: 'pointed' });
    addRecessedWindowBay(mb, { cx: 6.35, cy: 4.65, cz: -13.15, width: 1.9, height: 6.5, depth: 0.62, ry: -0.32, cols: 2, rows: 5, headType: 'pointed' });

    for (const zOuter of [-10.2, -6.2, -2.2, 1.8]) {
        addSculptedColumn(mb, { x: -7.35, baseY: 0.1, z: zOuter, radius: 0.34, height: 6.5, flutes: 16, style: 'classical' });
        addSculptedColumn(mb, { x: 7.35, baseY: 0.1, z: zOuter, radius: 0.34, height: 6.5, flutes: 16, style: 'classical' });
        addEnclosureWallBay(mb, { cx: -8.5, cy: 4.3, cz: zOuter, width: 3.9, height: 8.6, ry: Math.PI * 0.5 });
        addEnclosureWallBay(mb, { cx: 8.5, cy: 4.3, cz: zOuter, width: 3.9, height: 8.6, ry: -Math.PI * 0.5 });
    }

    addLightShaftQuad(shaftBuilder, [-2.2, 7.6, -13.4], [0.8, 7.6, -13.4], [3.2, 0.02, -4.5], [-0.4, 0.02, -4.5]);
    addLightShaftQuad(shaftBuilder, [-0.8, 7.6, -13.4], [2.2, 7.6, -13.4], [0.4, 0.02, -3.5], [-3.2, 0.02, -3.5]);

    dynamicParts.push({
        id: 'cathedral-halo-ring',
        pivot: [0, 5.55, -13.20],
        baseRot: [0, 0, 0],
        spinRate: [0, 0, 0.055],
        mesh: buildOrnateGimbalRing({ radius: 2.35, width: 0.085, thick: 0.13, segments: 56, matId: MAT_METAL }),
    });
    addCraneBracketArm(mb, -4.55, -3.72, 6.65, -10.2);
    addCraneBracketArm(mb, 4.55, 3.72, 6.65, -10.2);
    const censerMesh = buildOrnateLanternMesh(0.27, 0.98, 0.42);
    dynamicParts.push({ id: 'cathedral-censer-l', pivot: [-3.72, 5.10, -10.2], baseRot: [0, 0.2, 0], spinRate: [0, 0.10, 0], bobAmp: 0.08, mesh: censerMesh });
    dynamicParts.push({ id: 'cathedral-censer-r', pivot: [3.72, 5.10, -10.2], baseRot: [0, -0.2, 0], spinRate: [0, -0.10, 0], bobAmp: 0.08, mesh: censerMesh });
}

function buildObservatoryScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 2. 星穹浑天观象台：实石黄铜天文罗盘甲板 + 嵌圆星池 + 双赤道望远镜 + 开放星空夜穹（无中央玫瑰墙挡住夜空！）
    addSideTerraceDecks(mb, 4.55, 0.18, false);
    addFullWaterPlane(waterBuilder, 5.0);
    // 前景实体天文长桥与两侧嵌黄铜刻度干石地板（保留 -9.9 圆形映星水池及前台矩形星镜）
    addChamferedBox(mb, { cx: 0, cy: 0.09, cz: 3.2, sx: 9.2, sy: 0.18, sz: 5.4, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 0.09, cz: -4.2, sx: 9.2, sy: 0.18, sz: 3.2, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 0.09, cz: -14.2, sx: 11.4, sy: 0.22, sz: 2.2, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    // 同心嵌铜地板经纬刻度圈围绕 z = -9.9 星池外缘
    for (const rComp of [2.9, 3.65, 4.45]) {
        const ringPts = [];
        for (let k = 0; k < 48; k++) {
            const a = (k / 48) * Math.PI * 2;
            ringPts.push([Math.cos(a) * rComp, 0.18, -9.9 + Math.sin(a) * rComp]);
        }
        addSweptProfile(mb, {
            points: ringPts,
            section: [[-0.08, 0.04], [0.08, 0.04], [0.08, -0.04], [-0.08, -0.04]],
            closedPath: true,
            matId: MAT_METAL,
            planeNormal: [0, 1, 0],
        });
    }

    const obsBays = [-12.8, -7.0, -2.0, 3.0];
    for (let idx = 0; idx < obsBays.length; idx++) {
        const zObs = obsBays[idx];
        addSculptedColumn(mb, { x: -5.45, baseY: 0.1, z: zObs, radius: 0.36, height: 6.65, flutes: 20, style: 'classical' });
        addSculptedColumn(mb, { x: 5.45, baseY: 0.1, z: zObs, radius: 0.36, height: 6.65, flutes: 20, style: 'classical' });
        addMultiOrderArch(mb, {
            span: 10.9, springY: 6.7, apexY: 11.0, z: zObs,
            ribWidth: 0.38, ribDepth: 0.46, pointed: false, withSpandrel: false, withPendant: false, matTrim: MAT_METAL,
        });
    }
    addChamferedBox(mb, { cx: -5.45, cy: 6.72, cz: -4.9, sx: 0.48, sy: 0.36, sz: 17.4, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.45, cy: 6.72, cz: -4.9, sx: 0.48, sy: 0.36, sz: 17.4, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });

    // 外墙嵌星空天体仪高窗 + 双侧赤道望远镜台座
    for (const zWall of [-9.9, -4.5, 0.5]) {
        addEnclosureWallBay(mb, { cx: -7.85, cy: 4.3, cz: zWall, width: 4.8, height: 8.6, ry: Math.PI * 0.5 });
        addEnclosureWallBay(mb, { cx: 7.85, cy: 4.3, cz: zWall, width: 4.8, height: 8.6, ry: -Math.PI * 0.5 });
        if (zWall < 0) {
            addRecessedWindowBay(mb, { cx: -7.45, cy: 4.5, cz: zWall, width: 2.0, height: 5.6, depth: 0.52, ry: Math.PI * 0.5, cols: 2, rows: 4, headType: 'arched', frameMat: MAT_METAL });
            addRecessedWindowBay(mb, { cx: 7.45, cy: 4.5, cz: zWall, width: 2.0, height: 5.6, depth: 0.52, ry: -Math.PI * 0.5, cols: 2, rows: 4, headType: 'arched', frameMat: MAT_METAL });
        }
    }
    addTelescopePedestal(mb, { x: -4.45, baseY: 0.18, z: -5.2, aimInwardSign: 1 });
    addTelescopePedestal(mb, { x: 4.45, baseY: 0.18, z: -5.2, aimInwardSign: -1 });
    addTelescopePedestal(mb, { x: -4.45, baseY: 0.18, z: -10.8, aimInwardSign: 1 });
    addTelescopePedestal(mb, { x: 4.45, baseY: 0.18, z: -10.8, aimInwardSign: -1 });

    // 后部开放观星半圆矮石围栏 (y = 0..2.4)，彻底让位给 SKY_FS 的繁星银河夜空与双翼黄道观测窗！
    const drumPts = [];
    for (let i = 0; i <= 18; i++) {
        const a = -Math.PI * 0.42 + (i / 18) * Math.PI * 0.84;
        drumPts.push([Math.sin(a) * 6.2, 2.35, -8.5 - Math.cos(a) * 6.1]);
    }
    addSweptProfile(mb, {
        points: drumPts,
        section: [[-0.24, 0.24], [0.24, 0.24], [0.24, -2.35], [-0.24, -2.35]],
        matId: MAT_STONE,
        planeNormal: [0, 1, 0],
        capEnds: true,
    });
    // 后方倾斜细铜子午拱肋划过星空
    for (const xRib of [-2.4, 2.4]) {
        const arcPts = [];
        for (let k = 0; k <= 14; k++) {
            const tt = k / 14;
            const ang = -0.35 + tt * Math.PI * 0.85;
            arcPts.push([xRib * Math.cos(tt * 0.6), 2.4 + Math.sin(ang * 0.85) * 8.4, -14.3 + Math.sin(tt * Math.PI * 0.5) * 3.8]);
        }
        addSweptProfile(mb, {
            points: arcPts,
            section: [[-0.07, 0.10], [0.07, 0.10], [0.07, -0.10], [-0.07, -0.10]],
            matId: MAT_METAL,
            capEnds: true,
        });
    }
    // 左右各一扇小型黄道星图圆窗 (保留中央浑天仪背后的澄澈星空！)
    addRoseApertureSurround(mb, { cx: -4.45, cy: 5.5, cz: -13.65, innerRadius: 1.38, halfW: 2.0, halfBot: 3.1, halfTop: 2.6, thickness: 0.6 });
    addTraceryRoseWindow(mb, { cx: -4.45, cy: 5.5, cz: -13.55, radius: 1.38, spokes: 10 });
    addRoseApertureSurround(mb, { cx: 4.45, cy: 5.5, cz: -13.65, innerRadius: 1.38, halfW: 2.0, halfBot: 3.1, halfTop: 2.6, thickness: 0.6 });
    addTraceryRoseWindow(mb, { cx: 4.45, cy: 5.5, cz: -13.55, radius: 1.38, spokes: 10 });

    // z = -9.9 圆形水池中央矗立黄铜子午底座 + 弧形托架 + 巨型三层同心浑天星环
    addLathe(mb, {
        cx: 0, cy: 0.20, cz: -9.9,
        segs: 40,
        matId: MAT_TRIM,
        profile: [
            [2.05, 0.00, true, MAT_STONE],
            [1.92, 0.14, true, MAT_TRIM],
            [1.68, 0.18, true, MAT_METAL],
            [0.52, 0.26, true, MAT_METAL],
            [0.10, 0.30, true, MAT_METAL],
        ],
    });
    const cradlePts = [];
    for (let i = 0; i <= 24; i++) {
        const ang = -Math.PI + (i / 24) * Math.PI;
        cradlePts.push([Math.cos(ang) * 2.68, 5.65 + Math.sin(ang) * 2.68, -9.9]);
    }
    addSweptProfile(mb, {
        points: cradlePts,
        section: [[-0.08, 0.09], [0.08, 0.09], [0.08, -0.09], [-0.08, -0.09]],
        matId: MAT_TRIM,
        planeNormal: [0, 0, 1],
        capEnds: true,
    });
    addChamferedBox(mb, { cx: 0, cy: 1.72, cz: -9.9, sx: 0.40, sy: 2.48, sz: 0.40, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });

    dynamicParts.push({
        id: 'gimbal-outer',
        pivot: [0, 5.65, -9.9],
        baseRot: [0.35, 0.25, 0],
        spinRate: [0.05, 0.14, 0.04],
        mesh: buildOrnateGimbalRing({ radius: 2.34, width: 0.11, thick: 0.18, segments: 64, matId: MAT_METAL }),
    });
    dynamicParts.push({
        id: 'gimbal-mid',
        pivot: [0, 5.65, -9.9],
        baseRot: [-0.45, 0.65, 0.3],
        spinRate: [-0.11, 0.08, -0.07],
        mesh: buildOrnateGimbalRing({ radius: 1.78, width: 0.09, thick: 0.15, segments: 56, matId: MAT_METAL }),
    });
    dynamicParts.push({
        id: 'gimbal-inner',
        pivot: [0, 5.65, -9.9],
        baseRot: [0.85, -0.35, 0.2],
        spinRate: [0.16, -0.13, 0.09],
        mesh: buildOrnateGimbalRing({ radius: 1.22, width: 0.075, thick: 0.12, segments: 48, matId: MAT_METAL }),
    });

    addLightShaftQuad(shaftBuilder, [-2.2, 9.6, -11.5], [2.2, 9.6, -11.5], [3.2, 0.02, -3.5], [-3.2, 0.02, -3.5]);
}

function buildCloisterScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 3. 安藤青石水院：开阔全水庭 + 日式木构缘侧廊道 + 交错浮石「飞石」 + 偏心「圆悟」月窗与障子行灯风铃
    addFullWaterPlane(waterBuilder, 5.5);
    // 两侧低矮日式木缘侧走廊（零欧式栏杆！）
    addChamferedBox(mb, { cx: -7.8, cy: 0.12, cz: -4.2, sx: 6.4, sy: 0.24, sz: 28.0, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 7.8, cy: 0.12, cz: -4.2, sx: 6.4, sy: 0.24, sz: 28.0, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
    // 水面错落青石步汀「飞石 (Tobi-ishi)」与右偏寂静枯山水主座石台
    for (const [sx, sz, w, d] of [
        [-0.85, 2.2, 1.55, 0.95],
        [0.75, 0.2, 1.75, 1.05],
        [-0.65, -2.0, 1.60, 0.92],
        [0.95, -4.4, 1.85, 1.10],
        [-0.35, -7.0, 1.65, 1.00],
        [0.85, -9.4, 1.90, 1.15],
    ]) {
        addChamferedBox(mb, { cx: sx, cy: 0.06, cz: sz, sx: w, sy: 0.12, sz: d, bevel: 0.025, matId: MAT_STONE, matBevelId: MAT_TRIM });
    }
    addChamferedBox(mb, { cx: 1.45, cy: 0.14, cz: -12.0, sx: 5.2, sy: 0.28, sz: 2.6, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });

    const cloBays = [-12.6, -10.2, -7.8, -5.4, -3.0, -0.6, 1.8, 4.2];
    for (const zBay of cloBays) {
        addSculptedColumn(mb, { x: -4.95, baseY: 0.1, z: zBay, radius: 0.34, height: 6.75, style: 'timber_stone' });
        addSculptedColumn(mb, { x: 4.95, baseY: 0.1, z: zBay, radius: 0.34, height: 6.75, style: 'timber_stone' });
        addChamferedBox(mb, { cx: 0, cy: 7.22, cz: zBay, sx: 11.4, sy: 0.24, sz: 0.30, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
    }
    // 挑深木檐（中央留出天顶露空天光！）
    addChamferedBox(mb, { cx: -5.65, cy: 6.84, cz: -4.2, sx: 2.0, sy: 0.38, sz: 19.6, bevel: 0.035, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.65, cy: 6.84, cz: -4.2, sx: 2.0, sy: 0.38, sz: 19.6, bevel: 0.035, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: -5.95, cy: 7.56, cz: -4.2, sx: 2.8, sy: 0.14, sz: 19.8, bevel: 0.025, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.95, cy: 7.56, cz: -4.2, sx: 2.8, sy: 0.14, sz: 19.8, bevel: 0.025, matId: MAT_STONE, matBevelId: MAT_TRIM });

    // 非对称清水混凝土端墙：左偏「圆悟/Marumado」和纸圆窗 + 中央实体影壁 + 右侧竹格竖障子光隙
    addRoseApertureSurround(mb, { cx: -2.05, cy: 4.35, cz: -14.2, innerRadius: 1.92, halfW: 3.15, halfBot: 4.35, halfTop: 3.7, thickness: 0.72 });
    addCircularMoonAperture(mb, { cx: -2.05, cy: 4.35, cz: -14.12, radius: 1.92 });
    addChamferedBox(mb, { cx: 2.15, cy: 4.1, cz: -14.25, sx: 2.35, sy: 8.2, sz: 0.72, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addRecessedWindowBay(mb, { cx: 4.15, cy: 4.2, cz: -14.18, width: 1.55, height: 6.4, depth: 0.56, cols: 3, rows: 7, headType: 'flat', frameMat: MAT_TRIM });
    addChamferedBox(mb, { cx: 6.1, cy: 4.1, cz: -14.25, sx: 2.5, sy: 8.2, sz: 0.72, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 4.15, cy: 0.50, cz: -14.2, sx: 1.8, sy: 1.0, sz: 0.72, bevel: 0.03, matId: MAT_STONE });
    addChamferedBox(mb, { cx: 4.15, cy: 7.80, cz: -14.2, sx: 1.8, sy: 0.9, sz: 0.72, bevel: 0.03, matId: MAT_STONE });

    for (const zWall of [-11.4, -9.0, -6.6, -4.2, -1.8, 0.6, 3.0]) {
        addEnclosureWallBay(mb, { cx: -7.15, cy: 4.1, cz: zWall, width: 2.45, height: 8.2, ry: Math.PI * 0.5 });
        addEnclosureWallBay(mb, { cx: 7.15, cy: 4.1, cz: zWall, width: 2.45, height: 8.2, ry: -Math.PI * 0.5 });
        if (zWall === -9.0 || zWall === -4.2) {
            addRecessedWindowBay(mb, { cx: -6.78, cy: 3.7, cz: zWall, width: 1.95, height: 5.6, depth: 0.48, ry: Math.PI * 0.5, cols: 3, rows: 6, headType: 'flat' });
            addRecessedWindowBay(mb, { cx: 6.78, cy: 3.7, cz: zWall, width: 1.95, height: 5.6, depth: 0.48, ry: -Math.PI * 0.5, cols: 3, rows: 6, headType: 'flat' });
        }
    }

    addZenStoneLanternToro(mb, -4.35, 0.14, -11.4);
    addZenStoneLanternToro(mb, 4.35, 0.14, -11.4);
    addZenStoneLanternToro(mb, -4.35, 0.14, -1.8);
    addZenStoneLanternToro(mb, 4.35, 0.14, -1.8);

    for (let i = -2; i <= 2; i++) {
        const zS = -9.5 + i * 2.3;
        addLightShaftQuad(shaftBuilder, [-2.8, 7.1, zS - 0.5], [2.8, 7.1, zS - 0.5], [2.8, 0.02, zS + 1.1], [-2.8, 0.02, zS + 1.1]);
    }

    // 悬于庭院纵向木檐桁架正下方的垂吊行灯风铃（无西方铁艺悬臂折钩）
    addChamferedBox(mb, { cx: -3.92, cy: 7.12, cz: -5.4, sx: 0.16, sy: 0.22, sz: 14.5, bevel: 0.02, matId: MAT_TRIM });
    addChamferedBox(mb, { cx: 3.92, cy: 7.12, cz: -5.4, sx: 0.16, sy: 0.22, sz: 14.5, bevel: 0.02, matId: MAT_TRIM });
    for (const sx of [-3.92, 3.92]) {
        addChamferedBox(mb, { cx: sx, cy: 6.45, cz: -9.0, sx: 0.032, sy: 1.32, sz: 0.032, bevel: 0.005, matId: MAT_METAL });
    }
    const shojiChime = buildZenShojiWindChimeMesh(0.24, 0.90, 0.42);
    dynamicParts.push({ id: 'cloister-chime-l', pivot: [-3.92, 5.05, -9.0], baseRot: [0, 0.15, 0], spinRate: [0, 0.06, 0], bobAmp: 0.08, mesh: shojiChime });
    dynamicParts.push({ id: 'cloister-chime-r', pivot: [3.92, 5.05, -9.0], baseRot: [0, -0.15, 0], spinRate: [0, -0.06, 0], bobAmp: 0.08, mesh: shojiChime });
}

function buildPavilionScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 4. 折光晶体棱阁：锯齿折叠人字斜梁 + 斜角玄武岩浮台 + 菱形折射坛窗 + 八面晶棱（零圆弧/零古典柱！）
    addFullWaterPlane(waterBuilder, 5.4);
    // 两侧倾斜折纸边缘石座 & 锐角挑出观景棱台（无标准矩框路沿）
    addChamferedBox(mb, { cx: -7.8, cy: -0.15, cz: -4.2, sx: 6.2, sy: 0.58, sz: 28.0, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 7.8, cy: -0.15, cz: -4.2, sx: 6.2, sy: 0.58, sz: 28.0, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    for (const [cx, cz, ry, sx, sz] of [
        [-3.45, 0.2, 0.36, 2.8, 3.2],
        [3.45, -1.8, -0.36, 2.8, 3.2],
        [-3.35, -6.2, -0.32, 2.6, 3.0],
        [3.35, -8.2, 0.32, 2.6, 3.0],
        [0, -12.1, 0.785, 3.4, 3.4], // 后殿 45 度旋转菱形主坛！
    ]) {
        addChamferedBox(mb, { cx, cy: 0.16, cz, sx, sy: 0.32, sz, bevel: 0.05, ry, matId: MAT_STONE, matBevelId: MAT_METAL });
    }

    const tiers = [-12.2, -8.6, -5.0, -1.4, 2.2];
    for (let i = 0; i < tiers.length; i++) {
        const zPos = tiers[i];
        const spread = 4.95;
        // 棱角分明的八角斜切金属箍石墩 + 尖顶折纸 V 形桁架
        addChamferedBox(mb, { cx: -spread, cy: 0.54, cz: zPos, sx: 1.24, sy: 1.08, sz: 1.24, bevel: 0.06, ry: 0.785, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addChamferedBox(mb, { cx: spread, cy: 0.54, cz: zPos, sx: 1.24, sy: 1.08, sz: 1.24, bevel: 0.06, ry: 0.785, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addChamferedBox(mb, { cx: -spread, cy: 3.7, cz: zPos, sx: 0.46, sy: 5.4, sz: 0.46, bevel: 0.05, ry: 0.785, matId: MAT_TRIM, matBevelId: MAT_METAL });
        addChamferedBox(mb, { cx: spread, cy: 3.7, cz: zPos, sx: 0.46, sy: 5.4, sz: 0.46, bevel: 0.05, ry: 0.785, matId: MAT_TRIM, matBevelId: MAT_METAL });
        addFacetedChevronTruss(mb, { span: spread * 2, baseY: 1.05, springY: 6.2, apexY: 10.65, z: zPos, ribWidth: 0.32, ribDepth: 0.42 });

        if (i < tiers.length - 1) {
            const zMid = (zPos + tiers[i + 1]) * 0.5;
            const dBay = Math.abs(tiers[i + 1] - zPos);
            // 人字坡面透明棱晶天棚（双斜面板直抵尖脊，无弧顶！）
            for (const sgn of [-1, 1]) {
                const p0 = [0, 10.55, zPos];
                const p1 = [sgn * 4.45, 6.25, zPos];
                const p2 = [sgn * 4.45, 6.25, tiers[i + 1]];
                const p3 = [0, 10.55, tiers[i + 1]];
                if (sgn > 0) {
                    mb.addFlatQuad(p0, p1, p2, p3, 0, 0, 1, 1, MAT_GLASS);
                    mb.addFlatQuad([p0[0], p0[1] + 0.06, p0[2]], [p3[0], p3[1] + 0.06, p3[2]], [p2[0], p2[1] + 0.06, p2[2]], [p1[0], p1[1] + 0.06, p1[2]], 0, 0, 1, 1, MAT_GLASS);
                } else {
                    mb.addFlatQuad(p1, p0, p3, p2, 0, 0, 1, 1, MAT_GLASS);
                    mb.addFlatQuad([p1[0], p1[1] + 0.06, p1[2]], [p2[0], p2[1] + 0.06, p2[2]], [p3[0], p3[1] + 0.06, p3[2]], [p0[0], p0[1] + 0.06, p0[2]], 0, 0, 1, 1, MAT_GLASS);
                }
            }
            const yawTilt = (i % 2 === 0 ? 0.22 : -0.22);
            addChamferedBox(mb, { cx: -5.35, cy: 0.55, cz: zMid, sx: 0.85, sy: 1.1, sz: dBay * 0.72, bevel: 0.04, ry: yawTilt, matId: MAT_STONE, matBevelId: MAT_TRIM });
            addChamferedBox(mb, { cx: 5.35, cy: 0.55, cz: zMid, sx: 0.85, sy: 1.1, sz: dBay * 0.72, bevel: 0.04, ry: -yawTilt, matId: MAT_STONE, matBevelId: MAT_TRIM });
            addRecessedWindowBay(mb, { cx: -5.25, cy: 3.9, cz: zMid, width: 2.35, height: 5.6, depth: 0.42, ry: Math.PI * 0.5 + yawTilt, cols: 2, rows: 5, headType: 'flat', frameMat: MAT_METAL });
            addRecessedWindowBay(mb, { cx: 5.25, cy: 3.9, cz: zMid, width: 2.35, height: 5.6, depth: 0.42, ry: -Math.PI * 0.5 - yawTilt, cols: 2, rows: 5, headType: 'flat', frameMat: MAT_METAL });
        }
        addEnclosureWallBay(mb, { cx: -7.55, cy: 4.2, cz: zPos, width: 3.55, height: 8.4, ry: Math.PI * 0.5 });
        addEnclosureWallBay(mb, { cx: 7.55, cy: 4.2, cz: zPos, width: 3.55, height: 8.4, ry: -Math.PI * 0.5 });
    }
    addChamferedBox(mb, { cx: 0, cy: 10.68, cz: -5.0, sx: 0.28, sy: 0.28, sz: 15.2, bevel: 0.04, rz: 0.785, matId: MAT_METAL });

    // 后殿巨型 45° 菱形折射晶体曼陀罗主窗 + 两侧倾斜三角光隙墙面
    addChamferedBox(mb, { cx: -5.6, cy: 4.8, cz: -14.45, sx: 3.6, sy: 9.6, sz: 0.85, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.6, cy: 4.8, cz: -14.45, sx: 3.6, sy: 9.6, sz: 0.85, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 0.65, cz: -14.3, sx: 8.2, sy: 1.3, sz: 0.85, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 9.85, cz: -14.35, sx: 9.2, sy: 1.7, sz: 0.85, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addDiamondPrismWindow(mb, { cx: 0, cy: 5.25, cz: -14.08, rx: 3.2, ry: 3.95, thickness: 0.55 });
    addDiamondPrismWindow(mb, { cx: -4.45, cy: 4.65, cz: -13.92, rx: 1.15, ry: 2.35, thickness: 0.42 });
    addDiamondPrismWindow(mb, { cx: 4.45, cy: 4.65, cz: -13.92, rx: 1.15, ry: 2.35, thickness: 0.42 });

    // 折光天棚斜梁纵向钢檩 + 垂直张拉吊杆悬垂八面晶棱（无教堂悬臂支架）
    addChamferedBox(mb, { cx: -3.76, cy: 7.12, cz: -5.0, sx: 0.16, sy: 0.22, sz: 15.2, bevel: 0.02, matId: MAT_METAL });
    addChamferedBox(mb, { cx: 3.76, cy: 7.12, cz: -5.0, sx: 0.16, sy: 0.22, sz: 15.2, bevel: 0.02, matId: MAT_METAL });
    for (const [sx, pyDrop, pz] of [[-3.76, 6.42, -6.8], [3.76, 6.42, -6.8], [-3.76, 6.32, -10.4], [3.76, 6.32, -10.4]]) {
        addChamferedBox(mb, { cx: sx, cy: pyDrop, cz: pz, sx: 0.032, sy: 1.48, sz: 0.032, bevel: 0.005, matId: MAT_METAL });
    }
    const shardMesh = buildFacetedCrystalPrismMesh(0.35, 1.02, 0.44);
    dynamicParts.push({ id: 'pavilion-shard-l1', pivot: [-3.76, 4.82, -6.8], baseRot: [0, 0.35, 0], spinRate: [0, 0.24, 0], bobAmp: 0.09, mesh: shardMesh });
    dynamicParts.push({ id: 'pavilion-shard-r1', pivot: [3.76, 4.82, -6.8], baseRot: [0, -0.35, 0], spinRate: [0, -0.24, 0], bobAmp: 0.09, mesh: shardMesh });
    dynamicParts.push({ id: 'pavilion-shard-l2', pivot: [-3.76, 4.62, -10.4], baseRot: [0, -0.2, 0], spinRate: [0, -0.18, 0], bobAmp: 0.09, mesh: shardMesh });
    dynamicParts.push({ id: 'pavilion-shard-r2', pivot: [3.76, 4.62, -10.4], baseRot: [0, 0.2, 0], spinRate: [0, 0.18, 0], bobAmp: 0.09, mesh: shardMesh });

    addLightShaftQuad(shaftBuilder, [-2.4, 8.2, -13.6], [0.2, 8.2, -13.6], [2.4, 0.02, -3.5], [-1.0, 0.02, -3.5]);
    addLightShaftQuad(shaftBuilder, [-0.2, 8.2, -13.6], [2.4, 8.2, -13.6], [1.0, 0.02, -3.5], [-2.4, 0.02, -3.5]);
}

function buildRotundaScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 5. 星穹万神坛：真正半圆形弧状科林斯柱鼓壁 + 穹顶放射藻井肋 + 顶部开放日轮天窗 + 四座青铜圣火鼎
    addFullWaterPlane(waterBuilder, 6.2);
    // 环形同心台阶大理石围台围绕 (0, -8.8) 中心大镜池（彻底告别两条直线方坎！）
    addChamferedBox(mb, { cx: -7.8, cy: -0.24, cz: -4.2, sx: 6.0, sy: 0.68, sz: 28.0, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 7.8, cy: -0.24, cz: -4.2, sx: 6.0, sy: 0.68, sz: 28.0, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    for (const [rIn, rOut, h] of [[4.2, 5.2, 0.26], [5.1, 6.8, 0.52]]) {
        const arcPts = [];
        for (let k = 0; k <= 26; k++) {
            const a = -Math.PI * 0.78 + (k / 26) * Math.PI * 1.56;
            const rm = (rIn + rOut) * 0.5;
            arcPts.push([Math.sin(a) * rm, h * 0.5, -8.8 - Math.cos(a) * rm]);
        }
        const halfW = (rOut - rIn) * 0.5;
        addSweptProfile(mb, {
            points: arcPts,
            section: [[-halfW, h * 0.5], [halfW, h * 0.5], [halfW, -h * 0.5], [-halfW, -h * 0.5]],
            matId: MAT_STONE,
            planeNormal: [0, 1, 0],
            capEnds: true,
        });
    }

    // 前殿两道古典连拱门廊
    for (const zR of [2.6, -2.2]) {
        addSculptedColumn(mb, { x: -5.45, baseY: 0.1, z: zR, radius: 0.42, height: 6.8, flutes: 20, style: 'classical' });
        addSculptedColumn(mb, { x: 5.45, baseY: 0.1, z: zR, radius: 0.42, height: 6.8, flutes: 20, style: 'classical' });
        addMultiOrderArch(mb, { span: 10.9, springY: 6.85, apexY: 11.0, z: zR, ribWidth: 0.44, ribDepth: 0.52, pointed: false, withSpandrel: true, withPendant: false });
    }

    // 11 柱真半圆形潘神鼓座墙体 + 放射汇聚至天顶穹眼的古典石拱肋！
    const drumR = 6.75;
    const domeCenterZ = -8.6;
    const oculusR = 2.95;
    const drumCount = 10;
    const ribSec = [[-0.18, 0.22], [0.18, 0.22], [0.22, -0.22], [-0.22, -0.22]];
    for (let i = 0; i <= drumCount; i++) {
        const theta = -Math.PI * 0.42 + (i / drumCount) * Math.PI * 0.84;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        const px = sinT * drumR;
        const pz = domeCenterZ - cosT * drumR;
        addSculptedColumn(mb, { x: px, baseY: 0.35, z: pz, radius: 0.34, height: 6.45, flutes: 20, style: 'classical' });

        // 放射穹顶藻井肋从柱头弯拱向天顶穹眼环
        const archPts = [];
        for (let s = 0; s <= 10; s++) {
            const tt = s / 10;
            const rCur = drumR + (oculusR - drumR) * tt;
            const yCur = 6.85 + Math.sin(tt * Math.PI * 0.5) * 3.45;
            archPts.push([sinT * rCur, yCur, domeCenterZ - cosT * rCur]);
        }
        addSweptProfile(mb, { points: archPts, section: ribSec, matId: MAT_TRIM, capEnds: true });

        if (i < drumCount) {
            const thetaMid = -Math.PI * 0.42 + ((i + 0.5) / drumCount) * Math.PI * 0.84;
            const wx = Math.sin(thetaMid) * (drumR + 0.45);
            const wz = domeCenterZ - Math.cos(thetaMid) * (drumR + 0.45);
            addChamferedBox(mb, { cx: wx, cy: 1.5, cz: wz, sx: 2.35, sy: 2.8, sz: 0.65, bevel: 0.04, ry: -thetaMid, matId: MAT_STONE, matBevelId: MAT_TRIM });
            addRecessedWindowBay(mb, {
                cx: Math.sin(thetaMid) * (drumR + 0.32),
                cy: 4.85,
                cz: domeCenterZ - Math.cos(thetaMid) * (drumR + 0.32),
                width: 1.65,
                height: 3.4,
                depth: 0.45,
                ry: -thetaMid,
                cols: 2,
                rows: 4,
                headType: 'arched',
            });
            addChamferedBox(mb, { cx: wx, cy: 7.4, cz: wz, sx: 2.45, sy: 1.4, sz: 0.72, bevel: 0.04, ry: -thetaMid, matId: MAT_TRIM, matBevelId: MAT_STONE });
        }
    }

    // 万神殿天顶圆形开放穹眼外环 (Centered at (0, 10.3, -8.6))
    const oculusRingPts = [];
    for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        oculusRingPts.push([Math.cos(a) * oculusR, 10.3, domeCenterZ + Math.sin(a) * oculusR]);
    }
    addSweptProfile(mb, {
        points: oculusRingPts,
        section: [[-0.26, 0.26], [0.26, 0.26], [0.30, -0.26], [-0.30, -0.26]],
        closedPath: true,
        matId: MAT_TRIM,
        planeNormal: [0, 1, 0],
    });
    // 环形挑檐线脚圈 (y = 6.85 连续包裹半圆鼓墙顶部)
    const cornicePts = [];
    for (let i = 0; i <= 32; i++) {
        const theta = -Math.PI * 0.45 + (i / 32) * Math.PI * 0.90;
        cornicePts.push([Math.sin(theta) * (drumR + 0.15), 6.85, domeCenterZ - Math.cos(theta) * (drumR + 0.15)]);
    }
    addSweptProfile(mb, {
        points: cornicePts,
        section: [[-0.45, 0.24], [0.45, 0.24], [0.45, -0.24], [-0.45, -0.24]],
        matId: MAT_TRIM,
        planeNormal: [0, 1, 0],
        capEnds: true,
    });

    // 4 座三足青铜圣火鼎立于弧墙阶前
    addPantheonTripodBrazier(mb, { x: -4.25, baseY: 0.26, z: -4.6 });
    addPantheonTripodBrazier(mb, { x: 4.25, baseY: 0.26, z: -4.6 });
    addPantheonTripodBrazier(mb, { x: -4.75, baseY: 0.26, z: -10.8 });
    addPantheonTripodBrazier(mb, { x: 4.75, baseY: 0.26, z: -10.8 });

    // 高悬天顶日轮穹眼旋转青铜环 + 双侧精密纬度黄铜悬环（彻底取代欧式灯笼！）
    dynamicParts.push({
        id: 'rotunda-oculus-crown',
        pivot: [0, 8.45, -8.6],
        baseRot: [1.34, 0.0, 0.0],
        spinRate: [0, 0, 0.14],
        mesh: buildOrnateGimbalRing({ radius: 1.98, width: 0.12, thick: 0.20, segments: 64, matId: MAT_METAL }),
    });
    const ringSide = buildOrnateGimbalRing({ radius: 0.68, width: 0.055, thick: 0.09, segments: 56, matId: MAT_METAL });
    dynamicParts.push({ id: 'rotunda-pendulum-l', pivot: [-4.15, 5.45, -8.6], baseRot: [0.35, 0.45, 0], spinRate: [0, 0.22, 0.06], bobAmp: 0.07, mesh: ringSide });
    dynamicParts.push({ id: 'rotunda-pendulum-r', pivot: [4.15, 5.45, -8.6], baseRot: [-0.35, -0.45, 0], spinRate: [0, -0.22, -0.06], bobAmp: 0.07, mesh: ringSide });

    addLightShaftQuad(shaftBuilder, [-2.0, 10.1, -9.8], [2.0, 10.1, -9.8], [2.8, 0.02, -5.2], [-2.8, 0.02, -5.2]);
}

function buildArcadeScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 6. 威尼斯水上拱廊：最阔泻湖水道 + 反曲摩尔尖瓣列柱 + 开放海岸远景小石桥 + 水中系泊船灯柱！
    addSideTerraceDecks(mb, 5.35, 0.18, true);
    addFullWaterPlane(waterBuilder, 5.55);

    const bays = [-12.6, -9.4, -6.2, -3.0, 0.2, 3.4];
    for (let idx = 0; idx < bays.length; idx++) {
        const zPos = bays[idx];
        // 成对纤细威尼斯双联柱
        addSculptedColumn(mb, { x: -4.95, baseY: 0.1, z: zPos - 0.18, radius: 0.21, height: 5.95, flutes: 14, style: 'classical' });
        addSculptedColumn(mb, { x: -4.95, baseY: 0.1, z: zPos + 0.18, radius: 0.21, height: 5.95, flutes: 14, style: 'classical' });
        addSculptedColumn(mb, { x: 4.95, baseY: 0.1, z: zPos - 0.18, radius: 0.21, height: 5.95, flutes: 14, style: 'classical' });
        addSculptedColumn(mb, { x: 4.95, baseY: 0.1, z: zPos + 0.18, radius: 0.21, height: 5.95, flutes: 14, style: 'classical' });
        addVenetianOgeeArchBay(mb, { span: 9.9, springY: 6.0, apexY: 9.85, z: zPos, ribWidth: 0.34, ribDepth: 0.42 });
        if (idx < bays.length - 1) {
            addGroinVaultBay(mb, {
                spanX: 9.9, zCenter: (zPos + bays[idx + 1]) * 0.5,
                bayDepth: Math.abs(bays[idx + 1] - zPos), springY: 6.1, apexY: 9.85, withWebbing: false,
            });
        }
    }
    addChamferedBox(mb, { cx: -4.95, cy: 6.05, cz: -4.6, sx: 0.48, sy: 0.34, sz: 17.2, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 4.95, cy: 6.05, cz: -4.6, sx: 0.48, sy: 0.34, sz: 17.2, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });

    // 外廊宽阔开敞水滨矮石女墙 + 远外侧通透威尼斯彩色水波屏窗（透出大量开阔天空水光！）
    for (const zWin of [-11.0, -7.8, -4.6, -1.4, 1.8]) {
        addChamferedBox(mb, { cx: -5.35, cy: 0.56, cz: zWin, sx: 0.28, sy: 0.72, sz: 2.8, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addChamferedBox(mb, { cx: 5.35, cy: 0.56, cz: zWin, sx: 0.28, sy: 0.72, sz: 2.8, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addRecessedWindowBay(mb, { cx: -6.95, cy: 4.15, cz: zWin, width: 2.35, height: 5.4, depth: 0.38, ry: Math.PI * 0.5, cols: 3, rows: 5, headType: 'arched', frameMat: MAT_TRIM });
        addRecessedWindowBay(mb, { cx: 6.95, cy: 4.15, cz: zWin, width: 2.35, height: 5.4, depth: 0.38, ry: -Math.PI * 0.5, cols: 3, rows: 5, headType: 'arched', frameMat: MAT_TRIM });
    }

    // 远端跨越水道的低矮拱形威尼斯石桥 (apexY = 0.85 < 1.2，完全净空歌词视廊！)
    const bridgePts = [];
    for (let k = 0; k <= 16; k++) {
        const u = -1 + (k / 16) * 2;
        bridgePts.push([u * 4.4, 0.24 + (1 - u * u) * 0.58, -12.3]);
    }
    addSweptProfile(mb, {
        points: bridgePts,
        section: [[-0.55, 0.14], [0.55, 0.14], [0.55, -0.18], [-0.55, -0.18]],
        matId: MAT_TRIM,
        planeNormal: [0, 0, 1],
        capEnds: true,
    });

    // 后殿开敞三孔水门凯旋柱廊（下方大面积留白直接敞向月亮与暮光泻湖天际！）
    addChamferedBox(mb, { cx: -4.4, cy: 4.8, cz: -14.2, sx: 2.4, sy: 9.6, sz: 0.85, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 4.4, cy: 4.8, cz: -14.2, sx: 2.4, sy: 9.6, sz: 0.85, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addSculptedColumn(mb, { x: -2.55, baseY: 0.1, z: -14.1, radius: 0.30, height: 6.0, flutes: 16, style: 'classical' });
    addSculptedColumn(mb, { x: 2.55, baseY: 0.1, z: -14.1, radius: 0.30, height: 6.0, flutes: 16, style: 'classical' });
    addVenetianOgeeArchBay(mb, { span: 5.1, springY: 6.0, apexY: 9.6, z: -14.1, ribWidth: 0.36, ribDepth: 0.44 });
    addRecessedWindowBay(mb, { cx: 0, cy: 7.75, cz: -14.18, width: 2.6, height: 2.2, depth: 0.44, cols: 3, rows: 3, headType: 'arched', frameMat: MAT_TRIM });

    // 四根直立水面红金缠带威尼斯系泊木桩 (Paline)，顶部坐落微摆六角港湾灯笼！
    const hexLanternMesh = buildVenetianHexLanternMesh(0.26, 0.86);
    for (const [lid, lx, lz, dir] of [
        ['arcade-lantern-1', -4.05, -11.0, 1],
        ['arcade-lantern-2', 4.05, -11.0, -1],
        ['arcade-lantern-3', -4.05, -4.6, -1],
        ['arcade-lantern-4', 4.05, -4.6, 1],
    ]) {
        addLathe(mb, {
            cx: lx, cy: 0.0, cz: lz,
            segs: 12,
            matId: MAT_TRIM,
            profile: [
                [0.20, 0.0, true, MAT_STONE],
                [0.14, 0.65, true, MAT_TRIM],
                [0.13, 2.75, false, MAT_TRIM],
                [0.18, 2.95, true, MAT_METAL],
            ],
        });
        dynamicParts.push({
            id: lid,
            pivot: [lx, 3.06, lz],
            baseRot: [0, 0.25 * dir, 0],
            spinRate: [0, 0.14 * dir, 0],
            bobAmp: 0,
            mesh: hexLanternMesh,
        });
    }

    addLightShaftQuad(shaftBuilder, [-2.0, 8.2, -13.4], [2.0, 8.2, -13.4], [2.8, 0.02, -3.5], [-2.8, 0.02, -3.5]);
}

function buildScriptoriumScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 7. 秘阁藏经馆：干石读经主道 + 古典木石筒形藻井格子穹顶 + 后殿二层挑台连廊 + 帕拉第奥大型弧窗 + 读经台双烛台 + 悬垂天体仪
    addSideTerraceDecks(mb, 4.35, 0.22, true);
    addFullWaterPlane(waterBuilder, 4.4);
    // 实心修道院中轴棋盘石道 + 后殿展开古卷读经讲坛与双黄铜立灯柱
    addChamferedBox(mb, { cx: 0, cy: 0.08, cz: -3.2, sx: 3.9, sy: 0.16, sz: 22.0, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });
    for (let zT = 2.4; zT >= -12.0; zT -= 2.4) {
        addChamferedBox(mb, { cx: 0, cy: 0.17, cz: zT, sx: 3.2, sy: 0.04, sz: 0.24, bevel: 0.008, matId: MAT_TRIM, matBevelId: MAT_METAL });
    }
    addChamferedBox(mb, { cx: 0, cy: 0.20, cz: -11.4, sx: 5.2, sy: 0.24, sz: 2.5, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addLecternFolioStand(mb, { cx: 0, y: 0.32, cz: -11.4 });
    for (const lx of [-1.75, 1.75]) {
        addLathe(mb, {
            cx: lx, cy: 0.32, cz: -11.35,
            segs: 18,
            matId: MAT_TRIM,
            profile: [
                [0.28, 0.00, true, MAT_STONE],
                [0.24, 0.10, true, MAT_TRIM],
                [0.09, 0.20, false, MAT_METAL],
                [0.065, 0.88, false, MAT_METAL],
                [0.16, 0.96, true, MAT_TRIM],
                [0.22, 1.12, false, MAT_GLASS],
                [0.16, 1.28, false, MAT_GLASS],
                [0.02, 1.36, true, MAT_METAL],
            ],
        });
    }

    const sBays = [-12.4, -8.8, -5.2, -1.6, 2.0];
    for (let idx = 0; idx < sBays.length; idx++) {
        const zPos = sBays[idx];
        addChamferedBox(mb, { cx: -5.85, cy: 4.2, cz: zPos, sx: 0.82, sy: 8.4, sz: 0.95, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addChamferedBox(mb, { cx: 5.85, cy: 4.2, cz: zPos, sx: 0.82, sy: 8.4, sz: 0.95, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addSculptedColumn(mb, { x: -4.75, baseY: 0.1, z: zPos, radius: 0.30, height: 6.75, flutes: 18, style: 'classical' });
        addSculptedColumn(mb, { x: 4.75, baseY: 0.1, z: zPos, radius: 0.30, height: 6.75, flutes: 18, style: 'classical' });
        // 古典圆弧筒顶书馆横梁 (告别与哥特大教堂同构的尖拱玫瑰窗)
        addMultiOrderArch(mb, { span: 9.5, springY: 6.85, apexY: 10.65, z: zPos, ribWidth: 0.48, ribDepth: 0.56, pointed: false, withSpandrel: true, withPendant: false });
        if (idx < sBays.length - 1) {
            addGroinVaultBay(mb, {
                spanX: 9.5, zCenter: (zPos + sBays[idx + 1]) * 0.5,
                bayDepth: Math.abs(sBays[idx + 1] - zPos), springY: 6.95, apexY: 10.65, withWebbing: false,
            });
            addTurnedBalustrade(mb, { x0: -4.78, z0: zPos + 0.42, x1: -4.78, z1: sBays[idx + 1] - 0.42, y: 3.74, height: 0.78, spacing: 0.44, newelInterval: 4.0 });
            addTurnedBalustrade(mb, { x0: 4.78, z0: zPos + 0.42, x1: 4.78, z1: sBays[idx + 1] - 0.42, y: 3.74, height: 0.78, spacing: 0.44, newelInterval: 4.0 });
        }
    }
    // 纵向木石藻井纵桁梁 (与大教堂十字肋交叉形成明确木书库格子天棚区分)
    for (const [bx, by] of [[-3.75, 8.2], [-1.95, 9.75], [0, 10.45], [1.95, 9.75], [3.75, 8.2]]) {
        addChamferedBox(mb, { cx: bx, cy: by, cz: -5.2, sx: 0.24, sy: 0.28, sz: 15.6, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_METAL });
    }

    for (const zNiche of [-10.6, -7.0, -3.4, 0.2]) {
        addEnclosureWallBay(mb, { cx: -5.85, cy: 1.80, cz: zNiche, width: 3.3, height: 3.60, ry: Math.PI * 0.5, bookshelf: true });
        addEnclosureWallBay(mb, { cx: 5.85, cy: 1.80, cz: zNiche, width: 3.3, height: 3.60, ry: -Math.PI * 0.5, bookshelf: true });
        addChamferedBox(mb, { cx: -6.35, cy: 6.1, cz: zNiche, sx: 0.36, sy: 4.8, sz: 3.45, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addChamferedBox(mb, { cx: 6.35, cy: 6.1, cz: zNiche, sx: 0.36, sy: 4.8, sz: 3.45, bevel: 0.03, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addRecessedWindowBay(mb, { cx: -5.98, cy: 5.95, cz: zNiche, width: 2.25, height: 3.85, depth: 0.48, ry: Math.PI * 0.5, cols: 3, rows: 4, headType: 'arched' });
        addRecessedWindowBay(mb, { cx: 5.98, cy: 5.95, cz: zNiche, width: 2.25, height: 3.85, depth: 0.48, ry: -Math.PI * 0.5, cols: 3, rows: 4, headType: 'arched' });
    }
    addChamferedBox(mb, { cx: -5.58, cy: 3.62, cz: -5.2, sx: 1.15, sy: 0.28, sz: 16.4, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 5.58, cy: 3.62, cz: -5.2, sx: 1.15, sy: 0.28, sz: 16.4, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_STONE });

    // 后殿双层图书馆跨堂夹层走道桥 + 两侧藏书龛 + 中央古卷圣龛 + 巨型帕拉第奥弧顶花窗（无玫瑰窗！）
    addChamferedBox(mb, { cx: -5.4, cy: 5.2, cz: -14.6, sx: 3.8, sy: 10.6, sz: 0.95, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 5.4, cy: 5.2, cz: -14.6, sx: 3.8, sy: 10.6, sz: 0.95, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 0.55, cz: -14.4, sx: 8.6, sy: 1.10, sz: 0.88, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addEnclosureWallBay(mb, { cx: -2.75, cy: 2.35, cz: -14.25, width: 2.4, height: 3.2, ry: 0, bookshelf: true });
    addEnclosureWallBay(mb, { cx: 2.75, cy: 2.35, cz: -14.25, width: 2.4, height: 3.2, ry: 0, bookshelf: true });
    addRecessedWindowBay(mb, { cx: 0, cy: 2.35, cz: -14.2, width: 2.45, height: 3.35, depth: 0.52, cols: 3, rows: 4, headType: 'arched', frameMat: MAT_TRIM });

    // 贯穿后壁的二层书库挑廊木栏台 (y = 4.22)
    addChamferedBox(mb, { cx: 0, cy: 4.18, cz: -13.68, sx: 9.8, sy: 0.30, sz: 1.35, bevel: 0.035, matId: MAT_TRIM, matBevelId: MAT_METAL });
    addTurnedBalustrade(mb, { x0: -4.65, z0: -13.08, x1: 4.65, z1: -13.08, y: 4.32, height: 0.80, spacing: 0.44, newelInterval: 3.1 });

    // 二层大型帕拉第奥图书馆宽阔弧窗 (取代玫瑰窗 + 三联教堂窄窗)
    addChamferedBox(mb, { cx: -3.5, cy: 7.2, cz: -14.4, sx: 1.4, sy: 5.8, sz: 0.85, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 3.5, cy: 7.2, cz: -14.4, sx: 1.4, sy: 5.8, sz: 0.85, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 0, cy: 10.05, cz: -14.5, sx: 13.8, sy: 1.9, sz: 0.95, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addRecessedWindowBay(mb, { cx: 0, cy: 6.95, cz: -14.22, width: 5.55, height: 4.85, depth: 0.56, cols: 6, rows: 5, headType: 'arched', frameMat: MAT_TRIM });

    addCraneBracketArm(mb, -4.75, -3.72, 6.72, -10.6);
    addCraneBracketArm(mb, 4.75, 3.72, 6.72, -10.6);
    const astrolabeMesh = buildAstrolabeGlobeMesh(0.54, 0.94);
    dynamicParts.push({ id: 'scriptorium-folio-l', pivot: [-3.72, 5.20, -10.6], baseRot: [0.2, 0.45, 0], spinRate: [0.06, 0.12, -0.04], mesh: astrolabeMesh });
    dynamicParts.push({ id: 'scriptorium-folio-r', pivot: [3.72, 5.20, -10.6], baseRot: [-0.2, -0.45, 0], spinRate: [-0.06, -0.12, 0.04], mesh: astrolabeMesh });

    addLightShaftQuad(shaftBuilder, [-2.2, 8.8, -13.4], [2.2, 8.8, -13.4], [2.6, 0.02, -4.0], [-2.6, 0.02, -4.0]);
}

function buildAtriumScene(mb, shaftBuilder, waterBuilder, dynamicParts) {
    // 8. 曦光植物水晶花房：全玻弧形维多利亚温室拱顶 + 弯曲花园漫步石径 + 阶梯花坛棕榈铜叶 + 三环露珠生态仪！
    addFullWaterPlane(waterBuilder, 5.2);
    // 曲线园林砂岩步径穿行水镜之中 + 两侧台阶植物种植花床 (无冷硬长条路沿和欧式石栏！)
    for (let zWalk = 4.2; zWalk >= -12.6; zWalk -= 1.8) {
        const xWeave = Math.sin(zWalk * 0.28) * 0.55;
        addChamferedBox(mb, { cx: xWeave, cy: 0.07, cz: zWalk, sx: 2.25, sy: 0.14, sz: 1.48, bevel: 0.035, ry: Math.cos(zWalk * 0.28) * 0.12, matId: MAT_STONE, matBevelId: MAT_TRIM });
    }
    addChamferedBox(mb, { cx: -6.8, cy: 0.34, cz: -4.2, sx: 6.8, sy: 0.68, sz: 27.0, bevel: 0.045, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: 6.8, cy: 0.34, cz: -4.2, sx: 6.8, sy: 0.68, sz: 27.0, bevel: 0.045, matId: MAT_STONE, matBevelId: MAT_TRIM });
    addChamferedBox(mb, { cx: -4.45, cy: 0.42, cz: -4.2, sx: 1.5, sy: 0.54, sz: 22.0, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });
    addChamferedBox(mb, { cx: 4.45, cy: 0.42, cz: -4.2, sx: 1.5, sy: 0.54, sz: 22.0, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });

    const aBays = [-12.2, -8.4, -4.6, -0.8, 3.0];
    for (let idx = 0; idx < aBays.length; idx++) {
        const zPos = aBays[idx];
        addSculptedColumn(mb, { x: -5.15, baseY: 0.65, z: zPos, radius: 0.22, height: 6.25, style: 'cast_iron' });
        addSculptedColumn(mb, { x: 5.15, baseY: 0.65, z: zPos, radius: 0.22, height: 6.25, style: 'cast_iron' });
        // 纤细圆形温室铁艺桶拱 (Barrel conservatory truss)
        addMultiOrderArch(mb, { span: 10.3, springY: 6.85, apexY: 11.1, z: zPos, ribWidth: 0.26, ribDepth: 0.32, pointed: false, matId: MAT_METAL, matTrim: MAT_TRIM, withPendant: false });
        if (idx < aBays.length - 1) {
            addGroinVaultBay(mb, {
                spanX: 10.3, zCenter: (zPos + aBays[idx + 1]) * 0.5,
                bayDepth: Math.abs(aBays[idx + 1] - zPos), springY: 6.9, apexY: 11.1, conservatoryGlass: true,
            });
        }
    }
    addChamferedBox(mb, { cx: -5.15, cy: 6.92, cz: -4.6, sx: 0.28, sy: 0.24, sz: 16.0, bevel: 0.02, matId: MAT_METAL });
    addChamferedBox(mb, { cx: 5.15, cy: 6.92, cz: -4.6, sx: 0.28, sy: 0.24, sz: 16.0, bevel: 0.02, matId: MAT_METAL });

    // 通透连续花房玻璃侧幕墙 + 半圆形多叶全玻端殿穹顶（彻底移除与 Pavilion 撞车的厚石三联教堂窗！）
    for (const zWall of [-10.3, -6.5, -2.7, 1.1]) {
        addRecessedWindowBay(mb, { cx: -5.45, cy: 4.15, cz: zWall, width: 3.55, height: 6.4, depth: 0.38, ry: Math.PI * 0.5, cols: 4, rows: 7, headType: 'arched', frameMat: MAT_METAL });
        addRecessedWindowBay(mb, { cx: 5.45, cy: 4.15, cz: zWall, width: 3.55, height: 6.4, depth: 0.38, ry: -Math.PI * 0.5, cols: 4, rows: 7, headType: 'arched', frameMat: MAT_METAL });
    }
    // 端景弧排落地花房幕墙 (5 段柔和内抱)
    addChamferedBox(mb, { cx: 0, cy: 0.55, cz: -14.2, sx: 11.4, sy: 1.1, sz: 0.65, bevel: 0.04, matId: MAT_TRIM, matBevelId: MAT_STONE });
    for (const [gx, gz, gw, ry] of [
        [-4.2, -13.15, 2.35, 0.44],
        [-2.15, -13.95, 2.25, 0.20],
        [0.0, -14.25, 2.45, 0.0],
        [2.15, -13.95, 2.25, -0.20],
        [4.2, -13.15, 2.35, -0.44],
    ]) {
        addRecessedWindowBay(mb, { cx: gx, cy: 4.85, cz: gz, width: gw, height: 7.7, depth: 0.36, ry, cols: 3, rows: 7, headType: 'arched', frameMat: MAT_METAL });
    }

    // 侧翼花坛上扇展的青铜棕榈叶簇 (|x| >= 3.7，绝不碰触阅读廊道)
    for (const zP of [-10.5, -6.6, -2.6]) {
        addBotanicalPalmFrondCluster(mb, { x: -4.45, baseY: 0.68, z: zP, scale: 0.96, inwardSign: 1 });
        addBotanicalPalmFrondCluster(mb, { x: 4.45, baseY: 0.68, z: zP, scale: 0.96, inwardSign: -1 });
    }

    // 温室弧拱纵向锻铁桁檩 + 垂直玻璃穹顶吊杆悬垂露珠仪（告别角落悬臂支架）
    addChamferedBox(mb, { cx: -3.82, cy: 9.70, cz: -4.6, sx: 0.14, sy: 0.16, sz: 16.0, bevel: 0.015, matId: MAT_METAL });
    addChamferedBox(mb, { cx: 3.82, cy: 9.70, cz: -4.6, sx: 0.14, sy: 0.16, sz: 16.0, bevel: 0.015, matId: MAT_METAL });
    const dewOrbMesh = buildBotanicalDewOrbMesh(0.32, 0.48);
    for (const [cid, cxPos, cyPos, czPos, dir] of [
        ['atrium-crystal-l1', -3.82, 5.10, -10.3, 1],
        ['atrium-crystal-r1', 3.82, 5.10, -10.3, -1],
        ['atrium-crystal-l2', -3.82, 4.75, -2.7, -1],
        ['atrium-crystal-r2', 3.82, 4.75, -2.7, 1],
    ]) {
        const rodTop = 9.70;
        const rodBot = cyPos + 0.72;
        addChamferedBox(mb, {
            cx: cxPos,
            cy: (rodTop + rodBot) * 0.5,
            cz: czPos,
            sx: 0.026,
            sy: Math.max(0.4, rodTop - rodBot),
            sz: 0.026,
            bevel: 0.004,
            matId: MAT_METAL,
        });
        dynamicParts.push({
            id: cid,
            pivot: [cxPos, cyPos, czPos],
            baseRot: [0, 0.35 * dir, 0],
            spinRate: [0, 0.18 * dir, 0],
            bobAmp: 0.08,
            mesh: dewOrbMesh,
        });
    }

    addLightShaftQuad(shaftBuilder, [-2.8, 9.0, -13.4], [0.4, 9.0, -13.4], [2.6, 0.02, -3.0], [-1.0, 0.02, -3.0]);
    addLightShaftQuad(shaftBuilder, [-0.4, 9.0, -13.4], [2.8, 9.0, -13.4], [1.0, 0.02, -3.0], [-2.6, 0.02, -3.0]);
}

const ARCHETYPE_BUILDERS = {
    cathedral: buildCathedralScene,
    observatory: buildObservatoryScene,
    cloister: buildCloisterScene,
    pavilion: buildPavilionScene,
    rotunda: buildRotundaScene,
    arcade: buildArcadeScene,
    scriptorium: buildScriptoriumScene,
    atrium: buildAtriumScene,
};

export function composeVitrailArchitecture(archetype = 'cathedral') {
    const mb = new MeshBuilder();
    const shaftBuilder = new MeshBuilder();
    const waterBuilder = new MeshBuilder();
    const dynamicParts = [];

    const builder = ARCHETYPE_BUILDERS[archetype] || buildPavilionScene;
    builder(mb, shaftBuilder, waterBuilder, dynamicParts);

    return {
        archetype,
        staticMesh: mb.toBuffers(),
        waterMesh: waterBuilder.toBuffers(),
        shaftMesh: shaftBuilder.toBuffers(),
        dynamicParts,
    };
}
