/**
 * web/src/core/visualizers/vitrail/vitrailPrimitives.js
 * 「琉璃龛 · Vitrail」精细雕刻建筑原语库（车削线脚、扫掠拱肋、聚束柱、花窗石棂、旋转栏杆、灯笼星仪）
 *
 * 严格约束：
 * - 所有石材倒角与雕花均使用 MAT_STONE / MAT_TRIM，金属 MAT_METAL 仅用于铜棂、星仪刻度、腰箍与灯笼骨架；
 * - 所有回转体与扫掠体保留精确解析曲面法线并校验绕序，禁止低模棱面锯齿与退化零面积面。
 */

import {
    MAT_STONE,
    MAT_TRIM,
    MAT_METAL,
    MAT_GLASS,
    MAT_CRYSTAL,
    MeshBuilder,
    transformPoint,
    rotateVec,
    ptToObj,
    addChamferedBox,
} from './vitrailMeshCore.js';

function norm3(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
}

/**
 * 解析法线旋转车削原语（Attic 柱础、花瓶栏杆、华盖冠帽、壁柱基座、石灯笼底座）
 * @param {MeshBuilder} mb
 * @param {{
 *   cx?: number, cy?: number, cz?: number,
 *   rx?: number, ry?: number, rz?: number,
 *   profile: Array<[number, number, boolean?, number?]>,
 *   segs?: number,
 *   matId?: number,
 *   uvScaleV?: number,
 *   flutes?: number,
 *   fluteAmp?: number,
 * }} opts
 */
export function addLathe(mb, {
    cx = 0, cy = 0, cz = 0,
    rx = 0, ry = 0, rz = 0,
    profile,
    segs = 24,
    matId = MAT_STONE,
    uvScaleV = 1,
    flutes = 0,
    fluteAmp = 0,
} = {}) {
    if (!profile || profile.length < 2) return;
    const T = (lx, ly, lz) => transformPoint([lx, ly, lz], cx, cy, cz, rx, ry, rz);
    const R = (lx, ly, lz) => rotateVec([lx, ly, lz], rx, ry, rz);

    // 按 sharp 标记切分平滑区间，使相邻阶梯折角保留锐利刀口，圆弧滚线保持光滑曲面
    const spans = [];
    let cur = [profile[0]];
    for (let i = 1; i < profile.length; i++) {
        cur.push(profile[i]);
        if (profile[i][2] && i < profile.length - 1) {
            spans.push(cur);
            cur = [profile[i]];
        }
    }
    if (cur.length >= 2) spans.push(cur);

    const evalFlute = (ang) => {
        if (flutes <= 0 || fluteAmp <= 0) return { scale: 1, dScale: 0 };
        const phase = flutes * ang;
        const c = Math.cos(phase);
        if (c <= 0.02) return { scale: 1, dScale: 0 };
        const s = Math.sin(phase);
        const shape = Math.pow(c, 1.35);
        const dShape = -1.35 * flutes * Math.pow(c, 0.35) * s;
        return { scale: 1 - fluteAmp * shape, dScale: -fluteAmp * dShape };
    };

    for (const segProfile of spans) {
        // 为该平滑段各节点计算轮廓切向 (dr, dy)
        const nNodes = segProfile.length;
        const nrArr = new Float64Array(nNodes);
        const nyArr = new Float64Array(nNodes);
        for (let k = 0; k < nNodes; k++) {
            const pPrev = segProfile[Math.max(0, k - 1)];
            const pNext = segProfile[Math.min(nNodes - 1, k + 1)];
            const dr = pNext[0] - pPrev[0];
            const dy = pNext[1] - pPrev[1];
            const dLen = Math.hypot(dr, dy) || 1;
            nrArr[k] = dy / dLen;
            nyArr[k] = -dr / dLen;
        }

        for (let k = 0; k < nNodes - 1; k++) {
            const [r0, y0, , m0] = segProfile[k];
            const [r1, y1] = segProfile[k + 1];
            const segMat = m0 ?? matId;
            if (Math.hypot(r1 - r0, y1 - y0) < 1e-4) continue;
            const v0 = k * uvScaleV * 0.25;
            const v1 = (k + 1) * uvScaleV * 0.25;

            for (let i = 0; i < segs; i++) {
                const a0 = (i / segs) * Math.PI * 2;
                const a1 = ((i + 1) / segs) * Math.PI * 2;
                const c0 = Math.cos(a0), s0 = Math.sin(a0);
                const c1 = Math.cos(a1), s1 = Math.sin(a1);
                const f0 = evalFlute(a0);
                const f1 = evalFlute(a1);

                const rr00 = r0 * f0.scale;
                const rr01 = r0 * f1.scale;
                const rr10 = r1 * f0.scale;
                const rr11 = r1 * f1.scale;

                const normAt = (angCos, angSin, nrVal, nyVal, rVal, fObj) => {
                    if (fObj.dScale === 0 || rVal < 0.02) {
                        return R(angCos * nrVal, nyVal, angSin * nrVal);
                    }
                    // 计入凹槽斜率对水平法向的切向偏转，形成真实多里克凹槽高光
                    const slant = Math.max(-0.55, Math.min(0.55, fObj.dScale));
                    const lx = angCos * nrVal + angSin * slant * nrVal;
                    const lz = angSin * nrVal - angCos * slant * nrVal;
                    return norm3(...R(lx, nyVal, lz));
                };

                const n00 = normAt(c0, s0, nrArr[k], nyArr[k], r0, f0);
                const n01 = normAt(c1, s1, nrArr[k], nyArr[k], r0, f1);
                const n10 = normAt(c0, s0, nrArr[k + 1], nyArr[k + 1], r1, f0);
                const n11 = normAt(c1, s1, nrArr[k + 1], nyArr[k + 1], r1, f1);

                const u0 = i / segs;
                const u1 = (i + 1) / segs;

                if (r0 < 0.005 && r1 >= 0.008) {
                    const pTop = T(0, y0, 0);
                    const pB = T(c1 * rr11, y1, s1 * rr11);
                    const pA = T(c0 * rr10, y1, s0 * rr10);
                    const iTop = mb.addVertex(pTop[0], pTop[1], pTop[2], n00[0], n00[1], n00[2], (u0 + u1) * 0.5, v0, segMat);
                    const iA = mb.addVertex(pA[0], pA[1], pA[2], n10[0], n10[1], n10[2], u0, v1, segMat);
                    const iB = mb.addVertex(pB[0], pB[1], pB[2], n11[0], n11[1], n11[2], u1, v1, segMat);
                    const e1 = [pA[0] - pTop[0], pA[1] - pTop[1], pA[2] - pTop[2]];
                    const e2 = [pB[0] - pTop[0], pB[1] - pTop[1], pB[2] - pTop[2]];
                    const cxp = e1[1] * e2[2] - e1[2] * e2[1];
                    const cyp = e1[2] * e2[0] - e1[0] * e2[2];
                    const czp = e1[0] * e2[1] - e1[1] * e2[0];
                    if (cxp * n10[0] + cyp * n10[1] + czp * n10[2] >= 0) {
                        mb.addTri(iTop, iA, iB);
                    } else {
                        mb.addTri(iTop, iB, iA);
                    }
                } else if (r1 < 0.005 && r0 >= 0.008) {
                    const pTop = T(0, y1, 0);
                    const pA = T(c0 * rr00, y0, s0 * rr00);
                    const pB = T(c1 * rr01, y0, s1 * rr01);
                    const iTop = mb.addVertex(pTop[0], pTop[1], pTop[2], n10[0], n10[1], n10[2], (u0 + u1) * 0.5, v1, segMat);
                    const iA = mb.addVertex(pA[0], pA[1], pA[2], n00[0], n00[1], n00[2], u0, v0, segMat);
                    const iB = mb.addVertex(pB[0], pB[1], pB[2], n01[0], n01[1], n01[2], u1, v0, segMat);
                    const e1 = [pB[0] - pA[0], pB[1] - pA[1], pB[2] - pA[2]];
                    const e2 = [pTop[0] - pA[0], pTop[1] - pA[1], pTop[2] - pA[2]];
                    const cxp = e1[1] * e2[2] - e1[2] * e2[1];
                    const cyp = e1[2] * e2[0] - e1[0] * e2[2];
                    const czp = e1[0] * e2[1] - e1[1] * e2[0];
                    if (cxp * n00[0] + cyp * n00[1] + czp * n00[2] >= 0) {
                        mb.addTri(iA, iB, iTop);
                    } else {
                        mb.addTri(iA, iTop, iB);
                    }
                } else if (r0 >= 0.005 && r1 >= 0.005) {
                    const p00 = T(c0 * rr00, y0, s0 * rr00);
                    const p01 = T(c1 * rr01, y0, s1 * rr01);
                    const p11 = T(c1 * rr11, y1, s1 * rr11);
                    const p10 = T(c0 * rr10, y1, s0 * rr10);
                    mb.addSmoothQuad(p00, n00, p10, n10, p11, n11, p01, n01, u0, v0, u1, v1, segMat);
                }
            }
        }
    }
}

/**
 * 沿 3D 路径扫掠任意闭合 2D 线脚截面（多层级拱券肋、玫瑰窗石圈、窗楣线条、细铜棂筋）
 * @param {MeshBuilder} mb
 * @param {{
 *   points: Array<[number, number, number]>,
 *   section: Array<[number, number, boolean?, number?]>,
 *   closedPath?: boolean,
 *   matId?: number,
 *   uvScaleU?: number,
 *   planeNormal?: [number, number, number],
 *   capEnds?: boolean,
 * }} opts
 */
