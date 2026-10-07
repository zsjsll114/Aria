/* ============================================================
 * test_mv_backdrop.js — 「MV 背景 × 全景模式舞台压薄」契约钉
 *
 * 这份测试存在的理由：tempera / tunnel 两个模式的「底」分散在
 * 两个引擎里各自实现（Pixi clear alpha / Graphics fill alpha / 烘焙进
 * background-color 的块 alpha），它们唯一的共同依据就是这个模块。
 * 契约一旦松动，表现是「有的模式透、有的不透」「不开 MV 观感也变了」——
 * 前者用户会当成没修好，后者是**静默的观感回归**（不开 MV 的人不会来报，
 * 但整个模式的画面已经不是原来那个了）。所以这里把两条边界钉死：
 *   ① 因子只有两个取值（1 / MV_BACKDROP_ALPHA），判据只有 body.mv-bg-on；
 *   ② 没有 document / 没有 window 时必须是安全的 no-op。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MV_BACKDROP_ALPHA,
    MV_BACKDROP_EVENT,
    mvBgActive,
    mvBackdropAlpha,
    onMvBackdropChange,
    broadcastMvBackdrop,
} from '../../web/src/core/visualizers/mvBackdrop.js';

const realDoc = globalThis.document;
const realWin = globalThis.window;

/** 用一个可控的 body.classList 桩替代真实 DOM（模块是调用时读，不是导入时读） */
function stubDom({ mvOn = false } = {}) {
    const classes = new Set(mvOn ? ['mv-bg-on'] : []);
    globalThis.document = {
        body: {
            classList: {
                contains: (c) => classes.has(c),
                toggle: (c, on) => {
                    const want = on === undefined ? !classes.has(c) : !!on;
                    if (want) classes.add(c); else classes.delete(c);
                },
            },
        },
    };
    globalThis.window = new EventTarget();
    return classes;
}

function restoreDom() {
    if (realDoc === undefined) delete globalThis.document; else globalThis.document = realDoc;
    if (realWin === undefined) delete globalThis.window; else globalThis.window = realWin;
}

test('没有 document 时一律不压薄，且不抛（SSR / 工具脚本）', () => {
    restoreDom();
    delete globalThis.document;
    assert.equal(mvBgActive(), false);
    assert.equal(mvBackdropAlpha(), 1);
    restoreDom();
});

test('body 没有 mv-bg-on → 因子 1（不开 MV / 没匹配到 MV 时，各模式观感一个像素不变）', () => {
    stubDom({ mvOn: false });
    try {
        assert.equal(mvBgActive(), false);
        assert.equal(mvBackdropAlpha(), 1);
    } finally { restoreDom(); }
});

test('body 有 mv-bg-on → 因子 = MV_BACKDROP_ALPHA（压薄但不透光抹掉）', () => {
    stubDom({ mvOn: true });
    try {
        assert.equal(mvBgActive(), true);
        assert.equal(mvBackdropAlpha(), MV_BACKDROP_ALPHA);
        /* 因子必须是"透"的：0 会让模式彻底消失（只剩 MV，歌词排版语言全没了）；
           1 等于没压薄（用户报的现象）。两头都要挡住。 */
        assert.ok(MV_BACKDROP_ALPHA > 0 && MV_BACKDROP_ALPHA < 1,
            `因子必须落在 (0,1)，实际 ${MV_BACKDROP_ALPHA}`);
    } finally { restoreDom(); }
});

test('预览宿主不压薄：设置面板里的预览窗底下没有 MV，压薄只会让它变透明露出面板', () => {
    stubDom({ mvOn: true });
    try {
        const mainHost = { closest: () => null };
        const previewHost = { closest: () => ({}) };
        assert.equal(mvBackdropAlpha(mainHost), MV_BACKDROP_ALPHA);
        assert.equal(mvBackdropAlpha(previewHost), 1);
        /* 宿主没传 / 不是元素：按主播放器处理，老调用点行为不变 */
        assert.equal(mvBackdropAlpha(), MV_BACKDROP_ALPHA);
        assert.equal(mvBackdropAlpha({}), MV_BACKDROP_ALPHA);
    } finally { restoreDom(); }
});

test('MV 关着时不问宿主：一律 1（预览与主播放器都不用管）', () => {
    stubDom({ mvOn: false });
    try {
        assert.equal(mvBackdropAlpha({ closest: () => null }), 1);
        assert.equal(mvBackdropAlpha({ closest: () => ({}) }), 1);
    } finally { restoreDom(); }
});

test('broadcast 让订阅者自己重算（不给入参），退订后不再收到', () => {
    const classes = stubDom({ mvOn: false });
    const seen = [];
    /* ★ 回调故意不接入参：入参是"全应用一个数"，而预览窗要按宿主返回 1，
       业务侧必须自己 mvBackdropAlpha(自己的宿主)。这里就是那个约定的钉子。 */
    const off = onMvBackdropChange(() => seen.push(mvBackdropAlpha()));
    try {
        broadcastMvBackdrop();
        assert.deepEqual(seen, [1]);
        classes.add('mv-bg-on');
        broadcastMvBackdrop();
        assert.deepEqual(seen, [1, MV_BACKDROP_ALPHA]);
        /* 退订后广播不再打扰它（引擎 destroy 必须走到这一步，否则监听器泄漏） */
        off();
        classes.delete('mv-bg-on');
        broadcastMvBackdrop();
        assert.deepEqual(seen, [1, MV_BACKDROP_ALPHA]);
    } finally { restoreDom(); }
});

test('订阅方回调抛异常不会打断广播（一个引擎炸了不能连累另外两个模式）', () => {
    stubDom({ mvOn: true });
    const off1 = onMvBackdropChange(() => { throw new Error('boom'); });
    const got = [];
    const off2 = onMvBackdropChange(() => got.push(1));
    try {
        assert.doesNotThrow(() => broadcastMvBackdrop());
        assert.deepEqual(got, [1]);
    } finally { off1(); off2(); restoreDom(); }
});

test('没有 window 时订阅是安全的 no-op：返回可调用的退订函数', () => {
    stubDom({ mvOn: true });
    delete globalThis.window;
    try {
        const off = onMvBackdropChange(() => { throw new Error('不该被调用'); });
        assert.equal(typeof off, 'function');
        assert.doesNotThrow(() => off());
        assert.doesNotThrow(() => broadcastMvBackdrop());
    } finally { restoreDom(); }
});

test('事件名固定：三个引擎与 101 靠它对齐，改名等于静默断链', () => {
    assert.equal(MV_BACKDROP_EVENT, 'aria:mv-bg-change');
});
