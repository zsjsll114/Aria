/**
 * 304-lyric-poster.js — 歌词海报（需求 2）
 *
 * 「更多」菜单里的入口：把**用户此刻看到的那个画面**（真实歌词模式渲染结果）
 * 加上封面与歌曲信息，合成一张图存到本地。
 *
 * ★★ 与上一版的根本区别：**不再自绘歌词**。上一版画了张"封面 + 歌词 + 歌名"的卡片，
 *    被用户否掉（"不能用现有歌词模式吗"）。现在走真捕获：
 *      ① `core/domSnapshot.js` 把 DOM 真光栅化（真歌词 / 真字体 / 真高亮 / 真背景）；
 *      ② 引擎里的 WebGL 画布（PV/凝彩）由注册的**快照提供者**在「同一任务内
 *         render 后立刻 toDataURL」补上像素（`preserveDrawingBuffer:false` 下这是唯一出路）；
 *      ③ `core/lyricPoster.js` 只做排版：画面当主体 + 同图模糊铺底 + 信息栏。
 *
 * ★ 为什么要抓 `document.body` 再裁到 `.player-container`：
 *   播放器容器**自身背景是透明的**，模糊封面底（`.blur-background` / `.color-overlay` /
 *   `.mv-background`）是它的兄弟层。只抓 `.player-container` 会得到一张"透明底"的图，
 *   贴到深色海报上就丢了 App 原本的氛围 —— 所以抓整页再裁。
 */

import { snapshotElement, cropCanvas, registerCanvasSnapshot, measureCanvas } from '../core/domSnapshot.js';
import { showCtxMenu } from './80-context-menu.js';
import { offerReveal } from '../core/revealPath.js';
import {
	composePoster, saveBlob, posterFileName,
	POSTER_FRAMES, POSTER_DEFAULT_FRAME, posterFrameFor, captureIsRenderable,
} from '../core/lyricPoster.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'lyricPoster';

/** 视图模式 → 海报角标短名（与样式选择器显示名一致） */
const MODE_LABEL = {
	cover: '默认',
	lyrics: '歌词',
	flyin: '飞白',
	wordcloud: '词云',
	pv: '诗镜',
	tempera: '版画',
	tunnel: '格律',
	dimension: '穿行',
	letterpress: '活字',
	neon: '霓虹',
};

/**
 * 海报上不该出现的界面件（按钮 / 进度条 / 标题栏 / 各种浮层）。
 * ★ 只在这个"克隆体"里隐藏，绝不动真实 DOM —— 用户正在听的界面不能被改。
 */
const HIDE_SELECTORS = [
	'#appTitlebar', '.app-titlebar',
	'.top-action-buttons', '.controls-area', '.bottom-control-bar',
	/* ★★ 歌词行右侧那串时间标记（`00:12` 小胶囊）在海报上是纯噪音 —— 用户点名要去掉。
	   它是 `20-lyrics-render.js` 给每一行挂的 `.line-time`。 */
	'.line-time',
	/* 添加到歌单 / 收藏那颗小按钮也很出戏，一起摘掉（只摘海报克隆体，不动真 DOM） */
	'#addToPlaylistBtn', '#favoriteBtn', '.favorite-btn',
	'#mobilePageToggle', '.mobile-lyric-preview', '.mobile-page-toggle',
	'.lyric-offset-control', '.song-source-badge-slot',
	'.audio-rec-body', '.audio-rec-panel', '.sleep-timer-panel',
	'.settings-panel', '.eq-panel', '.view-mode-cards', '.music-drawer',
	'.source-status-list', '.storage-panel', '.storage-panel-host',
	'.ctx-menu', '.aria-dialog', '.aria-dialog-overlay', '.aria-confirm',
	/* ★ 首启引导（OOBE）必须按 **id** 隐藏：它的卡片 class 是 `.aria-oobe-card`，
	   只写 `.aria-oobe` 匹配不到；overlay 更是完全在别的命名空间（实测漏掉它，
	   海报主体整个被语言选择弹窗盖住）。 */
	'#ariaOobeOverlay', '.aria-oobe', '.aria-oobe-card', '.aria-oobe-layout',
	'#welcomeOverlay', '.first-run-guide', '.oobe-overlay',
	'.osd', '.aria-tooltip', '.tooltip', '.aria-toast',
	'.phone-remote-panel', '.diagnostics-panel', '.play-source-panel',
	'.aria-recognize-panel', '.aria-lyric-match', '.aria-artist-page',
	/* 播放队列：右下角那颗圆形把手（`.plm-toggle`）实测会留在海报上，
	   它 `position:fixed; z-index:5050`，不在 `.controls-area` 里，必须单独点名。 */
	'#playlistManagerToggle', '.plm-toggle', '#plmPanel', '.plm-panel', '#plmMask', '.plm-mask',
	/* AI 状态气泡也是 fixed 悬浮件，海报上不需要 */
	'#aiStatusPanel', '.ai-status-panel',
];

