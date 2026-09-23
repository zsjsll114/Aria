/* ============================================================
 * 57-wordcloud-camera.js — 由 src/app.js 拆分自动生成（split_app.js）
 * 来源区间: 原第 1060-1384 行 | 单元数: 3
 * 参照源 web/src/app.js 已删除（拆分完成，勿按旧行号定位）；仅改分片
 * ============================================================ */
import { LYRICS_VIRTUAL_SCROLL } from '../config/constants.js';
import { updateLineBlur, updateVirtualLyricsRender } from './20-lyrics-render.js';
import { getWordcloudTargetFontRem, playerContainer } from './40-playback-state.js';
import { wcLerpToDuration } from './55-wc-tuning.js';
import { flyinAutoScaleFont, updateFlyinTranslation } from './56-playback-misc.js';
import { updateMobileLyricPreview } from './60-mobile-dual-page.js';

/* ★ 摄像机统一写入入口：平移写在 scrollEl 的 transform（屏幕像素）。
   焦距缩放有双通道，解决"卡顿 vs 模糊"的两难：
   - 运动中（settled=false）：#wcZoom 用 transform: scale —— 合成器层缩放，
     零重排零重绘，跟焦/滚轮每帧写入也不卡顿（缩放期间文字按位图拉伸，略有软边）；
   - 静止后（settled=true）：吸附为 CSS zoom —— 布局级缩放，文字按最终分辨率
     重新栅格化，长时间停留的焦点行清晰锐利。
   滚轮缩放/拖拽/自动跟焦三处共用此函数，保证"歌词字号不变、变的是摄像机"。 */
globalThis.__wcSetCam = function (x, y, s, settled) {
    const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
    if (!sc) return;
    sc.style.transform = `translate(${x}px, ${y}px)`;
    const z = sc.querySelector('#wcZoom');
    if (!z) return;
    if (typeof settled === 'boolean') globalThis.__wcCamSettled = settled;
    if (globalThis.__wcCamSettled) {
        z.style.transform = '';
        z.style.zoom = String(s);
    } else {
        z.style.zoom = '1';
        z.style.transform = `scale(${s})`;
    }
};

let wcSettleAt = 0; /* 静止缓冲：补间结束满 350ms 才允许切 CSS zoom（避免"每句一重栅格化"卡顿） */
let wcLastFocusLine = -1; /* ★ 上次补间的焦点行号：句间切换时把补间时长减半（跨句要立刻到位） */

/* ============================================================
 * ★ 默认/歌词模式：AM 风格弹性滚动 + 间奏三点（Apple Music / AMLL 思路）
 *  - 滚动：容器整体 translate 弹簧物理（Scratch 参考实现「弹性+阻尼」逐帧模型）。
 *    v = v * 阻尼 + (target - y) * 弹性；y += v；60fps 子步长积分。
 *    滚轮弹性 0.5（近 1:1 跟手、轻微回弹），自动滚动弹性随行间隔动态调整。
 *  - 三点：当前行唱完(逐字末词 end) 与下一行之间空隙 ≥1.5s 时，在行间浮现
 *    三个小点（Expo 入场→正弦呼吸+逐点点亮→Back 回弹出场）；
 *    「推挤下方行」用 gapSpring 弹簧驱动当前行 margin-bottom：出现时非线性撑开、
 *    消失时非线性收回。暂停时不隐藏/删除三点（三点只随行/间隙窗口变化）。
 * ============================================================ */
let lyricsSpring = { y: 0, v: 0, target: null, needSnap: true };
/* 自动滚动主弹簧参数：弹性随行间隔调整（间隔小→弹性大、快速到位；间隔大→弹性小、缓慢跟进）。
   damping=0.4 保留系数 → 约 1% 过冲、自然顺滑。 */
let lyricsSpringNormal = { elasticity: 0.18, damping: 0.4 };
let lyricsGapDotEl = null;
let lyricsGapDotDots = null;
let lyricsGapState = { active: false, t0: 0, dur: 0, lineKey: -1 };
let lyricsFxLoopOn = false;
let prevUserScrolling = false;

/* ============ 三点撑开行距弹簧（非线性推挤） ============ */
let lyricsGapPush = { y: 0, v: 0, target: 0 }; /* 撑开的额外行距（驱动间距场/旧margin-bottom） */
const LYRICS_GAP_SPRING = { elasticity: 0.45, damping: 0.60 };
const LYRICS_GAP_HEIGHT = 28;     /* 三点占据的额外行距（px） */
const LYRICS_GAP_DOT_SIZE = 13;   /* 点直径（px，比原来 10px 大） */
const LYRICS_GAP_DOT_GAP = 11;    /* 点间距（px） */

/* ============ 耦合弹簧纵波（Coupled Spring-Mass Lattice） ============
   默认/歌词模式专用：行距是动态可伸缩的「弹性介质链（Slinky 纵波弹簧质点模型）」。
   - 静止态：激活行附近行距舒展（呼吸空间），远处致密（非均匀间距场）；
   - 切行：锚点换位 + 激波冲量注入 + 相邻耦合力沿链传播（纵波）→ 行距被逐层推挤展开、
     手风琴挤压与弹散，最后在苹果标志性阻尼下平滑收敛回弹；
   - 动态形态：激活行微放大 1.05，非激活行平滑收缩至 0.92；透明度平滑连续插值；
   - 对齐基点：默认模式左对齐基点 left center，歌词模式居中对齐基点 center center。 */
const WAVE_CONFIG = {
    padBase: 2,       /* 远离激活行的紧凑空白（px，结合 .line 自身 10px padding，行距非常紧凑自然） */
    padActive: 10,    /* 激活行扩展的适度呼吸空白（px） */
    padDecay: 0.80,   /* 间距场沿距离衰减系数 */
    kAnchor: 0.09,    /* 锚点回归刚度：响应迅速干脆 */
    kCouple: 0.05,    /* 相邻耦合刚度：柔和轻微牵引，不乱晃 */
    damping: 0.68,    /* 速度保留系数：快速平稳收敛，克制微超调 */
    impulse: 1.5,     /* 切行激波冲量强度：轻柔微颤，避免剧烈弹跳 */
    browseK: 0.08,    /* 滚轮浏览偏移回中弹性 */
    visWindow: 60     /* 可见渲染窗口（中心 ± 行数，足够覆盖整个大屏视口） */
};
const LYRICS_LINE_TRANS_PROP = 'filter,border-radius,background-color'; /* 行级禁 transform 和 opacity 过渡（物理写入直通） */
let wave = null;      /* WaveLyricSystem 单例 */
let waveInited = false;
let waveCleaned = true;

/* ============ 距离阶梯弹性波（CSS Stagger + 弹性贝塞尔回弹，备用） ============
   物理引擎接管的模式下不再使用；保留实现以防回退容器模式时复用。 */
const LYRICS_RIPPLE = {
    delayPerLine: 20,                       /* 每行延迟（ms）：18~25 为舒适波浪频率 */
    delayMax: 140,                          /* 封顶延迟，避免远处脱节 */
    dragDist: 5,                            /* 受牵动影响半径（行数） */
    drag: 1.8,                              /* 单行最大牵引位移（px） */
    dur: 680,                               /* 回弹时长（ms） */
    bezier: 'cubic-bezier(.25,1.4,.5,1)'    /* 苹果弹性曲线：第二值>1 带轻微 overshoot */
};
let rippleLines = [];                       /* 已注入 inline 过渡/偏移的行元素 */
let rippleCleanTimer = null;

function pulseLyricsRipple(centerIdx) {
    if (!amNormalLyricsMode() || !lineElements.length) return;
    cleanupLyricsRipple();   /* 上一波先清干净，避免过渡叠加 */
    const { delayPerLine, delayMax, dragDist, drag, dur, bezier } = LYRICS_RIPPLE;
    const from = Math.max(0, centerIdx - dragDist);
    const to = Math.min(lineElements.length - 1, centerIdx + dragDist);
    const touched = [];
    for (let i = from; i <= to; i++) {
        const el = lineElements[i];
        if (!el) continue;
        const dist = Math.abs(i - centerIdx);
        const delay = Math.min(dist * delayPerLine, delayMax);
        const tension = dragDist - dist > 0 ? (dragDist - dist) * drag : 0; /* 近大远小，中心为 0 */
        /* 覆盖行级 transform 过渡：带延迟阶梯 + 弹性贝塞尔（保留 opacity/filter 原有淡入） */
        el.style.transition = `opacity .35s ease, filter .35s ease, border-radius .25s ease, background-color .25s ease, transform ${dur}ms ${bezier} ${delay.toFixed(0)}ms`;
        el.style.transform = tension ? `translateY(${tension.toFixed(2)}px)` : '';
        touched.push(el);
    }
    if (!touched.length) return;
    rippleLines = touched;
    /* 双 rAF 确保「带偏移帧」先被渲染，再归零让贝塞尔回弹 */
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            for (const el of touched) el.style.transform = '';
        });
    });
    /* 动画结束清 inline（恢复 .line 默认过渡），不干扰之后滚轮浏览手感 */
    rippleCleanTimer = setTimeout(() => { cleanupLyricsRipple(); }, dur + delayMax + 120);
}

