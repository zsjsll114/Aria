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
    clearResolveTrace,
    describeBadge,
    describeDetail,
    getResolveTrace,
    markResolveFailed,
    markResolveRetry,
    platformKeyOf,
    qualityLabel,
    recordResolveHit,
    resolveSourceOf,
    sniffPlatform,
    sniffQuality,
    songIdentityKey,
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

test('beginResolveTrace 会重置上一首的命中（改成 pending 态，不是继续显示上一首）', () => {
    recordResolveHit('vkeys', 'https://stream.qqmusic.qq.com/a.mp3', '320');
    beginResolveTrace('netease:2');
    /* 不变量还是那条：**绝不能**继续显示上一首的 vkeys。
       但呈现方式变了（用户反馈「取链时显示取链失败而不是正在获取」）：
       以前 pending 返回 null → 角标直接消失，用户分不清「在加载」和「没在加载」；
       现在返回明确的 pending 文案。 */
    const b = describeBadge();
    assert.ok(b, 'pending 态必须有内容，不能再返回 null');
    assert.equal(b.text, '正在获取…');
    assert.equal(b.tier, 'pending');
    assert.equal(b.fallback, false, '正在获取不是降级，不该染成警示色');
    assert.ok(!/vkeys|QQ音乐/.test(b.text), '不能残留上一首的命中渠道');
});

test('重试中显示「重试中 n/m」而不是「取链失败」', () => {
    beginResolveTrace('tencent:3');
    markResolveRetry(2, 3);
    const b = describeBadge();
    assert.equal(b.text, '重试中 2/3…');
    assert.equal(b.tier, 'retry');
    /* 指数退避最长 8s，这段窗口里写「取链失败」会把用户骗去刷新页面 */
    assert.notEqual(b.text, '取链失败');
});

test('markResolveFailed 清掉 retry（真放弃了才说失败）', () => {
    beginResolveTrace('tencent:4');
    markResolveRetry(1, 3);
    markResolveFailed();
    const b = describeBadge();
    assert.equal(b.text, '取链失败');
    assert.equal(b.tier, 'failed');
});