/* ★★ 白名单之外的「画面层」：它们挂在 `document.body` 上，不属于 `.player-container`，
   但**是画面本身**。只按 `.player-container` 裁会把它们整层切掉 ——
   用户的投诉「飞入模式海报没有底部图形」就是 `#view-flyin-wireframes` 被切掉造成的
   （`220-shortcuts-viewmode.js:1088` 明确 `document.body.appendChild`）。
   `.blur-background` / `.color-overlay` / `.mv-background` 本来靠负 z 号就能活下来，
   这里再点一次名，是为了规则一旦变化也不会静默丢画面。 */
const VISUAL_LAYERS = [
	'#view-flyin-wireframes', '.view-flyin-wireframes', '.pv-shape-field',
	'.blur-background', '.color-overlay', '.mv-background',
];

/* ============================ 起照前的「布景」 ============================ */

/**
 * 把**克隆体**补到"这一行唱完那一刻"的样子。只动克隆体，真 DOM 一个字节不碰
 * ⇒ 用户不会看到任何闪动。
 *
 * ★★ 为什么飞入模式非补不可：那一模式的可见性完全由运行时逐帧挂的类决定 ——
 *   `.view-flyin .line { opacity:0; visibility:hidden }`，只有 `.line.active` 才显形；
 *   行内 `.word` 也只在唱到那一刻才拿到 `.active`（`57-wordcloud-camera.js` 按
 *   `currentTime` 挨个加）。于是：
 *   · 暂停时 / 抓帧落在两帧之间 → 一行都没有 `.active` ⇒ 海报**整块空白**；
 *   · 即使行是 active 的，没唱到的字 `opacity:0` ⇒ 歌词只剩半句。
 *   两者都不是"海报该有的样子"。这里统一补到"整行已唱完"。
 * ★ 字级微旋转（`rotate(var(--micro-r))`，1.5°/−1°/2°）是逐字内联的 `--micro-*`
 *   自定义属性驱动的，只要字拿到 `.active` 就会生效 —— 这正是"飞入的角度与错落"。
 * @returns {number} 补齐的节点数（诊断用）
 */