function cleanupLyricsRipple() {
    if (rippleCleanTimer) { clearTimeout(rippleCleanTimer); rippleCleanTimer = null; }
    for (const el of rippleLines) {
        if (!el) continue;
        el.style.transition = '';
        el.style.transform = '';
    }
    rippleLines = [];
}

/* ============================================================
 * WaveLyricSystem —— 耦合弹簧纵波物理引擎（默认/歌词模式专用）
 *  - 行绝对定位（top:0），节点 = {y(中心), vy, h, scale, opacity}
 *  - updateTargetLayout：以激活行为锚钉在视口中心，间距场
 *    由活跃空白向两侧按指数衰减（呼吸空间 + 紧密远端）
 *  - step：锚点回复 + 相邻耦合（纵波源泉）+ 阻尼 → 半隐式欧拉
 *  - setActive：切换锚点并注入临近行的初速度冲量（点燃波）
 *  - browse：滚轮浏览整体平移视口，松手后（响应切行）回中
 *  - 动态形态：scale/opacity 逐帧平滑插值，对齐原点自适应
 *  - 只写可见窗口 ±visWindow 行的 DOM，其余 visibility:hidden
 * ============================================================ */
class WaveLyricSystem {
    constructor() {
        this.nodes = [];
        this.activeIndex = -1;
        this.browse = 0;        /* 滚轮浏览视口偏移（px，向下为正） */
        this.inited = false;
        this._remeasureTick = 0; /* 行高节流重测计数 */
    }

    /* ★ 行高重测：绝对定位物理模式下，若行因窗口变窄/字号变化/翻译开关等
       换行变高，旧 nd.h 会让 translateY 锚点与行距 gap 失真 → 与上下行 DOM
       重叠。节流重读「可见行」的真实 clientHeight（纯读不写，单次 reflow）。 */
    remeasureVisible() {
        if (!this.inited) return;
        const nodes = this.nodes;
        for (let i = 0; i < nodes.length; i++) {
            const nd = nodes[i];
            if (!nd || !nd.el) continue;
            if (nd.el.dataset.virtual === 'true' || nd.el.style.visibility === 'hidden') continue;
            const h = nd.el.clientHeight || nd.h;
            if (h > 0 && h !== nd.h) nd.h = h;
        }
    }

    /* 从当前 lineElements 重建质点（歌词渲染完成/切歌时调用） */
    reset() {
        const els = lineElements;
        const n = els.length;
        cleanupLyricsTouchesFromLines(els);
        if (!n) { this.inited = false; this.nodes = []; this.activeIndex = -1; return; }
        let sumH = 0;
        const nodes = new Array(n);
        const isCenter = (appSettings.lyrics && appSettings.lyrics.align === 'center') || (playerContainer && playerContainer.classList.contains('view-lyrics'));
        const origin = isCenter ? 'center center' : 'left center';
        for (let i = 0; i < n; i++) {
            const el = els[i];
            const h = el.clientHeight || 40;
            nodes[i] = {
                el,
                y: 0,
                vy: 0,
                targetY: 0,
                h,
                scale: 0.95,
                opacity: 0.35,
                lastY: -99999,
                lastScale: -1,
                lastOpacity: -1
            };
            sumH += h;
            /* 物理矩阵接管定位：absolute + 顶部对齐 + 禁行级 transform/opacity 过渡 */
            el.style.position = 'absolute';
            el.style.left = '0';
            el.style.top = '0';
            el.style.width = '100%';
            el.style.transformOrigin = origin;
            el.style.transitionProperty = LYRICS_LINE_TRANS_PROP;
            el.style.visibility = '';
            delete el.dataset.virtual;
        }
        this.nodes = nodes;
        this.avgH = sumH / n;
        this.inited = true;
        this.activeIndex = -1;
        this.browse = 0;
    }

    viewCenterY() {
        const c = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
        return c ? c.clientHeight / 2 : window.innerHeight / 2;
    }

    /* 非均匀间距场：激活行钉中心，间距 = 行高半和 + 随距离衰减的空白（呼吸空间） */
    updateTargetLayout() {
        const n = this.nodes.length;
        const ctr = this.activeIndex;
        if (n === 0 || ctr < 0) return;
        const { padBase, padActive, padDecay } = WAVE_CONFIG;
        const center = this.viewCenterY();
        this.nodes[ctr].targetY = center;
        let prevY = center;
        for (let i = ctr - 1; i >= 0; i--) {
            const d = ctr - i;
            const pad = padBase + (padActive - padBase) * Math.exp(-d * padDecay);
            const gap = (this.nodes[i].h + this.nodes[i + 1].h) / 2 + pad;
            this.nodes[i].targetY = prevY - gap;
            prevY = this.nodes[i].targetY;
        }
        let nxtY = center;
        for (let i = ctr + 1; i < n; i++) {
            const d = i - ctr;
            const pad = padBase + (padActive - padBase) * Math.exp(-d * padDecay);
            /* ★ 三点撑开：激活行与下一行之间叠加歌词GapPush 的实时弹簧量（非线性推挤下方行） */
            const gap = (this.nodes[i].h + this.nodes[i - 1].h) / 2 + pad
                + (lyricsGapState.active && ctr === lyricsGapState.lineKey && i - 1 === ctr ? lyricsGapPush.y : 0);
            this.nodes[i].targetY = nxtY + gap;
            nxtY = this.nodes[i].targetY;
        }
    }

    /* 切换激活行：snap=瞬时对齐（seek/进模式），否则注入冲量发波 */    setActive(index, snap) {
        if (!this.inited || index < 0 || index >= this.nodes.length) return;
        const prevIdx = this.activeIndex;
        this.activeIndex = index;
        this.updateTargetLayout();
        if (!snap && prevIdx >= 0 && prevIdx !== index) {
            /* 激波注入（Impulse Injection）：切行方向的反向冲量，临近 5 行非对称发射点燃纵波 */
            const dir = index > prevIdx ? 1 : -1;
            const imp = WAVE_CONFIG.impulse;
            for (let i = 0; i < this.nodes.length; i++) {
                const d = Math.abs(i - index);
                if (d < 5) {
                    this.nodes[i].vy += (5 - d) * imp * (-dir);
                }
            }
        }
        if (snap) {
            for (let i = 0; i < this.nodes.length; i++) {
                const nd = this.nodes[i];
                nd.y = nd.targetY;
                nd.vy = 0;
                const d = Math.abs(i - index);
                nd.scale = (i === index) ? 1.05 : Math.max(0.92, 1 - d * 0.02);
                nd.opacity = (i === index) ? 1.0 : Math.max(0.20, 0.45 - d * 0.08);
            }
            this.browse = 0;
        } else {
            this.browse = 0; /* 播放切行：结束浏览偏移，回中跟随 */
        }
    }

    /* 滚轮浏览：视口整体平移（不改变锚点；delta>0 向下滚动内容向上移） */
    browseBy(delta) {
        if (!this.inited) return;
        this.browse -= delta;
    }

    /* 未播放/未定位时：歌词从视口顶部排布（贴近老版"顶部对齐"），
       播放到首行后由 setActive 把行拽向中心 */
    layoutFromTop() {
        const n = this.nodes.length;
        if (!n) return;
        const { padBase } = WAVE_CONFIG;
        let yy = this.nodes[0].h / 2 + 24;
        for (let i = 0; i < n; i++) {
            const nd = this.nodes[i];
            nd.targetY = yy;
            if (i < n - 1) yy += (nd.h + this.nodes[i + 1].h) / 2 + padBase;
        }
    }

