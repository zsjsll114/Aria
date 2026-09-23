/* ============================================================
 * tests/js/test_parsers.js — 歌词解析核心链路纯函数单测
 * 运行方式：node --test tests/js/test_parsers.js
 *   （Node ≥ 22 内置 test runner；零第三方依赖，契合纯标准库约束）
 * 覆盖：LRC / QQ YRC(A·B 排布) / 网易 YRC(三参数) / KRC(含加解密往返) /
 *       Romaji / 增强 LRC / mergeLyrics 对齐 / detectAndParseLyrics 自动识别
 * 期望值均按双端实际输出核实（含历史 bug 回归：A 格式首词丢失、英文空格保留）。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLrc, cleanQQMusicMetadata } from '../../web/src/parsers/lrcParser.js';
import { parseQrcLyric, parseQrcXml } from '../../web/src/parsers/qrcParser.js';
import { tokenizeForKaraoke, synthesizeWords, ensureWordTiming } from '../../web/src/parsers/wordTiming.js';
import { parseYrc, parseNeteaseYrc } from '../../web/src/parsers/yrcParser.js';
import { parseRoma } from '../../web/src/parsers/romaParser.js';
import { parseKrc, decryptKrc, KRC_XOR_KEY } from '../../web/src/services/krcParser.js';
import { parseEnhancedLrc } from '../../web/src/services/enhancedLrcConverter.js';
import { mergeLyrics, detectAndParseLyrics } from '../../web/src/parsers/lyricMerger.js';

/* ==================== LRC ==================== */
test('parseLrc：空输入与非字符串返回空数组', () => {
    assert.deepEqual(parseLrc(''), []);
    assert.deepEqual(parseLrc(null), []);
    assert.deepEqual(parseLrc(undefined), []);
    assert.deepEqual(parseLrc(123), []);
});

test('parseLrc：毫秒位数换算（1/2/3 位与冒号秒格式）', () => {
    assert.deepEqual(parseLrc('[00:12.3]x'), [{ time: 12300, text: 'x' }]);
    assert.deepEqual(parseLrc('[00:12.34]x'), [{ time: 12340, text: 'x' }]);
    assert.deepEqual(parseLrc('[00:12.345]x'), [{ time: 12345, text: 'x' }]);
    assert.deepEqual(parseLrc('[00:12:34]x'), [{ time: 12340, text: 'x' }]); // 冒号秒
    assert.deepEqual(parseLrc('[03:04.5]x'), [{ time: 184500, text: 'x' }]); // 跨分钟
});

test('parseLrc：同行多时间标签展开为多条并全局排序', () => {
    const r = parseLrc('[00:20.00]乙\n[00:10.00]甲\n[00:01.00][00:02.00]哈');
    assert.deepEqual(r, [
        { time: 1000, text: '哈' },
        { time: 2000, text: '哈' },
        { time: 10000, text: '甲' },
        { time: 20000, text: '乙' }
    ]);
});

test('parseLrc：无标签行忽略、CRLF 兼容、文本首尾空白清理', () => {
    assert.deepEqual(parseLrc('纯文本行\n[00:01.00]  词  '), [{ time: 1000, text: '词' }]);
    assert.deepEqual(parseLrc('[00:01.00]a\r\n[00:02.00]b'), [
        { time: 1000, text: 'a' }, { time: 2000, text: 'b' }
    ]);
});

test('cleanQQMusicMetadata：过滤元数据行 / 版权声明 / // 占位行', () => {
    const input = [
        '[ti:名]', '[ar:唱]', '[al:专辑]', '[by:工具]', '[offset:500]', '[kana:か]',
        '[00:01.00]词', '[00:02.00]//', '[00:03.00]h',
        '[00:04.00]本行自称享有本翻译作品的著作权',
        '[00:05.00][00:06.00]y'
    ].join('\n');
    const out = cleanQQMusicMetadata(input);
    assert.equal(out.includes('[ti:'), false);
    assert.equal(out.includes('[ar:'), false);
    assert.equal(out.includes('[offset:'), false);
    assert.ok(out.includes('[00:01.00]词'));
    assert.ok(out.includes('[00:03.00]h'));
    assert.ok(out.includes('[00:05.00][00:06.00]y'));
    assert.equal(out.includes('[00:02.00]//'), false);      // // 占位行
    assert.equal(out.includes('著作权'), false);            // 版权声明
});

