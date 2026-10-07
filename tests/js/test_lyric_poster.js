import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../web/src/core/lyricPoster.js');
const {
	POSTER_FRAMES, POSTER_DEFAULT_FRAME, POSTER_FONT, FULL_BLEED_MODES,
	posterFrameFor, containRect, coverRect2, layoutFor, frameTag, isFullBleedMode,
	charWidth, displayWidth, wrapDisplay,
	parseColor, withAlpha, mixColor, luminance,
	safeFileToken, posterFileName, drawPoster, captureIsRenderable,
} = mod;

/* ---------------- 抓帧就绪判据 ---------------- */

test('抓帧就绪：DOM 歌词 或 可见画布，满足其一即可抓', () => {
	/* ★ 回归守卫：判据第一版只看 DOM 可见歌词，于是把「画布绘字」的模式
	   （pv/诗境、tempera/版画）全部误判成"没有歌词"并拒绝出图 ——
	   它们的 .lyrics-area-wrapper 是 display:none（pv.css:18-21 / viewmode.css:881-888），
	   歌词由 Pixi 画在 canvas 上，DOM 里永远查不到可见歌词节点。 */
	assert.equal(captureIsRenderable({ lyricNodes: 1, canvases: 0 }), true, 'DOM 歌词可见即可抓');
	assert.equal(captureIsRenderable({ lyricNodes: 0, canvases: 1 }), true, '画布绘字的模式必须可抓');
	assert.equal(captureIsRenderable({ lyricNodes: 0, canvases: 0 }), false, '两者都没有才拒绝');
	assert.equal(captureIsRenderable({}), false, '缺参数按不可抓处理');
	assert.equal(captureIsRenderable(null), false, 'null 不许抛');
	assert.equal(captureIsRenderable({ lyricNodes: undefined, canvases: 2 }), true);
});

/* ---------------- 帧型 ---------------- */

test('帧型：id 唯一、缺省存在、字段齐整', () => {
	assert.ok(Array.isArray(POSTER_FRAMES) && POSTER_FRAMES.length === 3);
	const ids = POSTER_FRAMES.map(f => f.id);
	assert.deepEqual([...ids].sort(), ['native', 'square', 'story']);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes(POSTER_DEFAULT_FRAME));
	for (const f of POSTER_FRAMES) {
		for (const k of ['infoH', 'cover', 'padX']) {
			assert.equal(typeof f[k], 'number', `${f.id}.${k}`);
			assert.ok(f[k] >= 0, `${f.id}.${k} 不能为负`);
		}
		assert.equal(typeof f.infoOverlay, 'boolean', `${f.id}.infoOverlay`);
		assert.ok(typeof f.label === 'string' && f.label.length > 0);
	}
	/* ★★ 「不许再有圆角/外边距」是用户投诉换来的硬约束（毛玻璃框），
	   谁要是把 margin/radius 加回来就是重蹈覆辙。 */
	for (const f of POSTER_FRAMES) {
		assert.equal(f.margin, undefined, `${f.id} 不该再有 margin（会变成一块玻璃板）`);
		assert.equal(f.radius, undefined, `${f.id} 不该再有 radius（会变成一块玻璃板）`);
	}
	assert.equal(posterFrameFor('story').id, 'story');
	assert.equal(posterFrameFor('nope').id, POSTER_DEFAULT_FRAME);
	assert.equal(posterFrameFor(null).id, POSTER_DEFAULT_FRAME);
});

test('整屏模式表：视觉类铺满、文字类内嵌', () => {
	for (const m of ['pv', 'tempera', 'tunnel', 'dimension', 'letterpress', 'neon', 'cover']) {
		assert.equal(isFullBleedMode(m), true, `${m} 应铺满`);
	}
	for (const m of ['lyrics', 'flyin', 'wordcloud', '', null, undefined, 'unknown']) {
		assert.equal(isFullBleedMode(m), false, `${m} 应内嵌（裁一下就会切字）`);
	}
	assert.ok(FULL_BLEED_MODES instanceof Set);
});

/* ---------------- 几何纯函数 ---------------- */