    /* 每帧物理积分 + DOM 写入 */
    step(dt) {
        if (!this.inited) return;
        /* 容器整体平移归零：物理模式的位姿全在行级 transform，禁止残留容器位移 */
        const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
        if (sc && sc.style.transform && sc.style.transform !== 'none' && sc.style.transform !== 'translateY(0px)') {
            sc.style.transition = 'none';
            sc.style.transform = 'translateY(0px)';
        }
        const { kAnchor, kCouple, damping, browseK, visWindow } = WAVE_CONFIG;
        const n = this.nodes.length;
        const steps = Math.max(1, Math.ceil(dt * 60));
        const sdt = dt / steps;
        const scale = sdt * 60;              /* ≈1.0 @60fps */
        const damp = Math.pow(damping, scale);
        const kA = kAnchor * scale;
        const kC = kCouple * scale;
        if (this.activeIndex < 0 && activeLineIndex >= 0) { this.setActive(activeLineIndex, true); }
        /* 每帧以实时 gapSpring 重算目标布局（三点撑开实时生效） */
        if (this.activeIndex < 0) this.layoutFromTop();
        else this.updateTargetLayout();
        /* 滚轮浏览回中：仅在用户停止滚轮操作（!isUserScrolling）后柔和弹回 */
        if (!isUserScrolling) {
            this.browse += (0 - this.browse) * browseK * scale;
        }
        const nodes = this.nodes;
        const off = this.browse;
        for (let s = 0; s < steps; s++) {
            for (let i = 0; i < n; i++) {
                const nd = nodes[i];
                const target = nd.targetY + off;
                let force = (target - nd.y) * kA;         /* 锚点回复力 */
                if (i > 0) {                              /* 与上方耦合力（纵波源泉） */
                    const idealDist = nd.targetY - nodes[i - 1].targetY;
                    const currentDist = nd.y - nodes[i - 1].y;
                    force += (currentDist - idealDist) * -kC;
                }
                if (i < n - 1) {                          /* 与下方耦合力 */
                    const idealDist = nodes[i + 1].targetY - nd.targetY;
                    const currentDist = nodes[i + 1].y - nd.y;
                    force += (currentDist - idealDist) * kC;
                }
                nd.vy = (nd.vy + force) * damp;
                nd.y += nd.vy * scale;
            }
        }

        /* 动态形态：计算当前对齐原点 */
        const isCenter = (appSettings.lyrics && appSettings.lyrics.align === 'center') || (playerContainer && playerContainer.classList.contains('view-lyrics'));
        const origin = isCenter ? 'center center' : 'left center';

        /* 视口可见范围动态裁剪：以当前视口像素高度为准，仅渲染中心 ±1 屏范围（避免无谓开销与误裁）
           ★ 性能（2026-09-20）：容器引用改为模块级缓存（失连才重查）——原本每帧
           document.querySelector('.lyrics-container')×2（三目两侧各一次），常驻 rAF 下纯浪费 */
        const lcEl = lyricsContainerEl();
        const vh = lcEl ? lcEl.clientHeight
            : (typeof window !== 'undefined' ? window.innerHeight : 800);
        /* ★ 视口中心在「质点坐标」里是不动的常量：弹簧把每个质点拉向
           `targetY + off`（见下方积分），且渲染写的是 `translate3d(0, nd.y - h/2, 0)`
           —— 即节点中心就是 `nd.y`。所以屏幕中心对应的节点恒满足 `nd.y ≈ viewCenterY()`。
           此处原来写成 `viewCenterY() - off`，等于把中心按滚轮偏移量挪了一次，
           偏差 ≈ |browse| 像素 ÷ 行高（滚得越远差得越多）；一旦超过下面 ±35 行的
           窗口上限，真正可见的行就落到窗口外被 visibility:hidden —— 这正是
           「歌词滚动得越远、可见行越少，最后整片看不见」的根因。 */
        const centerPos = this.viewCenterY();
        const visibleMargin = Math.max(450, vh * 0.9);

        let from = 0, to = n - 1;
        if (n > 25) {
            /* 二分/中心发散探测当前视口中心附近的行 */
            let ci = (this.activeIndex >= 0 && this.activeIndex < n) ? this.activeIndex : 0;
            let ciDist = Math.abs(nodes[ci].y - centerPos);
            /* 简单微调探寻距离视口中心最近的节点 */
            if (ci > 0 && Math.abs(nodes[ci - 1].y - centerPos) < ciDist) {
                while (ci > 0 && Math.abs(nodes[ci - 1].y - centerPos) < ciDist) {
                    ciDist = Math.abs(nodes[--ci].y - centerPos);
                }
            } else if (ci < n - 1 && Math.abs(nodes[ci + 1].y - centerPos) < ciDist) {
                while (ci < n - 1 && Math.abs(nodes[ci + 1].y - centerPos) < ciDist) {
                    ciDist = Math.abs(nodes[++ci].y - centerPos);
                }
            }
            /* 向上下扩展至超出视口可见余量（至少保证各 12 行，上限各 35 行） */
            let f = ci;
            while (f > 0 && (centerPos - nodes[f].y < visibleMargin || (ci - f) < 12) && (ci - f) < 35) f--;
            let t = ci;
            while (t < n - 1 && (nodes[t].y - centerPos < visibleMargin || (t - ci) < 12) && (t - ci) < 35) t++;
            from = f;
            to = t;
        }
        const lerpFactor = Math.min(1, 0.15 * scale);

        /* ★ 行高节流重测：默认每 30 帧；在低性能或无显卡软件渲染下放宽至 180 帧（≈3s），
           避免无显卡虚拟机每半秒读取 clientHeight 造成频繁强制回流（Layout Thrashing） */
        const isLowPerf = typeof document !== 'undefined' && document.body &&
            (document.body.classList.contains('perf-low') || document.body.classList.contains('perf-minimal') ||
             (typeof window !== 'undefined' && Boolean(window.__isSoftwareRenderer)));
        const remeasureInterval = isLowPerf ? 180 : 30;
        if (++this._remeasureTick >= remeasureInterval) { this._remeasureTick = 0; this.remeasureVisible(); }

        for (let i = from; i <= to; i++) {
            const nd = nodes[i];
            if (nd.el.dataset.virtual === 'true' || nd.el.style.visibility === 'hidden') {
                nd.el.style.visibility = '';
                delete nd.el.dataset.virtual;
                nd.el.classList.remove('line-placeholder');
                const o = nd.el.querySelector('.lrc-original');
                if (o && o.style.visibility) o.style.visibility = '';
                const tr = nd.el.querySelector('.lrc-translation');
                if (tr && tr.style.visibility) tr.style.visibility = '';
                const rm = nd.el.querySelector('.lrc-romaji');
                if (rm && rm.style.visibility) rm.style.visibility = '';
            }

            /* 形态变化：缩放与透明度随与激活行的实际距离平滑逼近 */
            const distToActive = Math.abs(i - this.activeIndex);
            let targetScale, targetOpacity;
            if (isUserScrolling) {
                targetScale = 1.0;
                targetOpacity = (i === this.activeIndex) ? 1.0 : 0.85;
            } else {
                targetScale = (i === this.activeIndex) ? 1.05 : Math.max(0.92, 1 - distToActive * 0.02);
                targetOpacity = (i === this.activeIndex) ? 1.0 : Math.max(0.20, 0.45 - distToActive * 0.08);
            }

            nd.scale += (targetScale - nd.scale) * lerpFactor;
            nd.opacity += (targetOpacity - nd.opacity) * lerpFactor;

            if (nd.el.style.transformOrigin !== origin) {
                nd.el.style.transformOrigin = origin;
            }

            /* ★ 脏检查写入：微小变动跳过 DOM 赋值，低配模式下适当提高阈值减少 CPU 重排 */
            const diffY = Math.abs(nd.y - nd.lastY);
            const diffScale = Math.abs(nd.scale - nd.lastScale);
            const thY = isLowPerf ? 0.25 : 0.08;
            const thScale = isLowPerf ? 0.005 : 0.002;
            if (diffY >= thY || diffScale >= thScale) {
                nd.lastY = nd.y;
                nd.lastScale = nd.scale;
                nd.el.style.transform = `translate3d(0, ${(nd.y - nd.h / 2).toFixed(2)}px, 0) scale(${nd.scale.toFixed(3)})`;
            }

            const diffOpacity = Math.abs(nd.opacity - nd.lastOpacity);
            const thOp = isLowPerf ? 0.02 : 0.008;
            if (diffOpacity >= thOp) {
                nd.lastOpacity = nd.opacity;
                nd.el.style.opacity = nd.opacity.toFixed(3);
            }
        }
        for (let i = 0; i < from; i++) {
            const nd = nodes[i];
            if (nd.el.dataset.virtual !== 'true') {
                nd.el.style.visibility = 'hidden';
                nd.el.dataset.virtual = 'true';
            }
        }
        for (let i = to + 1; i < n; i++) {
            const nd = nodes[i];
            if (nd.el.dataset.virtual !== 'true') {
                nd.el.style.visibility = 'hidden';
                nd.el.dataset.virtual = 'true';
            }
        }
    }

    /* 退出歌词模式/切歌：还原行样式（恢复流式布局给其它模式） */
    cleanup() {
        if (!this.inited) return;
        const els = this.nodes.map(nd => nd.el);
        cleanupLyricsTouchesFromLines(els);
        this.inited = false;
        this.nodes = [];
        this.activeIndex = -1;
    }
}

/* 清除一组行元素上的物理接管 inline 样式（流式还原） */
function cleanupLyricsTouchesFromLines(els) {
    for (const el of els) {
        if (!el) continue;
        if (el.style.position === 'absolute') el.style.position = '';
        if (el.style.left) el.style.left = '';
        if (el.style.top) el.style.top = '';
        if (el.style.width === '100%') el.style.width = '';
        if (el.style.transform) el.style.transform = '';
        if (el.style.opacity) el.style.opacity = '';
        if (el.style.transformOrigin) el.style.transformOrigin = '';
        if (el.style.transitionProperty === LYRICS_LINE_TRANS_PROP) el.style.transitionProperty = '';
        if (el.style.visibility) el.style.visibility = '';
        el.classList.remove('line-placeholder');
        const originalEl = el.querySelector('.lrc-original');
        if (originalEl && originalEl.style.visibility) originalEl.style.visibility = '';
        const transEl = el.querySelector('.lrc-translation');
        if (transEl && transEl.style.visibility) transEl.style.visibility = '';
        const romaEl = el.querySelector('.lrc-romaji');
        if (romaEl && romaEl.style.visibility) romaEl.style.visibility = '';
        if (el.dataset && el.dataset.virtual) delete el.dataset.virtual;
    }
}

