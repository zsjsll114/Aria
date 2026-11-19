/* ============================================================
 * tests/js/test_instrumental_lines.js — 「纯音乐 ⇒ 虚拟 ♪ 行」共享逻辑
 *
 * 上游出处（两个 visualizer 的这段逐字相同，只差 id 前缀）：
 *   - `songHandover.ts` 的 `decideSongCommit` + `useVisualizerSongCommit({readyGraceMs:3000})`
 *     —— 空歌词在"还在加载"与"纯音乐"之间**只能靠播放区分**；
 *   - `VisualizerSonnet.tsx:89-107`（`virtual-staff-`）/ `VisualizerTempera.tsx:87-101`
 *     （`virtual-block-`）—— 纯音乐时喂 60 条虚拟 `♪` 行（每 8s 一条、长 6s）。
 * 本仓此前两个模式都是「空 lyrics → 空 program → 全黑空白」，见 instrumentalLines.js。
 *
 * ⚠ IL3 专测上游那个坑：父级在"加载中/无歌词"时**每次渲染都给一个新的 `[]`**，
 *   判定若按"歌词数组引用变化"重置观察窗就永远等不到确认（上游为此专门写了
 *   getLyricsSignature，见 songHandover.ts:52-58）。本实现按**歌**重置，结构上免疫。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	INSTRUMENTAL_GRACE_SEC, buildVirtualInstrumentalLines, advanceInstrumental, isSonnetStaffSegment,
} from '../../web/src/core/visualizers/instrumentalLines.js';

const IDLE = { instrumental: false, watch: null };

test('IL1 虚拟 ♪ 行与上游同参，且 id 前缀两模式各自对齐（staff / block）', () => {
	for (const [prefix, count] of [['virtual-staff-', 60], ['virtual-block-', 60]]) {
		const lines = buildVirtualInstrumentalLines(prefix);
		assert.equal(lines.length, count);
		assert.equal(lines[0].id, `${prefix}0`);
		assert.equal(lines[count - 1].id, `${prefix}${count - 1}`, '上游 sonnet=virtual-staff / tempera=virtual-block');
		for (const line of lines) {
			assert.equal(line.original, '♪', 'sonnet 的谱面分支判定条件就是 segment.text === "♪"');
			assert.deepEqual(line.words, [], '上游虚拟行就是 words: []');
			assert.equal(line.isChorus, false);
		}
		assert.equal(lines[0].start, 0);
		assert.equal(lines[1].start, 8000, '毫秒口径（Aria 歌词契约）');
		assert.equal(lines[1].end - lines[1].start, 6000, '每条 6s 长');
	}
});

test('IL2 Aria 行契约：毫秒 + original + 空 words（两个模式的归一化前提）', () => {
	const lines = buildVirtualInstrumentalLines('virtual-staff-');
	/* sonnetProgram.normalizeTimeUnit / temperaMode.normalizeTemperaLines 都是
	   「任一行 start ≥ 1000 ⇒ 整体 ÷1000」的启发式，前提是 start/end 同时在毫秒制。 */
	assert.ok(lines.some(l => l.start >= 1000), '必须命中毫秒启发式，否则 478s 会被当成 478000s');
	assert.equal(lines[59].end, 59 * 8000 + 6000, '60 条覆盖到 478s（上游同样固定 60 条，与歌长无关）');
	const seconds = lines.map(l => ({ start: l.start / 1000, end: l.end / 1000 }));
	assert.equal(seconds[59].end, 478);
});

test('IL3 判定状态机：播放推进 3s 才确认纯音乐；有词即复位', () => {
	const key = 'track-a';
	let state = advanceInstrumental(IDLE, { hasWords: false, timeSec: 0, songKey: key });
	assert.equal(state.instrumental, false, '刚播 0s：还可能是"歌词加载中"');
	assert.equal(state.watch.sinceSec, 0);

	state = advanceInstrumental(state, { hasWords: false, timeSec: 2.9, songKey: key });
	assert.equal(state.instrumental, false, '2.9s < 上游 readyGraceMs(3000)');

	state = advanceInstrumental(state, { hasWords: false, timeSec: 3.0, songKey: key });
	assert.equal(state.instrumental, true, '播放确认后仍无词 ⇒ 纯音乐');
	assert.equal(INSTRUMENTAL_GRACE_SEC, 3);

	state = advanceInstrumental(state, { hasWords: true, timeSec: 4, songKey: key });
	assert.equal(state.instrumental, false);
	assert.equal(state.watch, null, '歌词到了必须复位观察窗');
});

