/* ============================================================
 * JizuraVisualizer.js — 「字面 · Jizura」视觉模式（第 10 种）
 *
 * 形态：**走 VisualizerManager + 继承 VisualizerBase**（不是照抄 tempera 的独立单例）。
 * 理由：基类白送 5 条链 —— 容器创建（VisualizerBase.js:33-41）、
 * `start/stop/destroy`（:143/:150/:209）、`setLyrics`（:67-83）、
 * 每帧 `onUpdate(timeMs, timeSec)`（:122）、性能档下发（VisualizerManager:105-118）；
 * 另外后台节流（287-bg-throttle.js 的 visualizerManager target）与设置分发
 * （190-settings-fontsize.js:333 的 `mainVisManager.has(mode)` 分支）也是**自动**的。
 * 走独立单例这五条都得自己修，漏一条就是"点了没反应"式的静默失效。
 *
 * 每帧只做四件：① 需要就重建 plan（切歌/改设置）② 帧节流（画面没到下一格就不画）
 * ③ 按容器尺寸定画布与倍率 ④ `renderer.frame(...)` 并**实测耗时喂给调速器**。
 * 分镜/卡点/抽签/后处理全在上游引擎里。
 *
 * ★ 性能（2026-10-06 实测后重写，此前"很卡"的根因）：
 *   · DPR 上限原为 2 → Windows 缩放 150%/200% 时像素数 ×4，单帧中位 43.5ms（≈23fps）。
 *     现在默认压到 1（实测同尺寸 11.0ms）。
 *   · 全程 60fps 重渲，而引擎动画时基是 24fps 且 koma=12 → **37% 的帧画面完全没变**。
 *     现在按 `plan.fps / fpsDiv` 量化帧号，没跨格就不画。
 *   · `fast`（关实时滤镜与色差通道）实测中位 1.2ms，是最粗的一根杠杆 → 交给调速器
 *     在负载超标时自动拉，并按迟滞回退（core/visualizers/jizura/jizuraPerf.js）。
 * ============================================================ */
import { VisualizerBase } from '../VisualizerBase.js';
import { logCatch, logInfo } from '../../../services/log.js';
import {
    JIZURA_FX_DEFAULTS, JIZURA_TAG, applyJizuraFontOverride, buildJizuraPlan, collectJizuraFx,
    computeWordSyncOverrides, currentTrackBpm, currentTrackEntry, getJizuraEngine, jizuraPlanKey,
    perfOptionsFor, planLineAt, trackFingerprint,
} from './jizuraBridge.js';
import {
    PERF_LEVELS, createPerfGovernor, qualityStartLevel, qualityToDprCap,
} from './jizuraPerf.js';

const TAG = JIZURA_TAG;

/** 重建 plan / 换档后的"不计入调速统计"帧数（见构造函数里的注释） */
const WARMUP_FRAMES = 15;

