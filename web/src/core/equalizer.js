/* ============================================================
 * core/equalizer.js — 10 段均衡器的音频图 / 增益状态 / 持久化
 * （core 层接管第 4 个模块，2026-09-25）
 *
 * 来历：本文件原先是「没接线的目标架构快照」，缺活实现的两块关键能力：
 *   · 用户自定义预设（localStorage aria_eq_custom + 分享码导入的预设都走 getCustomEqs），
 *     快照的 applyEqPreset 只查内置 EQ_PRESETS —— 接上就是「自定义预设全部失效」；
 *   · 输出链上的 DynamicsCompressor 响度归一化与 Analyser 挂载（快照没有）。
 * 所以接管动作是从 app/90-eq.js 的活实现**重新抽取**，逻辑逐行照搬。
 *
 * 边界：本模块只管「音频图 + 增益状态 + 持久化」，DOM 部分（频段滑块、预设按钮、
 * 拖拽时的数值文本）留在 app/90-eq.js —— 特别注意 onEqBandChange 只刷新高亮、
 * 不重建滑块，否则拖动过程中会被自己重渲染打断。该行为通过 onBandChanged 回调保留。
 *
 * 状态：eqGains / eqActivePreset / eqInited / eqInitFailed / audioCtx / eqSourceNode /
 * eqFilterNodes 存在 infrastructure/state.js，仍与 globalThis 同名键双向打通
 * （180-boot-config、258-rankings 的分享码导入导出按裸标识符读写）。
 * ============================================================ */
import { state } from '../infrastructure/state.js';
import { EQ_BANDS, EQ_PRESETS, EQ_STORAGE_KEY } from '../config/constants.js';
import {
    stageTuningFor, STAGE_DEFAULT,
    spatialTuningFor, SPATIAL_DEFAULT, IR_DEFAULT, IR_ORDER, IR_SAMPLE_RATE, irFor, resampleLinear,
} from './spatialTuning.js';
import { logWarn, logError, logCatch, logInfo } from '../services/log.js';

const CUSTOM_EQ_KEY = 'aria_eq_custom';

/* ★ 空间处理（P1 虚拟声场 2026-10-05；P2 空间音频 + 对齐 Rust，2026-10-05 稍后）。
   档位 → 参数的唯一源在 core/spatialTuning.js（自动生成，两侧同源）。
   开关语义：off = 图里旁通（增益归位），
   ★ 绝不 disconnect/reconnect —— 那会有咔哒声 + 断音（方案 §2.1 关键约束）。 */
const STAGE_SMOOTH = 0.05;   /* setTargetAtTime 时间常数，防 zipper noise */

/* ★ Automix Phase 2：deck 元素 → { source, gain } 登记表。
   MediaElementSource 每元素只能建一次，必须幂等缓存（swap 后旧元素作为
   shadow 复用时直接命中，绝不重复 create）。 */
const _deckSources = new Map();

/* ★ 当前是否处于「直连旁通」：元素已被捕获但音效图不可用（被 cleanup 拆掉 / 建图失败）
   时，必须保证它有一条通往 destination 的活路径，否则永久静音。见 _ensurePassthrough。 */
let _passthrough = false;

/**
 * 取（或建立）某 deck 元素的 MediaElementSource + 增益通道（Automix Phase 2）。
 * 幂等；交叉执行器在 CROSSING 开始时对主/shadow 各取一次，随后对两个 gain
 * 铺等功率曲线。EQ 未初始化（含 CORS 回退路径）返回 null——调用方应降级为
 * 元素 volume 交叉。
 * @param {HTMLAudioElement} el
 * @returns {{source: MediaElementAudioSourceNode, gain: GainNode}|null}
 */
export function ensureDeckSource(el) {
    if (!el) return null;
    const hit = _deckSources.get(el);
    if (hit) return hit;
    if (!state.eqInited || !state.audioCtx || !state.eqMixBus) return null;
    try {
        const source = state.audioCtx.createMediaElementSource(el);
        const gain = state.audioCtx.createGain();
        source.connect(gain);
        gain.connect(state.eqMixBus);
        const rec = { source, gain };
        _deckSources.set(el, rec);
        return rec;
    } catch (e) {
        logCatch('eq', e);
        return null;
    }
}

let _audio = null;
let _onPlayError = null;   /* CORS 回退后恢复播放失败时回调（活实现是 handleAudioPlayError） */
let _onChanged = null;     /* 预设高亮需要刷新（不重建滑块） */
let _onBandChanged = null; /* 单个频段数值文本刷新 */
let _onPresetApplied = null; /* 换预设后需要整面板重建（频段 + 高亮） */

/**
 * 注入依赖。三个刷新回调对应活实现里三种不同的重渲染范围，别合并：
 * 拖滑块时若重建滑块，拖拽会被自己的重渲染打断。
 * @param {{audio: HTMLAudioElement, onPlayError?: Function, onChanged?: Function,
 *          onBandChanged?: (idx:number)=>void, onPresetApplied?: Function}} deps
 */
export function initEqualizer(deps) {
    _audio = deps.audio || null;
    _onPlayError = deps.onPlayError || null;
    _onChanged = deps.onChanged || null;
    _onBandChanged = deps.onBandChanged || null;
    _onPresetApplied = deps.onPresetApplied || null;
}

/** 当前 AudioContext（Automix 交叉铺曲线用；未初始化返回 null）。 */
export function getEqAudioContext() {
    return state.eqInited && state.audioCtx ? state.audioCtx : null;
}

/* ★ 音频链健康自愈（2026-10-05）：AudioContext 中途被系统挂起后**没有任何代码把它
   恢复**——设备切换 / 拔插耳机 / 蓝牙断连 / 系统休眠唤醒 / audiosrv 重启都会触发，
   而 `createMediaElementSource` 早已让 `<audio>` 改道进这个图 ⇒ 一停就是
   「UI 在播、进度在走、完全没声音」。这里监听 statechange 自动 resume；
   另外在下一次用户手势时兜底补一次（Web Audio 要求 resume 落在手势内，
   无手势时自动 resume 可能被拒或永远 pending）。 */
