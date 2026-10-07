/* ============================================================
 * tests/js/test_native_deck.js — core/nativeDeck.js 行为回归（原生输出线 Phase 2b）
 *
 * 盯四件事（都是「看起来能跑但会静默错」的类型）：
 *   · 时钟：20Hz 快照 + 墙钟外推；暂停后必须落锚，否则进度跳回去；
 *   · 事件时序：play() 乐观派发、乐观窗口内不回灌假 pause；
 *   · 加载幂等：显式 load() 不能把同一次加载打成两发；
 *   · 错误只报一次：引擎的 last_error 跨曲目留存，不记基线就会把上一首的
 *     失败当成这一首重报一遍。
 * 手法：注入假 api（记账），不碰 Tauri；轮询间隔调大用 _onSnapshot 手动驱动，
 * 需要真轮询的用例另用 10ms 间隔 + 短 sleep。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createNativeDeck, isNativeDeck } = await import('../../web/src/core/nativeDeck.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记账式假后端 */
function fakeApi() {
    const calls = [];
    const snap = {
        playing: false,
        ended: false,
        positionSec: 0,
        durationSec: null,
        sampleRate: 44100,
        volume: 1,
        bufferedFrames: 0,
        underruns: 0,
        decoding: false,
        hasTrack: false,
        trackName: null,
        outputMode: 'exclusive',
        sampleFormat: 's24',
        lastError: null,
    };
    return {
        calls,
        snap,
        load(src, autoplay) { calls.push(['load', src, autoplay]); return Promise.resolve(); },
        play() { calls.push(['play']); return Promise.resolve(); },
        pause() { calls.push(['pause']); return Promise.resolve(); },
        seek(sec) { calls.push(['seek', sec]); return Promise.resolve(); },
        setVolume(g) { calls.push(['volume', g]); return Promise.resolve(); },
        setEq(enabled, gains) { calls.push(['eq', enabled, gains.slice()]); return Promise.resolve(); },
        setRate(rate) { calls.push(['rate', rate]); return Promise.resolve(); },
        snapshot() { calls.push(['snapshot']); return Promise.resolve({ ...snap }); },
        count(kind) { return calls.filter((c) => c[0] === kind).length; },
    };
}

/** 手动推进一拍：驱动一次快照处理，并让内部 Promise 链走完。
 *  ★ 开头那一次 sleep(0) 不能省：load() 会在启动轮询时**立刻**发一拍快照，
 *    它的 .then 排在微任务队列里。不先排干，它就会在下面这次 _onSnapshot
 *    之后才带着**旧快照**（hasTrack=false）到达，把刚置上的状态又清回空态
 *    ——这正是「用例明明推了快照却读到 readyState=0」的成因。 */
async function pump(deck, api, patch) {
    await sleep(0);
    Object.assign(api.snap, patch || {});
    deck._onSnapshot({ ...api.snap });
    await sleep(0);
}

test('src 赋值即触发加载；随后显式 load() 幂等（全库多条路径只赋值不调 load）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    try {
        deck.src = '/local_music/a.mp3';
        assert.equal(api.count('load'), 1, '赋值即开始加载');
        /* 不按下标取第一发：起轮询时的那次立即快照可能先入账 */
        assert.deepEqual(api.calls.find((c) => c[0] === 'load'), ['load', '/local_music/a.mp3', false]);
        deck.load();
        assert.equal(api.count('load'), 1, '同 src 的显式 load 不再打第二发');
        assert.equal(isNativeDeck(deck), true);
        assert.equal(deck.currentSrc, '/local_music/a.mp3');
    } finally {
        deck.dispose();
    }
});

test('加载完成派发 loadedmetadata/durationchange/loadeddata/canplay，readyState=4', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    const seen = [];
    for (const t of ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay']) {
        deck.addEventListener(t, () => seen.push(t));
    }
    try {
        deck.src = '/local_music/a.flac';
        await pump(deck, api, { hasTrack: true, durationSec: 213.5, sampleRate: 48000 });
        assert.deepEqual(seen, ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay']);
        assert.equal(deck.readyState, 4);
        assert.equal(deck.duration, 213.5);
        assert.equal(deck.sampleRate, 48000);
    } finally {
        deck.dispose();
    }
});