export class JizuraVisualizer extends VisualizerBase {
    constructor(container, options = {}) {
        super(container, options);
        this.canvas = null;
        this.ctx = null;
        this.renderer = null;
        this.J = null;
        this.plan = null;
        this._enginePromise = null;
        this._planKey = '';
        this._renderScale = 1;
        this._mvOn = false;
        this._mvObserver = null;
        this._destroyed = false;
        this._failed = false;
        this._perf = null;
        /* ── 自适应画质（core/jizuraPerf.js）── */
        this._quality = 'auto';
        this._governor = null;
        this._level = null;
        this._dprCap = 1;
        /* ── 帧节流 ── */
        this._lastFrameIdx = -1;
        this._forceFrame = true;
        /* 预热宽限：重建 plan / 换画质档后的头几帧含**一次性**成本
           （纸纹生成 + 缓存重建，实测 100ms+），拿它们判断"这台机器有多快"
           会把画质永久拉低（回退要 150 帧轻松才爬回来）。 */
        this._warmup = WARMUP_FRAMES;
        /* ── 尺寸缓存（不每帧 getBoundingClientRect：真机上那是强制重排）── */
        this._rect = null;
        this._resizeObserver = null;
        /* ── 真实 BPM（只读已缓存的分析结果；见 bridge 的 currentTrackBpm）── */
        this._bpm = 0;
        this._bpmKey = '';
        /* 模式专有参数（由 applySettings 从 modeSettings.jizura 下发） */
        this.modeOptions = {
            style: '',            /* 空 = 用上游默认 noir；'auto' = 走 J.omakase 抽签 */
            mood: null,
            aspect: '16:9',
            res: 1080,
            fps: 24,
            fast: null,           /* null = 按性能档/调速器自动；true/false 为手动覆盖 */
            perf: 'auto',         /* auto | eco | hd —— 面板上的性能档 */
            fontFamily: 'inherit', /* 引擎字形链用的字体（'inherit' = 跟随全局字体设置） */
            /* beat：动画节拍。'every' = 逐帧（节拍 = fps，默认）；'onTwos' = 上游原味一拍两格 */
            beat: 'every',
            /* fx：引擎的画面细节（六个数值 + flash/hud）。面板按**单键**下发，
               由 collectJizuraFx 收敛成引擎要的对象（默认值与上游 defaultProject 对齐） */
            fx: Object.assign({}, JIZURA_FX_DEFAULTS),
            /* wordSync：按字时间切分镜。
               ★ 默认 'off'（2026-10-07 用户反馈后改回）：本引擎里**一个 cut 就是一次分镜**
                 （各自带版式/运镜/转场/装饰），所以「按字切段」不是"文字更准"，而是
                 "把一行歌词拆成好几个画面"——切到每字一块时观感直接崩（一个字一个画面）。
                 'cuts' 最多 12 块仍保留（面板可开，且文案已写清代价），'chars' 只留在
                 代码与单测里**不在面板暴露**：它验证了"精确逐字"这条路走得通，
                 但也证明了这条路在这个引擎里不好看。 */
            wordSync: 'off',
        };
    }

    getModeId() { return JIZURA_TAG; }

    /* ------------------------------------------------------------ 生命周期 */

    onInit() {
        if (!this.viewContainer) return;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'jizura-canvas';
        this.viewContainer.appendChild(this.canvas);
        /* alpha:true —— MV 背景开着时要能透出下层视频 */
        this.ctx = this.canvas.getContext('2d', { alpha: true });
        this._bindMvWatcher();
        this._bindResize();
        this._applyQuality();
        this._watchFonts();   /* 字体可能比字形缓存晚到（见 _watchFonts） */
        /* 立刻定一次尺寸：别让画布停在 canvas 默认的 300×150（见 _layout 头注释） */
        this._layout(true);
        /* 引擎加载与首帧渲染都是异步的：这里只发起，不阻塞 init */
        void this._ensureEngine();
    }

    onLyricsLoaded() {
        /* 歌词变了 → 让下一帧重建 plan（不做同步重建：此时引擎可能还没就绪） */
        this._planKey = '';
        this._forceFrame = true;
    }

    onResize() {
        /* 尺寸变了：作废旧尺寸、强制重画一帧，并把调速统计清零
           （窗口大小变化会改变负载，拿旧 EMA 判断会误降/误升） */
        this._rect = null;
        this._forceFrame = true;
        if (this._governor) this._governor.reset();
        this._layout(true);
    }

    /**
     * 性能档（由 VisualizerManager.applyPerformanceProfile 自动下发）
     * @param {{dimension?:object, vfx?:object}} cfg
     */
    setPerfConfig(cfg) {
        this._perf = cfg || null;
    }