let _ctxGuardBound = null;
function _installCtxGuard(ctx) {
    if (!ctx || _ctxGuardBound === ctx || typeof ctx.addEventListener !== 'function') return;
    _ctxGuardBound = ctx;
    ctx.addEventListener('statechange', () => {
        const st = ctx.state;
        if (st === 'suspended' || st === 'interrupted') {
            logWarn('eq', `AudioContext → ${st}（设备/会话变化），尝试自动恢复`);
            try { ctx.resume().catch(() => {}); } catch (e) { logCatch('eq', e); }
        }
    });
}

/* 手势兜底：ctx 被挂起且自动 resume 被策略挡下时，用户下一次点击/按键立即补一次。
   没有它的话整首歌都是静音，而且不产生任何报错 —— 用户只会说「有时候没声音」。 */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const _kickCtx = () => {
        const ctx = state.audioCtx;
        if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
            try { ctx.resume().catch(() => {}); } catch (e) { logCatch('eq', e); }
        }
    };
    document.addEventListener('pointerdown', _kickCtx, true);
    document.addEventListener('keydown', _kickCtx, true);
}

/** ★ 诊断快照（只读、零副作用）：音频链路每一环的真实状态。
    专治「有时候放歌没有声音」——一眼区分：图根本没建 / ctx 被挂起 /
    元素未捕获（声音没进图）/ deck 增益被掐成 0 / 初始化失败锁死。 */
export function getEqAudioSnapshot() {
    const ctx = state.audioCtx || null;
    const decks = [];
    for (const [el, rec] of _deckSources) {
        let g = NaN;
        try { g = rec && rec.gain ? rec.gain.gain.value : NaN; } catch (e) { logCatch('eq', e); }
        const id = (el && el.__nativeDeck) ? 'nativeDeck' : ((el && el.id) || '?');
        decks.push(`${id}=${Number.isFinite(g) ? g.toFixed(3) : '—'}`);
    }
    let sinkId = '';
    try { sinkId = (ctx && 'sinkId' in ctx) ? String(ctx.sinkId) : ''; } catch (e) { logCatch('eq', e); }
    let channelGains = null;
    if (state.chGains) {
        try {
            channelGains = ['ll', 'lr', 'rl', 'rr'].map(k => Number(state.chGains[k].gain.value.toFixed(4)));
        } catch (e) { logCatch('eq', e); }
    }
    return {
        inited: !!state.eqInited,
        initFailed: !!state.eqInitFailed,
        hasCtx: !!ctx,
        ctxState: ctx ? ctx.state : 'none',
        sampleRate: ctx ? ctx.sampleRate : 0,
        sinkId,
        sourceCaptured: !!state.eqSourceNode,
        hasMixBus: !!state.eqMixBus,
        deckCount: _deckSources.size,
        decks,
        spatialOn: !!state.spatialOn,
        spatialLevel: state.spatialLevel || '',
        spatialIr: state.spatialIrName || '',
        stageOn: !!state.stageOn,
        stageLevel: state.stageLevel || '',
        /* ★ 输出声道（需求 20）：模式 + 矩阵是否已建（只读诊断） */
        channelMode: state.channelMode || CHANNEL_DEFAULT,
        hasChannelMatrix: !!state.chGains,
        channelGains,
    };
}

/** 测试钩子：清空 deck 源登记与旁通标志（生产代码勿调）。 */
export function _resetEqGraphForTest() {
    _deckSources.clear();
    _passthrough = false;
}

/** ★ 保底旁通：元素一旦被 `createMediaElementSource` 捕获，它就**不再**直达系统输出，
    必须有至少一条通往 destination 的活路径。图被拆掉（cleanup）或建图失败
    （CORS / InvalidStateError）时若没人补这条路，元素就永久哑 —— 这是「有时候
    放歌没声音」的直接形态。本函数把 source 直连 destination（不带任何音效），
    保声音优先；下次 initEqAudioGraph 会 disconnect 它再改接 deckGain。 */
function _ensurePassthrough() {
    const ctx = state.audioCtx;
    if (!ctx || ctx.state === 'closed' || !state.eqSourceNode) return;
    if (_passthrough) return;   /* 已是旁通：别重复 disconnect/connect 刷日志 */
    try {
        state.eqSourceNode.disconnect();
        state.eqSourceNode.connect(ctx.destination);
        state.eqMixBus = null;
        state.eqDeckGain = null;
        _passthrough = true;
        logWarn('eq', '音效图不可用：音频已改走直连旁通（保声音优先，音效暂不生效）');
    } catch (e) { logCatch('eq', e); }
}

/* 拆掉 Web Audio 的「下游」处理图（EQ 段 / 汇流总线 / 空间 / 压缩 / 分析）。
 *
 * ★★ 2026-10-05 修复 —— 这是「有时候放歌没有声音」的根因：
 *   本函数**绝不 close() AudioContext，也绝不清掉 MediaElementSource**。
 *
 *   机理：`createMediaElementSource(el)` 对 media element 的「捕获」是**永久且不可
 *   转移**的 —— 元素一旦被捕获，它的输出就只走那个 source node，不再直接进系统。
 *   一旦 `ctx.close()`：
 *     ① 元素输出到一个已关闭的上下文 ⇒ **永久静音**（UI 却一切正常：进度在走、
 *        歌词在滚，因为元素自己仍处于 playing）；
 *     ② 换个 ctx 再 `createMediaElementSource(el)` 会抛 `InvalidStateError`
 *        （该元素已绑定另一个 source node）⇒ 落进 `eqInitFailed` 死锁，
 *        **非重启应用不能恢复**。
 *
 *   触发路径：`175-track-index-online.js:938` **每次在线点播加载都调本函数**
 *   （原注释写的是「清理旧的 Web Audio 图，防止内存泄漏」）。于是
 *   「开过均衡器 / 虚拟声场 / 空间音频」+「搜索点播」= 之后彻底没声音；
 *   而走歌单切歌路径不受影响 ⇒ 用户感知正是「**有时候**」。
 *
 *   所以本函数只拆下游节点，保留 `state.audioCtx` 与 `_deckSources` 里各元素的
 *   source node（那是不可重建的资源）；重连统一由 initEqAudioGraph 负责。
 *   不泄漏：被 disconnect 的节点已无引用，GC 会回收。
 */
