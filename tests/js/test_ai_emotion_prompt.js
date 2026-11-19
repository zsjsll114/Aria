/* ============================================================
 * tests/js/test_ai_emotion_prompt.js — AI 情感词配色提示词约束单测
 *
 * 用户投诉「AI 生成的情感词颜色全都很丑、不高级、太同质化」。
 * 旧提示词颜色约束只有一句「悲伤→冷蓝/热情→暖红/希望→黄绿」，
 * 无任何饱和度/亮度/色相间隔数值约束，示例 #FF6B6B 本身是高饱和荧光色。
 * 这里钉住两条提示词路径（buildEmotionSystemPrompt + buildSystemPrompt）
 * 都带上高级感色板约束，且移除荧光示例。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = fs.readFileSync(path.join(REPO, 'web/src/core/aiAnalyzer.js'), 'utf8');

test('PR1 饱和度上限约束（S≤0.75，去荧光）两条路径都有', () => {
    const hits = SRC.split('饱和度不超过 75%').length - 1;
    assert.ok(hits >= 2, '两条提示词路径都要带饱和度约束，实际: ' + hits);
});

test('PR2 亮度可读带约束（52%~80%）两条路径都有', () => {
    const hits = SRC.split('52%~80%').length - 1;
    assert.ok(hits >= 2, '缺亮度可读带约束，实际: ' + hits);
});

test('PR3 色相间隔约束（≥28°，去同质化）两条路径都有', () => {
    const hits = SRC.split('色相两两间隔至少 28°').length - 1;
    assert.ok(hits >= 2, '缺色相间隔约束，实际: ' + hits);
});

test('PR4 以 primary_color 为锚派生整组色板（色彩叙事）', () => {
    assert.ok(SRC.includes('以 primary_color 为锚'), '缺整组色板协调约束');
});

test('PR5 移除荧光示例 #FF6B6B，换低饱和高级感示例', () => {
    assert.ok(!SRC.includes('#FF6B6B'), '荧光示例仍在诱导同质化');
    assert.ok(SRC.includes('#8FA8B8'), '缺低饱和高级感示例');
});

test('PR6 归一化机制接进摄入链路（清洗步 + 流式路径，非死代码）', () => {
    const ai = fs.readFileSync(path.join(REPO, 'web/src/services/aiAnalyzer.js'), 'utf8');
    assert.ok(ai.includes("import { normalizeEmotionColor } from '../utils/colorUtils.js'"), 'services/aiAnalyzer 没 import 归一化');
    assert.ok(ai.includes('color: normalizeEmotionColor(ew.color)'), '清洗步没归一化情感词色');
    assert.ok(ai.includes("normalizeEmotionColor((w && w.color) || '#ff2a6d')"), '流式路径没归一化');
});