    onApplySettings(settings) {
        const s = settings || {};
        const next = this.modeOptions;
        let dirty = false;
        /* 面板的下拉把值写成字符串（data-value="1080"），而引擎要拿它做算术
           （res 参与画幅计算）—— 这里统一收敛成数字，别把 '1080' 漏进去。 */
        if (s.style !== undefined && next.style !== s.style) { next.style = String(s.style); dirty = true; }
        if (s.mood !== undefined) { const m = s.mood ? String(s.mood) : null; if (next.mood !== m) { next.mood = m; dirty = true; } }
        if (s.aspect !== undefined && next.aspect !== s.aspect) { next.aspect = String(s.aspect); dirty = true; }
        if (s.res !== undefined) { const r = Number(s.res) || 1080; if (next.res !== r) { next.res = r; dirty = true; } }
        if (s.fps !== undefined) { const f = Number(s.fps) || 24; if (next.fps !== f) { next.fps = f; dirty = true; } }
        /* fast 三态：null = 自动；true/false = 手动钉死（面板写的是布尔） */
        if (s.fast !== undefined) next.fast = (s.fast === null || s.fast === 'auto') ? null : !!s.fast;
        if (s.perf !== undefined && next.perf !== s.perf) {
            next.perf = String(s.perf || 'auto');
            this._applyQuality();
        }
        /* 字体（模式级 modeSettings.jizura.fontFamily）→ 引擎字形链。
           换字体**不需要重建 plan**（plan 里存的是角色键，不是字面），只需清字形缓存 + 重画。 */
        if (s.fontFamily !== undefined) {
            const fam = String(s.fontFamily === null ? '' : s.fontFamily);
            if (next.fontFamily !== fam) {
                next.fontFamily = fam;
                this._applyFont();
            }
        }
        /* 动画节拍：'every'（逐帧，默认）/ 'onTwos'（上游原味一拍两格） */
        if (s.beat !== undefined && next.beat !== s.beat) { next.beat = String(s.beat || 'every'); dirty = true; }
        /* 逐字跟唱：'off' / 'cuts' */
        if (s.wordSync !== undefined && next.wordSync !== s.wordSync) { next.wordSync = String(s.wordSync || 'off'); dirty = true; }
        /* 画面细节：面板下发的是**单键**（motion/glitch/chroma/… 见 defaults.js），
           这里收敛成引擎要的 fx 对象。密度/动感这类会改变分镜，所以脏了就重建 plan。 */
        {
            const r = collectJizuraFx(next.fx, s);
            if (r.dirty) { next.fx = r.fx; dirty = true; }
        }
        if (dirty) this._planKey = '';
        this._forceFrame = true;
    }

    /* ------------------------------------------------------------ 每帧 */

    onUpdate(timeMs, timeSec) {
        this._lastTime = Number(timeSec) || 0;
        if (this._destroyed || this._failed) return;
        if (!this.J) { void this._ensureEngine(); return; }
        const key = jizuraPlanKey(this.lines, this.modeOptions);
        if (key !== this._planKey) {
            if (!this._rebuildPlan(key)) return;
        }
        if (!this._shouldRender(timeSec)) return;
        this._render(timeSec);
    }

    /**
     * 帧节流：引擎的动画时基不高于 `plan.fps`（默认 24，且 koma=12 时有效更新率更低），
     * 同一格内重画得到的是**同一张画面**（实测 1/60 步进下 37% 的帧完全相同）。
     * @returns {boolean} 是否要真的渲染这一帧
     */
    _shouldRender(t) {
        const idx = this._frameIndex(t);
        if (this._forceFrame) {
            this._forceFrame = false;
            this._lastFrameIdx = idx;
            return true;
        }
        if (idx === this._lastFrameIdx) return false;
        this._lastFrameIdx = idx;
        return true;
    }

    _frameIndex(t) {
        const div = this._level ? this._level.fpsDiv : 1;
        return Math.floor(Number(t || 0) * (this._stepHz() / div));
    }

    /**
     * 引擎的**步长频率**：镜像上游 `J.komaOf` / `J.stepDur`（08_planner.js:47-48）。
     * `koma > 0` 时动画是"每秒 koma 张"的，与 plan.fps 无关 —— 按 fps 采样就是白渲
     * （一拍两格时 12 张/秒，按 24fps 画等于每张画两遍，实测正是那 37% 的白帧）。
     */
    _stepHz() {
        const fx = (this.plan && this.plan.fx) || {};
        const koma = fx.koma != null ? Number(fx.koma) : (fx.onTwos === false ? 0 : 12);
        if (Number.isFinite(koma) && koma > 0) return koma;
        return Math.max(1, Number(this.plan && this.plan.fps) || Number(this.modeOptions.fps) || 24);
    }

    /* ------------------------------------------------------------ 内部 */