/* ★ 是否**曾经**成功建过 EQ 音频图（跨 cleanupEqAudioGraph 保留，故用独立标志）。
   用途：175-track-index-online.js 每次在线点播都会 cleanupEqAudioGraph() 拆图
   （注释写的是"防内存泄漏"），但**从来没有人重建** —— 而全局响度压缩
   （DynamicsCompressor，见 initEqAudioGraph 末尾）就挂在那张图里，于是
   「在线点播期间响度均衡静默失效、整体偏响」。
   有了这个标志，175 就能在拆图前记住"用户本来是有图的"，新曲就绪后按原样重建；
   从未开过 EQ / 均衡的用户不会被强加一张图。 */
let _graphBuiltOnce = false;

/** 供加载流程判断"这一轮要不要重建 EQ 图"。 */
export function eqGraphBuiltOnce() {
    return _graphBuiltOnce;
}

export function cleanupEqAudioGraph() {
    if (state.eqFilterNodes.length > 0) {
        state.eqFilterNodes.forEach((node) => {
            try { node.disconnect(); } catch (e) { logCatch('eq', e); }
        });
        state.eqFilterNodes = [];
    }
    /* ★ Automix Phase 2：deck 增益通道只断「下游」，**source 登记一律保留**；
       gain 值复位为 1 —— 上一轮 automix 交叉会把旧 A 的 gain 落成 0，
       若那条记录被复用（影子元素轮换回主 deck）就会把活跃 deck 掐成静音。 */
    for (const rec of _deckSources.values()) {
        try { rec.gain.disconnect(); } catch (e) { logCatch('eq', e); }
        try { rec.gain.gain.cancelScheduledValues(0); rec.gain.gain.value = 1; } catch (e) { logCatch('eq', e); }
    }
    if (state.eqDeckGain) {
        try { state.eqDeckGain.disconnect(); } catch (e) { logCatch('eq', e); }
    }
    if (state.eqMixBus) {
        try { state.eqMixBus.disconnect(); } catch (e) { logCatch('eq', e); }
        state.eqMixBus = null;
    }
    /* ★ 空间处理节点图（空间音频 + 虚拟声场）一并断开（ctx.close() 会释放资源，
       这里只清引用，防止下次 initEqAudioGraph 复用已关闭 ctx 的节点） */
    const spread = (v) => (Array.isArray(v) ? v : []);
    const spatialNodes = [
        state.spatialIn, state.spatialOut, state.spatialSplit, state.spatialMerger,
        ...spread(state.spatialDryGains),
        ...spread(state.spatialWetGains),
        state.spatialConvL, state.spatialConvR,
        state.stageIn, state.stageOut, state.stageSplit, state.stageMerger,
        ...spread(state.stageDirect),
        ...spread(state.stageSGainLight),
        ...spread(state.stageSDelay),
        ...spread(state.stageSGainHaas),
        /* 输出声道矩阵（需求 20） */
        state.chIn, state.chOut, state.chSplit, state.chMerger,
        ...(state.chGains ? [state.chGains.ll, state.chGains.lr, state.chGains.rl, state.chGains.rr] : []),
    ];
    for (const n of spatialNodes) {
        if (n) { try { n.disconnect(); } catch (e) { logCatch('eq', e); } }
    }
    for (const k of ['spatialIn', 'spatialOut', 'spatialSplit', 'spatialMerger',
        'spatialDryGains', 'spatialWetGains', 'spatialConvL', 'spatialConvR', 'spatialIrName',
        'stageIn', 'stageOut', 'stageSplit', 'stageMerger', 'stageDirect',
        'stageSGainLight', 'stageSDelay', 'stageSGainHaas',
        'chIn', 'chOut', 'chSplit', 'chMerger', 'chGains']) {
        state[k] = null;
    }
    /* ★ 不复位 stageOn / spatialOn / channelMode —— 那是「用户意图」，图重建时要照着铺回去。
       也不 close state.audioCtx、不清 _deckSources（见函数头注释）。 */
    state.eqInited = false;
    /* ★★ 关键保底：图拆了但元素仍被捕获 ⇒ 必须立刻补一条直连旁通，否则这一段
       静默期（175 的在线加载流程**不会**自己重建图）里整首歌没声音。
       这是「搜索点播一首歌就没声音」的直接原因。 */
    _ensurePassthrough();
    /* ★ 输出设备重挂（原生输出线 Phase 1）：ctx 仍是有效 sink 目标，这里重挂是幂等的；
       保留调用以便 ctx 真被重建过时（state==='closed' 分支）设备选择不丢。 */
    try {
        const A = globalThis.Aria;
        if (A && typeof A.__audioOutputReapply === 'function') A.__audioOutputReapply();
    } catch (e) { logCatch('eq', e); }
}

/* ============================================================
 * 空间音频（HRTF 卷积）— 节点图与参数应用
 *
 *   in ─┬─ split(2) ─ L ─┬─ dGL(1−w) ───────► merger(0)   （干路：保清晰度）
 *       │                └─ convL ─ wGL(w) ─► merger(0)   （湿路：左耳 IR）
 *       └─ split(2) ─ R ─┬─ dGR(1−w) ───────► merger(1)
 *                        └─ convR ─ wGR(w) ─► merger(1)   （湿路：右耳 IR）
 *   merger ─► out
 *
 * dry/wet **并联**：HRTF 冲激响应天然低通（方案 §1.1），纯 wet 一定糊 ⇒
 * 必须留一条干路保清晰度。wet 即档位（轻/中/强）。
 *
 * ★ `ConvolverNode.normalize` 显式设 **false**：IR 已在生成期按能量归一化
 *   （scripts/build_spatial_tuning.mjs），再让浏览器归一化一次会让 Web 与 Rust
 *   两条路径的**响度口径**不一致。方案 §2.1 允许关掉它，条件正是"自己补增益
 *   补偿"——那个补偿就是生成期的归一化。
 * ★ IR 固定 48k，而 AudioContext 可能是 44.1k（独占路径更是按源采样率）⇒
 *   用与 Rust 侧**逐位同算法**的 `resampleLinear`（生成器同时产出两版）。
 * ============================================================ */

/** 把生成的 IR（Float32Array，48k）做成 ConvolverNode 可用的 AudioBuffer。 */
function _irBuffer(ctx, samples) {
    const resampled = resampleLinear(samples, IR_SAMPLE_RATE, ctx.sampleRate);
    const buf = ctx.createBuffer(1, Math.max(1, resampled.length), ctx.sampleRate);
    buf.copyToChannel(resampled, 0);
    return buf;
}