export function addSweptProfile(mb, {
    points,
    section,
    closedPath = false,
    matId = MAT_STONE,
    uvScaleU = 0.35,
    planeNormal = null,
    capEnds = false,
} = {}) {
    if (!points || points.length < 2 || !section || section.length < 3) return;
    const count = points.length;
    const frames = [];
    let prevB = planeNormal ? norm3(planeNormal[0], planeNormal[1], planeNormal[2]) : null;

    for (let i = 0; i < count; i++) {
        const prev = points[closedPath ? (i - 1 + count) % count : Math.max(0, i - 1)];
        const next = points[closedPath ? (i + 1) % count : Math.min(count - 1, i + 1)];
        const t = norm3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
        let b;
        if (planeNormal) {
            b = prevB;
        } else {
            const ref = Math.abs(t[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
            if (prevB) {
                // 平行输运消除急转处扭曲
                const dot = prevB[0] * t[0] + prevB[1] * t[1] + prevB[2] * t[2];
                const proj = [prevB[0] - t[0] * dot, prevB[1] - t[1] * dot, prevB[2] - t[2] * dot];
                b = Math.hypot(...proj) > 1e-4 ? norm3(...proj) : norm3(
                    t[1] * ref[2] - t[2] * ref[1],
                    t[2] * ref[0] - t[0] * ref[2],
                    t[0] * ref[1] - t[1] * ref[0],
                );
            } else {
                b = norm3(
                    t[1] * ref[2] - t[2] * ref[1],
                    t[2] * ref[0] - t[0] * ref[2],
                    t[0] * ref[1] - t[1] * ref[0],
                );
            }
            prevB = b;
        }
        // n = t x b（当 t=(tx,ty,0), b=(0,0,1) 时 n=(ty,-tx,0)，保持截面 (u,v) 一致性）
        const n = norm3(
            t[1] * b[2] - t[2] * b[1],
            t[2] * b[0] - t[0] * b[2],
            t[0] * b[1] - t[1] * b[0],
        );
        frames.push({ p: points[i], n, b });
    }

    const secLen = section.length;
    const evalPos = (fr, u, v) => [
        fr.p[0] + fr.n[0] * u + fr.b[0] * v,
        fr.p[1] + fr.n[1] * u + fr.b[1] * v,
        fr.p[2] + fr.n[2] * u + fr.b[2] * v,
    ];
    const evalNorm = (fr, nu, nv) => norm3(
        fr.n[0] * nu + fr.b[0] * nv,
        fr.n[1] * nu + fr.b[1] * nv,
        fr.n[2] * nu + fr.b[2] * nv,
    );

    // 预计算截面各边外法线 (假设截面围绕中心顺/逆时针有序，用相对截面质心外积确认朝外)
    let cu = 0, cv = 0;
    for (const s of section) { cu += s[0]; cv += s[1]; }
    cu /= secLen; cv /= secLen;

    const segCount = closedPath ? count : count - 1;
    for (let i = 0; i < segCount; i++) {
        const f0 = frames[i];
        const f1 = frames[(i + 1) % count];
        const uTex0 = i * uvScaleU;
        const uTex1 = (i + 1) * uvScaleU;

        for (let k = 0; k < secLen; k++) {
            const kNext = (k + 1) % secLen;
            const [su0, sv0, , sMat] = section[k];
            const [su1, sv1] = section[kNext];
            const du = su1 - su0, dv = sv1 - sv0;
            if (Math.hypot(du, dv) < 1e-4) continue;
            // 候选外法线 (dv, -du)，与中点相对于质心矢量点乘判定正负
            let enu = dv, env = -du;
            const midU = (su0 + su1) * 0.5 - cu;
            const midV = (sv0 + sv1) * 0.5 - cv;
            if (enu * midU + env * midV < 0) {
                enu = -enu; env = -env;
            }
            const eLen = Math.hypot(enu, env) || 1;
            enu /= eLen; env /= eLen;

            const n0 = evalNorm(f0, enu, env);
            const n1 = evalNorm(f1, enu, env);
            const p0 = evalPos(f0, su0, sv0);
            const p1 = evalPos(f0, su1, sv1);
            const p2 = evalPos(f1, su1, sv1);
            const p3 = evalPos(f1, su0, sv0);

            mb.addSmoothQuad(p0, n0, p1, n0, p2, n1, p3, n1, uTex0, k / secLen, uTex1, (k + 1) / secLen, sMat ?? matId);
        }
    }

    if (capEnds && !closedPath && secLen >= 3) {
        const capFace = (fr, rev) => {
            const center = [
                fr.p[0] + fr.n[0] * cu + fr.b[0] * cv,
                fr.p[1] + fr.n[1] * cu + fr.b[1] * cv,
                fr.p[2] + fr.n[2] * cu + fr.b[2] * cv,
            ];
            for (let k = 0; k < secLen; k++) {
                const s0 = section[k];
                const s1 = section[(k + 1) % secLen];
                const a = evalPos(fr, s0[0], s0[1]);
                const b = evalPos(fr, s1[0], s1[1]);
                if (rev) {
                    mb.addFlatTri(center, b, a, 0.5, 0.5, 0, 1, 1, 1, matId);
                } else {
                    mb.addFlatTri(center, a, b, 0.5, 0.5, 0, 1, 1, 1, matId);
                }
            }
        };
        capFace(frames[0], false);
        capFace(frames[count - 1], true);
    }
}

/**
 * 构建高精度古典/哥特/禅院雕刻立柱（真 Attic 车削基座、光滑凹槽柱身、聚束子柱、斗拱或叶饰钟形柱头）
 * 彻底移除石柱倒角上的亮金属描边，金属仅保留在精细颈环与腰箍中
 */
export function addSculptedColumn(mb, {
    x = 0, baseY = 0, z = 0,
    radius = 0.42,
    height = 7.2,
    flutes = 16,
    style = 'classical',
} = {}) {
    if (style === 'timber_stone') {
        // 禅意青石斗拱柱墩：多阶斜切基石 + 车削铜水磐箍 + 凹槽雕纹四面石木柱 + 传统三层斗拱托架
        const bH = 0.44;
        addChamferedBox(mb, { cx: x, cy: baseY + bH * 0.45, cz: z, sx: radius * 2.75, sy: bH * 0.90, sz: radius * 2.75, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
        addChamferedBox(mb, { cx: x, cy: baseY + bH + 0.05, cz: z, sx: radius * 2.15, sy: 0.14, sz: radius * 2.15, bevel: 0.025, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addLathe(mb, {
            cx: x, cy: baseY + bH + 0.12, cz: z,
            segs: 24,
            matId: MAT_METAL,
            profile: [
                [radius * 1.08, 0.00, true, MAT_METAL],
                [radius * 1.12, 0.05, false, MAT_METAL],
                [radius * 0.94, 0.11, true, MAT_METAL],
            ],
        });
        const capBaseY = baseY + height - 0.88;
        const postY0 = baseY + bH + 0.20;
        const postH = Math.max(1.2, capBaseY - postY0);
        const postCy = postY0 + postH * 0.5;
        // 主柱身 + 四向垂直阴刻木石贴面筋线（消除平板方块感）
        addChamferedBox(mb, { cx: x, cy: postCy, cz: z, sx: radius * 1.46, sy: postH, sz: radius * 1.46, bevel: 0.05, matId: MAT_STONE, matBevelId: MAT_TRIM });
        for (const [dx, dz, sxRib, szRib] of [
            [radius * 0.72, 0, 0.06, radius * 0.62],
            [-radius * 0.72, 0, 0.06, radius * 0.62],
            [0, radius * 0.72, radius * 0.62, 0.06],
            [0, -radius * 0.72, radius * 0.62, 0.06],
        ]) {
            addChamferedBox(mb, { cx: x + dx, cy: postCy, cz: z + dz, sx: sxRib, sy: postH * 0.92, sz: szRib, bevel: 0.015, matId: MAT_TRIM });
        }
        // 中段细铜榫箍
        addChamferedBox(mb, { cx: x, cy: postY0 + postH * 0.68, cz: z, sx: radius * 1.56, sy: 0.075, sz: radius * 1.56, bevel: 0.014, matId: MAT_METAL });
        // 三层渐出斗拱托臂（皿斗 -> X向肘木+端斗 -> Z向大斗+昂托）
        addChamferedBox(mb, { cx: x, cy: capBaseY + 0.12, cz: z, sx: radius * 1.82, sy: 0.22, sz: radius * 1.82, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addChamferedBox(mb, { cx: x, cy: capBaseY + 0.36, cz: z, sx: radius * 3.15, sy: 0.22, sz: radius * 1.35, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
        addChamferedBox(mb, { cx: x, cy: capBaseY + 0.36, cz: z, sx: radius * 1.35, sy: 0.22, sz: radius * 3.15, bevel: 0.03, matId: MAT_TRIM, matBevelId: MAT_STONE });
        for (const endOff of [-radius * 1.28, radius * 1.28]) {
            addChamferedBox(mb, { cx: x + endOff, cy: capBaseY + 0.56, cz: z, sx: radius * 0.62, sy: 0.18, sz: radius * 0.88, bevel: 0.025, matId: MAT_STONE, matBevelId: MAT_TRIM });
            addChamferedBox(mb, { cx: x, cy: capBaseY + 0.56, cz: z + endOff, sx: radius * 0.88, sy: 0.18, sz: radius * 0.62, bevel: 0.025, matId: MAT_STONE, matBevelId: MAT_TRIM });
        }
        addChamferedBox(mb, { cx: x, cy: baseY + height - 0.14, cz: z, sx: radius * 3.35, sy: 0.24, sz: radius * 3.35, bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM });
        return;
    }

    const plinthH = 0.30;
    const subH = 0.20;
    const atticH = 0.34;
    const capH = 0.54;
    const abacusH = 0.22;
    const shaftY0 = baseY + plinthH + subH + atticH;
    const shaftH = Math.max(1.2, height - plinthH - subH - atticH - capH - abacusH);
    const shaftY1 = shaftY0 + shaftH;

    // 1. 双层切角石 plinth 台基（MAT_STONE / MAT_TRIM 自然微倒角，绝无亮金属线框）
    addChamferedBox(mb, {
        cx: x, cy: baseY + plinthH * 0.5, cz: z,
        sx: radius * 3.15, sy: plinthH, sz: radius * 3.15,
        bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM,
    });
    addChamferedBox(mb, {
        cx: x, cy: baseY + plinthH + subH * 0.5, cz: z,
        sx: radius * 2.66, sy: subH, sz: radius * 2.66,
        bevel: 0.035, matId: MAT_TRIM,
    });

    // 2. Attic 车削基座线脚（圆环凸线 -> 深凹槽 scotia -> 上圆线 -> 细铜束腰箍）
    const atticY = baseY + plinthH + subH;
    addLathe(mb, {
        cx: x, cy: atticY, cz: z,
        segs: 28,
        matId: MAT_TRIM,
        profile: [
            [radius * 1.32, 0.00, true, MAT_TRIM],
            [radius * 1.38, 0.06, false, MAT_TRIM],
            [radius * 1.34, 0.12, true, MAT_TRIM],
            [radius * 1.14, 0.17, false, MAT_STONE],
            [radius * 1.24, 0.24, true, MAT_TRIM],
            [radius * 1.07, 0.31, true, MAT_TRIM],
            [radius * 1.08, 0.34, true, MAT_METAL],
            [radius * 1.02, 0.38, true, MAT_METAL],
        ],
    });

    if (style === 'gothic_cluster') {
        // 哥特八束聚束石柱：28面中心核心 + 4主斜向半嵌石柱 + 4细正交附壁小柱 + 双道铜边束腰箍
        addLathe(mb, {
            cx: x, cy: shaftY0, cz: z,
            segs: 28,
            matId: MAT_STONE,
            profile: [
                [radius * 0.86, 0.0, false],
                [radius * 0.84, shaftH * 0.5, false],
                [radius * 0.80, shaftH, true],
            ],
        });
        for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI * 2;
            const isMajor = k % 2 === 1;
            const shaftR = radius * (isMajor ? 0.28 : 0.19);
            const offsetR = radius * (isMajor ? 0.78 : 0.82);
            addLathe(mb, {
                cx: x + Math.cos(ang) * offsetR,
                cy: shaftY0,
                cz: z + Math.sin(ang) * offsetR,
                segs: isMajor ? 18 : 14,
                matId: isMajor ? MAT_TRIM : MAT_STONE,
                profile: [
                    [shaftR * 1.08, 0.0, false],
                    [shaftR, shaftH * 0.5, false],
                    [shaftR * 0.94, shaftH, false],
                ],
            });
        }
        // 双道中腰聚束石箍 + 嵌铜丝环
        for (const frac of [0.36, 0.68]) {
            addLathe(mb, {
                cx: x, cy: shaftY0 + shaftH * frac, cz: z,
                segs: 32,
                matId: MAT_TRIM,
                profile: [
                    [radius * 1.04, -0.09, true, MAT_TRIM],
                    [radius * 1.15, -0.02, false, MAT_TRIM],
                    [radius * 1.17, 0.02, true, MAT_METAL],
                    [radius * 1.04, 0.09, true, MAT_TRIM],
                ],
            });
        }
    } else if (style === 'cast_iron') {
        // 博物花房铸铁细棱肋柱（28面修长棱柱 + 双段铆接饰环 + 维多利亚弧形柱顶撑架）
        addLathe(mb, {
            cx: x, cy: shaftY0, cz: z,
            segs: 28,
            matId: MAT_METAL,
            flutes: 12,
            fluteAmp: 0.05,
            profile: [
                [radius * 0.84, 0.0, false],
                [radius * 0.80, shaftH * 0.5, false],
                [radius * 0.75, shaftH, true],
            ],
        });
        for (const frac of [0.30, 0.62, 0.86]) {
            addLathe(mb, {
                cx: x, cy: shaftY0 + shaftH * frac, cz: z,
                segs: 24,
                matId: MAT_TRIM,
                profile: [
                    [radius * 0.82, -0.06, true, MAT_TRIM],
                    [radius * 1.00, 0.0, false, MAT_METAL],
                    [radius * 0.82, 0.06, true, MAT_TRIM],
                ],
            });
        }
    } else {
        // 古典光滑凹槽收分柱 (entasis + smooth concave flutes + 微细水平鼓缝)
        const useFlutes = Math.max(20, flutes);
        const shaftNodes = [];
        const stacks = 10;
        for (let s = 0; s <= stacks; s++) {
            const t = s / stacks;
            const ent = 1.0 - 0.085 * t * t * 0.6 - 0.055 * t;
            shaftNodes.push([radius * ent, t * shaftH, false, MAT_STONE]);
        }
        addLathe(mb, {
            cx: x, cy: shaftY0, cz: z,
            segs: Math.max(40, useFlutes * 2),
            matId: MAT_STONE,
            flutes: useFlutes,
            fluteAmp: 0.038,
            profile: shaftNodes,
        });
    }

    // 3. 精雕颈部铜 astragal 圆线 + 钟形柱头 kalathos + 8 向曲线卷草涡卷叶片
    addLathe(mb, {
        cx: x, cy: shaftY1 - 0.02, cz: z,
        segs: 32,
        matId: MAT_TRIM,
        profile: [
            [radius * 0.92, -0.06, true, MAT_TRIM],
            [radius * 1.07, 0.00, true, MAT_METAL],
            [radius * 0.96, 0.06, true, MAT_TRIM],
            [radius * 0.95, 0.14, false, MAT_STONE],
            [radius * 1.08, 0.28, false, MAT_TRIM],
            [radius * 1.26, 0.42, false, MAT_TRIM],
            [radius * 1.42, capH, true, MAT_TRIM],
        ],
    });

    // 8 向精雕弧线涡卷毛茛叶饰 (扫掠平滑圆弧代替块状方角片!)
    const leafSec = [
        [-radius * 0.11, radius * 0.08, true, MAT_TRIM],
        [radius * 0.11, radius * 0.08, true, MAT_TRIM],
        [radius * 0.08, -radius * 0.07, true, MAT_STONE],
        [-radius * 0.08, -radius * 0.07, true, MAT_STONE],
    ];
    for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const reach = k % 2 === 0 ? 1.32 : 1.18;
        const pts = [
            [x + ca * radius * 0.88, shaftY1 + 0.06, z + sa * radius * 0.88],
            [x + ca * radius * (0.98 * reach), shaftY1 + capH * 0.46, z + sa * radius * (0.98 * reach)],
            [x + ca * radius * (1.14 * reach), shaftY1 + capH * 0.84, z + sa * radius * (1.14 * reach)],
            [x + ca * radius * (0.96 * reach), shaftY1 + capH * 0.96, z + sa * radius * (0.96 * reach)],
        ];
        addSweptProfile(mb, {
            points: pts,
            section: leafSec,
            matId: MAT_TRIM,
            capEnds: true,
        });
    }

    // 阶梯状冠状 abacus 顶板
    addChamferedBox(mb, {
        cx: x, cy: shaftY1 + capH + abacusH * 0.5, cz: z,
        sx: radius * 3.05, sy: abacusH, sz: radius * 3.05,
        bevel: 0.04, matId: MAT_STONE, matBevelId: MAT_TRIM,
    });
}

/**
 * 构建多阶石质线脚拱券 + 可选三角拱肩石墙填充 + 雕刻拱心石悬垂
 */
export function addMultiOrderArch(mb, {
    span = 11.2,
    springY = 6.8,
    apexY = 10.6,
    z = 0,
    ribWidth = 0.52,
    ribDepth = 0.62,
    pointed = true,
    stepsPerHalf = 30,
    matId = MAT_STONE,
    matTrim = MAT_TRIM,
    withSpandrel = false,
    withPendant = true,
} = {}) {
    const half = span * 0.5;
    const rise = Math.max(0.8, apexY - springY);
    const pts = [];

    const evalSide = (t, sign) => {
        if (pointed) {
            const y = springY + rise * Math.pow(Math.sin(t * Math.PI * 0.5), 0.78);
            const xBase = sign * half * (1 - t);
            const xCurve = sign * half * Math.cos(t * Math.PI * 0.44);
            return [xBase * 0.32 + xCurve * 0.68, y, z];
        }
        const ang = t * Math.PI * 0.5;
        return [sign * half * Math.cos(ang), springY + rise * Math.sin(ang), z];
    };

    for (let i = 0; i <= stepsPerHalf; i++) {
        pts.push(evalSide(i / stepsPerHalf, -1));
    }
    for (let i = stepsPerHalf - 1; i >= 0; i--) {
        pts.push(evalSide(i / stepsPerHalf, 1));
    }

    // 三层叠级石作拱肋截面（外冠 dripstone / 内嵌凹凸槽 / 内弧腹卷 —— 无斑马铜边）
    const hw = ribWidth * 0.5;
    const hd = ribDepth * 0.5;
    const section = [
        [-hw * 1.15, hd * 1.05, true, matTrim],
        [hw * 0.40, hd * 1.05, true, matTrim],
        [hw * 0.40, hd * 0.68, true, matId],
        [hw * 1.00, hd * 0.68, true, matId],
        [hw * 1.00, hd * 0.25, true, matTrim],
        [hw * 1.16, hd * 0.14, false, matTrim],
        [hw * 1.16, -hd * 0.14, true, matTrim],
        [hw * 1.00, -hd * 0.25, true, matId],
        [hw * 1.00, -hd * 0.68, true, matId],
        [hw * 0.40, -hd * 0.68, true, matTrim],
        [hw * 0.40, -hd * 1.05, true, matTrim],
        [-hw * 1.15, -hd * 1.05, true, matId],
    ];

    addSweptProfile(mb, {
        points: pts,
        section,
        closedPath: false,
        matId,
        planeNormal: [0, 0, 1],
    });

    // 若需要与两侧墙壁或上方挑檐咬合，生成高精度砖石拱肩壁片（位于 y > springY >= 6.0，远离阅读区）
    if (withSpandrel) {
        const wallTopY = apexY + 0.55;
        const zFace = z + hd * 0.38;
        const zBack = z - hd * 0.38;
        const outerX = half + ribWidth * 0.55;
        const stepIndices = Math.floor(pts.length * 0.5);
        for (let side = 0; side < 2; side++) {
            const start = side === 0 ? 0 : stepIndices;
            const end = side === 0 ? stepIndices : pts.length - 1;
            const xEdge = side === 0 ? -outerX : outerX;
            for (let i = start; i < end; i++) {
                const pA = pts[i];
                const pB = pts[i + 1];
                const minY = Math.min(pA[1], pB[1]) + 0.08;
                if (wallTopY - minY < 0.08) continue;
                // 前面与背面石墙三角拱肩填充，封堵“浮空细黑框”
                if (side === 0) {
                    mb.addFlatQuad(
                        [pA[0], pA[1], zFace], [pB[0], pB[1], zFace],
                        [pB[0], wallTopY, zFace], [pA[0], wallTopY, zFace],
                        i * 0.18, 0, (i + 1) * 0.18, 1, matId,
                    );
                    mb.addFlatQuad(
                        [pB[0], pB[1], zBack], [pA[0], pA[1], zBack],
                        [pA[0], wallTopY, zBack], [pB[0], wallTopY, zBack],
                        i * 0.18, 0, (i + 1) * 0.18, 1, matId,
                    );
                } else {
                    mb.addFlatQuad(
                        [pA[0], pA[1], zFace], [pB[0], pB[1], zFace],
                        [pB[0], wallTopY, zFace], [pA[0], wallTopY, zFace],
                        i * 0.18, 0, (i + 1) * 0.18, 1, matId,
                    );
                    mb.addFlatQuad(
                        [pB[0], pB[1], zBack], [pA[0], pA[1], zBack],
                        [pA[0], wallTopY, zBack], [pB[0], wallTopY, zBack],
                        i * 0.18, 0, (i + 1) * 0.18, 1, matId,
                    );
                }
            }
            // 外翼垂直封边补齐拱肩到柱头处矩形角落
            const cornerX = side === 0 ? -half * 0.96 : half * 0.96;
            addChamferedBox(mb, {
                cx: (xEdge + cornerX) * 0.5,
                cy: (springY + wallTopY) * 0.5,
                cz: z,
                sx: Math.max(0.24, Math.abs(xEdge - cornerX) + 0.25),
                sy: Math.max(0.4, wallTopY - springY),
                sz: ribDepth * 0.78,
                bevel: 0.025,
                matId,
                matBevelId: matTrim,
            });
        }
    }

    // 精雕阶梯楔形拱心石 + 底部花结垂饰
    addChamferedBox(mb, {
        cx: 0, cy: apexY + 0.08, cz: z,
        sx: ribWidth * 1.65, sy: ribWidth * 1.48, sz: ribDepth * 1.38,
        bevel: 0.045, matId: matTrim, matBevelId: matId,
    });
    if (withPendant) {
        addLathe(mb, {
            cx: 0, cy: apexY - ribWidth * 0.65, cz: z,
            segs: 16,
            matId: MAT_TRIM,
            profile: [
                [0.015, -0.34, true, MAT_METAL],
                [0.075, -0.22, false, MAT_METAL],
                [0.18, -0.06, false, MAT_TRIM],
                [0.24, 0.08, true, MAT_TRIM],
            ],
        });
    }
}

/**
 * 构建深槽石雕花窗边框与分叉花瓣石棂玫瑰窗（替换锯齿小方砖与丑陋居中菱形）
 */
export function addTraceryRoseWindow(mb, {
    cx = 0, cy = 4.6, cz = -13.2,
    radius = 4.2,
    spokes = 12,
} = {}) {
    // 1. 深斜切圆拱壁龛套筒 (Stone Embrasure Drum，64面高精度顺滑壁龛环)
    addLathe(mb, {
        cx, cy, cz: cz + 0.16,
        rx: Math.PI * 0.5,
        segs: Math.max(48, spokes * 4),
        matId: MAT_STONE,
        profile: [
            [radius * 1.00, -0.28, true, MAT_TRIM],
            [radius * 1.06, -0.04, true, MAT_STONE],
            [radius * 1.15, 0.14, true, MAT_TRIM],
            [radius * 1.24, 0.32, true, MAT_STONE],
            [radius * 1.30, 0.34, true, MAT_TRIM],
            [radius * 1.30, -0.30, true, MAT_STONE],
        ],
    });

    // 2. 退凹彩绘琉璃圆盘（多环极坐标高细分拼片）
    const rings = 4;
    const segs = Math.max(48, spokes * 4);
    const ringRadii = [0.05, radius * 0.24, radius * 0.48, radius * 0.74, radius * 0.99];
    const zGlass = cz - 0.08;
    for (let r = 0; r < rings; r++) {
        const rIn = ringRadii[r];
        const rOut = ringRadii[r + 1];
        for (let i = 0; i < segs; i++) {
            const a0 = (i / segs) * Math.PI * 2;
            const a1 = ((i + 1) / segs) * Math.PI * 2;
            const p0 = [cx + Math.cos(a0) * rIn, cy + Math.sin(a0) * rIn, zGlass];
            const p1 = [cx + Math.cos(a1) * rIn, cy + Math.sin(a1) * rIn, zGlass];
            const p2 = [cx + Math.cos(a1) * rOut, cy + Math.sin(a1) * rOut, zGlass];
            const p3 = [cx + Math.cos(a0) * rOut, cy + Math.sin(a0) * rOut, zGlass];
            const rUv = (0.30 + (r + 1) / rings) * 1.15;
            const u0 = 1.1 + Math.cos(a0) * rUv;
            const v0 = 1.1 + Math.sin(a0) * rUv;
            const u1 = 1.1 + Math.cos(a1) * rUv;
            const v1 = 1.1 + Math.sin(a1) * rUv;
            mb.addFlatQuad(p0, p3, p2, p1, u0, v0, u1, v1, MAT_GLASS);
        }
    }

    // 3. 光滑扫掠同心石棂圈 + 纤细铜铅条环
    const addRingTrace = (r, halfW, halfD, matRing) => {
        const ringPts = [];
        const rSeg = Math.max(52, spokes * 4);
        for (let i = 0; i < rSeg; i++) {
            const a = (i / rSeg) * Math.PI * 2;
            ringPts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz + 0.03]);
        }
        const sec = [
            [-halfW, halfD * 0.65],
            [0, halfD],
            [halfW, halfD * 0.65],
            [halfW * 0.85, -halfD * 0.8],
            [-halfW * 0.85, -halfD * 0.8],
        ];
        addSweptProfile(mb, {
            points: ringPts,
            section: sec,
            closedPath: true,
            matId: matRing,
            planeNormal: [0, 0, 1],
        });
    };

    addRingTrace(radius * 0.28, 0.05, 0.14, MAT_TRIM);
    addRingTrace(radius * 0.60, 0.06, 0.16, MAT_TRIM);
    addRingTrace(radius * 0.84, 0.04, 0.11, MAT_METAL);
    addRingTrace(radius * 0.96, 0.13, 0.24, MAT_TRIM);

    // 4. 放射石棂与 Y 型哥特花瓣拱叉 (Tracery Petals)
    for (let s = 0; s < spokes; s++) {
        const ang = (s / spokes) * Math.PI * 2;
        const spokeMid = radius * 0.62;
        // 内段直辐射石肋
        addChamferedBox(mb, {
            cx: cx + Math.cos(ang) * (spokeMid * 0.52),
            cy: cy + Math.sin(ang) * (spokeMid * 0.52),
            cz: cz + 0.03,
            sx: spokeMid * 0.96, sy: 0.075, sz: 0.17,
            bevel: 0.018, rz: ang, matId: MAT_TRIM,
        });

        // 外段 Y 字分叉拱花瓣（向左右邻辐汇聚，呈现真实哥特尖花叶韵味）
        const nextAng = ((s + 0.5) / spokes) * Math.PI * 2;
        const pStart = [cx + Math.cos(ang) * spokeMid, cy + Math.sin(ang) * spokeMid, cz + 0.04];
        const pMidL = [
            cx + Math.cos((ang + nextAng) * 0.5) * radius * 0.78,
            cy + Math.sin((ang + nextAng) * 0.5) * radius * 0.78,
            cz + 0.05,
        ];
        const pEnd = [cx + Math.cos(nextAng) * radius * 0.94, cy + Math.sin(nextAng) * radius * 0.94, cz + 0.03];
        addSweptProfile(mb, {
            points: [pStart, pMidL, pEnd],
            section: [[-0.036, 0.09], [0.036, 0.09], [0.03, -0.09], [-0.03, -0.09]],
            matId: MAT_TRIM,
            planeNormal: [0, 0, 1],
            capEnds: true,
        });

        const prevHalf = ((s - 0.5) / spokes) * Math.PI * 2;
        const pMidR = [
            cx + Math.cos((ang + prevHalf) * 0.5) * radius * 0.78,
            cy + Math.sin((ang + prevHalf) * 0.5) * radius * 0.78,
            cz + 0.05,
        ];
        const pEndR = [cx + Math.cos(prevHalf) * radius * 0.94, cy + Math.sin(prevHalf) * radius * 0.94, cz + 0.03];
        addSweptProfile(mb, {
            points: [pStart, pMidR, pEndR],
            section: [[-0.036, 0.09], [0.036, 0.09], [0.03, -0.09], [-0.03, -0.09]],
            matId: MAT_TRIM,
            planeNormal: [0, 0, 1],
            capEnds: true,
        });

        // 后层纤细铜嵌丝拉杆（质感点缀）
        addChamferedBox(mb, {
            cx: cx + Math.cos(ang) * (radius * 0.48),
            cy: cy + Math.sin(ang) * (radius * 0.48),
            cz: cz - 0.02,
            sx: radius * 0.94, sy: 0.024, sz: 0.05,
            bevel: 0.005, rz: ang, matId: MAT_METAL,
        });
    }

    // 5. 精致车削中央花冠芯饰 + 八瓣精雕黄铜花心（取代原先的斜切方块）
    addLathe(mb, {
        cx, cy, cz: cz + 0.05,
        rx: Math.PI * 0.5,
        segs: 24,
        matId: MAT_TRIM,
        profile: [
            [0.015, 0.16, true, MAT_METAL],
            [radius * 0.09, 0.12, false, MAT_METAL],
            [radius * 0.14, 0.06, true, MAT_TRIM],
            [radius * 0.18, -0.08, true, MAT_TRIM],
        ],
    });
}

/**
 * 构建带深槽石框窗套、坡面窗台、细石棂格与哥特/半圆拱窗头的立体花窗 (Lancet / Palladian / Shoji)
 */
export function addRecessedWindowBay(mb, {
    cx = 0, cy = 4.0, cz = -12.0,
    width = 1.8, height = 6.2,
    depth = 0.52,
    ry = 0, rz = 0,
    cols = 2, rows = 4,
    headType = 'pointed',
    frameMat = MAT_TRIM,
} = {}) {
    const T = (lx, ly, lz) => transformPoint([lx, ly, lz], cx, cy, cz, 0, ry, rz);
    const hw = width * 0.5;
    const hh = height * 0.5;
    const zGlass = -depth * 0.22;

    // 1. 退凹彩绘玻璃本体（世界尺度归一化 UV 避免拉扁马赛克）
    const glassTopY = headType === 'flat' ? hh : hh - hw * 0.35;
    mb.addFlatQuad(
        T(-hw, -hh, zGlass), T(hw, -hh, zGlass),
        T(hw, glassTopY, zGlass), T(-hw, glassTopY, zGlass),
        0, 0, Math.max(1, width * 0.7), Math.max(1, height * 0.4), MAT_GLASS,
    );

    if (headType !== 'flat') {
        // 拱头部分填满高细分弧形玻璃扇面，消除多边形折角
        const archSteps = 22;
        const topApex = hh + (headType === 'pointed' ? hw * 0.52 : hw * 0.28);
        const centerTop = T(0, glassTopY, zGlass);
        for (let i = 0; i < archSteps; i++) {
            const t0 = i / archSteps;
            const t1 = (i + 1) / archSteps;
            const evalArch = (t) => {
                const ang = t * Math.PI;
                const ax = -hw * Math.cos(ang);
                const s = Math.sin(ang);
                const lift = headType === 'pointed' ? Math.pow(s, 0.75) : s;
                const ay = glassTopY + (topApex - glassTopY) * lift;
                return [ax, ay];
            };
            const [x0, y0] = evalArch(t0);
            const [x1, y1] = evalArch(t1);
            mb.addFlatTri(centerTop, T(x1, y1, zGlass), T(x0, y0, zGlass), 0.5, 0.7, t1, 1.0, t0, 1.0, MAT_GLASS);
        }
    }

    // 2. 深窗框侧壁拥墙 + 左右附壁圆柱线脚窗柱 (Jamb Colonnettes) + 多阶窗台
    const jt = 0.17;
    const jd = depth;
    const rectH = headType === 'flat' ? height : (glassTopY - (-hh));
    const rectCy = -hh + rectH * 0.5;
    for (const sxSign of [-1, 1]) {
        addChamferedBox(mb, {
            ...ptToObj(T(sxSign * (hw + jt * 0.45), rectCy, 0)),
            sx: jt, sy: rectH + 0.08, sz: jd, bevel: 0.032, ry, rz, matId: frameMat, matBevelId: MAT_STONE,
        });
        // 窗框内缘精致细圆柱与上下微雕柱头柱础（非平面条窗直接升格为实体石刻窗龛）
        if (width >= 1.35) {
            const [cxJ, cyJ, czJ] = T(sxSign * (hw + 0.02), -hh + 0.04, jd * 0.34);
            addLathe(mb, {
                cx: cxJ, cy: cyJ, cz: czJ,
                segs: 14,
                rz,
                matId: frameMat,
                profile: [
                    [0.068, 0.00, true, frameMat],
                    [0.042, 0.14, true, frameMat],
                    [0.038, rectH - 0.20, true, frameMat],
                    [0.066, rectH - 0.04, true, MAT_TRIM],
                    [0.072, rectH + 0.02, true, frameMat],
                ],
            });
        }
    }
    // 外挑窗台线脚 + 下沿托槛
    addChamferedBox(mb, {
        ...ptToObj(T(0, -hh - 0.08, 0.08)),
        sx: width + jt * 2.5, sy: 0.18, sz: jd + 0.26, bevel: 0.038, ry, rz, matId: MAT_TRIM, matBevelId: MAT_STONE,
    });

    if (headType === 'flat') {
        addChamferedBox(mb, {
            ...ptToObj(T(0, hh + 0.08, 0.06)),
            sx: width + jt * 2.3, sy: 0.20, sz: jd + 0.20, bevel: 0.038, ry, rz, matId: frameMat, matBevelId: MAT_STONE,
        });
    } else {
        // 顶部高细分双阶拱楣与滴水檐线 (Hoodmould Arch)
        const archPts = [];
        const steps = 26;
        const topApex = hh + (headType === 'pointed' ? hw * 0.54 : hw * 0.30);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const ang = t * Math.PI;
            const ax = -hw * 1.06 * Math.cos(ang);
            const lift = headType === 'pointed' ? Math.pow(Math.sin(ang), 0.75) : Math.sin(ang);
            const ay = glassTopY + (topApex - glassTopY) * lift;
            archPts.push(T(ax, ay, 0.05));
        }
        const bNorm = rotateVec([0, 0, 1], 0, ry, rz);
        addSweptProfile(mb, {
            points: archPts,
            section: [
                [-0.125, jd * 0.50],
                [0.105, jd * 0.58],
                [0.145, 0.0],
                [0.095, -jd * 0.48],
                [-0.105, -jd * 0.48],
            ],
            matId: frameMat,
            planeNormal: bNorm,
            capEnds: true,
        });

        // 拱头内高细分圆花孔饰 + 对称三叶窗拱小肋 (Tracery Oculus + Sub-Arch Cusps)
        if (width >= 1.35) {
            const ocPts = [];
            const ocR = Math.min(hw * 0.32, (topApex - glassTopY) * 0.44);
            const ocY = glassTopY + ocR * 1.15;
            for (let i = 0; i < 32; i++) {
                const a = (i / 32) * Math.PI * 2;
                ocPts.push(T(Math.cos(a) * ocR, ocY + Math.sin(a) * ocR, zGlass + 0.08));
            }
            addSweptProfile(mb, {
                points: ocPts,
                section: [[-0.036, 0.075], [0.036, 0.075], [0.03, -0.075], [-0.03, -0.075]],
                closedPath: true,
                matId: frameMat,
                planeNormal: bNorm,
            });
            // 窗拱内侧四向精雕花心小辐
            for (let k = 0; k < 4; k++) {
                const ang = (k / 4) * Math.PI * 2 + Math.PI * 0.25;
                addChamferedBox(mb, {
                    ...ptToObj(T(Math.cos(ang) * ocR * 0.45, ocY + Math.sin(ang) * ocR * 0.45, zGlass + 0.08)),
                    sx: ocR * 0.92, sy: 0.026, sz: 0.055, bevel: 0.006, ry, rz: rz + ang, matId: frameMat,
                });
            }
            // 两翼从窗中梃向拱腰收束的小窗楣曲线 (Sub-lancet tracery)
            if (cols >= 2) {
                for (const sSign of [-1, 1]) {
                    const subPts = [];
                    for (let i = 0; i <= 10; i++) {
                        const tt = i / 10;
                        const ang = tt * Math.PI;
                        const subCx = sSign * hw * 0.5;
                        const subR = hw * 0.48;
                        subPts.push(T(subCx - subR * Math.cos(ang), glassTopY + Math.sin(ang) * ocR * 0.72, zGlass + 0.07));
                    }
                    addSweptProfile(mb, {
                        points: subPts,
                        section: [[-0.026, 0.055], [0.026, 0.055], [0.022, -0.055], [-0.022, -0.055]],
                        matId: frameMat,
                        planeNormal: bNorm,
                        capEnds: true,
                    });
                }
            }
        }
    }

    // 3. 垂直雕石小柱中梃 + 细铜水平嵌条
    for (let c = 1; c < cols; c++) {
        const lx = -hw + (width * c) / cols;
        const isCenter = c === Math.floor(cols * 0.5) && cols >= 2;
        addChamferedBox(mb, {
            ...ptToObj(T(lx, rectCy, zGlass + 0.08)),
            sx: isCenter ? 0.078 : 0.042,
            sy: rectH,
            sz: isCenter ? 0.18 : 0.09,
            bevel: isCenter ? 0.018 : 0.009,
            ry, rz,
            matId: isCenter ? frameMat : MAT_METAL,
        });
    }
    for (let r = 1; r < rows; r++) {
        const ly = -hh + (rectH * r) / rows;
        addChamferedBox(mb, {
            ...ptToObj(T(0, ly, zGlass + 0.05)),
            sx: width, sy: 0.038, sz: 0.08, bevel: 0.008, ry, rz, matId: MAT_METAL,
        });
    }
}

/**
 * 构建车削古典花瓶栏杆柱廊（取代粗糙光板长栏墙，适用于威尼斯水廊、圣坛隔栏、藏书阁二层走道）
 */
export function addTurnedBalustrade(mb, {
    x0, z0, x1, z1,
    y = 0.1,
    height = 0.94,
    spacing = 0.44,
    newelInterval = 3.2,
    matRail = MAT_TRIM,
    matBaluster = MAT_STONE,
} = {}) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.4) return;
    const ux = dx / len;
    const uz = dz / len;
    const yaw = -Math.atan2(dz, dx);

    // 1. 底部雕花地袱条石与顶部外挑圆弧扶手压顶
    const baseH = 0.14;
    const topH = 0.13;
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    addChamferedBox(mb, {
        cx, cy: y + baseH * 0.5, cz,
        sx: len, sy: baseH, sz: 0.28, bevel: 0.025, ry: yaw, matId: matRail, matBevelId: matBaluster,
    });
    addChamferedBox(mb, {
        cx, cy: y + height - topH * 0.5, cz,
        sx: len + 0.06, sy: topH, sz: 0.34, bevel: 0.035, ry: yaw, matId: matRail, matBevelId: matBaluster,
    });

    // 2. 分段方墩望柱 (Newels) + 车削双腹花瓶状石栏柱 (Lathe Balusters)
    const balH = Math.max(0.32, height - baseH - topH);
    const balY = y + baseH;
    const totalCount = Math.max(2, Math.round(len / spacing));
    const newelEvery = Math.max(4, Math.round(newelInterval / spacing));

    for (let i = 0; i <= totalCount; i++) {
        const dist = (i / totalCount) * len;
        const bx = x0 + ux * dist;
        const bz = z0 + uz * dist;
        const isNewel = i === 0 || i === totalCount || (i % newelEvery === 0);
        if (isNewel) {
            addChamferedBox(mb, {
                cx: bx, cy: y + height * 0.5, cz: bz,
                sx: 0.32, sy: height + 0.08, sz: 0.32,
                bevel: 0.032, ry: yaw, matId: matRail, matBevelId: matBaluster,
            });
            addLathe(mb, {
                cx: bx, cy: y + height + 0.04, cz: bz,
                segs: 12,
                matId: MAT_METAL,
                profile: [
                    [0.095, 0.0, true, matRail],
                    [0.065, 0.05, false, MAT_METAL],
                    [0.085, 0.11, false, MAT_METAL],
                    [0.015, 0.19, true, MAT_METAL],
                ],
            });
        } else {
            addLathe(mb, {
                cx: bx, cy: balY, cz: bz,
                segs: 12,
                matId: matBaluster,
                profile: [
                    [0.085, 0.00, true, matRail],
                    [0.085, balH * 0.10, true, matRail],
                    [0.048, balH * 0.22, false, matBaluster],
                    [0.105, balH * 0.42, false, matBaluster],
                    [0.088, balH * 0.62, false, matBaluster],
                    [0.046, balH * 0.78, false, matBaluster],
                    [0.078, balH * 0.90, true, matRail],
                    [0.085, balH * 1.00, true, matRail],
                ],
            });
        }
    }
}

/**
 * 构建高细节外围围合墙龛（消除侧廊大面积黑色虚空，支持盲拱壁龛或秘阁精装书柜架）
 */
export function addEnclosureWallBay(mb, {
    cx = 0, cy = 4.2, cz = 0,
    width = 3.8, height = 8.4,
    ry = 0,
    bookshelf = false,
} = {}) {
    const T = (lx, ly, lz) => transformPoint([lx, ly, lz], cx, cy - height * 0.5, cz, 0, ry, 0);
    const bNorm = rotateVec([0, 0, 1], 0, ry, 0);
    const hw = width * 0.5;
    const pilW = 0.42;

    // 1. 实体背墙（退后 0.42m，留出厚实阴影凹槽）
    addChamferedBox(mb, {
        ...ptToObj(T(0, height * 0.5, -0.34)),
        sx: width + 0.1, sy: height, sz: 0.34, bevel: 0.025, ry, matId: MAT_STONE,
    });
    // 2. 底部腰墙台座与镶板浮雕 + 上部齿饰檐口线脚
    addChamferedBox(mb, {
        ...ptToObj(T(0, 0.55, -0.06)),
        sx: width, sy: 1.1, sz: 0.52, bevel: 0.035, ry, matId: MAT_TRIM, matBevelId: MAT_STONE,
    });
    const panW = Math.max(0.5, (width - pilW * 2.2) * 0.44);
    for (const pxSign of [-1, 1]) {
        addChamferedBox(mb, {
            ...ptToObj(T(pxSign * (panW * 0.58), 0.58, 0.14)),
            sx: panW, sy: 0.62, sz: 0.16, bevel: 0.025, ry, matId: MAT_STONE, matBevelId: MAT_TRIM,
        });
    }
    addChamferedBox(mb, {
        ...ptToObj(T(0, height - 0.26, 0.04)),
        sx: width + 0.12, sy: 0.44, sz: 0.68, bevel: 0.04, ry, matId: MAT_TRIM, matBevelId: MAT_STONE,
    });
    // 3. 左右镶嵌壁柱框出深壁龛空间
    for (const sxSign of [-1, 1]) {
        addChamferedBox(mb, {
            ...ptToObj(T(sxSign * (hw - pilW * 0.45), height * 0.5, -0.04)),
            sx: pilW, sy: height - 0.4, sz: 0.52, bevel: 0.03, ry, matId: MAT_TRIM, matBevelId: MAT_STONE,
        });
    }

    // 4. 中部水平石腰线 + 盲拱双连拱壁龛或层架藏书
    addChamferedBox(mb, {
        ...ptToObj(T(0, 3.65, 0.02)),
        sx: width - pilW * 0.5, sy: 0.22, sz: 0.54, bevel: 0.03, ry, matId: MAT_TRIM,
    });

    const innerW = Math.max(1.2, width - pilW * 1.9);
    if (bookshelf) {
        // 秘阁精装藏书层架（位于 y <= 3.55 二层挑廊线以下）与拱顶护槛 + 卷帙阵列
        const archPts = [];
        for (let i = 0; i <= 14; i++) {
            const a = (i / 14) * Math.PI;
            archPts.push(T(-innerW * 0.48 * Math.cos(a), 2.95 + Math.sin(a) * 0.45, -0.04));
        }
        addSweptProfile(mb, {
            points: archPts,
            section: [[-0.08, 0.14], [0.08, 0.14], [0.07, -0.14], [-0.07, -0.14]],
            matId: MAT_TRIM,
            planeNormal: bNorm,
            capEnds: true,
        });
        for (const shelfY of [1.45, 2.08, 2.72]) {
            addChamferedBox(mb, {
                ...ptToObj(T(0, shelfY, -0.08)),
                sx: innerW, sy: 0.08, sz: 0.36, bevel: 0.012, ry, matId: MAT_TRIM,
            });
            const bookSlots = 6;
            for (let b = 0; b < bookSlots; b++) {
                const bx = -innerW * 0.40 + (b / (bookSlots - 1)) * innerW * 0.80;
                const bh = 0.38 + ((b * 5 + Math.round(shelfY * 3)) % 3) * 0.05;
                addChamferedBox(mb, {
                    ...ptToObj(T(bx, shelfY + 0.04 + bh * 0.5, -0.10)),
                    sx: innerW / (bookSlots * 1.32),
                    sy: bh,
                    sz: 0.24,
                    bevel: 0.014,
                    ry,
                    matId: b % 2 === 0 ? MAT_TRIM : MAT_STONE,
                });
            }
        }
    } else if (height >= 6.4) {
        // 精雕双连盲拱壁龛 (Recessed Blind Wall Arcade)：给平墙面注入真石作凹凸浮雕层次
        const subW = innerW * 0.46;
        const centerMulX = 0;
        addChamferedBox(mb, {
            ...ptToObj(T(centerMulX, (3.76 + (height - 0.52)) * 0.5, -0.08)),
            sx: 0.16, sy: Math.max(1.2, height - 4.4), sz: 0.32, bevel: 0.025, ry, matId: MAT_TRIM,
        });
        const archSpring = Math.min(height - 1.3, 6.1);
        const archTop = Math.min(height - 0.55, archSpring + subW * 0.44);
        for (const archCx of [-innerW * 0.26, innerW * 0.26]) {
            const blindPts = [];
            for (let i = 0; i <= 14; i++) {
                const a = (i / 14) * Math.PI;
                blindPts.push(T(
                    archCx - (subW * 0.46) * Math.cos(a),
                    archSpring + (archTop - archSpring) * Math.sin(a),
                    -0.06,
                ));
            }
            addSweptProfile(mb, {
                points: blindPts,
                section: [[-0.085, 0.15], [0.085, 0.15], [0.075, -0.14], [-0.075, -0.14]],
                matId: MAT_TRIM,
                planeNormal: bNorm,
                capEnds: true,
            });
        }
    }
}

/**
 * 构建大殿高位交叉肋拱穹顶（Cross Groin Vault Ribs + 顶花结 + 可选实石拱腹片或晶庭玻璃天顶，严格位于 y >= springY）
 */
export function addGroinVaultBay(mb, {
    spanX = 9.5,
    zCenter = -6.2,
    bayDepth = 4.0,
    springY = 6.8,
    apexY = 10.6,
    withWebbing = false,
    conservatoryGlass = false,
} = {}) {
    const hx = spanX * 0.5;
    const hz = bayDepth * 0.5;
    const ribSec = [
        [-0.14, 0.16], [0.14, 0.16], [0.17, 0.0], [0.11, -0.18], [-0.11, -0.18], [-0.17, 0.0],
    ];
    const evalVaultY = (s) => springY + (apexY - springY) * Math.pow(Math.max(0, Math.cos(s * Math.PI * 0.5)), 0.75);
    // 两条高细分斜向交叉肋拱从四角柱头交汇到穹顶中心
    for (const diagSign of [-1, 1]) {
        const dPts = [];
        const steps = 22;
        for (let i = 0; i <= steps; i++) {
            const s = (i / steps) * 2 - 1;
            dPts.push([s * hx, evalVaultY(s), zCenter + diagSign * s * hz]);
        }
        addSweptProfile(mb, { points: dPts, section: ribSec, matId: conservatoryGlass ? MAT_METAL : MAT_TRIM });
    }
    // 次级脊肋 (Tierceron / Ridge Ribs)
    const ridgeSec = [[-0.09, 0.10], [0.09, 0.10], [0.11, 0.0], [0.08, -0.12], [-0.08, -0.12], [-0.11, 0.0]];
    const longPts = [];
    for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        longPts.push([0, apexY - 0.02 + Math.sin(t * Math.PI) * 0.12, zCenter - hz + t * bayDepth]);
    }
    addSweptProfile(mb, { points: longPts, section: ridgeSec, matId: conservatoryGlass ? MAT_METAL : MAT_TRIM });

    if (withWebbing || conservatoryGlass) {
        // 上位实体拱腹或温室琉璃采光天棚（双向闭面避免剔除，strictly y >= springY + 0.4）
        const matWeb = conservatoryGlass ? MAT_GLASS : MAT_STONE;
        const nU = 6;
        const rise = apexY - springY;
        const evalSurface = (u, v) => {
            const x = u * hx;
            const z = zCenter + v * hz;
            const dU = Math.pow(Math.max(0, Math.cos(u * Math.PI * 0.5)), 0.78);
            const dV = Math.pow(Math.max(0, Math.cos(v * Math.PI * 0.5)), 0.78);
            const y = springY + 0.25 + rise * (dU * 0.78 + dV * 0.22);
            return [x, y, z];
        };
        for (let iu = 0; iu < nU; iu++) {
            const u0 = -1 + (iu / nU) * 2;
            const u1 = -1 + ((iu + 1) / nU) * 2;
            const p00 = evalSurface(u0, -1);
            const p10 = evalSurface(u1, -1);
            const p11 = evalSurface(u1, 1);
            const p01 = evalSurface(u0, 1);
            const thick = conservatoryGlass ? 0.06 : 0.16;
            const up = (p) => [p[0], p[1] + thick, p[2]];
            // 下可见拱腹面 (-Y 法线) + 顶背面 (+Y 法线)
            mb.addFlatQuad(p00, p10, p11, p01, iu / nU, 0, (iu + 1) / nU, 1, matWeb);
            mb.addFlatQuad(up(p00), up(p01), up(p11), up(p10), iu / nU, 0, (iu + 1) / nU, 1, matWeb);
        }
    }

    // 中心交叉精雕石花冠吊顶盘
    addLathe(mb, {
        cx: 0, cy: apexY - 0.10, cz: zCenter,
        segs: 24,
        matId: MAT_TRIM,
        profile: [
            [0.02, -0.22, true, MAT_METAL],
            [0.11, -0.14, false, MAT_METAL],
            [0.36, 0.02, false, MAT_TRIM],
            [0.44, 0.18, true, MAT_TRIM],
        ],
    });
}

/**
 * 构建高精度连续曲面浑天仪黄铜星环（替换锯齿八边断砖：平滑扫掠线脚环带 + 12 处刻度钉 + 4 向枢轴耳）
 * 严格满足 VG2 三角面数与法线拓扑要求
 */
export function buildOrnateGimbalRing(radiusOrOpts = 3.6, tubeW = 0.12, tubeD = 0.20, segs = 64, matId = MAT_METAL) {
    let radius = radiusOrOpts;
    if (radiusOrOpts && typeof radiusOrOpts === 'object') {
        radius = radiusOrOpts.radius ?? 3.6;
        tubeW = radiusOrOpts.width ?? radiusOrOpts.tubeW ?? 0.12;
        tubeD = radiusOrOpts.thick ?? radiusOrOpts.tubeD ?? 0.20;
        segs = Math.max(56, radiusOrOpts.segments ?? radiusOrOpts.segs ?? 64);
        matId = radiusOrOpts.matId ?? MAT_METAL;
    } else {
        segs = Math.max(56, segs);
    }

    const mb = new MeshBuilder();
    const pts = [];
    for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
    }

    // 精雕阶梯带凹槽环带截面（含中心外脊、两侧渐收肩坡、内圈斜角）
    const hw = tubeW * 0.55;
    const hd = tubeD * 0.52;
    const section = [
        [-hw * 0.88, hd * 0.45, false, matId],
        [0.0, hd * 1.05, true, matId],
        [hw * 0.88, hd * 0.45, false, matId],
        [hw, 0.0, false, MAT_TRIM],
        [hw * 0.88, -hd * 0.45, false, matId],
        [0.0, -hd * 1.05, true, matId],
        [-hw * 0.88, -hd * 0.45, false, matId],
        [-hw, 0.0, false, MAT_TRIM],
    ];
    addSweptProfile(mb, {
        points: pts,
        section,
        closedPath: true,
        matId,
        planeNormal: [0, 0, 1],
    });

    // 12 处十二宫黄铜刻度凸起 + 4 个主方位轴承枢轴耳座
    for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const isCardinal = k % 3 === 0;
        const rx = Math.cos(ang) * radius;
        const ry = Math.sin(ang) * radius;
        addChamferedBox(mb, {
            cx: rx, cy: ry, cz: 0,
            sx: isCardinal ? tubeW * 2.1 : tubeW * 1.4,
            sy: isCardinal ? tubeW * 1.55 : tubeW * 0.85,
            sz: isCardinal ? tubeD * 1.38 : tubeD * 1.18,
            bevel: tubeW * 0.24,
            rz: ang,
            matId,
        });
        if (isCardinal) {
            addLathe(mb, {
                cx: Math.cos(ang) * (radius + tubeW * 0.72),
                cy: Math.sin(ang) * (radius + tubeW * 0.72),
                cz: 0,
                rz: ang - Math.PI * 0.5,
                segs: 12,
                matId,
                profile: [
                    [tubeD * 0.30, -0.04, true],
                    [tubeD * 0.36, 0.06, true],
                    [tubeD * 0.16, 0.18, true],
                ],
            });
        }
    }

    return mb.toBuffers();
}

