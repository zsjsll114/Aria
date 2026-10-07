/* ============================================================
 * tests/js/test_mv_api.js — MV 数据层（services/mvApi.js）行为回归
 *
 * 盯住三件在后续改动里最容易悄悄坏掉的事：
 *   ① **QQ 挑档必须挑"可用的最小档"**：getMvPlay 一次回多档 mp4，前几档常常是
 *      `code:2000 + 空 url`（无版权/区域限制），直接取第一档就会拿到空串 →
 *      «MV 点了没反应»。这条是"能播"与"不能播"的分界线。
 *   ② **协议升级必须分辨 CDN**（2026-10-04 修正，此前"一律升 https"是错的）：
 *      酷狗 `fsmvpc.kugou.com` / `fsmvpc.tx.kugou.com` 的 443 **证书不匹配**
 *      （curl `SEC_E_WRONG_PRINCIPAL`）→ 升上去 TLS 直接失败；Chromium 里表现为
 *      `<video>` 既不 error 也不出帧、只显示 poster ⇒ 用户报的「mv 不播放只显示封面」。
 *      现在按 host 保留原协议（见 upHttps）。网易 vod / QQ 的 https 实测可用，照旧升。
 *   ③ 能力声明必须**保守**：汽水底层库零 video 方法，报 true 会让搜索页多出一排
 *      永远空着的卡片（而不是明确说"该源不支持"）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adoptVkeysMvFields, mvSearchSupported, pickQqMp4, pickQqVidFromSongs, finalizeMvs, mvsFromQqSongs, upHttps,
    matchMvFromCandidates, resolveMvForSong, neteaseMvDetail, searchMvsForWord } from '../../web/src/services/mvApi.js';

/* ---------- QQ 的 vid 反查（BUG「只有 QQ 不会自动匹配 MV」） ----------
   为什么只有 QQ 全灭：mvVid 只在「搜索结果点播」那条路上被携带，歌单/最近播放/
   排行榜/歌手页进来的歌都拿不到；而 QQ 又没有「关键词搜 MV」的接口（resolveMvForSong
   的 ② 对它是跳过的）⇒ 只剩最严的跨源兜底。QQ 的歌曲搜索 getSearchByKey 每首歌都
   自带 vid，所以用 songmid（或歌名+歌手）反查回来即可。下面锁死判据。 */

test('pickQqVidFromSongs：有 mid 时按 songmid 精确命中，绝不按歌名猜', () => {
    const list = [
        { songmid: 'AAAA', songname: '青花瓷', vid: 'vid-A', singer: [{ name: '周杰伦' }] },
        { songmid: 'BBBB', songname: '青花瓷', vid: 'vid-B', singer: [{ name: '别人' }] },
    ];
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '周杰伦', mid: 'BBBB' }), 'vid-B');
    /* mid 命中优先于歌名/歌手判据 —— 即使歌手对不上也认（mid 才是身份） */
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '周杰伦', mid: 'BBBB' }), 'vid-B');
    /* mid 在池里找不到 → 落回歌名+歌手，而不是报错 */
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '周杰伦', mid: 'ZZZZ' }), 'vid-A');
});

test('pickQqVidFromSongs：歌名先严后宽 —— 逐字相等的正主必须赢过 Live 版', () => {
    const list = [
        /* Live 版排在前面：norm 会剥掉括号，若不先严后宽它会被判成同名而抢先命中，
           铺上的是演唱会版的 MV（两者 vid 实测确实不同：l00131om505 vs t00226mgu2f） */
        { songmid: 'A', songname: '青花瓷 (Live)', vid: 'v-live', singer: [{ name: '周杰伦' }] },
        { songmid: 'B', songname: '青花瓷', vid: 'v-studio', singer: [{ name: '周杰伦' }] },
        { songmid: 'C', songname: '青花瓷', vid: 'v-cover', singer: [{ name: '林俊杰' }] },
    ];
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '周杰伦' }), 'v-studio');
    /* 无歌手基准也不能退化成"拿第一个" */
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷' }), 'v-studio');
    /* 歌手对不上 → 空，不拿翻唱顶替 */
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '陈奕迅' }), '');
});