/**
 * 建立空间音频节点图，返回链路出口节点（搭建失败则原样返回入参，整体旁通）。
 * @param {AudioNode} inputNode
 * @returns {AudioNode}
 */
function _buildSpatialGraph(inputNode) {
    const ctx = state.audioCtx;
    try {
        const inNode = ctx.createGain();
        const out = ctx.createGain();
        const split = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const dGL = ctx.createGain();
        const dGR = ctx.createGain();
        const wGL = ctx.createGain();
        const wGR = ctx.createGain();
        /* 干路初值：wet=0 ⇒ dry=1、wet 增益=0，整条支路**逐样本透明** */
        dGL.gain.value = 1;
        dGR.gain.value = 1;
        wGL.gain.value = 0;
        wGR.gain.value = 0;
        const convL = ctx.createConvolver();
        const convR = ctx.createConvolver();
        /* ★ 见文件头：IR 已预归一化，绝不能让浏览器再归一化一次 */
        convL.normalize = false;
        convR.normalize = false;

        inNode.connect(split);
        /* 干路（1−w） */
        split.connect(dGL, 0);
        dGL.connect(merger, 0, 0);
        split.connect(dGR, 1);
        dGR.connect(merger, 0, 1);
        /* 湿路（w）：每声道各自过自己的耳 IR（ConvolverNode 配单声道 buffer
           ⇒ 内部下混为单声道输出，正是我们要的"每耳一条 FIR"） */
        split.connect(convL, 0);
        convL.connect(wGL);
        wGL.connect(merger, 0, 0);
        split.connect(convR, 1);
        convR.connect(wGR);
        wGR.connect(merger, 0, 1);

        merger.connect(out);

        state.spatialIn = inNode;
        state.spatialOut = out;
        state.spatialSplit = split;
        state.spatialMerger = merger;
        state.spatialDryGains = [dGL, dGR];
        state.spatialWetGains = [wGL, wGR];
        state.spatialConvL = convL;
        state.spatialConvR = convR;
        if (state.spatialLevel == null) state.spatialLevel = SPATIAL_DEFAULT;
        inputNode.connect(inNode);
        return out;
    } catch (e) {
        logWarn('eq', '空间音频节点搭建失败，已旁通：', e && e.message ? e.message : e);
        return inputNode;
    }
}

/**
 * 应用空间音频参数（开关 + 档位 + IR 预设）。增益走 setTargetAtTime 平滑，
 * 防切换档位时的 zipper noise（方案 §2.1 关键约束）。
 * @param {boolean} on
 * @param {string} level  'light' | 'medium' | 'strong'
 * @param {string} irName 'near' | 'hall' | 'wide'
 */
export function applySpatialAudio(on, level, irName) {
    const ctx = state.audioCtx;
    /* 图未建（EQ 从未初始化 / 搭建失败）：只记状态，等 initEqAudioGraph
       建图后末尾会再调一次本函数把状态铺上去。 */
    if (!ctx || !state.spatialIn) {
        state.spatialOn = !!on;
        state.spatialLevel = level;
        state.spatialIrName = irName;
        return;
    }
    const t = ctx.currentTime;
    const k = STAGE_SMOOTH;
    const setP = (param, v) => { try { param.setTargetAtTime(v, t, k); } catch (e) { logCatch('eq', e); } };
    state.spatialOn = !!on;
    state.spatialLevel = level;

    /* IR 换预设才重建 buffer（重采样 + 分配，不该每次调用都做）。
       脏值回落缺省（不抛：音频路径不该因一个坏预设名整体失效）。 */
    const wanted = IR_ORDER.includes(irName) ? irName : IR_DEFAULT;
    if (wanted !== state.spatialIrName) {
        try {
            const pair = irFor(wanted);
            state.spatialConvL.buffer = _irBuffer(ctx, pair.left);
            state.spatialConvR.buffer = _irBuffer(ctx, pair.right);
            state.spatialIrName = wanted;
        } catch (e) {
            logWarn('eq', 'HRTF IR 装载失败：', e && e.message ? e.message : e);
        }
    }

    const wet = on ? spatialTuningFor(level).wet : 0;
    for (const n of (state.spatialWetGains || [])) setP(n.gain, wet);
    for (const n of (state.spatialDryGains || [])) setP(n.gain, 1 - wet);
    logInfo('eq', `spatial audio -> ${on ? level : 'off'} (wet=${wet.toFixed(2)}, ir=${state.spatialIrName})`);
}

/* ============================================================
 * 虚拟声场（M/S 展宽 + Haas）— 节点图与参数应用
 *
 * Web Audio 没有 M/S 原生节点，用四个增益搭出等价形式：
 *
 *   in ─┬─ split(2) ─ L ─┬─ dL(a) ─────────► merger(0)   （同侧，a=(1+S)/2）
 *       │                ├─ sL(b) ─────────► merger(1)   （对侧，b=(1−S)/2）
 *       │                └─ haasL ─ hGL ────► merger(1)   （medium 档）
 *       └─ split(2) ─ R ─┬─ dR(a) ─────────► merger(1)
 *                        ├─ sR(b) ─────────► merger(0)
 *                        └─ haasR ─ hGR ────► merger(0)
 *   merger ─► out
 *
 * ★★ 为什么是 M/S 而不是"向对侧注入同相信号"（这条踩过坑，务必读懂）：
 *   同相串音 out_L = L + k·R (k>0) 的效果是**收窄**而非展宽——
 *     S_out = (out_L − out_R)/2 = S_in·(1 − k)  ⇒ S 被缩小。
 *   （耳机的 Bauer crossfeed 正是靠这个原理**减少**立体声宽度。）
 *   真展宽要求 S_out = S·S_in（S>1），对偶地需要**反相注入**：
 *     a = (1+S)/2（同侧）, b = (1−S)/2（对侧，S>1 时 b<0）
 *     out_L = a·L + b·R ,  out_R = b·L + a·R
 *   关键性质 **a + b ≡ 1** ⇒ 单声道和 (L+R) **精确不变**（不抵消）。
 *   这正是方案 §1.2「轻档用 M/S，几乎零风险」的原意：同侧那一份被同步抬高，
 *   抵消掉对侧反相注入对和的削减。（盲目只把一侧反相、不抬同侧，才会真抵消。）
 * ★ Haas 是额外宽度：把对侧声道微延时混入（8ms / 0.18），靠优先效应产生包围感。
 *   它**会**改单声道相位（(L+R) 被 (1 + mix·z^-d) 梳状滤波，最深 −1.6dB），
 *   幅度克制所以可接受——这是本功能唯一需要留意的地方（方案 §1.2 警告）。
 * ★ 不做峰值补偿：a ≤ 1.16（S≤1.32），最大抬升 ≤ +1.4dB。留这点余量是为了
 *   保住 a+b≡1 这条单声道不变量——为压 1dB 破坏它不划算。
 * ============================================================ */

