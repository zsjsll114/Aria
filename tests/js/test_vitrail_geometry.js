/* ============================================================
 * tests/js/test_vitrail_geometry.js — 3D 参数化网格、法线外向性与线性 EDT-SDF 单测
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MeshBuilder,
    MAT_STONE,
    MAT_METAL,
    MAT_GLASS,
    addChamferedBox,
    buildGimbalRingMesh,
    composeVitrailArchitecture,
    mat4Identity,
    mat4ModelTransform,
    mat4Perspective,
    mat4LookAt,
    mat4Multiply,
} from '../../web/src/core/visualizers/vitrail/vitrailGeometry.js';
import { VITRAIL_ARCHETYPES } from '../../web/src/core/visualizers/vitrail/vitrailProfiles.js';
import { computeSdfFromAlpha } from '../../web/src/core/visualizers/vitrail/vitrailAtlas.js';

function assertValidMesh(buf, label) {
    assert.ok(buf.vertexCount > 0, `${label} 顶点数应大于 0`);
    assert.ok(buf.triangleCount > 0, `${label} 三角面数应大于 0`);
    assert.equal(buf.positions.length, buf.vertexCount * 3);
    assert.equal(buf.normals.length, buf.vertexCount * 3);
    assert.equal(buf.uvs.length, buf.vertexCount * 2);
    assert.equal(buf.matIds.length, buf.vertexCount);
    assert.equal(buf.indices.length, buf.triangleCount * 3);

    for (let i = 0; i < buf.vertexCount; i++) {
        const px = buf.positions[i * 3];
        const py = buf.positions[i * 3 + 1];
        const pz = buf.positions[i * 3 + 2];
        assert.ok(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz), `${label} 含非有限顶点坐标`);

        const nx = buf.normals[i * 3];
        const ny = buf.normals[i * 3 + 1];
        const nz = buf.normals[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        assert.ok(Math.abs(len - 1) < 1e-3, `${label} 顶点法线未归一化: ${len}`);
    }

    for (let t = 0; t < buf.triangleCount; t++) {
        const a = buf.indices[t * 3];
        const b = buf.indices[t * 3 + 1];
        const c = buf.indices[t * 3 + 2];
        assert.ok(a < buf.vertexCount && b < buf.vertexCount && c < buf.vertexCount, `${label} 索引越界`);
        const ax = buf.positions[a * 3], ay = buf.positions[a * 3 + 1], az = buf.positions[a * 3 + 2];
        const bx = buf.positions[b * 3], by = buf.positions[b * 3 + 1], bz = buf.positions[b * 3 + 2];
        const cx = buf.positions[c * 3], cy = buf.positions[c * 3 + 1], cz = buf.positions[c * 3 + 2];
        const ex = bx - ax, ey = by - ay, ez = bz - az;
        const fx = cx - ax, fy = cy - ay, fz = cz - az;
        const area2 = Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
        assert.ok(area2 > 1e-6, `${label} 含退化零面积三角形 #${t}`);
    }
}

test('VG1 addChamferedBox 生成 26 面斜角立体且所有三角面法线严格朝外', () => {
    const mb = new MeshBuilder();
    addChamferedBox(mb, {
        cx: 1.5, cy: 2.0, cz: -3.0,
        sx: 2.4, sy: 1.6, sz: 1.8,
        bevel: 0.14,
        matId: MAT_STONE,
        matBevelId: MAT_METAL,
    });
    const buf = mb.toBuffers();
    assertValidMesh(buf, 'chamferedBox');
    assert.ok(buf.triangleCount >= 40, `26 面倒角盒至少应有 40+ 三角面，实际 ${buf.triangleCount}`);

    let hasMetal = false;
    let hasStone = false;
    for (let i = 0; i < buf.vertexCount; i++) {
        if (buf.matIds[i] === MAT_METAL) hasMetal = true;
        if (buf.matIds[i] === MAT_STONE) hasStone = true;
    }
    assert.ok(hasStone && hasMetal, '主面应为石材，倒角斜边应为金属材质');

    for (let t = 0; t < buf.triangleCount; t++) {
        const a = buf.indices[t * 3];
        const b = buf.indices[t * 3 + 1];
        const c = buf.indices[t * 3 + 2];
        const mx = (buf.positions[a * 3] + buf.positions[b * 3] + buf.positions[c * 3]) / 3 - 1.5;
        const my = (buf.positions[a * 3 + 1] + buf.positions[b * 3 + 1] + buf.positions[c * 3 + 1]) / 3 - 2.0;
        const mz = (buf.positions[a * 3 + 2] + buf.positions[b * 3 + 2] + buf.positions[c * 3 + 2]) / 3 - (-3.0);
        const nx = buf.normals[a * 3];
        const ny = buf.normals[a * 3 + 1];
        const nz = buf.normals[a * 3 + 2];
        const dot = mx * nx + my * ny + mz * nz;
        assert.ok(dot > 0, `倒角盒三角面 #${t} 法线应朝外，dot=${dot}`);
    }
});

test('VG2 浑天仪双材质金属星环闭合拓扑正确', () => {
    const ring = buildGimbalRingMesh({ radius: 3.4, width: 0.12, thick: 0.22, segments: 40 });
    assertValidMesh(ring, 'gimbalRing');
    assert.ok(ring.triangleCount >= 320, `预期高细分星环网格，实际三角面 ${ring.triangleCount}`);
});

test('VG3 全部 8 种建筑空间原型拓扑有效且中央歌词阅读走廊零遮挡', () => {
    assert.equal(VITRAIL_ARCHETYPES.length, 8);
    for (const arch of VITRAIL_ARCHETYPES) {
        const scene = composeVitrailArchitecture(arch);
        assert.equal(scene.archetype, arch);
        assertValidMesh(scene.staticMesh, `${arch}.staticMesh`);
        assertValidMesh(scene.waterMesh, `${arch}.waterMesh`);
        assertValidMesh(scene.shaftMesh, `${arch}.shaftMesh`);
        assert.ok(scene.dynamicParts.length >= 1, `${arch} 应包含动态建筑机械组件`);
        for (const dp of scene.dynamicParts) {
            assertValidMesh(dp.mesh, `${arch}.${dp.id}`);
        }

        // 检查材质多样化：石材 + 金属 + 彩色琉璃窗缺一不可，且金属仅作精工点缀而不抢成粗糙霓虹线框
        const matSet = new Set();
        let metalVerts = 0;
        for (let i = 0; i < scene.staticMesh.vertexCount; i++) {
            const m = scene.staticMesh.matIds[i];
            matSet.add(m);
            if (m === MAT_METAL) metalVerts++;
        }
        assert.ok(matSet.has(MAT_STONE) && matSet.has(MAT_METAL) && matSet.has(MAT_GLASS),
            `${arch} 需同时包含石材、金属嵌边与彩色琉璃窗`);
        assert.ok(scene.staticMesh.triangleCount >= 2000,
            `${arch} 精细建模应具有丰富建筑面片细节 (>=2000 tris)，实际 ${scene.staticMesh.triangleCount}`);
        if (arch !== 'atrium') {
            const metalRatio = metalVerts / scene.staticMesh.vertexCount;
            assert.ok(metalRatio < 0.35, `${arch} 石作建筑金属比例应保持点缀尺度 (<35%)，实际 ${(metalRatio * 100).toFixed(1)}%`);
        }

        // 检查中央阅读视廊 (|x| < 3.0, y in [1.2, 3.8], z in [-5.0, 2.2]) 无建筑面片侵入遮挡
        const pos = scene.staticMesh.positions;
        const idx = scene.staticMesh.indices;
        for (let t = 0; t < scene.staticMesh.triangleCount; t++) {
            const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
            const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
            const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
            const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
            const blocksCorridor = Math.abs(cx) < 3.0 && cy > 1.2 && cy < 3.8 && cz > -5.0 && cz < 2.2;
            assert.equal(blocksCorridor, false,
                `${arch} 三角面 #${t} 质心 (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)}) 闯入中央阅读视野`);
        }
    }
});

test('VG4 线性时间 2D EDT 生成精确有符号距离场与外向倒角 XY 梯度法线', () => {
    const w = 64, h = 64, cx = 32, cy = 32, r = 14;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (Math.hypot(x - cx, y - cy) <= r) {
                alpha[y * w + x] = 255;
            }
        }
    }
    const rgba = computeSdfFromAlpha(alpha, w, h, 12);
    assert.equal(rgba.length, w * h * 4);

    // 圆心处为内部最高值 (> 128)
    const centerIdx = (cy * w + cx) * 4;
    assert.ok(rgba[centerIdx] > 200, `实心内部 SDF 应远大于 128，实际 ${rgba[centerIdx]}`);

    // 圆边界处接近 128，且倒角 XY 梯度法线应朝圆外 (右边缘 +x, 下边缘 +y)
    const rightEdgeIdx = (cy * w + (cx + r)) * 4;
    assert.ok(Math.abs(rgba[rightEdgeIdx] - 128) <= 22, `右边界 SDF 应贴近 128，实际 ${rgba[rightEdgeIdx]}`);
    const gxRight = rgba[rightEdgeIdx + 1] - 128;
    const gyRight = rgba[rightEdgeIdx + 2] - 128;
    assert.ok(gxRight > 20 && Math.abs(gyRight) < 30, `右边界倒角法线应指向右方 (+X)，实际 (${gxRight}, ${gyRight})`);

    const farOutIdx = (2 * w + 2) * 4;
    assert.ok(rgba[farOutIdx] < 40, `外部远点 SDF 应接近 0，实际 ${rgba[farOutIdx]}`);
});

test('VG5 列主序 4x4 视角/透视矩阵在相机前方点上给出有效 NDC 投影', () => {
    const p = mat4Perspective(46 * Math.PI / 180, 16 / 9, 0.1, 100);
    const v = mat4LookAt([0, 2.2, 4.6], [0, 2.2, -3.2], [0, 1, 0]);
    const vp = mat4Multiply(p, v);
    const id = mat4Identity();
    assert.equal(id[0], 1);
    // 世界点 (0, 2.2, -3.2) 在 view*proj 下应落到剪裁中心 x≈0, y≈0, w>0
    const wx = 0, wy = 2.2, wz = -3.2;
    const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
    const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    assert.ok(cw > 1 && Math.abs(cx / cw) < 1e-4 && Math.abs(cy / cw) < 1e-4);
});

test('VG6 动态建筑机件全旋转包络零穿墙/穿拱/撞地，且全原型具备高精细网格细分', () => {
    const archNeighbors = {
        cathedral: { archesZ: [-12.2, -8.2, -4.2, -0.2, 3.6], wallZ: -13.9, floorY: 0.72 },
        observatory: { archesZ: [-12.8, -7.0, -2.0, 3.0], wallZ: -13.9, floorY: 0.72 },
        cloister: { archesZ: [-12.6, -10.2, -7.8, -5.4, -3.0, -0.6, 1.8, 4.2], wallZ: -13.9, floorY: 0.22 },
        rotunda: { archesZ: [-2.2, 2.6], wallZ: -14.8, floorY: 0.72 },
        arcade: { archesZ: [-12.6, -9.4, -6.2, -3.0, 0.2, 3.4], wallZ: -13.9, floorY: 0.18 },
        scriptorium: { archesZ: [-12.4, -8.8, -5.2, -1.6, 2.0], wallZ: -13.9, floorY: 0.62 },
        atrium: { archesZ: [-12.2, -8.4, -4.6, -0.8, 3.0], wallZ: -13.9, floorY: 0.18 },
        pavilion: { archesZ: [-12.2, -8.6, -5.0, -1.4, 2.2], wallZ: -13.9, floorY: 0.85 },
    };

    for (const arch of VITRAIL_ARCHETYPES) {
        const scene = composeVitrailArchitecture(arch);
        const totalTris = scene.staticMesh.triangleCount
            + scene.waterMesh.triangleCount
            + scene.dynamicParts.reduce((acc, dp) => acc + dp.mesh.triangleCount, 0);
        assert.ok(totalTris >= 7000, `${arch} 精细建模总三角面应 >= 7000，实际 ${totalTris}`);

        const spec = archNeighbors[arch];
        for (const dp of scene.dynamicParts) {
            const pos = dp.mesh.positions;
            const [px, py, pz] = dp.pivot;
            const bob = dp.bobAmp || 0;
            const baseRot = dp.baseRot || [0, 0, 0];
            const spinRate = dp.spinRate || [0, 0, 0];
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;

            // 使用渲染器完全一致的 mat4ModelTransform 采样全周期 3D 变换包络
            for (const timeSec of [0, 7, 15, 29, 47, 67, 89, 113]) {
                for (const midPhase of [0, 0.25]) {
                    const yOff = bob ? Math.sin(timeSec * 0.9 + px) * bob * 1.4 : 0;
                    const rot = [
                        baseRot[0] + timeSec * spinRate[0] + (spinRate[0] !== 0 ? midPhase : 0),
                        baseRot[1] + timeSec * spinRate[1] + (spinRate[1] !== 0 ? midPhase : 0),
                        baseRot[2] + timeSec * spinRate[2] + (spinRate[2] !== 0 ? midPhase : 0),
                    ];
                    const m = mat4ModelTransform([px, py + yOff, pz], rot);
                    for (let i = 0; i < dp.mesh.vertexCount; i++) {
                        const vx = pos[i * 3];
                        const vy = pos[i * 3 + 1];
                        const vz = pos[i * 3 + 2];
                        const wx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
                        const wy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
                        const wz = m[2] * vx + m[6] * vy + m[10] * vz + m[14];
                        if (wx < minX) minX = wx;
                        if (wx > maxX) maxX = wx;
                        if (wy < minY) minY = wy;
                        if (wy > maxY) maxY = wy;
                        if (wz < minZ) minZ = wz;
                        if (wz > maxZ) maxZ = wz;
                    }
                }
            }

            assert.ok(minZ > spec.wallZ,
                `${arch}.${dp.id} 后缘 minZ=${minZ.toFixed(2)} 侵入后殿墙 ${spec.wallZ}`);
            assert.ok(minY > spec.floorY + 0.8,
                `${arch}.${dp.id} 底缘 minY=${minY.toFixed(2)} 过低接近地面台基`);

            // 中央歌词走廊无侵入检查 (|x| < 3.0 && y in [1.2, 3.8] && z in [-5.0, 2.2])
            if (maxX > -3.0 && minX < 3.0 && maxZ > -5.0 && minZ < 2.2) {
                assert.ok(minY >= 3.8,
                    `${arch}.${dp.id} 旋转/上下起伏包络下界 minY=${minY.toFixed(2)} 侵入中央阅读走廊`);
            }

            // 检查跨中大型旋转部件与横拱、柱廊（x = +-4.65）间距，避免穿模
            const halfSpanZ = (maxZ - minZ) * 0.5;
            if (Math.abs(px) < 1.0 && halfSpanZ >= 1.5) {
                for (const az of spec.archesZ) {
                    const overlapsZ = maxZ > (az - 0.16) && minZ < (az + 0.16);
                    assert.equal(overlapsZ, false,
                        `${arch}.${dp.id} ([${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]) 与 z=${az} 横拱发生穿透`);
                }
            }
        }
    }
});
