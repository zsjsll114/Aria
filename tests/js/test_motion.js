/* ============================================================
 * tests/js/test_motion.js — utils/motion.js 退场运行时行为回归
 *
 * 盯的是 CSS 单独办不到、必须由 JS 保证的几件事：
 *   · 演完退场才执行卸载回调（display:none / remove()）；
 *   · 落地前必须先摘 .is-concealing 释放 fill:forwards——顺序反了下次显示该元素是透明的；
 *   · 只认本元素本条动画：子元素冒泡上来的 animationend 不能提前收尾；
 *   · 同一元素连开两次时前一次回调作废——「切走又切回」不能被陈旧回调藏掉；
 *   · 时间轴被冻住（后台窗口）时 animationend 不会来，兜底计时器必须落地；
 *   · 返回的 promise 以「本次落地」为准，不能跟着动画挂死；
 *   · prefers-reduced-motion 时不起动画直接终态。
 * 手法：假 element（自己派发 animationend），不引 jsdom。
 * ============================================================ */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../../web/src/utils/motion.js');
const { CONCEAL_CLASS, CONCEAL_ANIM } = m;

function fakeEl(section = 'sec') {
    const set = new Set();
    const el = {
        dataset: { section },
        order: [],
        props: {},
        listeners: {},
        style: {
            setProperty(k, v) { el.props[k] = String(v); },
            removeProperty(k) { delete el.props[k]; },
        },
        classList: {
            add(c) { set.add(c); el.order.push('add:' + c); },
            remove(c) { if (set.has(c)) { set.delete(c); el.order.push('remove:' + c); } },
            contains(c) { return set.has(c); },
        },
    };
    el.addEventListener = (t, fn) => { (el.listeners[t] ||= []).push(fn); };
    el.removeEventListener = (t, fn) => { el.listeners[t] = (el.listeners[t] || []).filter((f) => f !== fn); };
    el.count = (t) => (el.listeners[t] || []).length;
    el.fire = (type, extra = {}) => {
        for (const fn of (el.listeners[type] || []).slice()) {
            fn({ type, target: el, animationName: CONCEAL_ANIM, ...extra });
        }
    };
    return el;
}

const realWindow = globalThis.window;
const realSetTimeout = globalThis.setTimeout;

/** 立刻结束动画，返回 conceal 的 promise 结果 */
async function runConceal(el, opts) {
    const p = m.conceal(el, opts);
    el.fire('animationend');
    return p;
}

afterEach(() => {
    if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
    globalThis.setTimeout = realSetTimeout;
    m._resetMotionTokensForTest();
});

test('parseTimeMs 认 ms / s / 空 / 垃圾四种输入', () => {
    assert.equal(m.parseTimeMs('160ms'), 160);
    assert.equal(m.parseTimeMs('0.16s'), 160);
    assert.equal(m.parseTimeMs('  340ms '), 340);
    assert.equal(m.parseTimeMs('', 42), 42);
    assert.equal(m.parseTimeMs('auto', 7), 7);
    assert.equal(m.parseTimeMs(null, 5), 5);
});

test('parseLen 只认 px，其余归零而不是猜单位', () => {
    assert.equal(m.parseLen('8px'), 8);
    assert.equal(m.parseLen('0'), 0);
    assert.equal(m.parseLen('0.5rem'), 0);
    assert.equal(m.parseLen('', 16), 16);
});

test('令牌缺省值与 motion.css 里的数字对齐', () => {
    m._resetMotionTokensForTest();
    const tk = m.motionTokens();
    assert.equal(tk.dFast, 160);
    assert.equal(tk.dyOut, 8);
    assert.equal(tk.dLayer, 340);
    assert.equal(tk.sOut, 0.992);
});

test('conceal 挂上退场 class，并把时长/幅度经自定义属性交给 CSS', () => {
    const el = fakeEl();
    m.conceal(el, {});
    assert.equal(el.classList.contains(CONCEAL_CLASS), true);
    assert.equal(el.props['--conceal-dur'], '160ms');
    assert.equal(el.props['--conceal-y'], '8px');
    assert.equal(el.props['--conceal-scale'], '0.992');
});

test('conceal：animationend 之前不得提前落隐藏', async () => {
    const el = fakeEl();
    let hidden = false;
    const p = m.conceal(el, { onHidden: () => { hidden = true; } });
    assert.equal(hidden, false);
    el.fire('animationend');
    assert.equal(await p, true);
    assert.equal(hidden, true);
});

test('conceal：先摘 class 释放 fill:forwards，再执行 onHidden', async () => {
    const el = fakeEl();
    const p = m.conceal(el, { onHidden: () => el.order.push('hidden') });
    el.fire('animationend');
    assert.equal(await p, true);
    assert.deepEqual(el.order, ['add:' + CONCEAL_CLASS, 'remove:' + CONCEAL_CLASS, 'hidden'],
        '顺序反了会把元素永久钉在透明态');
});

