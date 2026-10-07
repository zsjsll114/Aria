/* ============================================================
 * core/automix/crossfader.js — 等功率交叉执行器（Automix Phase 2）
 *
 * 状态机（方案 §3.3）：
 *   IDLE → armCrossfade() → ARMED →（B canplay 就绪 + A 剩余 ≤ overlap，
 *         由 scheduler.onTimeUpdate 触发）→ startCrossing() → CROSSING
 *        →（进度越过交接点）→ onSwapPoint →（app 层提前做角色顶替）
 *        →（曲线走完）→ onSwapped →（收尾）→ IDLE
 *   任何状态可 abort(reason) → B 静音暂停、A 恢复交叉前增益 → IDLE
 *
 * 双通道设计：
 *   · GainNode 路径（EQ 图就绪）：ensureDeckSource 给主/shadow 各建一条
 *     「source → gain → mixBus」，等功率曲线用 setValueCurveAtTime 一次性铺上
 *     —— AudioContext 时钟，后台标签页也精确，rAF 节流问题天然不存在。
 *   · volume 路径（CORS 回退 / EQ 初始化失败）：双元素 volume + rAF 逐帧 +
 *     setTimeout 兜底（与 fadeController 同模式；后台节流期曲线会阶梯化，
 *     但兜底保证终态正确）。
 *
 * ★ 交接点（onSwapPoint，2026-10-03）：进度过半即通知 app 层做「角色顶替」——
 *   播放栏标题/封面/进度条整体切到 B，而音频交叉曲线继续走完。这是 Apple Music
 *   的行为（视觉上已经换歌，耳朵里还在交叉）。cutoff 之前 UI 完全不动，是因为
 *   等功率曲线在 p=0.5 处恰好 gainA=gainB（能量分界），此处切换观感最平顺。
 *   调用方负责：把 swapRoles 提前到这一刻；曲线走完的 onSwapped 只做收尾。
 *
 * ABORT 语义（agents.md #26 代际守卫的 automix 落地，本模块唯一允许的复杂度）：
 *   · generation 计数：所有异步回调（曲线完成兜底 / rAF step / canplay 探针 /
 *     B.play promise）执行前比对 _gen，迟到者直接丢弃；
 *   · abort 恢复 A 的**交叉前**增益/音量（进入 CROSSING 时记录）；
 *   · 干预探针：CROSSING 期给 A 直挂 pause/seeking（直挂非搬运表——探针语义），
 *     用户干预即 abort；完成流程先摘探针再通知 swap，避免自己的 pause 触发 abort。
 *   · ★ 交接点之后 abort **退化为立即完成**：此时 app 层已把「当前曲」切到 B，
 *     回滚 A 会造成「UI 显示 B、声音回到 A」的更严重不一致。
 *
 * 层级纪律：core 层不 import app/*。对 app 的通知走回调。
 * ============================================================ */
import { logInfo, logWarn, logCatch } from '../../services/log.js';
import { ensureDeckSource, getEqAudioContext } from '../equalizer.js';

export const CROSSFADER_IDLE = 'IDLE';
export const CROSSFADER_ARMED = 'ARMED';
export const CROSSFADER_CROSSING = 'CROSSING';

/** 交接点默认值：进度过半即视为「已切歌」（见文件头 ★ 交接点）。 */
export const CROSSFADE_SWAP_AT = 0.5;

/**
 * 等功率交叉增益：gainA=cos(θ)、gainB=sin(θ)，θ=p·π/2。
 * p=0 → (1,0) 全 A；p=1 → (0,1) 全 B。纯函数（测试与双路径共用）。
 * @param {number} p 进度 0~1（越界自动钳制）
 * @returns {{gainA:number, gainB:number}}
 */