test('IL4 上游那个坑：空歌词每帧换新数组也不得重置观察窗', () => {
	const key = 'track-a';
	let state = IDLE;
	/* 逐帧喂「空歌词」——本函数不消费数组身份，只消费 hasWords ⇒ 结构上免疫 */
	for (let frame = 0; frame <= 30; frame += 1) {
		state = advanceInstrumental(state, { hasWords: false, timeSec: frame * 0.1, songKey: key });
	}
	assert.equal(state.watch.sinceSec, 0, '观察窗起点必须钉在第一次观察到「无词」的那一刻');
	assert.equal(state.instrumental, true, '3s 后必须已确认（按引用重置就会永远触发不了）');
});

test('IL5 暂停时「播放没推进」不许确认（上游：只有播放能区分加载中与纯音乐）', () => {
	const key = 'track-a';
	let state = advanceInstrumental(IDLE, { hasWords: false, timeSec: 5, songKey: key });
	for (let i = 0; i < 100; i += 1) {
		state = advanceInstrumental(state, { hasWords: false, timeSec: 5, songKey: key });
	}
	assert.equal(state.instrumental, false, 'timeSec 停在 5s（暂停）→ 不确认');
});

test('IL6 换歌重置：新歌是纯音乐也要重新等 3s', () => {
	let state = advanceInstrumental(IDLE, { hasWords: false, timeSec: 0, songKey: 'a' });
	state = advanceInstrumental(state, { hasWords: false, timeSec: 5, songKey: 'a' });
	assert.equal(state.instrumental, true);

	state = advanceInstrumental(state, { hasWords: false, timeSec: 5, songKey: 'b' });
	assert.equal(state.instrumental, false, '换歌（songKey 变）必须重新计时，不能继承上一首的结论');
	assert.equal(state.watch.songKey, 'b');

	state = advanceInstrumental(state, { hasWords: false, timeSec: 8, songKey: 'b' });
	assert.equal(state.instrumental, true);
});

test('IL7 谱面判定：默认只认 ♪（= 上游两处写死的字面量）；打开扩展才收间奏标记', () => {
	/* ★ 默认档必须与上游逐字一致：上游 sonnetTextViewBuilder.ts:198 与
	   sonnetSceneBuilder.ts:236 都写死 `segment.text === '♪'`。 */
	assert.equal(isSonnetStaffSegment('♪'), true);
	for (const text of ['MUSIC', 'MUSIC-', '♪♪', '…', '...', '···', '間奏', '', 'あの日', 'music']) {
		assert.equal(isSonnetStaffSegment(text), false,
			`默认档不该把 ${JSON.stringify(text)} 当谱面（那会与上游行为不一致）`);
	}

	/* 打开扩展（面板「间奏标记也走谱面」） */
	const on = (t) => isSonnetStaffSegment(t, true);
	assert.equal(on('♪'), true, '扩展模式下 ♪ 依然成立');
	for (const text of ['MUSIC', 'MUSIC-', 'MUSIC♪', '♪ MUSIC ♪', 'music', 'Instrumental',
		'間奏', '间奏', '…', '...', '···', '♪♪', '——']) {
		assert.equal(on(text), true, `${JSON.stringify(text)} 应识别为间奏标记`);
	}
	/* 不能误伤真歌词 */
	for (const text of ['MUSIC BOX を開けて', 'あの日のメロディー', '间奏曲', '♪ 好きだよ', 'ka-', '']) {
		assert.equal(on(text), false, `${JSON.stringify(text)} 是真歌词，不该变谱面`);
	}
	assert.equal(isSonnetStaffSegment(undefined), false, '非字符串一律 false（不抛）');
	assert.equal(isSonnetStaffSegment(undefined, true), false);
});