/* ==================== YRC — QQ ==================== */
test('parseYrc：A 排布（文本在标记前）首词不丢失（历史 bug 回归）', () => {
    const r = parseYrc('[0,3750]编(6750,375)曲(7125,375)');
    assert.equal(r.length, 1);
    assert.equal(r[0].start, 0);
    assert.equal(r[0].end, 3750);
    assert.equal(r[0].original, '编曲');
    assert.deepEqual(r[0].words, [
        { text: '编', start: 6750, end: 7125 },
        { text: '曲', start: 7125, end: 7500 }
    ]);
});

test('parseYrc：A 排布词间空格保留、行首残留空格清理', () => {
    const r = parseYrc('[0,500]你(0,100) 好(100,100)');
    assert.equal(r[0].original, '你 好');
    assert.equal(r[0].words[0].text, '你');
    assert.equal(r[0].words[1].text, ' 好');
});

test('parseYrc：B 排布（文本在标记后）与无标记整行保留', () => {
    const r = parseYrc('[0,480]晴(0,160)天(160,160)');
    assert.equal(r[0].original, '晴天');
    assert.deepEqual(r[0].words.map(w => [w.text, w.start, w.end]), [
        ['晴', 0, 160], ['天', 160, 320]
    ]);
    const plain = parseYrc('[0,1000]纯文本行');
    assert.deepEqual(plain, [{ start: 0, duration: 1000, end: 1000, original: '纯文本行', words: [] }]);
});

test('parseYrc：空输入返回空数组', () => {
    assert.deepEqual(parseYrc(''), []);
    assert.deepEqual(parseYrc(null), []);
});

/* ==================== YRC — 网易 ==================== */
test('parseNeteaseYrc：三参数排布解析与英文逐字空格保留', () => {
    const r = parseNeteaseYrc('[0,320](0,160,1)青(160,160,0)春\n[500,1000](0,100,0)Hello(100,100,0) World');
    assert.equal(r.length, 2);
    assert.equal(r[0].original, '青春');
    assert.deepEqual(r[0].words.map(w => [w.text, w.start, w.end]), [
        ['青', 0, 160], ['春', 160, 320]
    ]);
    assert.equal(r[1].original, 'Hello World');           // 单词间距不丢失
    assert.equal(r[1].words[1].text, ' World');
});

/* ==================== Romaji ==================== */
test('parseRoma：文本在标记后的罗马音逐词解析', () => {
    const r = parseRoma('(0,100)sa(100,100)ku(200,100)ra\n(300,100)ho');
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], {
        start: 100, duration: 300, end: 400, original: 'sa ku ra',
        words: [
            { text: 'sa', start: 100, end: 200 },
            { text: 'ku', start: 200, end: 300 },
            { text: 'ra', start: 300, end: 400 }
        ]
    });
});

/* ==================== KRC ==================== */
test('parseKrc：元数据行过滤、逐字相对时间绝对值化、英文空格保留', () => {
    const r = parseKrc('[ti:名]\n[ar:唱]\n[0,300]<0,100,0>青<100,100,0>春\n[500,1000]<0,200,2>Hello<200,200,2> World');
    assert.equal(r.length, 2);
    assert.equal(r[0].original, '青春');
    assert.deepEqual(r[0].words.map(w => [w.text, w.start, w.end]), [
        ['青', 0, 100], ['春', 100, 200]
    ]);
    assert.equal(r[1].original, 'Hello World');           // KRC 同样保留词间空格
    assert.equal(r[1].words[1].text, ' World');
});

test('decryptKrc：krc1 头 + XOR + deflate 往返还原原文', async () => {
    const plain = '[0,300]<0,100,0>青<100,100,0>春\n[500,1000]<0,200,2>Hello<200,200,2> World';
    /* 真实结构：'krc1' 头 + XOR(压缩(明文))；解密端顺序为 剥头→XOR→inflate */
    const bytes = new TextEncoder().encode(plain);
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const xor = merged.map((b, i) => b ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length]);
    const payload = new Uint8Array([0x6b, 0x72, 0x63, 0x31, ...xor]);
    const base64 = btoa(String.fromCharCode(...payload));

    assert.equal(await decryptKrc(base64), plain);
    assert.equal(await decryptKrc(''), '');               // 空输入安全
});

/* ==================== 增强 LRC ==================== */
test('parseEnhancedLrc：翻译合并、逐字打点、元数据提取', () => {
    const r = parseEnhancedLrc('[ti:测试]\n[00:10.00]一行歌词\n[00:10.00](tr)翻译内容\n[00:20.00]<00:20.50>逐<00:20.90>字');
    assert.equal(r.metadata.title, '测试');
    assert.equal(r.hasWordLevel, true);
    assert.equal(r.lines.length, 2);
    assert.deepEqual(r.lines[0], {
        start: 10000, end: 20000, original: '一行歌词', duration: 10000, translation: '翻译内容'
    });
    assert.equal(r.lines[1].original, '逐字');
    assert.deepEqual(r.lines[1].words.map(w => [w.text, w.start, w.end]), [
        ['逐', 20500, 20900], ['字', 20900, 21200]
    ]);
});

