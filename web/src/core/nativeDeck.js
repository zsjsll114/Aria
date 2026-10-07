/* ============================================================
 * core/nativeDeck.js — 把原生引擎伪装成一个 <audio> 元素（原生输出线 Phase 2b）
 *
 * 为什么是「鸭子类型」而不是「改造全库」：30 个分片都在读 `audio.currentTime`
 * / `audio.duration` / `audio.src`。与其逐个换成引擎调用（改一处漏一处），
 * 不如提供一个**同形替身**，插进 20-lyrics-render 的 `audio` live binding 即可
 * ——全库一行不用改，这是 dualDeck 当初把 `const audio` 改成 `export let` 的
 * 同一个理由。
 *
 * ── 三个不显然的契约 ──────────────────────────────────────────
 *
 * 1. **时钟必须插值，且不能逐帧 invoke。** 引擎以 20Hz 推进度，`currentTime`
 *    如果每次都问一次后端，60fps 的歌词循环会把主线程压满（JSON over 消息循环），
 *    逐字高亮立刻开始抖。所以：轮询 20Hz 取锚点，rAF 读属性时用
 *    `performance.now()` 线性外推，每次收到新锚点就重锚定。误差被压在一帧以内。
 *    ↑ 这同时是为什么 currentTime 是 **getter 带计算**，不是缓存字段。
 *
 * 2. **事件要自己合成，且必须是 HTML 的时序语义。** 分片监听
 *    play/pause/ended/loadedmetadata/canplay/error 等。HTML 里 `play()` 一调用就
 *    同步派发 `play`（paused 同时变 false），**不等**数据真的流动；`pause()` 同理。
 *    这里照抄该语义（乐观派发 + 失败回滚），否则播放按钮的图标会比声音慢半拍。
 *    另外 `_optimisticUntil` 窗口抑制「乐观态与下一次快照相反」造成的假事件
 *    ——引擎收命令到改状态之间隔着一条线程边界，50ms 内可能还是旧值。
 *
 * 3. **能力缺口要显式，不能静默降级。** 赋值非 1 的 `playbackRate` 曾经"接受但不生效"
 *    （引擎没有变速），所以当时会留一条警告日志、app/298 也在开启原生输出前先提示用户。
 *    ★ 2026-10-05：引擎补上了变速（解码→ring 之间的分数重采样，见 `engine.rs::spawn_decode`），
 *    所以现在 `playbackRate` 经 `rateProvider` 真正下发到 Rust 链并生效，警告已撤除。
 *    **音色**：Rust 侧是线性重采样 ⇒ 音色随速度变（黑胶那种），Web 侧练习模式因此
 *    同步把 `preservesPitch` 置 false，保证两条路径听感一致。
 *
 * 依赖注入：`api` 默认取 nativeBridge，测试注入假实现即可在 node 里跑（不碰 Tauri）。
 * ============================================================ */
import * as bridge from './nativeBridge.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'nativeDeck';

/** 与引擎推送节奏对齐的轮询间隔。**不要再降**：再低插值窗口就长到能听出进度跳。 */
const POLL_MS = 50;
/** 合成 timeupdate 的节奏 ≈ 浏览器原生（约 4Hz）。分片里 timeupdate 只做低频对齐，
 *  逐字高亮走的是 rAF 读 currentTime，所以这里不需要更快。 */