/**
 * 构建精雕细笼哥特琉璃提灯 / 十二面晶核圣灯（替换粗陋六边双锥！）
 * 结构：上部花边铜华盖顶 -> 8 根弯曲金属护笼肋条 + 腰部镶铆环带 -> 内部 12 面切割宝石晶心 -> 底部垂坠铜铃坠饰
 */
export function buildOrnateLanternMesh(radius = 0.42, halfH = 1.4, suspensionLen = 0) {
    const mb = new MeshBuilder();
    const rCage = radius * 1.06;
    const hBody = halfH * 0.72;

    // 1. 顶部精雕花边铜华盖与优雅悬吊铜杆串珠（取代悬空孤立灯体！）
    addLathe(mb, {
        cx: 0, cy: hBody * 0.92, cz: 0,
        segs: 28,
        matId: MAT_METAL,
        profile: [
            [rCage * 1.08, -0.06, true, MAT_METAL],
            [rCage * 0.96, 0.08, false, MAT_METAL],
            [rCage * 0.56, halfH * 0.26, false, MAT_TRIM],
            [rCage * 0.28, halfH * 0.44, true, MAT_METAL],
            [rCage * 0.14, halfH * 0.56, false, MAT_METAL],
            [0.022, halfH * 0.66, true, MAT_METAL],
        ],
    });
    if (suspensionLen > 0.05) {
        const rodY0 = hBody * 0.92 + halfH * 0.64;
        const rodTop = rodY0 + suspensionLen;
        addLathe(mb, {
            cx: 0, cy: rodY0, cz: 0,
            segs: 12,
            matId: MAT_METAL,
            profile: [
                [0.045, 0.00, true, MAT_METAL],
                [0.022, 0.06, false, MAT_METAL],
                [0.018, suspensionLen * 0.45, false, MAT_METAL],
                [0.038, suspensionLen * 0.50, false, MAT_METAL],
                [0.018, suspensionLen * 0.55, false, MAT_METAL],
                [0.018, suspensionLen - 0.08, false, MAT_METAL],
                [0.065, suspensionLen, true, MAT_TRIM],
            ],
        });
        addChamferedBox(mb, { cx: 0, cy: rodTop + 0.02, cz: 0, sx: 0.16, sy: 0.06, sz: 0.16, bevel: 0.015, matId: MAT_METAL });
    }

    // 2. 内部 16 面五段多阶明亮式切割宝石晶核 (Crown / Girdle / Pavilion)
    const sides = 16;
    const coreTop = [0, hBody * 0.78, 0];
    const coreBot = [0, -hBody * 0.78, 0];
    const rRings = [
        [radius * 0.34, hBody * 0.54, 0.85],
        [radius * 0.64, hBody * 0.26, 0.64],
        [radius * 0.78, 0.0, 0.48],
        [radius * 0.60, -hBody * 0.28, 0.28],
        [radius * 0.30, -hBody * 0.56, 0.12],
    ];
    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const s0 = i / sides;
        const s1 = (i + 1) / sides;
        const ringPt = (r, y, a) => [Math.cos(a) * r, y, Math.sin(a) * r];
        const t0 = ringPt(rRings[0][0], rRings[0][1], a0);
        const t1 = ringPt(rRings[0][0], rRings[0][1], a1);
        mb.addFlatTri(t1, t0, coreTop, s1, 0.85, s0, 0.85, (s0 + s1) * 0.5, 1.0, MAT_CRYSTAL);
        for (let band = 0; band < rRings.length - 1; band++) {
            const [rU, yU, vU] = rRings[band];
            const [rL, yL, vL] = rRings[band + 1];
            const u0 = ringPt(rU, yU, a0), u1 = ringPt(rU, yU, a1);
            const l0 = ringPt(rL, yL, a0), l1 = ringPt(rL, yL, a1);
            mb.addFlatQuad(l1, l0, u0, u1, s1, vL, s0, vU, MAT_CRYSTAL);
        }
        const b0 = ringPt(rRings[4][0], rRings[4][1], a0);
        const b1 = ringPt(rRings[4][0], rRings[4][1], a1);
        mb.addFlatTri(b0, b1, coreBot, s0, 0.12, s1, 0.12, (s0 + s1) * 0.5, 0.0, MAT_CRYSTAL);
    }

    // 3. 外部 8 根顺滑 13 段样条铜笼护肋 + 双道腰箍镶环
    const ribSec = [
        [-0.020, 0.020], [0.020, 0.020], [0.020, -0.020], [-0.020, -0.020],
    ];
    for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const ribPts = [];
        for (let i = 0; i <= 12; i++) {
            const tt = i / 12;
            const phi = (0.5 - tt) * Math.PI * 0.86;
            const rEnv = rCage * (0.64 + 0.54 * Math.cos(phi * 0.92));
            const yEnv = hBody * 0.90 * Math.sin(phi);
            ribPts.push([ca * rEnv, yEnv, sa * rEnv]);
        }
        addSweptProfile(mb, { points: ribPts, section: ribSec, matId: MAT_METAL });
    }

    // 上下双道精细笼腰镶圈
    for (const [gScale, gY] of [[1.15, hBody * 0.14], [1.13, -hBody * 0.14]]) {
        const girdlePts = [];
        for (let i = 0; i < 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            girdlePts.push([Math.cos(a) * rCage * gScale, gY, Math.sin(a) * rCage * gScale]);
        }
        addSweptProfile(mb, {
            points: girdlePts,
            section: [[-0.022, 0.032], [0.022, 0.032], [0.022, -0.032], [-0.022, -0.032]],
            closedPath: true,
            matId: MAT_METAL,
            planeNormal: [0, 1, 0],
        });
    }

    // 4. 底部车削莲座铜钵 + 长坠铜锥坠 (Plummet Finial)
    addLathe(mb, {
        cx: 0, cy: -hBody * 0.86, cz: 0,
        segs: 28,
        matId: MAT_METAL,
        profile: [
            [0.015, -halfH * 0.56, true, MAT_METAL],
            [rCage * 0.16, -halfH * 0.24, false, MAT_METAL],
            [rCage * 0.42, -0.08, false, MAT_TRIM],
            [rCage * 0.74, 0.04, true, MAT_METAL],
        ],
    });

    return mb.toBuffers();
}

