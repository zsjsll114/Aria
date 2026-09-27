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
import { tokenizeForKaraoke, synthesizeWords, ensureWordTiming, hasRealWordTiming, isSyntheticWordLine, stripSyntheticWords, realWordsOf, SYNTHESIZED } from '../../web/src/parsers/wordTiming.js';
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

/* ==================== mergeLyrics 对齐 v2：系统性偏移 ====================
 * 现场事故（2026-09-26 用户报告）：单调对齐只认「|行时间-译文字间| ≤ 3s」这个**绝对**窗口，
 * 而真实翻译轨往往带一个**整体偏移**（译文轨重新打点 / 原轨多一条前缀行 / 两份词由不同工具产出）。
 * 偏移一超过窗口就整片掉覆盖（实测掉到约一半），偏移卡在行距之间时又会让每一行拿到
 * **上一行**的译文（岔开）。下面这批钉全部针对这两条。 */

/* 造一组「原轨 + 翻译轨」：原轨等距，翻译轨按 offsetOf(i) 相对整体偏移 */
function makeOffsetCase(rowCount, { spacing = 3000, first = 1000, offsetOf = () => 0, skip = [] } = {}) {
    const originals = [];
    const translations = [];
    for (let i = 0; i < rowCount; i++) {
        const start = first + i * spacing;
        originals.push({ start, original: `L${i}` });
        if (skip.includes(i)) continue;
        translations.push({ time: start + offsetOf(i), text: `T${i}` });
    }
    return { originals, translations };
}

/* 逐行核对：每行拿到的必须是「自己的」那句译文（T{i}），错配与丢失都算失败 */
function assertInOrder(r, expected) {
    assert.deepEqual(r.map(l => l.translation), expected);
}

test('mergeLyrics：翻译轨整体偏移 +4000ms → 每行拿到自己的译文（旧绝对窗会整体岔开一行）', () => {
    const { originals, translations } = makeOffsetCase(7, { offsetOf: () => 4000 });
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
});

test('mergeLyrics：行距 10s + 翻译轨偏移 +5000ms → 覆盖率不再整片归零', () => {
    const originals = [0, 10000, 20000, 30000, 40000].map(t => ({ start: t, original: `L${t}` }));
    const translations = [5000, 15000, 25000, 35000, 45000].map((t, i) => ({ time: t, text: `T${i}` }));
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, ['T0', 'T1', 'T2', 'T3', 'T4']);
});

test('mergeLyrics：原轨多一条开头行（翻译轨没有）→ 后续配对不得整体错开一行', () => {
    const originals = [
        { start: 0, original: 'intro' },                        // 前缀旁白，翻译轨里根本没有
        { start: 3000, original: 'A' }, { start: 6000, original: 'B' },
        { start: 9000, original: 'C' }, { start: 12000, original: 'D' }
    ];
    const translations = [
        { time: 7000, text: 'TA' }, { time: 10000, text: 'TB' }, { time: 13000, text: 'TC' }
    ];
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, ['', 'TA', 'TB', 'TC', '']);
});

test('mergeLyrics：中间一行真的没有译文 → 该行留空，邻居照常（叠加 +3500ms 整体偏移）', () => {
    const originals = [1000, 4000, 7000, 10000].map(t => ({ start: t, original: `L${t}` }));
    const translations = [
        { time: 4500, text: 'T0' },     // 属于 1000
        { time: 7500, text: 'T1' },     // 属于 4000
        { time: 13500, text: 'T3' }     // 属于 10000；7000 那句翻译轨里就是没有
    ];
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, ['T0', 'T1', '', 'T3']);
});

test('mergeLyrics：偏移逐行递增（漂移 0→+6000ms）→ 仍能逐行对号', () => {
    const { originals, translations } = makeOffsetCase(7, {
        spacing: 16500, first: 1000, offsetOf: i => i * 1000
    });
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
});

test('mergeLyrics：40 行 + 偏移 6500ms + 翻译轨漏 4 句 → 覆盖率 ≥90% 且零错配', () => {
    const skip = [5, 13, 27, 33];
    const { originals, translations } = makeOffsetCase(40, {
        spacing: 4000, first: 1200, offsetOf: () => 6500, skip
    });
    const r = mergeLyrics(originals, translations);
    const expected = Array.from({ length: 40 }, (_, i) => (skip.includes(i) ? '' : `T${i}`));
    assertInOrder(r, expected);
    assert.ok(r.filter(l => l.translation).length >= 36, '译文覆盖率掉了');
});

