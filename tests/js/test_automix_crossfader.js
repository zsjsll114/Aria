/* ============================================================
 * tests/js/test_automix_crossfader.js — Automix Phase 2 单测
 *
 * 覆盖（方案 §3.3 回归标准：ABORT 3 场景 + 三层策略 + 状态机）：
 *   · equalPowerGains / decideCrossfade 纯函数
 *   · 状态机 IDLE→ARMED→CROSSING→(onSwapped)→IDLE 全流程（volume 路径，
 *     GainNode 路径依赖真实 AudioContext，留给浏览器 E2E）
 *   · ABORT ①手动 abort 恢复 A；②用户干预探针（A pause/seeking）自动 abort；
 *     ③abort 后迟到兜底回调必须被代际守卫丢弃
 *   · ARM 重复保护 / B 起播失败自动 abort
 *
 * 手法：不碰真 DOM。deck 元素为 stub bus（与 test_tempo_boost 同一手法），
 * 时钟/调度/rAF 全部手控注入——「时间」由测试推着走。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* equalizer.js（crossfader 的依赖）读 infrastructure/state.js，node 下可直接导入；
   ensureDeckSource 因 state.eqInited=false 返回 null → 走 volume 路径（正是要测的） */
const { equalPowerGains, initCrossfader, armCrossfade, startCrossing, abortCrossfade,
    crossfaderPhase, crossfadeProgress, _resetCrossfaderForTest,
    CROSSFADER_ARMED, CROSSFADER_CROSSING } = await import('../../web/src/core/automix/crossfader.js');
const { decideCrossfade } = await import('../../web/src/core/automix/decision.js');

function makeEl() {
    const listeners = new Map();
    const el = {
        volume: 1, playbackRate: 1, preservesPitch: false, currentTime: 0, paused: true,
        playedCount: 0,
        play() { el.playedCount++; el.paused = false; return { catch() {} }; },
        pause() { el.paused = true; },
        addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
        removeEventListener(t, fn) { const a = listeners.get(t); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
        dispatch(t) { for (const fn of [...(listeners.get(t) || [])]) fn({ type: t }); },
    };
    return el;
}

/** 手控时钟 + 手控调度：测试推着时间走 */
function makeClock() {
    let nowMs = 0;
    let seq = 0;
    const pending = [];
    return {
        now: () => nowMs,
        advance(ms) { nowMs += ms; },
        schedule(fn, ms) { const h = { fn, ms, id: ++seq }; pending.push(h); return h; },
        cancelScheduled(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
        raf(fn) { const h = { fn, raf: true, id: ++seq }; pending.push(h); return h; },
        caf(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
        /** 执行一轮 rAF 帧（执行中新增的下一帧留在队列） */
        fireRaf() {
            const frames = pending.filter(t => t.raf);
            for (const f of frames) { const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); f.fn(); }
            return frames.length;
        },
        /** 触发所有 schedule 兜底（不推进时钟） */
        fireScheduled() {
            const all = pending.filter(t => !t.raf);
            for (const f of all) { const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); f.fn(); }
            return all.length;
        },
        pendingCount: () => pending.length,
    };
}

function setup({ overlapMs = 4000, rate = 1 } = {}) {
    _resetCrossfaderForTest();
    const clock = makeClock();
    const a = makeEl();
    const b = makeEl();
    const events = { swapped: 0, aborted: [], points: [], progress: [] };
    initCrossfader({
        getDecks: () => ({ a, b }),
        now: clock.now,
        schedule: clock.schedule,
        cancelScheduled: clock.cancelScheduled,
        raf: clock.raf,
        caf: clock.caf,
        onSwapPoint: (info) => { events.points.push(info && info.progress); },
        onProgress: (p) => { events.progress.push(p); },
        onSwapped: () => { events.swapped++; },
        onAborted: (reason) => { events.aborted.push(reason); },
    });
    const ok = armCrossfade({ overlapMs, rate });
    return { clock, a, b, events, ok };
}

test('equalPowerGains：端点与中点、越界钳制', () => {
    assert.deepEqual(equalPowerGains(0), { gainA: 1, gainB: 0 });
    const mid = equalPowerGains(0.5);
    assert.ok(Math.abs(mid.gainA - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs(mid.gainB - Math.SQRT1_2) < 1e-9);
    assert.deepEqual(equalPowerGains(1), { gainA: 0, gainB: 1 });
    assert.deepEqual(equalPowerGains(-3), { gainA: 1, gainB: 0 });
    assert.deepEqual(equalPowerGains(7), { gainA: 0, gainB: 1 });
});

test('decideCrossfade：三层策略', () => {
    const A = { bpm: 120, bpmConfidence: 3, outroPointMs: 200000 };
    /* 对拍：gap 2 ≤ 8 且 rate 偏差 1.7% ≤ 5% */
    assert.equal(decideCrossfade(A, { bpm: 122, bpmConfidence: 3, introPointMs: 500 }), 'beatmatch');
    /* gap 2 但 rate 偏差 8.3% > 5% → 呼吸点 */
    assert.equal(decideCrossfade(A, { bpm: 130, bpmConfidence: 3, introPointMs: 500 }), 'breath');
    /* 8 < gap ≤ 30 → 呼吸点 */
    assert.equal(decideCrossfade(A, { bpm: 140, bpmConfidence: 3, introPointMs: 500 }), 'breath');
    /* gap > 30 → segue */
    assert.equal(decideCrossfade(A, { bpm: 160, bpmConfidence: 3, introPointMs: 500 }), 'segue');
    /* 置信度不足 → 最保守 segue */
    assert.equal(decideCrossfade(A, { bpm: 121, bpmConfidence: 0.4, introPointMs: 500 }), 'segue');
    assert.equal(decideCrossfade(A, { bpm: null, bpmConfidence: 9, introPointMs: 500 }), 'segue');
    /* 分析缺失 / 无有效出口 → 不 automix */
    assert.equal(decideCrossfade(null, { bpm: 120, bpmConfidence: 3 }), 'none');
    assert.equal(decideCrossfade({ bpm: 120, bpmConfidence: 3, outroPointMs: 0 }, { bpm: 120, bpmConfidence: 3 }), 'none');
});

test('状态机全流程：ARMED → CROSSING → rAF 推满 → onSwapped + 归位 IDLE', () => {
    const s = setup({ overlapMs: 4000 });
    assert.equal(s.ok, true);
    assert.equal(crossfaderPhase(), CROSSFADER_ARMED);
    assert.equal(startCrossing(), true);
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING);
    assert.equal(s.b.playedCount, 1, 'B 已起播');
    /* 推 3 帧，每帧 +2s：p=0.5 → 1.0（第二帧即完成），第三帧无 rAF */
    s.clock.advance(2000); s.clock.fireRaf();
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING);
    assert.ok(s.a.volume < 1 && s.a.volume > 0, 'A 已开始淡出');
    assert.ok(s.b.volume > 0 && s.b.volume < 1, 'B 已开始淡入');
    s.clock.advance(2000); s.clock.fireRaf();
    assert.equal(crossfaderPhase(), 'IDLE', '曲线走完自动完成');
    assert.equal(s.events.swapped, 1, 'onSwapped 恰好一次');
    assert.ok(s.pendingCount === 0 || s.clock.fireScheduled() === 0, '完成兜底已被清理，无悬挂句柄');
});

