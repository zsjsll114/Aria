/**
 * DimensionShapes.js
 * 3D 伴随纯点阵粒子几何体引擎
 * 特性：
 * 1. 彻底移除棱边线条与圆环描边，仅保留纯净点阵粒子（Pure Dot-Matrix）；
 * 2. 数量更多、尺寸更小巧（每行伴随 3~4 个小型圆柱与立方体星群）；
 * 3. 每一个粒子点精确映射当前播放音频频谱中的对应频段，实时沿法线方向起伏震颤。
 */

export class DimensionShapes {
    constructor() {
        this.fov = 900; // 与 CSS 3D perspective: 900px 严格一致
    }

    /**
     * 生成小巧点阵圆柱体点集 (Radius ~45-65px, Height ~90-130px)
     * 两底面无粒子，仅保留侧面圆周曲面点阵，疏密适中通透
     */
    createCylinderGeometry(radius = 52, height = 110, rings = 6, segments = 12) {
        const points = [];
        const hStep = rings > 1 ? height / (rings - 1) : height;
        const halfH = height * 0.5;

        let pIdx = 0;
        // 仅生成侧表面圆周曲面点阵（两底面不生成任何粒子，纯净透光圆柱筒）
        for (let ring = 0; ring < rings; ring++) {
            const y = ring * hStep - halfH;
            for (let s = 0; s < segments; s++) {
                const angle = (s / segments) * Math.PI * 2;
                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);
                points.push({
                    ox: cosA * radius,
                    oy: y,
                    oz: sinA * radius,
                    nx: cosA, // 侧表面向外法线
                    ny: 0,
                    nz: sinA,
                    freqIdx: (pIdx++) % 64,
                    isCap: false
                });
            }
        }