test('containRect：等比内嵌、居中、不越界', () => {
	const r = containRect(1600, 900, 0, 0, 1000, 1000);
	assert.equal(r.w, 1000);
	assert.equal(r.h, 562.5);
	assert.equal(r.x, 0);
	assert.equal(r.y, (1000 - 562.5) / 2);
	assert.ok(r.w <= 1000 && r.h <= 1000);
	/* 竖图放进横框 */
	const p = containRect(900, 1600, 0, 0, 1000, 1000);
	assert.equal(p.h, 1000);
	assert.ok(p.w < 1000);
	/* 非法输入不产生 NaN */
	const b = containRect(0, 0, 0, 0, 100, 100);
	assert.ok(Number.isFinite(b.w) && Number.isFinite(b.h));
});

test('coverRect2：等比铺满、居中裁切、至少覆盖方框', () => {
	const r = coverRect2(1600, 900, 10, 20, 400, 400);
	assert.ok(r.w >= 400 - 1e-9 && r.h >= 400 - 1e-9);
	assert.equal(r.h, 400);
	assert.equal(r.x, 10 + (400 - r.w) / 2);
	assert.equal(r.y, 20);
	const sq = coverRect2(500, 500, 0, 0, 300, 300);
	assert.deepEqual(sq, { x: 0, y: 0, w: 300, h: 300 });
});

/* ---------------- 版式（真正要钉的东西） ---------------- */

const VW = 1418;
const VH = 802;   /* 实测捕获到的播放器画面尺寸 */

test('native 帧：画面不裁不缩，信息栏外挂在下方', () => {
	const L = layoutFor('native', VW, VH);
	assert.equal(L.W, VW);
	assert.ok(L.H > VH, '画布要高出一个信息栏');
	assert.equal(L.hasBackdrop, false);
	assert.equal(L.radius, 0);
	assert.equal(L.fullBleed, false);
	assert.deepEqual(L.heroRect, { x: 0, y: 0, w: VW, h: VH });
	assert.equal(L.info.y, VH, '信息栏紧贴画面下缘');
	assert.equal(L.info.y + L.info.h, L.H - 0, '信息栏要落满画布底部');
	assert.equal(L.viewW, VW);
	assert.equal(L.viewH, VH);
});

for (const id of ['square', 'story']) {
	test(`${id} 帧（文字模式）：主体内嵌、铺满画布宽、不留外边距`, () => {
		const f = posterFrameFor(id);
		const L = layoutFor(id, VW, VH, 'lyrics');
		assert.equal(L.W, f.w);
		assert.equal(L.H, f.h);
		assert.equal(L.hasBackdrop, true, '非原生帧必须有模糊铺底，否则会留大片纯色');
		assert.equal(L.fullBleed, false, '文字模式不能铺满（裁一下会切字）');
		/* 主体保持画面宽高比（关键：绝不能拉伸变形） */
		const viewAspect = VW / VH;
		const heroAspect = L.heroRect.w / L.heroRect.h;
		assert.ok(Math.abs(heroAspect - viewAspect) < 1e-6, `主体被拉伸了：${heroAspect} vs ${viewAspect}`);
		/* ★★ 主体必须**贴着画布左右边**（原来 margin 64 让它缩了一圈，字跟着变小 ——
		   用户原话「放大一点歌词」）。 */
		assert.ok(L.heroRect.x <= 1e-6, `主体左边不该有外边距，实得 ${L.heroRect.x}`);
		assert.ok(L.heroRect.x + L.heroRect.w >= L.W - 1e-6, '主体右边不该有外边距');
		assert.ok(L.heroRect.y >= 0 && L.heroRect.y + L.heroRect.h <= L.info.y + 1e-6, '主体压到信息栏');
		/* 信息栏 */
		assert.equal(L.info.y + L.info.h, L.H);
		assert.ok(L.info.coverY >= L.info.y, '封面溢出信息栏上缘');
		assert.ok(L.info.coverY + L.info.cover <= L.info.y + L.info.h, '封面溢出信息栏下缘');
		assert.ok(L.info.textX > L.info.coverX + L.info.cover, '文字要排在封面右边');
		assert.ok(L.info.titleY > L.info.y && L.info.titleY < L.info.artistY, '标题在歌手之上');
		assert.ok(L.info.artistY < L.info.footY, '歌手在水印行之上（否则会压字）');
		assert.ok(L.info.footY <= L.H, '水印行越界');
		assert.ok(L.info.logoSize > 0, '水印要带 Logo');
		assert.ok(L.info.textUnits >= 8, '标题可用宽度太小');
	});
}