const TIMEUPDATE_MS = 250;
/** 乐观事件抑制窗口（见文件头 2） */
const OPTIMISTIC_MS = 300;
/** 等价于 HTMLMediaElement.HAVE_ENOUGH_DATA：`readyState >= 2` 是本库的「就绪」判据 */
const READY_STATE_LOADED = 4;
/** 在途加载的兜底期限（在线曲目要 HTTP 拉全曲，给得宽一点；只用于「对方彻底没反应」） */
const LOAD_TIMEOUT_MS = 30000;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * 造一个原生 deck。
 * @param {{api?:object, pollMs?:number, eqProvider?:Function, spatialProvider?:Function,
 *          rateProvider?:Function}} [opts]
 *   api 形如 nativeBridge 的导出集合（load/play/pause/seek/setVolume/snapshot/…）
 *   eqProvider 返回 `{enabled, gainsDb}`：引擎的 EQ 是**跨曲目偏好**、不存在于
 *   元素上，而 app 层的 `state.eqGains` 会经多条路径变化（滑杆、预设、图初始化）。
 *   与其在每条路径上挂钩子（漏一条就静默不一致），不如让本模块在既有的 20Hz 轮询里
 *   比对一次快照字符串——10 个数的 join 比一次 IPC 便宜四个数量级，且天然收全。
 *   spatialProvider 同理，返回 `{spatialEnabled, spatialLevel, ir, stageEnabled, stageLevel}`：
 *   空间音频 / 虚拟声场也是跨曲目偏好，而 WASAPI 独占时 Web Audio 图整条不生效，
 *   **只有走 IPC 下发到 Rust 链**才听得到（方案 §2.3）。
 *   rateProvider 返回**数字**（播放速率）：同理——独占路径的音频是 Rust 自己解码的，
 *   `<audio>.playbackRate` 到不了那里，不下发就是"独占模式下变速完全没反应"。
 */
export function createNativeDeck(opts) {
    const api = (opts && opts.api) || bridge;
    const pollMs = (opts && opts.pollMs) || POLL_MS;
    const eqProvider = (opts && opts.eqProvider) || null;
    const spatialProvider = (opts && opts.spatialProvider) || null;
    const rateProvider = (opts && opts.rateProvider) || null;

    return new NativeDeck(api, pollMs, eqProvider, spatialProvider, rateProvider);
}

/** 判定一个对象是不是本模块产的 deck（app 层用它决定要不要走原生分支） */
export function isNativeDeck(x) {
    return !!(x && x.__nativeDeck === true);
}

class NativeDeck {
    constructor(api, pollMs, eqProvider, spatialProvider, rateProvider) {
        this.__nativeDeck = true;
        this._api = api;
        this._pollMs = pollMs;
        this._eqProvider = eqProvider;
        this._eqKey = null;
        this._spatialProvider = spatialProvider;
        this._spatialKey = null;
        this._rateProvider = rateProvider;
        this._rateKey = null;

        /* ---- 元素属性 ---- */
        this._src = '';
        this._currentSrc = '';
        this._volume = 1;
        this._rate = 1;
        this._preservesPitch = true;

        /* ---- 播放状态（快照锚点） ---- */
        this._hasTrack = false;
        this._playing = false;
        this._ended = false;
        this._readyState = 0;
        this._duration = 0;
        this._position = 0;
        this._anchor = now();
        this._error = null;
        this._sampleRate = 0;
        this._outputMode = 'shared';
        this._sampleFormat = 'f32';

        /* ---- 加载/时钟内部 ---- */
        this._pendingLoad = false;
        this._pendingLoadDeadline = 0;
        this._loadedSrc = '';
        this._pendingSeek = null;
        this._errBaselinePending = false;
        this._lastErrText = null;
        this._optimisticUntil = 0;
        this._lastTimeupdate = 0;
        this._timer = null;
        this._inFlight = false;
        this._disposed = false;

        /* ---- 音量推送合并（淡入淡出每帧写 volume，不能每帧打一次 IPC） ---- */
        this._volTimer = null;
        this._volDirty = false;

        /* ---- 监听器 ---- */
        this._listeners = new Map();
    }

    /* ==================== 事件 ==================== */

    addEventListener(type, fn, options) {
        if (typeof fn !== 'function') return;
        let set = this._listeners.get(type);
        if (!set) {
            set = new Set();
            this._listeners.set(type, set);
        }
        /* once 语义：包一层而不是记 flag —— 分片里 canplay 探针普遍用 {once:true} */
        const once = !!(options && options.once);
        const entry = once ? (ev) => { this.removeEventListener(type, entry); fn(ev); } : fn;
        entry.__original = fn;
        set.add(entry);
    }

    removeEventListener(type, fn) {
        const set = this._listeners.get(type);
        if (!set) return;
        for (const entry of [...set]) {
            if (entry === fn || entry.__original === fn) set.delete(entry);
        }
    }