/* ★ 性能（2026-09-20）：歌词容器引用缓存——wave.step 常驻 rAF 每帧都要拿
   .lyrics-container（读 clientHeight 做可见窗口裁剪），querySelector 每帧两连发是纯浪费。
   失连（重渲染/切模式）时才重查。 */
let _lyricsContainerRef = null;
function lyricsContainerEl() {
    if (!_lyricsContainerRef || !_lyricsContainerRef.isConnected) {
        _lyricsContainerRef = (typeof document !== 'undefined')
            ? document.querySelector('.lyrics-container')
            : null;
    }
    return _lyricsContainerRef;
}

/* 确保物理引擎就绪（懒初始化单例） */
function waveEnsure() {
    if (!wave) wave = new WaveLyricSystem();
    if (!wave.inited) { wave.reset(); waveInited = wave.inited; }
    if (wave.inited) waveCleaned = false;
}

/* 退出歌词模式：清理一次 */
function waveCleanup() {
    if (waveCleaned) return;
    if (wave) wave.cleanup();
    cleanupLyricsRipple();
    waveInited = false;
    waveCleaned = true;
}

/* ★ 窗口尺寸变化常导致歌词换行（宽度变窄→行变高）→ 物理行高立即重测，
   不等下一次 30 帧节流，避免重排瞬间重叠 */
if (typeof window !== 'undefined') {
    let _waveReH = null;
    window.addEventListener('resize', function () {
        if (!wave || !wave.inited) return;
        clearTimeout(_waveReH);
        _waveReH = setTimeout(function () {
            if (wave && wave.inited) wave.remeasureVisible();
        }, 150);
    });
}

/* 切换活动行入口（由 updateLyricsHighlight 调用） */
function waveSetActiveFromPlayback(index, snap) {
    if (!amNormalLyricsMode()) return;
    waveEnsure();
    wave.setActive(index, snap);
}

function amNormalLyricsMode() {
    const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
    if (!sc || !playerContainer) return false;
    for (const v of ['view-wordcloud', 'view-flyin', 'view-pv', 'view-tunnel', 'view-dimension', 'view-polyphony', 'view-letterpress', 'view-neon', 'view-poster']) {
        if (playerContainer.classList.contains(v)) return false;
    }
    return true;
}

/* 根据实际滚动位置计算中心行索引（用真实 offsetTop，而非固定行高估算）。
   ★ 二分查找（offsetTop 随行序单调递增），不再用「活动行 ±30」限制搜索窗口：
   那个窗口在用户滚离活动行时够不着真正可见的行，会把视口内的行判成窗口外，
   被 updateVirtualLyricsRender 打上 line-placeholder 隐藏 —— 表现为
   「歌词划得越远、可见行越少，最后整片看不见」。 */
function computeCenterLineIndex(scrollY) {
    const n = lineElements.length;
    if (!n) return 0;
    const container = document.querySelector('.lyrics-container');
    const viewCenter = scrollY + (container ? container.clientHeight / 2 : 0);
    const topOf = (i) => {
        const el = lineElements[i];
        return el ? (el.offsetTop || 0) : 0;
    };
    /* 找第一个 offsetTop >= viewCenter 的行 */
    let lo = 0, hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (topOf(mid) < viewCenter) lo = mid + 1;
        else hi = mid;
    }
    /* 与它和它前一行比较，取更接近视口中心者 */
    const prev = lo - 1;
    if (prev >= 0 && Math.abs(topOf(prev) - viewCenter) < Math.abs(topOf(lo) - viewCenter)) {
        return prev;
    }
    return lo;
}

/* ============ 容器弹簧 + 三点撑开行距（margin-bottom） ============ */

/* 歌词重排/切歌后复位所有弹簧；同时清掉可能的行级 transform/margin 残留（旧逐行方案或其它代码） */
function resetLyricsSprings() {
    lyricsSpring.target = null;
    lyricsSpring.y = currentScrollY || 0; lyricsSpring.v = 0; lyricsSpring.needSnap = false;
    lyricsGapPush.y = 0; lyricsGapPush.v = 0; lyricsGapPush.target = 0;
    lyricsGapState.active = false; lyricsGapState.lineKey = -1;
    if (lyricsGapDotEl) lyricsGapDotEl.style.opacity = '0';
    cleanupLyricsRipple();
    /* ★ 物理引擎：歌词模式切歌/重排 → 重建质点；其它模式 → 清理接管样式 */
    if (wave) {
        if (amNormalLyricsMode()) wave.reset();
        else if (wave.inited) wave.cleanup();
    }
    for (let i = 0; i < lineElements.length; i++) {
        const el = lineElements[i];
        if (!el) continue;
        if (el.style.transform) el.style.transform = '';
        if (el.style.marginBottom) el.style.marginBottom = '';
    }
}
globalThis.Aria.__lyricsRebuildChain = resetLyricsSprings;

/* 三点额外行距弹簧：出现 target=GAP_HEIGHT（非线性撑开下方行）、隐藏 target=0（非线性收回）。
   实际撑开量由 stepLyricsScroll 每帧写到当前行 margin-bottom，天然非线性。 */
function stepGapPush(dt) {
    if (lyricsGapPush.y === lyricsGapPush.target && lyricsGapPush.v === 0) return;
    const steps = Math.max(1, Math.ceil(dt * 60));
    const sdt = dt / steps, scale = sdt * 60;
    const damp = Math.pow(LYRICS_GAP_SPRING.damping, scale);
    const elast = LYRICS_GAP_SPRING.elasticity * scale;
    for (let i = 0; i < steps; i++) {
        lyricsGapPush.v = lyricsGapPush.v * damp + (lyricsGapPush.target - lyricsGapPush.y) * elast;
        lyricsGapPush.y += lyricsGapPush.v * scale;
    }
    if (Math.abs(lyricsGapPush.y - lyricsGapPush.target) < 0.05 && Math.abs(lyricsGapPush.v) < 0.05) {
        lyricsGapPush.y = lyricsGapPush.target; lyricsGapPush.v = 0;
    }
}

/* 每帧推进弹簧并写入 scrollEl.transform（常驻 rAF，暂停/滚轮均可用，见 ensureLyricsFxLoop）。
   ★ 弹簧模型对齐 Scratch 参考实现：v = v * 阻尼 + (target - y) * 弹性；y += v。 */
function stepLyricsScroll(dt) {
    const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
    if (!sc || lyricsSpring.target == null) { prevUserScrolling = isUserScrolling; return; }
    /* 用户滚动刚结束：保持用户停留位置，不被旧的弹簧目标拉回去（下次切行再跟随） */
    if (!isUserScrolling && prevUserScrolling) {
        lyricsSpring.target = currentScrollY;
        lyricsSpring.y = currentScrollY;
        lyricsSpring.v = 0;
    }
    prevUserScrolling = isUserScrolling;
    /* 非用户滚动时跟随外部改动（切样式吸附等）；用户滚动时 target 已由 __lyricsWheelApply 设定 */
    if (!isUserScrolling && Math.abs(currentScrollY - lyricsSpring.y) > 2) lyricsSpring.y = currentScrollY;
    const t = lyricsSpring.target;
    if (lyricsSpring.needSnap) {
        lyricsSpring.y = t; lyricsSpring.v = 0; lyricsSpring.needSnap = false;
    } else {
        /* 滚轮弹性 0.5（对齐 Scratch「弹性 0.5」），阻尼 0.15 → 近 1:1 跟手 + 轻微回弹；
           自动滚动用行间隔动态弹性（applyLineSpringPolicy）。
           ★ 此模型中 damping 是速度保留系数：值越小能量耗散越快、回弹越小。 */
        const cfg = isUserScrolling
            ? { elasticity: 0.5, damping: 0.15 }
            : lyricsSpringNormal;
        /* 子步长积分：以 60fps 为基准步进，dt 大时拆多步，保证稳定性与手感一致 */
        const steps = Math.max(1, Math.ceil(dt * 60));
        const sdt = dt / steps;
        const frameScale = sdt * 60; /* 1.0 at 60fps */
        const damp = Math.pow(cfg.damping, frameScale);
        const elast = cfg.elasticity * frameScale;
        for (let i = 0; i < steps; i++) {
            lyricsSpring.v = lyricsSpring.v * damp + (t - lyricsSpring.y) * elast;
            lyricsSpring.y += lyricsSpring.v * frameScale;
        }
        if (Math.abs(lyricsSpring.y - t) < 0.05 && Math.abs(lyricsSpring.v) < 0.05) {
            lyricsSpring.y = t; lyricsSpring.v = 0;
        }
    }
    /* 容器整体平移（AM 风格弹簧滚动），虚拟渲染留在 rAF 内批量处理 */
    sc.style.transition = 'none';
    sc.style.transform = `translateY(${(-lyricsSpring.y).toFixed(2)}px)`;
    currentScrollY = lyricsSpring.y;
    /* ★ 三点撑开：gapSpring 弹簧值 → 当前行 margin-bottom（非线性推挤下方行） */
    stepGapPush(dt);
    if (lineElements[lyricsGapState.lineKey]) {
        const gEl = lineElements[lyricsGapState.lineKey];
        const mb = lyricsGapPush.y > 0.05 ? lyricsGapPush.y.toFixed(1) + 'px' : '';
        if (gEl.style.marginBottom !== mb) gEl.style.marginBottom = mb;
    }
    /* ★ 虚拟渲染跟随「实际可见位置」而非目标值：滚轮时上方歌词不会提前消失。
       与弹簧写入同帧批量处理，避免 wheel 事件里同步改 DOM 造成卡顿。
       ★ 普通歌词模式必须跳过：该模式下滚动量进的是 wave.browse（见 __lyricsWheelApply），
       lyricsSpring.y 不再更新 → 用它算出的中心行是错的，会把用户实际滚到的行
       按 placeholder 隐藏（"划得越远越看不见歌词"）。可见性由 wave 物理引擎
       的视口窗口自主管理（WaveLyricSystem.step），与 syncLineVisualRange 的
       `!amNormalLyricsMode()` 口径保持一致。 */
    if (LYRICS_VIRTUAL_SCROLL.enabled && isUserScrolling && !amNormalLyricsMode()) {
        updateVirtualLyricsRender(computeCenterLineIndex(lyricsSpring.y));
    }
}