export function equalPowerGains(p) {
    /* 端点精确归一：cos(π/2) 有 6e-17 残差，曲线终点必须严格 0/1 */
    if (p >= 1) return { gainA: 0, gainB: 1 };
    if (p <= 0) return { gainA: 1, gainB: 0 };
    const th = p * Math.PI / 2;
    return { gainA: Math.cos(th), gainB: Math.sin(th) };
}

/* ---------------- 模块状态 ---------------- */
let _deps = null;
let _phase = CROSSFADER_IDLE;
let _gen = 0;             /* 代际：abort/complete 各 ++，迟到回调一律丢弃 */
let _plan = null;         /* { overlapMs, rate, introOffsetMs, swapAt } */
let _decks = null;        /* { a, b } */
let _chans = null;        /* { gainA, gainB } | null —— null = volume 路径 */
let _aResumeGain = 1;     /* A 交叉前增益（GainNode 路径 abort 恢复） */
let _aResumeVol = 1;      /* A 交叉前元素音量（volume 路径 abort 恢复） */
let _bCanplayProbe = null;/* [b, type, fn] ARM 期一次性探针 */
let _probeBindings = [];  /* [{ host, type, fn }] —— 干预探针绑定表（teardown 逐个摘） */
let _loopRaf = null;      /* CROSSING 期唯一的 rAF 句柄（进度 + 曲线写入） */
let _finishTimer = null;
let _progress = 0;        /* CROSSING 期进度 0~1（UI 过渡动画读它） */
let _swapPointFired = false; /* 本轮的交接点是否已触发（防重复 + abort 语义分叉） */
let _lastSwapTs = 0;      /* 最近一次 automix swap 完成时刻（ended 竞态守卫用） */
const CURVE_STEPS = 24;   /* setValueCurveAtTime 的采样点数 */

/**
 * 注入依赖（全部可替换，node 单测注入 stub）。
 * @param {{
 *   getDecks: () => {a: HTMLAudioElement, b: HTMLAudioElement}|null,
 *   setElementVolume: (el: HTMLAudioElement, v: number) => void,
 *   onSwapPoint?: (info: {plan: object, progress: number}) => void,  // 进度过半：app 提前交接
 *   onProgress?: (p: number, info: {plan: object}) => void,          // 逐帧进度（UI 过渡动画）
 *   onSwapped: (info: {plan: object}) => void,                       // 曲线走完：收尾
 *   onAborted: (reason: string) => void,
 *   now?: () => number,
 *   schedule?: (fn: Function, ms: number) => any,
 *   cancelScheduled?: (h: any) => void,
 *   raf?: (fn: Function) => any,
 *   caf?: (h: any) => void,
 * }} deps
 */
export function initCrossfader(deps) {
    _deps = Object.assign({
        now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancelScheduled: (h) => clearTimeout(h),
        raf: (fn) => (typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(fn)
            : setTimeout(() => fn(Date.now()), 16)),
        caf: (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h)),
        setElementVolume: (el, v) => { try { el.volume = Math.max(0, Math.min(1, v)); } catch (e) { logCatch('crossfader', e); } },
        onSwapPoint: () => {},
        onProgress: () => {},
        onSwapped: () => {},
        onAborted: () => {},
    }, deps || {});
}

/** 当前状态机阶段（外部守卫用：70-audio-engine 的 ended 处理据此让路）。 */
export function crossfaderPhase() {
    return _phase;
}

/**
 * 当前交叉进度 0~1；非 CROSSING 期返回 null。
 * UI 层（封面/背景过渡、next-up 过渡态）读它画动画——不需要自己推时钟。
 */
export function crossfadeProgress() {
    return _phase === CROSSFADER_CROSSING ? _progress : null;
}

/** 当前代际（测试用）。 */
export function crossfaderGeneration() {
    return _gen;
}

/**
 * automix swap 是否刚完成（winMs 窗口内）。
 * A 曲尾的 ended 事件与交叉曲线的完成存在毫秒级竞态：swap 先完成、phase 已归
 * IDLE、晚到的 ended 会触发 autoPlayNext 把刚交接的下一首**整个重载一遍**
 * （交叉白做、B 从头播，实测踩坑）。播放链的 ended 处理据此守卫。
 * @param {number} [winMs]
 * @returns {boolean}
 */
