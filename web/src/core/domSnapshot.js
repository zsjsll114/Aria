/**
 * domSnapshot.js — 把真实 DOM 子树光栅化成图（歌词海报的底座）
 *
 * ★ 为什么必须自己做：歌词视图是 **DOM 渲染**的（PV/词云/飞白/活字 都是 DOM 文本节点，
 *   连"背景画布"也只是 2D canvas），**根本不存在一张可截的完整画布**。
 *   想拿到"用户此刻看到的画面"，只有把 DOM 交给浏览器自己去光栅化——也就是
 *   `<svg><foreignObject>` 这条路（html2canvas / dom-to-image 用的同一原理）。
 *
 * 三个必踩的坑（都在这里处理了）：
 *   ① **外部 CSS 不生效**：SVG 作为独立图片加载时不会去拉 `<link>` 样式表，
 *      class / id 全部作废 ⇒ 必须逐元素把 `getComputedStyle` 内联进 style 属性。
 *   ② **canvas 不会被序列化**：`cloneNode` 只复制标签不复制像素 ⇒ 要换成 `<img src=dataURL>`。
 *      WebGL 画布 `toDataURL()` 在 `preserveDrawingBuffer:false` 下是空的 ⇒
 *      由注册进来的 **canvas 快照提供者**（`registerCanvasSnapshot`）在「同一任务内」先
 *      `renderer.render()` 再 `toDataURL()`。
 *   ③ **跨域图片会污染画布**：一旦污染，`toBlob` 直接抛 SecurityError ⇒ 图片一律走
 *      同源 `/proxy?url=` 换 dataURL，失败就退成透明像素（宁可少一张图，不能出不了图）。
 *
 * 纯函数与浏览器函数分开，前者可在 node 直接测（见 tests/js/test_dom_snapshot.js）。
 */

import { logWarn, logCatch } from '../services/log.js';

/** 会内联的 CSS 属性白名单（挑影响绘制与布局的那些；全量内联会让 SVG 体积与耗时翻几倍） */
export const INLINE_PROPS = [
	'display', 'position', 'top', 'left', 'right', 'bottom',
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
	'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
	'justify-content', 'align-items', 'align-self', 'align-content', 'place-items',
	'gap', 'row-gap', 'column-gap',
	'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-column', 'grid-row',
	'order', 'z-index',
	'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
	'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
	'text-transform', 'text-decoration-line', 'text-shadow', 'text-overflow', 'text-wrap',
	'white-space', 'word-break', 'overflow-wrap', 'writing-mode', 'direction',
	'color', 'background-color', 'background-image', 'background-size', 'background-position',
	'background-repeat', 'background-clip', '-webkit-background-clip', '-webkit-text-fill-color',
	'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
	'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
	'box-shadow', 'opacity', 'filter', 'transform', 'transform-origin',
	'mix-blend-mode', 'isolation', 'object-fit', 'object-position', 'clip-path',
	'vertical-align', 'pointer-events', 'visibility', 'list-style-type', 'outline-width', 'outline-color',
];

/** 1×1 透明 GIF（图片内联失败时的兜底，避免出现破图图标） */
export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ============================ canvas 快照提供者 ============================ */

/**
 * WebGL 画布在 `preserveDrawingBuffer:false` 下 `toDataURL()` 是空白。
 * 引擎可以注册一个「给我这张画布的快照」函数：内部先同步 `render()` 再立刻 `toDataURL()`，
 * 全部在**同一个任务**里完成（await 一次就清空 backbuffer）。
 * @type {Array<(canvas: HTMLCanvasElement) => (string|null)>}
 */
const _canvasSnapshots = [];

/** 注册一个快照提供者；返回注销函数。 */
export function registerCanvasSnapshot(provider) {
	if (typeof provider !== 'function') return () => {};
	_canvasSnapshots.push(provider);
	return () => {
		const i = _canvasSnapshots.indexOf(provider);
		if (i >= 0) _canvasSnapshots.splice(i, 1);
	};
}

/** 依次问每个提供者要快照；谁先给出非空结果就用谁。 */
export function snapshotCanvas(canvas) {
	for (const p of _canvasSnapshots) {
		try {
			const url = p(canvas);
			if (typeof url === 'string' && url.length > 64) return url;
		} catch (e) { logCatch('domSnapshot', e); }
	}
	return null;
}

/* ============================ 纯函数（可单测） ============================ */

/**
 * 把 computedStyle 里白名单属性拼成一段 cssText。
 * @param {CSSStyleDeclaration|object} cs 任何有 getPropertyValue 的对象（测试可传桩）
 * @param {string[]} [props]
 * @returns {string}
 */
export function cssTextFromComputed(cs, props = INLINE_PROPS, opts = {}) {
	if (!cs || typeof cs.getPropertyValue !== 'function') return '';
	let out = '';
	for (const p of props) {
		if (p === 'position') continue;   /* 统一在末尾规范化，见下 */
		let v;
		try { v = cs.getPropertyValue(p); } catch { continue; }
		if (!v) continue;
		v = String(v).trim();
		if (!v || v === 'none' || v === 'normal' || v === 'auto') continue;
		out += `${p}:${v};`;
	}
	/* ★ position 必须规范化，且**不能**原样带进 SVG：
	   · `static` → `relative`：否则 clone 里那些绝对定位的后代在 SVG 里会跑到别的包含块去；
	   · `fixed` → `absolute`：`fixed` 在 foreignObject 里没有可靠的包含块，会飘到画布外或者
	     被浏览器的视口语义带走。统一成 absolute 后，包含块就落在被我们提成 relative 的根节点上，
     与浏览器里"相对视口 = 相对根节点原点"的结果一致。 */
	let pos;
	try { pos = String(cs.getPropertyValue('position') || '').trim(); } catch { pos = ''; }
	if (opts.keepPosition) {
		/* ★★ 根节点必须**原样保留** static：
		   一旦把克隆体的根（body 克隆）提成 `relative`，它就成了所有绝对定位后代的包含块；
		   而它的高度是 auto（子元素全是绝对定位）⇒ 高度 0 ⇒ 整页塌成一块黑。
		   实测：海报主体直接从有内容变成全黑。
		   保留 static 后，绝对定位后代在 SVG 里挂到 foreignObject 视口上，
		   与浏览器里的初始包含块语义一致。 */
		if (pos) out += `position:${pos};`;
		return out;
	}
	if (pos === 'fixed') out += 'position:absolute;';
	else if (!pos || pos === 'static') out += 'position:relative;';
	else out += `position:${pos};`;
	return out;
}

