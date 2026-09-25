/* ============================================================
 * tests/js/test_tempo_boost.js — core/tempoBoost.js 行为回归（todos #13）
 *
 * 这个功能唯一的难点不在「加速」，在「一定恢复」：按住的那只手会经由键盘、
 * 鼠标长按两条来源进入加速，而离开它可以有 keyup / window blur / 页面隐藏 /
 * 切歌 / 暂停 / 事件被系统吞掉 六条路径，任何一条漏掉都是「歌卡在 2× 播」——
 * 用户只会觉得播放器坏了。所以本文件把每条丢失焦点的路径都单独钉一遍。
 *
 * 手法：不碰真 DOM。core 的事件全部经 installTempoBoost({env}) 注入，
 * 这里造一套假 window / document / audio（与 test_stall_detector 同一手法），
 * 倍速读写也用假 setter，于是「恢复原速」= 断言假 audio 上的数字回到基准值。
 * ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    engageTempoBoost,
    installTempoBoost,
    isTempoBoosting,
    releaseTempoBoost,
    tempoBoostInfo,
    boostedRateFor,
} from '../../web/src/core/tempoBoost.js';

/* ---------- 假环境 ---------- */
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function makeBus() {
    const handlers = new Map();
    return {
        addEventListener(type, fn) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = handlers.get(type) || [];
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        },
        dispatch(type, ev = {}) {
            (handlers.get(type) || []).slice().forEach(fn => fn(ev));
        },
        count(type) { return (handlers.get(type) || []).length; },
    };
}

/** 假 audio + 假 currentPlaybackRate：writeRate 同时改两处，与真分片一致 */
function makeEnv({ rate = 1 } = {}) {
    const state = { rate, focused: true, hidden: false };
    const audio = makeBus();
    const doc = makeBus();
    /* 注意：hidden 必须是活 getter（Object.assign 会把 getter 求成一次性静态值） */
    Object.defineProperty(doc, 'hidden', { enumerable: true, get: () => state.hidden });
    doc.hasFocus = () => state.focused;
    return {
        state,
        audio,
        envObj: { window: makeBus(), document: doc, audio },
        readRate: () => state.rate,
        setRate: (r) => { state.rate = r; },
    };
}

let env;
let uninstall;
let intervals;

function install(e) {
    uninstall = installTempoBoost({ setRate: e.setRate, readRate: e.readRate, env: e.envObj });
}

beforeEach(() => {
    intervals = [];
    globalThis.setInterval = (fn) => { const h = { fn, cleared: false }; intervals.push(h); return h; };
    globalThis.clearInterval = (h) => { if (h) h.cleared = true; };
    globalThis.appSettings = { playback: { tempoBoost: { enabled: true, key: 'x', factor: 2, maxRate: 4 } } };
    env = makeEnv({ rate: 1 });
    install(env);
});

afterEach(() => {
    if (uninstall) uninstall();
    uninstall = null;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    delete globalThis.appSettings;
    delete globalThis.recordingShortcut;
});

function tickWatchdog(n = 1) {
    for (let i = 0; i < n; i++) intervals.filter(h => !h.cleared).forEach(h => h.fn());
}

function key(type, k, extra = {}) {
    env.envObj.window.dispatch(type, Object.assign({ key: k, repeat: false }, extra));
}

/* ---------- 1. 叠加规则 ---------- */

test('大小写不敏感：CapsLock / 按住 Shift 时的 X 也算加速键', () => {
    key('keydown', 'X');
    assert.equal(env.state.rate, 2);
    key('keyup', 'X');
    assert.equal(env.state.rate, 1);
});

test('按住加速键：1× → 2×，松开回 1×', () => {
    key('keydown', 'x');
    assert.equal(isTempoBoosting(), true);
    assert.equal(env.state.rate, 2, '按下必须真的抬到 2×');
    key('keyup', 'x');
    assert.equal(isTempoBoosting(), false);
    assert.equal(env.state.rate, 1, '松开必须回原速');
});

test('与用户手动倍速是乘法叠加：1.5× 按住到 3×，松回 1.5×', () => {
    env.state.rate = 1.5;
    key('keydown', 'x');
    assert.equal(env.state.rate, 3);
    key('keyup', 'x');
    assert.equal(env.state.rate, 1.5, '基准必须记住，不能掉回 1×');
});

test('封顶在 maxRate：base 3× 只会到 4×，且松手回到 3×', () => {
    env.state.rate = 3;
    key('keydown', 'x');
    assert.equal(env.state.rate, 4);
    key('keyup', 'x');
    assert.equal(env.state.rate, 3);
});

