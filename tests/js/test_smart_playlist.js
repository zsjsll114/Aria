import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../web/src/core/smartPlaylist.js');
const {
	SMART_RULE_VERSION, SMART_LIMIT_DEFAULT, SMART_LIMIT_MAX,
	emptySmartRule, normalizeSmartRule, isEmptySmartRule, ruleNeedsAnalysis,
	buildSmartPrompt, parseSmartRuleReply, queryLibrary, ruleToJSON,
} = mod;

/* ---------------- 规则归一化（AI 输出一律当不可信输入） ---------------- */

test('归一化：非对象输入不抛异常，一律回落空规则', () => {
	for (const bad of [null, undefined, 0, 'x', [], true]) {
		const r = normalizeSmartRule(bad);
		assert.equal(r.version, SMART_RULE_VERSION);
		assert.deepEqual(r.artists, []);
		assert.equal(r.bpm, null);
		assert.equal(r.limit, SMART_LIMIT_DEFAULT);
	}
});

test('归一化：同义字段名归并（LLM 换写法是常态，不做归并会时好时坏）', () => {
	assert.deepEqual(normalizeSmartRule({ artist: '周杰伦' }).artists, ['周杰伦']);
	assert.deepEqual(normalizeSmartRule({ singers: ['周杰伦', '邓紫棋'] }).artists, ['周杰伦', '邓紫棋']);
	assert.deepEqual(normalizeSmartRule({ keywords: ['晴天'] }).titleKeywords, ['晴天']);
	assert.deepEqual(normalizeSmartRule({ title_keywords: ['晴天'] }).titleKeywords, ['晴天']);
	assert.deepEqual(normalizeSmartRule({ blacklist: ['live'] }).excludeWords, ['live']);
	assert.deepEqual(normalizeSmartRule({ emotions: ['安静'] }).moods, ['安静']);
	assert.deepEqual(normalizeSmartRule({ source: 'netease' }).sources, ['netease']);
});

test('归一化：裸字符串容忍成单元素数组，空串/非字符串丢弃', () => {
	assert.deepEqual(normalizeSmartRule({ artists: '  周杰伦  ' }).artists, ['周杰伦']);
	assert.deepEqual(normalizeSmartRule({ artists: ['', '  ', 42, null, 'A'] }).artists, ['42', 'A']);
});

test('归一化：词表去重按大小写无关，且有数量上限', () => {
	const r = normalizeSmartRule({ artists: ['Live', 'live', 'LIVE', 'Other'] });
	assert.deepEqual(r.artists, ['Live', 'Other']);
	const many = normalizeSmartRule({ artists: Array.from({ length: 100 }, (_, i) => `a${i}`) });
	assert.equal(many.artists.length, 40);
});

test('归一化：BPM 三种写法都认，上下界颠倒自动交换', () => {
	assert.deepEqual(normalizeSmartRule({ bpm: { min: 60, max: 90 } }).bpm, { min: 60, max: 90 });
	assert.deepEqual(normalizeSmartRule({ bpm: [60, 90] }).bpm, { min: 60, max: 90 });
	assert.deepEqual(normalizeSmartRule({ bpm: '60-90' }).bpm, { min: 60, max: 90 });
	assert.deepEqual(normalizeSmartRule({ bpm: '90 ~ 60' }).bpm, { min: 60, max: 90 });
	assert.deepEqual(normalizeSmartRule({ tempo: { from: 70, to: 130 } }).bpm, { min: 70, max: 130 });
	/* 只给一侧 → 开区间 */
	assert.deepEqual(normalizeSmartRule({ bpm: { max: 90 } }).bpm, { min: null, max: 90 });
});

test('归一化：物理上不可能的 BPM 丢弃（>=300 / <=20 必是解析错误）', () => {
	assert.equal(normalizeSmartRule({ bpm: 500 }).bpm, null);
	assert.equal(normalizeSmartRule({ bpm: 5 }).bpm, null);
	assert.equal(normalizeSmartRule({ bpm: 'abc' }).bpm, null);
	assert.equal(normalizeSmartRule({ bpm: null }).bpm, null);
});

