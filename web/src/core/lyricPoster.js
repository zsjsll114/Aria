/**
 * lyricPoster.js — 歌词海报合成（需求 2）
 *
 * ★★ 本模块**不再自己画歌词**。上一版自绘了一张「封面 + 歌词 + 歌名」的卡片，
 *    被用户直接否掉：「不能用现有歌词模式吗」—— 对，海报要的就是**用户此刻看到的那个画面**。
 *    所以现在的分工是：
 *      · `core/domSnapshot.js` 负责把**真实 DOM 视图**光栅化成位图（真歌词、真字体、
 *        真高亮、真模糊、真背景）；
 *      · 本模块只负责**排版**：把那张画面当主体，加一层无缝的模糊铺底 + 一条信息栏。
 *
 * ★★ 版式的三条硬规则（都是用户逐条投诉换来的，别再改回去）：
 *   ① **不许有「毛玻璃框」**。上一版把主体画成一块圆角矩形：底板 + 1.5px 白描边 +
 *      42px 投影。用户的反馈是「底下多出了一个毛玻璃框 去掉」——在方图里那圈描边
 *      读起来就是一块玻璃板。现在**不画任何边框/圆角/投影**，主体直接落在铺底上。
 *   ② **铺底必须用「画面自己」拉伸模糊**，不能用封面。封面与画面是两张图，
 *      色调对不上，交界处就露出一块整齐的色带（用户实测「毛玻璃框」的另一半来源）。
 *      画面自己拉伸 1.35 倍再重模糊，畸变看不出来、色调完全一致 ⇒ 真正无缝。
 *      封面只在拿不到画面时兜底。
 *   ③ **能铺满就铺满**。全屏类视觉模式（诗镜 / 版画 / 格律 / 穿行 / 活字）本来就是
 *      满屏画面，`contain` 会留出上下两条带 —— 用户原话「穿行海报不应该在毛玻璃框里面
 *      显示 而是整个上方页面」。这些模式用 `cover` 裁切铺满整张海报。
 *      文字类（歌词 / 飞白 / 词云）**不能裁**（会把整行字切掉），才走 `contain` + 铺底。
 *
 * 帧型（frame）：
 *   native  原画幅 —— 完全不裁不缩，下面外挂一条信息栏（最保真）
 *   square  1:1   —— 主体铺满/内嵌居中，信息栏叠在下缘
 *   story   9:16  —— 同上，更高
 *
 * 纯函数（颜色 / 折行 / 文件名 / **版式计算**）与绘制分离，前者可在 node 直接测。
 */

import { logCatch } from '../services/log.js';

/* ============================ 常量 ============================ */

export const POSTER_FONT = "'PingFang SC','Microsoft YaHei','Noto Sans SC','Source Han Sans SC',system-ui,-apple-system,'Segoe UI',sans-serif";

/** 水印 Logo：标题栏用的就是这一张（`server.py` 把 `/icons/` 映射到 `src-tauri/icons`）。 */
export const POSTER_LOGO_URL = '/icons/icon.png';

/** 帧型定义。几何由 `layoutFor` 算出，这里只放「意图」。 */
export const POSTER_FRAMES = [
	{
		id: 'native', label: '原画幅', hint: '保留播放器画面比例',
		w: 0, h: 0,                        /* 0 = 跟随画面尺寸 */
		infoH: 104, cover: 72, padX: 44, infoOverlay: false,
	},
	{
		id: 'square', label: '方图', hint: '1:1 · 朋友圈 / Instagram',
		w: 1080, h: 1080,
		infoH: 188, cover: 104, padX: 56, infoOverlay: true,
	},
	{
		id: 'story', label: '竖图', hint: '9:16 · 小红书 / 故事',
		w: 1080, h: 1920,
		infoH: 220, cover: 116, padX: 56, infoOverlay: true,
	},
];

export const POSTER_DEFAULT_FRAME = 'square';

export function posterFrameFor(id) {
	return POSTER_FRAMES.find(f => f.id === id) || POSTER_FRAMES.find(f => f.id === POSTER_DEFAULT_FRAME);
}

/**
 * 「整屏画面」类模式：主体已经是满屏视觉效果，海报里要**裁切铺满**而不是内嵌。
 * ★ 反过来，歌词 / 飞白 / 词云的整行文字横跨画面宽度，裁一下就切字 —— 必须内嵌。
 */