/** 画布尺寸 → 输出尺寸。scale=2 时输出 2 倍，SVG 仍按 CSS 尺寸布局 ⇒ 文字是矢量放大的。 */
export function outputSize(w, h, scale) {
	const s = Math.max(1, Math.min(4, Number(scale) || 1));
	return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

/** 用 viewBox 放大：SVG 的外框是 W*s，但内部按 W 布局。 */
export function svgShell(innerXml, cssW, cssH, scale) {
	const o = outputSize(cssW, cssH, scale);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.w}" height="${o.h}" `
		+ `viewBox="0 0 ${Math.round(cssW)} ${Math.round(cssH)}" `
		+ `preserveAspectRatio="xMidYMid meet">`
		+ `<foreignObject x="0" y="0" width="${Math.round(cssW)}" height="${Math.round(cssH)}">`
		+ innerXml
		+ '</foreignObject></svg>';
}

/* ============================ 浏览器侧实现 ============================ */

/**
 * 规划阶段：并行遍历源树与克隆体，产出「要写进克隆体的 style」清单。
 *
 * ★★ 样式**必须从克隆体上读**，不能从源元素上读：
 *    `getComputedStyle(源元素)` 会把 `:hover` 的取值一并返回（base.css 里 `.line:hover`
 *    就改了颜色与位移），于是海报上会固定住"用户鼠标正压着的那一行"的高亮 ——
 *    用户实测直接点了这一条。克隆体挂在**离屏舞台**（`pointer-events:none`、
 *    `left:-200000px`）上，永远不会处于 hover 链里，读到的就是干净状态。
 *
 * ★ 两遍走：先全部读完，再统一写回。否则给父元素写了 `position:relative` 之后再读
 *   子元素，读到的是"被我们改过之后"的值，整棵树会一层层歪掉。
 */
function _plan(src, clone, out, hiddenSet, rootRef, gcs) {
	out.count++;
	let cs = null;
	try { cs = (gcs || getComputedStyle)(clone); } catch (e) { logCatch('domSnapshot', e); }
	let hidden = hiddenSet.has(src);
	/* ★★ 白名单式裁剪：只保留 `onlyRoot` 子树 + 它的祖先链 + **负 z-index 的装饰背景层**，
	   其余一律隐藏。比"列一串要隐藏的选择器"可靠得多 —— 弹窗、引导、浮动面板、
	   登录二维码、AI 气泡……这类东西会随版本不断新增，黑名单永远追不上。
	   负 z 号那一条是给 `.blur-background`(z=-2) / `.color-overlay`(z=-1) /
	   `.mv-background`(z=-2) 留的：它们是**画面的一部分**，不是控件。 */
	if (!hidden && out.onlyRoot && cs) {
		const isInScope = out.onlyRoot === src || out.onlyRoot.contains(src);
		const isAncestor = src.contains(out.onlyRoot);
		let isDecor = false;
		if (!isInScope && !isAncestor) {
			try {
				const z = Number.parseInt(cs.getPropertyValue('z-index'), 10);
				const pos = String(cs.getPropertyValue('position') || '').trim();
				isDecor = Number.isFinite(z) && z < 0 && (pos === 'fixed' || pos === 'absolute');
			} catch (e) { logCatch('domSnapshot', e); }
			/* ★★ `opts.alsoKeep`：**画面的一部分、但挂在 body 上**的浮动层。
			   白名单裁剪只认 `.player-container` 子树，于是「飞入模式的背景图形场」
			   （`#view-flyin-wireframes`，`document.body.appendChild`）整层被切掉 ——
			   用户的反馈正是「飞入模式海报没有底部图形」。这类层没法靠 z 号识别
			   （它是 z:0），只能显式点名。 */
			if (!isDecor && out.keepSet && out.keepSet.has(src)) isDecor = true;
		}
		if (!isInScope && !isAncestor && !isDecor) hidden = true;
	}
	if (!hidden) {
		try {
			/* 隐藏与否必须看**源元素**：克隆体在 iframe 里，祖先链不同，display 可能不一样 */
			hidden = String(getComputedStyle(src).getPropertyValue('display') || '').trim() === 'none';
		} catch (e) { logCatch('domSnapshot', e); }
	}
	/* ★ 几何对账（诊断用，`opts.debug` 打开时生效）：把「源元素」与「克隆体」成对记下，
	   布局落定后逐对读 `getBoundingClientRect()` 比对 —— 这是定位「海报主体塌黑 / 画面错位」
	   唯一有效的办法：只看出图只能说"不对"，有了成对矩形才能指出是**哪个**元素跑到了别处。
	   ★ 必须在 `hidden` 分支 return **之前**记：被隐藏的兄弟元素同样占过布局空间，
	   只看留下来的那些永远解释不了"为什么整块内容整体下移了 465px"。 */
	if (out.debugEls) {
		let pk = [0, 0, 0, 0];
		try {
			const r0 = clone.getBoundingClientRect();
			pk = [Math.round(r0.left), Math.round(r0.top), Math.round(r0.width), Math.round(r0.height)];
		} catch { /* 读不到就算了 */ }
		out.debugEls.push([src, clone, _readBox(clone, out.gcs), pk, hidden]);
	}
	if (hidden) {
		out.hidden++;
		/* ★ 2026-10-06 试过把这里从 `display:none` 改成「保留布局」的
		   `visibility:hidden + opacity:0`，想修「飞入海报主画面全黑」——
		   **实测没有修好**（整张画布依旧 0 亮像素），故按"未验证的改动不留"的原则回滚。
		   已确认的线索留给下一轮：把 `HIDE_SELECTORS` 的前 7 条
		   （#appTitlebar / .app-titlebar / .top-action-buttons / .controls-area /
		     .bottom-control-bar / .line-time / #addToPlaylistBtn）
		   单独拿去 hide 就会让字消失（行为二分：全 hide → 0，无 hide → 1261，
		   后 7 条 → 1185），而这 7 条里没有任何一条是 `.lyrics-area-wrapper` 的祖先。 */
		out.plan.push([clone, 'display:none !important;']);
		return;
	}
	if (out.trackSrc && src === out.trackSrc) out.trackClone = clone;
	let css = '';
	try { css = cssTextFromComputed(cs, INLINE_PROPS, { keepPosition: src === rootRef }); } catch (e) { logCatch('domSnapshot', e); }
	/* 泄漏哨兵：源里是 fixed 定位且可见的元素。它们在 SVG 里"无处安放"，一个都不该留着。 */
	try {
		if (String(getComputedStyle(src).getPropertyValue('position') || '').trim() === 'fixed') out.fixed.push(src);
	} catch (e) { logCatch('domSnapshot', e); }
	out.plan.push([clone, css]);
	const sk = src.children;
	const ck = clone.children;
	if (!sk || !ck) return;
	const n = Math.min(sk.length, ck.length);
	for (let i = 0; i < n; i++) _plan(sk[i], ck[i], out, hiddenSet, rootRef, gcs);
}