    async _ensureEngine() {
        if (this.J) return this.J;
        if (!this._enginePromise) {
            this._enginePromise = getJizuraEngine().then((J) => {
                if (this._destroyed) return null;
                if (!J) { this._failed = true; return null; }
                this.J = J;
                this.renderer = new J.Renderer();
                /* 引擎晚于设置到达：这里补一次字体覆写，否则"先开设置再进模式"会丢字体 */
                this._applyFont();
                this._layout(true);      /* 引擎到了 → 画幅可按 J.designSize 精确定尺寸 */
                this._planKey = '';      /* 触发下一帧重建 plan */
                this._forceFrame = true;
                return J;
            }).catch((e) => { logCatch(TAG, e); this._failed = true; return null; });
        }
        return this._enginePromise;
    }

    _rebuildPlan(key) {
        try {
            const ai = this.aiData || {};
            /* 节拍 → 引擎的 fx.koma/onTwos（语义见 defaults.js 的 beat 注释）。
               上游默认是 onTwos/koma12（12 张/秒），我们默认改成逐帧（节拍 = fps）。 */
            const onTwos = this.modeOptions.beat === 'onTwos';
            const fx = Object.assign({}, this.modeOptions.fx || {},
                onTwos ? { koma: 12, onTwos: true } : { koma: 0, onTwos: false });
            /* onTwos 一律配 24（引擎的原生时基）——koma>0 时步长由 koma 决定，
               此时把 fps 调到 60 只是多画重复帧，纯浪费。 */
            const fps = onTwos ? 24 : (Number(this.modeOptions.fps) || 24);
            const opts = {
                ...this.modeOptions,
                title: ai.title || '',
                artist: ai.artist || '',
                bpm: this._bpm,
                fps,
                fx,
            };
            let plan = buildJizuraPlan(this.J, this.lines, opts);
            let syncedLines = 0;
            /* 逐字跟唱：把真实字时间折算成各行的分镜切点（块级，见 bridge 头注释）。
               ★ 只有带**真实**逐字的行才有覆盖项：歌词是合成值（均分近似）时等于没喂。 */
            let syncStats = null;
            if (plan && this.modeOptions.wordSync !== 'off') {
                /* 两遍：第一遍先拿到引擎算出的 visEnd（它切分时真正用的可见窗口），
                   再据此算切点、重建一次。一遍做不到 —— 窗口是引擎的决策，
                   我们猜它（比如用 Aria 的 line.end）就会在末行这类地方错位。 */
                const stats = { synced: 0, reduced: 0, skipped: 0 };
                const ov = computeWordSyncOverrides(this.lines, {
                    mode: this.modeOptions.wordSync, plan, stats,
                });
                const n = ov ? Object.keys(ov).length : 0;
                if (n > 0) {
                    const synced = buildJizuraPlan(this.J, this.lines, Object.assign({}, opts, { overrides: ov }));
                    if (synced) { plan = synced; syncedLines = n; syncStats = stats; }
                }
            }
            this._wordSyncStats = syncStats;
            if (!plan) { this.plan = null; return false; }
            this.plan = plan;
            this._planKey = key;
            this._forceFrame = true;
            this._warmup = WARMUP_FRAMES;                 /* 新画幅要先建纸纹，别拿那几帧判负载 */
            if (this._governor) this._governor.reset();   /* 新歌/新画幅 = 新负载，别用旧 EMA 判断 */
            this._rect = null;
            this._layout(true);
            logInfo(TAG, `plan 重建：${plan.cuts.length} cut / ${plan.lines.length} 行 / lang=${plan.lang} / ${plan.W}×${plan.H}`
                + ` / bpm=${this._bpm || '自估'} / ${onTwos ? '一拍两格' : fps + 'fps 逐帧'}`
                + ` / 逐字同步 ${syncedLines} 行`
                + (syncStats ? `（其中 ${syncStats.reduced} 行因窗口不足减块、${syncStats.skipped} 行跳过）` : ''));
            void this._kickBpmLookup();
            return true;
        } catch (e) {
            /* 单首歌画不出来不该让整个模式哑掉：记日志、本帧不画，下首歌再试 */
            logCatch(TAG, e);
            this.plan = null;
            this._planKey = key;
            return false;
        }
    }

