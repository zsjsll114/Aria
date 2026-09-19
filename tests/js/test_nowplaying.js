/* ============================================================
 * tests/js/test_nowplaying.js — now-playing 负载容错解析纯函数单测
 * 运行方式：node --test tests/js/test_nowplaying.js
 * 覆盖：{data:{...}} 包裹(now-playing-service) / 平铺(kthri) / 通用键集 /
 *      缺标题返回 null / durationMs 毫秒→秒 / isPlaying 多种状态值 /
 *      nowPlayingKey 小写+去空白判等
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeNowPlayingPayload, nowPlayingKey } from '../../web/src/services/nowPlayingNormalize.js';

test('normalize：非对象/缺歌名返回 null', () => {
    assert.equal(normalizeNowPlayingPayload(null), null);
    assert.equal(normalizeNowPlayingPayload(undefined), null);
    assert.equal(normalizeNowPlayingPayload('x'), null);
    assert.equal(normalizeNowPlayingPayload({}), null);
    assert.equal(normalizeNowPlayingPayload({ data: {} }), null);
    assert.equal(normalizeNowPlayingPayload({ data: { artist: '只有歌手' } }), null);
});

test('normalize：now-playing-service 风格 {data:{...}} 包裹', () => {
    const r = normalizeNowPlayingPayload({
        data: { title: '雾里看花', artist: '那英', cover: 'http://c/1.jpg', duration: 214, isPlaying: true }
    });
    assert.deepEqual(r, {
        title: '雾里看花', artist: '那英', cover: 'http://c/1.jpg', duration: 214, isPlaying: true,
        paused: false, seek: 0
    });
});

test('normalize：kthri/now-playing 平铺风格（artwork_url + durationMs + 数字艺术家）', () => {
    const r = normalizeNowPlayingPayload({
        source: 'apple-music', title: 'Shake It Off', artist: 'Taylor Swift',
        album: '1989', artwork_url: 'http://c/a.png', durationMs: 219000
    });
    assert.deepEqual(r, {
        title: 'Shake It Off', artist: 'Taylor Swift', cover: 'http://c/a.png', duration: 219, isPlaying: false,
        paused: false, seek: 0
    });
});

test('normalize：通用键集 song/singer/picUrl 与字符串时长/播放状态', () => {
    const r = normalizeNowPlayingPayload({
        song: '海阔天空', singer: 'BEYOND', picUrl: 'http://c/b.jpg', duration: '260', status: 'playing'
    });
    assert.deepEqual(r, {
        title: '海阔天空', artist: 'BEYOND', cover: 'http://c/b.jpg', duration: 260, isPlaying: true,
        paused: false, seek: 0
    });
});

test('normalize：isPlaying 由 state/playState/value 识别', () => {
    assert.equal(normalizeNowPlayingPayload({ title: 'x', state: 'playing' }).isPlaying, true);
    assert.equal(normalizeNowPlayingPayload({ title: 'x', playState: 'playing' }).isPlaying, true);
    assert.equal(normalizeNowPlayingPayload({ title: 'x', isPlaying: true }).isPlaying, true);
    assert.equal(normalizeNowPlayingPayload({ title: 'x', state: 'paused' }).isPlaying, false);
    assert.equal(normalizeNowPlayingPayload({ title: 'x' }).isPlaying, false);
});

test('nowPlayingKey：小写 + 去首尾空白后判等（同名不同大小写视为同一首）', () => {
    const a = normalizeNowPlayingPayload({ title: '  Hello World ', artist: '  ABBA ' });
    const b = normalizeNowPlayingPayload({ title: 'hello world', artist: 'abba' });
    assert.equal(nowPlayingKey(a), nowPlayingKey(b));
    const c = normalizeNowPlayingPayload({ title: 'Hello World', artist: 'Beatles' });
    assert.notEqual(nowPlayingKey(a), nowPlayingKey(c));
});

test('normalize：嵌套 data 为空对象时回退平铺（兼容初版 kthri）', () => {
    const r = normalizeNowPlayingPayload({ data: {}, title: 'Fallback Title', artist: 'No One' });
    assert.equal(r.title, 'Fallback Title');
    assert.equal(r.artist, 'No One');
});

test('normalize：{data:{song:{...}}} 深层嵌套 + cover_url + is_playing（/api/query 风格）', () => {
    const r = normalizeNowPlayingPayload({
        data: {
            song: { name: '晴天', artists: [{ name: '周杰伦' }], cover_url: 'http://c/s.jpg', duration_ms: 269000 },
            player: { is_playing: true }
        }
    });
    assert.deepEqual(r, {
        title: '晴天', artist: '周杰伦', cover: 'http://c/s.jpg', duration: 269, isPlaying: true,
        paused: false, seek: 0
    });
});

test('normalize：顶层 song/track 对象与 artists 数组（无 data 包裹）', () => {
    const r = normalizeNowPlayingPayload({
        track: { title: '富士山下', artists: ['陈奕迅'], cover_url: 'http://c/f.jpg' },
        is_playing: true
    });
    assert.deepEqual(r, {
        title: '富士山下', artist: '陈奕迅', cover: 'http://c/f.jpg', duration: 0, isPlaying: true,
        paused: false, seek: 0
    });
});

test('normalize：player 对象不污染歌名（name 键属于播放器）', () => {
    const r = normalizeNowPlayingPayload({
        song: { title: '孤勇者' },
        player: { name: '网易云音乐', playing: true }
    });
    assert.equal(r.title, '孤勇者');
    assert.equal(r.isPlaying, true);
});

test('normalize：kthri/now-playing(9863) 只报 hasSong/isPaused 时，用 isPaused:false 反推「在播」', () => {
    const playing = normalizeNowPlayingPayload({
        player: { hasSong: true, isPaused: false, volumePercent: 80, seekbarCurrentPosition: 42 },
        track: { title: '互删 (我走以后)', author: '江辰', album: '互删 (我走以后)', duration: 211 }
    });
    assert.equal(playing.title, '互删 (我走以后)');
    assert.equal(playing.artist, '江辰');
    assert.equal(playing.isPlaying, true);
    assert.equal(playing.paused, false);
    assert.equal(playing.seek, 42);

    const paused = normalizeNowPlayingPayload({
        player: { hasSong: true, isPaused: true },
        track: { title: '互删 (我走以后)', author: '江辰' }
    });
    assert.equal(paused.isPlaying, false);
    assert.equal(paused.paused, true);
    assert.equal(paused.seek, 0);

    /* 显式 isPlaying 优先：即使 isPaused:false 也不覆盖显式 false */
    const explicit = normalizeNowPlayingPayload({
        player: { isPlaying: false, isPaused: false },
        track: { title: 'x' }
    });
    assert.equal(explicit.isPlaying, false);
});