function stageForMode(cloneEl) {
	if (!cloneEl) return 0;
	const lines = Array.from(cloneEl.querySelectorAll('.line'));
	if (!lines.length) return 0;
	let line = lines.find((l) => l.classList.contains('active'));
	if (!line) {
		/* 没人在唱（暂停/空闲）：退回"当前行"，再退回第一行 —— 总比整张空白强 */
		const idx = Number(globalThis.activeLineIndex);
		line = lines[Number.isFinite(idx) && idx >= 0 && idx < lines.length ? idx : 0];
		if (!line) return 0;
		line.classList.add('active');
	}
	let n = 1;
	/* ★ 2026-10-06 起**所有模式**都补到"整行已唱完"（此前只补飞入）。
	   用户报的「导出只显示一半」就是这个：逐字高亮是按播放进度铺的 ——
	   `.word-highlight` 用 mask + `--reveal` 百分比只显示到当前唱到的那一帧，
	   所以抓帧抓到的永远是"这半句亮着、后半句还是未唱色"。
	   海报是静态快照，"唱到哪儿"对它没有意义，一律补到唱完：
	     · `.word.active`  → 让逐字动画的字显形（飞入/逐字淡入类模式必需）
	     · `--reveal:100%` → 让逐字高亮的遮罩放开到整行
	   补完这一句就是**完整一句**，而不是半句。 */
	for (const w of line.querySelectorAll('.word')) {
		if (!w.classList.contains('active')) { w.classList.add('active'); n++; }
	}
	for (const h of line.querySelectorAll('.word-highlight')) {
		try { h.style.setProperty('--reveal', '100%'); n++; } catch (e) { logCatch(TAG, e); }
	}

	/* ★★★ 2026-10-06 关键修复：**光加类没用，必须清行内覆盖**。
	   实测根因：飞入模式的歌词显隐**不是 CSS 类控制的**（`viewmode.css` 里没有
	   任何 `.view-flyin .line` 规则），而是物理引擎逐帧写**行内**
	   `el.style.opacity`（57-wordcloud-camera.js:990）与
	   `el.style.visibility='hidden'`（:488/:495，屏外行）。`cloneNode(true)` 会把
	   这些行内值一并复制，而**行内 > 类** —— 于是加上的 `.active` 被压住，
	   克隆体里整行依旧不可见，海报主画面就是**全黑**
	   （实测：飞入抓帧 1884x919 全黑，而同一时刻实时画面正常有字）。
	   所以补态的最后一步是：把当前行的可见性行内值**清空**，让类/默认规则接管。
	   ⚠ 只清 `opacity` 与 `visibility`：`transform` 绝对不清 ——
	   飞入的定位（translate(-50%,-50%)）与逐字倾角全靠它，清了就整行飞出画面。 */
	const clearVisibilityGates = (el) => {
		try {
			if (el.style.opacity) el.style.opacity = '';
			if (el.style.visibility) el.style.visibility = '';
		} catch (e) { logCatch(TAG, e); }
	};
	clearVisibilityGates(line);
	for (const el of line.querySelectorAll('.word, .lrc-original, .lrc-romaji, .lrc-translation')) {
		clearVisibilityGates(el);
	}
	n++;
	return n;
}

/* ============================ WebGL 画布快照提供者 ============================ */

/**
 * ★ `preserveDrawingBuffer:false` 的 WebGL 画布，`toDataURL()` 拿到的永远是空帧。
 *   唯一的路子是：**在同一个任务里**先同步 `render()` 再立刻 `toDataURL()`（中间不能有 await）。
 *   这里给 PV（SonnetEngine）与凝彩（TemperaPixiRuntime）各挂一个提供者。
 */
let _providersReady = false;
async function ensureCanvasProviders() {
	if (_providersReady) return;
	_providersReady = true;
	try {
		const sonnet = await import('../core/visualizers/sonnet/sonnetMode.js');
		registerCanvasSnapshot((cv) => {
			const eng = typeof sonnet.getSonnetEngine === 'function' ? sonnet.getSonnetEngine() : null;
			const app = eng && eng.app;
			if (!app || !app.canvas || app.canvas !== cv || !app.renderer) return null;
			try {
				app.renderer.render(app.stage);
				return cv.toDataURL('image/png');
			} catch (e) { logCatch(TAG, e); return null; }
		});
	} catch (e) { logCatch(TAG, e); }
	try {
		const tempera = await import('../core/visualizers/tempera/temperaMode.js');
		registerCanvasSnapshot((cv) => {
			const rt = typeof tempera.getTemperaRuntime === 'function' ? tempera.getTemperaRuntime() : null;
			const app = rt && rt.app;
			if (!app || !app.canvas || app.canvas !== cv || !app.renderer) return null;
			try {
				app.renderer.render(app.stage);
				return cv.toDataURL('image/png');
			} catch (e) { logCatch(TAG, e); return null; }
		});
	} catch (e) { logCatch(TAG, e); }
}