/**
 * 构建紧贴玫瑰圆窗外缘的雕石封堵墙片，彻底消除圆形玫瑰窗四角与后殿侧壁间的背景空漏
 */
export function addRoseApertureSurround(mb, {
    cx = 0, cy = 5.5, cz = -14.2,
    innerRadius = 3.25,
    halfW = 4.2,
    halfBot = 3.5,
    halfTop = 4.0,
    thickness = 0.72,
    segs = 64,
    matId = MAT_STONE,
} = {}) {
    const zFront = cz + thickness * 0.5;
    const zBack = cz - thickness * 0.5;
    const evalOuter = (a) => {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const tx = Math.abs(dx) > 1e-4 ? halfW / Math.abs(dx) : 1e6;
        const ty = dy > 1e-4 ? halfTop / dy : (dy < -1e-4 ? halfBot / (-dy) : 1e6);
        const t = Math.max(innerRadius + 0.05, Math.min(tx, ty));
        return [cx + dx * t, cy + dy * t];
    };
    for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const [ix0, iy0] = [cx + Math.cos(a0) * innerRadius, cy + Math.sin(a0) * innerRadius];
        const [ix1, iy1] = [cx + Math.cos(a1) * innerRadius, cy + Math.sin(a1) * innerRadius];
        const [ox0, oy0] = evalOuter(a0);
        const [ox1, oy1] = evalOuter(a1);
        mb.addFlatQuad(
            [ix0, iy0, zFront], [ox0, oy0, zFront], [ox1, oy1, zFront], [ix1, iy1, zFront],
            ix0 * 0.25, iy0 * 0.25, ox1 * 0.25, oy1 * 0.25, matId,
        );
        mb.addFlatQuad(
            [ix0, iy0, zBack], [ix1, iy1, zBack], [ox1, oy1, zBack], [ox0, oy0, zBack],
            ix0 * 0.25, iy0 * 0.25, ox1 * 0.25, oy1 * 0.25, matId,
        );
    }
}

