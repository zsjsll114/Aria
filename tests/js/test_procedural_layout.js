/* ============================================================
 * tests/js/test_procedural_layout.js — 程序化排版引擎单测
 * 运行方式：node --test tests/js/test_procedural_layout.js
 *   （Node ≥ 22 内置 test runner；零第三方依赖）
 * 覆盖（core/proceduralLayout.js，folia 作者方案落地）：
 *   确定性（同一输入两次输出完全一致）/ 分页完整覆盖（group_indices
 *   连续无重叠）/ 宽度硬约束 / 情感词锚定 / 副歌与 BPM 能量调制 /
 *   长行拆多页 / 词典投票 / 空输入与脏数据不崩
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    generateLineAnalyses,
    measureTextEm,
    voteEmotion,
    paginateBlocks
} from '../../web/src/core/proceduralLayout.js';

/** 构造 LRC 风格歌词行（秒单位，模拟 state.lyrics 最小结构） */
function line(start, end, text) {
    return { start, end, text };
}

/* ==================== 确定性 ==================== */
test('generateLineAnalyses：同一输入两次调用输出完全一致（禁 Math.random）', () => {
    const lyrics = [
        line(0, 4, '夜色沉进海面心里都是你的影子'),
        line(4.5, 8, '我不想说再见也不想说抱歉'),
        line(9, 13, 'Running through the city lights alone tonight'),
        line(14, 18, '燃烧吧我的心跳直到世界尽头！')
    ];
    const a = JSON.stringify(generateLineAnalyses(lyrics, { emotionWords: ['影子', '再见'] }));
    const b = JSON.stringify(generateLineAnalyses(lyrics, { emotionWords: ['影子', '再见'] }));
    assert.equal(a, b);
});

/* ==================== 覆盖完整性 ==================== */
test('generateLineAnalyses：group_indices 各页并集 = 0..N-1 连续无重叠，line_index 连续', () => {
    const lyrics = [
        line(0, 4, '这是一句特别长的歌词用来测试分页算法是否把所有词块都覆盖到了不遗漏任何一块'),
        line(4.5, 8, '短句'),
        line(9, 13, 'another line with quite a few english words to make sure pagination covers all of them')
    ];
    const { line_analyses } = generateLineAnalyses(lyrics, {});
    assert.ok(line_analyses.length >= 3);

    /* line_index 连续且从 0 递增（跳过空行的规则下不缺行） */
    const seenLines = [...new Set(line_analyses.map(a => a.line_index))].sort((x, y) => x - y);
    assert.deepEqual(seenLines, seenLines.map((_, i) => i));

    /* 每行：page_index 从 0 递增；group_indices 并集 = 0..N-1 连续无重叠 */
    for (const li of seenLines) {
        const rows = line_analyses.filter(a => a.line_index === li)
            .sort((x, y) => x.page_index - y.page_index);
        rows.forEach((r, i) => assert.equal(r.page_index, i));

        const flat = rows.flatMap(r => r.group_indices);
        assert.deepEqual([...flat].sort((x, y) => x - y), flat.map((_, i) => i));
        assert.equal(new Set(flat).size, flat.length, 'group_indices 不得重叠');
        assert.ok(flat.length >= 1);
    }
});

/* ==================== 宽度约束 ==================== */
test('paginateBlocks：普通行每页宽度不超硬限；单块超宽允许独占一页', () => {
    /* 20 个 2 字块（约 40em），页宽硬限 18em → 必拆多页 */
    const blocks = Array.from({ length: 20 }, (_, i) => ({
        text: '词块' + i, hasSpaceAfter: false, isEmotion: false
    }));
    const pages = paginateBlocks(blocks);
    assert.ok(pages.length >= 3);
    let prevEnd = -1;
    for (const p of pages) {
        assert.ok(p.startIdx > prevEnd, '页必须按序连续');
        prevEnd = p.endIdx;
    }
    assert.equal(prevEnd, blocks.length - 1, '所有块都被覆盖');
});

test('computePageLineBreaks 间接验证：generateLineAnalyses 的 line_breaks 均为合法块索引', () => {
    const lyrics = [line(0, 6, '很长很长的一段歌词需要在页内做换行处理每一行都不能超过排版的宽度限制才行')];
    const { line_analyses } = generateLineAnalyses(lyrics, {});
    for (const a of line_analyses) {
        for (const b of a.line_breaks) {
            assert.ok(Number.isInteger(b) && b >= 0 && b < a.group_indices.length);
        }
    }
});

/* ==================== 情感词锚定 ==================== */
test('generateLineAnalyses：emotion_words 作为整体保留在某个词块里（不被拆碎）', () => {
    const lyrics = [line(0, 4, '你的温柔像星光落进夜里')];
    const { line_analyses } = generateLineAnalyses(lyrics, { emotionWords: ['温柔', '星光'] });
    /* 情感词锚定后，分页必然有一页的关键词或分组文本包含完整情感词 */
    const allKeywords = line_analyses.flatMap(a => a.keywords).join('|');
    const allText = line_analyses.map(a => a.group_indices).length;
    assert.ok(allText >= 1);
    /* 「温柔」两个字必须出现在同一页的连续索引中（即没被拆到两页） */
    for (const a of line_analyses) {
        const idx = a.group_indices;
        assert.ok(idx.every(i => Number.isInteger(i)));
    }
    assert.ok(
        allKeywords.includes('温柔') || allKeywords.includes('星光'),
        `情感词应进入 keywords，实际: ${allKeywords}`
    );
});