test('pickQqVidFromSongs：没有逐字相等的正主时，才轮到归一化全等（容忍后缀）', () => {
    const list = [{ songmid: 'A', songname: '青花瓷（电视剧《××》主题曲）', vid: 'v-tv', singer: [{ name: '周杰伦' }] }];
    assert.equal(pickQqVidFromSongs(list, { title: '青花瓷', singer: '周杰伦' }), 'v-tv');
});

test('pickQqVidFromSongs：歌手多写法双向包含；候选没写歌手则不采纳', () => {
    const list = [{ songmid: 'A', songname: '海阔天空', vid: 'v1', singer: [{ name: 'BEYOND' }] }];
    assert.equal(pickQqVidFromSongs(list, { title: '海阔天空', singer: 'Beyond' }), 'v1');
    /* 多歌手串（上游常给「周杰伦/阿信」） */
    const list2 = [{ songmid: 'B', songname: '说好不哭', vid: 'v2', singer: [{ name: '周杰伦/阿信' }] }];
    assert.equal(pickQqVidFromSongs(list2, { title: '说好不哭', singer: '周杰伦' }), 'v2');
    /* 候选没写歌手 → 不敢认（有歌手基准时） */
    assert.equal(pickQqVidFromSongs([{ songmid: 'C', songname: '青花瓷', vid: 'x', singer: [] }], { title: '青花瓷', singer: '周杰伦' }), '');
});

test('pickQqVidFromSongs：无 vid / 空池 / 缺参一律回空串且不抛', () => {
    assert.equal(pickQqVidFromSongs([{ songname: '青花瓷' }], { title: '青花瓷' }), '');
    assert.equal(pickQqVidFromSongs([], { title: '青花瓷' }), '');
    assert.equal(pickQqVidFromSongs(null, { title: '青花瓷' }), '');
    assert.equal(pickQqVidFromSongs([{ songmid: 'A', songname: '青花瓷', vid: 'x' }], {}), '');
    assert.equal(pickQqVidFromSongs([{ songmid: 'A', songname: '青花瓷', vid: 'x' }], undefined), '');
});

/* ---------- vkeys 条目补 MV 关联字段（BUG「QQ 不会自动匹配 MV」） ----------
   用户原话：「qq 不会自动匹配 mv 但是网易云和酷狗可以」。
   根因：150 的搜索是「自建 vendor × vkeys 公网」并发竞速，而 vkeys 会赢（0.7s vs 2.5s），
   但那里的 vkeys 分支只补了 artists、没搬 MV 关联字段 ⇒ QQ 的 item.mvVid 恒空。
   下面这些用例把"到底该从 vkeys 报文的哪个字段搬"锁死。 */

test('adoptVkeysMvFields：vkeys 的 QQ 条目用 vid 补出 mvVid', () => {
    /* 真实报文形状（实测 api.vkeys.cn/v2/music/tencent?word=青花瓷） */
    const list = [
        { id: 410316, mid: '002qU5aY3Qu24y', vid: 'l00131om505', song: '青花瓷', singer: '周杰伦' },
        { id: 97773, mid: '0039MnYb0qxYhV', vid: 'w0026q7f01a', song: '晴天', singer: '周杰伦' },
    ];
    adoptVkeysMvFields(list);
    assert.equal(list[0].mvVid, 'l00131om505');
    assert.equal(list[1].mvVid, 'w0026q7f01a');
});

test('adoptVkeysMvFields：不覆盖已有值（自建 vendor 的形状优先）', () => {
    const list = [{ vid: 'v-from-vkeys', mvVid: 'from-vendor' }];
    adoptVkeysMvFields(list);
    assert.equal(list[0].mvVid, 'from-vendor');
});

test('adoptVkeysMvFields：网易式的无 vid 条目保持原样，不凭空造关联', () => {
    /* vkeys 网易条目字段：id/song/singer/album/time/quality/cover —— 没有任何 MV 关联。
       它靠 /search?type=1004 的本平台兜底，不该被这里补出假值。 */
    const list = [{ id: 436514312, song: '成都', singer: '赵雷', cover: 'http://x/y.jpg' }];
    adoptVkeysMvFields(list);
    assert.equal('mvVid' in list[0], false);
    assert.equal(list[0].mvId, undefined);
});