/**
 * 构建折光晶体棱阁的尖顶折纸人字钢木桁架（无圆弧教堂拱，锐利几何折叠肋梁 + 可选斜天窗）
 */
export function addFacetedChevronTruss(mb, {
    span = 9.8,
    baseY = 1.05,
    springY = 6.2,
    apexY = 10.65,
    z = 0,
    ribWidth = 0.32,
    ribDepth = 0.40,
    matId = MAT_TRIM,
    matAccent = MAT_METAL,
} = {}) {
    const hx = span * 0.5;
    const hw = ribWidth * 0.5;
    const hd = ribDepth * 0.5;
    const hexSec = [
        [-hw, hd * 0.65, false, matId],
        [0, hd * 1.1, true, matAccent],
        [hw, hd * 0.65, false, matId],
        [hw, -hd * 0.65, false, matId],
        [0, -hd * 1.1, true, matAccent],
        [-hw, -hd * 0.65, false, matId],
    ];
    // 主 V 形尖脊桁架
    const mainPts = [
        [-hx, baseY + 0.1, z],
        [-hx * 0.88, springY, z],
        [-hx * 0.46, springY + (apexY - springY) * 0.58, z],
        [0, apexY, z],
        [hx * 0.46, springY + (apexY - springY) * 0.58, z],
        [hx * 0.88, springY, z],
        [hx, baseY + 0.1, z],
    ];
    addSweptProfile(mb, {
        points: mainPts,
        section: hexSec,
        matId,
        planeNormal: [0, 0, 1],
        capEnds: true,
    });
    // 上方钻石交叉辅助斜撑
    const braceSec = [
        [-hw * 0.55, hd * 0.45, false, matAccent],
        [hw * 0.55, hd * 0.45, false, matAccent],
        [hw * 0.55, -hd * 0.45, false, matAccent],
        [-hw * 0.55, -hd * 0.45, false, matAccent],
    ];
    addSweptProfile(mb, {
        points: [[-hx * 0.84, springY + 0.3, z], [0, apexY - 1.15, z], [hx * 0.84, springY + 0.3, z]],
        section: braceSec,
        matId: matAccent,
        planeNormal: [0, 0, 1],
        capEnds: true,
    });
}

