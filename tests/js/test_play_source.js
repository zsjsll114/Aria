/* ============================================================
 * tests/js/test_play_source.js — 取链透明化（todos #15）行为回归
 *
 * 盯住三件最容易在后续改动里丢掉的事：
 *   ① 降级路径（公网 / 跨源）必须打「兜底」，本机自建与解析池不打——
 *      这个区分就是本功能存在的理由（「为什么这首歌只有 128k」）；
 *   ② 失败态必须清掉上一首的命中，否则角标会把用户引到错误结论上；
 *   ③ 日志环形缓冲必须有界且按 tag/时间过滤，否则「降级轨迹」要么刷屏要么漏。
 * ============================================================ */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearLogs, getLogs, logCatch, logInfo, logWarn } from '../../web/src/services/log.js';
import {
    beginResolveTrace,
    channelMeta,
    describeBadge,
    describeDetail,
    markResolveFailed,
    qualityLabel,
    recordResolveHit,
    sniffPlatform,
    sniffQuality,
} from '../../web/src/services/playSource.js';

beforeEach(() => {
    clearLogs();
    beginResolveTrace('tencent:1');
});

/* ---------- 角标：渠道 tier 决定是否标「兜底」 ---------- */

test('本机自建命中不打「兜底」，音质取渠道上报值', () => {
    recordResolveHit('selfhostQQ', 'http://127.0.0.1:3200/song/xxx.flac', 'flac');
    const b = describeBadge();
    assert.equal(b.fallback, false);
    assert.equal(b.text, 'QQ音乐 · 无损 FLAC');
});

test('公网接口命中要打「兜底」', () => {
    recordResolveHit('ygking', 'https://stream.qqmusic.qq.com/O800.mp3', '128');
    const b = describeBadge();
    assert.equal(b.fallback, true);
    assert.match(b.text, /兜底$/);
    assert.match(b.text, /128k/);
});

test('跨源同名歌算降级', () => {
    recordResolveHit('crossKuwo', 'https://otherweb.kuwo.cn/1.mp3');
    assert.equal(describeBadge().fallback, true);
    assert.match(describeBadge().text, /^酷我音乐/);
});

test('渠道没上报音质时从直链猜', () => {
    recordResolveHit('qqResolve', 'https://stream.qqmusic.qq.com/F000xxxx.flac');
    assert.match(describeBadge().text, /无损 FLAC/);
    recordResolveHit('qqResolve', 'https://a.example/x.mp3?bitrate=320000');
    assert.match(describeBadge().text, /320k/);
});

test('未知渠道 id 不崩，归到 unknown 且算降级', () => {
    recordResolveHit('totallyNewChannel', 'https://x.example/a.mp3', '320');
    const b = describeBadge();
    assert.equal(b.tier, 'unknown');
    assert.equal(b.fallback, true);
    assert.equal(channelMeta('totallyNewChannel').name, '未知渠道');
});

/* ---------- 失败态与空态 ---------- */

test('全链失败时角标改口，不留上一首的命中', () => {
    recordResolveHit('selfhostQQ', 'http://127.0.0.1:3200/a.flac', 'flac');
    markResolveFailed();
    const b = describeBadge();
    assert.equal(b.text, '取链失败');
    assert.equal(b.fallback, true);
});

test('beginResolveTrace 会重置上一首的命中', () => {
    recordResolveHit('vkeys', 'https://stream.qqmusic.qq.com/a.mp3', '320');
    beginResolveTrace('netease:2');
    assert.equal(describeBadge(), null);
});

/* ---------- 详情面板：降级轨迹来自日志缓冲 ---------- */

test('describeDetail 只带本次取链之后、且只带取链相关 tag 的日志', () => {
    logWarn('trackIndexOnline', 'ygking.top 128 链接探测不可播，尝试下一音质');
    logInfo('trackIndexOnline', 'vkeys 获取成功: 某歌');
    logInfo('lyricSource', '与取链无关的日志');
    recordResolveHit('vkeys', 'https://stream.qqmusic.qq.com/b.mp3', '320');

    const d = describeDetail();
    assert.equal(d.logs.length, 2);
    assert.deepEqual([...new Set(d.logs.map(r => r.tag))].sort(), ['trackIndexOnline']);
    /* 面板按时间正序展示（缓冲是倒序查询） */
    assert.match(d.logs[0].msg, /探测不可播/);
    assert.match(d.logs[1].msg, /获取成功/);
    assert.ok(d.rows.some(r => r.k === '命中渠道' && r.v === 'vkeys 公网接口'));
    assert.ok(d.rows.some(r => r.k === '音质' && r.v === '320k'));
});

