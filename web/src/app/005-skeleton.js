/* ============================================================
 * 005-skeleton.js — 全局骨架屏（统一规范）
 * ------------------------------------------------------------
 * 所有「列表/宫格/歌词加载占位」统一走 Aria.__skeleton(kind, n)：
 *   __skeleton('cards',  n) → 宫格卡骨架（封面方块 + 名称行）
 *   __skeleton('list',   n) → 列表行骨架（序号位 + 封面 + 标题行 + 歌手行 + 操作位）
 *   __skeleton('lyrics', n) → 歌词区骨架（居中多行文字，切歌/加载歌词用）
 * 样式：src/styles/rankings.css 的 .sk 系列（index.html 全站加载）。
 * shimmer 自动随 body.perf-minimal 与 prefers-reduced-motion 关闭。
 * 本模块须最早加载（index.js 第二个 import），任何分片运行期可安全调用。
 *
 * ★ 时序规范（推荐用下面这组，而不是直接写 innerHTML）：
 *     Aria.skeleton.load(el, 'list', 8);   // 安排骨架（延迟后才真正写入）
 *     Aria.skeleton.settle(el, html);      // 满足最短展示时长后写入真实内容
 *   为什么需要：直连本机自建 / 缓存命中常常 <150ms，直接写骨架会「闪一下」，
 *   比不显示更廉价。`el.innerHTML = Aria.__skeleton(...)` 是旧写法，仍可用，
 *   但不做时序控制（不会有 bug，只是会闪）。
 * ============================================================ */
Aria.__skeleton = function (kind, n = 6) {
    if (kind === 'cards') {
        const card = '<div class="sk-card"><div class="sk sk-banner"></div><div class="sk sk-line short"></div></div>';
        return `<div class="sk-grid">${card.repeat(n)}</div>`;
    }
    if (kind === 'lyrics') {
        /* 居中歌词块：行宽大小错落，模拟真实歌词排版 */
        const widths = ['62%', '84%', '100%', '92%', '70%', '78%', '88%', '58%'];
        const lines = Array.from({ length: n }, (_, i) =>
            `<div class="sk sk-line" style="width:${widths[i % widths.length]}"></div>`).join('');
        return `<div class="skeleton-lyrics">${lines}</div>`;
    }
    /* 默认 list（保持向后兼容） */
    const row = '<div class="sk-row"><div class="sk sk-index"></div><div class="sk sk-cover"></div><div class="sk-col"><div class="sk sk-line wide"></div><div class="sk sk-line short"></div></div><div class="sk sk-ops"></div></div>';
    return `<div class="sk-list">${row.repeat(n)}</div>`;
};

/* ---------------- 骨架屏时序控制器 ---------------- */
/* 两个阈值按「本机自建/缓存 <150ms、第三方接口 300ms+」的实测分布定：
   · DELAY      150ms —— 这之内返回的请求根本不显示骨架（消除快响应的闪烁）
   · MIN_VISIBLE 280ms —— 骨架一旦真的出现，至少停留这么久再换成内容
                           （避免出现 20ms 就消失的「抖一下」）
   ★ 关键设计：load() 会挂一个 MutationObserver。只要**别的代码**往这个容器写了内容
     （成功/失败/空态等散落各处的 innerHTML 写入），骨架自动让位、绝不覆盖。
     所以接入成本只有「把 `el.innerHTML = Aria.__skeleton(...)` 换成 `Aria.skeleton.load(el, ...)`
     **一行**」，调用方原有的成功/失败渲染路径一个字都不用改。
   纯装饰：骨架块对读屏隐藏，容器用 aria-busy 表达「加载中」。 */
const SK_DELAY = 150;
const SK_MIN_VISIBLE = 280;
const _skState = new WeakMap();

function _skDisarm(st) {
    if (st.showT) { clearTimeout(st.showT); st.showT = 0; }
    if (st.writeT) { clearTimeout(st.writeT); st.writeT = 0; }
    if (st.obs) { try { st.obs.disconnect(); } catch { /* ignore */ } st.obs = null; }
    st.visible = false;
    st.suppress = false;
}

Aria.skeleton = {
    DELAY: SK_DELAY,
    MIN_VISIBLE: SK_MIN_VISIBLE,

    /** 安排骨架：DELAY 后才写入；期间若被外部写入或 settle 抢到，就静默让位。 */
    load(el, kind, n = 6, opts = {}) {
        if (!el) return;
        let st = _skState.get(el);
        if (!st) {
            st = { showT: 0, writeT: 0, shownAt: 0, visible: false, obs: null, suppress: false };
            _skState.set(el, st);
        }
        _skDisarm(st);
        el.setAttribute('aria-busy', 'true');
        /* 外部写入检测：childList 变化即认为有人接管了这个容器 */
        try {
            st.obs = new MutationObserver(() => {
                if (st.suppress) { st.suppress = false; return; }
                _skDisarm(st);
                el.removeAttribute('aria-busy');
            });
            st.obs.observe(el, { childList: true });
        } catch { st.obs = null; }
        st.showT = setTimeout(() => {
            st.showT = 0;
            st.visible = true;
            st.shownAt = Date.now();
            st.suppress = true;   /* 这一次 mutation 是我们自己造成的，不算外部接管 */
            el.innerHTML = (opts.prefix || '') + Aria.__skeleton(kind, n);
            const box = el.querySelector('.sk-grid, .sk-list, .skeleton-lyrics');
            if (box) box.setAttribute('aria-hidden', 'true');
        }, SK_DELAY);
    },

    /** 写入真实内容并补足最短展示时长。骨架没出现过则同步写入（等同旧行为）。 */
    settle(el, html) {
        if (!el) return;
        const st = _skState.get(el);
        if (!st) {
            el.removeAttribute('aria-busy');
            el.innerHTML = html;
            return;
        }
        const wasVisible = st.visible;
        const shownAt = st.shownAt;
        _skDisarm(st);
        const wait = wasVisible ? Math.max(0, SK_MIN_VISIBLE - (Date.now() - shownAt)) : 0;
        if (!wait) {
            el.innerHTML = html;
            el.removeAttribute('aria-busy');
            return;
        }
        st.writeT = setTimeout(() => {
            st.writeT = 0;
            el.innerHTML = html;
            el.removeAttribute('aria-busy');
        }, wait);
    },

    /** 兜底：清掉骨架状态与忙碌标记（视图切换/容器被移除时用）。 */
    cancel(el) {
        if (!el) return;
        const st = _skState.get(el);
        if (st) _skDisarm(st);
        el.removeAttribute('aria-busy');
    }
};