/**
 * 构建菱形/八角折光水晶花窗曼陀罗（替换圆玫瑰窗：纯折角几何棱晶门龛 + 放射晶棱）
 */
export function addDiamondPrismWindow(mb, {
    cx = 0, cy = 5.4, cz = -14.1,
    rx = 3.1, ry = 4.1,
    thickness = 0.52,
    frameMat = MAT_TRIM,
    accentMat = MAT_METAL,
} = {}) {
    // 双层菱形透光玻璃面
    const pts = [
        [cx, cy + ry, cz],
        [cx + rx, cy, cz],
        [cx, cy - ry, cz],
        [cx - rx, cy, cz],
    ];
    const cenF = [cx, cy, cz + 0.03];
    const cenB = [cx, cy, cz - 0.03];
    for (let i = 0; i < 4; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % 4];
        mb.addFlatTri(cenF, b, a, 0.5, 0.5, 1, 0, 0, 1, MAT_GLASS);
        mb.addFlatTri(cenB, a, b, 0.5, 0.5, 0, 1, 1, 0, MAT_GLASS);
    }

    // 菱形阶梯雕石框边 + 内部 45° 同心钻石棱框
    const frameSec = [
        [-0.22, thickness * 0.52, false, frameMat],
        [0.0, thickness * 0.62, true, accentMat],
        [0.24, thickness * 0.44, false, frameMat],
        [0.24, -thickness * 0.44, false, frameMat],
        [0.0, -thickness * 0.62, true, accentMat],
        [-0.22, -thickness * 0.52, false, frameMat],
    ];
    addSweptProfile(mb, { points: pts, section: frameSec, closedPath: true, matId: frameMat, planeNormal: [0, 0, 1] });
    const innerPts = pts.map(([px, py, pz]) => [cx + (px - cx) * 0.56, cy + (py - cy) * 0.56, pz]);
    addSweptProfile(mb, {
        points: innerPts,
        section: [[-0.08, 0.14], [0.08, 0.14], [0.08, -0.14], [-0.08, -0.14]],
        closedPath: true,
        matId: accentMat,
        planeNormal: [0, 0, 1],
    });
    // 八向放射折光棱筋
    const strutSec = [[-0.045, 0.11], [0.045, 0.11], [0.045, -0.11], [-0.045, -0.11]];
    for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const sDenom = Math.max(1e-3, Math.abs(ca) / rx + Math.abs(sa) / ry);
        const edgeDist = 1 / sDenom;
        addSweptProfile(mb, {
            points: [
                [cx + ca * 0.35, cy + sa * 0.35, cz],
                [cx + ca * edgeDist, cy + sa * edgeDist, cz],
            ],
            section: strutSec,
            matId: accentMat,
            planeNormal: [0, 0, 1],
            capEnds: true,
        });
    }
}