export function automixSwapJustCompleted(winMs = 2000) {
    return _lastSwapTs > 0 && (Date.now() - _lastSwapTs) < winMs;
}

/**
 * ARM：登记交叉计划。此时应已由 scheduler 完成 B 预载；B canplay 后由
 * scheduler（或本模块的 waitForShadowCanplay）推进到 CROSSING。
 * ★ ARM 起就在 A 上挂干预探针（pause/seeking/emptied）：ARMED 期 A 的 src
 *   被外部更换（boot 开篇歌单预载复用主元素实测踩坑）或用户暂停/拖动，
 *   本轮交叉计划已失效，必须 abort，否则 ARM 永久悬挂。
 * @param {{overlapMs:number, rate?:number, introOffsetMs?:number, swapAt?:number}} plan
 * @returns {boolean} false = 当前不处于 IDLE（上一轮未结束），调用方放弃本轮
 */
export function armCrossfade(plan) {
    if (_phase !== CROSSFADER_IDLE || !_deps) return false;
    if (!plan || !(plan.overlapMs > 0)) return false;
    _plan = {
        overlapMs: plan.overlapMs,
        rate: plan.rate > 0 ? plan.rate : 1,
        introOffsetMs: plan.introOffsetMs || 0,
        swapAt: (plan.swapAt > 0 && plan.swapAt < 1) ? plan.swapAt : CROSSFADE_SWAP_AT,
    };
    _progress = 0;
    _swapPointFired = false;
    _phase = CROSSFADER_ARMED;
    _armInterveneProbes();
    return true;
}

/** 绑一个干预探针并按绑定表登记（teardown 时逐个摘）。 */
function _bindProbe(host, type, fn) {
    try {
        host.addEventListener(type, fn);
        _probeBindings.push({ host, type, fn });
    } catch (e) { logCatch('crossfader', e); }
}

/** A 的干预探针：ARMED/CROSSING 全程有效。emptied = src 被外部更换。 */
function _armInterveneProbes() {
    const decks = _deps.getDecks && _deps.getDecks();
    if (!decks || !decks.a) return;
    const host = decks.a;
    const onIntervene = (ev) => {
        if (_phase === CROSSFADER_IDLE) return;
        /* A 自然播到头：Chromium 会在 ended 前派发 pause（ended 已置位），
           这不是用户干预——交叉曲线继续走完，swap 由 _complete 正常执行 */
        try { if (ev && ev.type === 'pause' && host.ended) return; } catch (e) { logCatch('crossfader', e); }
        abortCrossfade(`user-intervene:${ev && ev.type}`);
    };
    for (const type of ['pause', 'seeking', 'emptied']) _bindProbe(host, type, onIntervene);
}

/**
 * B 的干预探针：**只在交接点之后生效**。
 * 交接点前「当前元素」是 A——UI 的暂停/拖动都作用在 A 上，B 的 pause 只可能来自
 * 内核侧行为（src 赋值、load、introOffset 定位），据此 abort 会误伤本轮交叉；
 * 交接点后 B 才是当前元素，此时它被暂停就说明用户干预。
 * 只挂 pause：CROSSING 期 B 的 seeking 大多来自建流时的定位，噪声大于信号。
 */
function _armBInterveneProbe() {
    const decks = _decks || (_deps && _deps.getDecks && _deps.getDecks());
    if (!decks || !decks.b) return;
    _bindProbe(decks.b, 'pause', () => {
        if (_phase === CROSSFADER_IDLE) return;
        if (!_swapPointFired) return;
        abortCrossfade('user-intervene:pause-b');
    });
}