/**
 * 建立虚拟声场节点图，返回链路出口节点（搭建失败则原样返回入参，整体旁通）。
 * @param {AudioNode} inputNode
 * @returns {AudioNode}
 */
function _buildStageGraph(inputNode) {
    const ctx = state.audioCtx;
    try {
        const inNode = ctx.createGain();
        const out = ctx.createGain();
        const split = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        /* 同侧增益 a（关时 = 1） */
        const dL = ctx.createGain();
        const dR = ctx.createGain();
        dL.gain.value = 1;
        dR.gain.value = 1;
        /* 对侧增益 b（关时 = 0；S>1 时为负 = 反相注入） */
        const sL = ctx.createGain();
        const sR = ctx.createGain();
        sL.gain.value = 0;
        sR.gain.value = 0;
        /* Haas 支路（medium 档）：对侧微延时混入 */
        const haasL = ctx.createDelay(0.05);
        const haasR = ctx.createDelay(0.05);
        const haasGL = ctx.createGain();
        const haasGR = ctx.createGain();
        haasGL.gain.value = 0;
        haasGR.gain.value = 0;

        inNode.connect(split);
        /* L：同侧入左、对侧入右、Haas 入右 */
        split.connect(dL, 0);
        dL.connect(merger, 0, 0);
        split.connect(sL, 0);
        sL.connect(merger, 0, 1);
        split.connect(haasL, 0);
        haasL.connect(haasGL);
        haasGL.connect(merger, 0, 1);
        /* R：同侧入右、对侧入左、Haas 入左 */
        split.connect(dR, 1);
        dR.connect(merger, 0, 1);
        split.connect(sR, 1);
        sR.connect(merger, 0, 0);
        split.connect(haasR, 1);
        haasR.connect(haasGR);
        haasGR.connect(merger, 0, 0);

        /* merger → out。关时 a=1 / b=0 / haas=0 ⇒ 输出 = 原封不动的 L/R；
           开关只改增益，绝不 disconnect。 */
        merger.connect(out);

        state.stageIn = inNode;
        state.stageOut = out;
        state.stageSplit = split;
        state.stageMerger = merger;
        state.stageDirect = [dL, dR];
        state.stageSGainLight = [sL, sR];   /* 一对，成对设值 */
        state.stageSDelay = [haasL, haasR];
        state.stageSGainHaas = [haasGL, haasGR];
        /* ★ 不在此处重置 state.stageOn / stageLevel —— 用户可能在 EQ 首次建图前
           就已打开虚拟声场，重置会丢掉那个意图（随后 initEqAudioGraph 末尾会按
           state.stageOn 铺参数）。 */
        if (state.stageLevel == null) state.stageLevel = STAGE_DEFAULT;
        inputNode.connect(inNode);
        return out;
    } catch (e) {
        logWarn('eq', '虚拟声场节点搭建失败，已旁通：', e && e.message ? e.message : e);
        return inputNode;
    }
}

/**
 * 应用虚拟声场参数（开关 + 档位）。所有增益走 setTargetAtTime 平滑，
 * 防切换档位时的 zipper noise（方案 §2.1 关键约束）。
 * @param {boolean} on
 * @param {string} level  'light' | 'medium'
 */
export function applyVirtualStage(on, level) {
    const ctx = state.audioCtx;
    /* 图未建（EQ 从未初始化 / 搭建失败）：只记状态，等 initEqAudioGraph 建图后
       initEqAudioGraph 末尾会再调一次本函数把状态铺上去。 */
    if (!ctx || !state.stageIn) { state.stageOn = !!on; state.stageLevel = level; return; }
    const t = ctx.currentTime;
    const k = STAGE_SMOOTH;
    const setP = (param, v) => { try { param.setTargetAtTime(v, t, k); } catch (e) { logCatch('eq', e); } };
    state.stageOn = !!on;
    state.stageLevel = level;

    /* ★ M/S 形式（见上文推导）：a + b ≡ 1 ⇒ 单声道和精确不变。 */
    const s = on ? Math.max(0, stageTuningFor(level).stageS || 1) : 1;
    const a = (1 + s) / 2;
    const b = (1 - s) / 2;
    for (const n of (state.stageDirect || [])) setP(n.gain, a);
    for (const n of (state.stageSGainLight || [])) setP(n.gain, b);

    const tune = stageTuningFor(level);
    const haasOn = on && tune.haasMs > 0 && tune.haasMix > 0;
    for (const n of (state.stageSDelay || [])) {
        if (haasOn) { try { n.delayTime.setTargetAtTime(tune.haasMs / 1000, t, k); } catch (e) { logCatch('eq', e); } }
    }
    for (const n of (state.stageSGainHaas || [])) setP(n.gain, haasOn ? tune.haasMix : 0);
    logInfo('eq', `virtual stage -> ${on ? level : 'off'} (a=${a.toFixed(3)}, b=${b.toFixed(3)}, haas=${haasOn ? tune.haasMs : 0}ms)`);
}