/**
 * 构建日式禅院圆形「圆窗 / Marumado」组子木格障子窗
 */
export function addCircularMoonAperture(mb, {
    cx = 0, cy = 4.8, cz = -14.1,
    radius = 2.05,
    thickness = 0.44,
    segs = 48,
} = {}) {
    // 圆形琉璃和纸透光屏（双向）
    for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius, cz];
        const p1 = [cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, cz];
        const cF = [cx, cy, cz + 0.025];
        const cB = [cx, cy, cz - 0.025];
        mb.addFlatTri(cF, p0, p1, 0.5, 0.5, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0), 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1), MAT_GLASS);
        mb.addFlatTri(cB, p1, p0, 0.5, 0.5, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1), 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0), MAT_GLASS);
    }
    const ringPts = [];
    for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ringPts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, cz]);
    }
    addSweptProfile(mb, {
        points: ringPts,
        section: [
            [-0.14, thickness * 0.48], [0.16, thickness * 0.48],
            [0.16, -thickness * 0.48], [-0.14, -thickness * 0.48],
        ],
        closedPath: true,
        matId: MAT_TRIM,
        planeNormal: [0, 0, 1],
    });
    // 正交组子细木格条 (Shoji Bars)
    for (const frac of [-0.52, 0.0, 0.52]) {
        const off = frac * radius;
        const halfLen = Math.sqrt(Math.max(0.05, radius * radius - off * off));
        addChamferedBox(mb, { cx, cy: cy + off, cz, sx: halfLen * 2, sy: 0.065, sz: 0.14, bevel: 0.01, matId: MAT_TRIM });
        addChamferedBox(mb, { cx: cx + off, cy, cz, sx: 0.065, sy: halfLen * 2, sz: 0.14, bevel: 0.01, matId: MAT_TRIM });
    }
}

/**
 * 构建威尼斯/摩尔式反曲尖瓣拱 (Venetian Ogee Arch + 穿透三叶饰孔拱肩)
 */
export function addVenetianOgeeArchBay(mb, {
    span = 9.6,
    springY = 5.9,
    apexY = 9.75,
    z = 0,
    ribWidth = 0.34,
    ribDepth = 0.42,
    matId = MAT_TRIM,
    accentMat = MAT_METAL,
} = {}) {
    const hx = span * 0.5;
    const rise = apexY - springY;
    const steps = 26;
    const ogeeCurve = (t) => {
        // t in [0, 1]: 平缓圆起拱 -> S 型反曲上扬至优雅焰尖顶
        const x = hx * (1 - t);
        const y = t < 0.55
            ? springY + rise * 0.62 * Math.sin((t / 0.55) * Math.PI * 0.5)
            : springY + rise * (0.62 + 0.38 * Math.pow((t - 0.55) / 0.45, 0.72));
        return [x, y];
    };
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const [x, y] = ogeeCurve(i / steps);
        pts.push([-x, y, z]);
    }
    for (let i = steps - 1; i >= 0; i--) {
        const [x, y] = ogeeCurve(i / steps);
        pts.push([x, y, z]);
    }
    const hw = ribWidth * 0.5;
    const hd = ribDepth * 0.5;
    addSweptProfile(mb, {
        points: pts,
        section: [
            [-hw * 0.85, hd, false, matId],
            [0, hd * 1.15, true, MAT_STONE],
            [hw * 0.85, hd, false, matId],
            [hw * 0.85, -hd, false, matId],
            [0, -hd * 1.15, true, MAT_STONE],
            [-hw * 0.85, -hd, false, matId],
        ],
        matId,
        planeNormal: [0, 0, 1],
        capEnds: true,
    });
    // 两翼拱肩镂空四叶饰圆窗环 + 顶花铜徽
    for (const side of [-1, 1]) {
        const rPts = [];
        for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            rPts.push([side * hx * 0.66 + Math.cos(a) * 0.56, springY + rise * 0.64 + Math.sin(a) * 0.56, z]);
        }
        addSweptProfile(mb, {
            points: rPts,
            section: [[-0.065, 0.14], [0.065, 0.14], [0.065, -0.14], [-0.065, -0.14]],
            closedPath: true,
            matId: accentMat,
            planeNormal: [0, 0, 1],
        });
    }
    addLathe(mb, {
        cx: 0, cy: apexY - 0.12, cz: z,
        segs: 16,
        matId: accentMat,
        profile: [
            [0.02, -0.34, true, accentMat],
            [0.14, -0.18, false, accentMat],
            [0.24, 0.08, false, matId],
            [0.08, 0.36, true, accentMat],
        ],
    });
}

/**
 * 构建植物温室弧展棕榈蕨类雕铜叶簇 (Strictly |x| >= 3.35 置于侧翼花坛上)
 */
export function addBotanicalPalmFrondCluster(mb, {
    x = -4.35,
    baseY = 0.62,
    z = -7.0,
    scale = 1.0,
    inwardSign = 1,
} = {}) {
    // 雕石双层温室大花盆座
    addLathe(mb, {
        cx: x, cy: baseY, cz: z,
        segs: 20,
        matId: MAT_TRIM,
        profile: [
            [0.44 * scale, 0.0, true, MAT_STONE],
            [0.36 * scale, 0.22 * scale, false, MAT_TRIM],
            [0.52 * scale, 0.50 * scale, true, MAT_TRIM],
            [0.48 * scale, 0.56 * scale, true, MAT_STONE],
            [0.24 * scale, 0.60 * scale, true, MAT_STONE],
        ],
    });
    // 两层放射扇展连续流线弧形棕榈叶束 (Sculpted Art-Nouveau swept ribbon fronds, |x| >= 3.45)
    const tiers = [
        { count: 5, reach: 0.72 * scale, height: 2.45 * scale, ribMat: MAT_METAL, w: 0.082 * scale },
        { count: 6, reach: 0.92 * scale, height: 1.65 * scale, ribMat: MAT_TRIM, w: 0.095 * scale },
    ];
    for (let tIdx = 0; tIdx < tiers.length; tIdx++) {
        const tier = tiers[tIdx];
        const bladeSec = [
            [-tier.w, 0.012 * scale, false, tier.ribMat],
            [0, 0.030 * scale, true, MAT_METAL],
            [tier.w, 0.012 * scale, false, tier.ribMat],
            [0, -0.018 * scale, true, tier.ribMat],
        ];
        for (let k = 0; k < tier.count; k++) {
            const azimuth = (k / tier.count) * Math.PI * 2 + tIdx * 0.52;
            const dirX = Math.cos(azimuth) * 0.55 + inwardSign * 0.30;
            const dirZ = Math.sin(azimuth) * 0.92;
            const pts = [];
            for (let i = 0; i <= 10; i++) {
                const tt = i / 10;
                const spread = Math.pow(tt, 1.35) * tier.reach;
                const arcY = Math.sin(tt * Math.PI * 0.62) * (tier.height - 0.35 * scale)
                    - tt * tt * tt * 0.28 * scale;
                pts.push([
                    x + dirX * spread,
                    baseY + 0.52 * scale + arcY,
                    z + dirZ * spread,
                ]);
            }
            addSweptProfile(mb, { points: pts, section: bladeSec, matId: tier.ribMat, capEnds: true });
        }
    }
}

/**
 * 构建观象台双叉赤道仪望远镜底座（八角台座 + 黄铜极轴叉臂 + 渐缩黄铜折射镜筒与玻璃物镜）
 */
export function addTelescopePedestal(mb, { x = -4.25, baseY = 0.14, z = -6.2, aimInwardSign = 1 } = {}) {
    addLathe(mb, {
        cx: x, cy: baseY, cz: z,
        segs: 8,
        matId: MAT_STONE,
        profile: [
            [0.52, 0.0, true, MAT_STONE],
            [0.44, 0.22, true, MAT_TRIM],
            [0.32, 0.88, false, MAT_STONE],
            [0.40, 1.02, true, MAT_TRIM],
            [0.14, 1.18, true, MAT_METAL],
        ],
    });
    // 镜筒倾角朝上且略向中轴观测天空
    addLathe(mb, {
        cx: x + aimInwardSign * 0.14,
        cy: baseY + 1.48,
        cz: z - 0.18,
        rx: 0.72,
        rz: aimInwardSign * -0.18,
        segs: 18,
        matId: MAT_METAL,
        profile: [
            [0.055, -0.75, true, MAT_METAL],
            [0.085, -0.25, false, MAT_METAL],
            [0.125, 0.45, false, MAT_TRIM],
            [0.145, 0.92, true, MAT_METAL],
            [0.115, 0.96, true, MAT_GLASS],
        ],
    });
}

/**
 * 构建万神圆厅三足青铜圣火鼎 (Classical Tripod Brazier)
 */