export const FULL_BLEED_MODES = new Set([
    'cover', 'pv', 'tempera', 'tunnel', 'dimension', 'letterpress', 'neon', 'jizura',
]);

export function isFullBleedMode(mode) {
	return FULL_BLEED_MODES.has(String(mode || ''));
}

/**
 * 抓帧就绪判据（2026-10-05 修）。
 *
 * 起因：给海报流程加"没歌词就别出图"的守卫时，判据写成了"DOM 里有没有可见的
 * `.line/.word`"。但**画布绘字的模式**（pv/sonnet、tempera，以及 tunnel/dimension）
 * 恰恰把 `.lyrics-area-wrapper` 整个 `display:none`（pv.css / viewmode.css），
 * 歌词由 Pixi/WebGL 画在 canvas 上 —— 于是这些模式的 DOM 歌词节点**永远不可见**，
 * 判据恒为 0，海报流程对它们**必然**报"没有歌词文字"并拒绝出图。
 *
 * 正确判据：**DOM 可见歌词** 或 **有可见且已拿到尺寸的画布**，满足其一即为"可抓"。
 * 刻意不用"模式清单"来判断走哪条路：模式清单会漂移（新增模式忘登记就再次误杀），
 * 而"有没有可见歌词 / 有没有像样的画布"是当下的客观事实。
 *
 * @param {{lyricNodes?:number, canvases?:number}} probe
 */
export function captureIsRenderable(probe) {
	const p = probe || {};
	return (Number(p.lyricNodes) || 0) > 0 || (Number(p.canvases) || 0) > 0;
}

/* ============================ 纯函数：几何 ============================ */

/** 等比「内嵌」：既放得下，又不变形。 */
export function containRect(iw, ih, bx, by, bw, bh) {
	const w = Math.max(1, Number(iw) || 1);
	const h = Math.max(1, Number(ih) || 1);
	const s = Math.min(bw / w, bh / h);
	const dw = w * s;
	const dh = h * s;
	return { x: bx + (bw - dw) / 2, y: by + (bh - dh) / 2, w: dw, h: dh };
}

/** 等比「铺满」（多余部分居中裁掉），用于背景铺底与主体裁切。 */
export function coverRect2(iw, ih, bx, by, bw, bh) {
	const w = Math.max(1, Number(iw) || 1);
	const h = Math.max(1, Number(ih) || 1);
	const s = Math.max(bw / w, bh / h);
	const dw = w * s;
	const dh = h * s;
	return { x: bx + (bw - dw) / 2, y: by + (bh - dh) / 2, w: dw, h: dh };
}

/** 由帧参数算信息栏里那些文字的几何（native 与 overlay 共用）。 */
function infoGeometry(frame, W, H, infoY) {
	const cover = frame.cover;
	const padX = frame.padX;
	const titleSize = Math.round(cover * 0.42);
	const footSize = Math.max(17, Math.round(cover * 0.185));
	return {
		y: infoY, h: frame.infoH, padX,
		cover, coverX: padX, coverY: infoY + (frame.infoH - cover) / 2,
		textX: padX + cover + Math.round(cover * 0.26),
		titleY: infoY + frame.infoH * 0.44,
		artistY: infoY + frame.infoH * 0.44 + Math.round(cover * 0.34),
		/* 底行（水印行）压在信息栏下缘 */
		footY: infoY + frame.infoH - Math.round(footSize * 1.35),
		titleSize,
		artistSize: Math.round(cover * 0.24),
		footSize,
		logoSize: Math.round(footSize * 1.25),
		/* 标题折行可用的显示宽度（displayWidth 单位） */
		textUnits: Math.max(8, Math.floor((W - padX * 2 - cover - 40) / (titleSize * 0.62))),
	};
}

/**
 * 算出整张海报的几何 —— 「版式」这件事的唯一真相（纯函数，可单测）。
 * @param {string} frameId
 * @param {number} viewW 捕获画面宽（CSS px）
 * @param {number} viewH 捕获画面高（CSS px）
 * @param {string} [mode] 当前视图模式（决定铺满还是内嵌，见 `FULL_BLEED_MODES`）
 */