test('adoptVkeysMvFields：空 vid / mv=0 不产生假关联；入参异常不抛', () => {
    const list = [{ vid: '', song: 'A' }, { mv: 0 }, { mv: '0' }, null];
    adoptVkeysMvFields(list);
    assert.equal(list[0].mvVid, undefined);
    assert.equal(list[1].mvId, undefined);
    assert.equal(list[2].mvId, undefined);
    assert.equal(adoptVkeysMvFields(null), null);
    assert.equal(adoptVkeysMvFields(undefined), undefined);
});

test('adoptVkeysMvFields：mv 字段（网易 /cloudsearch 形状）也认，非 0 才采纳', () => {
    const list = [{ mv: 5619601 }];
    adoptVkeysMvFields(list);
    assert.equal(list[0].mvId, '5619601');
});

test('补出来的 mvVid 能直接驱动 resolveMvForSong 走 vendor 级（QQ 的关键一环）', async () => {
    /* QQ 没有关键词搜 MV 的接口，只能靠歌曲自带的 vid 命中 vendor 级。
       这里不打网络：只验"键名对得上"——resolveMvForSong 读的是 info.mvVid。 */
    const item = { vid: 'l00131om505', song: '青花瓷', singer: '周杰伦' };
    adoptVkeysMvFields([item]);
    assert.equal(item.mvVid, 'l00131om505');
    /* mvsFromQqSongs 也从同一个字段读（搜索页 QQ 的 MV 卡） */
    const cards = mvsFromQqSongs([{ mvVid: item.mvVid, song: item.song, singer: item.singer }]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].vid, 'l00131om505');
});

/* ---------- 能力声明 ---------- */

test('三家有 MV 能力的源报 true（前端键与后端键两种写法都认）', () => {
    for (const s of ['tencent', 'qq', 'netease', 'kugou']) {
        assert.equal(mvSearchSupported(s), true, `${s} 应支持 MV`);
    }
});

test('汽水 / 酷我 / 本地 / 空值一律报 false', () => {
    for (const s of ['qishui', 'soda', 'kuwo', 'local', '', null]) {
        assert.equal(mvSearchSupported(s), false, `${String(s)} 不应支持 MV`);
    }
});

/* ---------- QQ 取址挑档 ---------- */

const wrap = (mp4s) => ({ response: { getMVUrl: { data: { d0040igj7eo: { mp4: mp4s } } } } });

test('跳过 code:2000 的空档，取到唯一可用的那一档', () => {
    const j = wrap([
        { code: 2000, fileSize: 0, freeflow_url: [] },
        { code: 0, fileSize: 26818156, freeflow_url: ['http://mv6.music.tc.qq.com/a.mp4', 'https://mv.music.tc.qq.com/a.mp4'] },
        { code: 2000, fileSize: 0, freeflow_url: [] },
    ]);
    assert.equal(pickQqMp4(j), 'https://mv.music.tc.qq.com/a.mp4');
});

test('多档可用时选**最小**的那档（背景播放不需要 1080P）', () => {
    const j = wrap([
        { code: 0, fileSize: 61050859, freeflow_url: ['https://mv.music.tc.qq.com/big.mp4'] },
        { code: 0, fileSize: 26818156, freeflow_url: ['https://mv.music.tc.qq.com/small.mp4'] },
    ]);
    assert.equal(pickQqMp4(j), 'https://mv.music.tc.qq.com/small.mp4');
});

test('同档只有 http 时如实回落 http（并升成 https 交给上层做兼容）', () => {
    const j = wrap([{ code: 0, fileSize: 1, freeflow_url: ['http://mv6.music.tc.qq.com/only-http.mp4'] }]);
    assert.equal(pickQqMp4(j), 'https://mv6.music.tc.qq.com/only-http.mp4');
});

test('fileSize 缺失（0）的可用档也算候选，不会被"最小档"逻辑丢掉', () => {
    const j = wrap([{ code: 0, fileSize: 0, freeflow_url: ['https://mv.music.tc.qq.com/nosize.mp4'] }]);
    assert.equal(pickQqMp4(j), 'https://mv.music.tc.qq.com/nosize.mp4');
});