        return { type: 'cylinder', points };
    }

    /**
     * 生成小巧点阵立方体点集 (Size ~55-80px)
     */
    createCubeGeometry(size = 68, grid = 4) {
        const points = [];
        const step = size / (grid - 1);
        const half = size * 0.5;

        let pIdx = 0;
        for (let x = 0; x < grid; x++) {
            for (let y = 0; y < grid; y++) {
                for (let z = 0; z < grid; z++) {
                    const isSurface = (x === 0 || x === grid - 1 || y === 0 || y === grid - 1 || z === 0 || z === grid - 1);
                    if (isSurface) {
                        const px = x * step - half;
                        const py = y * step - half;
                        const pz = z * step - half;
                        const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
                        const isCorner = (x === 0 || x === grid - 1) && (y === 0 || y === grid - 1) && (z === 0 || z === grid - 1);
                        points.push({
                            ox: px,
                            oy: py,
                            oz: pz,
                            nx: px / len, // 表面向外法线
                            ny: py / len,
                            nz: pz / len,
                            freqIdx: (pIdx++) % 64,
                            isCorner
                        });
                    }
                }
            }
        }

        return { type: 'cube', points };
    }

    rotateX(x, y, z, angleRad) {
        const c = Math.cos(angleRad), s = Math.sin(angleRad);
        return { x, y: y * c - z * s, z: y * s + z * c };
    }

    rotateY(x, y, z, angleRad) {
        const c = Math.cos(angleRad), s = Math.sin(angleRad);
        return { x: x * c + z * s, y, z: -x * s + z * c };
    }

    rotateZ(x, y, z, angleRad) {
        const c = Math.cos(angleRad), s = Math.sin(angleRad);
        return { x: x * c - y * s, y: x * s + y * c, z };
    }

    /**
     * ★ 性能分档配置：低性能/无 GPU 设备上减少点阵粒子密度并关闭阴影
     * @param {Object} cfg { particleScale: 0.3~1, shadowEnabled: bool }
     */
    setPerf(cfg = {}) {
        this._stride = Math.max(1, Math.min(4, Math.round(1 / (Math.min(1, Math.max(0.25, cfg.particleScale ?? 1))))));
        this._shadowBlur = cfg.shadowEnabled === false ? 0 : 6;
    }

    /**
     * 将世界坐标点转换到摄像机视口坐标系
     */
    transformToCamera(wx, wy, wz, camera) {
        let x = wx - camera.x;
        let y = wy - camera.y;
        let z = wz - camera.z;

        const radY = (-camera.ry * Math.PI) / 180;
        const radX = (-camera.rx * Math.PI) / 180;
        const radZ = (-camera.rz * Math.PI) / 180;

        let p = this.rotateY(x, y, z, radY);
        p = this.rotateX(p.x, p.y, p.z, radX);
        p = this.rotateZ(p.x, p.y, p.z, radZ);

        return p;
    }

    /**
     * 渲染各歌词实体对应的所有小巧点阵几何体
     */
    render(ctx, width, height, dt, audioData = {}, entities = [], camera = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, themeColor = '#ffcc33') {
        const cx = width * 0.5;
        const cy = height * 0.5;
        const fov = this.fov;
        const freqData = audioData.freqData || new Uint8Array(64);
        const bass = audioData.bass || 0;

        const renderDots = [];

        for (const ent of entities) {
            if (!ent || !ent.shapes || ent.opacity <= 0.01) continue;

            const baseAlpha = ent.opacity;

            // 遍历该行歌词绑定的多个小巧伴随几何体 (星群)
            for (const shapeObj of ent.shapes) {
                const geom = shapeObj.geom;
                const pos = shapeObj.worldPos; // 3D 世界坐标
                const rot = shapeObj.fixedRot || [0.2, 0.35, 0.1];
                const scale = shapeObj.scale || 1.0;

                for (let pi = 0; pi < geom.points.length; pi += (this._stride || 1)) {
                    const pt = geom.points[pi];
                    // ★ 每一个点对应频谱中的一个频率，计算专属起伏振幅
                    const fVal = (freqData[pt.freqIdx] || 0) / 255;
                    // 粒子沿法线向外起伏位移
                    const disp = fVal * 20 * (0.5 + bass * 0.7);

                    const px = (pt.ox + pt.nx * disp) * scale;
                    const py = (pt.oy + pt.ny * disp) * scale;
                    const pz = (pt.oz + pt.nz * disp) * scale;

                    // 几何体自身的世界空间姿态旋转
                    let lPt = this.rotateX(px, py, pz, rot[0]);
                    lPt = this.rotateY(lPt.x, lPt.y, lPt.z, rot[1]);
                    lPt = this.rotateZ(lPt.x, lPt.y, lPt.z, rot[2]);

                    // 转换至 3D 摄像机视口空间
                    const cPt = this.transformToCamera(pos.x + lPt.x, pos.y + lPt.y, pos.z + lPt.z, camera);
                    const depth = -cPt.z;

                    // 视口近平面裁剪
                    if (depth <= -fov + 80) continue;

                    const sc = fov / (fov + depth);
                    const sx = cx + cPt.x * sc;
                    const sy = cy + cPt.y * sc;

                    // 屏幕外粗筛
                    if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue;

                    const alpha = Math.max(0.04, Math.min(0.95, baseAlpha * (0.55 + fVal * 0.65)));
                    const isAccent = (pt.freqIdx % 7 === 0 || pt.isCorner);

                    renderDots.push({
                        sx, sy, depth,
                        size: (pt.isCorner ? 3.6 : (isAccent ? 3.0 : 2.2) + fVal * 2.2) * Math.max(0.25, sc),
                        alpha,
                        isAccent,
                        fVal
                    });
                }
            }
        }

        // 深度排序（由远及近绘制）
        renderDots.sort((a, b) => b.depth - a.depth);

        // 执行纯点阵绘制（无任何线条描边）
        ctx.save();
        for (const dot of renderDots) {
            ctx.beginPath();
            ctx.arc(dot.sx, dot.sy, Math.max(0.6, dot.size), 0, Math.PI * 2);

            if (dot.isAccent) {
                ctx.fillStyle = themeColor || '#ffcc33';
                ctx.shadowColor = themeColor || '#ffcc33';
                ctx.shadowBlur = this._shadowBlur || 0;
            } else {
                ctx.fillStyle = `rgba(235, 245, 255, ${dot.alpha})`;
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }

            ctx.globalAlpha = dot.alpha;
            ctx.fill();
        }
        ctx.restore();
    }
}