/* 瞬时吸附：主弹簧到位 + 容器直接平移（seek/进模式/点击行跳转），不弹动画 */
function snapLyricsTo(targetY) {
    lyricsSpring.target = targetY; lyricsSpring.y = targetY; lyricsSpring.v = 0; lyricsSpring.needSnap = false;
    currentScrollY = targetY;
    const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
    if (sc) { sc.style.transition = 'none'; sc.style.transform = `translateY(-${targetY.toFixed(2)}px)`; }
}

/* 外部滚动请求的唯一入口（点击/单选跳转/进模式吸附）：
   ★ 物理引擎接管歌词模式后：滚动目标由「播放时间 + 活动行」驱动，
   targetY（旧 offsetTop 语义）不再适用 → 重定向为「吸附/切换当前活动行」。
   flyin 等非歌词模式走旧容器平移逻辑。 */
globalThis.Aria.__lyricsScrollTo = function (targetY, snap, targetIndex) {
    if (amNormalLyricsMode()) {
        waveEnsure();
        if (!wave.inited) return;
        const idx = (typeof targetIndex === 'number' && targetIndex >= 0)
            ? targetIndex
            : (activeLineIndex >= 0 ? activeLineIndex : 0);
        wave.setActive(idx, !!snap);
        return;
    }
    if (lyricsSpring.target == null) lyricsSpring.y = currentScrollY || 0;
    if (snap) { snapLyricsTo(targetY); return; }
    lyricsSpring.target = targetY;
    lyricsSpring.needSnap = false;
};

/* 滚轮跟手：歌词模式 → 物理引擎视口平移（browse，不改变锚点）；
   旧容器弹簧逻辑仅作为非歌词模式的兜底。 */
globalThis.Aria.__lyricsWheelApply = function (deltaY) {
    if (amNormalLyricsMode() && wave && wave.inited) {
        wave.browseBy(deltaY);
        return;
    }
    const sc = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
    if (!sc) return;
    const maxScroll = Math.max(0, (sc.scrollHeight || 0) - ((document.querySelector('.lyrics-container') || sc).clientHeight || 0));
    if (lyricsSpring.target == null) lyricsSpring.y = currentScrollY || 0;
    const next = Math.max(0, Math.min(maxScroll, (lyricsSpring.target != null ? lyricsSpring.target : currentScrollY) + deltaY));
    lyricsSpring.target = next;
    lyricsSpring.needSnap = false;
};

function ensureLyricsGapDot() {
    if (lyricsGapDotEl && lyricsGapDotEl.isConnected) return lyricsGapDotEl;
    const box = typeof document !== 'undefined' ? document.querySelector('.lyrics-container') : null;
    if (!box) return null;
    const el = document.createElement('div');
    /* 纯悬浮浮层：absolute 定位、不占文档流 → 由 gapSpring 撑开的行距承托 */
    const ds = LYRICS_GAP_DOT_SIZE, dg = LYRICS_GAP_DOT_GAP;
    el.style.cssText = [
        'position:absolute;left:0;top:0;z-index:40;display:flex;pointer-events:none;',
        `gap:${dg}px;opacity:0;transform:translate(-50%,-50%);filter:drop-shadow(0 2px 7px rgba(0,0,0,.55));`
    ].join('');
    el.innerHTML = '<span style="width:' + ds + 'px;height:' + ds + 'px;border-radius:50%;background:#fff;opacity:.25;display:block;"></span>'
                 + '<span style="width:' + ds + 'px;height:' + ds + 'px;border-radius:50%;background:#fff;opacity:.25;display:block;"></span>'
                 + '<span style="width:' + ds + 'px;height:' + ds + 'px;border-radius:50%;background:#fff;opacity:.25;display:block;"></span>';
    box.appendChild(el);
    lyricsGapDotEl = el;
    lyricsGapDotDots = el.children;
    return el;
}

function hideLyricsGapDots() {
    /* 三点隐藏：行距弹簧目标归零 → 非线性收回下方行；点淡出。删除/清点动作不做（暂停也要保留状态） */
    lyricsGapState.active = false;
    lyricsGapPush.target = 0;
    if (lyricsGapDotEl && lyricsGapDotEl.style.opacity !== '0') lyricsGapDotEl.style.opacity = '0';
}

function easeOutExpo(x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); }
function easeInOutBack(x) {
    const c1 = 1.70158, c2 = c1 * 1.525;
    return x < 0.5
        ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
        : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2;
}