test('mergeLyrics：翻译轨远短于原轨（12 行里只有 2 句）→ 零偏移优先，两句各归各行', () => {
    const originals = Array.from({ length: 12 }, (_, i) => ({ start: 1000 + i * 3000, original: `L${i}` }));
    const translations = [
        { time: 7000, text: 'T2' },        // 与原轨 start=7000 那行严格对齐
        { time: 28000, text: 'T9' }        // 与 start=28000 那行严格对齐
    ];
    const r = mergeLyrics(originals, translations);
    /* 证据只有两句时，"偏移 3000ms 也能配上两句"的巧合假设必须让位于零偏移 */
    assertInOrder(r, ['', '', 'T2', '', '', '', '', '', '', 'T9', '', '']);
});

test('mergeLyrics：时间戳全为 0 / 非数字的垃圾轨 → 一律不配对（宁缺勿错），且不抛', () => {
    const r = mergeLyrics(
        [{ start: 0, original: 'a' }, { start: 0, original: 'b' }, { start: 0, original: 'c' }],
        [{ time: 0, text: 'T0' }, { time: 0, text: 'T1' }, { time: 0, text: 'T2' }]
    );
    assertInOrder(r, ['', '', '']);
    // 原轨时间戳全 0、翻译轨正常：同样不得凭顺序硬塞
    assertInOrder(mergeLyrics(
        [{ start: 0, original: 'a' }, { start: 0, original: 'b' }],
        [{ time: 1000, text: 'T0' }, { time: 4000, text: 'T1' }]
    ), ['', '']);
    // 单行时间戳非数字 → 该行不进对齐（拿不到译文），但行本身保留
    const r2 = mergeLyrics([{ start: NaN, original: 'x' }, { start: 1000, original: 'y' }],
        [{ time: 1000, text: 'T' }]);
    assertInOrder(r2, ['', 'T']);
});

test('mergeLyrics：孤零零一条译文 + 巨大偏移 → 证据不足，宁可不配', () => {
    const originals = Array.from({ length: 12 }, (_, i) => ({ start: 1000 + i * 3000, original: `L${i}` }));
    const r = mergeLyrics(originals, [{ time: 90000, text: 'LONE' }]);
    assert.equal(r.filter(l => l.translation).length, 0);
});

test('mergeLyrics：罗马音轨带整体偏移时同样对齐（逐词一起带上）', () => {
    const originals = [1000, 4000, 7000].map(t => ({ start: t, original: `L${t}` }));
    const romaji = [5000, 8000, 11000].map((t, i) => ({
        start: t, original: `r${i}`, words: [{ text: `w${i}a` }, { text: `w${i}b` }]
    }));
    const r = mergeLyrics(originals, [], romaji);
    assert.deepEqual(r.map(l => l.romaji), ['r0', 'r1', 'r2']);
    assert.deepEqual(r.map(l => l.romajiWords.length), [2, 2, 2]);
});

