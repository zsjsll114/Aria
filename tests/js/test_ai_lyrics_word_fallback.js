/* ============================================================
 * tests/js/test_ai_lyrics_word_fallback.js — AI 侧不得把合成逐字当真实节拍
 *
 * 背景：renderLyrics 现在会给只有行级时间戳的歌词兜底合成 words
 * （parsers/wordTiming.js）。渲染侧要它，但 aiAnalyzer 的
 * getLyricsTextForAI() 拿 words 跨度算 duration，再用 duration 打
 * ★/◆ 高潮权重喂给 LLM —— 合成出来的节拍是按行摊平的假数据，
 * 且被 maxLineMs 截断过，喂进去等于让 AI 信一套编造的节奏。
 * 判真值的地方一律走 realWordsOf / hasRealWordTiming。
 * ============================================================ */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/* i18n 在模块求值期读 localStorage，Node 下会经 logCatch 打一条噪声；
   补个哑实现，保证测试输出干净。 */
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { state } = await import('../../web/src/infrastructure/state.js');
const { getLyricsTextForAI } = await import('../../web/src/core/aiAnalyzer.js');
const { ensureWordTiming, SYNTHESIZED } = await import('../../web/src/parsers/wordTiming.js');

before(() => {
    state.fullChorusSegments = [];
    state.currentChorusSegments = [];
});

test('全合成逐字：AI 文本走行格式，不得出现按摊平节拍算出的 [Nms]', () => {
    state.lyrics = ensureWordTiming([
        { start: 0, end: 20000, text: '甲乙丙', original: '甲乙丙' },
        { start: 20000, end: 24000, text: '丁', original: '丁' },
    ]);
    assert.equal(state.lyrics[0].wordTiming, SYNTHESIZED, '前提：这份是被合成过的');
    const out = getLyricsTextForAI();
    assert.ok(!/\[\d+ms\]/.test(out), `合成节拍不该喂给 AI，实际输出: ${out}`);
    assert.ok(out.includes('甲乙丙'), '歌词文本本身不能丢');
});

test('真实逐字：仍按词跨度给出 [Nms]（不被护栏误伤）', () => {
    state.lyrics = [
        { start: 0, end: 1000, text: '你好', original: '你好',
          words: [{ text: '你', start: 0, end: 300 }, { text: '好', start: 300, end: 800 }] },
        { start: 1000, end: 2000, text: '世界', original: '世界',
          words: [{ text: '世', start: 1000, end: 1100 }, { text: '界', start: 1100, end: 1500 }] },
    ];
    const out = getLyricsTextForAI();
    assert.ok(out.includes('[800ms]'), `真实词跨度应出现，实际: ${out}`);
});

test('混合：真实行走词跨度，合成行不编造 duration', () => {
    state.lyrics = ensureWordTiming([
        { start: 0, end: 1000, text: '你好', original: '你好',
          words: [{ text: '你', start: 0, end: 300 }, { text: '好', start: 300, end: 800 }] },
        { start: 1000, end: 20000, text: '丙丁戊', original: '丙丁戊' },
    ]);
    const out = getLyricsTextForAI();
    assert.ok(out.includes('[800ms]'), '真实行应保留词跨度时长');
    assert.ok(!out.includes('[10000ms]'), '合成行不得出现被截断的摊平时长');
});