    _emit(type, detail) {
        const set = this._listeners.get(type);
        if (!set || set.size === 0) return;
        const ev = { type, target: this, currentTarget: this };
        if (detail) Object.assign(ev, detail);
        for (const entry of [...set]) {
            try {
                entry(ev);
            } catch (e) {
                logCatch(TAG, e);
            }
        }
    }

    /* ==================== 元素属性 ==================== */

    get src() {
        return this._src;
    }

    /**
     * 设 src。**这里也自动开始加载**——HTML 元素的 src 赋值就是起播加载的信号，
     * 全库有若干处（125/130/135/175）只赋值不调 load()，少这一步那些路径会静默不出声。
     * 随后显式调的 load() 会因「同一 src 已在加载」而幂等跳过。
     */
    set src(v) {
        const next = typeof v === 'string' ? v : '';
        if (next === this._src) return;
        this._src = next;
        this._currentSrc = next;
        this._resetForNewSrc();
        if (next) this.load();
    }

    /** 全库用 `audio.src` 判「有没有歌」，所以空串即无歌（与 HTML 一致） */
    get currentSrc() {
        return this._currentSrc;
    }

    get paused() {
        return !this._playing;
    }

    get duration() {
        return this._duration > 0 ? this._duration : NaN;
    }

    get readyState() {
        return this._readyState;
    }

    get error() {
        return this._error;
    }

    get volume() {
        return this._volume;
    }

    /** 与 HTML 一致：写 volume 立即生效，并**合并**成最多约 60Hz 的一次 IPC */
    set volume(v) {
        const val = clamp01(Number(v));
        if (!Number.isFinite(val)) return;
        this._volume = val;
        this._volDirty = true;
        if (this._volTimer) return;
        this._volTimer = setTimeout(() => {
            this._volTimer = null;
            if (!this._volDirty || this._disposed) return;
            this._volDirty = false;
            this._api.setVolume(this._volume).catch((e) => logCatch(TAG, e));
        }, 16);
    }

    /** 播放速率。★ 引擎自 2026-10-05 起真的支持变速（解码侧分数重采样），
        所以这里**只负责记值**，由 `rateProvider` 在 20Hz 轮询里比对下发。
        （tempoBoost 那种"临时提速"也因此自动生效——它同样是给元素赋 playbackRate。） */
    get playbackRate() {
        return this._rate;
    }

    set playbackRate(v) {
        const r = Number(v);
        if (!Number.isFinite(r) || r <= 0) return;
        this._rate = r;
    }

    get preservesPitch() {
        return this._preservesPitch;
    }

    set preservesPitch(v) {
        this._preservesPitch = !!v;
    }

    get webkitPreservesPitch() {
        return this._preservesPitch;
    }

    set webkitPreservesPitch(v) {
        this._preservesPitch = !!v;
    }

    get mozPreservesPitch() {
        return this._preservesPitch;
    }

    set mozPreservesPitch(v) {
        this._preservesPitch = !!v;
    }

    /* ==================== 时钟（见文件头 1） ==================== */

    get currentTime() {
        if (!this._hasTrack) return 0;
        if (!this._playing) return Math.max(0, this._position);
        /* 线性外推：锚点 + 墙钟差 × 速率。速率恒为 1（引擎无变速），
           但仍然乘上去——将来引擎补上变速时这里不用改。 */
        let t = this._position + ((now() - this._anchor) / 1000) * this._rate;
        if (this._duration > 0) t = Math.min(t, this._duration);
        return Math.max(0, t);
    }

    set currentTime(sec) {
        const t = Math.max(0, Number(sec) || 0);
        this._position = t;
        this._anchor = now();
        this._ended = false;
        if (!this._hasTrack) {
            /* 元数据未就绪时先记账，加载完成后自查补一次 seek（见 _onTrackLoaded） */
            this._pendingSeek = t;
            return;
        }
        this._api.seek(t).catch((e) => logCatch(TAG, e));
        this._emit('seeked');
        this._emit('timeupdate');
    }

    /* ==================== 播放控制 ==================== */