/* ============================================================
 * 输出声道矩阵（需求 20）— 链路**最末端**（compressor 之后、destination 之前）
 *
 * 用途：立体声 / 单声道 / 只听左 / 只听右 / 交换左右。纯声道参数控制。
 *
 *   in ─ split(2) ─┬─ L ─┬─ gLL ─► merger(0)    out_L = gLL·L + gRL·R
 *                  │     └─ gLR ─► merger(1)    out_R = gLR·L + gRR·R
 *                  └─ R ─┬─ gRL ─► merger(0)
 *                        └─ gRR ─► merger(1)
 *   merger ─► out
 *
 * ★ 为什么放最末端：声道是**渲染的最后一步**（决定"这两根线各送什么"）。
 *   放在 compressor 之前会让下混后的单声道去驱动压缩器的侧链（增益约简曲线
 *   完全不同），放在之后才是"先按正常立体声处理、最后再决定怎么摆"。
 * ★ stereo 档必须**逐样本透明**：gLL=gRR=1、gLR=gRL=0。ChannelSplitter/Merger
 *   是纯路由节点，不引入采样延迟，所以 stereo 档与"没有这个矩阵"完全等价。
 * ★ 与空间处理（spatial/stage）一样：**图常驻、只改增益**，绝不 disconnect。
 * ============================================================ */
/** 声道模式 → 4 个矩阵增益（ll: L→左, lr: L→右, rl: R→左, rr: R→右） */
export const CHANNEL_MODES = {
    stereo: { ll: 1, lr: 0, rl: 0, rr: 1 },
    /* 单声道：每边都放 (L+R)/2。相关信号（L≈R）时幅度不变、不溢出；
       不相关时按标准下混 −3dB（这正是"单声道化"该有的响度损失）。 */
    mono: { ll: 0.5, lr: 0.5, rl: 0.5, rr: 0.5 },
    /* 只听左：把 L 复制到两边（不是把 R 静音到一耳留空） */
    left: { ll: 1, lr: 0, rl: 1, rr: 0 },
    right: { ll: 0, lr: 1, rl: 0, rr: 1 },
    swap: { ll: 0, lr: 1, rl: 1, rr: 0 },
};
export const CHANNEL_MODES_ORDER = ['stereo', 'mono', 'left', 'right', 'swap'];
export const CHANNEL_DEFAULT = 'stereo';

function _buildChannelMatrix(inputNode) {
    const ctx = state.audioCtx;
    try {
        const inNode = ctx.createGain();
        const out = ctx.createGain();
        const split = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const gLL = ctx.createGain();
        const gLR = ctx.createGain();
        const gRL = ctx.createGain();
        const gRR = ctx.createGain();
        /* 初值 = stereo（透明），避免建图瞬间出现"串音" 咔哒 */
        gLL.gain.value = 1; gLR.gain.value = 0;
        gRL.gain.value = 0; gRR.gain.value = 1;

        inNode.connect(split);
        split.connect(gLL, 0); gLL.connect(merger, 0, 0);
        split.connect(gLR, 0); gLR.connect(merger, 0, 1);
        split.connect(gRL, 1); gRL.connect(merger, 0, 0);
        split.connect(gRR, 1); gRR.connect(merger, 0, 1);
        merger.connect(out);

        state.chIn = inNode;
        state.chOut = out;
        state.chSplit = split;
        state.chMerger = merger;
        state.chGains = { ll: gLL, lr: gLR, rl: gRL, rr: gRR };
        if (state.channelMode == null) state.channelMode = CHANNEL_DEFAULT;
        inputNode.connect(inNode);
        return out;
    } catch (e) {
        logWarn('eq', '输出声道矩阵搭建失败，已旁通：', e && e.message ? e.message : e);
        return inputNode;
    }
}

/**
 * 应用输出声道模式。已建图则平滑改增益；未建图只记状态（建图时 initEqAudioGraph 补铺）。
 * @param {string} mode 'stereo' | 'mono' | 'left' | 'right' | 'swap'
 */
export function applyChannelMode(mode) {
    const m = CHANNEL_MODES[mode] ? mode : CHANNEL_DEFAULT;
    state.channelMode = m;
    const ctx = state.audioCtx;
    if (!ctx || !state.chGains) return;
    const g = CHANNEL_MODES[m];
    const t = ctx.currentTime;
    const k = STAGE_SMOOTH;
    const set = (n, v) => { try { n.gain.setTargetAtTime(v, t, k); } catch (e) { logCatch('eq', e); } };
    set(state.chGains.ll, g.ll);
    set(state.chGains.lr, g.lr);
    set(state.chGains.rl, g.rl);
    set(state.chGains.rr, g.rr);
    logInfo('eq', `channel mode -> ${m}`);
}

/**
 * ★★ 2026-10-06 修「立体声 / 切换声道没用」（需求 20 的真实根因）。
 *
 * 机制：声道矩阵、10 段均衡、虚拟声场、空间音频、响度压缩**全都挂在那张
 * Web Audio 图上**，而那张图此前**只有"打开均衡器面板"才会建**。
 * 于是一个从没点过均衡器的用户去切声道：`applyChannelMode` 只写了
 * `state.channelMode`，图不存在 ⇒ **一个字节的处理都没发生**。
 * 表现正是用户说的"按钮能点、选中态会变、声音完全没变"。
 *
 * 这两个函数把"需要图就得建图"显式化：
 *   · `wantsAudioGraph()` —— 回答"用户有没有必须建图才能生效的意图"
 *     （刻意包含 `_graphBuiltOnce`：一旦建过就延续旧行为，别让响度压缩又消失）；
 *   · `ensureAudioGraph()` —— "需要就现在建"，并把成败如实返回。
 *
 * ⚠ 原生 WASAPI 独占输出下音频根本不走 WebAudio（见 app/298），
 *   这张图**不存在也不该存在** —— 那种情况由调用方负责提示用户。
 */
export function wantsAudioGraph() {
    if (_graphBuiltOnce) return true;
    if ((state.channelMode || CHANNEL_DEFAULT) !== CHANNEL_DEFAULT) return true;
    if (state.spatialOn || state.stageOn) return true;
    const gains = Array.isArray(state.eqGains) ? state.eqGains : [];
    if (gains.some((g) => Math.abs(Number(g) || 0) > 0.01)) return true;
    return false;
}

/**
 * 确保音频图可用（需要就建）。
 * ★ 调用方必须 await 并检查返回值：建图要做一次 crossOrigin 重载测试
 *   （见 initEqAudioGraph），跨域受限的音源会**失败**。失败必须让用户知道，
 *   否则又变成一次"设置没生效但没人说"。
 * @param {string} [reason] 仅用于日志定位
 * @returns {Promise<boolean>}
 */