export function layoutFor(frameId, viewW, viewH, mode) {
	const f = posterFrameFor(frameId);
	const vw = Math.max(1, Math.round(Number(viewW) || 1));
	const vh = Math.max(1, Math.round(Number(viewH) || 1));
	const full = isFullBleedMode(mode);
	const isNative = f.id === 'native' || !f.w || !f.h;

	if (isNative) {
		/* 原画幅：信息栏外挂在画面**下方**，所以画布高 = 画面高 + 信息栏高 */
		const infoH = Math.max(72, Math.min(f.infoH, Math.round(vh * 0.4)));
		const H = vh + infoH;
		const base = { ...f, infoH };
		return {
			frameId: 'native', W: vw, H, hasBackdrop: false, infoOverlay: false, radius: 0,
			fullBleed: false,
			heroRect: { x: 0, y: 0, w: vw, h: vh },
			backdropRect: null, viewW: vw, viewH: vh,
			info: infoGeometry(base, vw, H, vh),
		};
	}

	const W = f.w;
	const H = f.h;
	const infoH = Math.min(f.infoH, Math.round(H * 0.26));
	const base = { ...f, infoH };
	/* 主体可用区 = 整幅减掉信息栏。全屏类模式直接铺满整幅（信息栏叠上去）。 */
	const availH = H - infoH;
	return {
		frameId: f.id, W, H, hasBackdrop: true, infoOverlay: true, radius: 0,
		fullBleed: full,
		heroRect: full
			? coverRect2(vw, vh, 0, 0, W, H)
			: containRect(vw, vh, 0, 0, W, availH),
		backdropRect: { x: 0, y: 0, w: W, h: H },
		viewW: vw, viewH: vh,
		info: infoGeometry(base, W, H, H - infoH),
	};
}

/** 海报文件名后缀用的帧标签。 */
export function frameTag(frameId) {
	const f = posterFrameFor(frameId);
	return f.id === 'story' ? '9x16' : (f.id === 'square' ? '1x1' : 'full');
}

/* ============================ 纯函数：文本 / 颜色 / 文件名 ============================ */

const RE_WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function charWidth(ch) {
	return RE_WIDE.test(ch) ? 2 : 1;
}

export function displayWidth(s) {
	let n = 0;
	for (const ch of String(s == null ? '' : s)) n += charWidth(ch);
	return n;
}

/** 按显示宽度折行（标题太长时用）。至少返回一项。 */
export function wrapDisplay(text, maxUnits) {
	const max = Math.max(1, Math.floor(Number(maxUnits)) || 1);
	const out = [];
	for (const para of String(text == null ? '' : text).split('\n')) {
		let line = '';
		let w = 0;
		for (const ch of [...para]) {
			const cw = charWidth(ch);
			if (w + cw > max && line !== '') {
				const sp = cw === 1 ? line.lastIndexOf(' ') : -1;
				if (sp > 0 && line.length - sp <= 12) {
					out.push(line.slice(0, sp));
					line = line.slice(sp + 1) + ch;
					w = displayWidth(line);
				} else {
					out.push(line);
					line = ch;
					w = cw;
				}
			} else {
				line += ch;
				w += cw;
			}
		}
		out.push(line);
	}
	return out.length ? out : [''];
}

export function parseColor(c) {
	if (typeof c !== 'string') return null;
	const s = c.trim();
	let m = /^#([0-9a-f]{3})$/i.exec(s);
	if (m) {
		const [r, g, b] = m[1].split('').map(x => parseInt(x + x, 16));
		return { r, g, b };
	}
	m = /^#([0-9a-f]{6})$/i.exec(s);
	if (m) {
		const v = parseInt(m[1], 16);
		return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
	}
	m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
	if (m) {
		return {
			r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
			g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
			b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
		};
	}
	return null;
}

function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

export function withAlpha(c, a) {
	const p = parseColor(c);
	if (!p) return c;
	const alpha = Math.max(0, Math.min(1, Number(a)));
	return `rgba(${p.r},${p.g},${p.b},${alpha})`;
}

export function mixColor(c1, c2, t) {
	const k = Math.max(0, Math.min(1, Number(t)));
	const a = parseColor(c1) || { r: 232, g: 190, b: 106 };
	const b = parseColor(c2) || { r: 0, g: 0, b: 0 };
	return '#' + ['r', 'g', 'b'].map(key => clamp255(a[key] + (b[key] - a[key]) * k))
		.map(v => v.toString(16).padStart(2, '0')).join('');
}

export function luminance(c) {
	const p = parseColor(c);
	if (!p) return 0;
	const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
	return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b);
}