/* 默认/歌词模式：行间空隙三点（判定 + 定位 + AMLL 三段动画），每帧调用 */
function updateLyricsGapDots(t) {
    /* ★ 暂停时不隐藏：三点状态只随「行/间隙窗口」变化（isPlaying 不参与判定） */
    if (!amNormalLyricsMode() || isUserScrolling) { hideLyricsGapDots(); return; }
    const el = ensureLyricsGapDot();
    if (!el) return;
    const cur = lyrics[activeLineIndex];
    const nx = lyrics[activeLineIndex + 1];
    const lineEl = lineElements[activeLineIndex];
    if (!cur || !nx || !lineEl) { hideLyricsGapDots(); return; }

    /* 当前行"唱完"时刻：逐字末词 end；无逐字无法区分句内/句间 → 不显示 */
    let curEnd = -1;
    const ws = wordElementsByLine[activeLineIndex] || [];
    for (let i = ws.length - 1; i >= 0; i--) {
        const e = parseInt(ws[i] && ws[i].dataset && ws[i].dataset.end);
        if (!isNaN(e)) { curEnd = e; break; }
    }
    const nextStart = (typeof nx.start === 'number') ? nx.start : 0;
    const gapMs = (curEnd >= 0 && nextStart > curEnd) ? (nextStart - curEnd) : 0;
    const active = gapMs >= 3500 && t >= curEnd && (nextStart - t) > 500;
    if (!active) { hideLyricsGapDots(); return; }

    if (!lyricsGapState.active || lyricsGapState.lineKey !== activeLineIndex) {
        /* 三点"出现"：行距弹簧目标撑开到 GAP_HEIGHT（由 stepGapPush 非线性打开，
           下方行的撑开也随之非线性——不再 margin-bottom 瞬时跳变）。
           ★ t0 用「音乐时间」而非墙钟：暂停期间三点动画冻结、恢复继续，
           不会因暂停长而走完淡出（配合"暂停不隐藏三点"）。 */
        lyricsGapState.active = true;
        lyricsGapState.t0 = t;
        lyricsGapState.dur = gapMs;
        lyricsGapState.lineKey = activeLineIndex;
        lyricsGapPush.target = LYRICS_GAP_HEIGHT;
    }

    /* 定位（视口坐标系 / .lyrics-container）：
       垂直 = 当前行与下一行之间的精确几何中心（物理坐标系直接计算，消除每帧 getBoundingClientRect 回流）；
       水平 = 跟随实际歌词文本对齐方式（左对齐 15px 缩进对准文本首字，居中对齐严格居中） */
    const align = (appSettings.lyrics && appSettings.lyrics.align)
        || (playerContainer && playerContainer.classList.contains('view-lyrics') ? 'center' : 'left');

    let dotCenterY = 0;
    if (wave && wave.inited && wave.nodes && wave.nodes[activeLineIndex]) {
        const curNd = wave.nodes[activeLineIndex];
        const nxNd = wave.nodes[activeLineIndex + 1];
        if (nxNd) {
            dotCenterY = (curNd.y + nxNd.y) / 2;
        } else {
            dotCenterY = curNd.y + curNd.h / 2 + lyricsGapPush.y / 2;
        }
    } else {
        const box = document.querySelector('.lyrics-container');
        const lineRect = lineEl.getBoundingClientRect();
        const nxEl = lineElements[activeLineIndex + 1];
        const nxRect = nxEl ? nxEl.getBoundingClientRect() : null;
        const boxRect = box ? box.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
        dotCenterY = nxRect
            ? ((lineRect.bottom + nxRect.top) / 2 - boxRect.top)
            : (lineRect.bottom - boxRect.top + lyricsGapPush.y / 2);
    }

    /* ★ 性能（2026-09-20）：left/right/top 是布局属性，间奏期每帧写入会强制 layout。
       top 取整后脏检查，left/right 仅在对齐方式变化时写入。 */
    const topPx = Math.max(0, Math.round(dotCenterY)) + 'px';
    if (el._gapTop !== topPx) { el._gapTop = topPx; el.style.top = topPx; }
    const gapLR = (align === 'right' || align === 'end') ? 'r' : (align === 'left' || align === 'start') ? 'l' : 'c';
    if (el._gapLR !== gapLR) {
        el._gapLR = gapLR;
        if (gapLR === 'r') {
            el.style.left = 'auto';
            el.style.right = '15px';
        } else if (gapLR === 'l') {
            el.style.left = '15px';
            el.style.right = 'auto';
        } else {
            el.style.left = '50%';
            el.style.right = 'auto';
        }
    }

    /* ★ 动画时间轴跟随音乐时间：暂停冻结、seek 往回 clamp 到 0（重放入场） */
    const tt = Math.max(0, t - lyricsGapState.t0);
    const dur = lyricsGapState.dur;
    const breatheDur = dur / Math.ceil(dur / 4500);
    let scale = 1;
    if (tt < 2000) scale *= easeOutExpo(tt / 2000);
    let opacity = 1;
    if (tt < 500) opacity = 0;
    else if (tt < 1000) opacity *= (tt - 500) / 500;
    scale *= Math.sin(1.5 * Math.PI - (tt / breatheDur) * 2 * Math.PI) / 20 + 1;
    const dotsDur = Math.max(0.001, dur - 750);
    for (let i = 0; i < 3; i++) {
        const p = (tt - i * dotsDur / 3) * 3 / dotsDur;
        const o = p < 0.25 ? 0.25 : p * 0.75 > 1 ? 1 : p * 0.75;
        lyricsGapDotDots[i].style.opacity = String(Math.max(0, Math.min(1, opacity * o)));
    }
    const remain = dur - tt;
    if (remain < 750) scale *= 1 - easeInOutBack((750 - remain) / 750 / 2);
    if (remain < 375) opacity *= Math.max(0, Math.min(1, remain / 375));
    scale = Math.max(0, scale);
    el.style.opacity = String(opacity);
    /* 已按对齐设置过 transform 的基础位，这里只叠缩放（避免覆盖 left/right 布局的 translate） */
    const baseTf = align === 'center'
        ? 'translate(-50%,-50%)'
        : 'translate(0,-50%)';
    el.style.transform = baseTf + ` scale(${scale.toFixed(3)})`;
}

/* 常驻 rAF：默认/歌词模式独有的弹簧滚动 + 三点（播放/暂停都跑；
   播放时行切换设 target，暂停时可滚轮浏览歌词） */
function ensureLyricsFxLoop() {
    if (lyricsFxLoopOn) return;
    lyricsFxLoopOn = true;
    let last = performance.now();
    (function tick() {
        if (!lyricsFxLoopOn) return;
        requestAnimationFrame(tick);
        const now = performance.now();
        if (!amNormalLyricsMode()) { waveCleanup(); return; }
        const dt = Math.min(0.04, Math.max(0.001, (now - last) / 1000));
        last = now;
        /* ★ 耦合弹簧纵波：物理引擎接管歌词定位（行绝对定位，无容器平移）。
           旧容器弹簧 stepLyricsScroll 不再执行，仅保留为回退参考。 */
        stepGapPush(dt);
        if (lineElements.length) waveEnsure();
        if (wave && wave.inited) wave.step(dt);
        updateLyricsGapDots((typeof currentTime === 'number' ? currentTime : 0) + (lyricOffset || 0));
    })();
}

/* 默认/歌词模式弹簧参数随行间隔动态调整（AMLL getPosYSpringPolicy 思路）。
   间隔小（快歌）→ 弹性大、快速到位；间隔大（慢歌/间奏前）→ 弹性小、缓慢跟进。
   阻尼固定 0.4（速度保留系数）→ 约 1% 过冲的自然顺滑感。 */
function applyLineSpringPolicy(activeIdx) {
    const cur = lyrics[activeIdx];
    const nextLine = lyrics[activeIdx + 1];
    const prevLine = lyrics[activeIdx - 1];
    let ivMs = 0;
    if (cur && nextLine) ivMs = (nextLine.start || 0) - (cur.start || 0);
    else if (cur && prevLine) ivMs = (cur.start || 0) - (prevLine.start || 0);
    const cIv = Math.max(100, Math.min(800, ivMs || 400));
    const ratio = Math.pow(1 - (cIv - 100) / 700, 0.2);
    /* 弹性范围 0.12 ~ 0.22：间隔越小弹性越大，滚动越跟手 */
    const elasticity = 0.12 + ratio * 0.10;
    lyricsSpringNormal = { elasticity, damping: 0.4 };
}

/* 模块即启动：默认/歌词模式常驻 rAF（播放/暂停/滚轮浏览都可用） */
ensureLyricsFxLoop();