export async function ensureAudioGraph(reason = '') {
    if (state.eqInited && state.chGains) return true;
    try {
        const ok = await initEqAudioGraph();
        if (!ok) logWarn('eq', `需要音频图才能生效的处理（${reason || '未注明'}）未能建图`);
        return !!ok;
    } catch (e) {
        logCatch('eq', e);
        return false;
    }
}

/* 懒初始化 Web Audio 图：source → filter[0..9] → 虚拟声场 → compressor → destination
   跨域音频需先设置 crossOrigin 并重新加载测试，失败则回退 */
export async function initEqAudioGraph() {
    if (state.eqInited) return true;
    if (state.eqInitFailed) { _ensurePassthrough(); return false; }
    if (!_audio) return false;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { logWarn('eq', '不支持 Web Audio API'); return false; }

    const currentSrc = _audio.src;
    if (!currentSrc) { _ensurePassthrough(); return false; }

    const savedTime = _audio.currentTime;
    const wasPlaying = !_audio.paused;
    const isBlob = currentSrc.startsWith('blob:');

    /* 跨域音频需要 crossOrigin='anonymous' 才能通过 Web Audio 输出，先重载测试，失败则回退 */
    if (!isBlob) {
        _audio.crossOrigin = 'anonymous';
        const reloadOk = await new Promise((resolve) => {
            const onCanPlay = () => {
                _audio.removeEventListener('canplay', onCanPlay);
                _audio.removeEventListener('error', onError);
                resolve(true);
            };
            const onError = () => {
                _audio.removeEventListener('canplay', onCanPlay);
                _audio.removeEventListener('error', onError);
                resolve(false);
            };
            _audio.addEventListener('canplay', onCanPlay);
            _audio.addEventListener('error', onError);
            _audio.src = currentSrc;
            _audio.load();
            setTimeout(() => resolve(false), 4000);
        });

        if (!reloadOk) {
            /* CORS 不支持，回退：移除 crossOrigin，重新加载 */
            _audio.crossOrigin = null;
            await new Promise((resolve) => {
                const onRestore = () => {
                    _audio.removeEventListener('canplay', onRestore);
                    resolve();
                };
                _audio.addEventListener('canplay', onRestore);
                _audio.src = currentSrc;
                _audio.load();
                setTimeout(resolve, 3000);
            });
            _audio.currentTime = savedTime;
            if (wasPlaying) _audio.play().catch(() => { if (_onPlayError) _onPlayError(); });
            state.eqInitFailed = true;
            /* ★ 若元素此前已被捕获（开过音效）而这次建图失败，图没了但元素仍改道
               ⇒ 必须补旁通，否则整首歌静音（CORS 受限源是常见入口）。 */
            _ensurePassthrough();
            return false;
        }
    }

    try {
        /* ★ 复用未关闭的 ctx 与已捕获的 source node。
           `createMediaElementSource(el)` 对元素的捕获不可逆（见 cleanupEqAudioGraph
           的函数头推导），所以 source node 必须**跨 cleanup 复用**，绝不能每次 new。
           只有确实没有 ctx（首启）或它已被别处 close 掉时才重建。 */
        if (!state.audioCtx || state.audioCtx.state === 'closed') {
            state.audioCtx = new AC();
            state.eqSourceNode = null;
        }
        if (!state.eqSourceNode) {
            state.eqSourceNode = state.audioCtx.createMediaElementSource(_audio);
        }
        /* ★ Automix Phase 2：主 deck 增益通道 + 汇流总线。
           音频图从「source → filters → …」改为「source → deckGain → mixBus → filters → …」。
           非交叉期 deckGain=1.0 完全透明，听感与旧图一致；交叉时 crossfader 对
           主/shadow 两个 deckGain 铺等功率曲线（AudioContext 时钟，后台精确）。 */
        state.eqDeckGain = state.audioCtx.createGain();
        state.eqMixBus = state.audioCtx.createGain();
        /* 复用时先断 source 的旧下游再改接新 deckGain（source 只连自己的 deckGain，
           disconnect 无副作用；不断的话旧 deckGain 废弃后会留一条悬挂连接，每次 init 累积）。 */
        try { state.eqSourceNode.disconnect(); } catch (e) { logCatch('eq', e); }
        state.eqSourceNode.connect(state.eqDeckGain);
        state.eqDeckGain.connect(state.eqMixBus);
        _deckSources.set(_audio, { source: state.eqSourceNode, gain: state.eqDeckGain });
        /* ★ 影子 deck（Automix）：它的 source 不可重建 ⇒ 只把 gain 改接到新 mixBus。
           不重连的话，重开音效后影子 deck 会连在已废的旧 mixBus 上（交叉时没声音）。 */
        for (const [el, rec] of _deckSources) {
            if (el === _audio || !rec || !rec.gain) continue;
            try { rec.gain.disconnect(); } catch (e) { logCatch('eq', e); }
            try { rec.gain.connect(state.eqMixBus); } catch (e) { logCatch('eq', e); }
        }
        state.eqFilterNodes = EQ_BANDS.map((freq, i) => {
            const f = state.audioCtx.createBiquadFilter();
            if (i === 0) f.type = 'lowshelf';
            else if (i === EQ_BANDS.length - 1) f.type = 'highshelf';
            else f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = 1.0;
            f.gain.value = state.eqGains[i];
            return f;
        });
        /* 串联（起点 = mixBus） */
        let node = state.eqMixBus;
        for (const f of state.eqFilterNodes) {
            node.connect(f);
            node = f;
        }
        /* ★ 空间处理（空间音频 → 虚拟声场）：插在 EQ 之后、compressor 之前。
           理由（方案 §2.1）：
             · 在 EQ 之后 —— 用户调 EQ 是「先把频谱修好」，空间处理应在干净信号上做；
             · 在 compressor 之前 —— 空间处理常让峰值上升，响度归一化要能吃到这里；
             · 在 mixBus 之后 —— Automix 双 deck 共享一套节点，交叉时声场不跳。
           空间音频在虚拟声场**之前**（方案 §2.1 的支路顺序）。
           图结构常驻（首次建图即建好），开关只改增益，绝不 disconnect（防咔哒）。
           结构性失败（老浏览器不支持 splitter/convolver）则整体旁通，不阻断 EQ 链路。 */
        node = _buildSpatialGraph(node);
        node = _buildStageGraph(node);
        /* ★ 响度归一化：EQ 输出前插一个温和的 DynamicsCompressor，
           压低过响峰值、抬升总体响度，使不同歌曲（尤其不同音源）听感更一致 */
        try {
            window.playerLoudnessComp = state.audioCtx.createDynamicsCompressor();
            window.playerLoudnessComp.threshold.value = -22;
            window.playerLoudnessComp.knee.value = 8;
            window.playerLoudnessComp.ratio.value = 3.2;
            window.playerLoudnessComp.attack.value = 0.008;
            window.playerLoudnessComp.release.value = 0.18;
            node.connect(window.playerLoudnessComp);
            node = window.playerLoudnessComp;
        } catch (ce) { /* 不支持则跳过 */ }
        /* ★ 输出声道矩阵（需求 20）：链路最末端，compressor 之后 / destination 之前 */
        node = _buildChannelMatrix(node);
        node.connect(state.audioCtx.destination);
        try {
            window.playerAudioAnalyser = state.audioCtx.createAnalyser();
            window.playerAudioAnalyser.fftSize = 128;
            window.playerAudioAnalyser.smoothingTimeConstant = 0.8;
            node.connect(window.playerAudioAnalyser);
        } catch (ae) { logCatch('eq', ae); }
        state.eqInited = true;
        _graphBuiltOnce = true; /* 记住"曾经建过图"，供 175 的加载流程判断要不要重建 */
        _passthrough = false;   /* 图已重新接上，退出旁通态 */
        _installCtxGuard(state.audioCtx);

        /* ★ 空间处理：图刚建好，把「用户已选状态」铺上去。
           initEqAudioGraph 可能在用户已经打开这两个开关之后才首次建图
           （EQ 是懒初始化的）—— 不铺的话用户开了开关却听不到效果。 */
        applySpatialAudio(
            !!state.spatialOn,
            state.spatialLevel || SPATIAL_DEFAULT,
            state.spatialIrName || IR_DEFAULT,
        );
        applyVirtualStage(!!state.stageOn, state.stageLevel || STAGE_DEFAULT);
        applyChannelMode(state.channelMode || CHANNEL_DEFAULT);

        if (state.audioCtx.state === 'suspended') {
            await state.audioCtx.resume();
        }

        /* 恢复播放状态 */
        _audio.currentTime = savedTime;
        if (wasPlaying) _audio.play().catch(() => { if (_onPlayError) _onPlayError(); });

        /* ★ 输出设备重挂（原生输出线 Phase 1）：图建成后元素自身输出已被静音，
           sink 的有效目标从 <audio> 变成 AudioContext —— 不重挂则用户选的设备
           在开过均衡器之后静默失效（sinkId 属性还报着新设备，声音走默认）。
           走 Aria 钩子而不是 import app/296：core 层不 import app 分片（同 dualDeck 规矩）。 */
        try {
            const A = globalThis.Aria;
            if (A && typeof A.__audioOutputReapply === 'function') A.__audioOutputReapply();
        } catch (e) { logCatch('eq', e); }

        return true;
    } catch (err) {
        logError('eq', '初始化均衡器失败:', err);
        /* ★ InvalidStateError = 该元素已绑定到**另一个**（多半是已关闭的）AudioContext
           ⇒ 元素永久哑，本进程内怎么修都出不来声。明确喊出来，别让用户猜。 */
        if (err && err.name === 'InvalidStateError') {
            logError('eq', '音频元素已被旧 AudioContext 捕获且无法转移：本进程不会再出声，请重启 Aria');
        }
        state.eqInitFailed = true;
        /* 元素可能已被捕获（复用时）⇒ 补旁通，至少保住声音 */
        _ensurePassthrough();
        return false;
    }
}