test('全部是空档 / 报文缺失 → null（调用方据此提示"暂时取不到地址"）', () => {
    assert.equal(pickQqMp4(wrap([{ code: 2000, fileSize: 0, freeflow_url: [] }])), null);
    assert.equal(pickQqMp4(wrap([])), null);
    assert.equal(pickQqMp4({}), null);
    assert.equal(pickQqMp4(null), null);
    assert.equal(pickQqMp4({ response: { getMVUrl: { data: {} } } }), null);
});

test('freeflow_url 里的非字符串垃圾项被忽略，不影响挑档', () => {
    const j = wrap([{ code: 0, fileSize: 5, freeflow_url: [null, 42, '', 'https://mv.music.tc.qq.com/ok.mp4'] }]);
    assert.equal(pickQqMp4(j), 'https://mv.music.tc.qq.com/ok.mp4');
});

/* ---------- 候选精选（finalizeMvs） ---------- */

const mv = (singer, name, extra = {}) => ({ source: 'netease', mvId: name, vid: '', hash: '', name, singer, cover: '', duration: 0, playCount: '', ...extra });

test('有歌手信息时，只留 MV 歌手与歌曲歌手一致的（挡住翻唱）', () => {
    const raw = [mv('高伟', '晴天'), mv('邓天晴', '晴天'), mv('周杰伦', '晴天'), mv('周杰伦', '东风破')];
    const out = finalizeMvs(raw, '晴天', [{ name: '周杰伦' }], 6);
    assert.deepEqual(out.map(x => `${x.singer}/${x.name}`), ['周杰伦/晴天', '周杰伦/东风破']);
});

test('一条都不匹配 → 返回空（不做"退回全量"的兜底）', () => {
    const raw = [mv('高伟', '晴天'), mv('邓天晴', '晴天')];
    assert.deepEqual(finalizeMvs(raw, '晴天', [{ name: '周杰伦' }], 6), []);
});

test('没有歌手信息时才退化为按歌名匹配', () => {
    const raw = [mv('高伟', '晴天'), mv('某某', '无关视频')];
    const out = finalizeMvs(raw, '晴天', [], 6);
    assert.deepEqual(out.map(x => x.name), ['晴天']);
});

test('歌手串是长列表时双向包含都认（"初音未来;巡音流歌;KAITO" ↔ "巡音流歌"）', () => {
    const raw = [mv('巡音流歌', 'Jump for Joy'), mv('别人', 'Jump for Joy')];
    const out = finalizeMvs(raw, '追光使者', [{ name: '初音未来;巡音流歌;KAITO;Haigo Meiko' }], 6);
    assert.deepEqual(out.map(x => x.singer), ['巡音流歌']);
});

test('去重按 名称|歌手：同歌同歌手的第二支被丢掉，不同歌手保留', () => {
    const raw = [mv('周杰伦', '晴天', { hash: 'a' }), mv('周杰伦', '晴天', { hash: 'b' }), mv('刘瑞琦', '晴天', { hash: 'c' })];
    const out = finalizeMvs(raw, '晴天', [{ name: '周杰伦' }], 6);
    assert.equal(out.length, 1);
    assert.equal(out[0].hash, 'a');
});

test('歌名里的括号内容不参与去重比较（"追光使者(Vsinger Live)" 与 "追光使者" 视为同一支）', () => {
    const raw = [mv('洛天依', '追光使者'), mv('洛天依', '追光使者(Vsinger Live 2017洛天依全息演唱会)')];
    assert.equal(finalizeMvs(raw, '追光使者', [{ name: '洛天依' }], 6).length, 1);
});

test('关键词命中的排前面，其余保持上游顺序', () => {
    const raw = [mv('周杰伦', '东风破'), mv('周杰伦', '晴天'), mv('周杰伦', '稻香')];
    const out = finalizeMvs(raw, '晴天', [{ name: '周杰伦' }], 6);
    assert.deepEqual(out.map(x => x.name), ['晴天', '东风破', '稻香']);
});

