/**
 * sonnetShotMg.js — folia sonnetShotMg / sonnetBackgroundDecor / sonnetBackgroundMgVariants
 * 的保真子集移植（M2）：HUD 取景框 + Geometric Chaos + 背景装饰粒子。
 *
 * 上游一个 shot 的 MG 分四层：bg（HUD）/ geo（巨几何）/ particle（装饰粒子）/ fixedGeo。
 * 这里实现前三层（fixedGeo 属 M3），所有布局由 seed 派生、seek 稳定；
 * 动画由 engine 每帧以「播放时间的纯函数」驱动（无自积分）。
 */

import { hash01, hashSonnetSeed, mixSonnetSeed } from './sonnetRandom.js';

const colorNumber = (color) => {
    const v = String(color || '#FFFFFF').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return parseInt(v.slice(1), 16);
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        return parseInt(v[1] + v[1] + v[2] + v[2] + v[3] + v[3], 16);
    }
    return 0xFFFFFF;
};

/* ---------- 装饰粒子形状（上游 sonnetBackgroundDecor drawShape 子集） ---------- */

const drawDecorShape = (g, shape, pSize, color, alpha) => {
    switch (shape) {
        case 'diamond':
            g.moveTo(0, -pSize).lineTo(pSize, 0).lineTo(0, pSize).lineTo(-pSize, 0)
                .fill({ color, alpha: alpha * 0.85 });
            return;
        case 'plus': {
            const arm = pSize * 0.34;
            g.rect(-pSize, -arm, pSize * 2, arm * 2).fill({ color, alpha: alpha * 0.9 });
            g.rect(-arm, -pSize, arm * 2, pSize * 2).fill({ color, alpha: alpha * 0.9 });
            return;
        }
        case 'ring':
            g.circle(0, 0, pSize).stroke({ color, width: Math.max(1, pSize * 0.22), alpha: alpha * 0.9 });
            return;
        case 'triangle':
            g.moveTo(0, -pSize).lineTo(pSize * 0.9, pSize * 0.7).lineTo(-pSize * 0.9, pSize * 0.7)
                .lineTo(0, -pSize).fill({ color, alpha: alpha * 0.85 });
            return;
        case 'bar':
            g.rect(-pSize, -pSize * 0.18, pSize * 2, pSize * 0.36).fill({ color, alpha: alpha * 0.85 });
            return;
        case 'dot':
            g.circle(0, 0, pSize * 0.34).fill({ color, alpha });
            return;
        case 'square':
        default:
            g.rect(-pSize / 2, -pSize / 2, pSize, pSize).fill({ color, alpha });
            return;
    }
};

const PARTICLE_PALETTES = [
    ['square', 'diamond', 'sparkle'],
    ['ring', 'dot', 'square'],
    ['bar', 'plus', 'square'],
    ['triangle', 'diamond', 'plus'],
    ['dot', 'ring', 'square'],
    ['bar', 'square', 'dot'],
];

const DECOR_VARIANTS = ['scatter', 'orbit', 'edge-band', 'corner-clusters', 'constellation', 'twin-columns'];

/* 粒子节点 { node, baseX, baseY, driftPhase, driftAmpX, driftAmpY, spin }——engine 每帧驱动 */
export const resolveSonnetParticleLayouts = (particleNodes, time) => {
    particleNodes.forEach(p => {
        p.node.x = p.baseX + Math.sin(time * 0.35 + p.driftPhase) * p.driftAmpX;
        p.node.y = p.baseY + Math.cos(time * 0.28 + p.driftPhase * 1.7) * p.driftAmpY;
        p.node.rotation = p.spin * time;
    });
};