/* 保存 / 加载设置 */
export function saveEqSettings() {
    try {
        localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify({
            gains: state.eqGains,
            preset: state.eqActivePreset,
        }));
    } catch (e) { logCatch('eq', e); }
}

export function loadEqSettings() {
    try {
        const raw = localStorage.getItem(EQ_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.gains) && data.gains.length === 10) {
            state.eqGains = data.gains;
            state.eqActivePreset = data.preset || '自定义';
        }
    } catch (e) { logCatch('eq', e); }
}

/** 用户自定义预设表（分享码导入的预设也落在这里） */
export function getCustomEqs() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_EQ_KEY) || '{}'); } catch (e) { return {}; }
}

export function saveEqPreset(name) {
    if (!name) return;
    const customs = getCustomEqs();
    customs[name] = { gains: (state.eqGains || []).slice(), preset: state.eqActivePreset || '自定义' };
    try { localStorage.setItem(CUSTOM_EQ_KEY, JSON.stringify(customs)); } catch (e) { logCatch('eq', e); }
    state.eqActivePreset = name;
    saveEqSettings();
    if (_onChanged) _onChanged();
}

/* 应用增益值到滤波器节点 */
export function applyEqGains(gains) {
    state.eqGains = gains.slice();
    if (state.eqInited) {
        gains.forEach((g, i) => {
            if (state.eqFilterNodes[i]) {
                state.eqFilterNodes[i].gain.setValueAtTime(g, state.audioCtx.currentTime);
            }
        });
    }
    saveEqSettings();
}

/* 应用预设（内置 EQ_PRESETS + 用户自定义预设） */
export function applyEqPreset(name) {
    const preset = EQ_PRESETS[name] || getCustomEqs()[name];
    if (!preset) return false;
    state.eqActivePreset = name;
    applyEqGains(Array.isArray(preset) ? preset : (preset.gains || []));
    if (_onPresetApplied) _onPresetApplied();
    return true;
}

/* 单个频段改变：只刷新值文本与预设高亮，不重建滑块（否则拖拽会被自己的重渲染打断） */
export function setEqBand(idx, val) {
    state.eqGains[idx] = parseInt(val);
    state.eqActivePreset = '自定义';
    if (state.eqInited && state.eqFilterNodes[idx]) {
        state.eqFilterNodes[idx].gain.setValueAtTime(state.eqGains[idx], state.audioCtx.currentTime);
    }
    saveEqSettings();
    if (_onBandChanged) _onBandChanged(idx);
    if (_onChanged) _onChanged();
}
