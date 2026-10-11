/* ============================================================
 * tests/js/test_lyric_scene_grouper.js — core/lyricSceneGrouper.js 行为回归
 *
 * 为什么补：该文件此前**没有任何测试**，却决定 PV / 活字 / 蒙德里安等模式的
 * 「哪几句在一起」与段落类型（chorus/break/outro/breath/lift/verse，直接影响纸色
 * 与构图节奏）。`noUncheckedIndexedAccess` 在它上面报 5 条，落在
 * median 的 sorted[mid-1]/sorted[mid]、tagOf 的 m[1]、splitOversizedDraft 的
 * candidates[0] 与 remaining[last] 上——都是「取首/取中/取末」这类最容易改错的索引。
 *
 * 覆盖：
 *   · lineStartOf / lineEndOf  字段兼容（start vs time、end vs duration）与兜底
 *   · resolveGapThreshold      中位数×2.5 与 1.25~3.5 钳制（含全重叠→无正间隙）
 *   · classifyScene            六种 kind 的判据（含中英字密度归一化那条修复）
 *   · buildSceneGroups         间隙边界 / 段落标记边界 / maxLines 与跨度上限 / 不变量 / 确定性
 * 运行：node --test tests/js/test_lyric_scene_grouper.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    lineStartOf,
    lineEndOf,
    resolveGapThreshold,
    classifyScene,
    buildSceneGroups,
} from '../../web/src/core/lyricSceneGrouper.js';

const KINDS = ['chorus', 'break', 'outro', 'breath', 'lift', 'verse'];

/* ==================== 时间字段兼容 ==================== */

test('lineStartOf：start 优先、time 兜底、脏输入归 0', () => {
    assert.equal(lineStartOf({ start: 1234 }), 1234);
    assert.equal(lineStartOf({ time: 5678 }), 5678);
    assert.equal(lineStartOf({ start: 1, time: 2 }), 1, 'start 优先');
    assert.equal(lineStartOf({}), 0);
    assert.equal(lineStartOf(null), 0);
    assert.equal(lineStartOf({ start: 'abc' }), 0, '非数字归 0');
});

test('lineEndOf：end 优先、其次 start+duration、下限 200ms', () => {
    assert.equal(lineEndOf({ start: 1000, end: 2000 }), 2000);
    assert.equal(lineEndOf({ start: 1000, duration: 500 }), 1500);
    assert.equal(lineEndOf({ start: 1000, duration: 10 }), 1200, 'duration 下限 200ms');
    assert.equal(lineEndOf({ start: 3000, end: 1000 }), 3000, 'end < start 时钳到 start');
    assert.equal(lineEndOf({ start: 1000 }), 4000, '无 duration 兜底 3000ms');
    assert.equal(lineEndOf(null), 3000);
});

/* ==================== 自适应间隙阈值 ==================== */

test('resolveGapThreshold：median(正间隙)×2.5', () => {
    const lines = [
        { start: 0, end: 1000 },
        { start: 2000, end: 3000 },
        { start: 4000, end: 5000 },
    ];
    assert.equal(resolveGapThreshold(lines), 2.5, '间隙 1s → 1×2.5');
});

test('resolveGapThreshold：钳制在 1.25~3.5s', () => {
    assert.equal(resolveGapThreshold([{ start: 0, end: 1000 }, { start: 1100, end: 2100 }]), 1.25,
        '间隙 0.1s → 0.25 → 抬到下限 1.25');
    assert.equal(resolveGapThreshold([{ start: 0, end: 1000 }, { start: 11000, end: 12000 }]), 3.5,
        '间隙 10s → 25 → 压到上限 3.5');
});

test('resolveGapThreshold：无正间隙（全重叠/单行）→ 下限 1.25', () => {
    assert.equal(resolveGapThreshold([{ start: 0, end: 5000 }, { start: 1000, end: 6000 }]), 1.25);
    assert.equal(resolveGapThreshold([{ start: 0, end: 1000 }]), 1.25);
    assert.equal(resolveGapThreshold([]), 1.25);
});

/* ==================== 段落类型判定 ==================== */

test('classifyScene：段落标记优先（chorus / break）', () => {
    assert.equal(classifyScene([{ original: '(Chorus) hello' }], 0, 4), 'chorus');
    assert.equal(classifyScene([{ original: '（副歌）你好' }], 0, 4), 'chorus');
    assert.equal(classifyScene([{ original: '(间奏)' }], 0, 4), 'break');
    assert.equal(classifyScene([{ flag: 'chorus' }], 0, 4), 'chorus', 'flag 字段同样生效');
});

test('classifyScene：末段归 outro', () => {
    const line = { start: 0, end: 10000, original: '今天天气真的很好' };
    assert.equal(classifyScene([line], 0, 1), 'outro');
    assert.equal(classifyScene([line], 2, 3), 'outro');
});

test('classifyScene：过短或字太少归 breath', () => {
    assert.equal(classifyScene([{ start: 0, end: 1000, original: '今天天气真的很好' }], 0, 4), 'breath',
        '时长 1s ≤3.5s');
    assert.equal(classifyScene([{ start: 0, end: 10000, original: '你好' }], 0, 4), 'breath',
        '视觉单元 2 ≤6');
});

