/* ============================================================
 * tests/js/test_astrolabe_program.js — 「画册 · Folio」（mode: astrolabe）54 镜编译器与几何排版单测
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ASTROLABE_FAMILIES,
    ASTROLABE_SHOT_KINDS,
    ASTROLABE_TYPO_TOPOLOGIES,
    ASTROLABE_FOCAL_ZONES,
    ASTROLABE_DECOR_MOTIFS,
    compileAstrolabeProgram,
    detectChorusLineFlags,
    findActiveAstrolabeShot,
} from '../../web/src/core/visualizers/astrolabe/astrolabeProgram.js';
import { buildAstrolabeShotGeometry } from '../../web/src/core/visualizers/astrolabe/astrolabeCompositions.js';
import { ASTROLABE_PALETTES } from '../../web/src/core/visualizers/astrolabe/astrolabeProfiles.js';
import { PrismVisualizer } from '../../web/src/core/visualizers/PrismVisualizer.js';
import { AstrolabeVisualizer, resolveAstrolabeFont, emotionColorsForGraphemes, astrolabeEmotionStamp, ASTROLABE_PRINT_LEVELS, resolveAstrolabePrintParams } from '../../web/src/core/visualizers/AstrolabeVisualizer.js';

const SAMPLE_LINES = Array.from({ length: 28 }, (_, i) => ({
    time: 2 + i * 3.2,
    text: i % 2 === 0
        ? `Beneath the silent meridian of golden twilight ${i}`
        : `在深邃的夜空与破框的羊皮纸交界处缓缓苏醒 ${i}`,
    translation: `测试双语底部字幕第 ${i + 1} 行`,
    romaji: `tesuto romaji line ${i + 1}`,
}));

test('A1 9 大家族 × 6 镜 = 54 种独立构图（超越 Prism 36 镜与 Tempera 30 镜）', () => {
    assert.equal(ASTROLABE_FAMILIES.length, 9);
    assert.equal(ASTROLABE_SHOT_KINDS.length, 54);
    assert.equal(new Set(ASTROLABE_SHOT_KINDS).size, 54);
    assert.equal(ASTROLABE_TYPO_TOPOLOGIES.length, 8);
    assert.equal(ASTROLABE_FOCAL_ZONES.length, 12);
    assert.equal(ASTROLABE_DECOR_MOTIFS.length, 10);
});

test('A2 全部 54 种分镜均可生成破框实色块面与正负形反色面（invert: true）', () => {
    for (let i = 0; i < ASTROLABE_SHOT_KINDS.length; i++) {
        const shotKind = ASTROLABE_SHOT_KINDS[i];
        const geo = buildAstrolabeShotGeometry({ shotKind, index: i, seed: 42 }, 16 / 9);
        assert.ok(Array.isArray(geo.masses) && geo.masses.length >= 3, `${shotKind} 块面不足`);
        assert.ok(geo.masses.some(m => m.invert === true), `${shotKind} 缺少正负形反色块面`);
        for (const m of geo.masses) {
            assert.ok(Array.isArray(m.points) && m.points.length >= 3);
            assert.ok(Number.isFinite(m.bbox.minX) && Number.isFinite(m.bbox.maxX));
        }
    }
});

test('A3 22 镜防重复滑动窗、8 种排版拓扑与 12 宫锚区相邻零重复', () => {
    const prog = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'astrolabe-test', cutRate: 'phrase' });
    const lyricShots = prog.shots.filter(s => !s.isInterlude);
    assert.ok(lyricShots.length >= 40);

    const seenKinds = new Set();
    const seenTopos = new Set();
    const seenZones = new Set();

    for (let i = 0; i < lyricShots.length; i++) {
        const s = lyricShots[i];
        seenKinds.add(s.shotKind);
        seenTopos.add(s.topology);
        seenZones.add(s.region.id);
        if (i >= 1) {
            const prev = lyricShots[i - 1];
            assert.notEqual(s.shotKind, prev.shotKind, '相邻分镜不得重复');
            assert.notEqual(s.family, prev.family, '相邻分镜家族不得重复');
            assert.notEqual(s.topology, prev.topology, '相邻分镜排版拓扑不得重复');
            assert.notEqual(s.region.id, prev.region.id, '相邻分镜银幕锚区不得重复');
        }
    }
    assert.ok(seenKinds.size >= 24, `单曲分镜种类过少: ${seenKinds.size}`);
    assert.equal(seenTopos.size, 8, '8 种排版拓扑未全覆盖');
    assert.ok(seenZones.size >= 10, `12 宫银幕锚区覆盖不足: ${seenZones.size}`);
});

test('A4 全屏视口等比例字号无上限放大与二分时间轴查找', () => {
    const prog = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'scale-check', cutRate: 'phrase' });
    const shot = prog.shots.find(s => !s.isInterlude);
    assert.ok(shot);

    const state = findActiveAstrolabeShot(prog, shot.startTimeMs + 200);
    assert.equal(state.active.index, shot.index);

    const vis = new AstrolabeVisualizer();
    assert.ok(vis instanceof AstrolabeVisualizer && PrismVisualizer);
    const mockCtx = {
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            return { width: Array.from(str || '').length * px * 0.55 };
        },
    };

    const geoSmall = vis._getGeometry(shot, 960 / 540);
    const layoutSmall = vis._getShotLayout(shot, geoSmall, 960, 540, mockCtx);
    vis._layoutCache.clear();
    const geoFull = vis._getGeometry(shot, 1920 / 1080);
    const layoutFull = vis._getShotLayout(shot, geoFull, 1920, 1080, mockCtx);

    assert.ok(layoutFull.fontPx > 115, `1080p 全屏字号偏小: ${layoutFull.fontPx}px`);
    const ratio = layoutFull.fontPx / layoutSmall.fontPx;
    assert.ok(ratio >= 1.75 && ratio <= 2.25, `窗口翻倍字号应等比放大 ~2.0x，实测 ${ratio.toFixed(2)}`);
});

test('A5 字体切换（内置宋体/楷体/等宽 + 自定义字体）与画册明暗翻页极性生效', () => {
    const prog = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'font-polarity', cutRate: 'phrase' });
    const vis = new AstrolabeVisualizer();

    assert.ok(resolveAstrolabeFont('serif').includes('Serif'));
    assert.ok(resolveAstrolabeFont('kai').includes('Kai'));
    assert.ok(resolveAstrolabeFont('mono').includes('Mono'));

    const mockCtx = {
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            return { width: Array.from(str || '').length * px * 0.55 };
        },
    };
    const shot = prog.shots.find(s => !s.isInterlude);
    const geo = vis._getGeometry(shot, 16 / 9);
    vis.onApplySettings({ fontFamily: 'serif' });
    const l1 = vis._getShotLayout(shot, geo, 1280, 720, mockCtx);
    vis.onApplySettings({ fontFamily: 'mono' });
    const l2 = vis._getShotLayout(shot, geo, 1280, 720, mockCtx);
    assert.notEqual(l1.fontStack, l2.fontStack, '切换字体后 layout.fontStack 必须立即更新');

    const basePal = vis._resolvePalette();
    const polarities = new Set();
    for (const s of prog.shots.slice(0, 18)) {
        const sp = vis._resolveShotPalette(basePal, s);
        polarities.add(sp.polarity);
    }
    assert.ok(polarities.has('dark') && polarities.has('paper'), '分镜应交替出现深墨底与象牙宣纸底翻页极性');
});

test('A6 编译确定性、真实副歌重复度检测（拒绝伪副歌泛滥）与同家族 6 变体构图差异度', () => {
    const prog1 = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'determinism-seed', cutRate: 'phrase' });
    const prog2 = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'determinism-seed', cutRate: 'phrase' });
    assert.equal(
        JSON.stringify(prog1.shots),
        JSON.stringify(prog2.shots),
        '同一 seed 编译两次的 shots JSON 必须 100% 完全相等'
    );

    const lyricShots = prog1.shots.filter(s => !s.isInterlude);
    const chorusCount = lyricShots.filter(s => s.isChorus).length;
    const chorusRatio = chorusCount / lyricShots.length;
    assert.ok(
        chorusRatio >= 0.10 && chorusRatio <= 0.42,
        `isChorus 占比应受控在 10%~42% 以防高光泛滥，实测 ${(chorusRatio * 100).toFixed(1)}%`
    );

    const songWithRepeatedChorus = [
        { time: 0, text: '独自走过寂静的旧街口' },
        { time: 4, text: '路灯拉长了微凉的影子' },
        { time: 8, text: '星轨在夜空刻下黄金的铭文' },
        { time: 12, text: '照亮我们未曾遗忘的远方' },
        { time: 16, text: '微风吹散昨日的尘埃与叹息' },
        { time: 20, text: '钟摆停留在黎明前的刻度' },
        { time: 24, text: '星轨在夜空刻下黄金的铭文' },
        { time: 28, text: '照亮我们未曾遗忘的远方' },
    ];
    const { isChorusByLine } = detectChorusLineFlags(songWithRepeatedChorus);
    assert.equal(isChorusByLine[0], false, '不重复主歌行不应标为副歌');
    assert.equal(isChorusByLine[2], true, '重复出现的副歌句必须被准确识别');
    assert.equal(isChorusByLine[3], true, '重复出现的副歌句必须被准确识别');
    assert.equal(isChorusByLine[6], true, '第二次出现的副歌句必须被准确识别');
    assert.equal(isChorusByLine[7], true, '第二次出现的副歌句必须被准确识别');

    // 验证 9 个家族内部的 6 个变体具备结构性构图差异（块面数量/顶点数/标线数/标尺种类不全同）
    for (let famIdx = 0; famIdx < ASTROLABE_FAMILIES.length; famIdx++) {
        const fam = ASTROLABE_FAMILIES[famIdx];
        const signatures = new Set();
        for (let v = 0; v < 6; v++) {
            const shotKind = ASTROLABE_SHOT_KINDS[famIdx * 6 + v];
            const geo = buildAstrolabeShotGeometry({ shotKind, index: v, seed: 77 }, 16 / 9);
            const sig = [
                geo.masses.length,
                geo.masses.map(m => `${m.points.length}:${m.invert ? 1 : 0}:${m.isAccent ? 1 : 0}`).join(','),
                geo.lines.length,
                geo.marks.map(mk => mk.kind).join(','),
            ].join('|');
            signatures.add(sig);
        }
        assert.ok(signatures.size >= 4, `家族 ${fam} 的 6 个变体结构签名过于雷同: ${signatures.size}`);
    }
});

test('A7 dirtyRect 几何包络断言：press-stamp(1.26x) 与 pivot-unfold(0.22rad) 极限入场绝不切字', () => {
    const vis = new AstrolabeVisualizer();
    const w = 1920;
    const h = 1080;
    const mockCtx = {
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            return { width: Array.from(str || '').length * px * 0.58 };
        },
    };

    const prog = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'dirtyrect-bounds', cutRate: 'phrase' });
    const cosR = Math.cos(0.22);
    const sinR = Math.sin(0.22);

    for (const shot of prog.shots) {
        if (shot.isInterlude) continue;
        vis._layoutCache.clear();
        const geo = vis._getGeometry(shot, w / h);
        const layout = vis._getShotLayout(shot, geo, w, h, mockCtx);
        const dr = layout.dirtyRect;

        for (const g of layout.glyphs) {
            const gPx = g.fontPx || layout.fontPx;
            // 最严苛入场组合：0.28 * gPx 位移 + 1.26x 放大 + 0.22rad 旋转
            const maxShift = gPx * 0.28;
            const halfW = (g.w * 0.5) * 1.26;
            const halfH = (gPx * 0.58) * 1.26;
            const rotHalfW = halfW * cosR + halfH * sinR + maxShift;
            const rotHalfH = halfW * sinR + halfH * cosR + maxShift;

            const left = Math.max(0, g.x - rotHalfW);
            const right = Math.min(w, g.x + rotHalfW);
            const top = Math.max(0, g.y - rotHalfH);
            const bottom = Math.min(h, g.y + rotHalfH);

            assert.ok(
                left >= dr.x && right <= dr.x + dr.w && top >= dr.y && bottom <= dr.y + dr.h,
                `shot#${shot.index}(${shot.shotKind}/${shot.topology}) 字形极限变换越出 dirtyRect: ` +
                `glyph=[${left.toFixed(1)},${top.toFixed(1)}..${right.toFixed(1)},${bottom.toFixed(1)}] ` +
                `dirtyRect=[${dr.x},${dr.y}..${dr.x + dr.w},${dr.y + dr.h}]`
            );
        }

        if (layout.heroBox) {
            const hb = layout.heroBox;
            const hLeft = Math.max(0, hb.x - hb.w * 0.5);
            const hRight = Math.min(w, hb.x + hb.w * 0.5);
            const hTop = Math.max(0, hb.y - hb.h * 0.5);
            const hBottom = Math.min(h, hb.y + hb.h * 0.5);
            assert.ok(
                hLeft >= dr.x && hRight <= dr.x + dr.w && hTop >= dr.y && hBottom <= dr.y + dr.h,
                `shot#${shot.index} heroBox 越出 dirtyRect`
            );
        }
        assert.ok(
            layout.typoGrid && Number.isFinite(layout.typoGrid.horizonY) && Number.isFinite(layout.typoGrid.seamX),
            `shot#${shot.index} 必须生成与文字对齐的 typoGrid 网格锚点`
        );
    }
});

test('A8 6 套博物馆跨色相色板、7/9 非圆家族去同质化与三档疏密呼吸（sparse/balanced/dense）', () => {
    const palKeys = Object.keys(ASTROLABE_PALETTES);
    assert.equal(palKeys.length, 6);
    const accents = new Set(palKeys.map(k => ASTROLABE_PALETTES[k].accent));
    assert.equal(accents.size, 6, '6 套色板的点睛色 accent 必须各不相同');
    // 验证包含冷色群青（prussian: #2b7fff）与石绿（celadon: #18b888），彻底打破全橙红同质化
    assert.equal(ASTROLABE_PALETTES.prussian.accent, '#2b7fff');
    assert.equal(ASTROLABE_PALETTES.celadon.accent, '#18b888');
    assert.equal(ASTROLABE_PALETTES.bauhaus.accent, '#f2b705');

    // 验证 9 大家族中仅有 eclipse / armillary 使用高顶点数圆弧（>=24 顶点），其余 7 大家族全部为硬边直线多边形（<=12 顶点）
    for (let famIdx = 0; famIdx < ASTROLABE_FAMILIES.length; famIdx++) {
        const fam = ASTROLABE_FAMILIES[famIdx];
        const isCircularFamily = fam === 'eclipse' || fam === 'armillary';
        for (let v = 0; v < 6; v++) {
            const shotKind = ASTROLABE_SHOT_KINDS[famIdx * 6 + v];
            const geo = buildAstrolabeShotGeometry({ shotKind, index: v, seed: 99, densityTier: 'dense' }, 16 / 9);
            if (!isCircularFamily) {
                for (const m of geo.masses) {
                    assert.ok(
                        m.points.length <= 12,
                        `非圆家族 ${fam} (${shotKind}) 不得使用大圆弧（顶点数 ${m.points.length} > 12）`
                    );
                }
            }
        }
    }

    // 验证编译期三档疏密呼吸（sparse 极简空镜 / balanced 平衡镜 / dense 高潮满版镜）交替生效
    const prog = compileAstrolabeProgram(SAMPLE_LINES, { seed: 'density-breath', cutRate: 'phrase' });
    const tiers = new Set(prog.shots.map(s => s.densityTier));
    assert.ok(tiers.has('sparse') && tiers.has('balanced') && tiers.has('dense'), '必须同时具备 sparse/balanced/dense 三档疏密呼吸');

    const sparseShot = prog.shots.find(s => s.densityTier === 'sparse');
    const sparseGeo = buildAstrolabeShotGeometry(sparseShot, 16 / 9);
    assert.equal(sparseGeo.masses.length, 1, 'sparse 极简留白镜应只保留 1 块核心正负形切面');
    assert.equal(sparseGeo.marks.length, 0, 'sparse 极简留白镜不应绘制冗余标尺');
    assert.equal(sparseGeo.watermark, null, 'sparse 极简留白镜不应绘制水印大字');
});

test('A9 竖排铭文（vertical-manuscript）字母语言整词横转 90° vs 中日韩正立竖排，且多行/分栏歌词绝不重叠', () => {
    const viz = new AstrolabeVisualizer();
    const w = 1920;
    const h = 1080;
    const mockCtx = {
        save() {},
        restore() {},
        font: '',
        measureText(str) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
            const px = m ? Number(m[1]) : 48;
            return { width: Array.from(str || '').length * px * 0.58 };
        },
    };

    // 1. 英文歌词在 vertical-manuscript 下：首词（"Golden"）必须整词横转 90°（rotRad = π/2），不能一字母一换行正立
    const enProg = compileAstrolabeProgram([
        { time: 0, text: 'Golden horizon rises over the silent midnight sea and distant stars' },
        { time: 4.0, text: 'Another line' },
    ], { seed: 'en-vert-test', cutRate: 'line' });
    const enShot = {
        ...enProg.shots[0],
        topology: 'vertical-manuscript',
        focalZone: 'nadir-low',
    };
    viz._layoutCache.clear();
    const enGeo = viz._getGeometry(enShot, w / h);
    const enLayout = viz._getShotLayout(enShot, enGeo, w, h, mockCtx);
    const goldenGlyphs = enLayout.glyphs.filter(g => g.rowIndex === 0);
    assert.equal(goldenGlyphs.length, 6, '首词 Golden 应有 6 个字母');
    for (const g of goldenGlyphs) {
        assert.ok(
            Math.abs(g.rotRad - Math.PI * 0.5) < 1e-4,
            `英文竖排首词字母 "${g.char}" 必须横转 90° (rotRad=π/2)，实际=${g.rotRad}`
        );
    }
    // 旁栏横排词（rowIndex >= 1）必须与竖排柱（rowIndex === 0）在 X 轴上严格分栏、互不侵入
    const pillarX = goldenGlyphs[0].x;
    const pillarHalfCol = goldenGlyphs[0].fontPx * 0.6;
    const bodyGlyphs = enLayout.glyphs.filter(g => g.rowIndex >= 1);
    for (const bg of bodyGlyphs) {
        const distX = Math.abs(bg.x - pillarX);
        assert.ok(
            distX >= pillarHalfCol + bg.w * 0.4,
            `旁栏字符 "${bg.char}" (x=${bg.x.toFixed(1)}) 不得与竖排铭文柱 (x=${pillarX.toFixed(1)}) 重叠`
        );
    }

    // 2. 中文歌词在 vertical-manuscript 下：首词保持正立（rotRad = 0）一字一行竖排
    const zhProg = compileAstrolabeProgram([
        { time: 0, text: '星轨 划过漫长夜空与山海之间' },
        { time: 4.0, text: '下一句' },
    ], { seed: 'zh-vert-test', cutRate: 'line' });
    const zhShot = {
        ...zhProg.shots[0],
        topology: 'vertical-manuscript',
    };
    viz._layoutCache.clear();
    const zhGeo = viz._getGeometry(zhShot, w / h);
    const zhLayout = viz._getShotLayout(zhShot, zhGeo, w, h, mockCtx);
    const zhPillarGlyphs = zhLayout.glyphs.filter(g => g.rowIndex === 0);
    assert.ok(zhPillarGlyphs.length >= 2);
    for (const g of zhPillarGlyphs) {
        assert.equal(g.rotRad, 0, `中文竖排字符 "${g.char}" 应保持正立 (rotRad=0)`);
    }

    // 3. 多行长句在低重心区域（nadir-low）下：不同行之间 Y 坐标必须严格递增，绝不因底部 clamp 而压扁重叠
    const multiRowShot = {
        ...enProg.shots[0],
        topology: 'swiss-grid-left',
        focalZone: 'nadir-low',
    };
    viz._layoutCache.clear();
    const multiGeo = viz._getGeometry(multiRowShot, w / h);
    const multiLayout = viz._getShotLayout(multiRowShot, multiGeo, w, h, mockCtx);
    const rowMap = new Map();
    for (const g of multiLayout.glyphs) {
        if (!rowMap.has(g.rowIndex)) rowMap.set(g.rowIndex, []);
        rowMap.get(g.rowIndex).push(g);
    }
    const rowIndices = [...rowMap.keys()].sort((a, b) => a - b);
    assert.ok(rowIndices.length >= 2, '长英文歌词应至少排成 2 行');
    for (let i = 1; i < rowIndices.length; i++) {
        const prevRow = rowMap.get(rowIndices[i - 1]);
        const currRow = rowMap.get(rowIndices[i]);
        const prevMeanY = prevRow.reduce((s, g) => s + g.y, 0) / prevRow.length;
        const currMeanY = currRow.reduce((s, g) => s + g.y, 0) / currRow.length;
        assert.ok(
            currMeanY - prevMeanY >= multiLayout.fontPx * 0.85,
            `第 ${i - 1} 行 (y=${prevMeanY.toFixed(1)}) 与第 ${i} 行 (y=${currMeanY.toFixed(1)}) 行距过小导致重叠`
        );
    }
});

test('A10 AI 情感词上色：读取 aiEmotionWords、按字形序列对齐、尊重总开关与行号限定', () => {
    const prevWords = globalThis.aiEmotionWords;
    const prevSettings = globalThis.appSettings;
    const TEXT = '在深邃的夜空与golden交界';
    const graphemes = Array.from(TEXT).map((ch, i) => ({ char: ch, start: i * 100, end: i * 100 + 90, wordIndex: 0 }));
    try {
        globalThis.appSettings = { lyrics: { emotionWords: true } };
        globalThis.aiEmotionWords = [
            { word: '夜空', color: '#2b7fff' },
            { word: 'golden', color: '#e6a832' },
            { word: '坏色', color: 'not-a-color' },
            { word: '', color: '#ffffff' },
        ];

        const colors = emotionColorsForGraphemes(TEXT, graphemes, 0);
        const nightIdx = graphemes.findIndex(g => g.char === '夜');
        assert.ok(nightIdx > 0, '样例文本应包含「夜」');
        assert.equal(colors[nightIdx], '#2b7fff', '中文情感词必须整词上色');
        assert.equal(colors[nightIdx + 1], '#2b7fff');
        const gIdx = graphemes.findIndex(g => g.char === 'g');
        assert.equal(colors[gIdx], '#e6a832', '英文情感词必须整词上色');
        assert.equal(colors[gIdx + 5], '#e6a832');
        assert.equal(colors.filter(c => c === 'not-a-color').length, 0, '非法颜色必须被丢弃');
        assert.equal(colors.filter(Boolean).length, 8, '只有命中的 2 + 6 个字被上色，其余保持 null');

        // 1. Prompt 与去重契约约定同一个词只下发首次出现行，着色必须覆盖全文所有匹配行（忽略 entry.line 过滤）
        globalThis.aiEmotionWords = [{ word: '夜空', color: '#2b7fff', line: 7 }];
        const crossLineColors = emotionColorsForGraphemes(TEXT, graphemes, 0);
        assert.equal(
            crossLineColors.filter(Boolean).length,
            2,
            '带 line 的情感词仍应在副歌/后续重复行命中上色',
        );

        // 2. 空数组 [] 不得短路回退链路；但切歌把 aiEmotionWords 置 [] 且未清 currentAiTheme 时，不得把旧歌 theme 漏给新歌
        globalThis.aiEmotionWords = [];
        globalThis.currentAiTheme = { emotion_words: [{ word: '夜空', color: '#2b7fff' }] };
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0, globalThis.currentAiTheme).filter(Boolean).length,
            0,
            'aiEmotionWords 已显式置空且 aiData === currentAiTheme 时，不得泄漏旧歌情感词',
        );
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0, { emotion_words: [{ word: '夜空', color: '#f6a' }] }).filter(c => c === '#ff66aa').length,
            2,
            '空 aiEmotionWords 应允许直传 aiData.emotion_words 并把 #f6a 归一化为 #ff66aa',
        );
        globalThis.currentAiTheme = null;
        globalThis.currentSongEmotionData = { emotion_words: [{ word: '夜空', color: '#2b7fff' }] };
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0).filter(Boolean).length,
            2,
            '空 aiEmotionWords 应回退到 currentSongEmotionData.emotion_words',
        );
        globalThis.currentSongEmotionData = null;

        // 3. 字符串条目与空 color 兜底色，同时拒绝非空非法色值
        globalThis.aiEmotionWords = ['夜空'];
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0).filter(c => c === '#e6a832').length,
            2,
            '纯字符串情感词应获得默认高亮兜底色',
        );
        globalThis.aiEmotionWords = [{ word: '夜空', color: 'not-a-color' }];
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0).filter(Boolean).length,
            0,
            '非空非法色值仍应被跳过',
        );

        // 4. astrolabeEmotionStamp 对中间条目变动敏感
        globalThis.aiEmotionWords = [
            { word: '星光', color: '#112233' },
            { word: '夜空', color: '#445566' },
            { word: '温柔', color: '#778899' },
        ];
        const stampBefore = astrolabeEmotionStamp();
        globalThis.aiEmotionWords = [
            { word: '星光', color: '#112233' },
            { word: '夜空', color: '#aabbcc' },
            { word: '温柔', color: '#778899' },
        ];
        assert.notEqual(astrolabeEmotionStamp(), stampBefore, '中间情感词变色必须使缓存指纹失效');

        // 5. 拉丁词边界 + 撇号规范化（dont -> Don't，love 不误染 glove）
        const latinLine = "Don't LOVE my glove";
        const latinGraphemes = Array.from(latinLine).map(char => ({ char }));
        globalThis.aiEmotionWords = [
            { word: 'dont', color: '#33cc88' },
            { word: 'Love', color: '#ff4466' },
        ];
        const latinColors = emotionColorsForGraphemes(latinLine, latinGraphemes, 0);
        assert.deepEqual(latinColors.slice(0, 5), ['#33cc88', '#33cc88', '#33cc88', '#33cc88', '#33cc88'], 'dont 应完整命中并染亮 Don\'t');
        assert.deepEqual(latinColors.slice(6, 10), ['#ff4466', '#ff4466', '#ff4466', '#ff4466'], 'Love 应命中独立单词 LOVE');
        assert.deepEqual(latinColors.slice(14, 19), [null, null, null, null, null], 'Love 不得误染 glove 内部');

        // 6. compileAstrolabeProgram 不腰斩英文单词，且跨块切分的中文短语通过 lineGraphemes + offset 完整着色
        const mixedProg = compileAstrolabeProgram([
            { time: 0, text: '夜空与starlight交织' },
            { time: 4, text: '星光与golden梦境交织' },
            { time: 8, text: '我的心中永远守候着这片璀璨夜空' },
        ], { cutRate: 'normal', durationMs: 12000 });
        const line0TextJoined = mixedProg.shots
            .filter(s => !s.isInterlude && s.lineIndex === 0)
            .map(s => s.graphemes.map(g => g.char).join(''));
        assert.ok(line0TextJoined.some(t => t.includes('starlight')), '英文单词 starlight 不应被分镜切分腰斩');
        const line1TextJoined = mixedProg.shots
            .filter(s => !s.isInterlude && s.lineIndex === 1)
            .map(s => s.graphemes.map(g => g.char).join(''));
        assert.ok(line1TextJoined.some(t => t.includes('golden')), '英文单词 golden 不应被分镜切分腰斩');

        const line2Shots = mixedProg.shots.filter(s => !s.isInterlude && s.lineIndex === 2);
        assert.ok(line2Shots.length >= 2, '长中文行仍应保持多分镜切分');
        globalThis.aiEmotionWords = [{ word: '守候着这', color: '#2b7fff' }];
        const crossChunkColored = line2Shots.reduce((sum, s) => {
            const fullColors = emotionColorsForGraphemes(s.text, s.lineGraphemes, s.lineIndex);
            const sliceColors = fullColors.slice(s.lineGraphemeOffset, s.lineGraphemeOffset + s.graphemes.length);
            return sum + sliceColors.filter(Boolean).length;
        }, 0);
        assert.equal(crossChunkColored, 4, '跨分镜切片边界的中文情感词应通过整行映射完整上色');

        globalThis.appSettings = { lyrics: { emotionWords: false } };
        assert.equal(
            emotionColorsForGraphemes(TEXT, graphemes, 0).filter(Boolean).length,
            0,
            '总开关关闭后必须完全不上色',
        );

        globalThis.appSettings = { lyrics: { emotionWords: true } };
        globalThis.aiEmotionWords = [{ word: '夜空', color: '#2b7fff' }];
        const stampA = astrolabeEmotionStamp();
        globalThis.aiEmotionWords = [{ word: '夜空', color: '#2b7fff' }, { word: 'golden', color: '#e6a832' }];
        assert.notEqual(stampA, astrolabeEmotionStamp(), '情感词表变化必须改变指纹以失效排版缓存');
    } finally {
        globalThis.aiEmotionWords = prevWords;
        globalThis.appSettings = prevSettings;
    }
});

test('A11 印刷成品四档：参数单调性、纸纹 tile 下限与非法档位回退', () => {
    // 未知档位必须回退到默认档，不能返回 undefined
    assert.deepEqual(resolveAstrolabePrintParams('nope'), resolveAstrolabePrintParams('balanced'));
    assert.deepEqual(resolveAstrolabePrintParams(undefined), ASTROLABE_PRINT_LEVELS.balanced);

    const clean = resolveAstrolabePrintParams('clean');
    const balanced = resolveAstrolabePrintParams('balanced');
    const vintage = resolveAstrolabePrintParams('vintage');
    const punch = resolveAstrolabePrintParams('punch');

    // 暗角强度：punch > 其它，且 punch 聚焦更早（innerRatio 更大）
    assert.ok(punch.vignette > balanced.vignette, 'punch 暗角应重于 balanced');
    assert.ok(punch.innerRatio > clean.innerRatio, 'punch 的清晰区应更小（暗角收得更紧）');
    // 颗粒：vintage 最重
    assert.ok(vintage.grainMax > clean.grainMax, 'vintage 颗粒应重于 clean');
    // 残影水印：punch 最明显
    assert.ok(punch.watermark > clean.watermark, 'punch 的水印应更明显');
    // 白底页必须比深底页弱
    for (const level of ['clean', 'balanced', 'vintage', 'punch']) {
        const p = resolveAstrolabePrintParams(level);
        assert.ok(p.tile >= 256, `${level} 的纸纹 tile 不应小于 256，否则大色块上能看出平铺重复`);
        assert.ok(p.vignettePaperMul < 1, `${level} 的白底页暗角必须弱于深底页`);
        assert.ok(p.vignette * p.vignettePaperMul < 0.35, `${level} 的白底页暗角不应压到发灰`);
    }
});