/* ============================ 状态读取 ============================ */

function hint(msg) {
	try {
		const A = typeof window !== 'undefined' ? window.Aria : null;
		if (A && typeof A.showHint === 'function') { A.showHint(msg); return; }
	} catch (e) { logCatch(TAG, e); }
	logInfo(TAG, msg);
}

function currentAccent() {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
		if (v) return v;
	} catch (e) { logCatch(TAG, e); }
	const p = (typeof window !== 'undefined' && window.coverPalette) || null;
	return (p && p.accent) || '#E8BE6A';
}

function currentSong() {
	const s = (typeof globalThis !== 'undefined' && globalThis.currentSongData) || null;
	if (!s) return null;
	return {
		title: s.title || s.name || s.song || '',
		artist: s.artist || s.singer || '',
		album: s.album || '',
		cover: s.cover || '',
	};
}

function currentCoverUrl(song) {
	if (song && song.cover) return song.cover;
	const el = (typeof document !== 'undefined')
		? (document.getElementById('songCover') || document.getElementById('bottomSongCover'))
		: null;
	return el ? (el.currentSrc || el.src || '') : '';
}

function modeKey() {
	return String((typeof globalThis !== 'undefined' && globalThis.currentViewMode) || 'cover');
}

function modeBadge() {
	return MODE_LABEL[modeKey()] || modeKey();
}

function today() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ============================ 捕获 ============================ */

/** 最近一次捕获的统计（诊断用：`Aria.poster.lastCaptureStats`） */
let _lastCaptureStats = null;

/**
 * 决定「主体画面」该裁哪一块（视口坐标）。
 *
 * ★ 铁律：**文字类模式收窄到歌词区，视觉类模式保留整舞台**。
 *   · 歌词 / 飞白 / 词云：歌词只占舞台的中上部，舞台下方那 20%（底控栏位置）是空的。
 *     不收窄就是在海报里白白塞一条黑边，字也跟着变小 —— 用户原话「放大一点歌词」。
 *   · 诗镜 / 版画 / 格律 / 穿行 / 活字：画面本来就铺满整个舞台，
 *     这时 `.lyrics-area-wrapper` 要么 `display:none`、要么等于整舞台，收窄无意义。
 *   两条判据都必须同时满足才收窄（尺寸占比 + 可见性），避免误裁全屏视觉模式。
 */
function contentRectOf(pc) {
	const pr = pc.getBoundingClientRect();
	const stage = { x: pr.left, y: pr.top, w: pr.width, h: pr.height };
	const la = pc.querySelector('.lyrics-area-wrapper');
	if (!la) return stage;
	let cs;
	try { cs = getComputedStyle(la); } catch { return stage; }
	if (cs.display === 'none' || cs.visibility === 'hidden') return stage;
	if (Number(cs.opacity) < 0.05) return stage;
	const lr = la.getBoundingClientRect();
	if (lr.width < 40 || lr.height < 40) return stage;
	if (lr.width < stage.w * 0.55 || lr.height < stage.h * 0.45) return stage;
	const x = Math.max(stage.x, lr.left);
	const y = Math.max(stage.y, lr.top);
	return {
		x, y,
		w: Math.min(stage.x + stage.w, lr.right) - x,
		h: Math.min(stage.y + stage.h, lr.bottom) - y,
	};
}

/**
 * 抓「当前歌词画面」。
 * ★ `scale` 默认 1.6 而不是 2：海报最长边 1080（方图/竖图）/ 原画幅才需要 1:1。
 *   原来固定 2 倍是把 1418×802 光栅化成 2836×1604（4.5MP）再缩回 1080 ——
 *   SVG 光栅化耗时几乎全在这里，属于纯浪费。1.6 倍已经比方图所需更高。
 * @param {number} [scaleOverride]
 * @returns {Promise<HTMLCanvasElement|null>}
 */