const buildParticles = (Graphics, Container, width, height, seed, primary, secondary) => {
    const layer = new Container();
    const nodes = [];
    const variant = mixSonnetSeed(seed, 0xc2b2ae35) % DECOR_VARIANTS.length;
    const palette = PARTICLE_PALETTES[variant % PARTICLE_PALETTES.length];
    const count = 14 + (seed % 9);

    for (let i = 0; i < count; i++) {
        const shape = palette[i % palette.length];
        const pSize = 4 + Math.round(hash01(seed, 0x51ed, i) * 14);
        const color = i % 3 === 0 ? primary : secondary;
        const alpha = 0.16 + hash01(seed, 0x77aa, i) * 0.22;
        const g = new Graphics();
        drawDecorShape(g, shape, pSize, color, alpha);
        const node = new Container();
        node.addChild(g);

        /* 布局：按 variant 撒点（上游 6 变体的简化——区域/密度差异保留） */
        let x; let y;
        const r1 = hash01(seed, 0x1111, i);
        const r2 = hash01(seed, 0x2222, i);
        if (variant === 1) { /* orbit：围绕中心的椭圆轨道 */
            const ang = r1 * Math.PI * 2;
            const rad = Math.min(width, height) * (0.28 + r2 * 0.22);
            x = width / 2 + Math.cos(ang) * rad * 1.3;
            y = height / 2 + Math.sin(ang) * rad * 0.8;
        } else if (variant === 2) { /* edge-band：贴边 */
            const edge = i % 4;
            x = edge === 0 ? width * 0.05 : edge === 1 ? width * 0.95 : r1 * width;
            y = edge === 2 ? height * 0.06 : edge === 3 ? height * 0.94 : r2 * height;
        } else if (variant === 3) { /* corner-clusters */
            const cx = i % 2 ? width * 0.12 : width * 0.88;
            const cy = i % 3 ? height * 0.14 : height * 0.86;
            x = cx + (r1 - 0.5) * width * 0.16;
            y = cy + (r2 - 0.5) * height * 0.16;
        } else if (variant === 4) { /* constellation：网格 + 抖动 */
            x = ((i * 37) % 100) / 100 * width;
            y = ((i * 61) % 100) / 100 * height;
        } else if (variant === 5) { /* twin-columns */
            x = i % 2 ? width * 0.1 : width * 0.9;
            y = r1 * height;
        } else { /* scatter */
            x = r1 * width;
            y = r2 * height;
        }
        node.position.set(x, y);
        layer.addChild(node);
        nodes.push({
            node,
            baseX: x,
            baseY: y,
            driftPhase: r1 * Math.PI * 2,
            driftAmpX: 4 + r2 * 10,
            driftAmpY: 4 + r1 * 10,
            spin: (r2 - 0.5) * 0.25,
        });
    }
    return { layer, nodes };
};

/* ---------- HUD 取景框（上游 drawSonnetBackgroundMgHud 保真子集） ---------- */

const buildHud = (Graphics, Container, width, height, seed, primary, secondary) => {
    const layer = new Container();
    const g = new Graphics();
    const inset = Math.min(width, height) * 0.045;
    const w = width - inset * 2;
    const h = height - inset * 2;
    const corner = Math.min(w, h) * 0.06;

    /* 主取景框（细线） */
    g.rect(inset, inset, w, h).stroke({ color: primary, width: 1, alpha: 0.16 });
    /* 四角 L 形角标（粗线） */
    const marks = [
        [inset, inset, 1, 1], [inset + w, inset, -1, 1],
        [inset, inset + h, 1, -1], [inset + w, inset + h, -1, -1],
    ];
    marks.forEach(([cx, cy, dx, dy], i) => {
        const len = corner * (i % 2 === 0 ? 1 : 0.7);
        g.moveTo(cx, cy + dy * len).lineTo(cx, cy).lineTo(cx + dx * len, cy)
            .stroke({ color: i % 2 === 0 ? primary : secondary, width: 2, alpha: 0.5 });
    });
    /* 侧边刻度线 */
    for (let i = 0; i < 5; i++) {
        const ty = inset + (h * (i + 1)) / 6;
        g.moveTo(inset - 6, ty).lineTo(inset - 6 + 10 * ((hash01(seed, 0x9e37, i) * 2) | 0 + 1), ty)
            .stroke({ color: secondary, width: 1, alpha: 0.3 });
    }
    /* 中心十字准星（小） */
    const cx0 = width / 2 + (hash01(seed, 0xbeef, 3) - 0.5) * width * 0.3;
    const cy0 = height / 2 + (hash01(seed, 0xbeef, 7) - 0.5) * height * 0.3;
    g.moveTo(cx0 - 8, cy0).lineTo(cx0 + 8, cy0).stroke({ color: secondary, width: 1, alpha: 0.28 });
    g.moveTo(cx0, cy0 - 8).lineTo(cx0, cy0 + 8).stroke({ color: secondary, width: 1, alpha: 0.28 });
    layer.addChild(g);
    return layer;
};

/* ---------- Geometric Chaos（上游 sonnetShotMg geo 段 3/6 变体） ---------- */