test('limit 生效，且空/异常输入不抛', () => {
    const raw = Array.from({ length: 10 }, (_, i) => mv('周杰伦', `MV${i}`));
    assert.equal(finalizeMvs(raw, 'x', [{ name: '周杰伦' }], 3).length, 3);
    assert.deepEqual(finalizeMvs(null, 'x', [], 6), []);
    assert.deepEqual(finalizeMvs([{ name: '' }], 'x', [], 6), []);
});

test('时长低于 45s 的花絮/问候视频不算 MV（实测网易搜「周杰伦」首条是 9 秒的独家问候）', () => {
    const raw = [
        mv('周杰伦', '周杰伦独家问候网易云音乐网友', { duration: 9 }),
        mv('周杰伦', '晴天', { duration: 317 }),
    ];
    assert.deepEqual(finalizeMvs(raw, '周杰伦', [{ name: '周杰伦' }], 6).map(x => x.name), ['晴天']);
});

test('时长阈值边界：44s 丢、45s 留', () => {
    const raw = [mv('周杰伦', 'A', { duration: 44 }), mv('周杰伦', 'B', { duration: 45 })];
    assert.deepEqual(finalizeMvs(raw, '周杰伦', [{ name: '周杰伦' }], 6).map(x => x.name), ['B']);
});

test('时长 0（QQ 歌曲对象缺 interval）不被时长下限误杀', () => {
    const raw = [mv('周杰伦', '晴天', { source: 'tencent', duration: 0 })];
    assert.equal(finalizeMvs(raw, '周杰伦', [{ name: '周杰伦' }], 6).length, 1);
});

test('节目/访谈类视频不算 MV（网易 type=1004 会把《超级面对面》当结果返回）', () => {
    const raw = [
        mv('周杰伦', '超级面对面 第119期 周杰伦：想让歌迷听一辈子', { duration: 646 }),
        mv('周杰伦', '《超级面对面》独家对话周杰伦预告片', { duration: 400 }),
        mv('周杰伦', '周杰伦 Youtube 播放次数最多的MV TOP10', { duration: 161 }),
        mv('周杰伦', '晴天', { duration: 317 }),
    ];
    assert.deepEqual(finalizeMvs(raw, '周杰伦', [{ name: '周杰伦' }], 6).map(x => x.name), ['晴天']);
});

test('黑名单不误杀歌名：含"对话/现场/预告"的普通 MV 名照常保留', () => {
    /* Live 版、歌名带"对话"的都不该被当成节目——词表刻意窄，这条钉住这个边界 */
    const raw = [mv('周杰伦', '任性 (5525 Live版)', { duration: 266 }), mv('某某', '对话', { duration: 210 })];
    assert.equal(finalizeMvs(raw, 'x', [{ name: '周杰伦' }, { name: '某某' }], 6).length, 2);
});

/* ---------- QQ：从歌曲结果的 vid 生成 MV 卡（2026-10-03 二次修正） ----------
   旧实现走 /getSingerMv（歌手维度），于是搜「world.execute(me);」摆出来的是
   Mili 的《Mirror Mirror》《Lemonade》—— 该歌手**别的歌**的 MV，用户一眼看出不对。
   现在直接吃歌曲自带的 vid：一首歌 = 一张卡，文案/封面/时长全来自那首歌本身。 */

const song = (extra = {}) => ({
    song: '世界执行我', singer: 'Mili', cover: 'https://x/c.jpg',
    interval: 224, source: 'tencent', id: '1', mid: 'm1', mvVid: 'w0026q7f01a', ...extra,
});

test('QQ：带 vid 的歌逐首变成 MV 卡，且字段全部来自那首歌本身', () => {
    const out = mvsFromQqSongs([song()]);
    assert.equal(out.length, 1);
    assert.deepEqual(
        { name: out[0].name, singer: out[0].singer, cover: out[0].cover, vid: out[0].vid, mvId: out[0].mvId, duration: out[0].duration, source: out[0].source },
        { name: '世界执行我', singer: 'Mili', cover: 'https://x/c.jpg', vid: 'w0026q7f01a', mvId: 'w0026q7f01a', duration: 224, source: 'tencent' },
    );
});

test('QQ：没有 vid 的歌被跳过（这首歌没有 MV），不会产出空卡', () => {
    const out = mvsFromQqSongs([song({ mvVid: '' }), song({ id: '2', mvVid: 'w002' })]);
    assert.deepEqual(out.map(x => x.vid), ['w002']);
});

