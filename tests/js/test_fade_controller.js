/* ============================================================
 * tests/js/test_fade_controller.js — core/fadeController.js 行为回归
 *
 * 盯的是活实现（app/135-crossfade.js）独有的那几处修复，旧快照都没有：
 *   · 双向取消（淡入要取消在途淡出，反之亦然），否则竞争会把音量卡在 0；
 *   · setTimeout 兜底：后台标签页 rAF 被节流时，音量和回调仍必须到位；
 *   · 淡入时长上限 1000ms + 正弦缓动 + 起始音量压到 target*0.35。
 * 手法：假 audio + 劫持 rAF/setTimeout/performance.now，手动推进时间。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const st = await import('../../web/src/infrastructure/state.js');
const fc = await import('../../web/src/core/fadeController.js');
const state = st.state;

const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;
const realNow = performance.now.bind(performance);

let clock, rafQueue, timers, cancelledRafs, cancelledTimers;

function install() {
    clock = 0;
    rafQueue = [];
    timers = [];
    cancelledRafs = new Set();
    cancelledTimers = new Set();
    performance.now = () => clock;
    globalThis.requestAnimationFrame = (fn) => { const id = rafQueue.length + 1; rafQueue.push({ id, fn }); return id; };
    globalThis.cancelAnimationFrame = (id) => { cancelledRafs.add(id); rafQueue = rafQueue.filter((r) => r.id !== id); };
    globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, id: timers.length + 1 }; timers.push(t); return t; };
    globalThis.clearTimeout = (t) => { if (t && typeof t === 'object') { t.cancelled = true; cancelledTimers.add(t.id); } };
}
function restore() {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancelRaf;
    performance.now = realNow;
}
/* 把当前排队的 rAF 全部按推进到 now 的时序跑完 */
function runFrames(now) {
    const batch = rafQueue.splice(0, rafQueue.length);
    clock = now;
    batch.forEach((r) => { if (!cancelledRafs.has(r.id)) r.fn(now); });
    return batch.length;
}

function setup({ fadeInOut = true, fadeDuration = 500, volume = 0.8 } = {}) {
    state.appSettings = { playback: { fadeInOut, fadeDuration } };
    state.fadeOutVolumeRafId = null;
    state.fadeInVolumeRafId = null;
    state.fadeOutVolumeTimeoutId = null;
    state.fadeInVolumeTimeoutId = null;
    const audio = { volume };
    fc.initFadeController(audio);
    return audio;
}

beforeEach(install);

test('fadeOutVolume：淡入淡出关闭时立即回调且不动音量', () => {
    const audio = setup({ fadeInOut: false });
    let called = 0;
    fc.fadeOutVolume(500, () => { called++; });
    assert.equal(called, 1);
    assert.equal(audio.volume, 0.8);
});

test('fadeOutVolume：逐帧降到 0，末帧触发回调并清掉兜底 timeout', () => {
    const audio = setup({ volume: 1 });
    let called = 0;
    fc.fadeOutVolume(1000, () => { called++; });
    runFrames(500);
    assert.ok(audio.volume > 0 && audio.volume < 1, '中途应在 0~1 之间');
    runFrames(1000);
    assert.equal(called, 1, '末帧必须回调');
    assert.equal(state.fadeOutVolumeTimeoutId, null, '末帧要清掉兜底定时器');
    assert.equal(timers.find((t) => !t.cancelled && t.fn), undefined, '所有兜底 timeout 应已取消');
});

test('后台标签页兜底：rAF 一次都不跑，timeout 仍把音量归零并回调（旧快照没这条）', () => {
    const audio = setup({ volume: 1 });
    let called = 0;
    fc.fadeOutVolume(400, () => { called++; });
    const fallback = timers[timers.length - 1];
    assert.equal(fallback.ms, 500, '兜底窗口 = duration + 100');
    fallback.fn();
    assert.equal(audio.volume, 0);
    assert.equal(called, 1);
});

test('淡入取消在途淡出：避免竞争把音量卡在 0（旧快照没这条）', () => {
    const audio = setup({ volume: 0.9 });
    fc.fadeOutVolume(1000, () => {});
    const outRaf = state.fadeOutVolumeRafId;
    const outTimer = state.fadeOutVolumeTimeoutId;
    fc.fadeInVolume(0.9, 600);
    assert.equal(state.fadeOutVolumeRafId, null, '淡出 rAF 必须被取消');
    assert.ok(cancelledRafs.has(outRaf), 'cancelAnimationFrame 要真的被调用');
    assert.equal(outTimer.cancelled, true, '淡出的兜底 timeout 必须取消，否则会把淡入好的音量又压到 0');
    runFrames(realNow.call(performance));
});

test('fadeInVolume：末帧精确落到目标音量，且时长上限 1000ms（旧快照没这条）', () => {
    const audio = setup({ volume: 0 });
    fc.fadeInVolume(0.7, 5000);
    const fallback = timers[timers.length - 1];
    assert.equal(fallback.ms, 1050, 'effectiveDuration 必须被压到 1000，兜底 = +50');
    runFrames(1000);
    assert.equal(+audio.volume.toFixed(2), 0.7);
});

test('fadeInVolume：淡入淡出关闭时直接设到目标值', () => {
    const audio = setup({ fadeInOut: false, volume: 0.1 });
    fc.fadeInVolume(0.55, 400);
    assert.equal(audio.volume, 0.55);
    assert.equal(timers.length, 0, '不该排任何动画或兜底');
});

test('cancelAllFades：句柄全部归零', () => {
    setup({ volume: 0.5 });
    fc.fadeOutVolume(800, () => {});
    fc.cancelAllFades();
    assert.equal(state.fadeOutVolumeRafId, null);
    assert.equal(state.fadeOutVolumeTimeoutId, null);
});

test('未注入 audio 元素时不抛错：淡出仍要回调，否则切歌流程卡死', () => {
    fc.initFadeController(null);
    state.appSettings = { playback: { fadeInOut: true, fadeDuration: 300 } };
    let called = 0;
    fc.fadeOutVolume(300, () => { called++; });
    assert.equal(called, 1);
    fc.fadeInVolume(0.4, 300);   /* 只要求不抛 */
});
