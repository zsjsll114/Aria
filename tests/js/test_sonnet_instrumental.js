/* ============================================================
 * tests/js/test_sonnet_instrumental.js — 纯音乐（无歌词）⇒ 虚拟 ♪ 谱面分镜
 *
 * 背景（2026-10-11 用户："folia 在长的句子间隔之间会新建一个分镜、依次显示几个点"，
 * 后确认是在 folia 的实机宣传视频里看到的）：那不是省略号，是 folia 的 **La Folia 五线谱**
 * —— `♪` 行渲染成谱面，音符（椭圆点）随播放光标依次亮起并脉动。上游有两条入口：
 *
 *   ① 引擎侧：谱面动画**全部**挂在 `updateAnimation(time)` 上，而旧的内联逐字更新器
 *      从不调用它 → 那个镜头只画得出 5 条线、**一个音符都不出现**（`noteGraphics` 直到
 *      updateAnimation 才首次绘制）。本轮 sonnetShotFrame 移植后该调用已恢复，
 *      逐帧断言在 test_sonnet_shot_frame.js（SF 系列）。
 *   ② 宿主侧：`songHandover.decideSongCommit` + `VisualizerSonnet.tsx:89-107` ——
 *      **无歌词的歌自动生成 60 条虚拟 `♪` 行**（每 8s 一条、长 6s），整首都是谱面分镜。
 *      本仓此前 `setLyrics([])` → 0 段落 → **全黑空白**。本文件钉的是这条。
 *
 * ⚠ 判定状态机与"上游那个坑"（父级在无歌词时每帧都给一个新的 `[]`）的测试在
 *   `test_instrumental_lines.js` —— 那是 verse / tempera 共用的纯逻辑
 *   （`core/visualizers/instrumentalLines.js`）。本文件只钉 verse 这一段端到端。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* 先装最小 DOM 桩再动态 import（编译链可能经排版/pretext 触到 canvas 量字宽） */
const stubCtx = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
globalThis.document = {
	createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
	fonts: { load: async () => [], ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
	addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;

const {
	buildSonnetVirtualStaffLines, advanceSonnetInstrumental, SONNET_INSTRUMENTAL_GRACE_SEC,
} = await import('../../web/src/core/visualizers/sonnet/sonnetMode.js');
const { compileSonnetProgram } = await import('../../web/src/core/visualizers/sonnet/sonnetProgram.js');

const IDLE = { instrumental: false, watch: null };

test('VI1 虚拟 ♪ 行与上游同参：60 条 / 每 8s 一条 / 长 6s / 文本恰为 ♪', () => {
	const lines = buildSonnetVirtualStaffLines();
	assert.equal(lines.length, 60);
	assert.equal(lines[59].id, 'virtual-staff-59');
	for (const line of lines) {
		assert.equal(line.original, '♪', '谱面分支的判定条件是 segment.text === "♪"');
		assert.deepEqual(line.words, [], '上游虚拟行就是 words: []');
	}
	assert.equal(lines[0].start, 0);
	assert.equal(lines[1].start, 8000, '毫秒口径（Aria 歌词契约）');
	assert.equal(lines[1].end - lines[1].start, 6000, '每条 6s 长');
});

test('VI2 端到端：虚拟 ♪ 行编译出「谱面分镜」，且每镜恰好一张谱', () => {
	const program = compileSonnetProgram(buildSonnetVirtualStaffLines(), 'instrumental-seed');
	assert.ok(program.paragraphs.length > 0, '0 段落就是全黑空白（本仓此前的状态）');

	let staffSegments = 0;
	let paragraphsWithStaff = 0;
	let maxStaffPerShot = 0;
	for (const paragraph of program.paragraphs) {
		let has = false;
		for (const shot of paragraph.shots) {
			let inShot = 0;
			for (const lineIndex of shot.lineIndices) {
				const line = paragraph.lines[lineIndex];
				assert.ok(line.renderEndTime < 1000, '时间单位必须已归一为秒（毫秒不归一会让镜头全挤在第一秒）');
				for (const segment of line.segments) {
					if (segment.text !== '♪') continue;
					inShot += 1;
					staffSegments += 1;
					has = true;
				}
			}
			maxStaffPerShot = Math.max(maxStaffPerShot, inShot);
		}
		if (has) paragraphsWithStaff += 1;
	}
	assert.equal(staffSegments, 60, '60 条 ♪ 各自成段（谱面分支 textViewBuilder 才会命中）');
	assert.equal(paragraphsWithStaff, program.paragraphs.length, '每个段落都应有谱面');
	assert.equal(maxStaffPerShot, 1,
		'8s 间距下每镜只落一行 ♪；多行共镜时靠 SonnetEngine 的 staffViewAdded 去重（否则叠画多张谱）');

	/* 「长间隔处新建一个分镜」的上游语义：♪ 段无词 ⇒ 段类型 breath ⇒ 首镜安静定格（quiet-tableau） */
	const quiet = program.paragraphs.some(p => p.kind === 'breath' && p.shots[0]?.kind === 'quiet-tableau');
	assert.ok(quiet, '纯器乐段应判为 breath 且首镜是 quiet-tableau（整幅谱面、不抢镜）');
});

test('VI3 verse 侧出口仍接在共享实现上（tempera 用同一套，见 test_instrumental_lines.js）', () => {
	const state = advanceSonnetInstrumental(IDLE, { hasWords: false, timeSec: 0, songKey: 'track-a' });
	assert.equal(state.watch.sinceSec, 0, '状态机是 instrumentalLines.advanceInstrumental 的同一函数');
	assert.equal(SONNET_INSTRUMENTAL_GRACE_SEC, 3);
	const lines = buildSonnetVirtualStaffLines(2, 8, 6);
	assert.equal(lines.length, 2);
	assert.equal(lines[1].id, 'virtual-staff-1', 'verse 的 id 前缀必须是上游的 virtual-staff-');
	assert.equal(lines[1].start, 8000);
});