export function safeFileToken(s, max = 40) {
	return String(s == null ? '' : s)
		/* eslint-disable-next-line no-control-regex */
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

export function posterFileName(song, frameId, ext = 'png') {
	const s = song || {};
	const title = safeFileToken(s.title || s.name || s.song) || 'Aria';
	const artist = safeFileToken(s.artist || s.singer);
	const parts = [title];
	if (artist && artist !== '未知歌手') parts.push(artist);
	parts.push(frameTag(frameId));
	return `${parts.join(' - ')}.${ext}`;
}

/* ============================ 绘制 ============================ */

function roundRectPath(ctx, x, y, w, h, r) {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2));
	if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); return; }
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

/** 取图像真实尺寸（canvas / img / ImageBitmap 通用）。 */
function srcSize(img, fallbackW, fallbackH) {
	return {
		w: Math.max(1, Number(img.width || img.naturalWidth) || fallbackW || 1),
		h: Math.max(1, Number(img.height || img.naturalHeight) || fallbackH || 1),
	};
}

/**
 * 画一张海报。坐标一律是逻辑像素；DPR 由调用方在外层 `ctx.scale()`。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {object} opts.layout  来自 `layoutFor`
 * @param {CanvasImageSource} opts.view  捕获到的**真实画面**（必需）
 * @param {CanvasImageSource} [opts.cover]
 * @param {CanvasImageSource} [opts.logo]  右下角水印用的应用图标
 * @param {object} [opts.song]
 * @param {string} [opts.accent]
 * @param {string} [opts.footer]
 * @param {string} [opts.badge]
 * @param {string} [opts.fontFamily]
 * @returns {{drewView:boolean, drewBackdrop:boolean, drewLogo:boolean, titleLines:number}}
 */