    /** 加载当前 src。同一 src 已在加载时幂等（见 set src 注释） */
    load() {
        if (this._disposed) return;
        if (!this._src) return;
        if (this._pendingLoad && this._loadedSrc === this._src) return;
        this._resetForNewSrc();
        this._pendingLoad = true;
        this._pendingLoadDeadline = now() + LOAD_TIMEOUT_MS;
        this._loadedSrc = this._src;
        /* 本次加载开始时的错误文本记为基线：引擎的 last_error 是跨曲目留存的，
           不记基线就会把上一首的失败当成这一首的错误再报一次。 */
        this._errBaselinePending = true;
        this._startPolling();
        this._api.load(this._src, false).catch((e) => this._failLoad(e));
    }

    /**
     * 起播。HTML 语义：`play()` 立刻让 paused 变 false 并同步派发 `play`，
     * 不等数据真正流出（见文件头 2）。
     * @returns {Promise<void>}
     */
    play() {
        if (this._disposed) return Promise.reject(new Error('deck disposed'));
        if (this._playing) return Promise.resolve();
        if (!this._hasTrack) {
            if (!this._pendingLoad) return Promise.reject(new Error('no track loaded'));
            /* 尚未就绪：等 canplay/error，再走一遍本函数 */
            return this._awaitReady().then(() => this.play());
        }
        this._playing = true;
        this._ended = false;
        this._anchor = now();
        this._optimisticUntil = now() + OPTIMISTIC_MS;
        this._emit('play');
        return this._api.play().catch((e) => {
            this._playing = false;
            this._emit('pause');
            throw e;
        });
    }

    pause() {
        if (this._disposed) return;
        if (!this._playing) return;
        /* 落锚：把外推出来的当前位置固化成新锚点，否则暂停后 currentTime 会跳回上一次快照 */
        this._position = this.currentTime;
        this._anchor = now();
        this._playing = false;
        this._optimisticUntil = now() + OPTIMISTIC_MS;
        this._emit('pause');
        this._api.pause().catch((e) => logCatch(TAG, e));
    }

    /**
     * 卸载 src（HTML 里 removeAttribute('src') 会让元素回到空态）。
     * ★ 这里额外给引擎发一次 pause：元素的 src 没了但引擎还在出声，
     *   就是「界面显示没在播放、喇叭在响」这类最难查的不一致。
     */
    removeAttribute(name) {
        if (name !== 'src') return;
        this._src = '';
        this._currentSrc = '';
        this._resetForNewSrc();
        this._api.pause().catch((e) => logCatch(TAG, e));
    }

    /* ==================== 引擎侧写入口 ==================== */

    /** 音效链变化时由 app/298 调用（引擎 EQ 是跨曲目偏好，与 element 图无关） */
    applyEq(enabled, gainsDb) {
        if (this._disposed) return Promise.resolve();
        return this._api.setEq(enabled, gainsDb).catch((e) => logCatch(TAG, e));
    }

    /** 输出设备/模式变化后由 app/298 调用；deck 自身不关心设备，只更新缓存字段 */
    noteOutput(mode, sampleFormat) {
        if (typeof mode === 'string') this._outputMode = mode;
        if (typeof sampleFormat === 'string') this._sampleFormat = sampleFormat;
    }

    /** 本机实测：不同输出模式/采样格式下音质是否比特完美，UI 要能如实说 */
    get outputMode() {
        return this._outputMode;
    }

    get sampleFormat() {
        return this._sampleFormat;
    }

    get sampleRate() {
        return this._sampleRate;
    }

    dispose() {
        this._disposed = true;
        this._stopPolling();
        if (this._volTimer) {
            clearTimeout(this._volTimer);
            this._volTimer = null;
        }
        this._listeners.clear();
        this._api.pause().catch(() => {});
    }

    /* ==================== 内部 ==================== */

    _resetForNewSrc() {
        const wasPlaying = this._playing;
        this._hasTrack = false;
        this._pendingLoad = false;
        this._readyState = 0;
        this._duration = 0;
        this._position = 0;
        this._anchor = now();
        this._error = null;
        this._ended = false;
        this._playing = false;
        /* 换 src 时若还在播，HTML 的加载算法同样会把 paused 置真并派发 pause。
           不补这一发的话「图标还停在暂停态」这种同步问题就会在原生模式下复发。 */
        if (wasPlaying) this._emit('pause');
    }