    /**
     * 把 Aria 的字体设置应用到引擎的字形链上。
     * 解析用 `window.resolveFontFamily`（与 VisualizerBase.applySettings 同一套）：
     * 它把 'inherit'/'default'/内置键解析成真实 CSS 栈，也让**用户导入的自定义字体**直接生效
     * （那些字体由 fontService 注入 @font-face，家族名就在 Aria 的词表里）。
     * 只覆写 family、保留引擎自己的 weight，风格的粗细层级因此不会塌。
     */
    _applyFont() {
        if (!this.J) return;
        const raw = String(this.modeOptions.fontFamily === null || this.modeOptions.fontFamily === undefined
            ? '' : this.modeOptions.fontFamily).trim();
        /* ★ 先判"跟不跟"，再解析：'default'/'inherit'/空 在本模式的含义是**不覆写**，
           必须在这里拦住，不能交给 resolveFontFamily —— 那会把它们解析成全局字体栈
           （实测 'default' → "'Segoe UI', 'Microsoft YaHei', sans-serif"），
           于是"没设置"反而变成"把全部角色字体换成雅黑"，把引擎按日文字面设计的版式冲掉。 */
        const follow = !raw || raw === 'default' || raw === 'inherit' || raw === 'system';
        let stack = follow ? '' : raw;
        if (!follow && typeof window !== 'undefined' && typeof window.resolveFontFamily === 'function') {
            try {
                const resolved = String(window.resolveFontFamily(raw) || '');
                if (resolved) stack = resolved;
            } catch (e) {
                logCatch(TAG, e);
            }
        }
        const applied = applyJizuraFontOverride(this.J, stack);
        this._fontStack = applied ? stack : '';
        this._forceFrame = true;
        logInfo(TAG, `字体${applied ? '' : '（还原上游）'}：${applied ? stack : '引擎自带角色字体'}`);
        /* ★ 自定义字体是懒加载的（@font-face 只在用到时才去取），而引擎会把字形**烘进缓存**
           （J.glyphs / J.metrics）。若首次烘焙发生在字体到位之前，缓存里就是回退字形 ——
           字体稍后加载完成也不会自动重烘，观感上就是"字体不对"甚至"一片空白"。
           这里挂一次"字体加载完成 → 重烘"，只对自定义字体做（上游字体无需）。 */
        if (applied && !follow) this._watchFonts();
    }

    /**
     * 等自定义字体真正加载完，再重烘一次字形缓存。
     * `applyJizuraFontOverride` 内部会清 `J.glyphs`/`J.metrics`（见 bridge 头注释），
     * 所以"再调一次"就是"重烘"；配合 `_forceFrame` 让下一帧按新字形重画。
     */
    _watchFonts() {
        if (this._fontsBound || typeof document === 'undefined' || !document.fonts) return;
        this._fontsBound = true;
        const rebake = () => {
            if (this._destroyed || !this.J || !this._fontStack) return;
            try {
                applyJizuraFontOverride(this.J, this._fontStack);
                this._forceFrame = true;
                logInfo(TAG, `字体已加载，重烘字形：${this._fontStack}`);
            } catch (e) { logCatch(TAG, e); }
        };
        this._onFontsDone = rebake;
        try { document.fonts.addEventListener('loadingdone', rebake); } catch (e) { logCatch(TAG, e); }
        try { Promise.resolve(document.fonts.ready).then(rebake).catch((e) => logCatch(TAG, e)); } catch (e) { logCatch(TAG, e); }
    }