/**
 * 抓帧前把"画布绘字"的视觉引擎补到**整行唱完**的那一刻（P3.5）。
 *
 * ★ 与 DOM 侧的 `stageForMode` 互补、不重叠：DOM 模式（歌词/飞白/词云）可以改**克隆体**，
 *   画布模式改不了 DOM —— 它的字是引擎画在 canvas 上的，只能让引擎**再渲一帧到
 *   "这一行唱完"的时刻**，快照抓到的才是完整的一行（暂停时字常常才亮到一半）。
 * ★ 画布是活的对象，所以顺序必须是「渲一帧 → 抓 → 还原」，而且**还原不能靠猜**：
 *   `stageForPoster()` 返回的闭包会在下一帧按真实播放时间重画（标志位 + 强制帧）。
 * 没有实现该方法的模式（PV/凝彩…）原样抓帧，行为不变。
 */
function stageCanvasForPoster() {
	try {
		const vm = globalThis.mainVisManager;
		const inst = vm && vm.activeInstance;
		if (!inst || typeof inst.stageForPoster !== 'function') return null;
		return inst.stageForPoster() || null;
	} catch (e) {
		logCatch(TAG, e);
		return null;
	}
}

export async function captureView(scaleOverride) {
	if (typeof document === 'undefined') return null;
	await ensureCanvasProviders();
	const pc = document.querySelector('.player-container');
	const body = document.body;
	if (!pc || !body) return null;

	const rect = contentRectOf(pc);
	if (!(rect.w >= 80 && rect.h >= 80)) return null;

	const br = body.getBoundingClientRect();
	const cssW = body.clientWidth || Math.round(br.width);
	const cssH = body.clientHeight || Math.round(br.height);
	const scale = Math.max(1, Math.min(3, Number(scaleOverride) || 1.6));

	const unstage = stageCanvasForPoster();
	let snap = null;
	try {
		snap = await snapshotElement(body, {
		width: cssW,
		height: cssH,
		scale,
		hide: HIDE_SELECTORS,
		/* ★ 只保留播放器那块 + 装饰背景层。弹窗 / 首启引导 / 浮动面板 / 登录二维码
		   这些"会随版本不断增加"的界面件，靠黑名单永远追不完，这里一刀切干净。 */
		onlyWithin: '.player-container',
		/* ★ 但**画面层**要放行：它们挂在 body 上（飞入的图形场就在其中），
		   只按 `.player-container` 裁会把它们整层切掉 —— 见 VISUAL_LAYERS 注释。 */
		alsoKeep: VISUAL_LAYERS,
		/* ★ 起照前给克隆体补上"唱完那一刻"的类（飞入模式否则整行不可见）—— 见 stageForMode */
		onStaged: stageForMode,
		});
	} finally {
		/* ★ 无论抓帧成功与否都要还原：失败时把画面留在补帧上，用户会看到"卡住的一帧" */
		if (unstage) unstage();
	}
	if (!snap) return null;

	/* 裁到主体那块。★ body 的 client 区域与页面坐标可能差一个滚动偏移，
	   这里用 rect 相对 body rect 的差值，二者都是视口坐标，相减即得。 */
	const k = snap.width / snap.cssWidth;
	const cropped = cropCanvas(snap.canvas, {
		x: (rect.x - br.left) * k,
		y: (rect.y - br.top) * k,
		w: rect.w * k,
		h: rect.h * k,
	});
	const out = cropped || snap.canvas;
	_lastCaptureStats = Object.assign({}, snap.stats, { crop: [Math.round(rect.w), Math.round(rect.h)], scale });
	logInfo(TAG, `画面捕获 ${out.width}x${out.height}（DOM ${snap.stats.count} 节点 / 隐藏 ${snap.stats.hidden} / 画布 ${snap.stats.canvases}(空 ${snap.stats.blankCanvases}) / 图 ${snap.stats.inlined}/${snap.stats.images} / 补态 ${snap.stats.stagedApplied || 0}）`);
	return out;
}