test('ABORT ①：CROSSING 中手动 abort → B 静音暂停、A 恢复交叉前音量、迟到兜底被丢弃', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    s.clock.advance(1000); s.clock.fireRaf();   /* 交叉 1/4 */
    assert.ok(s.a.volume < 1);
    const savedScheduled = s.clock.pendingCount();
    assert.equal(abortCrossfade('test'), true);
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.b.paused, true, 'B 已暂停');
    assert.equal(s.b.currentTime, 0, 'B 已归零');
    assert.equal(s.a.volume, 1, 'A 恢复交叉前音量');
    assert.equal(s.events.aborted.length, 1);
    /* ABORT ③（同场景）：abort 前挂的兜底句柄即便被外部触发也必须静默 */
    s.clock.fireScheduled();
    s.clock.fireRaf();
    assert.equal(s.events.swapped, 0, '迟到回调不得触发 swap');
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.ok(savedScheduled >= 0);
});

test('ABORT ②：CROSSING 中用户 pause A → 干预探针自动 abort', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    s.clock.advance(500); s.clock.fireRaf();
    s.a.dispatch('pause');
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.events.aborted[0], 'user-intervene:pause');
    assert.equal(s.b.paused, true);
    /* 完成探针摘除：再派发不再重复 abort */
    s.a.dispatch('pause');
    s.a.dispatch('seeking');
    assert.equal(s.events.aborted.length, 1);
});

test('ARM 重复保护与 IDLE abort：', () => {
    const s = setup({ overlapMs: 4000 });
    assert.equal(startCrossing(), true);
    /* CROSSING 中再 ARM 必须拒绝 */
    assert.equal(armCrossfade({ overlapMs: 2000 }), false);
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING);
    abortCrossfade('reset');
    /* IDLE 时 abort 是 no-op */
    assert.equal(abortCrossfade('again'), false);
    assert.equal(s.events.aborted.length, 1);
});