    /**
     * 海报抓帧前的"补到整行唱完"（P3.5，由 app/304-lyric-poster.js 调用）。
     *
     * 为什么需要：画布绘字的模式改不了 DOM，海报只能抓**当前这一帧**的画布；
     * 而暂停或在句中抓帧时，引擎按播放时间只亮到半句 —— 海报上就是半句。
     * 这里把画布**再渲一帧到"这一行唱完"的时刻**（行尾前一格），抓完由调用方还原。
     *
     * @returns {(() => void)|null} 还原函数；返回 null 表示本次不补（调用方照原样抓）
     */
    stageForPoster() {
        if (this._destroyed || !this.J || !this.plan || !this.ctx) return null;
        const idx = this.activeLineIndex;
        const line = (idx >= 0 && this.lines && this.lines[idx]) ? this.lines[idx] : null;
        if (!line) return null;
        const startSec = Number(line.start) / 1000;
        const endSec = Number(line.end) / 1000;
        if (!Number.isFinite(startSec)) return null;
        /* 引擎认为这一行可见到什么时候：有匹配的计划行就以它的 visEnd 为准
           （开了行尾通道时 = 真实行尾；没开时 = 引擎的估算），否则回落到 Aria 的行尾 */
        const planLine = planLineAt(this.plan, startSec);
        let visEnd = Number.isFinite(endSec) ? endSec : startSec;
        if (planLine && Number.isFinite(Number(planLine.visEnd))) visEnd = Number(planLine.visEnd);
        const step = 1 / Math.max(1, this._stepHz());
        /* ★ 补帧时刻取**定格相位的中点**，不是"行尾前一格"：
           退场动画会在这行结束前把它冲淡/移走 —— 在行尾抓帧会得到一张"正在消失"的图。
           定格相位 = [cut.start + inDur, cut.end - outDur]，取中点最稳（进完场、未开始退场）。 */
        const now = Number(this._lastTime) || 0;
        const cuts = (this.plan.cuts || []).filter(
            (c) => c && planLine && Number(c.line) === Number(planLine.index));
        let t = Math.max(startSec, visEnd - step);
        if (cuts.length) {
            const cut = cuts.find((c) => now >= c.start && now < c.end) || cuts[cuts.length - 1];
            const inDur = Number(cut.inDur) || 0;
            const outDur = Number(cut.outDur) || 0;
            const holdStart = Number(cut.start) + inDur;
            const holdEnd = Math.max(holdStart, Number(cut.end) - outDur);
            t = Math.max(startSec, Math.max(holdStart, Math.min(holdEnd, (holdStart + holdEnd) / 2)));
        }
        const prevIdx = this._lastFrameIdx;
        try {
            this._render(t);
        } catch (e) {
            logCatch(TAG, e);
            return null;
        }
        logInfo(TAG, `海报补帧：当前行 ${startSec}s → 渲到 ${t.toFixed(2)}s（整行唱完）`);
        return () => {
            this._lastFrameIdx = prevIdx;
            this._forceFrame = true;   /* 下一帧按真实播放时间重画，画面不会停在补帧上 */
        };
    }

    /**
     * 查一次"当前曲目已缓存的 BPM"，拿到就按真实节拍重建 plan。
     * 每首歌只查一次（用指纹去重）；异步返回后若值真变了才置脏，
     * 否则每帧重建 plan 会把帧预算烧光（实测一次 plan 重建 = 建纸纹 + 抽签，100ms 级）。
     */
    async _kickBpmLookup() {
        if (this._destroyed) return;
        const entry = currentTrackEntry();
        if (!entry) return;
        const fp = trackFingerprint(entry);
        if (!fp || fp === this._bpmKey) return;
        this._bpmKey = fp;
        try {
            const bpm = await currentTrackBpm(entry);
            if (this._destroyed || !bpm || bpm === this._bpm) return;
            this._bpm = bpm;
            this._planKey = '';        /* 置脏：下一帧按真实节拍重建 */
            this._forceFrame = true;
            logInfo(TAG, `取到已缓存的 BPM=${bpm}，按真实节拍重建卡点网格`);
        } catch (e) {
            logCatch(TAG, e);
        }
    }

    /** 建调速器（画质档变了就重建；eco 档把下界也钉在最低档，不给它爬回来） */
    _applyQuality() {
        const q = this.modeOptions.perf || 'auto';
        const last = PERF_LEVELS.length - 1;
        this._quality = q;
        this._dprCap = qualityToDprCap(q);
        this._governor = createPerfGovernor({
            startLevel: qualityStartLevel(q),
            minLevel: q === 'eco' ? last : 0,
            maxLevel: last,
        });
        this._level = this._governor.level();
        this._forceFrame = true;
        this._rect = null;
        this._warmup = WARMUP_FRAMES;   /* 换档后画布尺寸变了，头几帧同样含一次性成本 */
        logInfo(TAG, `画质档 ${q}：DPR 上限 ${this._dprCap}，起始档 ${this._level.key}`);
    }