/* ============================ 抓帧前的就绪等待 ============================ */

/** 元素自己或任一祖先是否落在 display:none 子树里（停在抓帧作用域边界）。 */
function inDisplayNoneSubtree(el, stopAt) {
	let n = el;
	while (n && n !== stopAt) {
		if (getComputedStyle(n).display === 'none') return true;
		n = n.parentElement;
	}
	return false;
}

/**
 * 抓帧作用域内"有歌词文字可抓"的行数。
 *
 * ★★ 判据刻意**不看** opacity / visibility（2026-10-05 修）：
 *    这两个在歌词里是**播放状态**驱动的，不是"有没有内容"。
 *    飞入模式最典型 —— `.view-flyin .line{opacity:0;visibility:hidden}`，
 *    只有 `.line.active` 显形，暂停/空闲时**一行都不显形**。
 *    而海报是静态快照：`304` 的 stageForMode 会在**暂存克隆**里把当前行补到
 *    "整行已唱完"。也就是说"此刻看不见"完全不代表"抓出来没有字"。
 *    此前的实现按可见性判定，导致飞入模式**永远出不了图**
 *    （实测：暂停态 generatePoster 恒返回 false，流程连 stageForMode 都走不到）。
 *    现在只排除"整个歌词区被 display:none"（即画布绘字模式：pv/tempera 等
 *    把 .lyrics-area-wrapper 整个藏掉，歌词改由 canvas 画 —— 那一路交给
 *    visibleCanvasCount() 判），以及本行自身 display:none。
 */
function visibleLyricNodes() {
	const pc = typeof document !== 'undefined' ? document.querySelector('.player-container') : null;
	if (!pc) return 0;
	let n = 0;
	for (const el of pc.querySelectorAll('.line')) {
		const text = el.textContent;
		if (!text || !text.trim()) continue;
		if (inDisplayNoneSubtree(el, pc)) continue;
		n++;
	}
	return n;
}

/**
 * 抓帧作用域内"看得见、且已经拿到尺寸"的画布数量。
 * ★ 为什么必须有这一项：pv(诗境/凝彩) 与 tempera(版画) 这两个模式把
 * `.lyrics-area-wrapper` 整个 `display:none`（pv.css:18-21 / viewmode.css:881-888），
 * 歌词由 Pixi 画在 canvas 上 —— 它们的**DOM 歌词节点恒不可见**。
 * 只按 DOM 判据的话，这两个模式会被判成"没有歌词"直接拒绝出图（实测过）。
 */
function visibleCanvasCount() {
	const pc = typeof document !== 'undefined' ? document.querySelector('.player-container') : null;
	if (!pc) return 0;
	let n = 0;
	for (const cv of pc.querySelectorAll('canvas')) {
		const cs = getComputedStyle(cv);
		if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.02) continue;
		if (cv.width > 0 && cv.height > 0 && cv.clientWidth > 0 && cv.clientHeight > 0) n++;
	}
	return n;
}

/**
 * 抓帧前等一等"画面真的能用"。
 * 抓的是**运行时 DOM 的瞬时状态**，所以三件事没就绪就会抓到半成品：
 *   ① 字体没就绪 → 歌词按回退字体渲染，成图"不像"；
 *   ② 歌词还没进 DOM / 整行被 opacity:0 藏着 → 海报里只剩背景
 *      （用户报的「甚至没有歌词、只有背景」就是这一条：切歌瞬间
 *      activeLineIndex = -1、PV 与版画的引擎是懒 import）；
 *   ③ 视觉引擎懒建中 → 画布还没拿到尺寸。
 * 都是**有界等待**（最长约 1.2s），到点就用现状继续，不让用户以为卡死。
 * @returns {{chars:number, canvases:number, waited:number}}
 */
