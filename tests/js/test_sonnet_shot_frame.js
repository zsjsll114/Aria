/* ============================================================
 * tests/js/test_sonnet_shot_frame.js — verse（sonnet）逐帧姿态契约
 *
 * 背景（2026-10-11 用户报障"感觉还是不太对 / 粒子特效像没动"）：
 * 上游 `sonnetShotFrame.ts`（单镜头逐帧姿态：相机、间隙漂移、MG、引导线、开放画框、
 * 逐字入场·色差·残影）**没有被移植**，其职责被内联进 SonnetEngine._updateScene 且被
 * 简化——最要命的是"只写 visible 不写 transform"这一类**静默**偏差：结构、时长、控制台
 * 全都正常，画面上只表现为"粒子僵在原地 / 引导线从不出现 / 新字直接跳出"。
 *
 * 本文件钉住七件事（每条都对应一个被简化掉的可见行为）：
 *   SF1 粒子层真的在游动（视差 ×0.4 + 连续自转 + 深度缩放）——此前只切 visible
 *   SF2 固定几何保持正立（-container.rotation）
 *   SF3 引导线按窗口显隐 + 推进（showGuide/showOnlyText 门控）
 *   SF4 开放画框逐帧 update（showFixedGeo 门控）
 *   SF5 逐字入场基值 0.16（本仓曾自改成 0.45，理由是"交叉淡化下不可读"——而淡化早删了）
 *   SF6 色差是**斜向**分裂（cyan(-off,+off/2) / red(+off,-off/2)）
 *   SF7 行尾间隙继续漂移（长间隔不发木）+ 音频垫片真的喂到 MG
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* sonnetShotFrame → sonnetTypographyLayout → vendor/pretext：加载期可能要建离屏 canvas
   量字宽，所以先装最小 DOM 桩、再动态 import（静态 import 会被提升到桩之前执行）。 */