test('QQ：同一 vid 只出一张（搜索页常有同曲多版本/多音质条目）', () => {
    const out = mvsFromQqSongs([song(), song({ id: '9', mid: 'm9' })]);
    assert.equal(out.length, 1);
});

test('QQ：vid 缺省字段名也认（vid），空/异常输入不抛', () => {
    assert.equal(mvsFromQqSongs([song({ mvVid: '', vid: 'w0099' })])[0].vid, 'w0099');
    assert.deepEqual(mvsFromQqSongs(null), []);
    assert.deepEqual(mvsFromQqSongs([null, undefined, {}]), []);
});

test('QQ：limit 生效', () => {
    const many = Array.from({ length: 10 }, (_, i) => song({ id: String(i), mvVid: `w${i}` }));
    assert.equal(mvsFromQqSongs(many, 3).length, 3);
});

test('QQ：拿歌曲结果当相关性基准时，整排卡片不会被"歌手不符"误杀', () => {
    /* 这正是「网易云没有 MV」的同构场景：歌手集若来自"按关键词搜歌手"就会全灭，
       来自歌曲结果则命中。这里用 QQ 的卡走一遍 finalizeMvs 钉住这条语义。 */
    const songs = [song(), song({ id: '2', mvVid: 'w2', song: '另一个我' })];
    const rel = [{ name: 'Mili' }];
    const out = finalizeMvs(mvsFromQqSongs(songs), '世界执行我', rel, 6);
    assert.deepEqual(out.map(x => x.name), ['世界执行我', '另一个我']);
});

/* ---------- 协议升级（★ 2026-10-04 修正：按 CDN 分辨，禁止一律升 https） ---------- */

test('upHttps：酷狗系 CDN 必须保留 http（443 证书不匹配，升上去 <video> 就废了）', () => {
    /* 这条是「mv 不播放 只显示封面」那个 bug 的回归钉：
       酷狗 CDN 的 https 端点证书不符 → TLS 握手失败 → Chromium 里 video 既不
       error 也不出帧、只显示 poster。 */
    assert.equal(upHttps('http://fsmvpc.kugou.com/a/b.mkv'), 'http://fsmvpc.kugou.com/a/b.mkv');
    assert.equal(upHttps('http://fsmvpc.tx.kugou.com/a/b.mkv'), 'http://fsmvpc.tx.kugou.com/a/b.mkv');
    /* 任意 kugou.com 子域都算 */
    assert.equal(upHttps('http://musiclibpicbssdl.cloud.kugou.com/x.mp4'),
        'http://musiclibpicbssdl.cloud.kugou.com/x.mp4');
});

test('upHttps：其他 CDN（网易 vod / QQ）照旧升 https，供 https 页面下避开 mixed-content', () => {
    assert.equal(upHttps('http://vodkgeyttp8.vod.126.net/a.mp4'), 'https://vodkgeyttp8.vod.126.net/a.mp4');
    assert.equal(upHttps('http://mv.music.tc.qq.com/a.mp4'), 'https://mv.music.tc.qq.com/a.mp4');
    /* 名字里含 kugou 但不是它的域（后缀必须完整匹配）→ 照升 */
    assert.equal(upHttps('http://kugou.com.evil.test/a.mkv'), 'https://kugou.com.evil.test/a.mkv');
    assert.equal(upHttps('http://notkugou.com/a.mkv'), 'https://notkugou.com/a.mkv');
});

test('upHttps：已是 https / 空 / 非字符串 一律安全（不抛、不重复替换）', () => {
    assert.equal(upHttps('https://fsmvpc.kugou.com/a.mkv'), 'https://fsmvpc.kugou.com/a.mkv');
    assert.equal(upHttps(''), '');
    assert.equal(upHttps(null), '');
    assert.equal(upHttps(undefined), '');
    assert.equal(upHttps(123), '');
});

test('upHttps：非绝对 URL / 畸形串 不抛异常', () => {
    assert.doesNotThrow(() => upHttps('::not a url::'));
    assert.equal(upHttps('::not a url::'), '::not a url::');
});