function updateWordcloudCamera(t) {
            if (!wordcloudLayoutDone || activeLineIndex < 0) return;
            /* 拖动中暂停自动跟焦 */
            if (wcDragState && wcDragState.moved) return;
            /* 滚轮缩放后 3s 内暂停自动跟焦 */
            if (wcZoomTimer) return;

            if (!wcContainerRef || !wcContainerRef.isConnected) wcContainerRef = document.querySelector('.lyrics-container');
            if (!wcScrollRef || !wcScrollRef.isConnected) wcScrollRef = document.getElementById('lyricsScroll');
            const container = wcContainerRef;
            const scrollEl = wcScrollRef;
            if (!container || !scrollEl) return;

            const viewW = container.clientWidth;
            const viewH = container.clientHeight;

            /* ★ 按"当前播放时间"选取焦点字，而非"最后一个上浮的 .active"。
               .active 只加不减（Apple Music 上浮风格），若据此跟焦，进度条回拖时
               焦点会锁死在最靠后的字上，摄像机永不左移/回退。改为按时间取"当前唱到
               或即将唱到"的字，进度条任意回拖都能立即改变焦点。 */
            const activeWords = wordElementsByLine[activeLineIndex] || [];
            let focusEl = null;
            if (typeof t === 'number') {
                for (let j = 0; j < activeWords.length; j++) {
                    const ws = parseInt(activeWords[j]?.dataset?.start);
                    if (!isNaN(ws) && ws <= t) focusEl = activeWords[j];
                    else if (!isNaN(ws) && ws > t) break;
                }
                /* t 早于该行第一个字 → 焦点对准即将唱到的第一个字 */
                if (!focusEl && activeWords.length) focusEl = activeWords[0];
            } else {
                /* 无时间参数（如刚排版完成）：跟焦最后一个已上浮的字 */
                for (let j = activeWords.length - 1; j >= 0; j--) {
                    if (activeWords[j] && activeWords[j].classList.contains('active')) {
                        focusEl = activeWords[j];
                        break;
                    }
                }
            }
            /* 无逐字数据 → 跟焦到活动行 */
            if (!focusEl) focusEl = lineElements[activeLineIndex];
            if (!focusEl) return;

            const activeLineEl = lineElements[activeLineIndex];
            const rawFont = parseFloat(activeLineEl?.dataset.wcFontSize || '2.5');
            const targetRaw = getWordcloudTargetFontRem();

            /* ★ 用户需求：词云焦点"对准显示"用摄像机焦距缩放，而不是放大歌词字号。
               基础歌词字号始终由排版定死（不变）；摄像机负责把焦点行拉近到目标观感、
               其余行随镜头缩放出屏。焦距倍率 = 目标字号/焦点行基础字号。
               用 CSS zoom 实现（Chromium 布局级缩放、按高分渲染），文字不糊；
               不再改写任何 .line 的 fontSize（彻底移除之前的"放大歌词"逻辑）。 */
            const fWidth = (globalThis.wordcloudZoomFov) || 1;   /* 用户可调焦距附加系数(预留) */
            const targetScale = Math.max(0.8, Math.min(6, (targetRaw * fWidth) / (rawFont || 2.5)));

            /* 实时读取词云跟焦设置中的相机阻尼系数 wcLerpFactor，换算为补间时长 */
            const wcSetting = (appSettings.modeSettings && appSettings.modeSettings.wordcloud) || {};
            const tweenDur = wcLerpToDuration(wcSetting.wcLerpFactor);

            /* ★ 相机焦点缓存：仅在焦点元素、上采样基准或布局版本变化时重算。
               getBoundingClientRect 会强制同步布局，逐字高亮每帧写 width 已弄脏布局，
               若相机每帧再测量会强制重排，拖慢整个渲染循环 */
            if (wordcloudCamCache == null || wordcloudCamCache.el !== focusEl || wordcloudCamCache.ver !== wordcloudLayoutVer) {
                /* 测量时 DOM 处于"当前缩放 S"下（上次写入的 transform），视口坐标差 = S × 未缩放画布坐标，
                   除以测量时的实际缩放 S 得到未缩放坐标（与缩放/平移状态无关，可安全缓存） */
                const s0 = wordcloudCurrentScale || 1;
                const wordRect = focusEl.getBoundingClientRect();
                const canvasRect = scrollEl.getBoundingClientRect();
                wordcloudCamCache = {
                    el: focusEl,
                    ver: wordcloudLayoutVer,
                    seq: ++wcCacheSeq,              /* 焦点/布局变化即递增 → 触发新的缓动补间 */
                    wx: (wordRect.left + wordRect.width / 2 - canvasRect.left) / s0,
                    wy: (wordRect.top + wordRect.height / 2 - canvasRect.top) / s0
                };
            }
            const wordX = wordcloudCamCache.wx;
            const wordY = wordcloudCamCache.wy;

            /* 目标缩放与平移：使焦点字中心居中于视口。
             * transform: translate(X, Y) scale(S)；字在视口中的位置 = X + wordX*S
             * 居中: X = viewW/2 - wordX*S（用最终缩放计算，缩放与平移同步收敛） */
            const endScale = targetScale;
            const endX = viewW / 2 - wordX * endScale;
            const endY = viewH / 2 - wordY * endScale;

            /* ★ 非线性(缓动)补间：逐字/逐句乃至缩放变化都用【时间驱动 + easeOut 缓动】
               替代原先的"固定比例 Lerp"。固定 Lerp 每帧按同一比例靠拢，速度看起来是
               匀速机械的（生硬）；easeOut 先快后慢、有加速到减速的曲线感，且到达目标后
               精确停稳（不漂移），切句/切字都不再突兀。 */
            const sig = `${wordcloudCamCache.seq}:${endScale.toFixed(3)}`;
            if (wcTween && wcTween.sig !== sig) {
                /* 目标变化 → 从当前位置起启一段新的缓动补间。
                 * ★ 句间切换（焦点行变化）用一半时长：跨句位移大、语义上"换句就该立刻
                 *   到位"；句内逐字推进用正常时长。此前的补间时长不分行内外，快歌逐字
                 *   重启补间（每字 < dur）导致镜头永远慢半拍、跨句拖沓。 */
                const lineChanged = (wcLastFocusLine !== activeLineIndex);
                wcLastFocusLine = activeLineIndex;
                wcTween = {
                    sig,
                    t0: performance.now(),
                    dur: lineChanged ? Math.max(0.08, tweenDur * 0.5) : tweenDur,
                    start: { x: wordcloudCurrentX, y: wordcloudCurrentY, s: wordcloudCurrentScale },
                    target: { x: endX, y: endY, s: endScale }
                };
            } else if (!wcTween) {
                /* 无进行中补间：若未到目标（如用户拖动/缩放后刚恢复跟焦）则启新补间，
                   已精确位于目标则保持不动，避免每帧重建无效补间 */
                const settled = Math.abs(wordcloudCurrentX - endX) < 0.5 &&
                                Math.abs(wordcloudCurrentY - endY) < 0.5 &&
                                Math.abs(wordcloudCurrentScale - endScale) < 0.002;
                if (!settled) {
                    const lineChanged = (wcLastFocusLine !== activeLineIndex);
                    wcLastFocusLine = activeLineIndex;
                    wcTween = {
                        sig,
                        t0: performance.now(),
                        dur: lineChanged ? Math.max(0.08, tweenDur * 0.5) : tweenDur,
                        start: { x: wordcloudCurrentX, y: wordcloudCurrentY, s: wordcloudCurrentScale },
                        target: { x: endX, y: endY, s: endScale }
                    };
                }
            }

            if (wcTween) {
                const tt = (performance.now() - wcTween.t0) / (wcTween.dur * 1000);
                const k = tt >= 1 ? 1 : (1 - Math.pow(1 - tt, 5));   /* easeOutQuint：0→1，前段比 Quart 更快收敛（逐字重启补间时滞更小） */
                wordcloudCurrentX = wcTween.start.x + (wcTween.target.x - wcTween.start.x) * k;
                wordcloudCurrentY = wcTween.start.y + (wcTween.target.y - wcTween.start.y) * k;
                wordcloudCurrentScale = wcTween.start.s + (wcTween.target.s - wcTween.start.s) * k;
                if (tt >= 1) { wcTween = null; wcSettleAt = performance.now(); }   /* 到位后清除，动画结束，位置精确停稳 */
            }

            /* ★ 静止时跳过重复写入：值不变时跳过，词云模式下逐字高亮每帧都在弄脏布局，
                相机这里省一次是一次。平移→scrollEl.transform；焦距→运动中 transform:scale
                （合成器、不卡顿），补间结束且缓冲 350ms 后吸附为 CSS zoom（文字高清重栅格化） */
            let settledNow = false;
            if (!wcTween) {
                if (wcSettleAt === 0) wcSettleAt = performance.now();
                settledNow = (performance.now() - wcSettleAt) >= 350;
            } else {
                wcSettleAt = 0; /* 新的运动开始 → 撤销缓冲，动画期间保持 transform scale */
            }
            const camTransform = `${wordcloudCurrentX.toFixed(2)},${wordcloudCurrentY.toFixed(2)}|${wordcloudCurrentScale.toFixed(4)}|${settledNow ? 1 : 0}`;
            if (camTransform !== wcLastTransform) {
                wcLastTransform = camTransform;
                __wcSetCam(wordcloudCurrentX, wordcloudCurrentY, wordcloudCurrentScale, settledNow);
            }
        }

/* ========== 词云模式：清理排版内联样式（切回普通模式时调用） ========== */
function cleanupWordCloud() {
            const scrollEl = typeof document !== 'undefined' ? document.getElementById('lyricsScroll') : null;
            if (scrollEl) {
                scrollEl.style.width = '';
                scrollEl.style.height = '';
                scrollEl.style.transform = '';
                scrollEl.style.transition = '';
                /* 把行移回 scrollEl 直接挂载并移除焦距层，还原普通模式布局 */
                const zl = scrollEl.querySelector('#wcZoom');
                if (zl) {
                    zl.style.transform = '';
                    zl.style.zoom = '1';
                    while (zl.firstChild) scrollEl.appendChild(zl.firstChild);
                    zl.remove();
                }
                globalThis.__wcCamSettled = true;
            }
            lineElements.forEach(el => {
                el.style.left = '';
                el.style.top = '';
                el.style.fontSize = '';
                el.style.zIndex = '';
            });
            wordcloudLayoutDone = false;
            wordcloudLayoutVer++;      /* 使相机焦点缓存失效 */
            wordcloudCamCache = null;
            wcBumpedIdx = null;        /* 清除（旧字号上采样状态已废弃，保留变量名兼容） */
            wordcloudCurrentX = 0;
            wordcloudCurrentY = 0;
            wordcloudCurrentScale = 1;
            if (wcZoomTimer) { clearTimeout(wcZoomTimer); wcZoomTimer = null; }
            wcDragState = null;
            wcTween = null;
            wcSettleAt = 0;
            wcLastTransform = '';
            wcSuppressClick = false;
        }

/* ========== 歌词高亮更新 ========== */
/* ★ 切行视觉同步调度器：blur + 虚拟滚动合并到下一帧执行，且只处理可视窗口内行数，
   避免切行瞬间整页 style 失效造成的"突然卡一下"。 */
let _lineVisualSyncRaf = null;
function scheduleLineVisualSync(centerIndex) {
    if (_lineVisualSyncRaf) cancelAnimationFrame(_lineVisualSyncRaf);
    _lineVisualSyncRaf = requestAnimationFrame(() => {
        _lineVisualSyncRaf = null;
        syncLineVisualRange(centerIndex);
    });
}
function syncLineVisualRange(centerIndex) {
    const total = lineElements.length;
    if (!total) return;
    const win = 14; /* 可视窗口 ±14 行；远处行屏幕外不可见，保持上次状态 */
    const from = Math.max(0, centerIndex - win);
    const to = Math.min(total - 1, centerIndex + win);
    for (let i = from; i <= to; i++) updateLineBlur(i);
    if (LYRICS_VIRTUAL_SCROLL.enabled && !amNormalLyricsMode()) updateVirtualLyricsRender(centerIndex);
}