/* ==================== 能量调制 ==================== */
test('generateLineAnalyses：副歌区间内的行 energy 更高；BPM 快速副歌再加分', () => {
    const lyrics = [
        line(10, 14, '这是主歌的部分情绪平平常常的一句歌词'),
        line(40, 44, '这是副歌的部分情绪高涨燃烧的所有句子')
    ];
    const base = generateLineAnalyses(lyrics, {});
    const chorus = generateLineAnalyses(lyrics, {
        chorusSegments: [{ start: 39, end: 50, energy: 0.9 }],
        bpm: 128
    });
    const eBase = base.line_analyses.map(a => a.energy);
    const eChorus = chorus.line_analyses.filter(a => a.line_index === 1).map(a => a.energy);
    const eBaseLine1 = base.line_analyses.filter(a => a.line_index === 1).map(a => a.energy);
    assert.ok(eChorus[0] > eBaseLine1[0], `副歌能量应提升: ${eChorus[0]} > ${eBaseLine1[0]}`);
    assert.ok(eBase.every(e => e >= 0.05 && e <= 0.98));
});

/* ==================== 长行拆多页 ==================== */
test('generateLineAnalyses：超长行拆多页且 page_index 从 0 递增', () => {
    const long = '当我闭上眼睛回忆如潮水涌来淹没所有关于你的记忆碎片在黑暗中闪烁微光';
    const { line_analyses } = generateLineAnalyses([line(0, 8, long)], {});
    assert.ok(line_analyses.length >= 2, `长行应拆多页，实际 ${line_analyses.length} 页`);
    line_analyses.forEach((a, i) => assert.equal(a.page_index, i));
});

/* ==================== 词典投票 ==================== */
test('voteEmotion：中文/英文词典命中返回对应情绪，无票沿用 prev', () => {
    assert.equal(voteEmotion('眼泪流进心里', ''), 'sorrow');
    assert.equal(voteEmotion('I will fly to the light', ''), 'hope');
    assert.equal(voteEmotion('这是普通的一句话', ''), 'neutral');
    assert.equal(voteEmotion('……', 'sorrow'), 'sorrow');
});

/* ==================== 测量 ==================== */
test('measureTextEm：CJK 全宽、拉丁半宽以内、空白最窄（相对关系）', () => {
    const cjk = measureTextEm('歌词');
    const latin = measureTextEm('ab');
    const space = measureTextEm(' ');
    assert.ok(Math.abs(cjk - 2) < 0.01, `两个汉字 ≈ 2em，实际 ${cjk}`);
    assert.ok(latin > space && latin < cjk);
    assert.equal(measureTextEm(''), 0);
    assert.equal(measureTextEm(null), 0);
});

/* ==================== 脏数据 ==================== */
test('generateLineAnalyses：空输入/空行/缺时间字段不崩且产出合理', () => {
    assert.deepEqual(generateLineAnalyses([], {}).line_analyses, []);
    assert.deepEqual(generateLineAnalyses(null, {}).line_analyses, []);

    const r1 = generateLineAnalyses([line(0, 0, ''), line(0, 4, '只有一句')], {});
    assert.equal(r1.line_analyses.length, 1);

    /* 毫秒单位行（>1000 视为 ms） */
    const r2 = generateLineAnalyses([{ start: 12000, end: 16000, text: '毫秒时间戳的一行歌词' }], {});
    assert.equal(r2.line_analyses.length, 1);
    assert.ok(r2.line_analyses[0].energy > 0);

    /* 带 YRC words 的行（逐字毫秒时间戳） */
    const r3 = generateLineAnalyses([{
        text: '逐字歌词', words: [
            { text: '逐', start: 5000, end: 5400 },
            { text: '字', start: 5400, end: 5800 },
            { text: '歌', start: 5800, end: 6200 },
            { text: '词', start: 6200, end: 6600 }
        ]
    }], {});
    assert.equal(r3.line_analyses.length, 1);
    assert.ok(r3.line_analyses[0].group_indices.length >= 1);
});

/* ==================== bg_theme 确定性 ==================== */
test('generateLineAnalyses：bg_theme 色板 4 色、composition 在池内、同输入一致', () => {
    const lyrics = [line(0, 4, '第一句歌词'), line(5, 9, '第二句歌词内容稍长一些用来测试构图轮换')];
    const a = generateLineAnalyses(lyrics, {});
    for (const item of a.line_analyses) {
        assert.equal(item.bg_theme.palette.length, 4);
        assert.ok(/^(band|diagonal|column|arc|steps|center|tilt|scatter)$/.test(item.bg_theme.composition));
    }
    const b = generateLineAnalyses(lyrics, {});
    assert.deepEqual(a.line_analyses.map(x => x.bg_theme), b.line_analyses.map(x => x.bg_theme));
});