test('时钟：播放中按墙钟外推，快照到达时重锚定；未加载时 duration 为 NaN', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    try {
        assert.ok(Number.isNaN(deck.duration), '无元数据时 duration 是 NaN（HTML 语义）');
        assert.equal(deck.currentTime, 0);

        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 200, playing: true, positionSec: 30 });
        assert.equal(deck.paused, false);
        const t0 = deck.currentTime;
        /* 容差放到 50ms：中间的 await 已经让时钟外推走了一小段，这正是它的职责 */
        assert.ok(Math.abs(t0 - 30) < 0.05, `锚点即快照位置，实际 ${t0}`);
        await sleep(60);
        const t1 = deck.currentTime;
        assert.ok(t1 > t0, '播放中 currentTime 必须自己往前走');
        assert.ok(t1 - t0 < 0.2, `外推不能漂，实际走了 ${(t1 - t0).toFixed(3)}s`);

        /* 暂停：先落锚再停，否则下一次读会跳回锚点 */
        deck.pause();
        const paused0 = deck.currentTime;
        await sleep(40);
        assert.ok(Math.abs(deck.currentTime - paused0) < 0.01, '暂停后 currentTime 必须冻住');
        assert.ok(paused0 >= t1 - 0.02, '落锚用的是暂停那一刻的外推值，不是旧锚点');
    } finally {
        deck.dispose();
    }
});

test('play() 乐观派发 play；乐观窗口内快照仍是旧值时不得回灌假 pause', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    const seen = [];
    deck.addEventListener('play', () => seen.push('play'));
    deck.addEventListener('pause', () => seen.push('pause'));
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 100 });
        seen.length = 0;

        await deck.play();
        assert.deepEqual(seen, ['play'], 'HTML 语义：play() 立刻派发 play，不等数据流动');
        assert.equal(deck.paused, false);
        assert.equal(api.count('play'), 1);

        /* 引擎还没把 playing 置真（线程边界），乐观窗口内不能反手派发 pause */
        await pump(deck, api, { playing: false });
        assert.deepEqual(seen, ['play'], '乐观窗口抑制了假 pause');

        /* 窗口过后真值说了算 */
        deck._optimisticUntil = 0;
        await pump(deck, api, { playing: false });
        assert.deepEqual(seen, ['play', 'pause'], '窗口过后按真值回灌');
    } finally {
        deck.dispose();
    }
});

test('尚未加载完就 play()：等 canplay 后再真正起播；无曲目则直接拒绝', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    try {
        await assert.rejects(() => deck.play(), /no track loaded/);

        deck.src = '/local_music/a.mp3';
        const p = deck.play();
        await sleep(0);
        assert.equal(api.count('play'), 0, '未就绪时不下发 play');
        await pump(deck, api, { hasTrack: true, durationSec: 10 });
        await p;
        assert.equal(api.count('play'), 1, 'canplay 之后才下发');
    } finally {
        deck.dispose();
    }
});

test('ended 只派发一次，且顺序是 pause → ended（HTML 语义）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    const seen = [];
    deck.addEventListener('pause', () => seen.push('pause'));
    deck.addEventListener('ended', () => seen.push('ended'));
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 42, playing: true, positionSec: 41 });
        await deck.play();
        seen.length = 0;
        deck._optimisticUntil = 0;

        await pump(deck, api, { playing: false, ended: true, positionSec: 42 });
        await pump(deck, api, { playing: false, ended: true, positionSec: 42 });
        assert.deepEqual(seen, ['pause', 'ended'], '播完是 pause 后跟 ended，且只一次');
        assert.equal(deck.currentTime, 42, '播完停在末尾');
    } finally {
        deck.dispose();
    }
});

test('last_error 跨曲目留存：加载时的基线错误不报，之后的新错误才报一次', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    let errs = 0;
    deck.addEventListener('error', () => { errs += 1; });
    try {
        api.snap.lastError = 'stale failure from previous track';
        deck.src = '/local_music/a.mp3';
        await pump(deck, api);
        assert.equal(errs, 0, '加载前的旧错误是基线，不该当成这一首的失败');

        await pump(deck, api, { lastError: 'exclusive endpoint consumed none' });
        assert.equal(errs, 1);
        assert.match(deck.error.message, /consumed none/);

        await pump(deck, api, { lastError: 'exclusive endpoint consumed none' });
        assert.equal(errs, 1, '同一条错误不重复派发');
    } finally {
        deck.dispose();
    }
});

test('EQ：只在快照字符串变化时下发（既有的 20Hz 轮询里顺带比对）', async () => {
    const api = fakeApi();
    let gains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let enabled = false;
    const deck = createNativeDeck({ api, pollMs: 3600000, eqProvider: () => ({ enabled, gainsDb: gains.slice() }) });
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 10 });
        assert.equal(api.count('eq'), 1);

        await pump(deck, api, {});
        assert.equal(api.count('eq'), 1, '没有变化就不重复下发');

        gains = gains.slice();
        gains[3] = 6;
        await pump(deck, api, {});
        assert.equal(api.count('eq'), 2);
        assert.equal(api.calls[api.calls.length - 1][2].join(','), gains.join(','));

        enabled = true;
        await pump(deck, api, {});
        assert.equal(api.count('eq'), 3);
        assert.equal(api.calls[api.calls.length - 1][1], true, '开关变化也要下发');
    } finally {
        deck.dispose();
    }
});

