/* ============================================================
 * tests/js/test_lyric_rows.js — 棱镜等全屏模式共用的歌词排版纯逻辑
 *
 * 钉住三件用户直接能看到的事：
 *   ① 长句按行拆开，不再靠省略号截断；
 *   ② 拆行不切断拉丁词，行范围无空洞；
 *   ③ AI 情感词按字素准确落色，暗背景自动提亮。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGraphemes,
    clamp01,
    emotionColorsForGraphemes,
    ensureReadableOnDark,
    graphemeWeight,
    normalizeLine,
    rowCountFor,
    rowFitScale,
    splitIntoRows,
} from '../../web/src/core/visualizers/lyricRows.js';
import { hexToRgb, rgbToHsl } from '../../web/src/utils/colorUtils.js';

/** @param {string} s */
function graphemes(s) {
    return Array.from(s, char => ({ char, start: 0, end: 1 }));
}

test('L1 字重：全角/拉丁/空格/标点的宽度关系符合直觉', () => {
    assert.equal(graphemeWeight('字'), 1);
    assert.ok(graphemeWeight('a') < 0.7);
    assert.ok(graphemeWeight(' ') < graphemeWeight('a'));
    assert.ok(graphemeWeight('，') < 0.5);
    assert.ok(graphemeWeight('😀') > 1);
});

test('L2 行数：短句一行，长句 2~4 行，永不返回 0 行', () => {
    assert.equal(rowCountFor(0), 1);
    assert.equal(rowCountFor(12), 1);
    assert.equal(rowCountFor(30), 2);
    assert.equal(rowCountFor(60), 3);
    assert.equal(rowCountFor(200), 4);
    assert.equal(splitIntoRows([]).length, 0);
});

test('L3 拆行：覆盖完整、无空洞、每行非空', () => {
    const src = '风把旧信吹到了街角我把名字写进雨里等一盏灯亮起来再慢慢走回家';
    const g = graphemes(src);
    const rows = splitIntoRows(g);
    assert.ok(rows.length >= 2 && rows.length <= 4);
    assert.equal(rows[0].start, 0);
    assert.equal(rows[rows.length - 1].end, g.length);
    for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i].start, rows[i - 1].end, '行与行之间不能漏字');
    }
    for (const r of rows) {
        assert.ok(r.end > r.start, '不能出现空行');
    }
});

test('L4 拉丁词不在词中间拆断', () => {
    const src = 'we were dancing in the pouring rain and the city lights were calling out our names again';
    const g = graphemes(src);
    const rows = splitIntoRows(g);
    for (let i = 1; i < rows.length; i++) {
        const prev = g[rows[i].start - 1].char;
        const next = g[rows[i].start].char;
        const brokeWord = /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next);
        assert.equal(brokeWord, false, `在 "${prev}${next}" 中间断词了`);
    }
});

test('L5 多行缩放：最宽的一行决定字号，下限 0.42', () => {
    assert.equal(rowFitScale([300, 400], 800), 1);
    assert.equal(rowFitScale([800, 400], 400), 0.5);
    assert.equal(rowFitScale([5000], 500), 0.42);
    assert.equal(rowFitScale([], 500), 1);
});

test('L6 情感词：中文短语与英文词按字素落色', () => {
    const g = graphemes('我爱你 love 你');
    const colors = emotionColorsForGraphemes(g, [
        { word: '爱', color: '#003366' },
        { word: 'love', color: '#22aa88' },
    ]);
    assert.equal(colors.length, g.length);
    assert.ok(colors[1], '「爱」必须着色');
    const love = ['l', 'o', 'v', 'e'];
    const start = 4;
    love.forEach((ch, i) => {
        assert.equal(g[start + i].char, ch);
        assert.ok(colors[start + i], `love 的 ${ch} 必须着色`);
    });
    assert.equal(colors[0], null);
    assert.equal(colors[3], null);
    assert.equal(colors[9], null);
});

test('L7 情感词：英文词有边界，Glover 里的 love 不着色', () => {
    const g = graphemes('Glover and love');
    const colors = emotionColorsForGraphemes(g, [{ word: 'love', color: '#ff0000' }]);
    for (let i = 0; i < 6; i++) assert.equal(colors[i], null, 'Glover 不能被 love 命中');
    const idx = 'Glover and love'.lastIndexOf('love');
    for (let i = idx; i < idx + 4; i++) assert.ok(colors[i], '独立的 love 必须命中');
});

test('L8 暗底提亮：保色相、过暗色被抬到可读亮度，亮色原样返回', () => {
    const lifted = ensureReadableOnDark('#003366');
    const rgb = hexToRgb(lifted);
    assert.ok(rgb, '必须仍是十六进制');
    const [, , l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    assert.ok(l >= 0.68 - 0.01, `提亮后亮度应 >= 0.68，实际 ${l}`);

    assert.equal(ensureReadableOnDark('#ffffff'), '#ffffff');
    assert.equal(ensureReadableOnDark('rgb(1,2,3)'), 'rgb(1,2,3)', '非 #rrggbb 原样返回');
});

test('L9 clamp01：有限值钳制在 [0, 1]，非有限数归零', () => {
    assert.equal(clamp01(-0.5), 0);
    assert.equal(clamp01(0.42), 0.42);
    assert.equal(clamp01(2.5), 1);
    assert.equal(clamp01(NaN), 0);
    assert.equal(clamp01(Infinity), 0);
});

test('L10 normalizeLine & buildGraphemes：推导结束时间并拆解字素时间线', () => {
    const line = normalizeLine({ text: '风吹', startTime: 1000 }, { startTime: 2200 });
    assert.equal(line.text, '风吹');
    assert.equal(line.start, 1000);
    assert.equal(line.end, 2120);

    const gs = buildGraphemes({
        fullText: '风吹',
        startTime: 1000,
        endTime: 2000,
        words: [
            { text: '风', startTime: 1000, endTime: 1400 },
            { text: '吹', startTime: 1400, endTime: 2000 },
        ],
    });
    assert.equal(gs.length, 2);
    assert.equal(gs[0].char, '风');
    assert.equal(gs[1].char, '吹');
    assert.ok(gs[0].start <= gs[0].end && gs[1].start >= gs[0].start);
});