test('clearResolveTrace 让角标回到空白（被吞掉的点击不该挂着上一首的终态）', () => {
    recordResolveHit('vkeys', 'https://stream.qqmusic.qq.com/c.mp3', '320');
    clearResolveTrace();
    assert.equal(describeBadge(), null);
    assert.equal(getResolveTrace(), null);
    /* 幂等：没有 trace 时再清一次不抛 */
    clearResolveTrace();
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
    assert.equal(sniffPlatform('https://m10.music.126.net/1.mp3'), '网易云音乐');
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

/* ===== 平台规范名与取链分支判定（BUG「未知歌曲 / 加载慢 / 历史记两遍」） ===== */
test('platformKeyOf：同一平台的别名收敛到一个键', () => {
    for (const alias of ['qq', 'QQ', ' tencent ', 'yqq', 'qqmusic']) {
        assert.equal(platformKeyOf(alias), 'tencent', alias);
    }
    for (const alias of ['netease', 'wangyiyun', 'ne', '163', 'NetEase']) {
        assert.equal(platformKeyOf(alias), 'netease', alias);
    }
    assert.equal(platformKeyOf('kg'), 'kugou');
    assert.equal(platformKeyOf('kw'), 'kuwo');
});

test('platformKeyOf：未登记的别名原样返回，空值给空串（不猜平台）', () => {
    assert.equal(platformKeyOf('local'), 'local');
    assert.equal(platformKeyOf('migu'), 'migu');
    assert.equal(platformKeyOf(''), '');
    assert.equal(platformKeyOf(null), '');
    assert.equal(platformKeyOf(undefined), '');
});

test('resolveSourceOf：歌曲自带 source 优先于全局 currentSource', () => {
    /* 这正是 bug 的形状：全局停在 tencent，而条目是网易/酷狗的 */
    assert.equal(resolveSourceOf({ source: 'netease' }, 'tencent'), 'netease');
    assert.equal(resolveSourceOf({ source: 'qq' }, 'kugou'), 'tencent');
    assert.equal(resolveSourceOf({ source: 'kugou' }, 'tencent'), 'kugou');
});

test('resolveSourceOf：无 source / 非取链平台时退回全局，不会被塞进 vkeys 分支', () => {
    assert.equal(resolveSourceOf({}, 'kugou'), 'kugou');
    assert.equal(resolveSourceOf({ source: 'local' }, 'tencent'), 'tencent');
    assert.equal(resolveSourceOf({ source: 'selfhost' }, 'netease'), 'netease');
    assert.equal(resolveSourceOf(null, undefined), 'tencent');
});

test('resolveSourceOf：入参缺字段不抛（历史里可能存着半截条目）', () => {
    assert.equal(resolveSourceOf(undefined, undefined), 'tencent');
    assert.equal(resolveSourceOf({ source: 42 }, ''), 'tencent');
});

/* ===== 歌曲身份键（BUG「不会自动匹配 MV 了 必须手动匹配」） =====
   MV 动态背景用它做两件事：_followCache 的「同一首歌」复用判定、_manual 手动锁的
   解锁判定。旧实现写的是 `song.id || song.song`，而 175 主路径落下的对象是
   {title, artist, id, mid, …} —— **没有 song 字段**。id 一缺，键就塌缩成 `${src}::`，
   同一平台所有缺 id 的歌共用一把键 ⇒ 切歌不换 MV + 手动点过之后整批歌不再自动铺。
   下面的用例直接把这条锁死。 */

test('songIdentityKey：id 缺失时用歌名回落，不同的歌绝不能并成一把键', () => {
    /* 175 主路径的真实形状：只有 title，没有 song、id 为空 */
    const a = { title: '泪海', artist: '许茹芸', source: 'kugou', id: '', mid: '' };
    const b = { title: '海阔天空', artist: 'Beyond', source: 'kugou', id: '', mid: '' };
    assert.notEqual(songIdentityKey(a), songIdentityKey(b), '修复前两者都塌缩成 kugou::');
    assert.equal(songIdentityKey(a), 'kugou:泪海:');
    assert.equal(songIdentityKey(b), 'kugou:海阔天空:');
    /* song 写法（搜索页/歌单层）与 title 写法必须落到同一把键上 */
    assert.equal(songIdentityKey({ song: '泪海', source: 'kugou' }), songIdentityKey(a));
});

test('songIdentityKey：id 优先，其次 mid，且 id 在场时 mid 不影响键', () => {
    assert.equal(songIdentityKey({ title: '泪海', source: 'kugou', id: 'AAA' }), 'kugou:AAA:');
    assert.equal(songIdentityKey({ title: '晴天', source: 'tencent', mid: '0039MnYb' }), 'tencent:0039MnYb:');
    assert.equal(songIdentityKey({ title: '晴天', source: 'tencent', id: '1', mid: 'M' }), 'tencent:1:');
});

test('songIdentityKey：mvVid 只用于区分同一首歌的不同 MV，不能单独构成身份', () => {
    const base = { title: '晴天', source: 'tencent', id: '1' };
    assert.notEqual(songIdentityKey(base), songIdentityKey({ ...base, mvVid: 'w0026q7f01a' }));
    assert.equal(songIdentityKey({ source: 'tencent', mvVid: 'w0026q7f01a' }), '');
});

test('songIdentityKey：平台写法归一，qq 与 tencent 不能生成两把键', () => {
    assert.equal(
        songIdentityKey({ title: '晴天', source: 'qq', id: '1' }),
        songIdentityKey({ title: '晴天', source: 'tencent', id: '1' }),
    );
});

test('songIdentityKey：身份全缺返回空串（调用方按"不可比较"处理 → 不缓存、不锁）', () => {
    assert.equal(songIdentityKey(null), '');
    assert.equal(songIdentityKey({}), '');
    assert.equal(songIdentityKey({ source: 'kugou' }), '');
    assert.equal(songIdentityKey({ id: '' }, ''), '');
    /* 无 source 时用兜底平台，但歌名仍然构不成"有身份"的例外 —— 有了就算 */
    assert.equal(songIdentityKey({ title: '泪海' }, 'kugou'), 'kugou:泪海:');
    assert.equal(songIdentityKey({ title: '泪海' }, undefined), ':泪海:');
});
