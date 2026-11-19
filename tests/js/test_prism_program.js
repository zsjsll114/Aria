/* ============================================================
 * tests/js/test_prism_program.js — 「棱镜 · Prism」分镜编译与切面几何单测
 *
 * 覆盖：
 *   1. 36 种分镜构图（6 大家族 × 6 款）全部可生成有效多边形切面与色散边
 *   2. 分镜编译确定性（同输入同分镜序列）、时间轴首尾无缝衔接
 *   3. 相邻分镜不重复同款构图、不连续同家族
 *   4. 二分检索 findActivePrismShot 在任意时刻的 seek-safe 行为
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PRISM_ENTER_STYLES,
    PRISM_LAYOUT_KINDS,
    PRISM_SHOT_FAMILIES,
    PRISM_SHOT_KINDS,
    PRISM_TRANSITION_KINDS,
} from '../../web/src/core/visualizers/prism/prismTypes.js';
import {
    buildPrismFacetGeometry,
    chunkLineGraphemes,
    compilePrismProgram,
    familyOfShotKind,
    findActivePrismShot,
} from '../../web/src/core/visualizers/prism/prismProgram.js';

const SAMPLE_LINES = Array.from({ length: 28 }, (_, i) => ({
    original: i % 3 === 0
        ? `穿过第${i + 1}道棱镜切面，把夜色折射成漫天光谱与星芒`
        : `Refracting light across crystal facet number ${i + 1} in the dark`,
    translation: `第 ${i + 1} 句译文`,
    start: i * 4200 + 800,
    end: (i + 1) * 4200 + 200,
}));

test('P1 36 种镜头构图常量与 6 大家族完整对齐', () => {
    const families = Object.keys(PRISM_SHOT_FAMILIES);
    assert.equal(families.length, 6);
    assert.equal(PRISM_SHOT_KINDS.length, 36);
    assert.equal(new Set(PRISM_SHOT_KINDS).size, 36);
    for (const kind of PRISM_SHOT_KINDS) {
        assert.ok(families.includes(familyOfShotKind(kind)));
    }
});

test('P2 全部 36 种镜头均可生成合法的多边形切面与反色焦点', () => {
    for (const kind of PRISM_SHOT_KINDS) {
        const geo = buildPrismFacetGeometry(kind, 12345, 1.6);
        assert.equal(geo.kind, kind);
        assert.ok(geo.facets.length >= 2, `${kind} 切面数不足: ${geo.facets.length}`);
        for (const facet of geo.facets) {
            assert.ok(facet.points.length >= 3, `${kind} 存在退化多边形`);
            for (const pt of facet.points) {
                assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
            }
        }
        const invertCount = geo.facets.filter(f => f.invert).length;
        assert.ok(invertCount <= 1, `${kind} 反色亮面超过 1 个`);
        assert.ok(geo.cutSegments.length >= 1, `${kind} 缺少棱边色散线段`);
    }
});

test('P3 compilePrismProgram：确定性、时间轴单调无空洞、相邻不重样', () => {
    const progA = compilePrismProgram(SAMPLE_LINES, { seed: 'aria-prism-test', cutRate: 'phrase' });
    const progB = compilePrismProgram(SAMPLE_LINES, { seed: 'aria-prism-test', cutRate: 'phrase' });
    assert.deepEqual(progA, progB);
    assert.ok(progA.shots.length >= 40, `短语分镜数量应大于行数: ${progA.shots.length}`);

    const seenKinds = new Set();
    for (let i = 0; i < progA.shots.length; i++) {
        const s = progA.shots[i];
        seenKinds.add(s.kind);
        assert.ok(PRISM_SHOT_KINDS.includes(s.kind));
        assert.ok(PRISM_LAYOUT_KINDS.includes(s.layout));
        assert.ok(PRISM_ENTER_STYLES.includes(s.enterStyle));
        assert.ok(PRISM_TRANSITION_KINDS.includes(s.transition));
        assert.ok(s.endTimeMs > s.startTimeMs);
        if (i > 0) {
            const prev = progA.shots[i - 1];
            assert.equal(s.startTimeMs, prev.endTimeMs, '相邻镜头时间轴必须无缝衔接');
            if (!s.isInterlude && !prev.isInterlude) {
                assert.notEqual(s.kind, prev.kind, '相邻镜头不得使用同款构图');
                assert.notEqual(s.family, prev.family, '相邻镜头不得连续属于同一几何家族');
            }
        }
    }
    assert.ok(seenKinds.size >= 28, `一首歌内应轮换绝大多数构图: 实测 ${seenKinds.size} 种`);
});

test('P4 cutRate 三档（line / phrase / fast）分镜密度递增且 findActivePrismShot 准确', () => {
    const lineProg = compilePrismProgram(SAMPLE_LINES, { seed: 99, cutRate: 'line' });
    const phraseProg = compilePrismProgram(SAMPLE_LINES, { seed: 99, cutRate: 'phrase' });
    const fastProg = compilePrismProgram(SAMPLE_LINES, { seed: 99, cutRate: 'fast' });

    assert.ok(lineProg.shots.length < phraseProg.shots.length);
    assert.ok(phraseProg.shots.length <= fastProg.shots.length);

    const midTime = 25000;
    const state = findActivePrismShot(phraseProg, midTime);
    assert.ok(state.active);
    assert.ok(midTime >= state.active.startTimeMs && midTime <= state.active.endTimeMs);
    assert.ok(state.activeProgress >= 0 && state.activeProgress <= 1);

    const chunks = chunkLineGraphemes(phraseProg.shots[0].graphemes, 'fast');
    assert.ok(chunks.length >= 1);
});

test('P5 18 镜滑动去重窗、9 宫不对称银幕锚区与 8 种光学母题连续流转', () => {
    const prog = compilePrismProgram(SAMPLE_LINES, { seed: 'prism-variety-guard', cutRate: 'phrase' });
    const lyricShots = prog.shots.filter(s => !s.isInterlude);
    const zones = new Set();
    const motifs = new Set();
    const aligns = new Set();

    for (let i = 0; i < lyricShots.length; i++) {
        const s = lyricShots[i];
        assert.ok(s.region && typeof s.region.id === 'string' && s.region.id.length > 0);
        assert.ok(typeof s.decorMotif === 'string' && s.decorMotif.length > 0);
        assert.ok(typeof s.region.align === 'string');
        assert.ok(Number.isFinite(s.flowAngleRad));
        zones.add(s.region.id);
        motifs.add(s.decorMotif);
        aligns.add(s.region.align);

        if (i >= 1) {
            const prev = lyricShots[i - 1];
            assert.notEqual(s.region.id, prev.region.id, '相邻歌词镜不得停留在同一银幕锚区');
            assert.notEqual(s.decorMotif, prev.decorMotif, '相邻歌词镜不得重复同一光学装饰母题');
        }
    }
    assert.ok(zones.size >= 7, `银幕锚区覆盖不足: ${zones.size}`);
    assert.ok(motifs.size >= 7, `光学装饰母题覆盖不足: ${motifs.size}`);
    assert.deepEqual(new Set(['left', 'center', 'right']), aligns);
});

test('P6 全屏视口等比例字号放大（突破 82px 天花板）与连续时钟零跳变', async () => {
    const { PrismVisualizer } = await import('../../web/src/core/visualizers/PrismVisualizer.js');
    const prog = compilePrismProgram(SAMPLE_LINES, { seed: 'prism-scale-test', cutRate: 'line' });
    const shot = prog.shots.find(s => !s.isInterlude);
    assert.ok(shot);

    const vis = new PrismVisualizer();
    const makeMockCtx = () => ({
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            return { width: Array.from(str || '').length * px * 0.56 };
        },
    });
    const ctx = makeMockCtx();

    const geoSmall = vis._getGeometry(shot, 960 / 540);
    const layoutSmall = vis._getShotLayout(shot, geoSmall, 960, 540, ctx);

    vis._layoutCache.clear();
    const geoFull = vis._getGeometry(shot, 1920 / 1080);
    const layoutFull = vis._getShotLayout(shot, geoFull, 1920, 1080, ctx);

    vis._layoutCache.clear();
    const geo2K = vis._getGeometry(shot, 2560 / 1440);
    const layout2K = vis._getShotLayout(shot, geo2K, 2560, 1440, ctx);

    // 1080p 与 2K 全屏下字号随视口等比例放大，彻底突破旧版 82px 上限
    assert.ok(layoutFull.fontPx > 110, `1080p 全屏字号偏小: ${layoutFull.fontPx}px`);
    assert.ok(layout2K.fontPx > layoutFull.fontPx * 1.25, `2K 全屏未随窗口继续放大: ${layout2K.fontPx}px vs ${layoutFull.fontPx}px`);
    const scaleRatio = layoutFull.fontPx / layoutSmall.fontPx;
    assert.ok(scaleRatio >= 1.75 && scaleRatio <= 2.25, `窗口翻倍时字号缩放比应接近 2.0，实测 ${scaleRatio.toFixed(2)}`);

    // 模拟 200ms audio.currentTime 离散脉冲期间的 60fps 帧间时钟推进：每帧步进应平稳在 ~16.67ms，无 90ms 后减速或 200ms 跳变
    const prevAudio = globalThis.audio;
    try {
        globalThis.audio = { currentTime: 1.0, paused: false, playbackRate: 1 };
        vis.update(1.0);
        let prevT = vis._smoothMediaMs;
        const steps = [];
        for (let f = 1; f <= 15; f++) {
            vis._lastFramePerf -= 16.67;
            vis._lastRawPerf -= 16.67;
            if (f === 12) {
                // 第 200ms 处 audio.currentTime 跳变更新（附带 +20ms 音频线程抖动）
                globalThis.audio.currentTime = 1.22;
                vis.update(1.22);
            }
            const nextT = vis._extrapolatedTimeMs();
            steps.push(nextT - prevT);
            prevT = nextT;
        }
        assert.ok(prevT > 1230, `平滑时钟推进不足: ${prevT}`);
        for (const st of steps) {
            assert.ok(st >= 12 && st <= 23, `帧间时钟步进出现顿挫或跳变: ${st.toFixed(2)}ms`);
        }
    } finally {
        globalThis.audio = prevAudio;
    }
});

test('P7 全画幅安全框保证：全角汉字 1.0x 真实字宽下全部分镜零越界', async () => {
    const { PrismVisualizer } = await import('../../web/src/core/visualizers/PrismVisualizer.js');
    const vis = new PrismVisualizer();
    const realWidthCtx = {
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            let w = 0;
            for (const ch of Array.from(str || '')) {
                w += /[\u2e80-\u9fff\uac00-\ud7af\u3040-\u30ff\uf900-\ufaff]/.test(ch) ? px * 1.02 : px * 0.58;
            }
            return { width: w };
        },
    };
    const W = 1920;
    const H = 1080;
    for (const cutRate of ['line', 'phrase', 'fast']) {
        const prog = compilePrismProgram(SAMPLE_LINES, { seed: 'overflow-guard', cutRate });
        vis._layoutCache.clear();
        for (const shot of prog.shots) {
            const geo = vis._getGeometry(shot, W / H);
            const layout = vis._getShotLayout(shot, geo, W, H, realWidthCtx);
            for (const g of layout.glyphs) {
                const left = g.x - g.w * 0.5;
                const right = g.x + g.w * 0.5;
                const top = g.y - g.fontPx * 0.55;
                const bottom = g.y + g.fontPx * 0.55;
                assert.ok(left >= W * 0.06 && right <= W * 0.94, `镜头 #${shot.index} (${shot.layout}) 字符 "${g.char}" 横向越界: [${left.toFixed(1)}, ${right.toFixed(1)}]`);
                assert.ok(top >= H * 0.08 && bottom <= H * 0.84, `镜头 #${shot.index} (${shot.layout}) 字符 "${g.char}" 纵向越界: [${top.toFixed(1)}, ${bottom.toFixed(1)}]`);
            }
        }
    }
});