export function drawPoster(ctx, opts) {
	const L = (opts && opts.layout) || layoutFor('native', 1280, 720);
	const W = L.W;
	const H = L.H;
	const font = (opts && opts.fontFamily) || POSTER_FONT;
	const accent = (opts && opts.accent) || '#E8BE6A';
	const view = (opts && opts.view) || null;
	const song = (opts && opts.song) || {};
	const cover = (opts && opts.cover) || null;
	const logo = (opts && opts.logo) || null;
	let drewBackdrop = false;

	/* ① 底 */
	ctx.fillStyle = '#08080a';
	ctx.fillRect(0, 0, W, H);

	/* ② 铺底：**画面自己**拉伸铺满 + 重模糊。
	   ★★ 绝不能用封面：封面和画面是两张图，色调一对不上，交界处就露出一块整齐的色块，
	   用户看到的正是那个「毛玻璃框」。用画面自己拉伸（畸变被重模糊吃掉）⇒ 真正无缝。 */
	if (L.hasBackdrop) {
		const bgSrc = view || cover;
		if (bgSrc) {
			const bs = srcSize(bgSrc, L.viewW, L.viewH);
			ctx.save();
			try { ctx.filter = `blur(${Math.round(Math.min(W, H) * 0.055)}px) saturate(1.12) brightness(0.52)`; } catch (e) { logCatch('poster', e); }
			try { ctx.drawImage(bgSrc, 0, 0, W, H); drewBackdrop = true; } catch (e) { logCatch('poster', e); }
			ctx.restore();
			void bs;
			ctx.save();
			ctx.fillStyle = 'rgba(6,6,8,0.26)';
			ctx.fillRect(0, 0, W, H);
			ctx.restore();
		}
	}

	/* ③ 主体：真实画面。**无边框、无圆角、无投影**（见文件头 ①）。 */
	const hr = L.heroRect;
	if (view) {
		ctx.save();
		try { ctx.drawImage(view, hr.x, hr.y, hr.w, hr.h); } catch (e) { logCatch('poster', e); }
		ctx.restore();
	} else if (L.radius > 0) {
		ctx.save();
		roundRectPath(ctx, hr.x, hr.y, hr.w, hr.h, L.radius);
		ctx.fillStyle = mixColor(accent, '#000000', 0.78);
		ctx.fill();
		ctx.restore();
	}

	/* ③b 边缘收敛：内嵌模式下主体与铺底之间会有一条几何缝。
	   这里用一圈极淡的暗角（径向渐变）把注意力压回画面中心，
	   缝在暗角里自然消失 —— 比任何描边都干净。 */
	if (L.hasBackdrop && !L.fullBleed) {
		ctx.save();
		const g = ctx.createRadialGradient(W / 2, H * 0.44, Math.min(W, H) * 0.32,
			W / 2, H * 0.44, Math.max(W, H) * 0.78);
		g.addColorStop(0, 'rgba(6,6,8,0)');
		g.addColorStop(1, 'rgba(6,6,8,0.55)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.restore();
	}

	/* ④ 信息栏
	   ★ 2026-10-06 改版（用户："海报底部信息栏不好看"）。旧版三个问题：
	     ① 栏顶画了一条**主题色渐变横线**，粗且亮，和下面的歌名抢视线；
	     ② 歌名/歌手用 `infoH*0.44`、`+cover*0.34` 的百分比硬定位 ——
	        歌名折成两行时整块就不居中了，上下留白明显不一样；
	     ③ 模式角标画在左缘（正好在封面下方），和封面缩略图挤成一坨。
	   新版：细发丝分隔线代替渐变粗线；文字块按**实测块高**整体垂直居中；
	   角标改成右侧胶囊（并带上主题色，主角色的存在感从横线转移到角标上）。 */
	const I = L.info;
	ctx.save();
	if (L.infoOverlay) {
		/* 叠在画面下缘：渐变把画面压下去，再铺半透明底 */
		const g = ctx.createLinearGradient(0, I.y - 150, 0, I.y + 12);
		g.addColorStop(0, 'rgba(8,8,10,0)');
		g.addColorStop(1, 'rgba(8,8,10,0.94)');
		ctx.fillStyle = g;
		ctx.fillRect(0, I.y - 150, W, 154);
		ctx.fillStyle = 'rgba(8,8,10,0.94)';
		ctx.fillRect(0, I.y, W, I.h);
	} else {
		ctx.fillStyle = '#0e0e11';
		ctx.fillRect(0, I.y, W, I.h);
	}
	/* 发丝分隔线：只做"边界"，不做"装饰" */
	ctx.fillStyle = 'rgba(255,255,255,0.07)';
	ctx.fillRect(0, I.y, W, 1);
	ctx.restore();

	/* ⑤ 封面缩略图（只收圆角，**不加描边**：海报主体"不许有边框"是用户投诉换来的
	   硬约束，由 tests/js/test_lyric_poster.js 钉住 strokes===0 / pathFills===1；
	   层次感改由深色栏底与封面自身的对比承担。） */
	const coverR = Math.round(I.cover * 0.13);
	ctx.save();
	roundRectPath(ctx, I.coverX, I.coverY, I.cover, I.cover, coverR);
	ctx.fillStyle = mixColor(accent, '#000000', 0.7);
	ctx.fill();
	if (cover) {
		ctx.save();
		roundRectPath(ctx, I.coverX, I.coverY, I.cover, I.cover, coverR);
		ctx.clip();
		const cr = coverRect2(cover.width || I.cover, cover.height || I.cover, I.coverX, I.coverY, I.cover, I.cover);
		try { ctx.drawImage(cover, cr.x, cr.y, cr.w, cr.h); } catch (e) { logCatch('poster', e); }
		ctx.restore();
	} else {
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `${Math.round(I.cover * 0.42)}px ${font}`;
		ctx.fillStyle = withAlpha(accent, 0.6);
		ctx.fillText('\u266A', I.coverX + I.cover / 2, I.coverY + I.cover / 2);
	}
	ctx.restore();

	/* ⑥ 模式角标：右侧胶囊（主题色改由它承载）。必须先量它，才能给标题留出宽度。 */
	const badgeText = String((opts && opts.badge) || '');
	const pillTextSize = I.footSize;
	ctx.save();
	ctx.font = `600 ${pillTextSize}px ${font}`;
	const pillPadX = Math.round(pillTextSize * 0.9);
	let pillW = badgeText ? Math.round(ctx.measureText(badgeText).width) + pillPadX * 2 : 0;
	/* 角标太长（如「拾光 · Lyrics」在窄版式里）会把标题挤成一列一个字：宁可不画 */
	if (pillW && pillW > W * 0.32) pillW = 0;
	ctx.restore();

	/* ⑦ 歌名 / 歌手 / 专辑 —— 整块按**实测块高**垂直居中
	   （旧版用 `infoH*0.44`、`+cover*0.34` 的百分比硬定位，歌名一折成两行就不居中） */
	const title = String(song.title || song.name || song.song || '未知曲目');
	const textRight = W - I.padX - (pillW ? pillW + Math.round(pillTextSize * 1.4) : 0);
	const titleUnits = Math.max(6, Math.floor((textRight - I.textX) / (I.titleSize * 0.62)));
	const titleLines = wrapDisplay(title, titleUnits).slice(0, 2);
	const tl = titleLines.length;
	const lineH = Math.round(I.titleSize * 1.18);
	const subH = Math.round(I.artistSize * 1.55);
	const blockTop = I.y + Math.max(0, Math.round((I.h - (tl * lineH + subH)) / 2));
	ctx.save();
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';
	ctx.fillStyle = '#ffffff';
	ctx.font = `700 ${I.titleSize}px ${font}`;
	titleLines.forEach((t, i) => {
		ctx.fillText(t, I.textX, blockTop + i * lineH + Math.round((lineH - I.titleSize) / 2));
	});
	const artist = String(song.artist || song.singer || '未知歌手');
	const album = song.album ? String(song.album) : '';
	ctx.font = `400 ${I.artistSize}px ${font}`;
	let sub = album ? `${artist}   ·   ${album}` : artist;
	/* 副标题超宽就丢掉专辑（只留歌手）——旧版一律拼「歌手 · 专辑」，长名直接糊出边界 */
	if (album && ctx.measureText(sub).width > (W - I.padX - I.textX)) sub = artist;
	ctx.fillStyle = 'rgba(255,255,255,0.58)';
	ctx.fillText(sub, I.textX, blockTop + tl * lineH + Math.round(subH * 0.14));
	ctx.restore();

	/* ⑧ 模式角标：强调色的标签文字（Material 的 label 风格），与标题块第一行对齐、靠右。
	   ★ 不用胶囊底：胶囊需要 path 填充，而「海报主体不得再有边框/额外填充」是用户投诉
	   换来的硬约束（test_lyric_poster.js 钉 pathFills===1）。着色标签同样清楚，
	   且把"主角色"从旧的横线上转移到角标文字上。 */
	if (pillW) {
		ctx.save();
		ctx.font = `700 ${pillTextSize}px ${font}`;
		ctx.fillStyle = withAlpha(accent, 0.92);
		ctx.textAlign = 'right';
		ctx.textBaseline = 'top';
		ctx.fillText(badgeText, W - I.padX, blockTop + Math.round((lineH - pillTextSize) / 2));
		ctx.textAlign = 'left';
		ctx.textBaseline = 'alphabetic';
		ctx.restore();
	}

	/* ⑨ 水印：右下角「Logo + 文字」。
	   ★ 上一版水印在左下角、纯文字、没有图标，用户点名三条：位置换到右下、
	   字号/字重难看、没有 Logo。这一版保持右下「图标 + 文字」，并把不透明度压到
	   0.44 —— 水印是署名，不该和歌名抢层级。 */
	const footText = String((opts && opts.footer) || 'Aria');
	let drewLogo = false;
	ctx.save();
	ctx.font = `600 ${I.footSize}px ${font}`;
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	const footYc = I.y + I.h - Math.round(I.footSize * 1.05);
	const footW = ctx.measureText(footText).width;
	const rightX = W - I.padX;
	if (logo) {
		const ls = I.logoSize;
		const lx = rightX - footW - Math.round(ls * 0.42) - ls;
		try {
			ctx.save();
			roundRectPath(ctx, lx, footYc - ls / 2, ls, ls, Math.round(ls * 0.24));
			ctx.clip();
			const lsz = srcSize(logo, ls, ls);
			const lr = coverRect2(lsz.w, lsz.h, lx, footYc - ls / 2, ls, ls);
			ctx.drawImage(logo, lr.x, lr.y, lr.w, lr.h);
			ctx.restore();
			drewLogo = true;
		} catch (e) { logCatch('poster', e); }
	}
	ctx.fillStyle = 'rgba(255,255,255,0.44)';
	ctx.fillText(footText, rightX, footYc);
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	ctx.restore();

	return { drewView: !!view, drewBackdrop, drewLogo, titleLines: tl };
}

/* ============================ 浏览器：加载位图 / 合成 / 保存 ============================ */

export function imageFromSource(src, crossOrigin = false, timeoutMs = 8000) {
	return new Promise((resolve) => {
		if (typeof Image === 'undefined' || typeof src !== 'string' || !src) { resolve(null); return; }
		let done = false;
		const img = new Image();
		if (crossOrigin) img.crossOrigin = 'anonymous';
		const finish = (v) => { if (!done) { done = true; resolve(v); } };
		img.onload = () => finish(img.naturalWidth > 0 ? img : null);
		img.onerror = () => finish(null);
		setTimeout(() => finish(null), Math.max(500, Number(timeoutMs) || 8000));
		img.src = src;
	});
}

/** 加载封面，保证不污染画布：远程图一律先走同源代理。 */
export async function loadCoverImage(rawUrl, timeoutMs = 6000) {
	const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
	if (!url) return null;
	if (/^(data|blob):/i.test(url)) return imageFromSource(url, false, timeoutMs);
	const list = /^https?:\/\//i.test(url) ? [`/proxy?url=${encodeURIComponent(url)}`, url] : [url];
	for (const c of list) {
		const img = await imageFromSource(c, true, timeoutMs);
		if (img) return img;
	}
	return null;
}

let _logoPromise = null;
/** 应用图标（水印用）。进程内只加载一次 —— 每张海报都重新 new Image 会白等一轮。 */
export function loadLogoImage(url = POSTER_LOGO_URL) {
	if (_logoPromise) return _logoPromise;
	_logoPromise = imageFromSource(url, false, 3000).catch(() => null);
	return _logoPromise;
}

function canvasToBlob(canvas, type = 'image/png', quality) {
	return new Promise((resolve, reject) => {
		try { canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 返回空'))), type, quality); }
		catch (e) { reject(e); }
	});
}

/* 封面 / Logo 都是**跨调用可复用**的资源，海报一张接一张生成时不该重复下网络。 */
const _imgCache = new Map();

async function cached(key, loader) {
	if (_imgCache.has(key)) return _imgCache.get(key);
	const p = loader();
	_imgCache.set(key, p);
	return p;
}

export function clearPosterImageCache() { _imgCache.clear(); _logoPromise = null; }

/**
 * 合成海报。
 * @param {object} opts
 * @param {'native'|'square'|'story'} [opts.frame]
 * @param {HTMLCanvasElement|HTMLImageElement} opts.view 由 `domSnapshot.snapshotElement` 得来的真实画面
 * @param {string} [opts.mode] 当前视图模式（决定铺满 / 内嵌，见 `FULL_BLEED_MODES`）
 * @param {number} [opts.dpr=2]
 * @returns {Promise<{blob:Blob, canvas:HTMLCanvasElement, frame:object, layout:object, info:object}>}
 */
export async function composePoster(opts) {
	if (typeof document === 'undefined') throw new Error('composePoster 需要浏览器环境');
	const o = opts || {};
	if (!o.view) throw new Error('缺少画面：请先调用 domSnapshot.snapshotElement');
	const frame = posterFrameFor(o.frame);
	const viewW = o.view.width || o.view.naturalWidth || 1280;
	const viewH = o.view.height || o.view.naturalHeight || 720;
	const layout = layoutFor(frame.id, viewW, viewH, o.mode);
	const dpr = Math.max(1, Math.min(3, Number(o.dpr) || 2));

	const canvas = document.createElement('canvas');
	canvas.width = Math.round(layout.W * dpr);
	canvas.height = Math.round(layout.H * dpr);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('无法创建 2D 上下文');
	ctx.scale(dpr, dpr);

	const cover = o.cover !== undefined
		? o.cover
		: await cached(`cover:${o.coverUrl || ''}`, () => loadCoverImage(o.coverUrl, o.coverTimeoutMs));
	const logo = o.logo !== undefined ? o.logo : await cached('logo', () => loadLogoImage());
	const info = drawPoster(ctx, Object.assign({}, o, { layout, cover: cover || null, logo: logo || null, view: o.view }));
	const blob = await canvasToBlob(canvas, o.mime || 'image/png', o.quality);
	return { blob, canvas, frame, layout, info, coverLoaded: !!cover, logoLoaded: !!logo };
}

/** 存到本地（`<a download>`，Tauri / 浏览器都稳）。 */
export async function saveBlob(blob, filename) {
	if (typeof document === 'undefined' || !blob) return false;
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = filename || 'poster.png';
		a.rel = 'noopener';
		document.body.appendChild(a);
		a.click();
		a.remove();
		return true;
	} catch (e) {
		logCatch('poster', e);
		return false;
	} finally {
		setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { logCatch('poster', e); } }, 4000);
	}
}
