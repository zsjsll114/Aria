/* ============================================================
 * tests/js/test_native_bridge.js — core/nativeBridge.js 行为回归（原生输出线 Phase 2b）
 *
 * 盯的是「注入时机」与「失败要说准」两件在真机上最难复现的事：
 *   · `__TAURI__` 可能是模块求值之后才注入的 → 必须在调用那一刻重新解析，
 *     模块顶层抓的引用迟早会变 undefined（远程 URL 的窗口就是这样）；
 *   · 「没外壳」和「有外壳但命令被 ACL 拦」必须区分开，前者静默隐藏 UI，
 *     后者要给人看原因；
 *   · 后端卡住时不能把调用方永久挂住 → 必须有超时。
 * 手法：stub globalThis.window.__TAURI__，逐条改 invoke 的行为。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const bridge = await import('../../web/src/core/nativeBridge.js');

/** 装一个假外壳；task 决定 invoke 的行为 */
function installShell(invoke) {
    globalThis.window = { __TAURI__: { core: { invoke } } };
}

beforeEach(() => {
    bridge._resetNativeBridgeForTest();
    delete globalThis.window;
    /* 默认不重试：多数用例关心的是判定结果，不是那 300ms 竞态窗口。
       专门验重试的用例自己改回来。 */
    bridge.SHELL_PROBE_RETRY.attempts = 1;
});

test('没有外壳：probe 报 no-shell 且不抛（网页版走这条路，UI 静默隐藏）', async () => {
    const res = await bridge.probe();
    assert.equal(res.available, false);
    assert.equal(res.reason, bridge.UNAVAILABLE.NO_SHELL);
});

test('晚注入：模块先加载、外壳后到，probe 仍能拿到（★ 不能缓存引用）', async () => {
    /* 关键回归点：解析必须推迟到调用那一刻。若实现里在模块顶层抓了 __TAURI__，
       这里会永远拿到 no-shell —— 正是 250-desktop-lyrics 踩过的坑。 */
    const first = await bridge.probe();
    assert.equal(first.available, false);

    bridge._resetNativeBridgeForTest();
    installShell(async (cmd) => {
        if (cmd === bridge.CMD.STATUS) return { available: true, mode: 'exclusive', sampleFormat: 's24' };
        throw new Error(`unexpected ${cmd}`);
    });
    const second = await bridge.probe();
    assert.equal(second.available, true);
    assert.equal(second.mode, 'exclusive');
    assert.equal(second.sampleFormat, 's24');
});

test('外壳在但引擎起不来：reason=error，detail 带引擎原文', async () => {
    installShell(async () => ({ available: false, mode: 'shared', sampleFormat: 'f32', reason: 'device busy' }));
    const res = await bridge.probe();
    assert.equal(res.available, false);
    assert.equal(res.reason, bridge.UNAVAILABLE.ERROR);
    assert.equal(res.detail, 'device busy');
});

test('外壳在但命令被 ACL 拦：reason=no-command，与「没外壳」分开', async () => {
    installShell(async () => {
        throw new Error('native_audio_status not allowed. Permissions associated with this command: ...');
    });
    const res = await bridge.probe();
    assert.equal(res.available, false);
    assert.equal(res.reason, bridge.UNAVAILABLE.NO_COMMAND);
    assert.match(res.detail, /not allowed/);
});

test('「没外壳」会多等一拍再下结论（远程 URL 下注入可能晚到）', async () => {
    /* 关键回归点：结论只用来隐藏一行设置，抢跑把功能永久藏起来是更糟的失败。
       重试窗口内注入到位 → 必须能认出来。 */
    bridge.SHELL_PROBE_RETRY.attempts = 3;
    bridge.SHELL_PROBE_RETRY.delayMs = 10;
    setTimeout(() => {
        installShell(async () => ({ available: true, mode: 'shared', sampleFormat: 'f32' }));
    }, 15);
    const res = await bridge.probe();
    assert.equal(res.available, true, '重试窗口内到达的外壳必须被认出来');
});

test('probe 结果被缓存：同一次会话只问一次', async () => {
    let n = 0;
    installShell(async () => {
        n += 1;
        return { available: true, mode: 'shared', sampleFormat: 'f32' };
    });
    await bridge.probe();
    await bridge.probe();
    assert.equal(n, 1);
});

test('超时：后端不回话时 reject 而不是永久挂住', async () => {
    installShell(() => new Promise(() => {}));
    await assert.rejects(
        () => bridge.call(bridge.CMD.STATUS, {}, 30),
        /native call timeout/,
    );
});

test('命令包装的参数名与后端 DTO 一致（camelCase，改一边必须改另一边）', async () => {
    const seen = [];
    installShell(async (cmd, args) => {
        seen.push([cmd, args]);
        return null;
    });
    await bridge.checkExclusive('dev-1', 48000);
    await bridge.setOutput('dev-1', true);
    await bridge.setEq(true, [0, 1, 2]);
    await bridge.load('/local_music/a.mp3', true);
    await bridge.releaseOutput();

    assert.deepEqual(seen[0], [bridge.CMD.CHECK_EXCLUSIVE, { deviceId: 'dev-1', sampleRate: 48000 }]);
    assert.deepEqual(seen[1], [bridge.CMD.SET_OUTPUT, { output: { deviceId: 'dev-1', exclusive: true } }]);
    assert.deepEqual(seen[2], [bridge.CMD.SET_EQ, { eq: { enabled: true, gainsDb: [0, 1, 2] } }]);
    assert.deepEqual(seen[3], [bridge.CMD.LOAD, { src: '/local_music/a.mp3', autoplay: true }]);
    /* 交还设备必须真的发出去：不发的话第二次打开独占会撞设备占用 */
    assert.deepEqual(seen[4], [bridge.CMD.RELEASE_OUTPUT, {}]);
});

test('空设备 id 归一成 null（后端 None = 系统默认端点）', async () => {
    const seen = [];
    installShell(async (cmd, args) => { seen.push([cmd, args]); return null; });
    await bridge.setOutput('', false);
    await bridge.checkExclusive('', 0);
    assert.deepEqual(seen[0], [bridge.CMD.SET_OUTPUT, { output: { deviceId: null, exclusive: false } }]);
    assert.deepEqual(seen[1], [bridge.CMD.CHECK_EXCLUSIVE, { deviceId: null, sampleRate: 0 }]);
});
