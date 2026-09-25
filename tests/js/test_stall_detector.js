/* ============================================================
 * tests/js/test_stall_detector.js — core/stallDetector.js 行为回归
 *
 * 为什么必须有：这个模块是「从 app/70-audio-engine.js 的活实现重新抽取」而来，
 * 抽取过程中最容易丢的就是活版本独有的三处修复（后台节流、6s 确认窗口、
 * bufferedEnd 诊断）。测试盯住行为而非实现细节。
 *
 * 手法：注入假 audio 元素 + 劫持 setTimeout，把 8 秒轮询的回调取出来手动触发，
 * 不需要真的等 8 秒。Node 环境下没有 document，isDocHidden() 恒 false，
 * 需要验证后台保护时再临时挂一个 globalThis.document。
 * ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let scheduled = [];

function installFakeTimers() {
    scheduled = [];
    globalThis.setTimeout = (fn, ms) => {
        const id = { id: scheduled.length, ms, fn };
        scheduled.push(id);
        return id;
    };
    globalThis.clearTimeout = (id) => { if (id && typeof id === 'object') id.cleared = true; };
}

function restoreTimers() {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
}

function makeAudio({ currentTime = 10, paused = false, readyState = 4, bufferedLen = 1 } = {}) {
    const listeners = {};
    return {
        get currentTime() { return currentTime; },
        set currentTime(v) { currentTime = v; },
        paused,
        readyState,
        buffered: { length: bufferedLen, end: () => currentTime + 30 },
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
        fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
        has: (type) => (listeners[type] || []).length > 0,
    };
}

const st = await import('../../web/src/infrastructure/state.js');
const sd = await import('../../web/src/core/stallDetector.js');
const state = st.state;

beforeEach(() => {
    installFakeTimers();
    state.stallTimer = null;
    state.stallLastTime = 0;
    state.stallCheckGeneration = 0;
    state.isBuffering = false;
});
afterEach(() => {
    restoreTimers();
    delete globalThis.document;
});

test('initStallDetector 挂上 stalled / waiting / playing 三个监听', () => {
    const audio = makeAudio();
    sd.initStallDetector(audio, () => {});
    assert.ok(audio.has('stalled'), 'stalled');
    assert.ok(audio.has('waiting'), 'waiting');
    assert.ok(audio.has('playing'), 'playing');
});

test('waiting：置缓冲态并清掉在途的检测定时器', () => {
    const audio = makeAudio();
    sd.initStallDetector(audio, () => {});
    sd.startStallCheck();
    const pending = state.stallTimer;
    audio.fire('waiting');
    assert.equal(state.isBuffering, true);
    assert.equal(state.stallTimer, null, 'waiting 必须清掉 stallTimer');
    assert.equal(pending.cleared, true, '真实 clearTimeout 要被调用');
});

test('playing：解除缓冲态并重启检测', () => {
    const audio = makeAudio();
    sd.initStallDetector(audio, () => {});
    state.isBuffering = true;
    audio.fire('playing');
    assert.equal(state.isBuffering, false);
    assert.ok(state.stallTimer, 'playing 后应重新排定检测');
});

test('currentTime 8 秒未前进 → 触发 onStall（活实现的核心行为）', () => {
    const audio = makeAudio({ currentTime: 42 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();
    const check = state.stallTimer.fn;
    check();                       /* currentTime 未变 → 判定卡死 */
    assert.equal(stalls, 1);
});

test('currentTime 正常前进 → 不误报，并继续排下一次', () => {
    const audio = makeAudio({ currentTime: 42 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();
    audio.currentTime = 50;
    state.stallTimer.fn();
    assert.equal(stalls, 0, '前进 8 秒不该判卡死');
    assert.ok(state.stallTimer, '应继续排下一次检测');
});

test('缓冲中 / 暂停中 → 跳过判定，只重排', () => {
    const audio = makeAudio({ currentTime: 42 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();
    state.isBuffering = true;
    state.stallTimer.fn();
    assert.equal(stalls, 0);
    audio.currentTime = 42;
    state.isBuffering = false;
    audio.paused = true;
    state.stallTimer.fn();
    assert.equal(stalls, 0, 'paused 时不该判卡死');
});

test('后台标签页节流保护：document.hidden 时不判卡死（旧快照缺这条，回归必查）', () => {
    globalThis.document = { hidden: true };
    const audio = makeAudio({ currentTime: 42 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();
    state.stallTimer.fn();
    assert.equal(stalls, 0, '后台不得误判');
});

test('stopStallCheck：清定时器 + 代际作废，在途回调不再判定', () => {
    const audio = makeAudio({ currentTime: 42 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();
    const stale = state.stallTimer.fn;
    sd.stopStallCheck();
    assert.equal(state.stallTimer, null);
    stale();                        /* 过期代际：应直接 return */
    assert.equal(stalls, 0);
});

test('stalled 事件：6 秒确认窗口，且 readyState<3 才判失败', () => {
    const audio = makeAudio({ currentTime: 42, readyState: 1 });
    let stalls = 0;
    sd.initStallDetector(audio, () => { stalls++; });
    sd.startStallCheck();

    audio.fire('stalled');
    const confirm = scheduled[scheduled.length - 1];
    assert.equal(confirm.ms, 6000, '确认窗口必须是 6000ms（旧快照是 3000ms）');
    confirm.fn();
    assert.equal(stalls, 1);
});