test('变速：playbackRate 经 rateProvider 下发到引擎（独占路径的音频是 Rust 解码的，元素速率到不了那里）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000, rateProvider: () => deck.playbackRate });
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 10 });
        assert.equal(api.count('rate'), 1, '初始速率也要下发一次（引擎默认 1，但别依赖它）');
        assert.equal(api.calls.filter((c) => c[0] === 'rate')[0][1], 1);

        /* 同一个值不该重复发（20Hz 轮询 × 一次 IPC 是不可接受的） */
        await pump(deck, api, {});
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 1, '没变化就不重复下发');

        deck.playbackRate = 1.5;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 2);
        assert.equal(api.calls[api.calls.length - 1][1], 1.5);

        deck.playbackRate = 0.8;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 3);
        assert.equal(api.calls[api.calls.length - 1][1], 0.8);

        /* 非法值不该污染引擎：设置器直接忽略，provider 也就读不到它 */
        deck.playbackRate = 0;
        deck.playbackRate = NaN;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 3, '非法速率不得下发');
        assert.equal(deck.playbackRate, 0.8, '非法赋值应被忽略、保留上一个合法值');
    } finally {
        deck.dispose();
    }
});

test('变速：rateProvider 返回非法值时静默跳过，不把 NaN 送进引擎', async () => {
    const api = fakeApi();
    let r = 1.25;
    const deck = createNativeDeck({ api, pollMs: 3600000, rateProvider: () => r });
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 10 });
        assert.equal(api.count('rate'), 1);
        assert.equal(api.calls[api.calls.length - 1][1], 1.25);

        r = NaN;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 1, 'NaN 不得下发（Rust 侧虽也夹，但别让它走到 IPC）');

        r = 0;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 1, '0/负数不得下发');

        r = 0.75;
        await pump(deck, api, {});
        assert.equal(api.count('rate'), 2);
        assert.equal(api.calls[api.calls.length - 1][1], 0.75);
    } finally {
        deck.dispose();
    }
});

test('removeAttribute(src) 清空并让引擎停声（界面说没在放、喇叭不能还在响）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    const seen = [];
    deck.addEventListener('pause', () => seen.push('pause'));
    try {
        deck.src = '/local_music/a.mp3';
        await pump(deck, api, { hasTrack: true, durationSec: 10, playing: true });
        await deck.play();
        seen.length = 0;

        deck.removeAttribute('src');
        assert.equal(deck.src, '');
        assert.equal(deck.readyState, 0);
        assert.equal(api.count('pause') >= 1, true, '引擎收到 pause');
        assert.deepEqual(seen, ['pause'], '换 src 而当时在播 → 派发一次 pause');
    } finally {
        deck.dispose();
    }
});

test('音量推送被合并（淡入淡出每帧写 volume 不能变成每帧一次 IPC）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    try {
        for (let i = 1; i <= 20; i += 1) deck.volume = i / 20;
        assert.equal(deck.volume, 1, '属性立即反映最后一次赋值');
        await sleep(40);
        assert.equal(api.count('volume'), 1, '20 次赋值只打一发，且是最后那个值');
        assert.equal(api.calls[api.calls.length - 1][1], 1);
    } finally {
        deck.dispose();
    }
});

test('playbackRate 接受赋值但不谎报生效（引擎无变速能力）', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 3600000 });
    try {
        deck.playbackRate = 1.5;
        assert.equal(deck.playbackRate, 1.5);
        assert.equal(api.calls.some((c) => c[0] === 'rate'), false, '不会往下发不存在的能力');
        assert.equal(deck.preservesPitch, true);
        deck.preservesPitch = false;
        assert.equal(deck.preservesPitch, false);
        assert.equal(deck.webkitPreservesPitch, false, '别名属性同步，否则 applyPreservesPitch 的探测分支形同虚设');
    } finally {
        deck.dispose();
    }
});

test('真轮询：加载在途时按期取快照，空闲（无曲/无在途）后自行停表', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 10 });
    try {
        deck.src = '/local_music/a.mp3';
        await sleep(45);
        assert.ok(api.count('snapshot') >= 2, `在途加载应持续轮询，实际 ${api.count('snapshot')}`);

        /* 加载失败：无曲目也无在途加载 → 轮询必须停 */
        deck._pendingLoad = false;
        deck._onSnapshot({ ...api.snap, hasTrack: false });
        const after = api.count('snapshot');
        await sleep(45);
        assert.equal(api.count('snapshot'), after, '空闲后不再打 IPC');
    } finally {
        deck.dispose();
    }
});

test('dispose 后一切静默：不再轮询、不再派发', async () => {
    const api = fakeApi();
    const deck = createNativeDeck({ api, pollMs: 10 });
    deck.src = '/local_music/a.mp3';
    await sleep(25);
    deck.dispose();
    const after = api.count('snapshot');
    let fired = 0;
    deck.addEventListener('canplay', () => { fired += 1; });
    await sleep(30);
    assert.equal(api.count('snapshot'), after);
    assert.equal(fired, 0);
});