for (const id of ['square', 'story']) {
	test(`${id} 帧（整屏模式）：主体裁切铺满整张海报`, () => {
		const f = posterFrameFor(id);
		const L = layoutFor(id, VW, VH, 'tunnel');
		assert.equal(L.fullBleed, true);
		/* 铺满 = 等比放大到**至少**盖住整张画布，多出来的部分居中裁掉（所以 x/y 会是负的） */
		assert.ok(L.heroRect.w >= f.w - 1e-6, '整屏模式必须铺满宽度');
		assert.ok(L.heroRect.h >= f.h - 1e-6, '整屏模式必须铺满高度');
		const viewAspect = VW / VH;
		const heroAspect = L.heroRect.w / L.heroRect.h;
		assert.ok(Math.abs(heroAspect - viewAspect) < 1e-6, '铺满依然要保持比例（靠裁切而不是拉伸）');
	});
}

test('版式：画面比例变化时主体仍不变形、不越界', () => {
	for (const [w, h] of [[1920, 1080], [800, 1200], [1000, 1000], [2560, 1080]]) {
		for (const id of ['square', 'story']) {
			const L = layoutFor(id, w, h, 'lyrics');
			assert.ok(Math.abs(L.heroRect.w / L.heroRect.h - w / h) < 1e-6, `${id} ${w}x${h} 变形`);
			assert.ok(L.heroRect.y + L.heroRect.h <= L.info.y + 1e-6, `${id} ${w}x${h} 压到信息栏`);
			assert.ok(L.heroRect.x >= 0 && L.heroRect.y >= 0, `${id} ${w}x${h} 负坐标`);
			assert.ok(L.heroRect.x + L.heroRect.w <= L.W + 1e-6, `${id} ${w}x${h} 右越界`);
		}
	}
});

test('frameTag / posterFileName', () => {
	assert.equal(frameTag('square'), '1x1');
	assert.equal(frameTag('story'), '9x16');
	assert.equal(frameTag('native'), 'full');
	assert.equal(posterFileName({ title: '晴天', artist: '周杰伦' }, 'square'), '晴天 - 周杰伦 - 1x1.png');
	assert.equal(posterFileName({ title: '晴天', artist: '周杰伦' }, 'native'), '晴天 - 周杰伦 - full.png');
	assert.equal(posterFileName({ title: '晴天' }, 'story'), '晴天 - 9x16.png');
	assert.equal(posterFileName({ title: '晴天', artist: '未知歌手' }, 'square'), '晴天 - 1x1.png');
	assert.equal(posterFileName(null, 'square'), 'Aria - 1x1.png');
	assert.equal(posterFileName({ title: 'a/b' }, 'square', 'jpg'), 'a b - 1x1.jpg');
});

/* ---------------- 文本 / 颜色 ---------------- */

test('charWidth / displayWidth', () => {
	assert.equal(charWidth('a'), 1);
	assert.equal(charWidth('中'), 2);
	assert.equal(displayWidth('abc'), 3);
	assert.equal(displayWidth('中文'), 4);
	assert.equal(displayWidth(null), 0);
});

test('wrapDisplay：按显示宽度折行，至少一项', () => {
	assert.deepEqual(wrapDisplay('abcd', 2), ['ab', 'cd']);
	assert.deepEqual(wrapDisplay('中文中文', 4), ['中文', '中文']);
	assert.deepEqual(wrapDisplay('abcd', 4), ['abcd']);
	assert.deepEqual(wrapDisplay('hello world', 8), ['hello', 'world']);
	assert.deepEqual(wrapDisplay('', 5), ['']);
	assert.deepEqual(wrapDisplay(null, 5), ['']);
});