const stubCtx = { font: '', measureText: (t) => ({ width: String(t).length * 10 }) };
globalThis.document = {
	createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }),
	fonts: { load: async () => [], ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
	addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;

const { updateSonnetShot } = await import('../../web/src/core/visualizers/sonnet/sonnetShotFrame.js');
const { resolveShotMotionFrame, resolveShotProgress } = await import('../../web/src/core/visualizers/sonnet/sonnetMotion.js');

const W = 1280;
const H = 720;
const EPS = 1e-9;

/* ---- pixi 最小替身（只实现逐帧代码真正会碰到的成员）---- */
const vecNode = () => ({
	x: 0, y: 0,
	set(a, b) { this.x = a; this.y = b; },
	copyFrom(o) { this.x = o.x; this.y = o.y; },
});
const node = (over = {}) => ({
	visible: true, alpha: 1, rotation: 0, x: 0, y: 0,
	pivot: vecNode(), position: vecNode(), scale: vecNode(), ...over,
});
const spy = () => {
	const fn = (...args) => { fn.calls.push(args); };
	fn.calls = [];
	return fn;
};

const glyphOf = (startTime, settleTime, over = {}) => ({
	display: node(),
	halo: null,
	caWrapper: node(),
	caCyan: node(),
	caRed: node(),
	caOffset: 4,
	baseX: 100, baseY: 50, enterX: -30, enterY: 12, entryRotation: -0.035,
	finalRotation: 0, startTime, settleTime, zDepth: 0, isTextGlyph: true,
	...over,
});
const segmentOf = (glyphs, over = {}) => ({
	role: 'hero',
	guide: {
		container: node({ alpha: 0 }),
		startTime: 1, endTime: 2.5, maxAlpha: 0.6,
		update: spy(),
	},
	frameDecor: { container: node(), startTime: 1, endTime: 3, update: spy() },
	glyphs,
	trackingGlyphs: glyphs,
	...over,
});
const viewOf = (shot, segments) => {
	const mg = node({ updateTime: spy() });
	return {
		shot,
		segments,
		container: node(),
		baseX: 100, baseY: 50, basePivotX: 0, basePivotY: 0,
		mg,
		mgParticleLayer: mg.particleLayer = node(),
		mgFixedGeoLayer: mg.fixedGeoLayer = node(),
	};
};
const shotOf = () => ({
	id: 'shot-1', kind: 'editorial-column', startTime: 0, endTime: 4, cues: [],
	camera: { zoom: 1.1, rotation: 0.02, x: 0, y: 0 },
});
/* 上游 DEFAULT_SONNET_TUNING（folia types.ts:560-572）里 sonnetShotFrame 消费的那几个键。
   ★ cameraIntensity 必须给：缺了它就是 undefined → 相机矩阵整条被 NaN 污染。 */
const TUNING = {
	typographyMotion: 1, cameraIntensity: 1,
	showOnlyText: false, showGuide: true, showFixedGeo: true,
	showGiantDecorativeText: true, showBackgroundDecor: true,
};
const ctxOf = (levels = { bass: 0, power: 0, vocal: 0 }, over = {}) => ({
	tuning: TUNING,
	theme: {},
	audioBands: { bass: { get: () => levels.bass }, vocal: { get: () => levels.vocal } },
	audioPower: { get: () => levels.power },
	mod: () => 1,          /* 本仓无 Folium tunable：恒等（上游缺省 1） */
	...over,
});

test('SF1 粒子层真的在游动：视差 ×0.4 + 连续自转 + 深度缩放（此前只切 visible）', () => {
	const shot = shotOf();
	/* 字形起始时间放在采样点之后 ⇒ revealDoneTime > time ⇒ 呼吸权重恰为 0，
	   这样下面可以精确断言 motion 帧本身（否则呼吸也会加进 cameraFrame）。 */
	const segments = [segmentOf([glyphOf(5, 5.6)])];
	const view = viewOf(shot, segments);
	const time = 2;

	updateSonnetShot(view, time, W, H, 0, ctxOf());

	const frame = resolveShotMotionFrame(shot.kind, resolveShotProgress(shot, time));
	/* camera = cameraIntensity(1) × animationScale(1) × mod(1) = 1，shake = 0 */
	assert.ok(Math.abs(view.mgParticleLayer.position.x - frame.x * W * 0.4) < 1e-9,
		`粒子层视差应为 motion.x*width*0.4，实得 ${view.mgParticleLayer.position.x}`);
	assert.ok(Math.abs(view.mgParticleLayer.position.y - frame.y * H * 0.4) < 1e-9);
	/* 连续自转：与镜头路径无关，只跟「距 shot 起点多久」成正比的 0.05 rad/s */
	assert.ok(Math.abs(view.mgParticleLayer.rotation - (time - shot.startTime) * 0.05) < EPS,
		`粒子层自转应为 (t-start)*0.05，实得 ${view.mgParticleLayer.rotation}`);
	assert.ok(Math.abs(view.mgParticleLayer.scale.x - (1 + (frame.scale - 1) * 0.3)) < 1e-9,
		'粒子层深度缩放应为 1+(cameraScale-1)*0.3');
});

test('SF2 固定几何保持正立（-container.rotation），不被相机旋转带走', () => {
	const shot = shotOf();
	const view = viewOf(shot, [segmentOf([glyphOf(0.2, 0.9)])]);
	updateSonnetShot(view, 1.7, W, H, 0, ctxOf());
	assert.ok(Math.abs(view.container.rotation) > 0, '这个镜头在 1.7s 应已转起来（否则断言无效）');
	assert.equal(view.mgFixedGeoLayer.rotation, -view.container.rotation);
});

test('SF3 引导线：窗口内显隐 + 推进；showGuide / showOnlyText 门控', () => {
	const shot = shotOf();
	const seg = segmentOf([glyphOf(0.2, 0.9)]);
	const view = viewOf(shot, [seg]);

	updateSonnetShot(view, 1.5, W, H, 0, ctxOf());
	assert.equal(seg.guide.container.visible, true, '1.5s 落在 [1, 2.5] 窗口内');
	assert.equal(seg.guide.container.alpha, 0.6, '有 update() 时 alpha 直接取 maxAlpha');
	assert.equal(seg.guide.update.calls.length, 1, '每帧必须推进一次 —— 此前从不调用');
	assert.ok(Math.abs(seg.guide.update.calls[0][0] - 0.5 / 1.5) < 1e-9);

	updateSonnetShot(view, 3, W, H, 0, ctxOf());
	assert.equal(seg.guide.container.visible, false, '出窗口即隐藏');
	assert.equal(seg.guide.update.calls.length, 1, '出窗口不再推进');

	updateSonnetShot(view, 1.5, W, H, 0, ctxOf({ bass: 0, power: 0, vocal: 0 }, { tuning: { ...TUNING, showGuide: false } }));
	assert.equal(seg.guide.container.visible, false, 'showGuide=false 时引导线整类关掉');
	updateSonnetShot(view, 1.5, W, H, 0, ctxOf({ bass: 0, power: 0, vocal: 0 }, { tuning: { ...TUNING, showOnlyText: true } }));
	assert.equal(seg.guide.container.visible, false, '仅文字模式不画引导线');
});

test('SF4 开放画框逐帧 update，随 showFixedGeo 开关（此前从不调用）', () => {
	const shot = shotOf();
	const seg = segmentOf([glyphOf(0.2, 0.9)]);
	const view = viewOf(shot, [seg]);

	updateSonnetShot(view, 2, W, H, 0, ctxOf());
	assert.equal(seg.frameDecor.container.visible, true);
	assert.equal(seg.frameDecor.update.calls.length, 1);
	assert.ok(Math.abs(seg.frameDecor.update.calls[0][0] - 0.5) < 1e-9, '2s 落在 [1,3] → 进度 0.5');

	updateSonnetShot(view, 2, W, H, 0, ctxOf({ bass: 0, power: 0, vocal: 0 }, { tuning: { ...TUNING, showFixedGeo: false } }));
	assert.equal(seg.frameDecor.container.visible, false, '「文字浮标」关掉 → 开放画框一起关');
	assert.equal(seg.frameDecor.update.calls.length, 1, '不可见时不再推进');
});

test('SF5 逐字入场基值 = 0.16（本仓曾自改成 0.45），waiting 期为 0', () => {
	const shot = shotOf();
	const glyph = glyphOf(1, 2);
	const view = viewOf(shot, [segmentOf([glyph])]);

	updateSonnetShot(view, 0.5, W, H, 0, ctxOf());
	assert.equal(glyph.display.alpha, 0, '未到 startTime：alpha 必须为 0（不是"提前半亮"）');

	updateSonnetShot(view, 1, W, H, 0, ctxOf());
	assert.ok(Math.abs(glyph.display.alpha - 0.16) < EPS,
		`入场起点应为上游的 0.16，实得 ${glyph.display.alpha}`);

	updateSonnetShot(view, 3, W, H, 0, ctxOf());
	assert.ok(Math.abs(glyph.display.alpha - 1) < EPS, '就位后满不透明');
	/* zDepth=0：视差为 0，位置回到基准点 */
	assert.ok(Math.abs(glyph.display.position.x - glyph.baseX) < 1e-9);
	assert.ok(Math.abs(glyph.display.position.y - glyph.baseY) < 1e-9);
});

test('SF6 色差是斜向分裂（cyan(-off, +off/2) / red(+off, -off/2)）', () => {
	const shot = shotOf();
	const glyph = glyphOf(1, 2);
	const view = viewOf(shot, [segmentOf([glyph])]);

	updateSonnetShot(view, 1.5, W, H, 0, ctxOf());

	const cx = glyph.caCyan.position.x;
	const cy = glyph.caCyan.position.y;
	const rx = glyph.caRed.position.x;
	const ry = glyph.caRed.position.y;
	assert.ok(Math.abs(cx + rx) < EPS, 'x 必须镜像');
	assert.ok(Math.abs(cy + ry) < EPS, 'y 必须镜像');
	assert.ok(Math.abs(cy - (-cx) * 0.5) < 1e-9,
		`y 分量必须是 x 的一半且反向（斜向而非水平拖影），实得 cyan=(${cx}, ${cy})`);
	assert.ok(Math.abs(cx) > 1e-9 && Math.abs(cy) > 1e-9, '入场期不得收成 0');
	/* CA 层必须跟随 display 的变换（它挂在 shot 的共享 caLayer 上，不在 display 之下） */
	assert.equal(glyph.caWrapper.position.x, glyph.display.position.x);
	assert.equal(glyph.caWrapper.scale.x, glyph.display.scale.x);
});

test('SF7 行尾间隙继续漂移（长间隔不发木）+ 音频垫片真的喂到 MG', () => {
	const shot = shotOf();
	const view = viewOf(shot, [segmentOf([glyphOf(3.5, 3.9)])]);

	updateSonnetShot(view, shot.endTime, W, H, 0, ctxOf());
	const atEnd = view.container.x;
	updateSonnetShot(view, shot.endTime + 3, W, H, 0, ctxOf());
	const inGap = view.container.x;
	assert.notEqual(inGap, atEnd, '行唱完后镜头必须继续沿尾段方向漂移（gapTime 漂移）');

	/* MG 的 updateTime 收到的是**真实电平**（0~255），不是恒 0：
     上游签名 (time, cues, start, end, bass, power, vocal) */
	const view3 = viewOf(shot, [segmentOf([glyphOf(1, 2)])]);
	updateSonnetShot(view3, 1, W, H, 0, ctxOf({ bass: 42, power: 7, vocal: 13 }));
	const call = view3.mg.updateTime.calls.at(-1);
	assert.equal(call[4], 42, 'bass 应来自 audioBands.bass.get()');
	assert.equal(call[5], 7, 'power 应来自 audioPower.get()');
	assert.equal(call[6], 13, 'vocal 应来自 audioBands.vocal.get()');
});

test('SF8 缺件不抛：没有 MG / 没有 frameDecor / 没有 update 的引导线', () => {
	const shot = shotOf();
	const seg = segmentOf([glyphOf(1, 2)], {
		frameDecor: null,
		guide: { container: node({ alpha: 0 }), startTime: 1, endTime: 2.5, maxAlpha: 0.6 },
	});
	const view = viewOf(shot, [seg]);
	/* 真把四个 MG 平铺字段与 mg 束里的层都摘掉：走「本仓字段缺失」的兜底路径 */
	delete view.mgParticleLayer;
	delete view.mgFixedGeoLayer;
	delete view.mg.particleLayer;
	delete view.mg.fixedGeoLayer;
	delete view.mg.updateTime;

	assert.doesNotThrow(() => updateSonnetShot(view, 1.5, W, H, 0, ctxOf()));
	/* 无 update() 的引导线走 sin 包络分支（上游 else 分支）：
     alpha = sin(eased*π)*maxAlpha，scale = 0.76 + eased*0.24 */
	assert.ok(seg.guide.container.alpha > 0 && seg.guide.container.alpha <= 0.6);
	const eased = Math.asin(seg.guide.container.alpha / 0.6) / Math.PI;
	assert.ok(Math.abs(seg.guide.container.scale.x - (0.76 + eased * 0.24)) < 1e-9);
});

test('SF9 连续平滑运镜与追踪：不被 pivotClamp / 屏边距硬墙锁死或跳变（2026-11-20 修复）', () => {
	const shot = {
		id: 'shot-ribbon', kind: 'tracking-ribbon', startTime: 0, endTime: 4, cues: [],
		camera: { zoom: 1.25, rotation: 0.01, x: 0.02, y: 0.01 },
	};
	const g1 = glyphOf(0.2, 0.8, { baseX: -520, baseY: 0 });
	const g2 = glyphOf(1.6, 2.2, { baseX: 0, baseY: 0 });
	const g3 = glyphOf(3.0, 3.6, { baseX: 520, baseY: 0 });
	const view = viewOf(shot, [segmentOf([g1, g2, g3])]);
	/* 即便上游对象残留 contentBounds / pivotClamp 字段，逐帧姿态也不得被硬墙锁死或跳变 */
	view.contentBounds = { minX: -620, maxX: 620, minY: -80, maxY: 80 };
	view.pivotClamp = { fxMin: 0, fxMax: 0, fyMin: -10, fyMax: 10 };

	let prevX = null;
	let maxStepDx = 0;
	const pivots = [];
	const xs = [];
	for (let k = 0; k <= 100; k++) {
		const t = (4 * k) / 100;
		updateSonnetShot(view, t, W, H, 0, ctxOf());
		if (prevX !== null) maxStepDx = Math.max(maxStepDx, Math.abs(view.container.x - prevX));
		prevX = view.container.x;
		pivots.push(view.container.pivot.x);
		xs.push(view.container.x);
	}
	assert.ok(Math.max(...xs) - Math.min(...xs) > 120,
		`tracking-ribbon 水平扫镜幅度应完整保留，实得 span=${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}`);
	assert.ok(Math.max(...pivots) - Math.min(...pivots) > 200,
		`逐词水平焦点追踪不得被锁死，实得 pivotSpan=${(Math.max(...pivots) - Math.min(...pivots)).toFixed(1)}`);
	assert.ok(maxStepDx < 8,
		`单步相机位移不得因硬墙夹紧发生跳变，实得 maxStepDx=${maxStepDx.toFixed(2)}`);
});
