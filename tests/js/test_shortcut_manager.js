/* ============================================================
 * tests/js/test_shortcut_manager.js — core/shortcutManager.js 行为回归
 *
 * 盯住从 app/110-keyboard-nav.js 抽取时最容易改坏的三点：
 *   · 快捷键必须走按钮 .click()（不是回调），否则按钮副作用全丢；
 *   · 音量是 0~100 百分比且要夹在 [0,100]（旧快照用的是 0~1，接上就失灵）；
 *   · prev/next 在按住 Ctrl 时要让位（Ctrl+←/→ 是逐段跳转）。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const st = await import('../../web/src/infrastructure/state.js');
const sm = await import('../../web/src/core/shortcutManager.js');
const state = st.state;

function fakeKey(key, opts = {}) {
    let prevented = false;
    return {
        key,
        ctrlKey: !!opts.ctrlKey,
        shiftKey: !!opts.shiftKey,
        altKey: !!opts.altKey,
        preventDefault: () => { prevented = true; },
        get prevented() { return prevented; },
    };
}

function makeCtx({ volume = 50, duration = 200, currentTime = 100, seekStep = 5 } = {}) {
    const clicked = [];
    const mk = (name) => ({ click: () => clicked.push(name) });
    const volumes = [];
    const ctx = {
        inInput: false,
        audio: { duration, currentTime },
        playBtn: mk('play'),
        prevBtn: mk('prev'),
        nextBtn: mk('next'),
        favoriteBtn: mk('fav'),
        moreBtn: mk('more'),
        updateVolume: (v) => volumes.push(v),
        clicked,
        volumes,
    };
    state.volume = volume;
    state.appSettings = {
        shortcuts: { playPause: ' ', prev: 'p', next: 'n', volumeUp: '=', volumeDown: '-', favorite: 'f', toggleLyrics: 'l', more: 'm' },
        playback: { seekStep },
    };
    return ctx;
}

beforeEach(() => { state.volume = 50; state.appSettings = null; });

test('播放/暂停快捷键点的是按钮本身，不是回调（按钮副作用不能丢）', () => {
    const ctx = makeCtx();
    assert.equal(sm.handleShortcutKeys(fakeKey(' '), ctx), true);
    assert.deepEqual(ctx.clicked, ['play']);
});

test('未映射的键返回 false，让调用方继续走后续逻辑', () => {
    const ctx = makeCtx();
    assert.equal(sm.handleShortcutKeys(fakeKey('Q'), ctx), false);
    assert.equal(ctx.clicked.length, 0);
});

test('音量键是 0~100 百分比，且夹在 [0,100]（旧快照用 0~1，接上即失灵）', () => {
    const ctx = makeCtx({ volume: 98 });
    sm.handleShortcutKeys(fakeKey('=', ctx), ctx);
    assert.deepEqual(ctx.volumes, [100], '98+5 必须夹到 100');
    const ctx2 = makeCtx({ volume: 2 });
    sm.handleShortcutKeys(fakeKey('-'), ctx2);
    assert.deepEqual(ctx2.volumes, [0], '2-5 必须夹到 0');
});

test('输入框聚焦时让位：不点击、不改音量，但算已消费', () => {
    const ctx = makeCtx();
    ctx.inInput = true;
    const ev = fakeKey(' ');
    assert.equal(sm.handleShortcutKeys(ev, ctx), true);
    assert.equal(ctx.clicked.length, 0);
    assert.equal(ev.prevented, false, '输入框里不该 preventDefault，否则打不出空格');
});

test('Ctrl+→ 按 seekStep 前进，并夹在 duration 内', () => {
    const ctx = makeCtx({ currentTime: 100, duration: 200, seekStep: 7 });
    const ev = fakeKey('ArrowRight', { ctrlKey: true });
    assert.equal(sm.handleShortcutKeys(ev, ctx), true);
    assert.equal(ctx.audio.currentTime, 107);
    assert.equal(ctx.clicked.length, 0, 'Ctrl+方向键是跳转，不该触发切歌');
    const ctx2 = makeCtx({ currentTime: 198, duration: 200 });
    sm.handleShortcutKeys(fakeKey('ArrowRight', { ctrlKey: true }), ctx2);
    assert.equal(ctx2.audio.currentTime, 200, '必须夹到 duration');
});

test('Ctrl+← 后退到 0 为止', () => {
    const ctx = makeCtx({ currentTime: 2, duration: 200, seekStep: 5 });
    sm.handleShortcutKeys(fakeKey('ArrowLeft', { ctrlKey: true }), ctx);
    assert.equal(ctx.audio.currentTime, 0);
});

test('上一曲/下一曲在按住 Ctrl 时让位（不与 Ctrl+方向键抢）', () => {
    const ctx = makeCtx();
    const ev = fakeKey('n', { ctrlKey: true });
    assert.equal(sm.handleShortcutKeys(ev, ctx), true);
    assert.equal(ctx.clicked.length, 0);
});

test('收藏 / 更多 / 上一曲 各自点对应按钮', () => {
    const ctx = makeCtx();
    sm.handleShortcutKeys(fakeKey('f'), ctx);
    sm.handleShortcutKeys(fakeKey('m'), ctx);
    sm.handleShortcutKeys(fakeKey('p'), ctx);
    assert.deepEqual(ctx.clicked, ['fav', 'more', 'prev']);
});

test('没有 appSettings 时不抛错（启动早期设置未加载）', () => {
    const ctx = makeCtx();
    state.appSettings = null;
    assert.equal(sm.handleShortcutKeys(fakeKey(' '), ctx), false);
});