test('归一化：limit 夹取（Number(null)===0 这个坑必须挡掉）', () => {
	assert.equal(normalizeSmartRule({ limit: 12 }).limit, 12);
	assert.equal(normalizeSmartRule({ limit: 0 }).limit, SMART_LIMIT_DEFAULT);
	assert.equal(normalizeSmartRule({ limit: null }).limit, SMART_LIMIT_DEFAULT);
	assert.equal(normalizeSmartRule({ limit: -5 }).limit, SMART_LIMIT_DEFAULT);
	assert.equal(normalizeSmartRule({ limit: 'abc' }).limit, SMART_LIMIT_DEFAULT);
	assert.equal(normalizeSmartRule({ limit: 99999 }).limit, SMART_LIMIT_MAX);
	assert.equal(normalizeSmartRule({ limit: 3.9 }).limit, 3);
});

test('空规则判定 / 是否需要分析数据', () => {
	assert.equal(isEmptySmartRule({}), true);
	assert.equal(isEmptySmartRule({ limit: 10 }), true, '只有 limit 等于没有条件');
	assert.equal(isEmptySmartRule({ artists: ['x'] }), false);
	assert.equal(isEmptySmartRule({ bpm: { min: 60 } }), false);
	assert.equal(ruleNeedsAnalysis({ artists: ['x'] }), false);
	assert.equal(ruleNeedsAnalysis({ moods: ['安静'] }), true);
	assert.equal(ruleNeedsAnalysis({ bpm: { min: 60 } }), true);
});

/* ---------------- AI 回复解析 ---------------- */

test('解析：裸 JSON / markdown 围栏 / 前后夹带说明 三种都能抠出来', () => {
	const body = '{"name":"深夜","artists":["周杰伦"],"limit":20}';
	assert.equal(parseSmartRuleReply(body).name, '深夜');
	assert.equal(parseSmartRuleReply('```json\n' + body + '\n```').name, '深夜');
	assert.equal(parseSmartRuleReply('好的，这是规则：\n' + body + '\n希望有帮助！').name, '深夜');
	assert.equal(parseSmartRuleReply('```' + body + '```').limit, 20);
});

test('解析：失败返回 null（而不是空规则）——上层要能区分"没条件"与"没解析出来"', () => {
	assert.equal(parseSmartRuleReply(''), null);
	assert.equal(parseSmartRuleReply(null), null);
	assert.equal(parseSmartRuleReply('完全不是 JSON'), null);
	assert.equal(parseSmartRuleReply('{"a":1'), null, '括号不平衡');
});

test('解析：字符串里的花括号不会把平衡扫描带偏', () => {
	const r = parseSmartRuleReply('{"name":"含 } 和 { 的名字","limit":5}');
	assert.ok(r);
	assert.equal(r.name, '含 } 和 { 的名字');
	assert.equal(r.limit, 5);
});

/* ---------------- 本地匹配 ---------------- */

const LIB = [
	{ key: 'a', title: '晴天', artist: '周杰伦', source: 'netease', bpm: 76, mood: ['温暖', '怀旧'] },
	{ key: 'b', title: '夜曲', artist: '周杰伦', source: 'qq', bpm: 88, mood: ['忧伤'] },
	{ key: 'c', title: '晴天 (Live)', artist: '周杰伦', source: 'kugou', bpm: 78 },
	{ key: 'd', title: '光年之外', artist: '邓紫棋', source: 'netease', bpm: 130, mood: ['燃'] },
	{ key: 'e', title: '未知曲', artist: '某人', source: 'local' },
];

test('匹配：歌手 / 标题关键词 / 排除词 各自独立成立', () => {
	const byArtist = queryLibrary({ artists: ['周杰伦'] }, LIB);
	assert.deepEqual(byArtist.matched.map((x) => x.key), ['a', 'b', 'c']);

	const byTitle = queryLibrary({ titleKeywords: ['晴天'] }, LIB);
	assert.deepEqual(byTitle.matched.map((x) => x.key), ['a', 'c']);

	/* 排除词命中标题或歌手任一即排除（d/e 先被歌手条件挡掉，c 才是被排除词挡掉的） */
	const noLive = queryLibrary({ artists: ['周杰伦'], excludeWords: ['live'] }, LIB);
	assert.deepEqual(noLive.matched.map((x) => x.key), ['a', 'b']);
	assert.deepEqual(noLive.rejected.map((r) => [r.entry.key, r.reason]),
		[['c', 'excluded'], ['d', 'artist'], ['e', 'artist']]);
});