/* ==================== mergeLyrics ==================== */
test('mergeLyrics：精确命中与 3s 内最近翻译对齐', () => {
    const r = mergeLyrics(
        [{ start: 1000, original: 'a' }, { start: 4000, original: 'b' }],
        [{ time: 1000, text: '译文A' }, { time: 2500, text: '遥远' }]
    );
    assert.equal(r[0].translation, '译文A');              // 精确
    assert.equal(r[1].translation, '遥远');               // 1500ms 内最近
    assert.equal(r[0].romaji, '');
    assert.deepEqual(r[0].romajiWords, []);
});

test('mergeLyrics：无翻译时字段为空字符串，3s 外不匹配', () => {
    const r = mergeLyrics([{ start: 1000, original: 'a' }, { start: 9000, original: 'b' }],
        [{ time: 1000, text: '译文A' }, { time: 4000, text: '太远' }]);
    assert.equal(r[0].translation, '译文A');
    assert.equal(r[1].translation, '');                   // 9000-4000=5000 > 3000 → 不匹配
});

test('mergeLyrics：中文歌配中文"翻译"轨（源站错发另一首歌）→ 逐行丢弃翻译', () => {
    const originals = [
        { start: 1000, original: '岁月难得沉默秋风厌倦漂泊' },
        { start: 5000, original: '夕阳赖着不走挂在墙头舍不得我' },
        { start: 9000, original: '出品：昌禾文化' },                    // 制作信息行 → 整行剔除
        { start: 13000, original: '[该版本已获词曲正式授权]' },        // 版权行 → 整行剔除
    ];
    // 源站错发：翻译轨其实是另一首中文歌（《我想》）
    const translations = [
        { time: 1000, text: '我想拥抱你' },
        { time: 5000, text: '我想留在你身边' },
        { time: 13000, text: '我想拥抱你' },
    ];
    const r = mergeLyrics(originals, translations);
    assert.equal(r.length, 2);                                // 两条制作信息行被剔除
    assert.equal(r[0].original, '岁月难得沉默秋风厌倦漂泊');
    assert.equal(r[0].translation, '');                       // 中文配中文 → 丢弃
    assert.equal(r[1].translation, '');
});

test('mergeLyrics：日文行配中文翻译保留（日→中是正常翻译，不受同文字守卫影响）', () => {
    const r = mergeLyrics(
        [{ start: 1000, original: '夜に駆ける' }],
        [{ time: 1000, text: '奔向夜空' }]
    );
    assert.equal(r[0].translation, '奔向夜空');
});

test('mergeLyrics：中文歌配英文翻译保留（跨语言才是真翻译）', () => {
    const r = mergeLyrics(
        [{ start: 1000, original: '岁月难得沉默' }],
        [{ time: 1000, text: 'Time holds its breath' }]
    );
    assert.equal(r[0].translation, 'Time holds its breath');
});

test('mergeLyrics：无翻译的行不得捡到后面几行的翻译（1:1 对齐）', () => {
    // 第 1 行有翻译，第 2 行本来没有——旧算法第 2 行距 T0 仅 1s，会错拿第 1 行的翻译
    const r = mergeLyrics(
        [{ start: 1000, original: '有翻译的行' }, { start: 2000, original: '没翻译的行' }],
        [{ time: 1000, text: 'T0' }]
    );
    assert.equal(r[0].translation, 'T0');
    assert.equal(r[1].translation, '');
});

test('mergeLyrics：罗马音按行对齐并携带逐词', () => {
    const r = mergeLyrics(
        [{ start: 1000, original: 'a' }], [],
        [{ start: 1000, original: 'sakura', words: [{ text: 'sa' }, { text: 'ku' }] }]
    );
    assert.equal(r[0].romaji, 'sakura');
    assert.equal(r[0].romajiWords.length, 2);
});

/* ==================== detectAndParseLyrics ==================== */
test('detectAndParseLyrics：自动识别 QQ/网易 YRC 与字符串入参', () => {
    const qq = detectAndParseLyrics({ yrc: '[0,3750]编(6750,375)曲(7125,375)' });
    assert.equal(qq.format, 'qq_yrc');
    assert.equal(qq.originals[0].original, '编曲');
    assert.equal(qq.originals[0].words[0].text, '编');     // 首词保留

    const ncm = detectAndParseLyrics({ yrc: '[0,320](0,160,1)青(160,160,0)春' });
    assert.equal(ncm.format, 'netease_yrc');
    assert.equal(ncm.originals[0].original, '青春');

    const str = detectAndParseLyrics('[00:01.00]字符串');
    assert.equal(str.format, 'lrc');
    assert.equal(str.originals[0].original, '字符串');
});

