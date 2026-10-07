import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mod = await import('../../web/src/core/domSnapshot.js');
const {
	INLINE_PROPS, TRANSPARENT_PIXEL,
	cssTextFromComputed, svgShell,
	registerCanvasSnapshot, snapshotCanvas,
} = mod;

/** 造一个 getComputedStyle 的桩 */
function stubComputed(map) {
	return { getPropertyValue: (p) => (p in map ? map[p] : '') };
}

test('INLINE_PROPS：含关键的绘制属性，且不含会在 SVG 里添乱的东西', () => {
	for (const p of ['display', 'position', 'width', 'height', 'font-family', 'font-size',
		'color', 'background-color', 'background-image', 'text-shadow', 'filter',
		'opacity', 'transform', 'box-shadow', 'border-top-left-radius', 'mix-blend-mode']) {
		assert.ok(INLINE_PROPS.includes(p), `缺 ${p}`);
	}
	/* 这些一旦内联进 SVG 很容易把布局整个带偏，明确不要 */
	for (const p of ['content', 'cursor', 'animation', 'transition', 'will-change']) {
		assert.ok(!INLINE_PROPS.includes(p), `不该内联 ${p}`);
	}
});

test('cssTextFromComputed：跳过空值/none/normal/auto，保留真值', () => {
	const cs = stubComputed({
		'display': 'flex',
		'width': '100px',
		'background-image': 'linear-gradient(90deg, #000, #fff)',
		'box-shadow': 'none',
		'filter': 'none',
		'z-index': 'auto',
		'color': 'rgb(255, 0, 0)',
	});
	const css = cssTextFromComputed(cs);
	assert.ok(css.includes('display:flex;'));
	assert.ok(css.includes('width:100px;'));
	assert.ok(css.includes('background-image:linear-gradient(90deg, #000, #fff);'), '渐变必须保留（不能被 none 规则误伤）');
	assert.ok(css.includes('color:rgb(255, 0, 0);'));
	assert.ok(!css.includes('box-shadow'), 'none 要跳过');
	assert.ok(!css.includes('z-index'), 'auto 要跳过');
});

test('cssTextFromComputed：static 定位统一提成 relative', () => {
	const staticCss = cssTextFromComputed(stubComputed({ 'position': 'static' }));
	assert.ok(staticCss.includes('position:relative;'), 'static 必须换成 relative');
	const absCss = cssTextFromComputed(stubComputed({ 'position': 'absolute' }));
	assert.ok(absCss.includes('position:absolute;'));
	assert.ok(!absCss.includes('relative;'), 'absolute 不该被改写');
	/* 缺失 position 时也要补 relative，否则子元素绝对定位会跑飞 */
	assert.ok(cssTextFromComputed(stubComputed({})).includes('position:relative;'));
});

test('cssTextFromComputed：非法输入不抛', () => {
	assert.equal(cssTextFromComputed(null), '');
	assert.equal(cssTextFromComputed({}), '');
	assert.equal(cssTextFromComputed({ getPropertyValue: 'not a function' }), '');
	/* 某个属性读取时抛异常也不能把整体带崩 */
	const evil = {
		getPropertyValue(p) { if (p === 'width') throw new Error('boom'); return p === 'color' ? 'red' : ''; },
	};
	const css = cssTextFromComputed(evil);
	assert.ok(css.includes('color:red;'));
	assert.ok(css.includes('position:relative;'));
});

test('svgShell：用 viewBox 放大，内部仍按 CSS 尺寸布局（文字是矢量放大的）', () => {
	const svg = svgShell('<div>x</div>', 800, 450, 2);
	assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
	assert.ok(svg.includes('width="1600"') && svg.includes('height="900"'));
	assert.ok(svg.includes('viewBox="0 0 800 450"'));
	assert.ok(svg.includes('<foreignObject x="0" y="0" width="800" height="450">'));
	assert.ok(svg.includes('<div>x</div>'));
	assert.ok(svg.endsWith('</svg>'));
});

test('svgShell：scale 夹在 1~4，非法值退 1', () => {
	assert.ok(svgShell('', 100, 100, 0).includes('width="100"'));
	assert.ok(svgShell('', 100, 100, 99).includes('width="400"'), 'scale 上限 4');
	assert.ok(svgShell('', 100, 100, -3).includes('width="100"'));
	assert.ok(svgShell('', 100, 100, 'x').includes('width="100"'));
});

test('canvas 快照提供者：注册 / 注销 / 依次询问', () => {
	const fake = { width: 100, height: 100 };
	let called = 0;
	const off = registerCanvasSnapshot((cv) => {
		called++;
		return cv === fake ? 'data:image/png;base64,' + 'A'.repeat(120) : null;
	});
	assert.ok(snapshotCanvas(fake).length > 64);
	assert.equal(called, 1);
	/* 不认识的对象 → null（不能抛） */
	assert.equal(snapshotCanvas({ width: 1, height: 1 }), null);
	off();
	const before = called;
	assert.equal(snapshotCanvas(fake), null);
	assert.equal(called, before, '注销后不该再被调用');
});

test('canvas 快照提供者：抛异常不影响后续提供者', () => {
	const fake = { width: 10, height: 10 };
	const off1 = registerCanvasSnapshot(() => { throw new Error('provider boom'); });
	const off2 = registerCanvasSnapshot(() => 'data:image/png;base64,' + 'B'.repeat(120));
	assert.ok(snapshotCanvas(fake).length > 64, '前面那个抛了，后面的要顶上');
	off1(); off2();
});

