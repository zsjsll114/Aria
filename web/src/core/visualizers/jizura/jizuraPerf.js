/* ============================================================
 * jizuraPerf.js — 「字面 · Jizura」自适应画质调速器（纯逻辑，无 DOM，可单测）
 *
 * 为什么需要它（2026-10-06 实测，1280×720 容器，headless Chromium）：
 *   ┌───────────────────────────┬──────────┬───────────┐
 *   │ 组合                      │ 中位     │ p90       │
 *   ├───────────────────────────┼──────────┼───────────┤
 *   │ dpr 2 + 全滤镜            │ 43.5ms   │ 117.5ms   │  ← ≈23fps，体感"很卡"
 *   │ dpr 1 + 全滤镜            │ 11.0ms   │  26.6ms   │
 *   │ dpr 1 + fast（关滤镜色差）│  1.2ms   │  12.7ms   │  ← 10× 收益
 *   └───────────────────────────┴──────────┴───────────┘
 *   另有：以 1/60 秒步进扫 60 帧，**59 对里有 22 对画面完全相同**（37% 白渲）——
 *   引擎的动画时基是 24fps 且默认 koma=12（一拍两格），按 60fps 重渲纯属浪费。
 *
 * 三根杠杆按"收益 / 观感代价"排序 ⇒ 降级顺序固定为：
 *   ① fast        （10× 收益，代价：关实时滤镜与色差通道）
 *   ② 渲染倍率    （~1.8× 收益/档，代价：轻微变软）
 *   ③ 帧节流 ÷2   （~2× 收益，代价：12fps 的"一拍两格"观感，与上游 koma 同源）
 * 本模块只负责"按实测帧耗时在这三根杆之间自动移动"，并带回退迟滞，
 * 避免在阈值附近来回抖成"清晰度闪烁"。
 * ============================================================ */

/** 画质档（索引越小越清晰；调速器只能在这些档之间移动） */
export const PERF_LEVELS = [
    { key: 'full', fast: false, resScale: 1, fpsDiv: 1 },
    { key: 'fast', fast: true, resScale: 1, fpsDiv: 1 },
    { key: 'fast-low', fast: true, resScale: 0.75, fpsDiv: 1 },
    { key: 'eco', fast: true, resScale: 0.6, fpsDiv: 2 },
];

/**
 * 面板偏好 → DPR 上限。
 * ★ 默认 1：本模式是"文字 PV"（字号大、笔触粗），DPR>1 的锐度收益很小，
 *   像素数却按平方涨（实测 43.5ms vs 11.0ms）。Windows 缩放 150%/200% 时
 *   `devicePixelRatio` 是 1.5/2 —— 之前把它当上限就是"旧电脑上必然卡"的写法。
 */
export function qualityToDprCap(quality) {
    if (quality === 'eco') return 1;
    if (quality === 'hd') return 2;
    return 1;
}

/** 面板偏好 → 起始档位（eco 直接钉在最低档，不给它机会爬回去） */
export function qualityStartLevel(quality) {
    if (quality === 'eco') return PERF_LEVELS.length - 1;
    return 0;
}

/**
 * 建一个调速器。
 * @param {{targetMs?:number, downAfter?:number, upAfter?:number, upSlack?:number,
 *          startLevel?:number, minLevel?:number, maxLevel?:number}} [opts]
 * @returns {{level:Function, index:Function, ema:Function, samples:Function,
 *            sample:Function, reset:Function}}
 */
export function createPerfGovernor(opts = {}) {
    /* 单帧预算 12ms 而不是 16.7ms：rAF 里还跑着歌词滚动、封面动画等主线程工作，
       把整帧预算全吃掉会让"看起来还行"但整体掉帧。 */
    const targetMs = opts.targetMs > 0 ? opts.targetMs : 12;
    const downAfter = opts.downAfter > 0 ? opts.downAfter : 10;
    const upAfter = opts.upAfter > 0 ? opts.upAfter : 150;
    const upSlack = opts.upSlack > 0 ? opts.upSlack : 0.55;
    const minLevel = Number.isFinite(opts.minLevel) ? opts.minLevel : 0;
    const maxLevel = Number.isFinite(opts.maxLevel) ? opts.maxLevel : PERF_LEVELS.length - 1;
    const startLevel = Number.isFinite(opts.startLevel) ? opts.startLevel : 0;

    let idx = Math.min(Math.max(startLevel, minLevel), maxLevel);
    let ema = 0;
    let over = 0;
    let easy = 0;
    let samples = 0;

    const level = () => PERF_LEVELS[idx];

    return {
        level,
        index: () => idx,
        ema: () => ema,
        samples: () => samples,
        /**
         * 喂一帧的渲染耗时（ms），返回当前生效的档位。
         * 用 EMA（0.8/0.2）而不是单帧判断：分镜切换帧天然会尖一下（实测 p90 12.7ms、
         * max 65.9ms 都出现在转场），按单帧降级会导致"每次转场都掉清晰度"。
         */
        sample(ms) {
            const v = Number(ms);
            if (!Number.isFinite(v) || v < 0) return level();
            samples++;
            ema = samples === 1 ? v : ema * 0.8 + v * 0.2;
            if (ema > targetMs) { over++; easy = 0; } else { over = 0; easy = ema < targetMs * upSlack ? easy + 1 : 0; }
            if (over >= downAfter && idx < maxLevel) { idx++; over = 0; easy = 0; }
            else if (easy >= upAfter && idx > minLevel) { idx--; over = 0; easy = 0; }
            return level();
        },
        /** 重置统计（切歌/改窗口尺寸/改设置后调用，别拿旧负载误判新场景） */
        reset() { ema = 0; over = 0; easy = 0; samples = 0; },
    };
}