test('classifyScene：标点密集或字密度高归 lift', () => {
    assert.equal(classifyScene([{ start: 0, end: 10000, original: '今天天气真的很好！！' }], 0, 4), 'lift',
        '2 个标点即 lift');
});

test('classifyScene：英文按「词」计单元（中英 kind 分布一致，用户反馈的那条修复）', () => {
    /* 英文行字符数天然是中文的 3~5 倍；若按「去空格字符数」算密度（43 字符 / 10s = 4.3 > 2.5）
       这一行会被判成 lift。归一化后一个英文词 ≈ 一个汉字 → 8 单元，密度 0.8，应落回 verse。
       注意字数守卫是 `unitCount <= 6 → breath`，故选例必须 >6 个词，否则测的是守卫而非密度。 */
    const enLine = { start: 0, end: 10000, original: 'the quick brown fox jumps over lazy dogs' };
    assert.equal(classifyScene([enLine], 0, 4), 'verse',
        '8 个词 → 8 单元，密度 0.8，不该判成 lift；也不该因字数守卫判成 breath');
});

/* ==================== 主入口 ==================== */

test('buildSceneGroups：空/非法输入 → 空数组', () => {
    assert.deepEqual(buildSceneGroups([]), []);
    assert.deepEqual(buildSceneGroups(), []);
    assert.deepEqual(buildSceneGroups(null), []);
    assert.deepEqual(buildSceneGroups('not-array'), []);
});

/** 10 行、每行 0.5s、行间 0.5s 空隙的规整歌词 */
function regularLines(n = 10) {
    return Array.from({ length: n }, (_, i) => ({
        start: i * 1000,
        end: i * 1000 + 500,
        original: '今天天气真的很好',
    }));
}

test('buildSceneGroups：maxLines 上限与跨度上限都必须守住', () => {
    const scenes = buildSceneGroups(regularLines(10), { gapThresholdSec: 2 });
    assert.ok(scenes.length >= 2, `应切成多组，实际 ${scenes.length}`);
    for (const s of scenes) {
        assert.ok(s.lines.length >= 1 && s.lines.length <= 4,
            `每组行数应在 1~4，实际 ${s.lines.length}`);
        const span = lineEndOf(s.lines[s.lines.length - 1]) - lineStartOf(s.lines[0]);
        assert.ok(span <= 6500 + 1000, `组内跨度 ${span}ms 不应明显超过上限 6500ms`);
        assert.equal(s.boundary, 'mixed');
    }
});

test('buildSceneGroups：maxLines 被钳到 [1,8]', () => {
    const scenes = buildSceneGroups(regularLines(10), { maxLines: 100, gapThresholdSec: 2 });
    for (const s of scenes) {
        assert.ok(s.lines.length <= 8, `maxLines 上界应钳到 8，实际 ${s.lines.length}`);
    }
});

test('buildSceneGroups：行间大间隙切出段落边界', () => {
    const lines = [
        { start: 0, end: 500, original: '第一行歌词哦' },
        { start: 1000, end: 1500, original: '第二行歌词哦' },
        { start: 9000, end: 9500, original: '第三行歌词哦' },
    ];
    const scenes = buildSceneGroups(lines, { gapThresholdSec: 2 });
    assert.equal(scenes.length, 2, '7.5s 的大间隙应切断');
    assert.deepEqual(scenes[0].lines.map((l) => l.start), [0, 1000]);
    assert.deepEqual(scenes[1].lines.map((l) => l.start), [9000]);
});

test('buildSceneGroups：段落标记变化切出边界，且 kind 随之改变', () => {
    const lines = [
        { start: 0, end: 500, original: '(Verse) 主歌一句' },
        { start: 1000, end: 1500, original: '(Chorus) 副歌一句' },
    ];
    const scenes = buildSceneGroups(lines, { gapThresholdSec: 2 });
    assert.equal(scenes.length, 2, '标记从 verse 变 chorus 应切断');
    assert.equal(scenes[1].kind, 'chorus', '带 (Chorus) 标记的段落应判为 chorus');
});

test('buildSceneGroups：输出不变量（kind 合法、时间有限、按 start 升序）', () => {
    const scenes = buildSceneGroups(regularLines(12));
    assert.ok(scenes.length > 0);
    for (const s of scenes) {
        assert.ok(KINDS.includes(s.kind), `kind 应 ∈${KINDS.join('/')}，实际 ${s.kind}`);
        assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end), `时间应有限：${s.start}~${s.end}`);
        assert.ok(s.end >= s.start, `end(${s.end}) 不应早于 start(${s.start})`);
        assert.ok(s.lines.length >= 1, '每组至少一行');
    }
    for (let i = 1; i < scenes.length; i++) {
        assert.ok(scenes[i].start >= scenes[i - 1].start, '场景应按 start 升序');
    }
});

test('buildSceneGroups：确定性 —— 同输入两次结果一致', () => {
    const a = buildSceneGroups(regularLines(12));
    const b = buildSceneGroups(regularLines(12));
    assert.deepEqual(a, b, '纯分句器必须确定性');
});
