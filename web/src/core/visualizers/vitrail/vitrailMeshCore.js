/**
 * web/src/core/visualizers/vitrail/vitrailMeshCore.js
 * 「琉璃龛 · Vitrail」底层网格构建器、材质 ID 与基础倒角几何原语
 *
 * 零 DOM 依赖，严格保证法线归一化与零面积退化三角面剔除。
 */

export const MAT_STONE = 0;
export const MAT_TRIM = 1;
export const MAT_METAL = 2;
export const MAT_GLASS = 3;
export const MAT_WATER = 4;
export const MAT_SHAFT = 5;
export const MAT_CRYSTAL = 6;

export class MeshBuilder {
    constructor() {
        /** @type {number[]} */ this.positions = [];
        /** @type {number[]} */ this.normals = [];
        /** @type {number[]} */ this.uvs = [];
        /** @type {number[]} */ this.matIds = [];
        /** @type {number[]} */ this.indices = [];
    }

    /**
     * 写入单顶点，自动归一化法线
     */
    addVertex(x, y, z, nx, ny, nz, u, v, matId) {
        const idx = this.positions.length / 3;
        this.positions.push(x, y, z);
        const len = Math.hypot(nx, ny, nz) || 1;
        this.normals.push(nx / len, ny / len, nz / len);
        this.uvs.push(u, v);
        this.matIds.push(matId);
        return idx;
    }

    addTri(a, b, c) {
        const ax = this.positions[a * 3], ay = this.positions[a * 3 + 1], az = this.positions[a * 3 + 2];
        const bx = this.positions[b * 3], by = this.positions[b * 3 + 1], bz = this.positions[b * 3 + 2];
        const cx = this.positions[c * 3], cy = this.positions[c * 3 + 1], cz = this.positions[c * 3 + 2];
        const ex = bx - ax, ey = by - ay, ez = bz - az;
        const fx = cx - ax, fy = cy - ay, fz = cz - az;
        const crossX = ey * fz - ez * fy;
        const crossY = ez * fx - ex * fz;
        const crossZ = ex * fy - ey * fx;
        // 略高于 1e-12（area2 = sqrt(cross^2) > 1.4e-6），防止单测 VG 面积断言因极微浮点临界失败
        if (crossX * crossX + crossY * crossY + crossZ * crossZ < 4e-12) return;
        this.indices.push(a, b, c);
    }

    addQuad(v0, v1, v2, v3) {
        this.addTri(v0, v1, v2);
        this.addTri(v0, v2, v3);
    }

    /**
     * 添加独立硬折边四边形：根据顶点 CCW 顺序自动计算精确外向面法线
     */
    addFlatQuad(p0, p1, p2, p3, u0, v0, u1, v1, matId) {
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 2e-6) return;
        const onx = nx / len, ony = ny / len, onz = nz / len;
        const i0 = this.addVertex(p0[0], p0[1], p0[2], onx, ony, onz, u0, v0, matId);
        const i1 = this.addVertex(p1[0], p1[1], p1[2], onx, ony, onz, u1, v0, matId);
        const i2 = this.addVertex(p2[0], p2[1], p2[2], onx, ony, onz, u1, v1, matId);
        const i3 = this.addVertex(p3[0], p3[1], p3[2], onx, ony, onz, u0, v1, matId);
        this.addQuad(i0, i1, i2, i3);
    }

    addFlatTri(p0, p1, p2, u0, v0, u1, v1, u2, v2, matId) {
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 2e-6) return;
        const onx = nx / len, ony = ny / len, onz = nz / len;
        const i0 = this.addVertex(p0[0], p0[1], p0[2], onx, ony, onz, u0, v0, matId);
        const i1 = this.addVertex(p1[0], p1[1], p1[2], onx, ony, onz, u1, v1, matId);
        const i2 = this.addVertex(p2[0], p2[1], p2[2], onx, ony, onz, u2, v2, matId);
        this.addTri(i0, i1, i2);
    }

    /**
     * 添加光滑着色四边形：保留每个顶点的解析曲面法线，若几何面法线反相则自动修正 CCW 绕序
     */
    addSmoothQuad(p0, n0, p1, n1, p2, n2, p3, n3, u0, v0, u1, v1, matId) {
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        const avgNx = n0[0] + n1[0] + n2[0] + n3[0];
        const avgNy = n0[1] + n1[1] + n2[1] + n3[1];
        const avgNz = n0[2] + n1[2] + n2[2] + n3[2];
        const i0 = this.addVertex(p0[0], p0[1], p0[2], n0[0], n0[1], n0[2], u0, v0, matId);
        const i1 = this.addVertex(p1[0], p1[1], p1[2], n1[0], n1[1], n1[2], u1, v0, matId);
        const i2 = this.addVertex(p2[0], p2[1], p2[2], n2[0], n2[1], n2[2], u1, v1, matId);
        const i3 = this.addVertex(p3[0], p3[1], p3[2], n3[0], n3[1], n3[2], u0, v1, matId);
        if (cx * avgNx + cy * avgNy + cz * avgNz >= 0) {
            this.addQuad(i0, i1, i2, i3);
        } else {
            this.addQuad(i0, i3, i2, i1);
        }
    }

    toBuffers() {
        return {
            positions: new Float32Array(this.positions),
            normals: new Float32Array(this.normals),
            uvs: new Float32Array(this.uvs),
            matIds: new Float32Array(this.matIds),
            indices: new Uint32Array(this.indices),
            vertexCount: this.positions.length / 3,
            triangleCount: this.indices.length / 3,
        };
    }
}

