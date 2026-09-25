/* ============================================================
 * tests/js/test_equalizer.js — core/equalizer.js 行为回归
 *
 * 盯住从 app/90-eq.js 抽取时最容易丢的三条活实现性质：
 *   · applyEqPreset 必须同时查内置 EQ_PRESETS 和用户自定义预设（旧快照只查内置，
 *     接上就是「自定义预设 / 分享码导入的预设全部失效」）；
 *   · 拖单个频段时绝不重建滑块（只刷数值与高亮），否则拖拽被自己的重渲染打断；
 *   · 未初始化音频图时改增益只存不发（eqFilterNodes 为空不能碰节点）。
 * 手法：stub localStorage + 假 AudioContext 节点，不依赖浏览器。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* --- 最小 localStorage --- */
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const st = await import('../../web/src/infrastructure/state.js');
const eq = await import('../../web/src/core/equalizer.js');
const { EQ_PRESETS } = await import('../../web/src/config/constants.js');
const state = st.state;

let calls;
function resetDeps({ inited = false, nodeCount = 10 } = {}) {
    calls = { changed: 0, presetApplied: 0, bandChanged: [], disconnects: 0, closes: 0, gainSets: [] };
    const mkFilter = (i) => ({
        gain: { setValueAtTime: (g) => calls.gainSets.push([i, g]) },
        disconnect: () => { calls.disconnects++; },
    });
    state.eqGains = new Array(10).fill(0);
    state.eqActivePreset = '默认';
    state.eqInited = inited;
    state.eqInitFailed = false;
    state.eqFilterNodes = inited ? Array.from({ length: nodeCount }, (_, i) => mkFilter(i)) : [];
    state.eqSourceNode = inited ? { disconnect: () => { calls.disconnects++; } } : null;
    state.audioCtx = inited ? { currentTime: 1.5, close: () => { calls.closes++; } } : null;
    eq.initEqualizer({
        audio: { src: '', currentTime: 0, paused: true },
        onPlayError: () => {},
        onChanged: () => { calls.changed++; },
        onPresetApplied: () => { calls.presetApplied++; },
        onBandChanged: (idx) => { calls.bandChanged.push(idx); },
    });
}

beforeEach(() => { store.clear(); resetDeps(); });

test('内置预设能应用，且会请求整面板重建（频段 + 高亮）', () => {
    const name = Object.keys(EQ_PRESETS)[0];
    assert.equal(eq.applyEqPreset(name), true);
    assert.equal(state.eqActivePreset, name);
    assert.equal(calls.presetApplied, 1);
    assert.equal(state.eqGains.length, 10);
});

test('自定义预设也能应用（旧快照只查内置，接上即失效）', () => {
    store.set('aria_eq_custom', JSON.stringify({ '我的低频': { gains: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0] } }));
    assert.equal(eq.applyEqPreset('我的低频'), true);
    assert.equal(state.eqActivePreset, '我的低频');
    assert.deepEqual(state.eqGains, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('未知预设名：返回 false 且不动状态', () => {
    const before = state.eqActivePreset;
    assert.equal(eq.applyEqPreset('不存在'), false);
    assert.equal(state.eqActivePreset, before);
    assert.equal(calls.presetApplied, 0);
});

test('拖单个频段：刷数值与高亮，但不重建滑块', () => {
    resetDeps({ inited: true });
    eq.setEqBand(3, '6');
    assert.deepEqual(calls.bandChanged, [3], '要通知数值文本刷新');
    assert.equal(calls.changed, 1, '要刷新预设高亮');
    assert.equal(calls.presetApplied, 0, '绝不能重建频段滑块');
    assert.equal(state.eqActivePreset, '自定义');
    assert.equal(state.eqGains[3], 6);
    assert.ok(calls.gainSets.some(([i, g]) => i === 3 && g === 6), '已初始化时要写进滤波节点');
});

test('未初始化音频图：改增益只存不发节点', () => {
    resetDeps({ inited: false });
    eq.applyEqGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(state.eqGains, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(calls.gainSets.length, 0);
});

test('保存自定义预设：落盘 + 设为当前 + 只刷高亮', () => {
    eq.applyEqGains([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    eq.saveEqPreset('我的');
    const saved = JSON.parse(store.get('aria_eq_custom'));
    assert.deepEqual(saved['我的'].gains, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(state.eqActivePreset, '我的');
    assert.equal(calls.changed, 1);
    assert.equal(calls.presetApplied, 0);
});

test('空预设名直接忽略', () => {
    eq.saveEqPreset('');
    assert.equal(store.has('aria_eq_custom'), false);
});

test('持久化往返：save 后重新 load 能拿回增益与预设', () => {
    eq.applyEqGains([5, 4, 3, 2, 1, 0, 1, 2, 3, 4]);
    state.eqActivePreset = '我的';
    eq.saveEqSettings();
    resetDeps();
    eq.loadEqSettings();
    assert.deepEqual(state.eqGains, [5, 4, 3, 2, 1, 0, 1, 2, 3, 4]);
    assert.equal(state.eqActivePreset, '我的');
});

test('脏数据不破功：段数不对 / JSON 坏掉时保持原状', async () => {
    const { EQ_STORAGE_KEY } = await import('../../web/src/config/constants.js');
    const original = state.eqGains.slice();
    store.set(EQ_STORAGE_KEY, JSON.stringify({ gains: [1, 2, 3] }));
    eq.loadEqSettings();
    assert.deepEqual(state.eqGains, original, '长度不是 10 必须整条忽略');
    assert.equal(state.eqActivePreset, '默认', '脏数据不该顺带改预设');
    store.set(EQ_STORAGE_KEY, '{坏 JSON');
    eq.loadEqSettings();
    assert.deepEqual(state.eqGains, original, '解析失败必须被吞住且不改状态');
    /* 合法数据仍然要生效（证明上面两次不是因为根本没读到才通过） */
    store.set(EQ_STORAGE_KEY, JSON.stringify({ gains: new Array(10).fill(7), preset: '摇滚' }));
    eq.loadEqSettings();
    assert.deepEqual(state.eqGains, new Array(10).fill(7));
    assert.equal(state.eqActivePreset, '摇滚');
});

test('cleanupEqAudioGraph：节点断开、上下文关闭、状态复位', () => {
    resetDeps({ inited: true });
    eq.cleanupEqAudioGraph();
    assert.equal(calls.disconnects, 11, '10 个滤波节点 + source');
    assert.equal(calls.closes, 1);
    assert.equal(state.eqInited, false);
    assert.equal(state.audioCtx, null);
    assert.deepEqual(state.eqFilterNodes, []);
});

test('getCustomEqs 遇到坏 JSON 返回空表而不是抛', () => {
    store.set('aria_eq_custom', '{不是JSON');
    assert.deepEqual(eq.getCustomEqs(), {});
});