/** 在源树上把要隐藏的元素先找出来（用 Element 引用，绕开"clone 已无 id"的问题）。 */
export function collectHidden(root, selectors) {
	const set = new Set();
	if (!root || !Array.isArray(selectors)) return set;
	for (const sel of selectors) {
		let list;
		try { list = root.querySelectorAll(sel); } catch { continue; }
		for (const el of list) set.add(el);
	}
	return set;
}

/**
 * 收集「命中选择器的元素 **及其整棵子树**」。
 * ★ 必须连子树一起收集：白名单裁剪是逐节点的，只放行根节点的话，
 *   它的子元素仍然"不在 `.player-container` 里"，会被当场隐藏 ——
 *   结果是一个空壳层，等于没保留。
 */
export function collectSubtrees(root, selectors) {
	const set = new Set();
	if (!root || !Array.isArray(selectors)) return set;
	for (const sel of selectors) {
		let list;
		try { list = root.querySelectorAll(sel); } catch { continue; }
		for (const el of list) {
			set.add(el);
			try { el.querySelectorAll('*').forEach((e) => set.add(e)); } catch { /* 忽略 */ }
		}
	}
	return set;
}

/**
 * 内联 `background-image: url(...)`。
 * ★ 这是「海报没背景」的根因：App 的模糊封面底是背景图层，用的是
 *   `background-image: url(https://…)`。SVG 作为独立图片加载时**不会去联网取外部资源**，
 *   相对 URL 也解析不了；跨域的还会污染画布。必须全部换成 dataURL。
 */