/**
 * ARM 期一次性探针：B 缓冲可播后推进 CROSSING。
 * ★ 生产链路不用它——「canplay 即开」会让交叉落在 A 的正常播放段并提前结束
 *   （ARM 在剩 15s，B 缓存命中后 1s 内 canplay）。生产的交叉开始由
 *   scheduler.onTimeUpdate 在「B 就绪 + A 剩余 ≤ overlap」窗口触发；
 *   本函数只为测试与显式时序控制保留。
 */
export function waitForShadowCanplay() {
    if (_phase !== CROSSFADER_ARMED || !_deps) return false;
    const decks = _deps.getDecks && _deps.getDecks();
    if (!decks || !decks.b) return false;
    const gen = _gen;
    const fn = () => {
        if (gen !== _gen) return;
        _clearCanplayProbe();
        startCrossing();
    };
    _bCanplayProbe = [decks.b, 'canplay', fn];
    decks.b.addEventListener('canplay', fn, { once: true });
    return true;
}

function _clearCanplayProbe() {
    if (_bCanplayProbe) {
        const [el, type, fn] = _bCanplayProbe;
        try { el.removeEventListener(type, fn); } catch (e) { logCatch('crossfader', e); }
        _bCanplayProbe = null;
    }
}

/**
 * 进入 CROSSING：B 从 introOffsetMs 起播，双通道铺等功率曲线。
 * @returns {boolean} false = 状态机不在 ARMED 或 deck 缺失
 */
export function startCrossing() {
    if (_phase !== CROSSFADER_ARMED || !_deps) return false;
    const decks = _deps.getDecks && _deps.getDecks();
    if (!decks || !decks.a || !decks.b) { abortCrossfade('no-decks'); return false; }
    const gen = ++_gen;
    _decks = decks;
    const { a, b } = decks;

    /* 对拍速率：preservesPitch=true（Chromium 原生保音高变速），重叠时长按速率缩放 */
    if (_plan.rate !== 1) {
        try {
            b.preservesPitch = true;
            b.playbackRate = _plan.rate;
        } catch (e) { logCatch('crossfader', e); }
    }

    /* 通道解析：GainNode 路径 / volume 路径 */
    const recA = ensureDeckSource(a);
    const recB = ensureDeckSource(b);
    _chans = (recA && recB) ? { gainA: recA.gain, gainB: recB.gain } : null;
    if (_chans) {
        _aResumeGain = 1; /* deckGain 常态透明；防御性记录当前值 */
        try { _aResumeGain = _chans.gainA.gain.value; } catch (e) { logCatch('crossfader', e); }
        /* ★ 2026-10-05 修「自动混音时音量突然变大」。
           GainNode 路径的终态收口只把 gainB 设回 1（见 _settleEndState），
           这隐含假设**两个元素的 volume 都已经等于用户音量**。但影子 deck
           （#audioShadow，由 dualDeck 创建）的 volume **从来没有人写过**，
           一直是 HTML 默认的 1.0；只有主 deck 由 70-audio-engine.js 的
           `audio.volume = volumePercentToGain(volume)` 维护。
           于是交叉结束、角色顶替之后，新主 deck 的实际输出是
           1.0（元素）× 1.0（gain）= **100%**，而用户设的是 e.g. 50%
           —— 表现为"每交叉一次跳一次、音量突然变大"。
           为什么是"有时候"：只有走 GainNode 路径才这样；volume 降级路径在
           _makeVolumeWriteFn 里乘了用户增益，终点写的是 `_userGain()`，所以正常。
           这里把 B 的元素音量对齐到用户音量，使那条隐含假设成立。
           （用 _userGain() 而不是 a.volume：文件里 volume 路径的终态就是
            `_userGain()`，两条件路径的收口值必须一致；且 a 可能正被淡入淡出
            /睡眠斜坡瞬时改动，照抄会把那个瞬时值固化成 B 的基线。） */
        try { _deps.setElementVolume(b, _userGain()); } catch (e) { logCatch('crossfader', e); }
    } else {
        _aResumeVol = a.volume;
        logWarn('crossfader', 'EQ 图不可用，交叉降级为元素 volume 路径');
    }

    /* 干预探针 A 侧已在 armCrossfade（ARMED）时挂上，这里不重复挂 */

    /* B 起播。play 的 promise 若**同步** reject（stub / 内核异常路径），
       catch 会中途触发 abortCrossfade 清掉 _plan——此刻必须立刻让位，
       后续的 phase 推进 / 曲线铺设全部跳过（代际已失效）。 */
    try { b.currentTime = _plan.introOffsetMs / 1000; } catch (e) { logCatch('crossfader', e); }
    const playResult = typeof b.play === 'function' ? b.play() : null;
    if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
            if (gen === _gen) abortCrossfade('b-play-failed');
        });
    }
    if (gen !== _gen) return false;

    _phase = CROSSFADER_CROSSING;
    const T = _plan.overlapMs / _plan.rate;   /* 真实时长（速率缩放） */
    /* B 的干预探针此刻才挂：ARM 期 B 只是预载（src 刚赋、未播），提前挂会吃到
       load()/currentTime 赋值引发的 pause/emptied 而误 abort 本轮交叉。 */
    _armBInterveneProbe();
    const writeFn = _chans ? _startGainCurve(gen, T) : _makeVolumeWriteFn();
    _startCrossingLoop(gen, T, writeFn);
    /* 完成兜底：曲线/rAF 都靠不住时的最后闸（AudioContext 时钟与 JS 时钟漂移容差） */
    _finishTimer = _deps.schedule(() => { if (gen === _gen) _complete(gen); }, T + 250);
    logInfo('crossfader', `交叉开始（${_chans ? 'GainNode' : 'volume'} 路径，T=${Math.round(T)}ms，rate=${_plan.rate}）`);
    return true;
}

