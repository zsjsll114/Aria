/* ============================================================
 * tests/js/test_sonnet_credits_layer.js — 片尾「歌曲信息分镜」回归防线
 *
 * 背景（2026-10-11 用户："最后还没有歌曲信息分镜"）：
 * 海报能建出来、时间线也对，**但它是场景容器的子节点**，而片尾帧会做
 * `scene.container.alpha *= creditsFrame.lyricAlpha`（lyricAlpha 在歌词淡尽后收到 **0**）
 * —— 父节点 alpha 0 ⇒ 海报再亮也乘成 0，永远看不见。上游把 creditsContainer 与
 * sceneContainer **并列**加在 stage 上（createSonnetPixiRuntime.ts:153-157），所以上游没这问题。
 *
 * 为什么 CL1 是**读源码**的结构断言：这个不变量是「拓扑」事实（海报在不在场景子树里），
 * Node 里没法实例化 Pixi 去验；而它一旦被改回去，表现是**静默的**（画面少一层，无报错）。
 * 本仓 tests/js 已有 15 个文件用同法做结构守卫（见 test_settings_contract.js 等）。
 * 另：海报构建历史上被 try/catch 吞过（后面还紧跟 `_lastError = null`），所以 CL3 用
 * stub pixi 真建一次，并锚住「失败要留痕（_creditsError）」这条。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENGINE_SRC = readFileSync(
	fileURLToPath(new URL('../../web/src/core/visualizers/sonnet/SonnetEngine.js', import.meta.url)),
	'utf8',
);

/* ---- 最小 DOM 桩 + pixi stub（sonnetCredits 经 fontStacks 可能触到 DOM）---- */
const stubCtx = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
globalThis.document = {
	createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx, style: {} }),
	fonts: { load: async () => [], ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
	addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;

const vec = () => ({ x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } });
const pixiStub = {
	Container: class {
		constructor() { this.children = []; this.pivot = vec(); this.position = vec(); this.scale = vec(); }
		addChild(...c) { this.children.push(...c); }
	},
	Text: class { constructor(o) { Object.assign(this, o); this.anchor = vec(); this.position = vec(); this.scale = vec(); } },
	TextStyle: class { constructor(o) { Object.assign(this, o); } },
	Graphics: class {
		rect() { return this; } roundRect() { return this; } circle() { return this; } ellipse() { return this; }
		fill() { return this; } moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
	},
	Color: { shared: { setValue: () => ({ toNumber: () => 0xffffff }) } },
};
const { buildSonnetCreditsPoster, hasSonnetCreditsMetadata, resolveSonnetCreditsFrame } =
	await import('../../web/src/core/visualizers/sonnet/sonnetCredits.js');

/** 去掉注释再搜（否则说明文字里的 "scene.creditsContainer" 会让断言误判） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('CL1 ★ 海报必须挂在场景**之外**（否则被片尾的 lyricAlpha=0 连坐成透明）', () => {
	const code = stripComments(ENGINE_SRC);

	assert.match(code, /this\.app\.stage\.addChild\(this\.sceneRoot,\s*this\.creditsLayer/,
		'creditsLayer 必须与 sceneRoot **并列**加在 stage 上（上游 153-157 的拓扑）');
	/* 画框角标层同理，且在海报之上（上游 addChild 顺序：scene → credits → overlay） */
	assert.match(code, /this\.app\.stage\.addChild\(this\.sceneRoot,\s*this\.creditsLayer,\s*this\.overlayLayer\)/,
		'overlayLayer 也必须在 stage 层、排在 creditsLayer 之后');
	assert.doesNotMatch(code, /scene\.creditsContainer/,
		'禁止把海报挂回场景容器：scene.container.alpha *= lyricAlpha 会把它一起乘成 0');
	assert.doesNotMatch(code, /container\.addChild\(creditsContainer\)/);

	/* 歌词淡出只能乘在**场景**上 */
	assert.match(code, /scene\.container\.alpha \*= creditsFrame\.lyricAlpha/, '歌词淡出作用在场景');
	assert.doesNotMatch(code, /creditsLayer\.alpha \*= /, '海报层自己的 alpha 只能来自 posterAlpha');

	/* 海报失败不能再被静默（历史上 try/catch 后紧跟 _lastError = null，报障无处可查） */
	assert.match(code, /this\._creditsError = String\(/, '构建失败必须留痕到 _creditsError');
	assert.doesNotMatch(code, /this\._lastError = null/, '不再用「成功即清痕迹」的写法掩盖海报构建失败');
});

test('CL2 片尾时间线：末行结束后淡入海报；非末段传 +∞ ⇒ 永不激活', () => {
	const end = 260;
	assert.equal(resolveSonnetCreditsFrame(end - 0.1, end).active, false, '歌词没唱完不激活');
	assert.equal(resolveSonnetCreditsFrame(end - 0.1, end).posterAlpha, 0);

	const mid = resolveSonnetCreditsFrame(end + 1.5, end);
	assert.equal(mid.active, true);
	assert.ok(mid.lyricAlpha < 1 && mid.lyricBlur > 0, '歌词同时淡出并模糊');
	assert.ok(mid.posterAlpha > 0 && mid.posterAlpha < 1, '海报在淡入途中');

	const settled = resolveSonnetCreditsFrame(end + 5, end);
	assert.equal(settled.posterAlpha, 1, '约 2s 后海报完全就位');
	assert.equal(settled.lyricAlpha, 0, '此时歌词已淡尽 —— 这正是父节点 alpha 连坐的取值');
	assert.equal(settled.posterOffsetY, 0);
	assert.equal(settled.posterScale, 1);

	/* 引擎对非末段传 Number.POSITIVE_INFINITY（等价上游 finalParagraph?.endTime ?? Infinity） */
	const nonFinal = resolveSonnetCreditsFrame(999, Number.POSITIVE_INFINITY);
	assert.equal(nonFinal.active, false, '非末段必须永远不激活');
});

test('CL3 海报真的建得出来（stub pixi），且元数据两种键名都能进', () => {
	assert.equal(hasSonnetCreditsMetadata({ title: '桃花雪', artist: '穹虹' }), true, '在线链路 {title, artist}');
	assert.equal(hasSonnetCreditsMetadata({ song: '桃花雪', singer: '穹虹' }), false,
		'★ {song, singer} 本函数不认 —— 所以引擎侧必须先映射（_ensureCreditsLayer 的 meta.song || meta.title）');
	assert.equal(hasSonnetCreditsMetadata({}), false, '全空不建（不显示空海报）');

	const poster = buildSonnetCreditsPoster(
		pixiStub,
		{ primaryColor: '#f4f4f5', accentColor: '#E8BE6A', secondaryColor: '#4a4e57' },
		{ title: '桃花雪', artist: '穹虹', album: '' },
		1280, 720, 1,
	);
	assert.ok(poster.children.length > 0, '有元数据就必须至少建出标题（>0 子节点）');
	assert.equal(poster.pivot.x, 640, '海报自身锚屏幕中心（上游 drawCredits:229）');
	assert.equal(poster.pivot.y, 360);
});