    _failLoad(e) {
        const msg = String((e && e.message) || e || 'native load failed');
        this._pendingLoad = false;
        this._readyState = 0;
        this._error = { code: 4, message: msg };
        logWarn(TAG, 'load failed:', msg);
        this._emit('error');
        this._stopPollingIfIdle();
    }

    _startPolling() {
        if (this._timer || this._disposed) return;
        this._timer = setInterval(() => { void this._tick(); }, this._pollMs);
        void this._tick();
    }

    _stopPolling() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** 无歌可放且无在途加载时停轮询：空闲时不该持续打 IPC。
     *  在途加载超时也要在这里收口——否则引擎既不报错也不加载时，
     *  20Hz 轮询会无声无息地一直烧下去（前端 8s 的 waitForAudioReady 只管
     *  它自己那条 Promise，管不到这里）。 */
    _stopPollingIfIdle() {
        if (this._pendingLoad && now() > this._pendingLoadDeadline) {
            this._pendingLoad = false;
            this._error = { code: 4, message: 'native load timed out' };
            logWarn(TAG, 'load timed out');
            this._emit('error');
        }
        if (!this._hasTrack && !this._pendingLoad) this._stopPolling();
    }

    async _tick() {
        if (this._inFlight || this._disposed) return;
        this._inFlight = true;
        let s = null;
        try {
            s = await this._api.snapshot();
        } catch (e) {
            logCatch(TAG, e);
        } finally {
            this._inFlight = false;
        }
        if (this._disposed || !s) return;
        this._onSnapshot(s);
    }

    _onSnapshot(s) {
        /* ---- 加载完成：hasTrack 由 false 变 true ---- */
        if (s.hasTrack && !this._hasTrack) {
            this._hasTrack = true;
            this._pendingLoad = false;
            this._readyState = READY_STATE_LOADED;
            this._duration = numberOr(s.durationSec, 0);
            this._sampleRate = numberOr(s.sampleRate, 0);
            this._position = numberOr(s.positionSec, 0);
            this._anchor = now();
            logInfo(TAG, `track loaded (${this._sampleRate} Hz)`);
            this._emit('loadedmetadata');
            this._emit('durationchange');
            this._emit('loadeddata');
            this._emit('canplay');
            if (this._pendingSeek != null) {
                const t = this._pendingSeek;
                this._pendingSeek = null;
                this.currentTime = t;
            }
        } else if (!s.hasTrack && this._hasTrack) {
            /* 引擎侧换曲/清空：回到空态但保持 _pendingLoad 由下一次 load() 决定 */
            this._hasTrack = false;
            this._readyState = 0;
            this._duration = 0;
            this._position = 0;
        }

        /* ---- 错误：只在文本**变化**时派发（引擎的 last_error 是跨曲目留存的） ---- */
        const errText = typeof s.lastError === 'string' && s.lastError ? s.lastError : null;
        if (this._errBaselinePending) {
            this._errBaselinePending = false;
            this._lastErrText = errText;
        } else if (errText && errText !== this._lastErrText) {
            this._lastErrText = errText;
            this._error = { code: 4, message: errText };
            this._pendingLoad = false;
            logWarn(TAG, 'engine error:', errText);
            this._emit('error');
        } else if (!errText) {
            this._lastErrText = null;
        }

        if (typeof s.outputMode === 'string') this._outputMode = s.outputMode;
        if (typeof s.sampleFormat === 'string') this._sampleFormat = s.sampleFormat;

        /* ---- 时钟重锚定 ---- */
        const pos = numberOr(s.positionSec, this._position);
        const playing = !!s.playing;
        const wall = now();
        /* 位置跳变（seek/切曲）时不要重锚成旧值：差得太远说明是引擎刚切的，
           直接采纳新值即可，外推窗口本来就是 50ms 级。 */
        this._position = pos;
        this._anchor = wall;
        if (s.sampleRate) this._sampleRate = s.sampleRate;

        /* ---- duration 变化 ---- */
        const dur = numberOr(s.durationSec, 0);
        if (dur > 0 && Math.abs(dur - this._duration) > 0.05) {
            this._duration = dur;
            if (this._hasTrack) this._emit('durationchange');
        }

        /* ---- play/pause 状态回灌（乐观窗口内不推翻，见文件头 2） ---- */
        if (playing !== this._playing && wall >= this._optimisticUntil) {
            this._playing = playing;
            this._emit(playing ? 'play' : 'pause');
        }

        /* ---- ended：只在真正的「播完」上派发一次 ---- */
        if (s.ended && !this._ended && this._hasTrack) {
            this._ended = true;
            this._position = this._duration > 0 ? this._duration : this._position;
            this._anchor = wall;
            if (this._playing) {
                this._playing = false;
            }
            logInfo(TAG, 'track ended');
            this._emit('ended');
        }

        /* ---- 合成 timeupdate（≈4Hz，见常量注释） ---- */
        if (playing && wall - this._lastTimeupdate >= TIMEUPDATE_MS) {
            this._lastTimeupdate = wall;
            this._emit('timeupdate');
        }

        this._syncEq();
        this._syncSpatial();
        this._syncRate();
        this._stopPollingIfIdle();
    }