test('detectAndParseLyrics：LRC 结构、翻译、KRC parsedList 直通、空输入', () => {
    const lrc = detectAndParseLyrics({ lrc: '[00:01.00]词', trans: '[00:01.00]翻译' });
    assert.equal(lrc.format, 'lrc');
    assert.equal(lrc.originals[0].start, 1000);
    assert.deepEqual(lrc.translations, [{ time: 1000, text: '翻译' }]);

    const pl = detectAndParseLyrics({ parsedList: [{ start: 0, original: 'x', words: [] }] });
    assert.equal(pl.format, 'kugou_krc');
    assert.equal(pl.originals[0].original, 'x');

    assert.equal(detectAndParseLyrics(null).format, 'empty');
    assert.deepEqual(detectAndParseLyrics(undefined).originals, []);
});

/* ==================== QRC 逐字歌词（NPS 接管接入回归） ====================
   针对 kthri/now-playing(9863) 实测推送：karaoke 歌曲的 Lyric 帧 data.lrc
   即「每行一条 JSON」的 QRC 格式；karaokeLyric 另有 XML 形态。
   曾缺陷：未识别 QRC → 逐字歌词部分/全部不显示。 */
test('parseQrcLyric：每行 JSON 逐字歌词全量解析（元数据/空 c 行跳过）', () => {
    const lrc = [
        '{"t":0,"c":[{"tx":"作词"},{"tx":"：某某"}],"type":0}',
        '{"t":12000,"c":[{"tx":"你"},{"tx":"是"}]}',
        '{"t":15000,"c":[{"tx":"我"}]}',
        '{"t":18000,"c":[]}',                                  // 间奏空 c 行
        '{"t":21000,"c":[{"tx":"的"},{"tx":"月"},{"tx":"光"}]}',
    ].join('\n');
    const r = parseQrcLyric(lrc);
    assert.ok(r, '应能解析出逐字行');
    assert.equal(r.length, 4);
    assert.deepEqual(r[0], { start: 0, text: '作词：某某', original: '作词：某某' });
    assert.equal(r[1].start, 12000);
    assert.equal(r[1].text, '你是');
    assert.equal(r[2].start, 15000);
    assert.equal(r[3].start, 21000);
    assert.equal(r[3].text, '的月光');
});

test('parseQrcLyric：空 c 元数据行 + 少于 2 行 → null', () => {
    assert.equal(parseQrcLyric(null), null);
    assert.equal(parseQrcLyric(''), null);
    assert.equal(parseQrcLyric('{"t":1000,"c":[]}'), null);   // 仅 1 行且无文本
    assert.equal(parseQrcLyric('不是JSON'), null);
});

test('parseQrcXml：LyricLine 毫秒时间戳逐字行解析', () => {
    const xml = '<QrcInfos><QrcHeadInfo Version="8.0"/><LyricInfo>' +
        '<LyricLine LyricTime="12000"><Text>你是</Text></LyricLine>' +
        '<LyricLine LyricTime="15000"><Text>我</Text></LyricLine>' +
        '<LyricLine LyricTime="21000"><Text>的月光</Text></LyricLine>' +
        '</LyricInfo></QrcInfos>';
    const r = parseQrcXml(xml);
    assert.ok(r && r.length === 3);
    assert.deepEqual(r[0], { start: 12000, text: '你是', original: '你是' });
    assert.equal(r[2].start, 21000);
    assert.equal(r[2].text, '的月光');
});

test('parseQrcXml：属性值无引号/空文本行 → 过滤（解析守卫：需≥2 有效行）', () => {
    const xml = '<QrcInfos>' +
        '<LyricLine LyricTime=12000><Text>行1</Text></LyricLine>' +
        '<LyricLine LyricTime=15000><Text></Text></LyricLine>' +   // 空文本 → 不产出
        '<LyricLine LyricTime=21000><Text>行2</Text></LyricLine>' +
        '</QrcInfos>';
    const r = parseQrcXml(xml);
    assert.ok(r && r.length === 2);
    assert.ok(r.every(l => l.text.length > 0));   // 空文本行不产出
    assert.equal(r[0].start, 12000);
    assert.equal(r[1].start, 21000);
});

