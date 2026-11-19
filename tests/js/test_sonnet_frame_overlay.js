/* ============================================================
 * tests/js/test_sonnet_frame_overlay.js — 画框角标层（屏幕坐标系静态层）
 *
 * 上游 `sonnetFrameOverlay.ts`（本仓 2026-10-11 补移植）：不对称角标（左上粗横条 +
 * 下垂线、右下粗竖条 + 横线 + 上升线）+ 右上十字 + 左下菱形 + 右下 ✦，
 * 随 `outerFrameMode !== 'none'` 与「仅文字」开关显隐。它是**屏幕坐标系**的静态层
 * （挂在 stage 上与场景容器并列），所以不随运镜/转场移动。
 *
 * 这个文件钉三件事：
 *   FO1 正常档画得出（Graphics + ✦ 两个子节点），且用主题主色；
 *   FO2 `showOnlyText` / `outerFrameMode: 'none'` 两个门控都真的关掉它；
 *   FO3 重画前必须清旧层（否则每帧重画会叠出无穷多个画框）。
 * 它一旦抛异常会带走整帧（排在 _updateScene 之前），所以引擎侧就地兜住并留 `_overlayError`。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawSonnetFrameOverlay } from '../../web/src/core/visualizers/sonnet/sonnetFrameOverlay.js';

const vec = () => ({ x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } });
const colorCalls = [];
const makeStub = (pixiCallLog) => {
    class Container {
        constructor() { this.children = []; this.pivot = vec(); this.position = vec(); this.scale = vec(); }
        addChild(...c) { this.children.push(...c); }
        removeChildren() { const out = this.children; this.children = []; return out; }
    }
    class Graphics {
        constructor() { pixiCallLog.push(['graphics']); }
        rect() { return this; } fill(o) { pixiCallLog.push(['fill', o]); return this; }
        moveTo() { return this; } lineTo() { return this; } stroke(o) { pixiCallLog.push(['stroke', o]); return this; }
        destroy() { this.destroyed = true; }
    }
    class TextStyle { constructor(o) { Object.assign(this, o); } }
    class Text {
        constructor(o) { Object.assign(this, o); this.anchor = vec(); this.position = vec(); }
        destroy() { this.destroyed = true; }
    }
    return {
        Container, Graphics, TextStyle, Text,
        Color: { shared: { setValue: (v) => { colorCalls.push(v); return { toNumber: () => 0xabcdef }; } } },
    };
};

const TUNING = { showOnlyText: false, outerFrameMode: 'full' };
const THEME = { primaryColor: '#f4f4f5' };

test('FO1 正常档：画出 Graphics + ✦ 两个子节点，用主题主色', () => {
	colorCalls.length = 0;
	const log = [];
	const pixi = makeStub(log);
	const container = new pixi.Container();

	drawSonnetFrameOverlay(pixi, container, 1280, 720, TUNING, THEME);

	assert.equal(container.children.length, 2, '一个 Graphics（角标/十字/菱形）+ 一个 ✦ 文本');
	assert.equal(container.children[0] instanceof pixi.Graphics, true);
	assert.equal(container.children[1].text, '✦');
	assert.equal(container.children[1].anchor.x, 1, '✦ 以右中为锚点（上游 anchor.set(1, 0.5)）');
	assert.ok(container.children[1].position.x < 1280 - 60, '✦ 落在右下角内（padding 内缩）');
	assert.ok(colorCalls.includes('#f4f4f5'), '颜色取 theme.primaryColor');
	assert.ok(log.some(([k]) => k === 'fill'), '至少有一次填充（角标）');
});

test('FO2 两个门控：showOnlyText / outerFrameMode = none 都不画', () => {
	const pixi = makeStub([]);

	const a = new pixi.Container();
	drawSonnetFrameOverlay(pixi, a, 1280, 720, { ...TUNING, showOnlyText: true }, THEME);
	assert.equal(a.children.length, 0, '仅文字模式不画任何画框');

	const b = new pixi.Container();
	drawSonnetFrameOverlay(pixi, b, 1280, 720, { ...TUNING, outerFrameMode: 'none' }, THEME);
	assert.equal(b.children.length, 0, 'outerFrameMode: none 关掉整层');

	/* 上游只区分 none / 非 none（'frame' 与 'full' 画的是同一套），照抄 */
	const c = new pixi.Container();
	drawSonnetFrameOverlay(pixi, c, 1280, 720, { ...TUNING, outerFrameMode: 'frame' }, THEME);
	assert.equal(c.children.length, 2, 'frame 档与 full 档同为这一套（上游如此）');
});

test('FO3 重画前清旧层：连画三次仍是 2 个子节点（不叠画框）', () => {
	const pixi = makeStub([]);
	const container = new pixi.Container();
	for (let i = 0; i < 3; i += 1) {
		drawSonnetFrameOverlay(pixi, container, 1280, 720, TUNING, THEME);
	}
	assert.equal(container.children.length, 2, '旧层必须被 removeChildren + destroy 清掉');
});