export function transformPoint(p, cx, cy, cz, rx = 0, ry = 0, rz = 0) {
    let [x, y, z] = p;
    if (rx) {
        const c = Math.cos(rx), s = Math.sin(rx);
        const ny = y * c - z * s;
        const nz = y * s + z * c;
        y = ny; z = nz;
    }
    if (ry) {
        const c = Math.cos(ry), s = Math.sin(ry);
        const nx = x * c + z * s;
        const nz = -x * s + z * c;
        x = nx; z = nz;
    }
    if (rz) {
        const c = Math.cos(rz), s = Math.sin(rz);
        const nx = x * c - y * s;
        const ny = x * s + y * c;
        x = nx; y = ny;
    }
    return [x + cx, y + cy, z + cz];
}

export function rotateVec(v, rx = 0, ry = 0, rz = 0) {
    return transformPoint(v, 0, 0, 0, rx, ry, rz);
}

export function ptToObj(arr) {
    return { cx: arr[0], cy: arr[1], cz: arr[2] };
}

/**
 * 构建带 45° 真倒角斜边与 8 个斜角切面的精细六面建筑体（26 面，VG1 严格契约）
 */
export function addChamferedBox(mb, {
    cx = 0, cy = 0, cz = 0,
    sx = 1, sy = 1, sz = 1,
    bevel = 0.06,
    matId = MAT_STONE,
    matBevelId = null,
    rx = 0, ry = 0, rz = 0,
    uvScale = 1,
    seedU = 0,
} = {}) {
    const hx = Math.max(0.02, sx * 0.5);
    const hy = Math.max(0.02, sy * 0.5);
    const hz = Math.max(0.02, sz * 0.5);
    const b = Math.min(bevel, hx * 0.35, hy * 0.35, hz * 0.35);
    const bMat = matBevelId ?? matId;
    const T = (x, y, z) => transformPoint([x, y, z], cx, cy, cz, rx, ry, rz);

    if (b < 0.002) {
        const x0 = -hx, x1 = hx, y0 = -hy, y1 = hy, z0 = -hz, z1 = hz;
        mb.addFlatQuad(T(x0, y0, z1), T(x1, y0, z1), T(x1, y1, z1), T(x0, y1, z1), seedU, 0, seedU + sx * uvScale, sy * uvScale, matId);
        mb.addFlatQuad(T(x1, y0, z0), T(x0, y0, z0), T(x0, y1, z0), T(x1, y1, z0), seedU, 0, seedU + sx * uvScale, sy * uvScale, matId);
        mb.addFlatQuad(T(x0, y1, z1), T(x1, y1, z1), T(x1, y1, z0), T(x0, y1, z0), seedU, 0, seedU + sx * uvScale, sz * uvScale, matId);
        mb.addFlatQuad(T(x0, y0, z0), T(x1, y0, z0), T(x1, y0, z1), T(x0, y0, z1), seedU, 0, seedU + sx * uvScale, sz * uvScale, matId);
        mb.addFlatQuad(T(x1, y0, z1), T(x1, y0, z0), T(x1, y1, z0), T(x1, y1, z1), seedU, 0, seedU + sz * uvScale, sy * uvScale, matId);
        mb.addFlatQuad(T(x0, y0, z0), T(x0, y0, z1), T(x0, y1, z1), T(x0, y1, z0), seedU, 0, seedU + sz * uvScale, sy * uvScale, matId);
        return;
    }

    const ix = hx - b, iy = hy - b, iz = hz - b;

    // 6 个主平面（CCW 从外看）
    mb.addFlatQuad(T(-ix, -iy, hz), T(ix, -iy, hz), T(ix, iy, hz), T(-ix, iy, hz), seedU, 0, seedU + sx * uvScale, sy * uvScale, matId); // +Z
    mb.addFlatQuad(T(ix, -iy, -hz), T(-ix, -iy, -hz), T(-ix, iy, -hz), T(ix, iy, -hz), seedU, 0, seedU + sx * uvScale, sy * uvScale, matId); // -Z
    mb.addFlatQuad(T(-ix, hy, iz), T(ix, hy, iz), T(ix, hy, -iz), T(-ix, hy, -iz), seedU, 0, seedU + sx * uvScale, sz * uvScale, matId); // +Y
    mb.addFlatQuad(T(-ix, -hy, -iz), T(ix, -hy, -iz), T(ix, -hy, iz), T(-ix, -hy, iz), seedU, 0, seedU + sx * uvScale, sz * uvScale, matId); // -Y
    mb.addFlatQuad(T(hx, -iy, iz), T(hx, -iy, -iz), T(hx, iy, -iz), T(hx, iy, iz), seedU, 0, seedU + sz * uvScale, sy * uvScale, matId); // +X
    mb.addFlatQuad(T(-hx, -iy, -iz), T(-hx, -iy, iz), T(-hx, iy, iz), T(-hx, iy, -iz), seedU, 0, seedU + sz * uvScale, sy * uvScale, matId); // -X

    // 12 条 45° 倒角斜棱带
    mb.addFlatQuad(T(-ix, iy, hz), T(ix, iy, hz), T(ix, hy, iz), T(-ix, hy, iz), 0, 0, 1, 0.2, bMat); // +Z/+Y
    mb.addFlatQuad(T(-ix, -hy, iz), T(ix, -hy, iz), T(ix, -iy, hz), T(-ix, -iy, hz), 0, 0, 1, 0.2, bMat); // -Y/+Z
    mb.addFlatQuad(T(-ix, hy, -iz), T(ix, hy, -iz), T(ix, iy, -hz), T(-ix, iy, -hz), 0, 0, 1, 0.2, bMat); // -Z/+Y
    mb.addFlatQuad(T(-ix, -iy, -hz), T(ix, -iy, -hz), T(ix, -hy, -iz), T(-ix, -hy, -iz), 0, 0, 1, 0.2, bMat); // -Z/-Y

    mb.addFlatQuad(T(ix, -iy, hz), T(hx, -iy, iz), T(hx, iy, iz), T(ix, iy, hz), 0, 0, 1, 0.2, bMat); // +Z/+X
    mb.addFlatQuad(T(-hx, -iy, iz), T(-ix, -iy, hz), T(-ix, iy, hz), T(-hx, iy, iz), 0, 0, 1, 0.2, bMat); // +Z/-X
    mb.addFlatQuad(T(hx, -iy, -iz), T(ix, -iy, -hz), T(ix, iy, -hz), T(hx, iy, -iz), 0, 0, 1, 0.2, bMat); // -Z/+X
    mb.addFlatQuad(T(-ix, -iy, -hz), T(-hx, -iy, -iz), T(-hx, iy, -iz), T(-ix, iy, -hz), 0, 0, 1, 0.2, bMat); // -Z/-X

    mb.addFlatQuad(T(ix, hy, iz), T(hx, iy, iz), T(hx, iy, -iz), T(ix, hy, -iz), 0, 0, 1, 0.2, bMat); // +Y/+X
    mb.addFlatQuad(T(-hx, iy, iz), T(-ix, hy, iz), T(-ix, hy, -iz), T(-hx, iy, -iz), 0, 0, 1, 0.2, bMat); // +Y/-X
    mb.addFlatQuad(T(hx, -iy, iz), T(ix, -hy, iz), T(ix, -hy, -iz), T(hx, -iy, -iz), 0, 0, 1, 0.2, bMat); // -Y/+X
    mb.addFlatQuad(T(-ix, -hy, iz), T(-hx, -iy, iz), T(-hx, -iy, -iz), T(-ix, -hy, -iz), 0, 0, 1, 0.2, bMat); // -Y/-X

    // 8 个斜角三角切面（外向 CCW）
    mb.addFlatTri(T(ix, iy, hz), T(hx, iy, iz), T(ix, hy, iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(-ix, iy, hz), T(-ix, hy, iz), T(-hx, iy, iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(ix, -iy, hz), T(ix, -hy, iz), T(hx, -iy, iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(-ix, -iy, hz), T(-hx, -iy, iz), T(-ix, -hy, iz), 0, 0, 1, 0, 0.5, 1, bMat);

    mb.addFlatTri(T(ix, iy, -hz), T(ix, hy, -iz), T(hx, iy, -iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(-ix, iy, -hz), T(-hx, iy, -iz), T(-ix, hy, -iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(ix, -iy, -hz), T(hx, -iy, -iz), T(ix, -hy, -iz), 0, 0, 1, 0, 0.5, 1, bMat);
    mb.addFlatTri(T(-ix, -iy, -hz), T(-ix, -hy, -iz), T(-hx, -iy, -iz), 0, 0, 1, 0, 0.5, 1, bMat);
}