/* ==================== 逐字时间补全（wordTiming） ==================== */
/* 这是「NPS/外部歌词看不到逐字」的修复核心：renderLyrics 只在 line.words 存在时
   才建 .word/.word-highlight 逐字层，而行级歌词没有 words。 */

test('tokenizeForKaraoke：CJK 逐字切分，拉丁整词，空白并入前一词元', () => {
    const t = tokenizeForKaraoke('我 爱你 baby');
    /* 空白并入前一词元尾部（渲染层 buildWordsInto 会把它剥成 white-space:pre 占位，
       词间距因此不丢）；行首空白才独立成 weight 0 的占位词元 */
    assert.deepEqual(t.map(x => x.text), ['我 ', '爱', '你 ', 'baby']);
    /* weight：CJK 每字 1，拉丁词按可见字符数但上限 6 */
    assert.deepEqual(t.map(x => x.weight), [1, 1, 1, 4]);
});

test('tokenizeForKaraoke：行首空白成独立占位词元（weight 0）', () => {
    const t = tokenizeForKaraoke('  你好');
    assert.equal(t[0].text, '  ');
    assert.equal(t[0].weight, 0);
    assert.deepEqual(t.slice(1).map(x => x.text), ['你', '好']);
});

test('synthesizeWords：字词按行区间均分，单调不重叠且覆盖整行', () => {
    const lines = [
        { start: 1000, text: '一二三四' },
        { start: 5000, text: '五' },
    ];
    const out = synthesizeWords(lines);
    const w = out[0].words;
    assert.equal(w.length, 4);
    assert.equal(w[0].start, 1000);            // 从行首开始
    assert.equal(w[w.length - 1].end, 5000);   // 到下一行开始处结束（覆盖整行）
    for (let i = 0; i < w.length; i++) {
        assert.ok(w[i].end > w[i].start, '每个词元区间非空（渲染层会做除法，零长区间会出 NaN）');
        if (i > 0) assert.ok(w[i].start >= w[i - 1].end, '词元不应重叠');
    }
    assert.deepEqual(w.map(x => x.text), ['一', '二', '三', '四']);
});

test('synthesizeWords：拉丁按可见字符加权（长词分到更长时长）', () => {
    const out = synthesizeWords([
        { start: 0, text: 'a abcdef' },   // 'a '(w1) + 'abcdef'(w6)
        { start: 7000, text: 'x' },
    ]);
    const [a, word] = out[0].words;
    assert.equal(a.text, 'a ');
    assert.equal(word.text, 'abcdef');
    assert.ok((word.end - word.start) > (a.end - a.start) * 3, '长词的时长应显著大于单字符');
});

test('synthesizeWords：末行无下一行时用 totalMs；长间奏截断到 maxLineMs', () => {
    const out = synthesizeWords([
        { start: 0, text: '甲' },
        { start: 1000, text: '乙' },
    ], { totalMs: 9000 });
    assert.equal(out[1].words[0].end, 9000);   // 末行吃到总时长

    const clamped = synthesizeWords([
        { start: 0, text: '甲' },
        { start: 60000, text: '乙' },          // 60s 长间奏
    ]);
    assert.equal(clamped[0].words[0].end, 10000);  // 默认 maxLineMs=10000，不把整段间奏摊给一行
});

test('ensureWordTiming：已有真实逐字 → 原样保留，不覆盖第三方精确节拍', () => {
    const real = [{
        start: 0, text: '你好', original: '你好',
        words: [{ text: '你', start: 0, end: 300 }, { text: '好', start: 300, end: 800 }],
    }, { start: 2000, text: '世界', original: '世界', words: [{ text: '世界', start: 2000, end: 2600 }] }];
    const out = ensureWordTiming(real);
    assert.equal(out, real, '应直接返回原数组引用');
    assert.equal(out[0].words[1].end, 800);
});

test('ensureWordTiming：行级歌词（无 words）→ 合成逐字，且原行其它字段保留', () => {
    const out = ensureWordTiming([
        { start: 0, text: '你好', original: '你好', translation: 'hello' },
        { start: 2000, text: '世界', original: '世界' },
    ]);
    assert.equal(out[0].words.length, 2);
    assert.equal(out[0].translation, 'hello');
    assert.equal(out[1].words[0].start, 2000);
});

test('ensureWordTiming：少于 2 行 / 非数组 → 原样返回（与 applyExternalLyrics 的守卫一致）', () => {
    assert.equal(ensureWordTiming(null), null);
    assert.deepEqual(ensureWordTiming([]), []);
    const one = [{ start: 0, text: '单行' }];
    assert.equal(ensureWordTiming(one), one);
});