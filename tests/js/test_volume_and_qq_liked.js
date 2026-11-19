/**
 * @file tests/js/test_volume_and_qq_liked.js
 * 回归测试：
 *   1. readSavedVolume / writeSavedVolume：精确 0、夹取、NaN 防御、时间戳与 legacy initialVolume 迁移
 *   2. DEFAULT_SETTINGS：移除 initialVolume / volumeNormalization，保留 bottomBarCollapsed=false
 *   3. selfhost-runtime.js：QQ 我喜欢的歌（dirid=201、response 包裹、空列表、歌单列表）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const _store = new Map();
if (!globalThis.window) globalThis.window = globalThis;
globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
    clear: () => _store.clear(),
};
if (!globalThis.CustomEvent) {
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    };
}
if (!globalThis.window.dispatchEvent) {
    globalThis.window.dispatchEvent = () => true;
}

const { SETTINGS_STORAGE_KEY, VOLUME_STORAGE_KEY, VOLUME_TS_STORAGE_KEY } = await import('../../web/src/config/constants.js');
const { DEFAULT_SETTINGS } = await import('../../web/src/config/defaults.js');
const { readSavedVolume, writeSavedVolume } = await import('../../web/src/core/settingsStore.js');
const {
    invalidateSelfhostCaches,
    normQQTracks,
    selfhostFavorites,
    selfhostPlaylistSongs,
    selfhostPlaylists,
} = await import('../../web/src/app/selfhost-runtime.js');

function jsonRes(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

function withMockFetch(handler, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => handler(String(url), opts || {});
    return Promise.resolve().then(fn).finally(() => {
        globalThis.fetch = orig;
    });
}

test('settingsStore: volume persistence supports 0, clamping, NaN, and legacy migration', () => {
    _store.clear();
    assert.equal(readSavedVolume(), 80);
    assert.equal(readSavedVolume(65), 65);

    // 精确写入与读回 0（不可被当作 falsy 丢回默认值）
    assert.equal(writeSavedVolume(0), 0);
    assert.equal(readSavedVolume(80), 0);
    assert.ok(Number(globalThis.localStorage.getItem(VOLUME_TS_STORAGE_KEY)) > 0);

    // 夹取与四舍五入
    assert.equal(writeSavedVolume(-12), 0);
    assert.equal(readSavedVolume(), 0);
    assert.equal(writeSavedVolume(135.4), 100);
    assert.equal(readSavedVolume(), 100);
    assert.equal(writeSavedVolume(37.6), 38);
    assert.equal(readSavedVolume(), 38);

    // 非数字写入不得污染已有记录
    assert.equal(writeSavedVolume('not-a-number'), undefined);
    assert.equal(readSavedVolume(), 38);

    // legacy initialVolume / lastVolume 迁移（当 VOLUME_STORAGE_KEY 为空时）
    _store.clear();
    globalThis.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        playback: { initialVolume: 42 },
    }));
    assert.equal(readSavedVolume(), 42);

    globalThis.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        playback: { lastVolume: 0, initialVolume: 90 },
    }));
    assert.equal(readSavedVolume(), 0);

    // 独立 STORAGE_KEY 优先于 legacy 设置
    globalThis.localStorage.setItem(VOLUME_STORAGE_KEY, '27');
    assert.equal(readSavedVolume(), 27);
});

test('DEFAULT_SETTINGS: removes initialVolume/volumeNormalization and includes bottomBarCollapsed', () => {
    assert.equal('initialVolume' in DEFAULT_SETTINGS.playback, false);
    assert.equal('volumeNormalization' in DEFAULT_SETTINGS.playback, false);
    assert.equal(DEFAULT_SETTINGS.playback.lastVolume, 80);
    assert.equal(DEFAULT_SETTINGS.interface.bottomBarCollapsed, false);
});

test('selfhost-runtime QQ liked: fetches populated and empty 我喜欢的歌 with dirid=201', async () => {
    _store.clear();
    invalidateSelfhostCaches();

    const hitUrls = [];
    // 1. 有曲目的「我喜欢的歌」（含 dirid=201 与 {response:{cdlist:[{songlist}]}} 包裹）
    await withMockFetch(async (url) => {
        hitUrls.push(url);
        if (url === '/api/selfhost/status') {
            return jsonRes({
                qq: { alive: true, loggedIn: true, uid: 'wx_user_1' },
                netease: { alive: false, loggedIn: false },
                kugou: { alive: false, loggedIn: false },
            });
        }
        const decoded = decodeURIComponent(url);
        if (decoded.includes('/user/getUserLikedSongs?uin=wx_user_1')) {
            return jsonRes({
                response: {
                    data: {
                        info: { id: '2019988', songCount: 1, cover: 'https://img/liked.jpg' },
                    },
                },
            });
        }
        if (decoded.includes('/getSongListDetail?disstid=2019988&dirid=201')) {
            return jsonRes({
                response: {
                    code: 0,
                    cdlist: [{
                        dissname: '我喜欢',
                        songnum: 1,
                        songlist: [{
                            mid: '0039MnYb0qxYhV',
                            title: '晴天',
                            singer: [{ name: '周杰伦' }],
                            album: { mid: '000MkMNI19ClKG', name: '叶惠美' },
                        }],
                    }],
                },
            });
        }
        if (decoded.includes('/user/getUserPlaylists?uin=wx_user_1')) {
            return jsonRes({
                response: {
                    code: 0,
                    data: {
                        playlists: [{ disstid: '777001', dirname: '自建歌单', songnum: 3, picurl: 'https://img/p1.jpg' }],
                    },
                },
            });
        }
        throw new Error(`unexpected URL: ${url}`);
    }, async () => {
        const favRes = await selfhostFavorites('qq');
        assert.equal(favRes.ok, true);
        assert.equal(favRes.list.length, 1);
        assert.equal(favRes.list[0].id, '0039MnYb0qxYhV');
        assert.equal(favRes.list[0].name, '晴天');
        assert.equal(favRes.list[0].singer, '周杰伦');

        const plRes = await selfhostPlaylists('qq');
        assert.equal(plRes.ok, true);
        assert.equal(plRes.cards[0].name, '我喜欢的歌');
        assert.equal(plRes.cards[0].key, '2019988');
        assert.equal(plRes.cards[1].key, '777001');

        const tracksRes = await selfhostPlaylistSongs('qq', '2019988');
        assert.equal(tracksRes.ok, true);
        assert.equal(tracksRes.title, '我喜欢的歌 · QQ音乐');
        assert.equal(tracksRes.list.length, 1);
    });
    assert.ok(hitUrls.some(u => decodeURIComponent(u).includes('dirid=201')));

    // 2. 空「我喜欢的歌」+ getUserLikedSongs 缺 id 仍走 disstid=0&dirid=201 且返回 ok:true, list:[]
    invalidateSelfhostCaches();
    await withMockFetch(async (url) => {
        if (url === '/api/selfhost/status') {
            return jsonRes({
                qq: { alive: true, loggedIn: true, uid: 'wx_empty_user' },
            });
        }
        const decoded = decodeURIComponent(url);
        if (decoded.includes('/user/getUserLikedSongs?uin=wx_empty_user')) {
            return jsonRes({ response: { data: { info: { id: '', songCount: 0 } } } });
        }
        if (decoded.includes('/getSongListDetail?disstid=0&dirid=201')) {
            return jsonRes({
                response: {
                    code: 0,
                    cdlist: [{ dissname: '我喜欢', songnum: 0, songlist: [] }],
                },
            });
        }
        throw new Error(`unexpected URL: ${url}`);
    }, async () => {
        const emptyFav = await selfhostFavorites('qq');
        assert.equal(emptyFav.ok, true);
        assert.deepEqual(emptyFav.list, []);

        const emptyPl = await selfhostPlaylistSongs('qq', '__qq_liked__');
        assert.equal(emptyPl.ok, true);
        assert.deepEqual(emptyPl.list, []);
    });

    // 3. normQQTracks 直接边界兼容：{data:{songlist:[{song:{songmid}}]}}
    const normed = normQQTracks({
        data: {
            cdlist: [{
                songlist: [{
                    song: { songmid: 'm99', songname: '夜曲', singer: '周杰伦', albummid: 'alb1', albumname: '十一月的萧邦' },
                }],
            }],
        },
    });
    assert.equal(normed.length, 1);
    assert.equal(normed[0].mid, 'm99');
    assert.equal(normed[0].source, 'qq');
});