/* 可复现噪声：LCG，不依赖 Math.random（与 test_word_aligner.js 同一手法） */
function lcg01(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function medianOf(nums) {
    const s = nums.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

test('mergeLyrics：不变量——抖动行距 + 偏移 6000ms + 15% 缺行，每条译文各归其行且不复用/不交叉', () => {
    const rnd = lcg01(20260926);
    const originals = [];
    let t = 1000;
    for (let i = 0; i < 40; i++) {
        originals.push({ start: t, original: `L${i}` });
        t += 2500 + Math.round(rnd() * 1500);            // 行距 2500~4000ms，逐行抖动
    }
    const present = [];
    const translations = [];
    for (let i = 0; i < originals.length; i++) {
        const has = rnd() >= 0.15;                        // 翻译轨约每 7 句漏 1 句
        present.push(has);
        if (!has) continue;
        translations.push({
            time: originals[i].start + 6000 + Math.round((rnd() - 0.5) * 600),
            text: `T${i}`
        });
    }
    const r = mergeLyrics(originals, translations);
    assertInOrder(r, present.map((has, i) => (has ? `T${i}` : '')));

    /* 三条不变量单独复核（不依赖上面那条逐行对号刚好命中）。
       注意必须在「扣掉整体偏移」之后的坐标系里比距离——直接比原始时间会把
       偏移 6000ms 的正常配对判成"更属于下一行"。 */
    const timeOfText = text => translations.find(x => x.text === text).time;
    const paired = r.filter(l => l.translation);
    const off = medianOf(paired.map(l => timeOfText(l.translation) - l.start));
    const seen = new Set();
    let lastTime = -Infinity;
    for (const line of paired) {
        assert.equal(seen.has(line.translation), false, '一条译文被两行共用了');
        seen.add(line.translation);
        const tt = timeOfText(line.translation);
        assert.ok(tt > lastTime, '两行拿到的译文时间倒挂（配对交叉）');
        lastTime = tt;
        const mine = Math.abs(tt - (line.start + off));
        assert.ok(mine <= 1600, `残差过大（${mine}ms）：这一对是牵强附会出来的`);
        for (const other of originals) {
            if (other.start === line.start) continue;
            assert.ok(mine <= Math.abs(tt - (other.start + off)),
                `${line.translation} 明显更属于 start=${other.start} 那一行`);
        }
    }
});

test('mergeLyrics：两道守卫在新对齐下依旧生效（偏移版）', () => {
    // 中文原轨 + 整体偏移 +4000ms 的中文"翻译"轨（源站错发另一首歌）→ 逐行丢弃
    const originals = [
        { start: 1000, original: '岁月难得沉默秋风厌倦漂泊' },
        { start: 5000, original: '夕阳赖着不走挂在墙头舍不得我' },
        { start: 9000, original: '出品：昌禾文化' },
        { start: 13000, original: '[该版本已获词曲正式授权]' }
    ];
    const translations = [
        { time: 5000, text: '我想拥抱你' },
        { time: 9000, text: '我想留在你身边' },
        { time: 17000, text: '翻译：某某' }
    ];
    const r = mergeLyrics(originals, translations);
    assert.equal(r.length, 2, '制作信息/版权行必须整行剔除');
    assertInOrder(r, ['', '']);
    // 日文行（含假名）配偏移后的中文翻译属正常日→中，不得被守卫误伤
    const ja = mergeLyrics(
        [{ start: 1000, original: '夜に駆ける' }, { start: 4000, original: '君と見た空' }],
        [{ time: 5000, text: '奔向夜空' }, { time: 8000, text: '与你同看的天空' }]
    );
    assertInOrder(ja, ['奔向夜空', '与你同看的天空']);
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
/* ---------- 合成逐字必须可区分 ----------
   接线点是 renderLyrics：它会把合成好的 words 写进 globalThis.lyrics，桌面歌词/PV/词云
   因此一起受益。但下游有一批代码是拿 `line.words.length` 判**真值**的——下载歌词
   (90-eq)、"逐字歌词"标签(130-playlists)、歌词源质量打分(170/lyricMatcher)。
   没有标记的话它们会把摊平的近似节拍当成平台给的精确逐字：下载下来的 .lrc 里
   全是假时间戳，选源时又会优先选中合成过的那份。 */

test('synthesizeWords：合成行带 wordTiming 标记', () => {
    const out = synthesizeWords([{ start: 0, text: '你好' }, { start: 2000, text: '世界' }]);
    assert.equal(out[0].wordTiming, SYNTHESIZED);
    assert.equal(out[1].wordTiming, SYNTHESIZED);
});

test('ensureWordTiming：真实逐字行不打合成标记（否则真值判定会反过来被骗）', () => {
    const real = [
        { start: 0, text: '你好', words: [{ text: '你', start: 0, end: 300 }, { text: '好', start: 300, end: 800 }] },
        { start: 2000, text: '世界', words: [{ text: '世界', start: 2000, end: 2600 }] },
    ];
    const out = ensureWordTiming(real);
    assert.equal(out, real, '真实逐字应原样返回');
    assert.equal(out[0].wordTiming, undefined);
    assert.equal(isSyntheticWordLine(out[0]), false);
});

test('hasRealWordTiming：合成出来的 words 不算真实逐字', () => {
    const synthesized = ensureWordTiming([
        { start: 0, text: '你好', original: '你好' },
        { start: 2000, text: '世界', original: '世界' },
    ]);
    assert.ok(synthesized[0].words.length, '前提：确实合成了 words');
    assert.equal(hasRealWordTiming(synthesized), false, '摊平的近似节拍不能被当成平台精确逐字');
});

test('ensureWordTiming：对已合成的数组再调用一次，结果不变（renderLyrics 会被反复调用）', () => {
    const once = ensureWordTiming([
        { start: 0, text: '一二三' },
        { start: 3000, text: '四' },
    ], { totalMs: 6000 });
    const twice = ensureWordTiming(once, { totalMs: 6000 });
    assert.deepEqual(twice.map(l => l.words), once.map(l => l.words));
    assert.deepEqual(twice.map(l => l.wordTiming), once.map(l => l.wordTiming));
});

test('isSyntheticWordLine：无 words 的行不是合成行', () => {
    assert.equal(isSyntheticWordLine({ start: 0, text: 'x' }), false);
    assert.equal(isSyntheticWordLine(null), false);
    assert.equal(isSyntheticWordLine({ wordTiming: SYNTHESIZED, words: [{ text: 'x', start: 0, end: 1 }] }), true);
});

test('stripSyntheticWords：去掉合成 words、保留真实 words（下载/导出前必须过这一道）', () => {
    const mixed = [
        { start: 0, text: '合成行', wordTiming: SYNTHESIZED, words: [{ text: '合', start: 0, end: 10 }] },
        { start: 5000, text: '真实行', words: [{ text: '真', start: 5000, end: 5300 }] },
    ];
    const out = stripSyntheticWords(mixed);
    assert.equal(out[0].words.length, 0, '合成行不得带假时间戳出去');
    assert.equal(out[0].wordTiming, undefined);
    assert.equal(out[1].words[0].start, 5000, '真实逐字必须原样保留');
    assert.equal(mixed[0].words.length, 1, '不得原地改调用方的数组');
});

test('ensureWordTiming：混合形状逐行补——带真实节拍的行不动，缺的那行合成', () => {
    const realWord = { text: '甲', start: 0, end: 111 };
    const lines = [
        { start: 0, end: 1000, text: '甲乙', words: [realWord, { text: '乙', start: 111, end: 999 }] },
        { start: 1000, end: 2000, text: '丙丁' },
    ];
    const out = ensureWordTiming(lines);
    assert.equal(out[0], lines[0], '带真实逐字的行必须原引用保留');
    assert.equal(out[0].words[0], realWord);
    assert.equal(out[1].wordTiming, SYNTHESIZED, '缺逐字的行应被补上');
    assert.equal(out[1].words.length, 2);
    assert.equal(out[1].words[0].start, 1000, '补出来的区间应贴着本行 start');
    assert.equal(out[1].words[1].end, 2000);
});

/* ---------- 导出/展示侧的真值判定 ----------
   renderLyrics 会把合成的 words 写进 globalThis.lyrics。下载歌词的序列化
   (_krcText)、"逐字歌词"标签、歌词源质量打分都读 line.words——不区分的话
   摊平出来的假节拍会被当成平台精确逐字：下载出去的 .lrc 全是编造的时间戳。 */

test('realWordsOf：合成行返回 null（下载时该走行级分支）', () => {
    assert.deepEqual(realWordsOf({ wordTiming: SYNTHESIZED, words: [{ text: '甲', start: 0, end: 9 }] }), null);
});

test('realWordsOf：真实行原样给出 words', () => {
    const ws = [{ text: '甲', start: 0, end: 300 }];
    assert.equal(realWordsOf({ words: ws }), ws);
});

test('realWordsOf：无 words / 脏数据 → null，不抛', () => {
    assert.equal(realWordsOf({ start: 0, text: 'x' }), null);
    assert.equal(realWordsOf({ words: [] }), null);
    assert.equal(realWordsOf({ words: [{ text: '甲' }] }), null, '缺 start/end 的不能算真实逐字');
    assert.equal(realWordsOf({ words: [{ text: '甲', start: 5, end: 5 }] }), null, '零长区间不能算真实');
    assert.equal(realWordsOf(null), null);
});
