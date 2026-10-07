/* ============================================================
 * tests/js/test_hearing_guard.js — 听力健康提醒状态机（core/hearingGuard.js）
 *
 * 时间源注入，直接把「2 小时」推进出来，不用等。
 *
 * ★ 状态机以**两次采样之间的增量 dt** 计时，所以每条用例都必须：
 *     先 sample 一次建立基准（此时 dt=0）→ advance(...) → 再 sample 取判定。
 *   少了第一拍，dt 恒为 0，什么都不会触发 —— 这是本文件最容易写错的地方。
 *
 * 盯住四条：
 *   ① 连续播放到点提醒，且提醒后累计归零（不会每周期弹一次）；
 *   ② 音量偏高累积到点提醒，掉回阈值以下要清零累积；
 *   ③ 暂停够久才清零连续计时（短暂停不该抹掉累计）；
 *   ④ 同一类提醒有冷却。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createHearingGuard, CONTINUOUS_LIMIT_MS, LOUD_LIMIT_MS, LOUD_VOLUME_PCT,
    COOLDOWN_MS, RESET_AFTER_PAUSE_MS,
} from '../../web/src/core/hearingGuard.js';

/** 可控时钟 */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

test('连续播放到点提醒一次，且不会每个采样周期都弹', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    assert.equal(g.sample(true, 60), null, '第一拍只建立基准（dt=0）');
    c.advance(CONTINUOUS_LIMIT_MS);
    const first = g.sample(true, 60);
    assert.equal(first && first.kind, 'continuous');
    assert.equal(first.minutes, 120);
    /* 紧接着再采样：累计已归零，不该立刻再弹 */
    c.advance(10_000);
    assert.equal(g.sample(true, 60), null, '提醒后不能每个周期都弹');
    /* 再过 2 小时才有第二次 */
    c.advance(CONTINUOUS_LIMIT_MS);
    assert.equal((g.sample(true, 60) || {}).kind, 'continuous');
});

test('音量偏高累积到点提醒，掉回阈值以下清零累积', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, LOUD_VOLUME_PCT);            /* 基准 */
    c.advance(LOUD_LIMIT_MS - 60_000);
    assert.equal(g.sample(true, LOUD_VOLUME_PCT), null, '还差 1 分钟，不该提醒');
    g.sample(true, LOUD_VOLUME_PCT - 1);        /* 同刻降音量：累积清零 */
    c.advance(LOUD_LIMIT_MS);
    const warn = g.sample(true, LOUD_VOLUME_PCT);
    assert.equal(warn && warn.kind, 'loud', '降过音量后需重新累积满 30 分钟才提醒');
    assert.equal(warn.volume, LOUD_VOLUME_PCT);
});

test('音量刚好在阈值下方不触发', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, LOUD_VOLUME_PCT - 1);        /* 基准 */
    c.advance(LOUD_LIMIT_MS * 3);
    assert.equal(g.sample(true, LOUD_VOLUME_PCT - 1), null);
});

test('暂停短于重置阈值：累计不丢，恢复后很快到点', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, 60);
    c.advance(CONTINUOUS_LIMIT_MS - 60_000);
    assert.equal(g.sample(true, 60), null, '已累计 ~1h59m，还差 1 分钟');
    g.sample(false, 60);                        /* 暂停 */
    c.advance(60_000);
    const w = g.sample(true, 60);               /* 恢复：暂停仅 1 分钟 → 累计保留 */
    assert.equal(w && w.kind, 'continuous', '短暂停不该抹掉 2 小时的累计');
});

test('暂停超过 5 分钟：连续计时清零，不会立刻提醒', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, 60);
    c.advance(CONTINUOUS_LIMIT_MS - 1000);
    g.sample(true, 60);                         /* 已累计 ~2h-1s */
    g.sample(false, 60);
    c.advance(RESET_AFTER_PAUSE_MS + 1000);
    assert.equal(g.sample(true, 60), null, '休息够久就该重新计时');
});

test('同类提醒有冷却（不会因为反复调音量连续弹）', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, 95);                         /* 基准 */
    c.advance(LOUD_LIMIT_MS);
    assert.equal((g.sample(true, 95) || {}).kind, 'loud');
    c.advance(LOUD_LIMIT_MS / 2);
    assert.equal(g.sample(true, 95), null, '冷却期内不重复提醒');
    c.advance(COOLDOWN_MS);
    assert.equal((g.sample(true, 95) || {}).kind, 'loud', '冷却结束且重新累积后应再提醒');
});

test('非法音量不炸也不触发', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, NaN);
    c.advance(LOUD_LIMIT_MS * 2);
    assert.equal(g.sample(true, NaN), null);
    assert.equal(g.sample(true, undefined), null);
    assert.equal(g.sample(true, 'abc'), null);
});

test('reset 清空全部状态', () => {
    const c = clock();
    const g = createHearingGuard({ now: c.now });
    g.sample(true, 60);                         /* 基准 */
    c.advance(CONTINUOUS_LIMIT_MS);
    assert.equal((g.sample(true, 60) || {}).kind, 'continuous');
    g.reset();
    const snap = g.snapshot();
    assert.equal(snap.playedMs, 0);
    assert.equal(snap.loudMs, 0);
    assert.equal(snap.lastWarn.continuous, 0);
});

test('snapshot 暴露阈值，便于诊断页展示', () => {
    const g = createHearingGuard({ now: () => 0 });
    const snap = g.snapshot();
    assert.equal(snap.limits.CONTINUOUS_LIMIT_MS, CONTINUOUS_LIMIT_MS);
    assert.equal(snap.limits.LOUD_VOLUME_PCT, LOUD_VOLUME_PCT);
    assert.equal(snap.limits.RESET_AFTER_PAUSE_MS, RESET_AFTER_PAUSE_MS);
});