async function waitForCaptureReady() {
	const t0 = Date.now();
	try {
		if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
			await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 800))]);
		}
	} catch (e) { logCatch(TAG, e); }
	let chars = visibleLyricNodes();
	let canvases = visibleCanvasCount();
	while (!captureIsRenderable({ lyricNodes: chars, canvases }) && Date.now() - t0 < 1200) {
		await new Promise((r) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r()); else setTimeout(r, 32); });
		chars = visibleLyricNodes();
		canvases = visibleCanvasCount();
	}
	return { chars, canvases, waited: Date.now() - t0 };
}

/* ============================ 生成 ============================ */

/**
 * 生成并保存一张海报。
 * @param {'native'|'square'|'story'} frameId
 * @returns {Promise<boolean>}
 */
export async function generatePoster(frameId) {
	const song = currentSong();
	if (!song || !song.title) { hint('请先播放一首歌'); return false; }
	const frame = posterFrameFor(frameId || POSTER_DEFAULT_FRAME);
	hint('正在生成歌词海报…');
	try {
		/* ★ 抓帧前先等画面就绪，并对「没有歌词文字」直接拦下 —— 否则用户拿到的
		   是一张只有背景的图，只会以为功能坏了（2026-10-05 用户报障）。
		   拦下比出一张错图好：错图会被发出去，而"稍后再试"至少是诚实的。 */
		const ready = await waitForCaptureReady();
		/* ★ 判据必须同时认"可见歌词"与"可见画布"：画布绘字的模式（诗境/凝彩/版画）
		   在 DOM 里永远查不到可见歌词，只按 DOM 判会把它们全部误杀。
		   （2026-10-05 实测：这条守卫第一版就是这么把版画/诗境判成"没有歌词"的。） */
		if (!captureIsRenderable({ lyricNodes: ready.chars, canvases: ready.canvases })) {
			hint('当前画面还没准备好，等歌词或视觉引擎出现后再试');
			logInfo(TAG, `海报取消：可见歌词节点 ${ready.chars} / 可见画布 ${ready.canvases}（已等待 ${ready.waited}ms）`);
			return false;
		}

		let view = await captureView();
		if (!view) { hint('无法获取当前画面'); return false; }
		const m = measureCanvas(view);
		if (m.sd < 2 && m.opaqueRatio < 0.02) { hint('画面是空的，请先播放'); return false; }

		/* ★ 空画布：`preserveDrawingBuffer:false` 的 WebGL 层（PV 的 sonnet、版画的
		   Pixi，以及**没注册提供者的 MV 画质增强输出** mvUpscale.js:112）在这一刻
		   `toDataURL()` 拿到的可能是空帧，于是整层被换成透明像素 —— 成图"少了视觉
		   模式那一层"，看起来就不像该模式的画面。重抓一次（中间放过两帧），
		   仍为空就明确告诉用户哪不对，别让他对着图猜。 */
		let stats = _lastCaptureStats || {};
		if ((stats.blankCanvases || 0) > 0) {
			logWarn(TAG, `抓帧有 ${stats.blankCanvases} 张画布是空的，隔两帧重试一次`);
			await new Promise((r) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => r())); else setTimeout(r, 64); });
			const retry = await captureView();
			if (retry) { view = retry; stats = _lastCaptureStats || {}; }
		}
		const blankLeft = stats.blankCanvases || 0;

		const { blob, info } = await composePoster({
			frame: frame.id,
			view,
			/* ★ 模式决定「铺满」还是「内嵌」——见 lyricPoster 的 FULL_BLEED_MODES。
			   传错的后果就是用户投诉的那条：「穿行海报不应该在毛玻璃框里面显示」。 */
			mode: modeKey(),
			song,
			accent: currentAccent(),
			footer: `Aria · ${today()}`,
			badge: modeBadge(),
			coverUrl: currentCoverUrl(song),
			dpr: 2,
		});
		const name = posterFileName(song, frame.id, 'png');
		const ok = await saveBlob(blob, name);
		if (!ok) { hint('海报保存失败'); return false; }
		logInfo(TAG, `海报已生成 ${name}（${Math.round((blob.size || 0) / 1024)}KB, 画面 ${view.width}x${view.height}, 铺底=${info.drewBackdrop}, Logo=${info.drewLogo}）`);
		/* ★ 「生成之后不能一键打开文件所在位置」——桌面壳里直接给入口；
		   浏览器版没有下载目录语义，退回普通提示。 */
		const offered = await offerReveal(name, { title: '海报已保存' });
		/* 空画布没救回来时要说出来：图已经存了，但用户有权知道哪一层缺了 */
		if (blankLeft > 0) {
			hint(`海报已保存（有 ${blankLeft} 层画面没抓到，可稍后重试）`);
		} else if (!offered) {
			hint('海报已保存');
		}
		return true;
	} catch (e) {
		logWarn(TAG, '生成失败：', e && e.message ? e.message : e);
		hint('海报生成失败');
		return false;
	}
}