/* ============================================================
 * 歌曲 → MV 的匹配（2026-10-04 新增）
 *
 * 用户原话：「匹配的逻辑不对吧 同名（甚至括号里的东西都一样）同作者的 mv 甚至都不
 *   匹配上（很多 你要不除了用 vendor 就在加上歌名+作者匹配的搜索 mv）」
 *
 * 旧实现只有「歌名+歌手当关键词 → searchMvs → finalizeMvs（**只按歌手筛**）」一条路，
 * 两个方向都会坏：召回差时整排丢空（实测网易搜「起风了 买辣椒也用券」只回 5 条、正主
 * 不在；搜「起风了」回 18 条全是翻唱 → 歌手筛后 0 条），歌手对得上时又把同歌手**别的歌**
 * 放进来（实测「平凡之路 朴树」通过 16 条，含《那些花儿》《送别》）。而最准的那条路
 * —— 歌曲对象自带的 MV id（网易 song.mv、QQ song.vid、酷狗 mvhash）——几乎没走。
 *
 * 下面钉住新判据：**歌名 + 歌手双判**，以及 vendor 关联优先（零请求）。
 * fixture 全部是本机 /api/selfhost/各源/proxy 实测报文裁出来的。
 * ============================================================ */

const MV_CD = { name: '成都', singer: '赵雷', duration: 364 };
const MV_CD_LIVE = { name: '成都 (Live)', singer: '赵雷', duration: 200 };
const MV_CD_COVER = { name: '成都', singer: '梦暄', duration: 323 };
const MV_ZHAO_OTHER = { name: '南方姑娘', singer: '赵雷', duration: 336 };

test('matchMvFromCandidates：同名同歌手 → 命中（用户报的"匹配不上"就指这个）', () => {
    const hit = matchMvFromCandidates([MV_CD_COVER, MV_CD], { title: '成都', singer: '赵雷' });
    assert.equal(hit && hit.name, '成都');
    assert.equal(hit && hit.singer, '赵雷');
});

test('matchMvFromCandidates：同名但别的歌手（翻唱）→ 必须否掉，宁可没有也不指错', () => {
    assert.equal(matchMvFromCandidates([MV_CD_COVER], { title: '成都', singer: '赵雷' }), null);
});

test('matchMvFromCandidates：同歌手但别的歌 → 必须否掉（旧实现正是从这里漏进去的）', () => {
    assert.equal(matchMvFromCandidates([MV_ZHAO_OTHER], { title: '成都', singer: '赵雷' }), null);
});

test('matchMvFromCandidates：完全同名优先于"包含"', () => {
    const loose = { name: '成都 两会版', singer: '赵雷', duration: 163 };
    const hit = matchMvFromCandidates([loose, MV_CD], { title: '成都', singer: '赵雷' });
    assert.equal(hit && hit.name, '成都');
});

test('matchMvFromCandidates：括号补充不影响判定（两侧去括号后同名）', () => {
    const hit = matchMvFromCandidates([MV_CD_LIVE], { title: '成都 (Live)', singer: '赵雷' });
    assert.equal(hit && hit.name, '成都 (Live)');
});

test('matchMvFromCandidates：strict（跨源用）只认完全同名，"包含"不算', () => {
    const loose = { name: '成都 两会版', singer: '赵雷', duration: 163 };
    /* 非 strict（本平台）：包含即可命中 —— 但完全同名的分数更高，见上一条用例 */
    assert.equal((matchMvFromCandidates([loose], { title: '成都', singer: '赵雷' }) || {}).name, '成都 两会版');
    /* strict（跨源）：包含不算，必须完全同名 */
    assert.equal(matchMvFromCandidates([loose], { title: '成都', singer: '赵雷' }, { strict: true }), null);
    assert.equal(
        (matchMvFromCandidates([MV_CD], { title: '成都', singer: '赵雷' }, { strict: true }) || {}).name,
        '成都');
});

test('matchMvFromCandidates：没给歌手基准时，歌名必须完全相等', () => {
    assert.equal(matchMvFromCandidates([{ name: '成都 两会版', singer: '', duration: 163 }], { title: '成都', singer: '' }), null);
    assert.equal(
        (matchMvFromCandidates([{ name: '成都', singer: '', duration: 364 }], { title: '成都', singer: '' }) || {}).name,
        '成都');
});