    /** EQ 变化检测 + 下发（见 createNativeDeck 的 eqProvider 注释） */
    _syncEq() {
        if (!this._eqProvider || this._disposed) return;
        let cur;
        try {
            cur = this._eqProvider();
        } catch (e) {
            logCatch(TAG, e);
            return;
        }
        if (!cur || !Array.isArray(cur.gainsDb)) return;
        const key = (cur.enabled ? '1' : '0') + '|' + cur.gainsDb.join(',');
        if (key === this._eqKey) return;
        this._eqKey = key;
        this._api.setEq(!!cur.enabled, cur.gainsDb).catch((e) => logCatch(TAG, e));
    }

    /** 空间处理（空间音频 + 虚拟声场）变化检测 + 下发。与 _syncEq 同构：
        provider 返回的字段拼成快照串，变了才走一次 IPC。 */
    _syncSpatial() {
        if (!this._spatialProvider || this._disposed) return;
        let cur;
        try {
            cur = this._spatialProvider();
        } catch (e) {
            logCatch(TAG, e);
            return;
        }
        if (!cur) return;
        const key = [
            cur.spatialEnabled ? '1' : '0',
            cur.spatialLevel || '',
            cur.ir || '',
            cur.stageEnabled ? '1' : '0',
            cur.stageLevel || '',
        ].join('|');
        if (key === this._spatialKey) return;
        this._spatialKey = key;
        this._api.setSpatial(cur).catch((e) => logCatch(TAG, e));
    }

    /** 播放速率变化检测 + 下发。与 _syncEq/_syncSpatial 同构。
        ★ 独占路径的音频由 Rust 自己解码，`<audio>.playbackRate` 到不了那里，
          必须走这条 IPC；共享路径则两边都生效（Web 侧元素 + Rust 侧重采样互不冲突，
          因为共享路径下 Rust 引擎根本没在出声）。 */
    _syncRate() {
        if (!this._rateProvider || this._disposed) return;
        let cur;
        try {
            cur = this._rateProvider();
        } catch (e) {
            logCatch(TAG, e);
            return;
        }
        const r = Number(cur);
        if (!Number.isFinite(r) || r <= 0) return;
        /* 用固定小数位做键：浮点直接字符串化会把 1.0000000001 与 1 判成不同 */
        const key = r.toFixed(4);
        if (key === this._rateKey) return;
        this._rateKey = key;
        this._api.setRate(r).catch((e) => logCatch(TAG, e));
    }

    /** 等 canplay / error / 超时。仅供内部 play() 在未就绪时使用 */
    _awaitReady(timeoutMs) {
        const budget = timeoutMs || 8000;
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const done = (fn) => {
                if (settled) return;
                settled = true;
                this.removeEventListener('canplay', onReady);
                this.removeEventListener('error', onErr);
                if (timer) clearTimeout(timer);
                fn();
            };
            const onReady = () => done(resolve);
            const onErr = () => done(() => {
                const msg = (this._error && this._error.message) || 'native load error';
                reject(new Error(msg));
            });
            this.addEventListener('canplay', onReady);
            this.addEventListener('error', onErr);
            timer = setTimeout(() => done(() => reject(new Error('native load timeout'))), budget);
        });
    }
}

function clamp01(v) {
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(1, v));
}

function numberOr(v, fallback) {
    return Number.isFinite(v) ? v : fallback;
}