/** 「更多」菜单的子菜单项。**两套菜单共用这一份清单**（见下方说明）。 */
export function posterMenuItems() {
	return POSTER_FRAMES.map(f => ({
		key: `poster-${f.id}`,
		label: `${f.label}（${f.hint}）`,
		onClick: () => { generatePoster(f.id).catch((e) => logCatch(TAG, e)); },
	}));
}

/**
 * 在指定坐标弹出「选帧型」菜单。
 * ★ 底栏那套静态菜单（`#moreSubmenu` 里的 `.more-item`）是平铺列表，塞不下三个帧型，
 *   所以点它之后就地弹一张 `showCtxMenu` —— 与 `#moreBtn` 那条路径完全同一份数据。
 */
export function showPosterMenu(x, y) {
	try {
		showCtxMenu(posterMenuItems(), x, y);
	} catch (e) { logCatch(TAG, e); }
}

/**
 * ★★ 项目里「更多」菜单有**两套**，必须都挂（AGENTS 约束 14/21 早已写明）：
 *   · `#moreBtn`（播控列那颗）→ 90-eq.js 的 `openMoreMenu()` 动态菜单，
 *     **只在 cover 模式够得着**（其余模式 `.player-controls-wrapper` 整列隐藏）；
 *   · `#bottomMoreBtn` → 底栏 `#moreSubmenu` 那串静态 `.more-item`，
 *     歌词 / PV / 隧道等模式**只剩这一面**。
 *   只挂前者 = 除了 cover 模式，用户在任何歌词模式里都找不到入口（实测被用户点出来）。
 */
function wireBottomMoreItem() {
	if (typeof document === 'undefined') return;
	const item = document.getElementById('moreLyricPosterItem');
	if (!item || item.dataset.posterWired === '1') return;
	item.dataset.posterWired = '1';
	item.addEventListener('click', (ev) => {
		ev.stopPropagation();
		try { document.getElementById('moreSubmenu')?.classList.remove('open'); } catch (e) { logCatch(TAG, e); }
		try {
			const r = item.getBoundingClientRect();
			showPosterMenu(Math.round(r.left), Math.round(r.top - 6));
		} catch (e) { logCatch(TAG, e); }
	});
}

wireBottomMoreItem();

/* ============================ 注册 ============================ */

try {
	const A = typeof window !== 'undefined' ? window.Aria : null;
	if (A) {
		A.poster = {
			generate: generatePoster, menuItems: posterMenuItems, frames: POSTER_FRAMES,
			captureView, showMenu: showPosterMenu,
			get lastCaptureStats() { return _lastCaptureStats; },
		};
	}
} catch (e) { logCatch(TAG, e); }

export { POSTER_FRAMES, posterFrameFor, HIDE_SELECTORS };