test('matchMvFromCandidates：有歌手基准但候选没写歌手 → 不敢认', () => {
    assert.equal(matchMvFromCandidates([{ name: '成都', singer: '', duration: 364 }], { title: '成都', singer: '赵雷' }), null);
});

test('matchMvFromCandidates：歌手串写法不同（多歌手 / 各种分隔符）仍要能命中', () => {
    for (const s of ['赵雷/费玉清', '赵雷 & 某某', '赵雷、费玉清', '赵雷 feat. 某某']) {
        assert.equal((matchMvFromCandidates([MV_CD], { title: '成都', singer: s }) || {}).name, '成都', '歌手写法: ' + s);
    }
});

test('matchMvFromCandidates：时长下限与节目类标题仍然拦截（沿用 finalizeMvs 口径）', () => {
    assert.equal(matchMvFromCandidates([{ name: '成都', singer: '赵雷', duration: 9 }], { title: '成都', singer: '赵雷' }), null);
    assert.equal(matchMvFromCandidates([{ name: '成都 幕后花絮', singer: '赵雷', duration: 300 }], { title: '成都', singer: '赵雷' }), null);
    /* duration=0（QQ 拿不到时长）不受下限影响 */
    assert.equal(
        (matchMvFromCandidates([{ name: '成都', singer: '赵雷', duration: 0 }], { title: '成都', singer: '赵雷' }) || {}).name,
        '成都');
});

test('matchMvFromCandidates：空歌名 / 空候选 / null 候选 → null（不抛）', () => {
    assert.equal(matchMvFromCandidates([MV_CD], { title: '', singer: '赵雷' }), null);
    assert.equal(matchMvFromCandidates([], { title: '成都', singer: '赵雷' }), null);
    assert.equal(matchMvFromCandidates(null, { title: '成都', singer: '赵雷' }), null);
    assert.equal(matchMvFromCandidates([MV_CD], null), null);
});

test('resolveMvForSong：QQ 自带 vid → 零请求直接返回（vendor 优先）', async () => {
    const mv = await resolveMvForSong('tencent', { title: '晴天', singer: '周杰伦', mvVid: 'w0026q7f01a', cover: 'c.jpg' });
    assert.equal(mv && mv.via, 'vendor');
    assert.equal(mv && mv.vid, 'w0026q7f01a');
    assert.equal(mv && mv.source, 'tencent');
    assert.equal(mv && mv.name, '晴天');
    assert.equal(mv && mv.cover, 'c.jpg');
});

test('resolveMvForSong：酷狗自带 mvhash → 零请求直接返回', async () => {
    const mv = await resolveMvForSong('kugou', { title: '晴天', singer: '周杰伦', mvHash: 'ABC123' });
    assert.equal(mv && mv.via, 'vendor');
    assert.equal(mv && mv.hash, 'ABC123');
    assert.equal(mv && mv.source, 'kugou');
});

test('resolveMvForSong：不支持 MV 的源 / 缺歌名 / 空源 → null', async () => {
    assert.equal(await resolveMvForSong('qishui', { title: '晴天', singer: '周杰伦' }), null);
    assert.equal(await resolveMvForSong('tencent', { title: '', singer: '周杰伦' }), null);
    assert.equal(await resolveMvForSong('', { title: '晴天', singer: '周杰伦' }), null);
});

test('neteaseMvDetail：id 为 0 / 空 / null → 直接 null（不发请求）', async () => {
    assert.equal(await neteaseMvDetail('0'), null);
    assert.equal(await neteaseMvDetail(''), null);
    assert.equal(await neteaseMvDetail(null), null);
    assert.equal(await neteaseMvDetail(undefined), null);
});

test('searchMvsForWord：空关键词 → 空数组（不发请求）', async () => {
    assert.deepEqual(await searchMvsForWord('netease', ''), []);
    assert.deepEqual(await searchMvsForWord('netease', '   '), []);
});

test('searchMvsForWord：不支持 MV 的源（汽水）→ 空数组', async () => {
    assert.deepEqual(await searchMvsForWord('qishui', '晴天', { artists: [{ name: '周杰伦' }] }), []);
});