    /** 监听 `body.mv-bg-on`：MV 开关不触发切换，只能自己看（与 296 监听 sink 同理） */
    _bindMvWatcher() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
        this._mvOn = document.body.classList.contains('mv-bg-on');
        try {
            this._mvObserver = new MutationObserver(() => {
                const on = document.body.classList.contains('mv-bg-on');
                if (on === this._mvOn) return;
                this._mvOn = on;
                this._forceFrame = true;
                if (this.viewContainer) this.viewContainer.classList.toggle('jizura-mv', on);
            });
            this._mvObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        } catch (e) {
            logCatch(TAG, e);
        }
    }

    /**
     * 尺寸变化改由 ResizeObserver 驱动。
     * ★ 原实现每帧 `getBoundingClientRect()`：那会**强制重排**（读布局 → 刷样式），
     *   在每帧被调用等于把浏览器刚算好的布局反复作废。headless 里量到 0.002ms 看不出，
     *   真机（WebView2）上它是那种"明明渲染很快却整体掉帧"的隐形开销。
     */
    _bindResize() {
        if (typeof ResizeObserver === 'undefined' || !this.viewContainer) return;
        try {
            this._resizeObserver = new ResizeObserver(() => {
                this._rect = null;
                this._forceFrame = true;
            });
            this._resizeObserver.observe(this.viewContainer);
        } catch (e) {
            logCatch(TAG, e);
        }
        this._measure();
    }

    _measure() {
        try {
            if (this.viewContainer && typeof this.viewContainer.getBoundingClientRect === 'function') {
                const r = this.viewContainer.getBoundingClientRect();
                this._rect = { width: r.width, height: r.height };
            }
        } catch (e) {
            this._rect = null;
        }
        return this._rect;
    }

    /**
     * 定画布尺寸与缩放。
     * · CSS 尺寸 = 设计画幅按容器**等比 contain**（留白由 CSS 居中）；
     * · 背面存储 = CSS 尺寸 × 调速倍率 × DPR（默认 DPR 上限 1）。
     * 降的是**渲染像素数**，不是质量参数 —— 后者由 `fast` 控制，两者别混。
     *
     * ★ 没有 plan 时也要定尺寸（2026-10-07 补）：此前开头是 `if (!this.plan) return`，
     *   于是「无歌词」或「引擎还没加载完」期间画布保持 canvas 元素的 HTML 默认值
     *   **300×150** —— 观感上就是容器里角落一小块、比例也不对。现在退回
     *   当前画幅（引擎的 `J.designSize(aspect)`，没引擎时按 aspect 自己算），
     *   保证任何时刻画布都与容器同形。
     */
    _layout(force) {
        if (!this.canvas) return;
        let box = this._rect;
        if (force || !box) box = this._measure();
        if (!box && !force) box = this._measure();
        const cw = Math.max(1, Math.round((box && box.width) || this.width || 1280));
        const ch = Math.max(1, Math.round((box && box.height) || this.height || 720));
        const [W, H] = this._designSize();
        const level = this._level || PERF_LEVELS[0];
        const cssFit = Math.min(cw / W, ch / H);
        const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, this._dprCap);
        const pxW = Math.max(2, Math.round(W * cssFit * level.resScale * dpr));
        const pxH = Math.max(2, Math.round(H * cssFit * level.resScale * dpr));
        if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
            this.canvas.width = pxW;
            this.canvas.height = pxH;
        }
        const cssW = Math.round(W * cssFit);
        const cssH = Math.round(H * cssFit);
        if (this.canvas.style.width !== `${cssW}px`) this.canvas.style.width = `${cssW}px`;
        if (this.canvas.style.height !== `${cssH}px`) this.canvas.style.height = `${cssH}px`;
        this._renderScale = pxW / W;
    }

    /**
     * 当前的**设计画幅**（W, H）。
     * 有 plan 就用它的（plan.W/H 是引擎按 aspect 定的设计尺寸）；
     * 没有 plan 时问引擎要（`J.designSize(aspect)` 是唯一事实源）；
     * 引擎还没加载到就按 aspect 自己算一次，保证"任何时刻都有个正确比例"。
     */
    _designSize() {
        if (this.plan && this.plan.W && this.plan.H) return [this.plan.W, this.plan.H];
        const aspect = String(this.modeOptions.aspect || '16:9');
        if (this.J && typeof this.J.designSize === 'function') {
            try {
                const d = this.J.designSize(aspect);
                if (d && d[0] && d[1]) return [d[0], d[1]];
            } catch (e) { logCatch(TAG, e); }
        }
        const m = /^(\d+):(\d+)$/.exec(aspect);
        if (m) return [Math.max(2, Math.round(1080 * Number(m[1]) / Number(m[2]))), 1080];
        return [1920, 1080];
    }

    _renderOptions() {
        const body = (typeof document !== 'undefined' && document.body) ? document.body.classList : null;
        const html = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement.classList : null;
        const flags = {
            softwareRenderer: !!(html && html.contains('is-software-renderer')),
            minimal: !!(body && body.contains('perf-minimal')),
            low: !!(body && body.contains('perf-low')),
            mvOn: this._mvOn,
        };
        const auto = perfOptionsFor(flags);
        /* 三个来源取**更省**的那一个：性能分档判定（静态）、实测调速（动态）、
           手动覆盖（用户明说）。手动覆盖优先；否则"静态判定 or 动态调速"取 or —— 
           两者都是"这机器扛不住"的证据，取更省者不会误伤。 */
        const level = this._level || PERF_LEVELS[0];
        auto.fast = (this.modeOptions.fast !== null)
            ? !!this.modeOptions.fast
            : (auto.fast || !!level.fast);
        return auto;
    }

    _render(t) {
        if (!this.renderer || !this.plan || !this.ctx || !this.canvas) return;
        this._layout(false);
        const opts = this._renderOptions();
        opts.scale = this._renderScale;
        const hasPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function');
        const t0 = hasPerf ? performance.now() : 0;
        try {
            /* 透明通道（MV）：引擎自己不铺底，我们必须先清成透明，
               否则上一帧的残影会留在画布上（非透明时引擎会整幅重铺，不需要清）。 */
            if (opts.transparent) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.renderer.frame(this.ctx, this.plan, t, opts);
        } catch (e) {
            logCatch(TAG, e);
        }
        if (hasPerf && this._governor) {
            if (this._warmup > 0) {
                /* 宽限期内只渲染、不统计（一次性成本见构造函数注释） */
                this._warmup--;
            } else {
                const before = this._governor.index();
                const lv = this._governor.sample(performance.now() - t0);
                this._level = lv;
                if (this._governor.index() !== before) {
                    this._forceFrame = true;   /* 档位变了：立刻按新倍率重画一帧 */
                    logInfo(TAG, `画质自动调整 → ${lv.key}（EMA ${this._governor.ema().toFixed(1)}ms，第 ${this._governor.samples()} 帧）`);
                }
            }
        }
    }

    /* ------------------------------------------------------------ 释放 */

    destroy() {
        this._destroyed = true;
        try {
            if (this._mvObserver) { this._mvObserver.disconnect(); this._mvObserver = null; }
            if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
            if (this._onFontsDone && typeof document !== 'undefined' && document.fonts
                && typeof document.fonts.removeEventListener === 'function') {
                document.fonts.removeEventListener('loadingdone', this._onFontsDone);
                this._onFontsDone = null;
            }
        } catch (e) { logCatch(TAG, e); }
        /* ★ 内存：引擎渲染器持有 paperCache（每张纸 W/2×H/2，1080p 一张 ≈ 2MB）、
           4 张 256² 噪点、以及若干临时画布 —— 实测常驻可达 55~65MB。
           切走模式必须把它们交还 GC（引擎单例本身留着，它只放部件表，很轻）。 */
        try {
            const r = this.renderer;
            if (r) {
                if (r.paperCache && typeof r.paperCache.clear === 'function') r.paperCache.clear();
                r.paperCache = null;
                r.grain = [];
                r.scratch = null; r.small = null; r.tiny = null; r.scan = null;
            }
        } catch (e) { logCatch(TAG, e); }
        if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
        this.renderer = null;
        this.canvas = null;
        this.ctx = null;
        this.plan = null;
        this._governor = null;
        super.destroy();
    }
}
