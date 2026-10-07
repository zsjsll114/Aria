/* ============================================================
 * tests/js/test_search_suggest.js — 搜索热词 / 联想词解析（services/searchSuggest.js）
 *
 * 背景（2026-10-04 用户需求）：搜索页要在输入框空着时显示热词 + 历史，
 * 有输入时切成联想词。三家 vendor 的返回结构**完全不一样**，而且都是那种
 * 「字段名看着像诗歌」的接口，所以解析必须逐源钉死。
 *
 * 这份测试的 fixture 是**上游真实报文裁剪出来的**（本机自建代理实测抓的原文），
 * 不是照着文档编的 —— 编出来的 fixture 只能证明"我编的和我想的
 * 一样"，钉不住真实的脏数据（尾部空格、<em> 高亮标记、多分组）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert';
import {
    parseHotWords, parseSuggestions,
    hotSupported, suggestSupported, effectiveSource,
    MAX_HOT, MAX_SUGGEST,
} from '../../web/src/services/searchSuggest.js';

/* ---------- 热词 ---------- */

test('parseHotWords / tencent：取 response.data.hotkey[].k，并剥掉尾部空格', () => {
    /* 真实报文里 k 是带尾空格的（"我们的歌 "）—— 不 trim 会搜出奇怪的结果 */
    const j = { response: { code: 0, data: { hotkey: [{ k: '我们的歌 ', n: 765562 }, { k: '冰雪奇缘2 ', n: 587404 }] } } };
    assert.deepEqual(parseHotWords('tencent', j), ['我们的歌', '冰雪奇缘2']);
});

test('parseHotWords / netease：取 result.hots[].first（兼容 keyword 字段）', () => {
    const j = { code: 200, result: { hots: [{ first: '我不难过' }, { first: '茶汤' }, { keyword: '雨爱' }] } };
    assert.deepEqual(parseHotWords('netease', j), ['我不难过', '茶汤', '雨爱']);
});

test('parseHotWords / kugou：data.list[].keywords[].keyword 摊平（多分组）', () => {
    const j = {
        status: 1,
        data: {
            list: [
                { name: '热搜榜', keywords: [{ keyword: '茶汤' }, { keyword: '无奈的思绪' }] },
                { name: '其他', keywords: [{ keyword: '甲乙丙丁' }] },
            ],
        },
    };
    assert.deepEqual(parseHotWords('kugou', j), ['茶汤', '无奈的思绪', '甲乙丙丁']);
});

test('parseHotWords：去重（忽略大小写）+ 丢弃空串 + 上限截断', () => {
    const j = { result: { hots: [{ first: 'Lost' }, { first: 'lost' }, { first: '  ' }, { first: '' }] } };
    assert.deepEqual(parseHotWords('netease', j), ['Lost']);
    const many = { result: { hots: Array.from({ length: MAX_HOT + 20 }, (_, i) => ({ first: 'w' + i })) } };
    assert.equal(parseHotWords('netease', many).length, MAX_HOT);
});

test('parseHotWords：空 / 畸形报文一律回 []（不抛异常）', () => {
    assert.deepEqual(parseHotWords('netease', null), []);
    assert.deepEqual(parseHotWords('netease', {}), []);
    assert.deepEqual(parseHotWords('tencent', { response: {} }), []);
    assert.deepEqual(parseHotWords('kugou', { data: { list: null } }), []);
    assert.deepEqual(parseHotWords('unknown-source', { result: { hots: [{ first: 'x' }] } }), []);
});

/* ---------- 联想词 ---------- */

test('parseSuggestions / tencent：歌曲优先，再补歌手/专辑/MV', () => {
    const j = {
        response: {
            data: {
                song: { itemlist: [{ name: '晴天' }, { name: '晴天娃娃' }] },
                singer: { itemlist: [{ name: '周杰伦' }] },
                album: { itemlist: [{ name: '叶惠美' }] },
                mv: { itemlist: [{ name: '晴天 MV' }] },
            },
        },
    };
    assert.deepEqual(parseSuggestions('tencent', j), ['晴天', '晴天娃娃', '周杰伦', '叶惠美', '晴天 MV']);
});

test('parseSuggestions / netease：songs→artists→albums→playlists→mvs 依次收集', () => {
    const j = {
        result: {
            songs: [{ name: '晴天' }],
            artists: [{ name: '周杰伦' }],
            albums: [{ name: '晴天(深情版)' }],
            playlists: [{ name: '华语经典' }],
            mvs: [{ name: '晴天' }],        /* 与 songs 同名 → 应被去重 */
        },
    };
    assert.deepEqual(parseSuggestions('netease', j), ['晴天', '周杰伦', '晴天(深情版)', '华语经典']);
});

test('parseSuggestions / kugou：data[].RecordDatas[].HintInfo；data 为对象时也要能处理', () => {
    const arrForm = { status: 1, data: [{ RecordDatas: [{ HintInfo: '晴天' }, { HintInfo: '晴天 周杰伦' }] }] };
    assert.deepEqual(parseSuggestions('kugou', arrForm), ['晴天', '晴天 周杰伦']);
    const objForm = { status: 1, data: { RecordDatas: [{ HintInfo: '成都' }] } };
    assert.deepEqual(parseSuggestions('kugou', objForm), ['成都']);
});

test('parseSuggestions：剥掉 <em> 高亮标记 + 上限截断', () => {
    const j = { result: { songs: [{ name: '<em>晴</em>天' }] } };
    assert.deepEqual(parseSuggestions('netease', j), ['晴天']);
    const many = { result: { songs: Array.from({ length: MAX_SUGGEST + 15 }, (_, i) => ({ name: 's' + i })) } };
    assert.equal(parseSuggestions('netease', many).length, MAX_SUGGEST);
});

test('parseSuggestions：空 / 畸形报文一律回 []', () => {
    assert.deepEqual(parseSuggestions('netease', null), []);
    assert.deepEqual(parseSuggestions('netease', {}), []);
    assert.deepEqual(parseSuggestions('tencent', { response: { data: null } }), []);
    assert.deepEqual(parseSuggestions('kugou', { data: null }), []);
    assert.deepEqual(parseSuggestions('unknown', { result: { songs: [{ name: 'x' }] } }), []);
});

/* ---------- 能力表 / 回退 ---------- */

test('能力表：QQ / 网易 / 酷狗 三源都有热词与联想词', () => {
    for (const s of ['tencent', 'netease', 'kugou']) {
        assert.equal(hotSupported(s), true, s + ' 应有热词');
        assert.equal(suggestSupported(s), true, s + ' 应有联想词');
        assert.equal(effectiveSource(s, { qishui: 'netease' }), s, '自身有能力就不该借别的源');
    }
});

test('能力表：汽水没有这两条接口 → 回退网易（宁可给通用建议也不留空白）', () => {
    const FALLBACK = { qishui: 'netease' };
    assert.equal(effectiveSource('qishui', FALLBACK), 'netease');
    assert.equal(hotSupported('qishui'), true, '经网易回退后算"可用"');
    assert.equal(suggestSupported('qishui'), true, '经网易回退后算"可用"');
});

test('能力表：未知 / 本地 等非法源 → 不支持，也不冒充回退', () => {
    assert.equal(hotSupported('local'), false);
    assert.equal(suggestSupported('local'), false);
    assert.equal(hotSupported(''), false);
    assert.equal(suggestSupported('kuwo'), false, '酷我 2026-10-03 已从搜索移除，不该再登记');
});