test('canvas 快照提供者：短结果视为无效（防止拿到空帧）', () => {
	const off = registerCanvasSnapshot(() => 'data:,');
	assert.equal(snapshotCanvas({ width: 1, height: 1 }), null, '过短的 dataURL 要当无效');
	off();
});

test('TRANSPARENT_PIXEL 是合法的小 GIF', () => {
	assert.ok(TRANSPARENT_PIXEL.startsWith('data:image/gif;base64,'));
	assert.ok(TRANSPARENT_PIXEL.length > 40);
});

test('collectHidden：按选择器收集要隐藏的元素引用（用引用而非选择器，绕开 clone 已无 id 的坑）', () => {
	const a = { id: 'a' };
	const b = { id: 'b' };
	const root = {
		querySelectorAll(sel) {
			if (sel === '#a') return [a];
			if (sel === '.b') return [b];
			if (sel === '#missing') return [];
			throw new Error('bad selector');
		},
	};
	const set = mod.collectHidden(root, ['#a', '.b', '#missing', '!!不合法!!']);
	assert.ok(set.has(a));
	assert.ok(set.has(b));
	assert.equal(set.size, 2);
	/* 非法选择器不能把整体带崩 */
	assert.equal(mod.collectHidden(root, ['!!不合法!!']).size, 0);
	assert.equal(mod.collectHidden(null, ['#a']).size, 0);
	assert.equal(mod.collectHidden(root, null).size, 0);
});

test('collectSubtrees：保留「画面层」时必须连整棵子树一起留（只留根 = 空壳）', () => {
	const leaf = { id: 'leaf' };
	const layer = { id: 'layer', querySelectorAll: () => [leaf] };
	const other = { id: 'other', querySelectorAll: () => [] };
	const root = {
		querySelectorAll(sel) {
			if (sel === '#view-flyin-wireframes') return [layer];
			if (sel === '.mv-background') return [other];
			if (sel === '#missing') return [];
			throw new Error('bad selector');
		},
	};
	const set = mod.collectSubtrees(root, ['#view-flyin-wireframes', '.mv-background', '#missing', '!!不合法!!']);
	assert.ok(set.has(layer), '根节点要在');
	assert.ok(set.has(leaf), '★ 子节点也必须在 —— 否则层是空的，等于没保留');
	assert.ok(set.has(other));
	assert.equal(set.size, 3);
	assert.equal(mod.collectSubtrees(root, ['!!不合法!!']).size, 0);
	assert.equal(mod.collectSubtrees(null, ['#x']).size, 0);
	assert.equal(mod.collectSubtrees(root, null).size, 0);
});

test('导出面：浏览器函数都在（node 下不执行）', () => {
	assert.equal(typeof mod.snapshotElement, 'function');
	assert.equal(typeof mod.cropCanvas, 'function');
	assert.equal(typeof mod.collectHidden, 'function');
	assert.equal(typeof mod.collectSubtrees, 'function');
	assert.equal(typeof mod.measureCanvas, 'function');
	assert.equal(typeof mod.clearDataUrlCache, 'function');
});

/* ---- 源码级守门（暂存 iframe 里的两条硬约束只能靠源码约束，node 下跑不到 DOM）---- */

const SRC = readFileSync(new URL('../../web/src/core/domSnapshot.js', import.meta.url), 'utf8');

test('暂存 iframe：必须冻结 CSS 过渡，否则抓到的是过渡的起始帧（画面空白）', () => {
	/* ★★ 踩过的坑：给克隆体补上 `.active`（本意是让飞入的行显形）后**立刻**读 computed，
	   拿到的却是 `opacity:0` —— 因为 `transition` 会把它从 0 平滑推到 1，而
	   `getComputedStyle` 读的是"此刻"。`.line` 读到 0.981617、`.word` 读到 0，
	   海报上就是一片空白。**这不是"类没加上"，是"还没到"。**
	   过渡只决定"何时到达"，不决定"到达什么"，静态快照必须关掉。 */
	assert.match(SRC, /transition:none\s*!important/, '暂存 iframe 里必须有 transition:none !important');
	assert.match(SRC, /transition-delay:0s\s*!important/, '还必须清掉 transition-delay（延迟显形同样会读到旧值）');
	/* ★ 只关过渡、不关动画：飞入的旋转图形场等靠动画画出真实当前帧 */
	assert.ok(!/animation:none\s*!important/.test(SRC), '不该连带关掉 animation —— 动画的当前帧就是真实画面');
});

test('snapshotElement：必须有 onStaged 钩子且在 **读样式之前** 调用', () => {
	/* 钩子的意义：有些模式的"好看"状态依赖运行时逐帧挂的类（飞入的 `.line.active`）。
	   钩子必须在 `_plan`（读+写 computed）**之前**执行 —— `_plan` 是"读一次、写一次"，
	   一旦读过就被内联冻死了，事后再加类没有任何效果。 */
	const at = SRC.indexOf('opts.onStaged');
	assert.ok(at > 0, '缺 onStaged 钩子');
	const planCall = SRC.indexOf('_plan(root, clone, stats,');
	assert.ok(planCall > 0, '缺 _plan 调用');
	assert.ok(at < planCall, 'onStaged 必须在 _plan 之前调用（否则读到的还是旧值）');
	assert.match(SRC, /stats\.stagedApplied/, 'onStaged 的返回值要落进 stats，便于诊断');
});