async function _inlineBackgroundImages(cloneRoot) {
	const nodes = cloneRoot.querySelectorAll('[style*="url("]');
	const cache = new Map();
	let replaced = 0;
	let failed = 0;
	for (const el of nodes) {
		const style = el.getAttribute('style') || '';
		if (!style.includes('url(')) continue;
		const urls = [...style.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map(m => m[2]);
		let next = style;
		for (const u of urls) {
			if (!u || u.startsWith('data:') || u.startsWith('#')) continue;
			let du = cache.get(u);
			if (du === undefined) {
				du = await _fetchAsDataUrl(u);
				cache.set(u, du);
			}
			if (du) { next = next.split(`url(${u})`).join(`url("${du}")`); replaced++; }
			else { failed++; }
		}
		/* 取不到的背景直接摘掉：留着会让 SVG 去联网（必然失败），不如干净地没有 */
		if (next !== style) {
			next = next.replace(/url\((['"]?)(?![d#])[^'")]*\1\)/g, 'none');
			el.setAttribute('style', next);
		}
	}
	return { bgReplaced: replaced, bgFailed: failed };
}

/* ★ 抓取结果按 URL 缓存（含失败）：连拍几张海报 / 同一首歌反复生成时，
   封面与背景图不该每次都过一遍网络。失败也缓存，避免反复等超时。 */
const _dataUrlCache = new Map();

export function clearDataUrlCache() { _dataUrlCache.clear(); }

async function _fetchAsDataUrl(raw) {
	if (_dataUrlCache.has(raw)) return _dataUrlCache.get(raw);
	let fetchUrl = raw;
	try {
		const abs = new URL(raw, location.href);
		fetchUrl = abs.origin === location.origin ? abs.href : `/proxy?url=${encodeURIComponent(abs.href)}`;
	} catch { /* 解析不了就原样试 */ }
	try {
		const pr = await fetch(fetchUrl);
		if (!pr.ok) throw new Error(`fetch ${pr.status}`);
		const b = await pr.blob();
		/* ★ 大图必须缩：内联进 SVG 的是 base64，体积是原图的 1.33 倍，
		   而整份 SVG 会作为 data: URL 交给浏览器解析 —— 实测一张 1.7MB 的 PNG
		   能把 SVG 顶到 18MB，解析明显变慢。长边压到 1600、转 JPEG 就足够海报用了。 */
		if (b.size > 1_200_000) {
			const shrunk = await _shrinkToDataUrl(b, 1600, 0.86);
			if (shrunk) { _dataUrlCache.set(raw, shrunk); return shrunk; }
		}
		const du = await new Promise((res, rej) => {
			const f = new FileReader();
			f.onload = () => res(String(f.result));
			f.onerror = () => rej(new Error('read fail'));
			f.readAsDataURL(b);
		});
		const out = (du && du.length > 64) ? du : null;
		_dataUrlCache.set(raw, out);
		return out;
	} catch (e) {
		_failedUrls.push(String(raw).slice(0, 120));
		logCatch('domSnapshot', e);
		_dataUrlCache.set(raw, null);
		return null;
	}
}

/** 把大图缩到长边 `maxEdge` 再重编码；失败返回 null（调用方退回原图）。 */
async function _shrinkToDataUrl(blob, maxEdge, quality) {
	try {
		const bmp = await createImageBitmap(blob);
		const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
		const w = Math.max(1, Math.round(bmp.width * scale));
		const h = Math.max(1, Math.round(bmp.height * scale));
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const cx = c.getContext('2d');
		if (!cx) return null;
		cx.drawImage(bmp, 0, 0, w, h);
		try { bmp.close(); } catch { /* 老浏览器没有 close */ }
		/* ★ 不能无条件转 JPEG：原图可能是带透明的 PNG，拍平会变成黑块。 */
		return _encodeCanvasBest(c, quality);
	} catch (e) {
		logCatch('domSnapshot', e);
		return null;
	}
}

const _failedUrls = [];

/**
 * ★★ `scope`（= 白名单保留的那棵子树）之外的元素**一律不处理**：
 *   海报场景用的是 `onlyWithin`，页面上绝大多数节点都会被隐藏，
 *   但"页面里所有 img/canvas"里仍有头像、HSV 取色器、录音频谱……
 *   每张海报都为它们走一遍网络抓取 + base64 内联，是「生成一张 10 秒」的主要来源。
 *   被隐藏的节点反正看不见，跳过它们只是省时间，产物一模一样。
 */
function _inScope(el, scope) {
	return !scope || scope === el || scope.contains(el);
}

/**
 * 判断画布四角是否不透明。不透明 ⇒ 是整屏背景层，可以走 JPEG；
 * 有透明 ⇒ 是叠加层，必须保留 alpha（JPEG 会把透明处拍成黑块）。
 */
function _cornersOpaque(ctx, w, h) {
	try {
		const px = ctx.getImageData(0, 0, w, h).data;
		const at = (x, y) => px[(y * w + x) * 4 + 3];
		const m = Math.max(1, Math.round(Math.min(w, h) * 0.06));
		for (const [x, y] of [[m, m], [w - 1 - m, m], [m, h - 1 - m], [w - 1 - m, h - 1 - m]]) {
			if (at(x, y) < 250) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * 按「有没有透明」挑最省的编码。
 * ★★ 为什么要动这一步：视觉模式的整屏画布（`dim-shapes-canvas` / 凝彩的 WebGL 画布）
 *   经 `toDataURL('image/png')` 出来是 2~3MB 的 base64，整份 SVG 随之涨到 3.8MB。
 *   而 SVG 是当 data: URL 交给浏览器解析的 —— 解析 3.8MB 就是**出图那一下的几秒钟**。
 *   · 不透明 → JPEG：噪点型画面（网点/粒子）体积能掉一个量级；
 *   · 有透明 → WebP（**带 alpha**，Chromium/WebView2 都支持）：比 PNG 小得多又不丢透明。
 *   只有两者都失败才回退 PNG。
 */
function _encodeCanvasBest(c, quality) {
	const cx = c.getContext('2d');
	const opaque = _cornersOpaque(cx, c.width, c.height);
	if (opaque) {
		const j = c.toDataURL('image/jpeg', quality || 0.92);
		if (j && j.startsWith('data:image/jpeg') && j.length > 64) return j;
	} else {
		const w = c.toDataURL('image/webp', quality || 0.92);
		if (w && w.startsWith('data:image/webp') && w.length > 64) return w;
	}
	const p = c.toDataURL('image/png');
	return (p && p.length > 64) ? p : null;
}

/**
 * 把一段图片 dataURL 重新编码（必要时缩到长边 `maxEdge`）。
 * ★★ 这是「生成一张海报要 10 秒」的最大单点：视觉模式的整屏 canvas
 *   出来就是 2~3MB base64，整份 SVG 随之涨到 3.5MB —— 解析这份 SVG 的代价
 *   全部落在出图那一下。
 * ★ 必须「先拿到 dataURL 再缩」，**不能**直接 `drawImage(源 canvas)`：
 *   源画布若是 `preserveDrawingBuffer:false` 的 WebGL，此刻再画只会读到空白
 *   （提供者给的那份 dataURL 才是唯一有效像素）。
 * @returns {Promise<string|null>} 失败返回 null（调用方保留原图）
 */
async function _reencodeImageDataUrl(url, maxEdge, quality) {
	try {
		const img = await _loadSvgImage(url, 4000);
		if (!img || !img.naturalWidth) return null;
		const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
		const w = Math.max(1, Math.round(img.naturalWidth * k));
		const h = Math.max(1, Math.round(img.naturalHeight * k));
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const cx = c.getContext('2d');
		if (!cx) return null;
		cx.drawImage(img, 0, 0, w, h);
		return _encodeCanvasBest(c, quality);
	} catch (e) {
		logCatch('domSnapshot', e);
		return null;
	}
}

async function _replaceCanvases(srcRoot, cloneRoot, scope) {
	const s = srcRoot.querySelectorAll('canvas');
	const c = cloneRoot.querySelectorAll('canvas');
	const n = Math.min(s.length, c.length);
	let ok = 0;
	let blank = 0;
	for (let i = 0; i < n; i++) {
		if (!_inScope(s[i], scope)) continue;
		/* 先问引擎要（WebGL 唯一出路），再退到浏览器自带的 toDataURL */
		let url = snapshotCanvas(s[i]);
		const fromProvider = !!url;
		if (!url) {
			try { url = s[i].toDataURL('image/png'); } catch (e) { logCatch('domSnapshot', e); }
		}
		/* 大画布先重编码再内联：见 `_reencodeImageDataUrl` 的说明（这是 10 秒的元凶）。 */
		if (typeof url === 'string' && url.length > 1_200_000) {
			const small = await _reencodeImageDataUrl(url, 1600, 0.92);
			if (small) url = small;
		}
		/* 全透明 = 没内容（WebGL 未渲染 / 空画布），当破图处理会让画面出现纯色块。
		   ★★ 但**提供者给的快照不能再拿活画布去验证**：`preserveDrawingBuffer:false`
		   的 WebGL 画布此刻 `drawImage` 只会读到空白，会把**有效的**帧判成空帧、
		   整层换成透明像素 —— 画面直接消失。提供者内部已经同步 render 过，
		   拿到非空 dataURL 就说明有内容。 */
		let usable = typeof url === 'string' && url.length > 200;
		if (!fromProvider && usable && s[i].width * s[i].height > 0 && s[i].height * s[i].width <= 4e6) {
			try {
				const t = document.createElement('canvas');
				t.width = 8; t.height = 8;
				const tx = t.getContext('2d');
				tx.drawImage(s[i], 0, 0, 8, 8);
				const d = tx.getImageData(0, 0, 8, 8).data;
				let any = false;
				for (let k = 3; k < d.length; k += 4) { if (d[k] > 6) { any = true; break; } }
				if (!any) usable = false;
			} catch { /* 读不了就按可用处理：宁可当可用，也别把有内容的画布误判成空白 */ }
		}
		if (usable) ok++; else blank++;
		const img = document.createElement('img');
		img.setAttribute('style', c[i].getAttribute('style') || '');
		img.setAttribute('src', usable ? url : TRANSPARENT_PIXEL);
		c[i].parentNode.replaceChild(img, c[i]);
	}
	return { canvases: n, ok, blank };
}

async function _inlineImages(srcRoot, cloneRoot, scope) {
	const s = srcRoot.querySelectorAll('img');
	const c = cloneRoot.querySelectorAll('img');
	const n = Math.min(s.length, c.length);
	let inlined = 0;
	let failed = 0;
	for (let i = 0; i < n; i++) {
		if (!_inScope(s[i], scope)) continue;
		const raw = (s[i] && (s[i].currentSrc || s[i].src || '')) || '';
		if (!raw) { c[i].setAttribute('src', TRANSPARENT_PIXEL); failed++; continue; }
		if (raw.startsWith('data:')) { inlined++; continue; }
		/* ★ 同源图（`/icons/icon.png`、`/api/cover?...`）**不能**送进 `/proxy?url=`：
		   通用代理只吃绝对 URL，相对路径直接失败。而且 SVG 作为 data: URL 图片加载时
		   没有 base，相对路径在里面本来就解析不了 —— 无论同源还是跨源，都必须内联成 dataURL。 */
		const du = await _fetchAsDataUrl(raw);
		if (du) { c[i].setAttribute('src', du); inlined++; }
		else { c[i].setAttribute('src', TRANSPARENT_PIXEL); failed++; }
	}
	return { images: n, inlined, failed };
}

/**
 * 「源里是 fixed 定位、此刻仍然可见」的元素清单。
 * ★ 这是「海报上混进播放控件」的自动哨兵：右下角那颗队列把手（`.plm-toggle`）就是这么被抓出来的。
 *   判定规则：fixed + 可见 + 面积 ≥ 20×20 + **z-index ≥ 0**。
 *   负 z-index 的 fixed 元素是**装饰背景层**（`.blur-background` z=-2 / `.color-overlay` z=-1 /
 *   `.mv-background` z=-2）—— 那本来就是画面的一部分，靠 z 号一刀切开，比维护白名单可靠。
 */
function _describeFixedLeaks(list, limit = 12) {
	const out = [];
	for (const el of list) {
		try {
			if (!el || !el.isConnected) continue;
			const cs = getComputedStyle(el);
			if (cs.display === 'none' || cs.visibility === 'hidden') continue;
			const z = Number.parseInt(cs.zIndex, 10);
			if (Number.isFinite(z) && z < 0) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 20 || r.height < 20) continue;
			const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
			out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`
				+ ` ${Math.round(r.width)}x${Math.round(r.height)}`);
			if (out.length >= limit) break;
		} catch (e) { logCatch('domSnapshot', e); }
	}
	return out;
}

/* ============================ 同源 iframe 暂存区 ============================ */

/**
 * 摘掉克隆体上的 `id` / `class` / `data-index`。
 *
 * ★★ 必须**在所有样式都读完、写完之后**再摘 —— 这是「海报主体塌黑」的直接元凶。
 *   曾经的写法是"边走边摘"（`_plan` 读完当前节点就把它的 id/class 抹掉，再递归子节点），
 *   后果是**祖先/后代选择器在克隆体里集体失配**：本 App 的视图模式规则全是
 *   `.player-container.view-lyrics .player-controls-wrapper { display:none }` 这种形式，
 *   父节点的 class 一没了，子节点就读不到自己该有的 display。
 *   实测：`.player-controls-wrapper` 本该 `display:none`，被读成 `display:flex`，
 *   凭空占掉 **397×465** 并作为 `.player-container`（flex column）的第一个 flex 项，
 *   把整条 `.lyrics-area-wrapper → .lyrics-container` 推到 y=465 之外 ——
 *   海报主体于是整块塌黑，只剩一条错位的背景竖带。
 *   摘 id/class 本身只是为了产物干净，**与布局无关**，所以放到最后统一做。
 */
function _stripIdentifiers(root) {
	const strip = (el) => {
		try {
			el.removeAttribute('id');
			el.removeAttribute('class');
			el.removeAttribute('data-index');
		} catch (e) { logCatch('domSnapshot', e); }
	};
	strip(root);
	let list;
	try { list = root.querySelectorAll('[id],[class],[data-index]'); } catch { return; }
	for (const el of list) strip(el);
}

/** 诊断用：读一个元素的「盒模型关键项」。`gcs` 不传就用本页的 getComputedStyle。 */
const BOX_PROPS = [
	'display', 'position', 'width', 'height', 'min-height', 'max-height',
	'flex', 'flex-grow', 'flex-basis', 'flex-direction', 'align-self', 'align-items',
	'overflow', 'overflow-y', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom',
	'padding-left', 'padding-right', 'gap', 'box-sizing', 'transform', 'top', 'left',
];
function _readBox(el, gcs) {
	const out = {};
	try {
		const cs = (gcs || getComputedStyle)(el);
		for (const p of BOX_PROPS) {
			const v = String(cs.getPropertyValue(p) || '').trim();
			/* 只留"有信息量"的：默认值不记，输出才看得清 */
			if (!v || v === '0px' || v === 'auto' || v === 'normal' || v === 'static') continue;
			out[p] = v;
		}
	} catch { /* 读不到就算了 */ }
	return out;
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function _attrText(el) {
	try {
		return [...el.attributes].map(a => ` ${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`).join('');
	} catch { return ''; }
}

function _waitFrameStyles(doc, timeoutMs = 3000) {
	const links = [...doc.querySelectorAll('link[rel="stylesheet"]')];
	if (!links.length) return Promise.resolve();
	return new Promise((resolve) => {
		let left = links.length;
		let done = false;
		const tick = () => { if (!done && --left <= 0) { done = true; resolve(); } };
		for (const l of links) {
			l.addEventListener('load', tick, { once: true });
			l.addEventListener('error', tick, { once: true });
		}
		setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
	});
}

/**
 * 把克隆体放进一个**离屏同源 iframe** 里读样式。
 *
 * ★★ 为什么非这样不可（两条都是实测踩出来的）：
 *   ① **不能从源元素读** —— `getComputedStyle(源元素)` 会把 `:hover` 的取值一起返回。
 *      base.css 的 `.line:hover` 是 `transform: scale(1.05)`，海报上会把鼠标压着的那一行
 *      定格成放大态。而 Chromium **只在真实鼠标事件时才重算 hover**：实测
 *      「根节点 pointer-events:none」「hover 链上逐个 pointer-events:none」
 *      「临时 visibility:hidden」「临时 display:none」四种手段全都不生效。
 *      iframe 里根本没有指针，`:hover` 天然不成立 —— 这是唯一可靠的路子。
 *   ② **不能把克隆体挂在普通 <div> 下** —— 这个 App 的 CSS 大量写
 *      `html#ariaRoot …` / `body.perf-low …` 这类祖先选择器，克隆体一离开原来的
 *      html/body，整套规则失配，布局直接塌成黑（实测）。
 *      所以 iframe 里要**原样复制 html/body 的属性**（id / class / style / data-*），
 *      并把所有 `<link rel=stylesheet>` 与 `<style>` 一起搬过去。
 *
 * @returns {Promise<{frame:HTMLIFrameElement, win:Window, doc:Document}|null>}
 */
async function _stageInFrame(clone, cssW, cssH) {
	try {
		const frame = document.createElement('iframe');
		frame.setAttribute('aria-hidden', 'true');
		frame.setAttribute('tabindex', '-1');
		frame.style.cssText = `position:fixed;left:-200000px;top:0;width:${cssW}px;height:${cssH}px;`
			+ 'border:0;pointer-events:none;';
		document.body.appendChild(frame);
		const doc = frame.contentDocument;
		const win = frame.contentWindow;
		if (!doc || !win) { frame.remove(); return null; }
		/* base 用本页 URL —— iframe 里相对路径（字体/图片）要靠它解析。
		   属性值一律按 HTML 属性转义，不用模板插值直接拼。 */
		const baseHref = String(location.href).replace(/[&<>"]/g, (c) => HTML_ESCAPE[c]);
		doc.open();
		doc.write('<!doctype html><html' + _attrText(document.documentElement) + '>'
			+ '<head><base href="' + baseHref + '"></head>'
			+ '<body' + _attrText(document.body) + '></body></html>');
		doc.close();
		/* 把页面上的样式整份搬过去（link 同源，走缓存，很快） */
		for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
			try { doc.head.appendChild(node.cloneNode(true)); } catch (e) { logCatch('domSnapshot', e); }
		}
		/* ★★★ 冻结过渡 —— 这条是「类加对了、画面还是空白」的根因。
		   `getComputedStyle` 读的是**此刻**的值，而 CSS transition 会让「刚加上的类」
		   从旧值**慢慢**过渡到新值 ⇒ 抓帧读到的是过渡的**起始帧**。
		   实测：给飞入的行补上 `.active`（本意是让它显形）之后立刻读，
		   `.line` 的 opacity 是 `0.981617`、`.word` 还是 `0` —— 海报上依然一片空白。
		   这不是"类没加上"，是"还没到"。过渡只决定"何时到达"，不决定"到达什么"，
		   对一张静态快照一律关掉即可；顺带把"正好卡在淡出中途的行"也拉到终值。
		   ★ **只关过渡、不关动画**：动画的当前帧就是真实画面（飞入的旋转图形场靠它转），
		     关掉反而变样；而过渡永远只是"过程"，没有画面意义。 */
		try {
			const freeze = doc.createElement('style');
			freeze.textContent = '*,*::before,*::after{transition:none !important;transition-delay:0s !important;}';
			doc.head.appendChild(freeze);
		} catch (e) { logCatch('domSnapshot', e); }
		doc.body.appendChild(clone);
		await _waitFrameStyles(doc, 3000);
		/* 让布局与字体落定 */
		await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
		/* ★ 2026-10-06 排查记录（未修好，故不留改动）：
		   飞入海报主画面全黑 = 补态加的 `.active` 没能让那一行显形。
		   已定位到**很窄的一步**：`_plan` 给那一行内联的样式里
		     `visibility:visible`（说明 `.view-flyin .line.active` 确实生效了）
		     但 `opacity:0`（`.view-flyin .line.active{opacity:1!important}` 是 (0,3,0)，
		     本该压过 `.view-flyin .line{opacity:0!important}` 的 (0,2,0)）。
		   而 `INLINE_PROPS` 含 `opacity`，一旦内联成 0 就被永久冻住（setAttribute 整段替换）⇒ 黑。
		   已排除：① `HIDE_SELECTORS`（先前"二分"量到的 1265 亮像素其实全是顶栏/底控栏，
		     不是歌词 —— 这是那次测量的自我更正，详见 207 行注释）；
		     ② 过渡未走完（在本轮 rAF 之后对 `doc.getAnimations()` 里的 CSSTransition
		     调 `finish()` 再量，内联值仍是 0）；
		     ③ viewmode.css 里仅有的两条 `opacity:0!important` 都不该赢。
		   下一步（一条命令可定）：在暂存 iframe 的 **plan 时刻**，遍历 `doc.styleSheets` 找出
		   所有「选择器匹配该行且声明了 opacity」的规则，按特异性+顺序排出真正的赢家；
		     同时打印 `doc.getAnimations()` 的数量。脚本骨架见 scratch/_clone_after_stage.py。 */
		return { frame, win, doc };
	} catch (e) {
		logCatch('domSnapshot', e);
		return null;
	}
}

function _loadSvgImage(url, timeoutMs = 8000) {
	return new Promise((resolve) => {
		let done = false;
		const img = new Image();
		const finish = (v) => { if (!done) { done = true; resolve(v); } };
		img.onload = () => finish(img.naturalWidth > 0 ? img : null);
		img.onerror = () => finish(null);
		setTimeout(() => finish(null), timeoutMs);
		img.src = url;
	});
}

/**
 * 把 DOM 子树光栅化。
 * @param {Element} root
 * @param {object} [opts]
 * @param {number} [opts.scale=2]     输出倍率（SVG 矢量放大，文字不会糊）
 * @param {string[]} [opts.hide]      在这个子树里要隐藏的选择器（播放控件等）
 * @param {number} [opts.width]       指定布局宽（默认 root.clientWidth）
 * @param {number} [opts.height]      指定布局高（默认 root.clientHeight）
 * @param {Element} [opts.trackElement] 诊断用：回读该元素在 iframe 里的 computedStyle
 *                                     （用于验收「拍照时 hover 有没有被带进去」）
 * @param {string} [opts.onlyWithin]  只保留这个选择器命中的子树（+祖先链 +负 z 背景层），
 *                                    其余全部隐藏。海报场景必用：弹窗/引导/浮动件会被一刀切掉。
 * @returns {Promise<{canvas:HTMLCanvasElement, dataURL:string, width:number, height:number,
 *   cssWidth:number, cssHeight:number, stats:object}|null>} 失败返回 null
 */
export async function snapshotElement(root, opts = {}) {
	if (typeof document === 'undefined' || !root) return null;
	const cssW = Math.max(1, Math.round(Number(opts.width) || root.clientWidth || 0));
	const cssH = Math.max(1, Math.round(Number(opts.height) || root.clientHeight || 0));
	if (!cssW || !cssH) { logWarn('domSnapshot', '目标元素尺寸为 0，放弃快照'); return null; }

	_failedUrls.length = 0;
	const clone = root.cloneNode(true);
	const stats = { count: 0, hidden: 0, plan: [], fixed: [], trackSrc: opts.trackElement || null };
	if (opts.debug) stats.debugEls = [];
	if (opts.onlyWithin) {
		try {
			stats.onlyRoot = root.querySelector(opts.onlyWithin) || null;
			/* ★ 诊断口：白名单根是谁。为 null 时"只保留 xx 子树"整条规则会静默失效 ——
			   表现是整页 3000 个节点全部被保留并逐节点内联样式（SVG 直接 5MB、生成 10 秒），
			   而且**不报错**。留一个字符串给人看，别让它再隐形。 */
			const r = stats.onlyRoot;
			stats.scope = r ? `${r.tagName.toLowerCase()}${r.id ? '#' + r.id : ''}${typeof r.className === 'string' && r.className.trim() ? '.' + r.className.trim().split(/\s+/)[0] : ''}` : null;
			/* ★ 白名单根没找到 = 整条裁剪规则静默失效（全页数千节点全部逐节点内联样式，
			   SVG 5MB、生成十秒，且**不报错**）。这种状态必须留痕，否则只能靠人肉发现变慢。 */
			if (!r) logWarn('domSnapshot', `onlyWithin "${opts.onlyWithin}" 没找到任何元素 —— 白名单裁剪失效，本次快照会包含整页`);
		} catch (e) { logCatch('domSnapshot', e); }
	}
	/* 白名单之外的「画面层」：挂在 body 上但属于画面（飞入的图形场等），见 `_plan` 的说明 */
	if (Array.isArray(opts.alsoKeep) && opts.alsoKeep.length) stats.keepSet = collectSubtrees(root, opts.alsoKeep);

	/* 同源 iframe 暂存：既清掉 :hover，又保住 html/body 祖先选择器（见 _stageInFrame 注释） */
	const staged = await _stageInFrame(clone, cssW, cssH);
	if (!staged) return null;
	const gcs = staged.win.getComputedStyle.bind(staged.win);

	/* ★★ 根节点的尺寸必须在**读样式之前**钉死 —— 这是「海报主体塌黑」的真正根因。
	   克隆体是 `body` 的副本，而真机上 body 的高度是定值（视口高），克隆体看到的却是 auto：
	   暂存 iframe 里没有"视口语义"，`height:100%` 的根就成了内容高。于是**整条 `height:100%`
	   链**（本 App 是 `.player-container` → `.lyrics-area-wrapper` → `.lyrics-container`，
	   base.css 里三层全是 `height:100%`）全部按"父级高度未定"解析，读到的 computed 值是错的：
	   实测 `.lyrics-container` 读到 `height:0px`、宽度反而胀到整页宽（1304.58 → 1418），
	   `.lyrics-area-wrapper` 同理（612.83 → 785.97）。
	   这些错值一旦被内联进 style 就被**冻死**，海报主体因此整块塌黑、只剩一条错位的背景竖带。
	   先量后读，整条链就和真机一致了。 */
	try {
		clone.setAttribute('style', `${clone.getAttribute('style') || ''}`
			+ `width:${cssW}px;height:${cssH}px;margin:0;`);
	} catch (e) { logCatch('domSnapshot', e); }

	/* ★★ 起照前的最后一道「布景」钩子 —— 必须在 `_plan` **读 computed 之前**执行，
	   因为 `_plan` 是「读一次、写一次」的：一旦读过，值就被内联冻死了。
	   ★ 它只动**克隆体**，绝不碰真 DOM ⇒ 不会让用户看到任何闪动。
	   用途：有些模式的"好看"状态依赖运行时逐帧挂的类（飞入模式的 `.line.active` /
	   `.word.active` 就是 rAF 按 currentTime 逐个加的）。暂停时、或抓帧恰好落在
	   两帧之间时，这些类不齐 ⇒ 海报里整行 `opacity:0;visibility:hidden`，一片空白。
	   在这里补齐，等价于「把这一行放到它唱完那一刻的样子」。 */
	if (typeof opts.onStaged === 'function') {
		try { stats.stagedApplied = opts.onStaged(clone, root) || 0; } catch (e) { logCatch('domSnapshot', e); }
	}

	try {
		stats.gcs = gcs;
		_plan(root, clone, stats, collectHidden(root, opts.hide), root, gcs);
		for (const [el, css] of stats.plan) {
			if (!css) continue;
			try { el.setAttribute('style', css); } catch (e) { logCatch('domSnapshot', e); }
		}
		stats.plan = undefined;
		stats.keepSet = undefined;
		/* 几何对账：源 vs 克隆体，逐对读矩形。见 `_plan` 里 `debugEls` 的说明。 */
		if (stats.debugEls && stats.debugEls.length) {
			const list = [];
			for (const [srcEl, cloneEl, pw, pk, hid] of stats.debugEls) {
				try {
					const a = srcEl.getBoundingClientRect();
					const b = cloneEl.getBoundingClientRect();
					let bg = '';
					let op = '';
					try {
						const fcs = gcs(cloneEl);
						bg = String(fcs.getPropertyValue('background-color') || '').trim();
						op = String(fcs.getPropertyValue('opacity') || '').trim();
					} catch { /* 读不到就算了 */ }
					list.push({
						t: srcEl.tagName.toLowerCase(),
						id: srcEl.id || '',
						c: (typeof srcEl.className === 'string' ? srcEl.className : '').trim().split(/\s+/).slice(0, 3).join('.'),
						s: [Math.round(a.left), Math.round(a.top), Math.round(a.width), Math.round(a.height)],
						k: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
						bg, op,
						sc: _readBox(srcEl),
						kc: _readBox(cloneEl, gcs),
						pw, pk, hid,
						st: String(cloneEl.getAttribute('style') || '').slice(0, 400),
					});
				} catch (e) { logCatch('domSnapshot', e); }
			}
			stats.debug = list;
		}
		stats.debugEls = undefined;
		stats.gcs = undefined;
		/* 标识属性最后再摘（见 `_stripIdentifiers` 的说明：摘早了会打断祖先/后代选择器） */
		_stripIdentifiers(clone);
		/* 诊断口：把被追踪的源元素在"无 hover 的 iframe"里的取值读回来，
		   供探针断言「拍照时 hover 真的没被带进去」。 */
		if (stats.trackClone) {
			try {
				const tcs = gcs(stats.trackClone);
				stats.trackedStyle = {
					transform: tcs.getPropertyValue('transform'),
					color: tcs.getPropertyValue('color'),
					opacity: tcs.getPropertyValue('opacity'),
					/* ★ `background-color` 才是 `:hover` 最干净的判据：base.css 的 `.line:hover`
					   给它上 `rgba(255,255,255,0.1)`，而普通歌词行是 transparent。
					   只看 `opacity`/`transform` 会误判 —— 当前高亮那行**本来**就是 opacity:1 + scale，
					   与 hover 取值一模一样。 */
					backgroundColor: tcs.getPropertyValue('background-color'),
					filter: tcs.getPropertyValue('filter'),
				};
			} catch (e) { logCatch('domSnapshot', e); }
		}
		stats.trackSrc = undefined;
		stats.trackClone = undefined;
		stats.keepSet = undefined;
		/* 根节点尺寸已在读样式**之前**钉死（见上）—— 这里不再重复设置：
		   写回阶段用的是 computed 值，其中 width/height/margin 已经是钉死后的正确值。 */
	} catch (e) {
		logCatch('domSnapshot', e);
	}

	try {
		const scope = stats.onlyRoot || null;
		/* ★ 分段量体积：SVG 一大，出图就慢，而"大"可能来自四个完全不同的地方
		   （内联样式本身 / canvas 快照 / <img> / background-image）。
		   没有分段数字就只能凭猜优化。 */
		const sizeOf = () => { try { return new XMLSerializer().serializeToString(clone).length; } catch { return 0; } };
		stats.lenPlan = sizeOf();

		const cv = await _replaceCanvases(root, clone, scope);
		stats.canvases = cv.canvases;
		stats.blankCanvases = cv.blank;
		stats.lenCanvas = sizeOf();

		const im = await _inlineImages(root, clone, scope);
		stats.images = im.images;
		stats.inlined = im.inlined;
		stats.failedImages = im.failed;
		stats.lenImgs = sizeOf();

		const bg = await _inlineBackgroundImages(clone);
		stats.bgReplaced = bg.bgReplaced;
		stats.bgFailed = bg.bgFailed;
		stats.failedUrls = _failedUrls.slice(0, 5);
		stats.lenBg = sizeOf();

		stats.fixedLeaks = _describeFixedLeaks(stats.fixed);
		stats.fixed = undefined;

		let xml;
		try { xml = new XMLSerializer().serializeToString(clone); } catch (e) { logCatch('domSnapshot', e); return null; }

		const scale = Math.max(1, Math.min(4, Number(opts.scale) || 2));
		const svg = svgShell(xml, cssW, cssH, scale);
		stats.svgLen = svg.length;
		const img = await _loadSvgImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
		if (!img) { logWarn('domSnapshot', 'SVG 光栅化失败（foreignObject 可能被拒）'); return null; }

		const o = outputSize(cssW, cssH, scale);
		const canvas = document.createElement('canvas');
		canvas.width = o.w;
		canvas.height = o.h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, o.w, o.h);

		let dataURL;
		try { dataURL = canvas.toDataURL('image/png'); } catch (e) {
			/* 被污染 —— 说明有跨域资源没走代理。返回 canvas 无用，直接判失败。 */
			logWarn('domSnapshot', '画布被污染（有跨域资源没走代理）:', e && e.message ? e.message : e);
			return null;
		}
		return { canvas, dataURL, width: o.w, height: o.h, cssWidth: cssW, cssHeight: cssH, stats };
	} catch (e) {
		logWarn('domSnapshot', '快照过程中出错：', e && e.message ? e.message : e);
		return null;
	} finally {
		/* 暂存区必须无条件撤掉 */
		try { staged.frame.remove(); } catch (e) { logCatch('domSnapshot', e); }
	}
}

/**
 * 从一张画布里裁一块出来（用于「抓整页 → 只留播放器那块」）。
 * @param {HTMLCanvasElement} src
 * @param {{x:number,y:number,w:number,h:number}} rect 源矩形（与 src 同一坐标域）
 * @returns {HTMLCanvasElement|null}
 */
export function cropCanvas(src, rect) {
	if (!src || !rect) return null;
	const x = Math.max(0, Math.round(rect.x));
	const y = Math.max(0, Math.round(rect.y));
	const w = Math.min(src.width - x, Math.round(rect.w));
	const h = Math.min(src.height - y, Math.round(rect.h));
	if (w <= 0 || h <= 0) return null;
	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	const ctx = out.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
	return out;
}

/**
 * 采样一张画布，返回「不透明像素占比」与「亮度标准差」。
 * 用于验收：标准差接近 0 说明是纯色（没画上东西）。
 */
export function measureCanvas(canvas, step = 7) {
	if (!canvas) return { opaqueRatio: 0, sd: 0, mean: 0 };
	const ctx = canvas.getContext('2d');
	let data;
	try { data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; } catch { return { opaqueRatio: 0, sd: 0, mean: 0, tainted: true }; }
	let opaque = 0, sum = 0, sum2 = 0, k = 0;
	const stride = 4 * Math.max(1, step);
	for (let i = 0; i + 3 < data.length; i += stride) {
		if (data[i + 3] > 8) opaque++;
		const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
		sum += L; sum2 += L * L; k++;
	}
	if (!k) return { opaqueRatio: 0, sd: 0, mean: 0 };
	const mean = sum / k;
	return {
		opaqueRatio: +(opaque / k).toFixed(4),
		mean: +mean.toFixed(2),
		sd: +Math.sqrt(Math.max(0, sum2 / k - mean * mean)).toFixed(3),
	};
}