test('颜色工具', () => {
	assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
	assert.deepEqual(parseColor('#E8BE6A'), { r: 232, g: 190, b: 106 });
	assert.deepEqual(parseColor('rgba(1,2,3,0.5)'), { r: 1, g: 2, b: 3 });
	assert.equal(parseColor('nope'), null);
	assert.equal(withAlpha('#000000', 0.5), 'rgba(0,0,0,0.5)');
	assert.equal(withAlpha('var(--x)', 0.5), 'var(--x)');
	assert.equal(mixColor('#000000', '#ffffff', 0.5), '#808080');
	assert.equal(luminance('#000000'), 0);
	assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
});

test('safeFileToken：去非法字符、截断', () => {
	assert.equal(safeFileToken('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
	assert.equal(safeFileToken('x'.repeat(100)).length, 40);
	assert.equal(safeFileToken(null), '');
});

/* ---------------- 绘制（记录型 ctx 桩） ---------------- */

function makeCtx() {
	const rec = { fills: [], texts: [], images: [], strokes: 0, clips: 0, pathFills: 0, ops: [] };
	const grad = () => ({ addColorStop(p, c) { rec.ops.push(['stop', p, c]); } });
	const ctx = {
		_rec: rec,
		canvas: { width: 2160, height: 2160 },
		set fillStyle(v) { rec.ops.push(['fillStyle', v]); },
		get fillStyle() { return ''; },
		set strokeStyle(v) { rec.ops.push(['strokeStyle', v]); },
		get strokeStyle() { return ''; },
		set lineWidth(v) { rec.ops.push(['lineWidth', v]); },
		set font(v) { rec.ops.push(['font', v]); },
		get font() { return rec.ops.filter(o => o[0] === 'font').slice(-1)[0]?.[1] || ''; },
		set textAlign(v) { rec.ops.push(['textAlign', v]); },
		get textAlign() { return ''; },
		set textBaseline(v) { rec.ops.push(['textBaseline', v]); },
		get textBaseline() { return ''; },
		set shadowColor(v) { rec.ops.push(['shadowColor', v]); },
		set shadowBlur(v) { rec.ops.push(['shadowBlur', v]); },
		set shadowOffsetY(v) { rec.ops.push(['shadowOffsetY', v]); },
		set globalAlpha(v) { rec.ops.push(['globalAlpha', v]); },
		set filter(v) { rec.ops.push(['filter', v]); },
		get filter() { return ''; },
		createLinearGradient: grad,
		createRadialGradient: grad,
		fillRect(x, y, w, h) { rec.fills.push({ x, y, w, h }); },
		fillText(t, x, y) { rec.texts.push({ t: String(t), x, y, font: ctx.font }); },
		/* 水印要按文字宽度左移 Logo，所以桩必须给 measureText（近似宽度即可） */
		measureText(t) { return { width: String(t).length * 9 }; },
		drawImage(img, x, y, w, h) { rec.images.push({ img, x, y, w, h }); },
		fill() { rec.pathFills++; },
		stroke() { rec.strokes++; },
		clip() { rec.clips++; },
		save() {}, restore() {},
		beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, rect() {},
		translate() {}, scale() {}, setTransform() {}, clearRect() {},
	};
	return ctx;
}

const SONG = { title: '晴天', artist: '周杰伦', album: '叶惠美' };
const fakeView = { width: 1418, height: 802 };
const fakeCover = { width: 600, height: 600 };
const fakeLogo = { width: 256, height: 256 };

test('drawPoster square（文字模式）：画面自己铺底 + 主体 + 信息栏，**没有边框**', () => {
	const ctx = makeCtx();
	const L = layoutFor('square', VW, VH, 'lyrics');
	const info = drawPoster(ctx, {
		layout: L, view: fakeView, cover: fakeCover, logo: fakeLogo, song: SONG,
		accent: '#FF3B30', footer: 'Aria · 2026-10-05', badge: '歌词',
	});
	assert.equal(info.drewView, true);
	assert.equal(info.drewBackdrop, true, '非原生帧必须铺模糊底');
	assert.equal(info.drewLogo, true, '水印必须带上 Logo');
	/* ★★ 铺底必须用**画面自己**拉伸模糊 —— 用封面会因色调不一致而露出一块整齐的色带，
	   那正是用户投诉的「毛玻璃框」。图像使用次数：画面 ×2（铺底 + 主体）+ 封面 ×1（缩略图）。 */
	assert.equal(ctx._rec.images.filter(i => i.img === fakeView).length, 2, '画面要画两次（铺底 + 主体）');
	assert.equal(ctx._rec.images.filter(i => i.img === fakeCover).length, 1, '封面只做缩略图');
	assert.equal(ctx._rec.images.filter(i => i.img === fakeLogo).length, 1, 'Logo 只画一次');
	/* 铺底那一笔要铺满整张画布 */
	assert.ok(ctx._rec.images.some(i => i.img === fakeView && i.w >= L.W - 0.5 && i.h >= L.H - 0.5),
		'铺底那次必须铺满整张画布');
	assert.ok(ctx._rec.ops.some(o => o[0] === 'filter' && /blur\(/.test(String(o[1]))), '铺底必须模糊');
	/* ★★ 主体不再有任何裁切/描边（原来有圆角 + 描边 = 用户说的「毛玻璃框」）。
	   唯一该出现的两次 clip 是封面缩略图与 Logo 的圆角。 */
	assert.equal(ctx._rec.clips, 2, `只该裁 2 次（封面圆角 + Logo 圆角），实得 ${ctx._rec.clips}`);
	assert.equal(ctx._rec.strokes, 0, '主体不该再描边');
	assert.equal(ctx._rec.pathFills, 1, `只该填充 1 次（封面底），实得 ${ctx._rec.pathFills}`);
	/* 文字：歌名 + 歌手·专辑 + 水印 + 角标 */
	const texts = ctx._rec.texts.map(t => t.t);
	assert.ok(texts.includes('晴天'));
	assert.ok(texts.some(t => t.includes('周杰伦') && t.includes('叶惠美')));
	assert.ok(texts.includes('Aria · 2026-10-05'));
	assert.ok(texts.includes('歌词'));
	/* 信息栏底色要被铺在 I.y 处 */
	assert.ok(ctx._rec.fills.some(f => Math.abs(f.y - L.info.y) < 1 && f.w === L.W));
});

test('drawPoster square（整屏模式）：主体裁切铺满整张画布，信息栏叠在上面', () => {
	const ctx = makeCtx();
	const L = layoutFor('square', VW, VH, 'tunnel');
	drawPoster(ctx, { layout: L, view: fakeView, cover: fakeCover, song: SONG, badge: '格律' });
	const hero = ctx._rec.images.find(i => i.img === fakeView && i.w === L.W);
	assert.ok(hero, '整屏模式必须有一次铺满画布的主体绘制');
	assert.equal(hero.x, 0);
	assert.equal(hero.y, 0);
	assert.equal(hero.h, L.H);
});

test('drawPoster：水印在**右下角**、用 Logo、不用页脚左对齐（用户点名改造）', () => {
	const ctx = makeCtx();
	const L = layoutFor('square', VW, VH, 'lyrics');
	drawPoster(ctx, { layout: L, view: fakeView, cover: fakeCover, logo: fakeLogo, song: SONG, footer: 'Aria · 2026-10-05', badge: '歌词' });
	const foot = ctx._rec.texts.find(t => t.t === 'Aria · 2026-10-05');
	assert.ok(foot, '水印文字必须在');
	assert.ok(foot.x > L.W * 0.55, `水印必须靠右，实得 x=${foot.x} / W=${L.W}`);
	/* Logo 必须比水印文字更靠左、且同一行 */
	const lg = ctx._rec.images.find(i => i.img === fakeLogo);
	assert.ok(lg, 'Logo 必须画出来');
	assert.ok(lg.x + lg.w <= foot.x + 1, 'Logo 应在水印文字左侧且不重叠');
});

test('drawPoster native：不铺底，主体顶到边，信息栏贴在画面下方', () => {
	const ctx = makeCtx();
	const L = layoutFor('native', VW, VH);
	const info = drawPoster(ctx, { layout: L, view: fakeView, cover: fakeCover, song: SONG, accent: '#E8BE6A' });
	assert.equal(info.drewBackdrop, false);
	assert.equal(ctx._rec.images.filter(i => i.img === fakeView).length, 1, 'native 主体只画一次');
	assert.equal(ctx._rec.images.filter(i => i.img === fakeCover).length, 1, '封面只做缩略图');
	/* 主体必须顶到边（不缩不放） */
	const heroImg = ctx._rec.images.find(i => i.img === fakeView);
	assert.deepEqual({ x: heroImg.x, y: heroImg.y, w: heroImg.w, h: heroImg.h }, { x: 0, y: 0, w: VW, h: VH });
});

test('drawPoster：没有画面时铺底退回封面（仍不能一片死黑）', () => {
	const ctx = makeCtx();
	const L = layoutFor('square', VW, VH, 'lyrics');
	const info = drawPoster(ctx, { layout: L, view: null, cover: fakeCover, song: SONG, accent: '#E8BE6A' });
	assert.equal(info.drewBackdrop, true, '没画面也要有铺底（退回封面）');
	assert.ok(ctx._rec.images.some(i => i.img === fakeCover && i.w >= L.W - 0.5 && i.h >= L.H - 0.5),
		'铺底退回封面时也要铺满整张画布');
});

test('drawPoster：没有 Logo 也要出图（水印退化为纯文字）', () => {
	const ctx = makeCtx();
	const info = drawPoster(ctx, { layout: layoutFor('square', VW, VH, 'lyrics'), view: fakeView, cover: null, logo: null, song: SONG, footer: 'Aria · 2026-10-05' });
	assert.equal(info.drewLogo, false);
	assert.ok(ctx._rec.texts.some(t => t.t === 'Aria · 2026-10-05'), '没有 Logo 也不能丢水印文字');
});

test('drawPoster：无封面时画兜底音符，且有封面时不画', () => {
	const a = makeCtx();
	drawPoster(a, { layout: layoutFor('square', VW, VH, 'lyrics'), view: fakeView, cover: null, song: SONG });
	assert.ok(a._rec.texts.some(t => t.t === '\u266A'), '无封面应有兜底音符');
	const b = makeCtx();
	drawPoster(b, { layout: layoutFor('square', VW, VH, 'lyrics'), view: fakeView, cover: fakeCover, song: SONG });
	assert.ok(!b._rec.texts.some(t => t.t === '\u266A'), '有封面不该画音符');
});

test('drawPoster：长歌名折行到 2 行，且不越过水印行', () => {
	const ctx = makeCtx();
	const L = layoutFor('square', VW, VH, 'lyrics');
	const long = '这是一个非常非常非常非常非常长的歌曲名字用来测试折行行为是否受控';
	const info = drawPoster(ctx, { layout: L, view: fakeView, cover: fakeCover, song: { title: long, artist: '某人' } });
	assert.ok(info.titleLines >= 1 && info.titleLines <= 2, `折行数应在 1~2，实得 ${info.titleLines}`);
	const titleTexts = ctx._rec.texts.filter(t => long.includes(t.t));
	assert.equal(titleTexts.length, info.titleLines);
	for (const t of titleTexts) assert.ok(t.y < L.info.footY, '标题不得压到水印行');
});

test('drawPoster：无画面也不抛（只出一张信息栏图）', () => {
	const ctx = makeCtx();
	const info = drawPoster(ctx, { layout: layoutFor('square', VW, VH, 'lyrics'), view: null, cover: null, logo: null, song: {} });
	assert.equal(info.drewView, false);
	assert.equal(ctx._rec.images.length, 0);
	assert.ok(ctx._rec.texts.some(t => t.t === '未知曲目'));
	assert.ok(ctx._rec.texts.some(t => t.t === '未知歌手'));
});

test('drawPoster：默认 layout（不传）可用，不抛', () => {
	const ctx = makeCtx();
	const info = drawPoster(ctx, {});
	assert.equal(info.drewView, false);
	assert.ok(ctx._rec.texts.some(t => t.t === 'Aria'), '默认页脚是 Aria');
});

test('导出面：浏览器函数都在', () => {
	assert.equal(typeof mod.composePoster, 'function');
	assert.equal(typeof mod.loadCoverImage, 'function');
	assert.equal(typeof mod.imageFromSource, 'function');
	assert.equal(typeof mod.loadLogoImage, 'function');
	assert.equal(typeof mod.clearPosterImageCache, 'function');
	assert.equal(typeof mod.saveBlob, 'function');
	assert.equal(typeof POSTER_FONT, 'string');
	assert.equal(typeof mod.POSTER_LOGO_URL, 'string');
});
