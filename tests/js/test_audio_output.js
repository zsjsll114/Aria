/* ============================================================
 * tests/js/test_audio_output.js — 输出设备选择的契约（原生输出线 Phase 1）
 *
 * 这块代码要做两件「做错了很难发现」的事，所以钉死：
 *   ① **sink 目标的优先级**：只要 EQ 图存在，元素自身输出已被静音，
 *      必须打到 AudioContext 上。优先级写反 = 用户选完设备声音还是从默认出，
 *      而 sinkId 属性会报告成功（Chromium 的旧坑，issue 40206537），
 *      靠界面完全看不出来 —— 只能靠这条测试挡。
 *   ② **失效偏好必须回落**：设备拔掉后旧 deviceId 会抛 NotFoundError。
 *      回落是设计而非容错 —— 不回落的表现是「一打开设置面板就报错」。
 *
 * 另钉：未授权时 enumerateDevices() 回空 deviceId（规范行为），
 * 不能被当成一台「无名设备」混进列表。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    OUTPUT_DEVICE_KEY,
    SYSTEM_DEFAULT_ID,
    describeSinkError,
    normalizeOutputDevices,
    pickSavedDeviceId,
    readSavedDeviceId,
    resolveSinkTarget,
    writeSavedDeviceId,
} from '../../web/src/core/audioOutput.js';

const dev = (deviceId, label, kind = 'audiooutput') => ({ deviceId, label, kind });

test('首项恒为系统默认，且只收 audiooutput', () => {
    const list = normalizeOutputDevices([
        dev('spk-1', '扬声器 (Realtek)'),
        { deviceId: 'mic-1', label: '麦克风', kind: 'audioinput' },
        dev('hdmi-1', '显示器 (NVIDIA High Definition Audio)'),
    ]);
    assert.equal(list.length, 3);
    assert.equal(list[0].id, SYSTEM_DEFAULT_ID);
    assert.equal(list[0].isDefault, true);
    assert.deepEqual(list.slice(1).map((it) => it.id), ['spk-1', 'hdmi-1']);
    assert.equal(list.some((it) => it.label === '麦克风'), false);
});

test('空 deviceId 被跳过（未授权时 Chromium 就这么回，不是一台无名设备）', () => {
    const list = normalizeOutputDevices([dev('', ''), dev('spk-1', '扬声器')]);
    assert.equal(list.length, 2);
    assert.equal(list.filter((it) => it.id === SYSTEM_DEFAULT_ID).length, 1, '默认项不应出现重复');
    assert.equal(list[1].id, 'spk-1');
});

test('同 id 去重且保序；label 缺失保留空串（文案交给 UI 层）', () => {
    const list = normalizeOutputDevices([
        dev('a', 'A'),
        dev('b', ''),
        dev('a', 'A 重复'),
    ]);
    assert.deepEqual(list.map((it) => it.id), [SYSTEM_DEFAULT_ID, 'a', 'b']);
    assert.equal(list[2].label, '', 'core 不做兜底文案，空串要原样传出去');
});

test('slot 从 1 连续编号，被跳过的项不占号', () => {
    const list = normalizeOutputDevices([dev('', ''), dev('a', ''), dev('b', '')]);
    assert.deepEqual(list.slice(1).map((it) => it.slot), [1, 2]);
});

test('null / 非数组输入只回默认项（不抛异常）', () => {
    for (const bad of [null, undefined, 'x', 0, {}]) {
        const list = normalizeOutputDevices(bad);
        assert.equal(list.length, 1);
        assert.equal(list[0].id, SYSTEM_DEFAULT_ID);
    }
});

test('失效的保存 id 回落系统默认（设备拔掉后不许抛 NotFoundError）', () => {
    const list = normalizeOutputDevices([dev('spk-1', '扬声器')]);
    assert.equal(pickSavedDeviceId('spk-1', list), 'spk-1');
    assert.equal(pickSavedDeviceId('usb-已拔掉', list), SYSTEM_DEFAULT_ID);
    assert.equal(pickSavedDeviceId('', list), SYSTEM_DEFAULT_ID);
    assert.equal(pickSavedDeviceId(null, list), SYSTEM_DEFAULT_ID);
    assert.equal(pickSavedDeviceId('spk-1', null), SYSTEM_DEFAULT_ID);
});

test('sink 目标优先 AudioContext（EQ 图存在时元素自身已被静音）', () => {
    const ctx = { setSinkId() {} };
    const el = { setSinkId() {} };

    const withCtx = resolveSinkTarget(ctx, el);
    assert.equal(withCtx.kind, 'context');
    assert.equal(withCtx.node, ctx);

    const withoutCtx = resolveSinkTarget(null, el);
    assert.equal(withoutCtx.kind, 'element');
    assert.equal(withoutCtx.node, el);
});

test('AudioContext 没有 setSinkId（Chrome <110）时退回元素，而不是判死', () => {
    const oldCtx = { /* 无 setSinkId */ };
    const el = { setSinkId() {} };
    assert.equal(resolveSinkTarget(oldCtx, el).kind, 'element');
});

test('两个目标都没有 setSinkId 才返回 null（调用方据此报「不支持」）', () => {
    assert.equal(resolveSinkTarget({}, {}), null);
    assert.equal(resolveSinkTarget(null, null), null);
});

test('错误名映射到可区分的原因（UI 据此选文案）', () => {
    assert.equal(describeSinkError({ name: 'NotAllowedError' }), 'permission');
    assert.equal(describeSinkError({ name: 'NotFoundError' }), 'notfound');
    assert.equal(describeSinkError({ name: 'AbortError' }), 'abort');
    assert.equal(describeSinkError({ name: 'TypeError' }), 'unknown');
    assert.equal(describeSinkError(null), 'unknown');
});

test('localStorage 不可用时读回落默认、写返回 false（不抛）', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
        assert.equal(readSavedDeviceId(), SYSTEM_DEFAULT_ID);
        assert.equal(writeSavedDeviceId('spk-1'), false);
    } finally {
        if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
        else delete globalThis.localStorage;
    }
});

test('写入后能读回；写默认值等于清键（不留空串键）', () => {
    const store = new Map();
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => store.set(k, String(v)),
                removeItem: (k) => store.delete(k),
            },
        });
        assert.equal(readSavedDeviceId(), SYSTEM_DEFAULT_ID, '未写过的键应回落默认');

        assert.equal(writeSavedDeviceId('spk-1'), true);
        assert.equal(readSavedDeviceId(), 'spk-1');
        assert.equal(store.get(OUTPUT_DEVICE_KEY), 'spk-1');

        writeSavedDeviceId(SYSTEM_DEFAULT_ID);
        assert.equal(store.has(OUTPUT_DEVICE_KEY), false, 'default 语义 = 无键');
        assert.equal(readSavedDeviceId(), SYSTEM_DEFAULT_ID);
    } finally {
        if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
        else delete globalThis.localStorage;
    }
});