/**
 * CROSSING 期**唯一**的时间驱动：一帧内完成「写交叉曲线 → 上报进度 → 越点交接」。
 * 三条路径共用。GainNode 正常路径的音量由 setValueCurveAtTime 自行推进（writeFn=null），
 * 这里只上报进度与交接点；volume 路径与 setValueCurveAtTime 降级的写回由 writeFn 承担。
 * ★ 进度必须在 rAF 里算，不能靠 AudioContext 时钟反推——UI 过渡动画要与音频曲线同源。
 */
function _startCrossingLoop(gen, T, writeFn) {
    const t0 = _deps.now();
    const swapAt = _plan.swapAt || CROSSFADE_SWAP_AT;
    const step = () => {
        if (gen !== _gen || _phase !== CROSSFADER_CROSSING) return;
        const p = Math.min(1, Math.max(0, (_deps.now() - t0) / T));
        _progress = p;
        if (writeFn) { try { writeFn(p); } catch (e) { logCatch('crossfader', e); } }
        try { _deps.onProgress(p, { plan: _plan }); } catch (e) { logCatch('crossfader', e); }
        if (!_swapPointFired && p >= swapAt) {
            _swapPointFired = true;
            logInfo('crossfader', `交叉进度 ${p.toFixed(2)} ≥ 交接点 ${swapAt}，通知提前交接`);
            try { _deps.onSwapPoint({ plan: _plan, progress: p }); } catch (e) { logCatch('crossfader', e); }
        }
        if (p >= 1) { _complete(gen); return; }
        _loopRaf = _deps.raf(step);
    };
    _loopRaf = _deps.raf(step);
}

/** GainNode 路径：setValueCurveAtTime 一次铺完整条等功率曲线。
 *  @returns {null|Function} 正常返回 null（由 AudioContext 时钟推进）；
 *    老内核对 setValueCurveAtTime 抛错时返回逐帧写 gain.value 的降级 writeFn。 */
