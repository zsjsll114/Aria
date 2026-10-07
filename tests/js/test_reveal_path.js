/**
 * test_reveal_path.js — 「打开文件所在位置」（需求补充）
 *
 * 这一条**只能在有桌面壳时才有意义**，所以单测要验的不是"能不能拉起资源管理器"
 * （那要真的 Windows），而是**没有壳时它必须安静地失败**：
 * 不能抛、不能卡、不能返回 true 骗调用方。
 * 有壳的那半边靠真机探针/人工验收，这里只钉住边界行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../web/src/core/revealPath.js');

test('无桌面壳（node / 浏览器）：一律安静失败，不抛', async () => {
	assert.equal(await mod.canReveal(), false);
	assert.equal(await mod.downloadsDir(), null);
	assert.equal(await mod.revealInExplorer('晴天 - 周杰伦 - 1x1.png'), false);
	/* offerReveal 在没有 showGlassConfirm 时也必须直接返回 false（不能弹、不能抛） */
	assert.equal(await mod.offerReveal('晴天 - 周杰伦 - 1x1.png'), false);
});

test('空文件名也不能出事', async () => {
	assert.equal(await mod.revealInExplorer(''), false);
	assert.equal(await mod.revealInExplorer(null), false);
	assert.equal(await mod.revealInExplorer(undefined), false);
});

test('导出面：三个能力都在', () => {
	assert.equal(typeof mod.canReveal, 'function');
	assert.equal(typeof mod.downloadsDir, 'function');
	assert.equal(typeof mod.revealInExplorer, 'function');
	assert.equal(typeof mod.offerReveal, 'function');
});