test('匹配：拒绝原因分得清（这是"匹配不到的标记出来"的数据基础）', () => {
	const r = queryLibrary({ artists: ['周杰伦'] }, LIB);
	const reasons = Object.fromEntries(r.rejected.map((x) => [x.entry.key, x.reason]));
	assert.equal(reasons.d, 'artist');
	assert.equal(reasons.e, 'artist');

	const srcFilter = queryLibrary({ sources: ['netease'] }, LIB);
	assert.deepEqual(srcFilter.matched.map((x) => x.key), ['a', 'd']);
	assert.equal(srcFilter.rejected.find((x) => x.entry.key === 'b').reason, 'source');
});

test('匹配：情绪——有数据但不符 ≠ 没有数据（两种原因必须分开）', () => {
	const r = queryLibrary({ moods: ['安静'] }, LIB);
	assert.equal(r.rejected.find((x) => x.entry.key === 'b').reason, 'mood');
	/* c / e 没有情绪数据 → mood-unknown，不是 mood */
	assert.equal(r.rejected.find((x) => x.entry.key === 'c').reason, 'mood-unknown');
	assert.equal(r.rejected.find((x) => x.entry.key === 'e').reason, 'mood-unknown');
	assert.deepEqual(r.matched.map((x) => x.key), []);
});

test('匹配：情绪命中（mood 既可能是数组也可能是裸字符串）', () => {
	const r = queryLibrary({ moods: ['忧伤'] }, LIB);
	assert.deepEqual(r.matched.map((x) => x.key), ['b']);
	const single = queryLibrary({ moods: ['燃'] }, [{ key: 'z', title: 'x', artist: 'y', mood: '很燃很燃' }]);
	assert.deepEqual(single.matched.map((x) => x.key), ['z']);
});

test('匹配：BPM 区间（缺少分析数据要报 bpm-unknown，不能静默丢）', () => {
	const slow = queryLibrary({ bpm: { max: 80 } }, LIB);
	assert.deepEqual(slow.matched.map((x) => x.key), ['a', 'c']);
	assert.equal(slow.rejected.find((x) => x.entry.key === 'b').reason, 'bpm');
	assert.equal(slow.rejected.find((x) => x.entry.key === 'e').reason, 'bpm-unknown');

	const openMin = queryLibrary({ bpm: { min: 100, max: null } }, LIB);
	assert.deepEqual(openMin.matched.map((x) => x.key), ['d']);
});

test('匹配：按 key 去重（同一首歌可能同时在收藏与歌单里）', () => {
	const dup = [...LIB, { key: 'a', title: '晴天', artist: '周杰伦' }];
	assert.equal(queryLibrary({ artists: ['周杰伦'] }, dup).matched.length, 3);
});

test('匹配：超出上限的算 overLimit，不算 rejected（报成失败会让用户以为规则写错了）', () => {
	const r = queryLibrary({ artists: ['周杰伦'], limit: 2 }, LIB);
	assert.equal(r.matched.length, 2);
	assert.equal(r.overLimit, 1);
	assert.equal(r.rejected.length, 2, '只有 d/e 是真不匹配');
});

test('匹配：空曲库 / 空规则不抛，空规则等于全都要', () => {
	assert.deepEqual(queryLibrary({}, []).matched, []);
	const all = queryLibrary({}, LIB);
	assert.equal(all.matched.length, LIB.length);
	assert.equal(all.rejected.length, 0);
});

/* ---------------- 提示词与回显 ---------------- */

test('提示词：包含用户描述且要求只输出 JSON', () => {
	const { system, user } = buildSmartPrompt('深夜慢歌');
	assert.ok(user.includes('深夜慢歌'));
	assert.ok(/只输出 JSON/.test(system));
	assert.ok(/titleKeywords/.test(system) && /bpm/.test(system));
});

test('回显：ruleToJSON 输出可被 JSON.parse 并归一化回同一份规则', () => {
	const rule = normalizeSmartRule({ name: '慢歌', artists: ['周杰伦'], bpm: '60-90', limit: 20 });
	const back = normalizeSmartRule(JSON.parse(ruleToJSON(rule)));
	assert.deepEqual(back, rule);
	assert.equal(emptySmartRule().limit, SMART_LIMIT_DEFAULT);
});
