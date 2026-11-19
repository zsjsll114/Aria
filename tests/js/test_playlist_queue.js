/* ============================================================
 * tests/js/test_playlist_queue.js — 传统主流播放器播放队列行为回归
 *
 * 覆盖核心队列纯函数（web/src/core/playlistQueue.js）与关键渠道防回退契约：
 *  1. 曲目归一化：QQ/网易/酷狗/日推/歌手页/历史/本地结构化/早期收藏多格式全字段保留
 *  2. A 类（发现渠道）单曲点播清空为 1 首；B 类（合集/歌单）及「播放全部」全量入队并精确定位索引
 *  3. 「+ 加入当前播放」按原生主键跨平台去重追加、不打断当前播放
 *  4. 切歌/自然播完决策：
 *     - len===1 且 sequence/random 自然播完 → stop（禁止 %1===0 死循环）
 *     - len===1 且 loop → loop-replay
 *     - len===1 手动上/下一曲 → replay-current
 *     - len>1 sequence 列表循环（含首尾回绕与 autoPlayNext=false 尊重）
 *     - len===0 → random-api / stop
 *  5. 关键修复锚点校验（70/130/145/175/297 不回退到旧缺陷写法）
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildCollectionQueue,
    buildSingleTrackQueue,
    computeNextQueueDecision,
    enqueueTrack,
    insertNextAndPlay,
    isPlayableQueueTrack,
    normalizeQueueTrack,
    trackIdentityKey,
} from '../../web/src/core/playlistQueue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readShard = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('normalizeQueueTrack: 保留在线跨源、本地结构化与早期收藏元数据', () => {
    const qq = normalizeQueueTrack({
        song: '晴天',
        singer: '周杰伦',
        cover: 'https://img/q.jpg',
        id: 102065756,
        mid: '0039MnYb0qxYhV',
        album: '叶惠美',
        interval: 269,
        mvVid: 'k001',
    }, 'qq');
    assert.equal(qq.source, 'tencent');
    assert.equal(qq.title, '晴天');
    assert.equal(qq.song, '晴天');
    assert.equal(qq.artist, '周杰伦');
    assert.equal(qq.mid, '0039MnYb0qxYhV');
    assert.equal(qq.album, '叶惠美');
    assert.equal(qq.interval, 269);
    assert.equal(qq.mvVid, 'k001');
    assert.equal(qq.isLocal, false);
    assert.equal(isPlayableQueueTrack(qq), true);

    const localStructured = normalizeQueueTrack({
        title: 'Local Track',
        artist: 'Local Artist',
        album: 'Local Album',
        folder: 'track_dir',
        audioUrl: '/local_music/track_dir/song.flac',
        coverUrl: '/local_music/track_dir/cover.jpg',
        elrcUrl: '/local_music/track_dir/lyrics.elrc',
        lrcUrl: '/local_music/track_dir/lyrics.lrc',
        hasWordLevel: true,
        matchScore: 98,
    });
    assert.equal(localStructured.isLocal, true);
    assert.equal(localStructured.source, 'local');
    assert.equal(localStructured.folder, 'track_dir');
    assert.equal(localStructured.audioUrl, '/local_music/track_dir/song.flac');
    assert.equal(localStructured.elrcUrl, '/local_music/track_dir/lyrics.elrc');
    assert.equal(localStructured.lrcUrl, '/local_music/track_dir/lyrics.lrc');
    assert.equal(localStructured.hasWordLevel, true);
    assert.equal(localStructured.matchScore, 98);
    assert.equal(localStructured.key, 'local:track_dir');
    assert.equal(isPlayableQueueTrack(localStructured), true);

    const legacyNetease = normalizeQueueTrack({ id: '186016', title: '晴天', artist: '周杰伦' });
    assert.equal(legacyNetease.source, 'netease');
    assert.equal(isPlayableQueueTrack(legacyNetease), true);

    const legacyBlob = normalizeQueueTrack({ url: 'blob:http://localhost:8001/abc', title: 'Blob Song', artist: 'Unknown' });
    assert.equal(legacyBlob.isLocal, true);
    assert.equal(legacyBlob.source, 'local');
    assert.equal(legacyBlob.url, 'blob:http://localhost:8001/abc');
    assert.equal(isPlayableQueueTrack(legacyBlob), true);
});

test('A 类单曲点播与 B 类合集点播（含无效条目下标映射）', () => {
    const single = buildSingleTrackQueue({ id: '99', name: '孤勇者', authors: [{ author_name: '陈奕迅' }] }, 'netease');
    assert.equal(single.playlist.length, 1);
    assert.equal(single.currentTrackIndex, 0);
    assert.equal(single.playlist[0].title, '孤勇者');
    assert.equal(single.playlist[0].artist, '陈奕迅');

    const badSingle = buildSingleTrackQueue({ title: 'NoIdNoUrl' });
    assert.equal(badSingle.playlist.length, 0);

    const collection = buildCollectionQueue([
        { id: '1', song: 'First', source: 'netease' },
        { title: 'Broken Item Without Id' },
        { id: '2', mid: 'mid2', song: 'Third Clicked', source: 'qq' },
        { id: '3', song: 'Fourth', source: 'netease' },
    ], 2);
    assert.equal(collection.playlist.length, 3);
    assert.equal(collection.currentTrackIndex, 1);
    assert.equal(collection.playlist[1].title, 'Third Clicked');
    assert.equal(collection.playlist[1].source, 'tencent');
});

test('enqueueTrack: 跨平台别名主键去重、尾部追加与下一首插入', () => {
    const queue = [];
    const r1 = enqueueTrack(queue, { id: 102065756, mid: '0039MnYb0qxYhV', song: '晴天', singer: '周杰伦' }, 'qq');
    assert.equal(r1.added, true);
    assert.equal(r1.duplicate, false);
    assert.equal(queue.length, 1);

    // 用 tencent 别名加同一首 QQ 歌曲（仅带 mid）应当去重
    const rDup = enqueueTrack(queue, { mid: '0039MnYb0qxYhV', song: '晴天', singer: '周杰伦' }, 'tencent');
    assert.equal(rDup.added, false);
    assert.equal(rDup.duplicate, true);
    assert.equal(rDup.index, 0);
    assert.equal(queue.length, 1);

    const r2 = enqueueTrack(queue, { id: '200', song: '第二首', source: 'netease' });
    assert.equal(r2.added, true);
    assert.equal(queue.length, 2);

    const rNext = enqueueTrack(queue, { hash: 'AABBCCDD', name: '插播曲' }, 'kugou', { insertNext: true, currentIndex: 0 });
    assert.equal(rNext.added, true);
    assert.equal(rNext.index, 1);
    assert.equal(queue[1].source, 'kugou');
    assert.equal(queue[1].title, '插播曲');
    assert.equal(trackIdentityKey(queue[1]), 'kugou:AABBCCDD');
});

test('insertNextAndPlay: 发现渠道点击插入当前曲下一位并立即切换，不清空现有队列', () => {
    const initial = [
        normalizeQueueTrack({ id: '1', song: 'First', source: 'netease' }),
        normalizeQueueTrack({ id: '2', song: 'Second', source: 'netease' }),
        normalizeQueueTrack({ id: '3', song: 'Third', source: 'netease' }),
    ];
    // 1) 插入新曲（当前播第 0 首）→ 插入到下标 1 并立即切换为 1，原有 3 首都保留
    const r1 = insertNextAndPlay(initial, { id: '99', name: 'New Pick', source: 'netease' }, 'netease', 0);
    assert.equal(r1.playlist.length, 4);
    assert.equal(r1.currentTrackIndex, 1);
    assert.deepEqual(r1.playlist.map(t => t.id), ['1', '99', '2', '3']);

    // 2) 点击队列末尾已存在的曲目('3'，下标 3) → 移至当前下一位(下标 2) 并切换为 2
    const r2 = insertNextAndPlay(r1.playlist, { id: '3', name: 'Third', source: 'netease' }, 'netease', 1);
    assert.equal(r2.playlist.length, 4);
    assert.equal(r2.currentTrackIndex, 2);
    assert.deepEqual(r2.playlist.map(t => t.id), ['1', '99', '3', '2']);

    // 3) 空队列直接点播 → 长度为 1，下标 0
    const r3 = insertNextAndPlay([], { id: '55', name: 'Solo', source: 'qq' }, 'qq', 0);
    assert.equal(r3.playlist.length, 1);
    assert.equal(r3.currentTrackIndex, 0);
});

test('computeNextQueueDecision: 单曲队列自然播完停止（仅单曲循环续播）与多曲队列行为', () => {
    const oneSong = [normalizeQueueTrack({ id: '1', song: 'Only One', source: 'netease' })];

    // 关键行为：仅 1 首歌时，顺序或随机模式下自然播完必须停止，禁止 %1===0 死循环
    const dSeqAuto = computeNextQueueDecision({ playlist: oneSong, currentIndex: 0, playMode: 'sequence', reason: 'auto', autoPlayNext: true });
    assert.equal(dSeqAuto.kind, 'stop');

    const dRandAuto = computeNextQueueDecision({ playlist: oneSong, currentIndex: 0, playMode: 'random', reason: 'auto', autoPlayNext: true });
    assert.equal(dRandAuto.kind, 'stop');

    // 单曲循环自动重播
    const dLoopAuto = computeNextQueueDecision({ playlist: oneSong, currentIndex: 0, playMode: 'loop', reason: 'auto', autoPlayNext: true });
    assert.equal(dLoopAuto.kind, 'loop-replay');
    assert.equal(dLoopAuto.index, 0);

    // 手动按上/下一曲在单曲队列上从头重播当前歌曲，不丢弃用户队列去随机 API
    const dManual = computeNextQueueDecision({ playlist: oneSong, currentIndex: 0, playMode: 'sequence', delta: 1, reason: 'manual' });
    assert.equal(dManual.kind, 'replay-current');
    assert.equal(dManual.index, 0);

    // 多曲队列顺序循环与随机散列
    const threeSongs = [
        normalizeQueueTrack({ id: '1', song: 'A', source: 'netease' }),
        normalizeQueueTrack({ folder: 'f2', audioUrl: '/local_music/f2/b.mp3', title: 'B' }),
        normalizeQueueTrack({ id: '3', song: 'C', source: 'netease' }),
    ];
    const wrapNext = computeNextQueueDecision({ playlist: threeSongs, currentIndex: 2, playMode: 'sequence', delta: 1, reason: 'auto', autoPlayNext: true });
    assert.equal(wrapNext.kind, 'online');
    assert.equal(wrapNext.index, 0);

    const toLocal = computeNextQueueDecision({ playlist: threeSongs, currentIndex: 0, playMode: 'sequence', delta: 1, reason: 'manual' });
    assert.equal(toLocal.kind, 'local');
    assert.equal(toLocal.index, 1);

    const wrapPrev = computeNextQueueDecision({ playlist: threeSongs, currentIndex: 0, playMode: 'sequence', delta: -1, reason: 'manual' });
    assert.equal(wrapPrev.kind, 'online');
    assert.equal(wrapPrev.index, 2);

    const multiStopOnAutoOff = computeNextQueueDecision({ playlist: threeSongs, currentIndex: 0, playMode: 'sequence', delta: 1, reason: 'auto', autoPlayNext: false });
    assert.equal(multiStopOnAutoOff.kind, 'stop');

    const emptyManual = computeNextQueueDecision({ playlist: [], currentIndex: 0, playMode: 'sequence', reason: 'manual' });
    assert.equal(emptyManual.kind, 'random-api');
    const emptyAutoOff = computeNextQueueDecision({ playlist: [], currentIndex: 0, playMode: 'sequence', reason: 'auto', autoPlayNext: false });
    assert.equal(emptyAutoOff.kind, 'stop');
});

test('渠道接线防回退断言（ended 停播 / 单曲清空 / 历史与歌手播放全部 / 本地音乐队列）', () => {
    const audioEngine = readShard('web/src/app/70-audio-engine.js');
    assert.match(audioEngine, /computeNextQueueDecision/, '70-audio-engine ended 必须经 computeNextQueueDecision 判定');
    assert.match(audioEngine, /decision\.kind === 'stop'/, '70-audio-engine ended 必须在 stop 分支停播');

    const onlineLoader = readShard('web/src/app/175-track-index-online.js');
    assert.match(onlineLoader, /insertNextAndPlay/, '175 loadOnlineSong 必须在非 skipPlaylistUpdate 时插入队列下一位并立即切换，而不清空队列');
    assert.doesNotMatch(onlineLoader, /buildSingleTrackQueue\s*\(/, '175 loadOnlineSong 不得再调用 buildSingleTrackQueue 清空已有队列');

    const playlists = readShard('web/src/app/130-playlists.js');
    const rcBlock = playlists.slice(playlists.indexOf("getElementById('rcPlayAll')"), playlists.indexOf("querySelectorAll('.result-item[data-rh]')"));
    assert.doesNotMatch(rcBlock, /loadOnlineSong\s*\(/, '#rcPlayAll 不得再漏传 skipPlaylistUpdate 调 loadOnlineSong 把队列清掉');
    assert.match(rcBlock, /loadPlaylistTrack\s*\(\s*0\s*\)/, '#rcPlayAll 应通过 loadPlaylistTrack(0) 保留整单队列');

    const artistPage = readShard('web/src/app/297-artist-page.js');
    assert.match(artistPage, /playAllArtistSongs\s*\(\)/, '297 #artistPlayAllBtn 必须整单入队播放');

    const playlistImport = readShard('web/src/app/145-playlist-import.js');
    const localClickBlock = playlistImport.slice(playlistImport.indexOf('data-local-idx'), playlistImport.indexOf('data-sidx'));
    assert.match(localClickBlock, /buildCollectionQueue\s*\(\s*localSongsCache/, '145 本地音乐单行点击必须以整份 localSongsCache 入队');
});
