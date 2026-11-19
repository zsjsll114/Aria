/**
 * @file tests/js/test_selfhost_integrations.js
 * 覆盖自建服务前后端集成逻辑（无真实网络/后端，stub globalThis.fetch）：
 *   1. artistApi.js：网易歌手搜索与详情归一化
 *   2. musicApi.js：酷狗自建搜索兜底 & 自建 KRC 逐字歌词兜底
 *   3. selfhost-runtime.js：网易/酷狗云端收藏、红心、建删歌单、曲目增删与状态失效事件
 */
import test from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.localStorage) {
  const _store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
  };
}
if (!globalThis.EventTarget && typeof globalThis.addEventListener !== 'function') {
  const _listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    const arr = _listeners.get(type) || [];
    arr.push(fn);
    _listeners.set(type, arr);
  };
  globalThis.dispatchEvent = (ev) => {
    for (const fn of _listeners.get(ev.type) || []) fn(ev);
    return true;
  };
}

const { artistSearchSupported, clearArtistCache, fetchArtist, searchArtists } = await import('../../web/src/services/artistApi.js');
const { fetchKugouLyric, fetchKugouVendorSearch, searchKugouSongs } = await import('../../web/src/services/musicApi.js');
const {
  invalidateSelfhostCaches,
  selfhostCloudLike,
  selfhostCreatePlaylist,
  selfhostDeletePlaylist,
  selfhostFavorites,
  selfhostPlaylistMutateTracks,
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

test('artistApi: 网易歌手搜索与详情归一化', async () => {
  assert.equal(artistSearchSupported('netease'), true);
  clearArtistCache();
  await withMockFetch(async (url) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes('/cloudsearch')) {
      return jsonRes({
        result: {
          artists: [
            { id: 3684, name: '林俊杰', picUrl: 'https://img/jj.jpg', albumSize: 18, musicSize: 120 },
          ],
        },
      });
    }
    if (decoded.includes('/artists?')) {
      return jsonRes({
        artist: { id: 3684, name: '林俊杰', picUrl: 'https://img/jj.jpg', briefDesc: '歌手简介', musicSize: 120, albumSize: 18 },
        hotSongs: [{ id: 1001, name: '江南', ar: [{ id: 3684, name: '林俊杰' }], al: { name: '第二天堂', picUrl: 'https://img/jn.jpg' }, dt: 267000 }],
      });
    }
    if (decoded.includes('/artist/songs')) {
      return jsonRes({
        songs: [{ id: 1001, name: '江南', ar: [{ id: 3684, name: '林俊杰' }], al: { name: '第二天堂', picUrl: 'https://img/jn.jpg' }, dt: 267000 }],
      });
    }
    if (decoded.includes('/artist/album')) {
      return jsonRes({
        hotAlbums: [{ id: 2001, name: '第二天堂', picUrl: 'https://img/a1.jpg', publishTime: 1086307200000 }],
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  }, async () => {
    const list = await searchArtists('netease', '林俊杰');
    assert.equal(list.length, 1);
    assert.equal(list[0].artistId, '3684');
    assert.equal(list[0].source, 'netease');

    const detail = await fetchArtist({ source: 'netease', artistId: '3684', artistName: '林俊杰' });
    assert.equal(detail.name, '林俊杰');
    assert.ok(detail.songs.length >= 1);
    assert.equal(detail.songs[0].song, '江南');
    assert.equal(detail.songs[0].source, 'netease');
    assert.equal(detail.albums.length, 1);
    assert.equal(detail.albums[0].name, '第二天堂');
  });
});

test('musicApi: 酷狗自建搜索与 KRC 逐字歌词兜底', async () => {
  await withMockFetch(async (url) => {
    const decoded = decodeURIComponent(url);
    if (url.startsWith('/api/selfhost/kugou/proxy') && decoded.includes('/search?')) {
      return jsonRes({
        data: {
          lists: [{
            SongName: '<em>晴天</em>',
            SingerName: '周杰伦',
            FileHash: 'KG_HASH_1',
            AlbumName: '叶惠美',
            Image: 'https://img/{size}/qt.jpg',
            Duration: 269,
          }],
        },
      });
    }
    if (url.startsWith('/api/selfhost/kugou/proxy') && decoded.includes('/search/lyric?')) {
      return jsonRes({ candidates: [{ id: 'cid-1', accesskey: 'ak-1' }] });
    }
    if (url.startsWith('/api/selfhost/kugou/proxy') && decoded.includes('/lyric?')) {
      return jsonRes({
        decodeContent: '[ti:晴天]\n[0,2000]<0,500,0>故<500,500,0>事<1000,1000,0>里',
      });
    }
    // 模拟所有公网酷狗接口不可用
    throw new Error('public upstream down');
  }, async () => {
    const direct = await fetchKugouVendorSearch('晴天', 1, 10);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].song, '晴天');
    assert.equal(direct[0].cover, 'https://img/400/qt.jpg');

    const fallbackSongs = await searchKugouSongs('晴天');
    assert.equal(fallbackSongs.success, true);
    assert.equal(fallbackSongs.list.length, 1);
    assert.equal(fallbackSongs.list[0].hash, 'KG_HASH_1');

    const lyric = await fetchKugouLyric({ hash: 'KG_HASH_1', song: '晴天', singer: '周杰伦', duration: 269 });
    assert.equal(lyric.source, 'kugou');
    assert.ok(Array.isArray(lyric.parsedList) && lyric.parsedList.length > 0);
    assert.ok(lyric.parsedList[0].words.length >= 2);
  });
});