function updateLyricsHighlight() {
            if (lyrics.length === 0 || lineElements.length === 0) return;
            const t = currentTime + lyricOffset;  /* 应用歌词偏移 */

            /* 二分查找当前活动行（O(log n)） */
            let newActiveIndex = -1;
            let lo = 0, hi = lyrics.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (lyrics[mid].start <= t) {
                    newActiveIndex = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            if (newActiveIndex === -1) newActiveIndex = 0;

            /* 活动行变化：只更新旧/新活动行附近受影响的几行，避免全量遍历 */
            if (newActiveIndex !== activeLineIndex) {
                const oldIndex = activeLineIndex;
                activeLineIndex = newActiveIndex;

                /* ★ 切行时立即收起间奏三点并清除挤下边距——必须在计算滚动目标之前，
                   否则旧行的 margin-bottom 会撑大新行 offsetTop，导致滚动目标偏移 */
                hideLyricsGapDots();

                if (oldIndex >= 0 && lineElements[oldIndex]) {
                    lineElements[oldIndex].classList.remove('active');
                    /* 重置旧行所有单词：高亮归零 + 移除浮动 active 类 */
                    const oldWords = wordElementsByLine[oldIndex] || [];
                    const oldHighlights = wordHighlightElementsByLine[oldIndex] || [];
                    for (let i = 0; i < oldWords.length; i++) {
                        if (oldWords[i] && oldWords[i].classList.contains('active')) oldWords[i].classList.remove('active');
                        if (oldHighlights[i]) {
                            /* ★ seek/切行后必须重置 --reveal 并清除 done，否则再次进入该行时
                               高亮停留在旧值（甚至 width 残留 0% 导致整层不可见） */
                            oldHighlights[i].style.width = '';
                            oldHighlights[i].style.setProperty('--reveal', '0%');
                            oldHighlights[i].classList.remove('done');
                        }
                        lastWordProgress.delete(oldWords[i]);
                    }
                }

                if (lineElements[activeLineIndex]) {
                    lineElements[activeLineIndex].classList.add('active');
                }

                /* ★ P4：行变化时同步手机版歌词预览 */
                updateMobileLyricPreview();

                /* ★ 词云模式 / PV 模式：跳过模糊和虚拟滚动（所有行必须可见或由专用引擎接管） */
                const isWordcloudMode = playerContainer.classList.contains('view-wordcloud');
                const isPvMode = playerContainer.classList.contains('view-pv');

                /* ★ 切行同步降尖峰：整页 blur 重排是切行瞬间"突然卡一下"的大头。
                   改为「可视窗口 ±14 行 + 顺延到下一帧」，当前帧只做高亮与行类切换，
                   模糊/虚拟滚动分摊到下一帧；远处行保持上次状态（屏幕外不可见）。 */
                if (!isUserScrolling && !isWordcloudMode && !isPvMode) {
                    scheduleLineVisualSync(activeLineIndex);
                }

                /* 飞入模式 / 词云模式 / 浮空与全景视觉模式：统一更新底部翻译/罗马音区域 */
                if (typeof updateFlyinTranslation === 'function' && activeLineIndex >= 0) {
                    updateFlyinTranslation(activeLineIndex);
                }

                if (playerContainer.classList.contains('view-flyin')) {
                    flyinAutoScaleFont();
                } else if (playerContainer.classList.contains('view-wordcloud')) {
                    /* 词云模式：不使用传统滚动，镜头跟焦由 updateWordcloudCamera 在每帧驱动 */
                } else if (isPvMode || (mainVisManager && mainVisManager.has(currentViewMode))) {
                    /* PV 模式与全景视觉模式：由独立渲染引擎进行运镜，跳过传统滚动 */
                } else if (!isUserScrolling && appSettings.lyrics.autoScroll && lineElements[activeLineIndex]) {
                    /* ★ 耦合弹簧纵波：活动行切换由物理引擎接管——
                       大跳（seek>2.5s）瞬时吸附，正常切行走弹簧波（锚点+耦合力+冲量） */
                    const tNow = currentTime + lyricOffset;
                    const lineStart = (lyrics[activeLineIndex] && lyrics[activeLineIndex].start) || 0;
                    const bigJump = isNaN(tNow) || Math.abs(tNow - lineStart) > 2500;
                    waveSetActiveFromPlayback(activeLineIndex, bigJump);
                }
            }

            /* 只更新当前活动行内的单词高亮，使用缓存的 .word-highlight 元素
               ★ 用户滚动时仍然更新逐字高亮，让用户看到当前播放进度 */
            {
                const activeWords = wordElementsByLine[activeLineIndex] || [];
                const activeHighlights = wordHighlightElementsByLine[activeLineIndex] || [];
                for (let j = 0; j < activeWords.length; j++) {
                    const wordEl = activeWords[j];
                    const highlightEl = activeHighlights[j];
                    if (!highlightEl) continue;
                    /* ★ 性能（2026-09-20）：dataset 每帧读+parseInt 是字符串解析开销——
                       逐字时间轴解析一次后用 WeakMap 缓存（歌词重渲染时元素重建自动失效） */
                    let timing = _wordTimingCache.get(wordEl);
                    if (timing === undefined) {
                        timing = { s: parseInt(wordEl.dataset.start) || 0, e: parseInt(wordEl.dataset.end) || 0 };
                        _wordTimingCache.set(wordEl, timing);
                    }
                    const start = timing.s;
                    const end = timing.e;
                    /* ★ P1 性能：数值百分比 + 恒定盒。写入 --reveal（LTR mask 前沿）
                       或 clip-path（RTL），不再动画 width → 每帧零重排 */
                    let pct;
                    if (t < start) {
                        pct = 0;
                    } else if (t >= end) {
                        pct = 100;
                    } else {
                        pct = Math.round((t - start) / (end - start) * 1000) / 10;
                    }
                    /* 一旦开始演唱就上浮并保持（Apple Music 风格，不再回落） */
                    if (t >= start && !wordEl.classList.contains('active')) {
                        wordEl.classList.add('active');
                        /* 情感词也逐字符上浮，不整组同时激活 */
                    }
                    /* 跳过未变化的目标值，避免无谓的样式写入与重绘 */
                    if (lastWordProgress.get(wordEl) === pct) continue;
                    if (highlightEl.classList.contains('rtl-highlight')) {
                        /* ★ 上下 -0.4em 外扩（2026-09-20 裁剪彻底修复）：inset 正值裁
                           字形上伸/下伸（g/j/y/f 不全），负值把裁剪区扩出行盒 */
                        highlightEl.style.clipPath = `inset(-0.4em 0 -0.4em ${100 - pct}%)`;
                    } else {
                        highlightEl.style.setProperty('--reveal', pct + '%');
                    }
                    /* 完全高亮后添加 done 移除前沿渐变，部分高亮时保留渐变 */
                    if (pct >= 100) {
                        highlightEl.classList.add('done');
                    } else {
                        highlightEl.classList.remove('done');
                    }
                    lastWordProgress.set(wordEl, pct);
                }
            }

            /* 词云模式：每帧驱动镜头阻尼跟焦
               ★ 性能分档：关闭时停用跟焦；开启时按 updateIntervalMs 节流相机写入 */
            if (playerContainer.classList.contains('view-wordcloud') && _wcPerf.enabled) {
                if (_wcPerf.intervalMs > 0) {
                    const now = performance.now();
                    if (now - _wcLastWrite >= _wcPerf.intervalMs) {
                        _wcLastWrite = now;
                        updateWordcloudCamera(t);
                    }
                } else {
                    updateWordcloudCamera(t);
                }
            }

            /* 默认/歌词模式：弹簧滚动 + 行间三点由常驻 rAF 驱动（ensureLyricsFxLoop），
               这里只需确保 loop 已启动（播放/暂停/滚轮都可用） */
            ensureLyricsFxLoop();
        }

/* ★ 词云模式性能分档消费：相机跟焦开关与节流
   由 180-boot-config.applyPerformanceProfile 调用。 */
let _wcPerf = { enabled: true, intervalMs: 0 };
let _wcLastWrite = 0;
/* ★ 逐字时间轴解析缓存（updateLyricsHighlight 每帧消费，见上方 ★ 性能注释） */
const _wordTimingCache = new WeakMap();
function wordcloudApplyPerf(profile = {}) {
    const w = profile.wordcloud || {};
    const v = profile.vfx || {};
    _wcPerf = {
        enabled: v.wcParticles !== false,
        intervalMs: (parseInt(w.updateIntervalMs) || 0)
    };
    _wcLastWrite = 0;
}

export { cleanupWordCloud, updateLyricsHighlight, updateWordcloudCamera, wordcloudApplyPerf };