test('上一首的日志不会串进本次轨迹', () => {
    logWarn('trackIndexOnline', '第一首的失败');
    beginResolveTrace('tencent:2');
    const d = describeDetail();
    assert.equal(d.logs.length, 0);
});

test('命中之后才打的日志（歌词/预加载）不算进本次取链轨迹', () => {
    logWarn('trackIndexOnline', '降级中的一级');
    recordResolveHit('vkeys', 'https://stream.qqmusic.qq.com/b.mp3', '320');
    logInfo('trackIndexOnline', '[Preload] 开始预加载下一首: 另一首歌');
    const d = describeDetail();
    assert.equal(d.logs.length, 1);
    assert.match(d.logs[0].msg, /降级中的一级/);
});

test('Error 对象进缓冲时留 message，且正文被截断', () => {
    logWarn('trackIndexOnline', new Error('连接超时'));
    logWarn('musicApi', 'x'.repeat(400));
    /* getLogs 契约是新→旧，所以最近的那条在下标 0 */
    const logs = getLogs({ tags: ['trackIndexOnline', 'musicApi'] });
    assert.equal(logs[0].msg.length <= 241, true, `正文应被截断，实际 ${logs[0].msg.length}`);
    assert.equal(logs[1].msg, '连接超时');
});

test('日志缓冲有界（400 条），只保留最近的', () => {
    for (let i = 0; i < 900; i++) logInfo('trackIndexOnline', `m${i}`);
    const all = getLogs({ limit: 5000 });
    assert.equal(all.length, 400);
    assert.equal(all[0].msg, 'm899');
    assert.equal(all[399].msg, 'm500');
});

test('logCatch 只在实际输出那一次进缓冲（与 5s 去重同频）', () => {
    const e = new Error('同样的错');
    logCatch('trackIndexOnline', e);
    logCatch('trackIndexOnline', e);
    logCatch('trackIndexOnline', e);
    assert.equal(getLogs({ tags: ['trackIndexOnline'] }).length, 1);
});

/* ---------- 归类函数 ---------- */

test('sniffPlatform 认得四个平台与本地', () => {
    assert.equal(sniffPlatform('https://r2.astyle.kugou.com/1.mp3'), '酷狗音乐');
    assert.equal(sniffPlatform('https://m10.music.126.net/1.mp3'), '网易云');
    assert.equal(sniffPlatform('https://otherweb.kuwo.cn/1.mp3'), '酷我音乐');
    assert.equal(sniffPlatform('blob:http://localhost:8001/x'), '本地');
    assert.equal(sniffPlatform('https://nope.example/1'), '');
});

test('qualityLabel 未登记的档位原样透出（不编造中文名）', () => {
    assert.equal(qualityLabel('exhigh'), '极高 320k');
    assert.equal(qualityLabel('999'), '999');
    assert.equal(qualityLabel(''), '');
});

/* 实测踩到的第二个坑：QQ 直链的 vkey 是以 hex 结尾的签名，出现过 …F320__v2… 这种串，
   整 URL 匹配 /320/ 会让角标谎报 320k（真值 m4a）。所以只准匹配 pathname。 */
test('vkey 里出现 320 不得被当成音质', () => {
    const real = 'http://isure6.stream.qqmusic.qq.com/C400002FQqNA0lLtAt.m4a'
        + '?guid=2000000638&vkey=BC92C04C7663F320__v2b9ab3b5&uin=0&fromtag=99030638';
    assert.equal(sniffQuality(real), '');
    beginResolveTrace('tencent:9');
    recordResolveHit('qqResolve', real, 'song_play_url', { ext: 'm4a' });
    assert.equal(describeBadge().text, 'QQ音乐 · m4a');
    /* 详情里角标的 ext 兜底不能同时占掉「音质」和「容器」两行（实测会重复显示 m4a） */
    const rows = Object.fromEntries(describeDetail().rows.map(r => [r.k, r.v]));
    assert.equal(rows['音质'], '未上报');
    assert.equal(rows['容器'], 'm4a');
    /* 真正的档位标记在文件名里才认 */
    assert.equal(sniffQuality('https://stream.qqmusic.qq.com/F00000abc.flac?vkey=x320y'), 'flac');
    assert.equal(sniffQuality('https://stream.qqmusic.qq.com/R000abc.mp3?bitrate=320000'), '320');
});
test('provider 标识不是音质，不能被当成音质显示', () => {
    assert.equal(qualityLabel('song_play_url'), '');
    assert.equal(qualityLabel('q10'), '');
    beginResolveTrace('tencent:1');
    recordResolveHit('qqResolve', 'http://isure6.stream.qqmusic.qq.com/C400001H4yUA2r0L08.m4a', 'song_play_url', { ext: 'm4a' });
    assert.equal(describeBadge().text, 'QQ音乐 · m4a');
});
