/* ============================================================
 * tests/js/test_view_mode_stage.js — 全屏模式的「舞台底」不变量
 *
 * 背景（2026-10-05 用户报障）：活字模式放 MV 时，mv.css 会把舞台的深底
 * 透明化（目的正是露出 MV），结果**底下默认模式那整列播放器**当场穿帮露出来 ——
 * 因为活字只藏了 `.lyrics-area-wrapper`，一直靠不透明底去盖 `.player-controls-wrapper`。
 * 霓虹有同一处缺陷。
 *
 * 不变量：凡是用"整屏舞台盖住默认布局"的全屏模式，必须**显式 display:none
 * 整列播放器**，不能依赖"舞台底把它盖住"这种隐式关系 —— 那种关系在 MV
 * 透明化时会瞬间失效，而且只在不常见的组合下复现。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const STYLES = path.join(REPO, 'web/src/styles');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (f) => stripComments(fs.readFileSync(path.join(STYLES, f), 'utf8'));

const CSS_FILES = fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'));
const ALL_CSS = CSS_FILES.map(read).join('\n');
const MV_CSS = read('mv.css');

/** 用整屏 absolute 舞台盖住默认布局的全屏模式（wordcloud 不在此列：它用
 *  相对定位 + z-index 把播放列浮在上层，本来就不盖） */
const STAGE_MODES = ['pv', 'tempera', 'dimension', 'tunnel', 'letterpress', 'neon', 'jizura'];

/** 舞台类名 → 模式名（这些模式的底由 mv.css 直接改成 transparent） */
const STAGE_TO_MODE = {
    'vis-dimension-stage': 'dimension',
    'visualizer-stage-neon': 'neon',
    'visualizer-stage-letterpress': 'letterpress',
    'visualizer-stage-jizura': 'jizura',
};

/** 扫出「把 background 透明化」的规则，收集被透明化的模式名 */
function transparentizedModes() {
    const modes = new Set();
    for (const m of MV_CSS.matchAll(/([^{}]{1,400}?)\{([^{}]{0,400}?background:\s*transparent[^{}]{0,400}?)\}/g)) {
        const selector = m[1];
        for (const v of selector.matchAll(/\.view-([a-z]+)/g)) modes.add(v[1]);
        for (const [cls, mode] of Object.entries(STAGE_TO_MODE)) {
            if (selector.includes(cls)) modes.add(mode);
        }
    }
    return modes;
}

/** 取所有"给某模式的播放列设过 display"的规则体 */
function playerColumnRules(mode) {
    const re = new RegExp('\\.view-' + mode + '\\s+\\.player-controls-wrapper');
    return [...ALL_CSS.matchAll(/([^{}]{1,600}?)\{([^{}]{0,400}?)\}/g)]
        .filter((m) => re.test(m[1]))
        .map((m) => m[2]);
}

test('V1 mv.css 里"被透明化背景"的模式集合 = 已知的 5 个（解析失效会立刻红）', () => {
    /* ★ tunnel 刻意不在其中：它不把舞台底改透明，而是把 .tunnel-layer-bg 压到 0.2、
       .t-m-bg 压到 0（mv.css 的另一组规则），色块另由引擎按 mvBackdropAlpha 处理。
       所以"透明化"这套写法目前只覆盖 pv / tempera / dimension / neon / letterpress。 */
    const EXPECTED = ['dimension', 'jizura', 'letterpress', 'neon', 'pv', 'tempera'];
    assert.deepEqual([...transparentizedModes()].sort(), EXPECTED.slice().sort(),
        'mv.css 透明化的模式集合变了：新增/删除了全屏模式？请同步确认它的播放列显隐');
});

test('V2 每个全屏舞台模式都必须显式隐藏整列播放器', () => {
    const missing = STAGE_MODES.filter((m) => playerColumnRules(m).length === 0);
    assert.deepEqual(missing, [],
        `这些模式没藏 .player-controls-wrapper —— 开 MV 时默认模式的播放列会穿帮: ${missing.join(', ')}`);
});

test('V3 隐藏必须用 display:none（visibility/opacity 仍占 340~420px flex 宽度）', () => {
    const bad = STAGE_MODES.filter((m) => !playerColumnRules(m).some((body) => /display:\s*none/.test(body)));
    assert.deepEqual(bad, [], `这些模式的播放列隐藏方式不对（应为 display:none）: ${bad.join(', ')}`);
});

test('V4 反例守卫：歌词区与播放列必须成对隐藏（只藏一个就是本次踩的坑）', () => {
    const bad = STAGE_MODES.filter((m) => {
        const hasLyrics = new RegExp('\\.view-' + m + '\\s+\\.lyrics-area-wrapper').test(ALL_CSS);
        const hasPlayer = playerColumnRules(m).length > 0;
        return hasLyrics !== hasPlayer;
    });
    assert.deepEqual(bad, [],
        `这些模式只藏了歌词区与播放列中的一个（另一个靠不透明底盖着，MV 时会穿帮）: ${bad.join(', ')}`);
});
