/* ============================================================
 * tests/js/test_dual_deck.js — core/dualDeck.js 行为回归（Automix Phase 1）
 *
 * 盯三件事：
 *   · registerAudioListener 挂到活跃 deck，swapRoles 后成对搬运到新 deck；
 *   · swap 时 onRoleSwap 回调逐个收到新活跃元素，单个回调抛错不拖垮其余；
 *   · 未初始化时 register 只登记不挂载（node 行为测试的兜底语义），
 *     init 后补挂已有登记——「装配序变化不丢监听」。
 * 手法：假 audio 元素（addEventListener/removeEventListener 记账），
 * document stub 供影子元素创建。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const dd = await import('../../web/src/core/dualDeck.js');

/** 记账式假 audio 元素 */
function fakeAudio(id) {
    const listeners = new Map();  /* type -> Set<fn> */
    return {
        id,
        listeners,
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            listeners.get(type)?.delete(fn);
        },
        hasListener(type, fn) {
            return listeners.get(type)?.has(fn) || false;
        },
        remove() {},
    };
}

/* dualDeck 创建影子元素需要 document stub */
beforeEach(() => {
    dd._resetDualDeckForTest();
    /* 经 globalThis 挂载（裸 document 会吃 no-undef error） */
    globalThis.document = {
        created: [],
        createElement(tag) {
            const el = fakeAudio(`created-${tag}-${this.created.length}`);
            el.style = {};
            el.setAttribute = () => {};
            this.created.push(el);
            return el;
        },
        body: { appendChild() {} },
    };
});

test('init + register：监听挂到活跃 deck', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    assert.equal(dd.getActiveAudio(), a);
    assert.ok(dd.getShadowAudio(), '影子 deck 已创建');
    const fn = () => {};
    dd.registerAudioListener('play', fn);
    assert.ok(a.hasListener('play', fn));
});

test('swapRoles：监听成对搬运，回调收到新活跃元素', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    const fnPlay = () => {};
    const fnEnded = () => {};
    dd.registerAudioListener('play', fnPlay);
    dd.registerAudioListener('ended', fnEnded, { passive: true });

    let swappedTo = null;
    dd.onRoleSwap((el) => { swappedTo = el; });

    const shadow = dd.getShadowAudio();
    dd.swapRoles();

    assert.equal(dd.getActiveAudio(), shadow, '影子升为活跃');
    assert.equal(dd.getShadowAudio(), a, '旧活跃降为影子');
    assert.equal(swappedTo, shadow);
    assert.ok(!a.hasListener('play', fnPlay), '旧 deck 已摘除');
    assert.ok(!a.hasListener('ended', fnEnded), '旧 deck 已摘除');
    assert.ok(shadow.hasListener('play', fnPlay), '新 deck 已挂载');
    assert.ok(shadow.hasListener('ended', fnEnded), '新 deck 已挂载');
});

test('swapRoles：单个 swap 回调抛错不拖垮其余回调', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    const seen = [];
    dd.onRoleSwap(() => { throw new Error('boom'); });
    dd.onRoleSwap((el) => { seen.push(el); });
    dd.swapRoles();
    assert.equal(seen.length, 1, '第二个回调仍然执行');
});

test('未初始化 register 只登记；init 后补挂（装配序防御）', () => {
    const fn = () => {};
    dd.registerAudioListener('pause', fn);   /* 此时 deckA 为 null */
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    assert.ok(a.hasListener('pause', fn), 'init 时补挂已登记监听');
});

test('幂等：重复 init 不重置；无 swap 调用者时影子永不参与（Phase 1 承诺）', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    const shadow1 = dd.getShadowAudio();
    dd.initDualDeck(fakeAudio('X'));
    assert.equal(dd.getActiveAudio(), a, '重复 init 不换 deck');
    assert.equal(dd.getShadowAudio(), shadow1);
    assert.equal(globalThis.document.created.length, 1, '影子元素只创建一次');
});

/* ========== replaceActiveDeck（原生输出线 Phase 2b）========== */

test('replaceActiveDeck：常驻监听搬到新 deck，onRoleSwap 收到新活跃元素', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    const fnPlay = () => {};
    const fnTime = () => {};
    dd.registerAudioListener('play', fnPlay);
    dd.registerAudioListener('timeupdate', fnTime);

    let swappedTo = null;
    dd.onRoleSwap((el) => { swappedTo = el; });

    const native = fakeAudio('native');
    dd.replaceActiveDeck(native);

    assert.equal(dd.getActiveAudio(), native);
    assert.equal(swappedTo, native, '必须通知：audio live binding 靠这条回调重指');
    assert.ok(!a.hasListener('play', fnPlay), '旧元素已摘除');
    assert.ok(native.hasListener('play', fnPlay), '新 deck 已挂载');
    assert.ok(native.hasListener('timeupdate', fnTime));
    assert.notEqual(dd.getShadowAudio(), native, '顶替不碰影子 deck 的身份');
});

test('replaceActiveDeck：同引用幂等，不产生额外搬运与回调', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    let swaps = 0;
    dd.onRoleSwap(() => { swaps += 1; });
    dd.replaceActiveDeck(a);
    assert.equal(swaps, 0);
    assert.equal(dd.getActiveAudio(), a);
});

test('replaceActiveDeck：可换回原元素（关掉原生输出时走这条）', () => {
    const a = fakeAudio('A');
    dd.initDualDeck(a);
    const fn = () => {};
    dd.registerAudioListener('pause', fn);
    const native = fakeAudio('native');
    dd.replaceActiveDeck(native);
    dd.replaceActiveDeck(a);
    assert.equal(dd.getActiveAudio(), a);
    assert.ok(a.hasListener('pause', fn), '监听回到 HTML 元素');
    assert.ok(!native.hasListener('pause', fn), '原生 deck 已摘除');
});

test('replaceActiveDeck：未 init 就顶替时把已登记监听补挂上（否则整条播放链路静默失效）', () => {
    const fn = () => {};
    dd.registerAudioListener('ended', fn);   /* deckA 仍为 null */
    const native = fakeAudio('native');
    dd.replaceActiveDeck(native);
    assert.equal(dd.getActiveAudio(), native);
    assert.ok(native.hasListener('ended', fn));
});