const buildGeo = (Graphics, Container, kind, width, height, seed, primary) => {
    if (kind !== 'type-impact' && kind !== 'fragment-collage') return null;
    const layer = new Container();
    const g = new Graphics();
    const radius = Math.min(width, height);
    const geoVariant = mixSonnetSeed(seed, 0x5eed) % 3;

    if (geoVariant === 0) {
        /* 巨环 + sunburst */
        g.circle(0, 0, radius * 0.6).stroke({ color: primary, width: 6, alpha: 0.8 });
        g.circle(0, 0, radius * 0.58).stroke({ color: primary, width: 2, alpha: 0.4 });
        for (let i = 0; i < 32; i++) {
            const angle = (i / 32) * Math.PI * 2;
            const r1 = radius * (0.3 + (i % 3) * 0.05);
            const r2 = radius * 0.55;
            g.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1)
                .lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2)
                .stroke({ color: primary, width: 1, alpha: 0.2 + (i % 2) * 0.1 });
        }
    } else if (geoVariant === 1) {
        /* 嵌套菱形 + 十字轴 */
        const r = radius * 0.7;
        g.moveTo(0, -r).lineTo(r, 0).lineTo(0, r).lineTo(-r, 0).lineTo(0, -r)
            .stroke({ color: primary, width: 6, alpha: 0.8 });
        g.moveTo(0, -r * 0.96).lineTo(r * 0.96, 0).lineTo(0, r * 0.96).lineTo(-r * 0.96, 0).lineTo(0, -r * 0.96)
            .stroke({ color: primary, width: 2, alpha: 0.4 });
        g.moveTo(0, -r * 0.4).lineTo(r * 0.4, 0).lineTo(0, r * 0.4).lineTo(-r * 0.4, 0).lineTo(0, -r * 0.4)
            .stroke({ color: primary, width: 1, alpha: 0.6 });
        g.moveTo(-r, 0).lineTo(r, 0).stroke({ color: primary, width: 1, alpha: 0.3 });
        g.moveTo(0, -r).lineTo(0, r).stroke({ color: primary, width: 1, alpha: 0.3 });
    } else {
        /* 六角网格 + 辐条 */
        const drawHex = (x, y, r, width_, a) => {
            g.moveTo(x + r * Math.sin(0), y - r * Math.cos(0));
            for (let j = 1; j <= 6; j++) g.lineTo(x + r * Math.sin(j * Math.PI / 3), y - r * Math.cos(j * Math.PI / 3));
            g.stroke({ color: primary, width: width_, alpha: a });
        };
        drawHex(0, 0, radius * 0.6, 6, 0.8);
        drawHex(0, 0, radius * 0.57, 2, 0.4);
        drawHex(0, 0, radius * 0.25, 1, 0.5);
        for (let j = 0; j < 6; j++) {
            const angle = j * Math.PI / 3 - Math.PI / 6;
            g.moveTo(Math.cos(angle) * radius * 0.25, Math.sin(angle) * radius * 0.25)
                .lineTo(Math.cos(angle) * radius * 0.57, Math.sin(angle) * radius * 0.57)
                .stroke({ color: primary, width: 2, alpha: 0.4 });
        }
    }

    /* 放置：中心偏移由 seed 决定（上游 geo 挂 mgLayer 中心附近） */
    g.position.set(
        width / 2 + (hash01(seed, 0x4001, 1) - 0.5) * width * 0.24,
        height / 2 + (hash01(seed, 0x4002, 2) - 0.5) * height * 0.2,
    );
    layer.addChild(g);
    return { layer, graphics: g, spinPhase: (hashSonnetSeed(seed) % 628) / 100 };
};

/* ---------- 总装 ---------- */

/**
 * @returns {{ container, bgLayer, geoLayer, particleLayer, particles, geo }}
 */
export const buildSonnetShotMg = (pixi, kind, theme, width, height, seed) => {
    const { Container, Graphics } = pixi;
    const container = new Container();
    const primary = colorNumber(theme.primaryColor);
    const secondary = colorNumber(theme.secondaryColor || '#71717a');

    const bgLayer = buildHud(Graphics, Container, width, height, seed, primary, secondary);
    container.addChild(bgLayer);

    const geo = buildGeo(Graphics, Container, kind, width, height, seed, primary);
    const geoLayer = geo ? geo.layer : new Container();
    container.addChild(geoLayer);

    const particles = buildParticles(Graphics, Container, width, height, seed, primary, secondary);
    container.addChild(particles.layer);

    return {
        container,
        bgLayer,
        geoLayer,
        particleLayer: particles.layer,
        particles: particles.nodes,
        geo,
    };
};