test('selfhost-runtime: 网易/酷狗云端收藏、红心与歌单 CRUD', async () => {
  globalThis.localStorage.setItem('selfhost_prefs', JSON.stringify({
    enabled: { netease: true, kugou: true, qq: false },
  }));
  invalidateSelfhostCaches();

  const calls = [];
  let neteaseAuthed = false;

  await withMockFetch(async (url, opts) => {
    calls.push({ url: decodeURIComponent(url), opts });
    if (url.includes('/api/selfhost/status')) {
      return jsonRes({
        netease: { alive: true, loggedIn: true, uid: 'u_ne' },
        kugou: { alive: true, loggedIn: true, uid: 'u_kg' },
        qq: { alive: true, loggedIn: true, uid: 'u_qq' },
      });
    }
    if (url.includes('/api/selfhost/kugou/proxy')) {
      const dec = decodeURIComponent(url);
      if (dec.includes('/playlist/add')) return jsonRes({ status: 1, data: { listid: 77 } });
      if (dec.includes('/playlist/tracks/add')) return jsonRes({ status: 1 });
      if (dec.includes('/playlist/tracks/del')) return jsonRes({ status: 1 });
      if (dec.includes('/playlist/del')) return jsonRes({ status: 1 });
    }
    if (url.includes('/api/selfhost/netease/proxy')) {
      const dec = decodeURIComponent(url);
      if (dec.includes('/user/playlist')) {
        if (!neteaseAuthed) return jsonRes({ playlist: [] });
        return jsonRes({ playlist: [{ id: 55, name: '我喜欢的音乐', specialType: 5 }] });
      }
      if (dec.includes('/playlist/track/all')) {
        return jsonRes({ songs: [{ id: 101, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美', picUrl: 'https://img/qt.jpg' } }] });
      }
      if (dec.includes('/like')) return jsonRes({ code: 200 });
      if (dec.includes('/playlist/create')) return jsonRes({ code: 200, id: 888 });
      if (dec.includes('/playlist/delete')) return jsonRes({ code: 200 });
      return jsonRes({ code: 200, id: 888 });
    }
    return jsonRes({ ok: true });
  }, async () => {
    const emptyFav = await selfhostFavorites('netease');
    assert.equal(emptyFav.ok, false);

    neteaseAuthed = true;
    const fav = await selfhostFavorites('netease');
    assert.equal(fav.ok, true);
    assert.equal(fav.list.length, 1);
    assert.equal(fav.list[0].source, 'netease');

    const likeRes = await selfhostCloudLike('netease', { id: '101' }, true);
    assert.equal(likeRes.ok, true);

    const qqLike = await selfhostCloudLike('qq', { id: 'qq-1' }, true);
    assert.equal(qqLike.ok, false);
    assert.equal(qqLike.unsupported, true);

    const cNe = await selfhostCreatePlaylist('netease', '夜间歌单');
    assert.equal(cNe.ok, true);
    assert.equal(cNe.id, '888');

    const cKg = await selfhostCreatePlaylist('kugou', '酷狗新建');
    assert.equal(cKg.ok, true);
    assert.equal(cKg.id, '77');

    const addKg = await selfhostPlaylistMutateTracks('kugou', { listId: '77' }, [{ id: 'H1', hash: 'H1', name: '歌', albumId: '1', mixSongId: '2' }], 'add');
    assert.equal(addKg.ok, true);

    const delKgMissingFid = await selfhostPlaylistMutateTracks('kugou', { listId: '77' }, [{ id: 'H1', hash: 'H1' }], 'del');
    assert.equal(delKgMissingFid.ok, false);

    const delKg = await selfhostPlaylistMutateTracks('kugou', { listId: '77' }, [{ id: 'H1', fileid: 'F99' }], 'del');
    assert.equal(delKg.ok, true);

    const delNe = await selfhostDeletePlaylist('netease', { listId: '888' });
    assert.equal(delNe.ok, true);
  });

  assert.ok(calls.some(c => c.url.includes('/api/selfhost/netease/proxy')));
});