export function addPantheonTripodBrazier(mb, { x = -3.85, baseY = 0.24, z = -6.0 } = {}) {
    addLathe(mb, {
        cx: x, cy: baseY, cz: z,
        segs: 24,
        matId: MAT_STONE,
        profile: [
            [0.46, 0.0, true, MAT_STONE],
            [0.38, 0.20, true, MAT_TRIM],
            [0.32, 0.28, true, MAT_TRIM],
        ],
    });
    const legSec = [[-0.032, 0.032], [0.032, 0.032], [0.032, -0.032], [-0.032, -0.032]];
    for (let k = 0; k < 3; k++) {
        const ang = (k / 3) * Math.PI * 2 + 0.35;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        addSweptProfile(mb, {
            points: [
                [x + ca * 0.26, baseY + 0.28, z + sa * 0.26],
                [x + ca * 0.18, baseY + 0.85, z + sa * 0.18],
                [x + ca * 0.28, baseY + 1.42, z + sa * 0.28],
            ],
            section: legSec,
            matId: MAT_METAL,
            capEnds: true,
        });
    }
    addLathe(mb, {
        cx: x, cy: baseY + 1.38, cz: z,
        segs: 24,
        matId: MAT_METAL,
        profile: [
            [0.12, 0.0, true, MAT_METAL],
            [0.38, 0.14, false, MAT_METAL],
            [0.44, 0.26, true, MAT_TRIM],
            [0.24, 0.32, true, MAT_CRYSTAL],
            [0.02, 0.48, true, MAT_CRYSTAL],
        ],
    });
}

/**
 * 构建秘阁穹廊中央雕刻读经 lectern 讲坛（展开羊皮纸手抄古卷 + 发光墨韵晶饰）
 */
export function addLecternFolioStand(mb, { cx = 0, y = 0.22, cz = -11.4 } = {}) {
    addLathe(mb, {
        cx, cy: y, cz,
        segs: 12,
        matId: MAT_TRIM,
        profile: [
            [0.65, 0.0, true, MAT_STONE],
            [0.52, 0.14, true, MAT_TRIM],
            [0.22, 0.30, false, MAT_TRIM],
            [0.16, 0.96, true, MAT_TRIM],
            [0.36, 1.12, true, MAT_METAL],
        ],
    });
    // 左右微倾展开古卷页书页
    addChamferedBox(mb, { cx: cx - 0.30, cy: y + 1.24, cz, sx: 0.58, sy: 0.07, sz: 0.78, bevel: 0.015, rx: 0.38, rz: -0.22, matId: MAT_TRIM, matBevelId: MAT_METAL });
    addChamferedBox(mb, { cx: cx + 0.30, cy: y + 1.24, cz, sx: 0.58, sy: 0.07, sz: 0.78, bevel: 0.015, rx: 0.38, rz: 0.22, matId: MAT_TRIM, matBevelId: MAT_METAL });
    addChamferedBox(mb, { cx, cy: y + 1.22, cz: cz + 0.04, sx: 0.18, sy: 0.08, sz: 0.68, bevel: 0.01, rx: 0.38, matId: MAT_CRYSTAL });
}

/**
 * 构建禅意水院正交「行灯 / 风铃」(Zen Square Andon & Wind Chime, 非欧式灯笼！)
 */
export function buildZenShojiWindChimeMesh(halfW = 0.25, height = 0.92, suspensionLen = 0.42) {
    const mb = new MeshBuilder();
    const yHalf = height * 0.48;
    // 日式方形歇山铜帽与悬杆
    addChamferedBox(mb, { cx: 0, cy: yHalf + 0.07, cz: 0, sx: halfW * 2.55, sy: 0.07, sz: halfW * 2.55, bevel: 0.018, matId: MAT_TRIM, matBevelId: MAT_METAL });
    addChamferedBox(mb, { cx: 0, cy: yHalf + 0.14, cz: 0, sx: halfW * 1.45, sy: 0.08, sz: halfW * 1.45, bevel: 0.015, matId: MAT_METAL });
    if (suspensionLen > 0.05) {
        addLathe(mb, {
            cx: 0, cy: yHalf + 0.18, cz: 0,
            segs: 10,
            matId: MAT_METAL,
            profile: [
                [0.03, 0.0, true, MAT_METAL],
                [0.016, suspensionLen, true, MAT_METAL],
                [0.05, suspensionLen + 0.02, true, MAT_TRIM],
            ],
        });
    }
    // 内部柔和方柱透光和纸灯芯 + 外部四角垂直 Cedar 木框架 + 中腰正交横栅
    addChamferedBox(mb, { cx: 0, cy: 0, cz: 0, sx: halfW * 1.35, sy: yHalf * 1.55, sz: halfW * 1.35, bevel: 0.02, matId: MAT_CRYSTAL });
    for (const sx of [-halfW * 0.92, halfW * 0.92]) {
        for (const sz of [-halfW * 0.92, halfW * 0.92]) {
            addChamferedBox(mb, { cx: sx, cy: 0, cz: sz, sx: 0.045, sy: yHalf * 1.85, sz: 0.045, bevel: 0.008, matId: MAT_TRIM });
        }
    }
    for (const yBar of [-yHalf * 0.45, 0, yHalf * 0.45]) {
        addChamferedBox(mb, { cx: 0, cy: yBar, cz: halfW * 0.92, sx: halfW * 1.9, sy: 0.035, sz: 0.035, bevel: 0.005, matId: MAT_TRIM });
        addChamferedBox(mb, { cx: 0, cy: yBar, cz: -halfW * 0.92, sx: halfW * 1.9, sy: 0.035, sz: 0.035, bevel: 0.005, matId: MAT_TRIM });
        addChamferedBox(mb, { cx: halfW * 0.92, cy: yBar, cz: 0, sx: 0.035, sy: 0.035, sz: halfW * 1.9, bevel: 0.005, matId: MAT_TRIM });
        addChamferedBox(mb, { cx: -halfW * 0.92, cy: yBar, cz: 0, sx: 0.035, sy: 0.035, sz: halfW * 1.9, bevel: 0.005, matId: MAT_TRIM });
    }
    // 底部铜托底座 + 垂直风铃短册纸片 (Tanzaku plate)
    addChamferedBox(mb, { cx: 0, cy: -yHalf * 0.92, cz: 0, sx: halfW * 2.15, sy: 0.06, sz: halfW * 2.15, bevel: 0.015, matId: MAT_METAL });
    addChamferedBox(mb, { cx: 0, cy: -yHalf - 0.24, cz: 0, sx: 0.09, sy: 0.36, sz: 0.02, bevel: 0.004, matId: MAT_METAL });
    return mb.toBuffers();
}

/**
 * 构建折光晶体棱阁的八面多棱浮空棱晶体 (Faceted Octahedral Shard Array)
 */
export function buildFacetedCrystalPrismMesh(radius = 0.36, halfH = 1.05, suspensionLen = 0.42) {
    const mb = new MeshBuilder();
    const top = [0, halfH * 0.82, 0];
    const bot = [0, -halfH * 0.88, 0];
    const beltY = halfH * 0.08;
    const sides = 6;
    for (let i = 0; i < sides; i++) {
        const a0 = (i / sides) * Math.PI * 2;
        const a1 = ((i + 1) / sides) * Math.PI * 2;
        const p0 = [Math.cos(a0) * radius * 0.78, beltY, Math.sin(a0) * radius * 0.78];
        const p1 = [Math.cos(a1) * radius * 0.78, beltY, Math.sin(a1) * radius * 0.78];
        mb.addFlatTri(p1, p0, top, (i + 1) / sides, 0.5, i / sides, 0.5, (i + 0.5) / sides, 1.0, MAT_CRYSTAL);
        mb.addFlatTri(p0, p1, bot, i / sides, 0.5, (i + 1) / sides, 0.5, (i + 0.5) / sides, 0.0, MAT_CRYSTAL);
    }
    // 倾斜菱形铜轨外环
    const hoopPts = [];
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        hoopPts.push([Math.cos(a) * radius * 1.18, Math.sin(a) * halfH * 0.72, Math.sin(a) * radius * 0.42]);
    }
    addSweptProfile(mb, {
        points: hoopPts,
        section: [[-0.028, 0.04], [0.028, 0.04], [0.028, -0.04], [-0.028, -0.04]],
        closedPath: true,
        matId: MAT_METAL,
    });
    if (suspensionLen > 0.05) {
        addLathe(mb, {
            cx: 0, cy: halfH * 0.80, cz: 0,
            segs: 8,
            matId: MAT_METAL,
            profile: [
                [0.03, 0.0, true, MAT_METAL],
                [0.016, suspensionLen, true, MAT_METAL],
            ],
        });
    }
    return mb.toBuffers();
}

/**
 * 构建威尼斯港湾六角立柱航灯 (Venetian Hexagonal Harbor Post Lamp, 坐于水面系泊木桩顶部)
 */
export function buildVenetianHexLanternMesh(radius = 0.28, height = 0.88) {
    const mb = new MeshBuilder();
    const hBody = height * 0.55;
    // 底座托杯 -> 六棱上宽下窄透明船灯罩 -> 葱头尖塔铜顶
    addLathe(mb, {
        cx: 0, cy: -0.10, cz: 0,
        segs: 6,
        matId: MAT_METAL,
        profile: [
            [radius * 0.38, -0.14, true, MAT_METAL],
            [radius * 0.56, 0.02, true, MAT_TRIM],
            [radius * 0.62, 0.08, true, MAT_METAL],
        ],
    });
    addLathe(mb, {
        cx: 0, cy: 0.0, cz: 0,
        segs: 6,
        matId: MAT_CRYSTAL,
        profile: [
            [radius * 0.52, 0.02, true, MAT_CRYSTAL],
            [radius * 0.86, hBody * 0.82, false, MAT_CRYSTAL],
            [radius * 0.72, hBody, true, MAT_CRYSTAL],
        ],
    });
    for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        addSweptProfile(mb, {
            points: [
                [Math.cos(a) * radius * 0.58, 0.02, Math.sin(a) * radius * 0.58],
                [Math.cos(a) * radius * 0.90, hBody, Math.sin(a) * radius * 0.90],
            ],
            section: [[-0.016, 0.016], [0.016, 0.016], [0.016, -0.016], [-0.016, -0.016]],
            matId: MAT_METAL,
            capEnds: true,
        });
    }
    addLathe(mb, {
        cx: 0, cy: hBody, cz: 0,
        segs: 6,
        matId: MAT_METAL,
        profile: [
            [radius * 1.05, 0.0, true, MAT_METAL],
            [radius * 0.68, 0.14, false, MAT_METAL],
            [radius * 0.24, 0.28, false, MAT_TRIM],
            [0.02, 0.48, true, MAT_METAL],
        ],
    });
    return mb.toBuffers();
}

/**
 * 构建曦光植物晶庭三环交错球形露珠生态玻璃仪 (Botanical Armillary Terrarium Orb)
 */
export function buildBotanicalDewOrbMesh(radius = 0.34, suspensionLen = 0.45) {
    const mb = new MeshBuilder();
    const ring = buildOrnateGimbalRing({ radius, width: 0.026, thick: 0.042, segments: 48, matId: MAT_METAL });
    const appendRot = (rx, rz) => {
        const base = mb.positions.length / 3;
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        for (let i = 0; i < ring.vertexCount; i++) {
            const px = ring.positions[i * 3], py = ring.positions[i * 3 + 1], pz = ring.positions[i * 3 + 2];
            const nx = ring.normals[i * 3], ny = ring.normals[i * 3 + 1], nz = ring.normals[i * 3 + 2];
            const y1 = py * cx - pz * sx, z1 = py * sx + pz * cx;
            const ny1 = ny * cx - nz * sx, nz1 = ny * sx + nz * cx;
            mb.addVertex(
                px * cz - y1 * sz, px * sz + y1 * cz, z1,
                nx * cz - ny1 * sz, nx * sz + ny1 * cz, nz1,
                ring.uvs[i * 2], ring.uvs[i * 2 + 1], ring.matIds[i],
            );
        }
        for (let i = 0; i < ring.indices.length; i++) mb.indices.push(base + ring.indices[i]);
    };
    appendRot(0, 0);
    appendRot(Math.PI * 0.5, 0.45);
    appendRot(0.35, Math.PI * 0.5);
    // 中心垂泪晶核
    addLathe(mb, {
        cx: 0, cy: -radius * 0.48, cz: 0,
        segs: 12,
        matId: MAT_CRYSTAL,
        profile: [
            [0.015, 0.0, true, MAT_CRYSTAL],
            [radius * 0.44, radius * 0.32, false, MAT_CRYSTAL],
            [radius * 0.28, radius * 0.72, false, MAT_CRYSTAL],
            [0.02, radius * 0.98, true, MAT_CRYSTAL],
        ],
    });
    if (suspensionLen > 0.05) {
        addLathe(mb, {
            cx: 0, cy: radius + 0.02, cz: 0,
            segs: 10,
            matId: MAT_METAL,
            profile: [
                [0.032, 0.0, true, MAT_METAL],
                [0.016, suspensionLen, true, MAT_METAL],
            ],
        });
    }
    return mb.toBuffers();
}


