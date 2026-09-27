/* ============================================================
 * tests/js/test_ab_loop.js — 单句 / A-B 循环的边界判据（todos #3）
 *
 * 循环功能的坑全在边界：判错一次就是"进度条打不过用户"或"死循环拽不回"。
 * 所以这里只测 core/abLoop.js 的纯函数，audio 接线在浏览器测。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineRangeMs, lineStartMs, seekCancelsLoop, shouldRewind, TAIL_SKEW_MS } from '../../web/src/core/abLoop.js';

const L = [
    { start: 0, text: 'a' },
    { start: 4000, text: 'b' },
    { start: 9000, text: 'c' },
    { start: 14000, text: 'd' },
];

test('lineStartMs：只有非负有限数算起点；没有时间戳的行返回 null', () => {
    assert.equal(lineStartMs({ start: 0 }), 0);
    assert.equal(lineStartMs({ start: 4000 }), 4000);
    assert.equal(lineStartMs({ start: -1 }), null, '负数不是合法起点');
    assert.equal(lineStartMs({ start: 'abc' }), null);
    assert.equal(lineStartMs({}), null);
    assert.equal(lineStartMs(null), null);
});

test('lineRangeMs：行尾取下一行的起点（唱完这句就回头）', () => {
    assert.deepEqual(lineRangeMs(L, 1), { start: 4000, end: 9000 });
    assert.deepEqual(lineRangeMs(L, 2), { start: 9000, end: 14000 });
});

test('lineRangeMs：跳过没有合法时间戳的行，不会把区间算成 0', () => {
    const withHoles = [{ start: 0 }, {}, { start: null }, { start: 7000 }];
    assert.deepEqual(lineRangeMs(withHoles, 0), { start: 0, end: 7000 });
});

test('lineRangeMs：最后一行用 end / duration 兜底，再不行给默认 6 秒', () => {
    assert.deepEqual(lineRangeMs([{ start: 1000, end: 3000 }], 0), { start: 1000, end: 3000 });
    assert.deepEqual(lineRangeMs([{ start: 1000, duration: 5000 }], 0), { start: 1000, end: 6000 });
    /* duration 是秒级（<600）时按秒换算，不能把 5 秒当成 5 毫秒 */
    assert.deepEqual(lineRangeMs([{ start: 1000, duration: 5 }], 0), { start: 1000, end: 6000 });
    const r = lineRangeMs([{ start: 1000, text: '只剩一行' }], 0);
    assert.deepEqual(r, { start: 1000, end: 7000 });
});

test('lineRangeMs：越界 / 空数组 / 脏 index 一律返回 null（宁可不循环）', () => {
    assert.equal(lineRangeMs(L, -1), null);
    assert.equal(lineRangeMs(L, L.length), null);
    assert.equal(lineRangeMs(L, 1.5), null, '小数 index 不是行号');
    /* 数字字符串**故意**接受：调用方很可能从 dataset 取 index（el.dataset.i 是字符串），
       拒掉只会让"从界面点哪行循环哪行"这类接线白白多写一层 Number()。 */
    assert.deepEqual(lineRangeMs(L, '1'), { start: 4000, end: 9000 });
    assert.equal(lineRangeMs(L, 'abc'), null, '非数字字符串仍然不行');
    assert.equal(lineRangeMs(L, null), null);
    assert.equal(lineRangeMs([], 0), null);
    assert.equal(lineRangeMs(null, 0), null);
    assert.equal(lineRangeMs(undefined, 0), null);
});

test('shouldRewind：到区间尾回头，区间内不动', () => {
    assert.equal(shouldRewind(8500, 4000, 9000), false);
    assert.equal(shouldRewind(9000, 4000, 9000), true);
    assert.equal(shouldRewind(9200, 4000, 9000), true, '缓冲不足会小跳，仍该拽回');
});

test('shouldRewind：远超区间尾就不再拽回（否则用户拖不出去 = 像卡死）', () => {
    assert.equal(shouldRewind(9000 + TAIL_SKEW_MS - 1, 4000, 9000), true);
    assert.equal(shouldRewind(9000 + TAIL_SKEW_MS + 500, 4000, 9000), false);
});

test('shouldRewind：退化区间（end<=start）永远 false —— 这条会死循环', () => {
    assert.equal(shouldRewind(5000, 5000, 5000), false);
    assert.equal(shouldRewind(5000, 9000, 4000), false);
});

test('shouldRewind：NaN/undefined 不抛也不循环', () => {
    assert.equal(shouldRewind(NaN, 0, 1000), false);
    assert.equal(shouldRewind(undefined, 0, 1000), false);
    assert.equal(shouldRewind(1000, 0, undefined), false);
});

test('seekCancelsLoop：落在区间外就取消，区间内保留', () => {
    assert.equal(seekCancelsLoop(6000, 4000, 9000), false, '区间内不取消');
    assert.equal(seekCancelsLoop(1000, 4000, 9000), true, '拖到前面');
    assert.equal(seekCancelsLoop(20000, 4000, 9000), true, '拖到后面');
    assert.equal(seekCancelsLoop(4000, 4000, 9000), false, 'A 点本身算区间内');
    assert.equal(seekCancelsLoop(9000, 4000, 9000), true, 'B 点算越界（下一帧就该回头了）');
});

test('seekCancelsLoop：区间无效时一律取消，不留一个拽不回来的循环', () => {
    assert.equal(seekCancelsLoop(5000, 5000, 5000), true);
    assert.equal(seekCancelsLoop(5000, NaN, 9000), true);
    assert.equal(seekCancelsLoop(NaN, 4000, 9000), false, '读不到当前时间时不误取消');
});