test('对拍速率：rate 写入 B 的 playbackRate + preservesPitch，重叠时长按速率缩放', () => {
    const s = setup({ overlapMs: 4000, rate: 1.02 });
    startCrossing();
    assert.equal(s.b.playbackRate, 1.02);
    assert.equal(s.b.preservesPitch, true);
    /* rAF 帧以 T/rate=3922ms 为分母：推 2000ms 后 p>0.5 */
    s.clock.advance(2000); s.clock.fireRaf();
    const g = equalPowerGains(2000 / (4000 / 1.02));
    assert.ok(Math.abs(s.a.volume - 0.8 * g.gainA) < 1e-9, `A volume=${s.a.volume}`);
    assert.equal(abortCrossfade('done'), true);
});

test('B 起播失败（play reject）→ 自动 abort', async () => {
    _resetCrossfaderForTest();
    const clock = makeClock();
    const a = makeEl();
    const b = makeEl();
    b.play = () => ({ catch(fn) { fn(new Error('NotAllowed')); } });
    const events = { aborted: [] };
    initCrossfader({
        getDecks: () => ({ a, b }),
        now: clock.now, schedule: clock.schedule, cancelScheduled: clock.cancelScheduled,
        raf: clock.raf, caf: clock.caf,
        onSwapped: () => {}, onAborted: (r) => events.aborted.push(r),
    });
    armCrossfade({ overlapMs: 4000 });
    startCrossing();
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(events.aborted[0], 'b-play-failed');
});

/* ---------- 交接点：进度过半提前交接，曲线继续走完 ---------- */

test('交接点：进度过半触发一次 onSwapPoint，曲线继续走完才 onSwapped', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    assert.equal(crossfadeProgress(), 0, 'CROSSING 起点进度为 0');
    s.clock.advance(2000); s.clock.fireRaf();          /* p = 0.5 → 越点 */
    assert.equal(s.events.points.length, 1, '交接点恰好触发一次');
    assert.ok(Math.abs(s.events.points[0] - 0.5) < 1e-9, `越点进度=${s.events.points[0]}`);
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING, '★ 越点 ≠ 结束：曲线仍在走');
    assert.equal(s.events.swapped, 0, '曲线未走完，onSwapped 尚未触发');
    s.clock.advance(2000); s.clock.fireRaf();          /* p = 1 → 完成 */
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.events.swapped, 1, 'onSwapped 恰好一次');
    assert.equal(s.events.points.length, 1, '交接点不重复触发');
    assert.equal(crossfadeProgress(), null, '非 CROSSING 期进度为 null');
});

test('进度上报：CROSSING 期逐帧推 0~1，结束即停', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    s.clock.advance(1000); s.clock.fireRaf();
    assert.equal(s.events.progress.length, 1);
    assert.ok(Math.abs(s.events.progress[0] - 0.25) < 1e-9);
    s.clock.advance(3000); s.clock.fireRaf();          /* p = 1 → 完成，不再推 */
    const nAtDone = s.events.progress.length;
    assert.equal(s.events.progress[nAtDone - 1], 1, '最后一帧推到 1');
    s.clock.fireRaf();
    assert.equal(s.events.progress.length, nAtDone, '完成后不再上报');
});

test('交接点后 abort 退化为「立即完成」：不产生 onAborted，且走 onSwapped 收尾', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    s.clock.advance(2000); s.clock.fireRaf();          /* 越点 */
    assert.equal(s.events.points.length, 1);
    assert.equal(abortCrossfade('user-intervene:pause'), true);
    assert.equal(crossfaderPhase(), 'IDLE');
    assert.equal(s.events.swapped, 1, '走的是完成路径（UI 已切到 B，回滚会更糟）');
    assert.equal(s.events.aborted.length, 0, '不通知 abort');
});

test('B 的干预探针：交接点前忽略、交接点后 abort', () => {
    const s = setup({ overlapMs: 4000 });
    startCrossing();
    s.clock.advance(1000); s.clock.fireRaf();          /* p = 0.25，未越点 */
    s.b.dispatch('pause');                             /* B 的 pause 不算用户干预 */
    assert.equal(crossfaderPhase(), CROSSFADER_CROSSING, '越点前 B 的 pause 被忽略');
    s.clock.advance(1500); s.clock.fireRaf();          /* p = 0.625 → 越点 */
    assert.equal(s.events.points.length, 1);
    s.b.dispatch('pause');                             /* 越点后 B 才是「当前元素」 */
    assert.equal(crossfaderPhase(), 'IDLE');
    /* 越点后退化为立即完成，因此走的是 onSwapped 而不是 onAborted */
    assert.equal(s.events.swapped, 1);
    assert.equal(s.events.aborted.length, 0);
});