function _startGainCurve(gen, T) {
    const ctxTime = _ctxNow();
    const curveA = new Float32Array(CURVE_STEPS);
    const curveB = new Float32Array(CURVE_STEPS);
    for (let i = 0; i < CURVE_STEPS; i++) {
        const g = equalPowerGains(i / (CURVE_STEPS - 1));
        curveA[i] = g.gainA;
        curveB[i] = g.gainB;
    }
    try {
        for (const [gain, curve] of [[_chans.gainA, curveA], [_chans.gainB, curveB]]) {
            gain.gain.cancelScheduledValues(ctxTime);
            gain.gain.setValueAtTime(curve[0], ctxTime);
            gain.gain.setValueCurveAtTime(curve, ctxTime, T / 1000);
        }
        return null;
    } catch (e) {
        /* setValueCurveAtTime 不可用（老内核）：退化为逐帧写 gain.value */
        logCatch('crossfader', e);
        return (p) => {
            const g = equalPowerGains(p);
            try { _chans.gainA.gain.value = g.gainA; } catch (e2) { logCatch('crossfader', e2); }
            try { _chans.gainB.gain.value = g.gainB; } catch (e2) { logCatch('crossfader', e2); }
        };
    }
}

function _ctxNow() {
    try {
        const ctx = getEqAudioContext();
        return ctx ? ctx.currentTime : 0;
    } catch { return 0; }
}

/* 用户音量换算（与 core/sleepTimer 同一探测式读法：分片求值顺序不保证）。
   ★ volume 路径的交叉曲线必须乘用户增益——元素 volume 是「用户音量 × 交叉曲线」
   的乘积通道，终点若写到 1 会把用户 80% 音量的歌推到全音量。 */
function _userGain() {
    try {
        const vp = (typeof globalThis !== 'undefined' && typeof globalThis.volume === 'number')
            ? globalThis.volume : 80;
        const g = (typeof globalThis !== 'undefined' && typeof globalThis.volumePercentToGain === 'function')
            ? globalThis.volumePercentToGain(vp) : Math.max(0, Math.min(1, vp / 100));
        return Math.max(0, Math.min(1, g));
    } catch { return 0.8; }
}

/** volume 路径的逐帧写回（由 _startCrossingLoop 驱动）。 */
function _makeVolumeWriteFn() {
    const ug = _userGain();
    return (p) => {
        const g = equalPowerGains(p);
        _deps.setElementVolume(_decks.a, ug * g.gainA);
        _deps.setElementVolume(_decks.b, ug * g.gainB);
    };
}

/** 终态收口：曲线的最后一点必须精确落位（A=0 / B=用户音量），否则 swap 后
 *  新主 deck 音量卡在半路或被推到全音量、旧 deck 残留声。GainNode 路径由
 *  setValueCurveAtTime 自行到点（gain 终点 0/1，元素 volume 不动），退化
 *  rAF 写 gain.value 的路径与 volume 路径在此补齐。 */
function _settleEndState() {
    if (!_decks) return;
    if (_chans) {
        try { _chans.gainA.gain.value = 0; } catch (e) { logCatch('crossfader', e); }
        try { _chans.gainB.gain.value = 1; } catch (e) { logCatch('crossfader', e); }
    } else if (_deps) {
        _deps.setElementVolume(_decks.a, 0);
        _deps.setElementVolume(_decks.b, _userGain());
    }
}

/** 完成交接：终态收口 → 摘探针 → 通知 app 层收尾（角色顶替已由交接点做过）。 */
function _complete(gen) {
    if (gen !== _gen || _phase !== CROSSFADER_CROSSING) return;
    _gen++;
    _settleEndState();
    _teardownProbes();
    if (_finishTimer) { _deps.cancelScheduled(_finishTimer); _finishTimer = null; }
    if (_loopRaf) { _deps.caf(_loopRaf); _loopRaf = null; }
    _phase = CROSSFADER_IDLE;
    const plan = _plan;
    const swappedEarly = _swapPointFired;
    _plan = null;
    _decks = null;
    _chans = null;
    _progress = 0;
    _swapPointFired = false;
    _lastSwapTs = Date.now();
    logInfo('crossfader', `交叉完成（交接点${swappedEarly ? '已过' : '未到，由收尾补做'}），通知收尾`);
    try { _deps.onSwapped({ plan, swappedEarly }); } catch (e) { logCatch('crossfader', e); }
}