test('已经在封顶档时不做无效切换（不写倍速、不进入加速态）', () => {
    env.state.rate = 4;
    key('keydown', 'x');
    assert.equal(isTempoBoosting(), false);
    assert.equal(env.state.rate, 4);
});

test('boostedRateFor 是纯函数，UI 提示可以直接用它算文案', () => {
    assert.equal(boostedRateFor(1.25), 2.5);
    assert.equal(boostedRateFor(0), 0, '非法基准返回 0 = 不加速');
});

/* ---------- 2. 每一条丢焦点路径都必须恢复 ---------- */

test('window blur：键盘还按着也必须恢复（没收到 keyup）', () => {
    key('keydown', 'x');
    assert.equal(env.state.rate, 2);
    env.envObj.window.dispatch('blur');
    assert.equal(env.state.rate, 1, '失焦瞬间就恢复，不等松手');
    assert.equal(isTempoBoosting(), false);
});

test('页面隐藏（visibilitychange + hidden）：恢复', () => {
    key('keydown', 'x');
    env.state.hidden = true;
    env.state.focused = false;
    env.envObj.document.dispatch('visibilitychange');
    assert.equal(env.state.rate, 1);
});

test('audio pause：恢复（暂停时停在 2× 是最难发现的坏状态）', () => {
    key('keydown', 'x');
    env.envObj.audio.dispatch('pause');
    assert.equal(env.state.rate, 1);
});

test('切歌：loadstart / emptied / loadedmetadata 任一发都要恢复', () => {
    ['loadstart', 'emptied', 'loadedmetadata'].forEach(type => {
        env.state.rate = 1;
        key('keydown', 'x');
        assert.equal(env.state.rate, 2, `${type} 用例的前置：必须先进入加速`);
        env.envObj.audio.dispatch(type);
        assert.equal(env.state.rate, 1, `${type} 必须把倍速交回基准`);
    });
});

test('切歌后即便手还按着，也不会被后续 keyup 反吊回加速态', () => {
    key('keydown', 'x');
    env.envObj.audio.dispatch('loadstart');
    key('keyup', 'x');
    assert.equal(env.state.rate, 1);
    assert.equal(isTempoBoosting(), false);
});

test('pagehide（进 bfcache / 关页面）：恢复', () => {
    key('keydown', 'x');
    env.envObj.window.dispatch('pagehide');
    assert.equal(env.state.rate, 1);
});

test('看门狗兜底：blur/visibilitychange 一个都没发出来时，靠 hasFocus 现值恢复', () => {
    key('keydown', 'x');
    assert.equal(intervals.length, 1, '进入加速必须挂上看门狗');
    env.state.focused = false;
    tickWatchdog();
    assert.equal(env.state.rate, 1, '失焦没收到事件也必须恢复');
    assert.equal(isTempoBoosting(), false);
    key('keyup', 'x');
    assert.equal(env.state.rate, 1, '兜底恢复后，迟到的 keyup 不得再改动倍速');
});

test('看门狗兜底：hidden 没收到事件时同样能恢复', () => {
    key('keydown', 'x');
    env.state.hidden = true;
    tickWatchdog();
    assert.equal(env.state.rate, 1);
});

test('退出加速会收掉看门狗，不留常驻定时器', () => {
    key('keydown', 'x');
    key('keyup', 'x');
    assert.equal(intervals[0].cleared, true);
    env.state.focused = false;
    tickWatchdog();
    assert.equal(env.state.rate, 1, '已停的定时器不得再改倍速');
});

/* ---------- 3. 别误伤：不该恢复的时候别恢复，不该加速的时候别加速 ---------- */

test('其它键的 keyup 不打断加速（手在键盘上乱按）', () => {
    key('keydown', 'x');
    key('keyup', 'a');
    assert.equal(env.state.rate, 2, 'a 的抬起与加速无关');
    key('keyup', 'x');
    assert.equal(env.state.rate, 1);
});

test('加速键的 keyup 被系统整批吞掉时，迟到的其它 keyup 也必须恢复', () => {
    globalThis.appSettings.playback.tempoBoost.key = 'Shift';
    /* Shift 这类键在「按住 Shift 点右键弹菜单」时会只留下 contextmenu，keyup 整个丢掉 */
    key('keydown', 'Shift');
    assert.equal(env.state.rate, 2);
    env.envObj.window.dispatch('contextmenu', {});
    assert.equal(env.state.rate, 1, '菜单弹出那一刻就该收手');
    globalThis.appSettings.playback.tempoBoost.key = 'x';
    key('keydown', 'a');
    key('keyup', 'a');
    assert.equal(env.state.rate, 1, '兜底路径不能反过来把倍速改坏');
});

test('输入框里的 x 是打字，不是加速', () => {
    key('keydown', 'x', { target: { tagName: 'INPUT' } });
    assert.equal(isTempoBoosting(), false);
});