test('conceal：结束后摘掉监听器与入参，不留累积', async () => {
    const el = fakeEl();
    await runConceal(el, { onHidden: () => {} });
    assert.equal(el.count('animationend'), 0);
    assert.equal(el.count('animationcancel'), 0);
    assert.deepEqual(el.props, {}, '退场入参要擦干净，否则 DevTools 里看着像还在生效');
});

test('conceal：子元素冒泡上来的 animationend 不算结束', async () => {
    const el = fakeEl();
    let hidden = false;
    const p = m.conceal(el, { onHidden: () => { hidden = true; } });
    el.fire('animationend', { target: { not: el } });
    assert.equal(hidden, false, '子元素（如分区里的开关）自己的动画会误触发');
    el.fire('animationend', { animationName: 'ariaSectionIn' });
    assert.equal(hidden, false, '同名元素上的其它动画不能接管');
    el.fire('animationend');
    assert.equal(await p, true);
    assert.equal(hidden, true);
});

test('conceal：animationcancel 同样落地，否则元素卡在 is-concealing', async () => {
    const el = fakeEl();
    let hidden = false;
    const p = m.conceal(el, { onHidden: () => { hidden = true; } });
    el.fire('animationcancel');
    assert.equal(await p, true);
    assert.equal(hidden, true);
    assert.equal(el.classList.contains(CONCEAL_CLASS), false);
});

test('conceal：同一元素连开两次，前一次回调作废', async () => {
    const el = fakeEl();
    let first = 0;
    let second = 0;
    const p1 = m.conceal(el, { onHidden: () => { first++; } });
    const p2 = m.conceal(el, { onHidden: () => { second++; } });
    el.fire('animationend');
    await p1;
    await p2;
    assert.equal(first, 0, '被取代的那次不得落地');
    assert.equal(second, 1);
});

test('conceal：不同元素各退各的，互不作废', async () => {
    const a = fakeEl('a');
    const b = fakeEl('b');
    let n = 0;
    const pa = m.conceal(a, { onHidden: () => { n++; } });
    const pb = m.conceal(b, { onHidden: () => { n++; } });
    a.fire('animationend');
    b.fire('animationend');
    await pa;
    await pb;
    assert.equal(n, 2);
});

test('conceal：时间轴被冻住时兜底计时器仍要落地', async () => {
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    const el = fakeEl();
    let hidden = false;
    const ok = await m.conceal(el, { onHidden: () => { hidden = true; } });
    assert.equal(hidden, true, '兜底没落地的话退场中的分区会一直盖在新分区上');
    assert.equal(ok, true);
    assert.equal(el.classList.contains(CONCEAL_CLASS), false);
});

test('conceal：兜底与动画结束只落地一次', async () => {
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    const el = fakeEl();
    let n = 0;
    const p = m.conceal(el, { onHidden: () => { n++; } });   // 兜底同步触发
    el.fire('animationend');                                  // 动画随后才结束
    await p;
    assert.equal(n, 1, '重复落地会把刚显示的新状态又拍回隐藏');
});

test('conceal：prefers-reduced-motion 时起 0 时长路径——不挂动画直接终态', async () => {
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    m._resetMotionTokensForTest();
    const el = fakeEl();
    let hidden = false;
    const ok = await m.conceal(el, { onHidden: () => { hidden = true; } });
    assert.equal(el.classList.contains(CONCEAL_CLASS), false);
    assert.equal(hidden, true);
    assert.equal(ok, true);
});

test('conceal：传进来不是元素（null / 裸对象）时退化为立刻隐藏，不卡功能', async () => {
    let hidden = false;
    assert.equal(await m.conceal(null, { onHidden: () => {} }), true);
    assert.equal(await m.conceal({}, { onHidden: () => { hidden = true; } }), true);
    assert.equal(hidden, true);
});

test('conceal：onHidden 抛错只留痕，本次仍算落地', async () => {
    const el = fakeEl();
    const p = m.conceal(el, { onHidden: () => { throw new Error('boom'); } });
    el.fire('animationend');
    assert.equal(await p, true);
});

test('自定义 durationMs / y / scale 覆盖令牌值', async () => {
    const el = fakeEl();
    const p = m.conceal(el, { durationMs: 400, y: 0, scale: 1 });
    assert.equal(el.props['--conceal-dur'], '400ms');
    assert.equal(el.props['--conceal-y'], '0px');
    assert.equal(el.props['--conceal-scale'], '1');
    el.fire('animationend');
    assert.equal(await p, true);
});

test('退场幅度比进场小：默认用 --dy-out(8) 而不是 --dy-in(16)', () => {
    const el = fakeEl();
    m.conceal(el, {});
    assert.equal(el.props['--conceal-y'], '8px');
});