/**
 * 中止交叉（用户干预 / B 起播失败 / scheduler 撤销 ARM）：
 * B 静音 + 暂停，A 恢复交叉前增益。代际 ++ 使所有在途回调失效。
 * ★ 交接点已过时退化为「立即完成」：app 层已把当前曲切到 B，回滚 A 会造成
 *   「UI 显示 B、声音回到 A」的更严重不一致。
 * @param {string} reason
 * @returns {boolean} 是否真的从 ARMED/CROSSING 中止
 */
export function abortCrossfade(reason) {
    if (_phase === CROSSFADER_IDLE) return false;
    if (_swapPointFired && _phase === CROSSFADER_CROSSING) {
        logInfo('crossfader', `交接点已过，abort（${reason || 'unknown'}）退化为立即完成`);
        _complete(_gen);
        return true;
    }
    const wasPhase = _phase;
    _gen++;
    _teardownProbes();
    if (_finishTimer && _deps) { _deps.cancelScheduled(_finishTimer); _finishTimer = null; }
    if (_loopRaf && _deps) { _deps.caf(_loopRaf); _loopRaf = null; }
    /* B 静音 + 停。CROSSING 期 _decks 已登记；ARM 期（预载了但没起播）从
       getDecks 现取——预载的 src 也要清掉，释放网络/解码资源。 */
    const decks = _decks || (_deps && _deps.getDecks && _deps.getDecks());
    if (decks && decks.b) {
        try { decks.b.pause(); } catch (e) { logCatch('crossfader', e); }
        try { decks.b.currentTime = 0; } catch (e) { logCatch('crossfader', e); }
        if (wasPhase === CROSSFADER_ARMED) {
            try { decks.b.removeAttribute('src'); decks.b.load(); } catch (e) { logCatch('crossfader', e); }
        }
    }
    /* A 恢复交叉前状态（仅 CROSSING 期动过 A 的音量；ARM 期 A 从未被碰，勿恢复） */
    if (wasPhase === CROSSFADER_CROSSING && _decks && _decks.a) {
        if (_chans && _chans.gainA) {
            try {
                const t = _ctxNow();
                _chans.gainA.gain.cancelScheduledValues(t);
                _chans.gainA.gain.setValueAtTime(_aResumeGain, t);
            } catch (e) { logCatch('crossfader', e); }
        } else if (_deps) {
            _deps.setElementVolume(_decks.a, _aResumeVol);
        }
    }
    _phase = CROSSFADER_IDLE;
    _plan = null;
    _decks = null;
    _chans = null;
    _progress = 0;
    _swapPointFired = false;
    logWarn('crossfader', `交叉中止（${wasPhase}）：${reason || 'unknown'}`);
    try { _deps && _deps.onAborted(reason || 'unknown'); } catch (e) { logCatch('crossfader', e); }
    return true;
}

function _teardownProbes() {
    _clearCanplayProbe();
    for (const { host, type, fn } of _probeBindings) {
        try { host.removeEventListener(type, fn); } catch (e) { logCatch('crossfader', e); }
    }
    _probeBindings = [];
}

/** 测试钩子：清空全部状态（生产代码勿调） */
export function _resetCrossfaderForTest() {
    _deps = null;
    _phase = CROSSFADER_IDLE;
    _gen = 0;
    _plan = null;
    _decks = null;
    _chans = null;
    _bCanplayProbe = null;
    _probeBindings = [];
    _loopRaf = null;
    _finishTimer = null;
    _progress = 0;
    _swapPointFired = false;
    _lastSwapTs = 0;
}