test('带修饰键的组合让位（Ctrl+X 是剪切）', () => {
    key('keydown', 'x', { ctrlKey: true });
    assert.equal(isTempoBoosting(), false);
});

test('IME 组合态与快捷键录制态都不吃键', () => {
    key('keydown', 'x', { isComposing: true });
    assert.equal(isTempoBoosting(), false, '中文选词过程中的 x 不算');
    globalThis.recordingShortcut = { dataset: { shortcut: 'playPause' } };
    key('keydown', 'x');
    assert.equal(isTempoBoosting(), false, '正在录制快捷键时不能顺手触发');
});

test('长按连发的 repeat keydown 不会把倍速越抬越高', () => {
    key('keydown', 'x');
    for (let i = 0; i < 30; i++) key('keydown', 'x', { repeat: true });
    assert.equal(env.state.rate, 2, '一直按着也必须稳定在 2×');
    key('keyup', 'x');
    assert.equal(env.state.rate, 1);
});

test('开关关掉后键完全失效', () => {
    globalThis.appSettings.playback.tempoBoost.enabled = false;
    key('keydown', 'x');
    assert.equal(isTempoBoosting(), false);
    assert.equal(env.state.rate, 1);
});

test('自定义键位与倍率走 appSettings.playback.tempoBoost', () => {
    globalThis.appSettings.playback.tempoBoost = { enabled: true, key: 'j', factor: 1.5, maxRate: 4 };
    key('keydown', 'x');
    assert.equal(isTempoBoosting(), false, '默认键已被改，x 不再生效');
    key('keydown', 'j');
    assert.equal(env.state.rate, 1.5);
    key('keyup', 'j');
    assert.equal(env.state.rate, 1);
});

/* ---------- 4. 多来源与外部改写 ---------- */

test('键盘 + 长按两条来源：最后一路松开才恢复', () => {
    key('keydown', 'x');
    engageTempoBoost('press');
    assert.equal(env.state.rate, 2);
    key('keyup', 'x');
    assert.equal(env.state.rate, 2, '手指还按着播放键，不能提前恢复');
    releaseTempoBoost('press');
    assert.equal(env.state.rate, 1);
});

test('加速期间用户另选倍速：以用户的值为准，松手不覆盖', () => {
    env.state.rate = 1;
    key('keydown', 'x');
    assert.equal(env.state.rate, 2);
    /* 模拟右键菜单 applyPlaybackRate(1.25) —— 走的是同一个 currentPlaybackRate */
    env.state.rate = 1.25;
    key('keyup', 'x');
    assert.equal(env.state.rate, 1.25, '不能把用户刚选的 1.25× 抹回 1×');
});

test('未处于加速时 release 是纯空操作，绝不写倍速', () => {
    env.state.rate = 1.5;
    let writes = 0;
    uninstall();
    env.setRate = (r) => { writes++; env.state.rate = r; };
    install(env);
    releaseTempoBoost('key');
    env.envObj.window.dispatch('blur');
    env.envObj.audio.dispatch('pause');
    assert.equal(writes, 0, '没加速过就不该有倍速写入');
    assert.equal(env.state.rate, 1.5);
});

test('倍速写入抛错时不留脏状态（下一帧还在 2× 但状态机已复位）', () => {
    uninstall();
    const e = makeEnv({ rate: 1 });
    e.setRate = () => { throw new Error('audio gone'); };
    install(e);
    e.envObj.window.dispatch('keydown', { key: 'x', repeat: false });
    assert.equal(isTempoBoosting(), false, '写入失败就不算进入加速');
    assert.equal(tempoBoostInfo().sources.length, 0);
});

test('极端兜底：keyup 被系统整批吞掉时，超过 maxHoldMs 也强制恢复', () => {
    globalThis.appSettings.playback.tempoBoost.maxHoldMs = 1000;
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0;
    try {
        key('keydown', 'x');
        assert.equal(env.state.rate, 2);
        Date.now = () => t0 + 5000;
        tickWatchdog();
    } finally {
        Date.now = realNow;
    }
    assert.equal(env.state.rate, 1, '按住不放也不能永远停在 2×');
    assert.equal(isTempoBoosting(), false);
});

test('卸载后监听全部摘除，按键不再影响倍速', () => {
    uninstall();
    env.envObj.window.dispatch('keydown', { key: 'x', repeat: false });
    assert.equal(env.state.rate, 1);
});

test('重复 install 只挂一份监听（分片可能被求值两次）', () => {
    const before = env.envObj.window.count('keydown');
    install(env);
    assert.equal(env.envObj.window.count('keydown'), before, '第二次 install 不得再加监听');
});
