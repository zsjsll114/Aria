/* ============================================================
 * core/automix/scheduler.js — 预载与起播决策（Automix Phase 2）
 *
 * 职责（方案 §3.2）：把「下一曲」从纯播放链里拉出来做 automix 判断——
 *   A 起播 → 后台分析 A（IndexedDB 秒回）→ timeupdate 进入 ARM 窗口
 *   → 决策下一曲 + 分析 B → decision 三层策略 → 预载 B 到影子 deck
 *   → armCrossfade + canplay 探针 → CROSSING（crossfader 接管）
 *   → 交叉完成 → 旧 A 收尾 + swapRoles + 通知 app 层做元数据同步。
 *
 * 分层纪律：core 不 import app/*。下一曲决策（computeStepTrack）、
 * URL 解析（getStreamCachedAudioUrl）、AB 循环状态、automix 开关、
 * swap 后元数据同步全部经 initScheduler 注入。
 *
 * v2 范围（在线源支持）：本地/blob 源直接交叉；在线曲（source/id 标记）在
 * ARM 期经注入的 resolveOnlinePlayUrl 即时解析（175 预载命中 → fetchPlayUrlForPreload
 * 解析链 → 流代理包装），解析失败放弃本轮走原生 ended。
 * automix 开关默认关闭（appSettings.playback.automix.enabled），未开启时
 * 本模块全部入口直接短路——合入零行为变化。
 * ============================================================ */
import { analyzeTrack } from './analyzer.js';
import { decideCrossfade, beatmatchRate } from './decision.js';
import { initCrossfader, armCrossfade, abortCrossfade, startCrossing,
    crossfaderPhase, crossfadeProgress, CROSSFADER_IDLE, CROSSFADER_ARMED } from './crossfader.js';
import { getActiveAudio, getShadowAudio, swapRoles } from '../dualDeck.js';
import { trackTitle, trackArtist } from '../nextUp.js';
import { logInfo, logCatch } from '../../services/log.js';

/**
 * ARM 窗口参数。
 * ★ 2026-10-03 重做：重叠时长改由 A 的**结构**决定（analyzer 的 outroPointMs）,
 *   不再写死。此前 beatmatch/breath 固定 6s、segue 更以 outroSparsePointMs
 *   （能量 ≤10%，已近静音）为起点，于是大量曲目听感是「等 A 没声了才淡入」。
 */
export const AUTOMIX_DEFAULTS = {
    /** 无结构信息时的兜底重叠 */
    overlapMs: 8000,
    /** 结构驱动的重叠区间：短于 3s 变化太急（听得出「开关」而不是「过渡」）；
     *  长于 16s 会与下一首的进入打架（B 的主歌都过去了 A 还没退干净）。 */
    minOverlapMs: 3000,
    maxOverlapMs: 16000,
    /** 在线曲 ARM 期取链（175 预载 → fetchPlayUrlForPreload → 流代理包装）的单次预算。
     *  与 _armAndGo 的 race 超时同源，抽出来是为了让下面那条不变量可被引用。 */
    resolveTimeoutMs: 8000,
    /** ARM 提前量。两条约束：
     *  ① 必须 > maxOverlapMs——ARM 要在交叉开始前完成取链 + 分析 + 预载 B；
     *  ② ★ armLeadMs − maxOverlapMs ≥ resolveTimeoutMs。否则当 A 的自然尾声很长
     *      （重叠被 clamp 到 maxOverlapMs）时，「ARM 开始」到「最迟必须开交叉」之间
     *      的可用时间比取链超时还短——取链一旦走满超时，交叉在起跑线上就已经迟到，
     *      表现为「ARM 了却永远不开交叉」。22s 时差值仅 6s < 8s（不成立），故取 26s
     *      （差值 10s，留 2s 给 B 的 canplay）。 */
    armLeadMs: 26000,
};

/**
 * 重叠时长：优先由 A 的结构点决定。
 *
 * analyzer 把 outroPointMs 定义为「A **最早可以开始交叉的位置**」——从尾部回扫
 * 第一个能量 ≥ 峰值 30% 的窗口末端，即音乐内容已入衰减、但**仍有声**的地方。
 * 从那儿开始交叉，重叠长度天然等于 durationMs - outroPointMs，听感是「叠加」
 * 而不是「等 A 停了再进 B」——这才是 Apple Music 的行为。
 *
 * 兜底链：outroPointMs 缺失 → outroSparsePointMs（能量 ≤10%，已近静音，只能算
 * 不坏了）→ 固定 overlapMs。尾部突然截断（outroPoint = 全曲长，无自然淡出）
 * 时同样退到固定值——那种重叠只能切在响处，是已知取舍。
 * @param {object|null} anA A 的分析结果
 * @returns {number} 毫秒
 */
function _resolveOverlap(anA) {
    const d = AUTOMIX_DEFAULTS;
    if (!anA || !(anA.durationMs > 0)) return d.overlapMs;
    let natural = (anA.outroPointMs > 0) ? anA.durationMs - anA.outroPointMs : 0;
    if (!(natural > 500) && anA.outroSparsePointMs > 0) {
        natural = anA.durationMs - anA.outroSparsePointMs;
    }
    if (!(natural > 500)) return d.overlapMs;
    return Math.max(d.minOverlapMs, Math.min(d.maxOverlapMs, natural));
}

/** ARM 期单侧分析的超时：分析只是观感优化，卡住的请求宁可放弃本轮，
 *  也绝不能把 _arming 卡成 true 让 automix 永久瘫痪（真机无超时实测踩坑）。 */
const ANALYZE_TIMEOUT_MS = 20000;

/**
 * ★ 队列条目字段名不统一（title/song/name、artist/singer）——见 core/nextUp.js
 * 的 trackTitle/trackArtist。这不是边角情况：榜单 / 自建歌单 / 历史播放的「播放全部」
 * 都是先 push 原始接口对象、再以 `loadOnlineSong(first, /*skipPlaylistUpdate*\/ true)`
 * 播放，队列里留下的就是 {song, singer} 形状；175 的 loadOnlineSong 会用 titleOf/artistOf
 * 归一出 currentSongData，但**不改队列条目本身**。
 *
 * automix 读的正是队列条目，直读 .title 会连锁出三类故障（真机日志实录：
 * `ARM 开始：A=? → B=2` / `[Preload] 开始预加载下一首: undefined`）：
 *   ① 日志里完全没有歌名，排查时无法确认是哪首；
 *   ② 空 songName 传给 fetchPlayUrlForPreload → 「跨源同名歌兜底」（酷狗→网易→酷我，
 *      守卫是 `if (!playUrl && songName)`）整条失效 → ARM 取链失去最后的退路；
 *   ③ onSwappedMeta 交出的 track 缺名，135 虽自带 `|| song || name` 兜底，
 *      但写进 currentSongData 的会是空标题。
 *
 * 在**唯一入口**归一一次（本模块所有外部条目都经它），scheduler 的日志、
 * 分析、取链、以及交给 app 的元数据就都是完整条目。刻意复制一份再补字段：
 * 不改动调用方持有的对象（那是 app 的队列条目，别处还有别的消费者）。
 */
function _normTrack(t) {
    if (!t || typeof t !== 'object') return null;
    return { ...t, title: trackTitle(t), artist: trackArtist(t) };
}

let _deps = null;
let _analysisMemo = new Map();   /* url → Promise<analysis|null>（进程内；analyzeTrack 自带持久缓存） */
let _currentUrl = null;          /* 当前曲分析对应的 URL（swap 后失效） */
let _arming = false;             /* _armAndGo 在途（防 timeupdate 每帧重入） */
let _armedNext = null;           /* ARM 成功时存的 { track, index }，swap 完成时交给 app */
let _plannedOverlapMs = 0;       /* 本轮计划的交叉时长（segue 稀疏区短交叉 < 6000） */
let _shadowReady = false;        /* 影子 deck canplay 已触发（交叉开始的必要条件之一） */
let _shadowProbe = null;         /* [el, type, fn] B 的 canplay 一次性探针 */
let _swapApplied = false;        /* 本轮角色顶替是否已做（交接点提前做，曲线走完兜底补） */
let _warnedDuration = false;     /* 诊断：duration 非有限的警告只打一次 */

/* ARM 重试节流：同一首曲最多尝试 N 次、间隔 ms。真机实测：取链失败时
   onTimeUpdate 每 250ms 重试一次，15s 窗口刷出上百条相同日志并反复打爆网络。
   3 次足以覆盖「预载稍后就绪」，换歌（_currentUrl 变化）自动重置计数。 */
const ARM_MAX_ATTEMPTS = 3;
const ARM_RETRY_INTERVAL_MS = 3000;
let _armUrl = null;              /* 重试计数所属的曲目 URL */
let _armAttempts = 0;            /* 当前曲已尝试 ARM 的次数 */
let _lastArmTs = 0;              /* 上次尝试时刻（节流） */

/**
 * 注入 app 层依赖。
 *
 * ★ 契约：getCurrentTrack / getNextTrack 返回的**原始队列条目**允许字段名不统一
 *   （title/song/name、artist/singer）；scheduler 会在所有入口用 _normTrack 归一，
 *   因此 resolveTrackUrl / resolveOnlinePlayUrl / onSwappedMeta / analyzer 以及日志
 *   拿到的 track 一定已有完整 title/artist。app 侧无需自己补。
 *
 * @param {{
 *   isEnabled: () => boolean,
 *   getCurrentTrack: () => object|null,
 *   getNextTrack: () => {track: object, index: number}|null,
 *   resolveTrackUrl: (track: object) => string,
 *   resolveOnlinePlayUrl?: (track: object) => Promise<string>,  // 在线曲 ARM 期即时解析（175 链），失败返回空串
 *   isAbLoopActive: () => boolean,
 *   onSwappedMeta: (info: {plan: object, next: {track: object, index: number}|null}) => void,
 *   onCrossfadeProgress?: (p: number, info: {plan: object, next: {track:object,index:number}|null}) => void,  // 交叉进度 0~1（UI 过渡动画）
 *   schedule?: (fn: Function, ms: number) => any,
 * }} deps
 */
export function initScheduler(deps) {
    _deps = Object.assign({
        isEnabled: () => false,
        getCurrentTrack: () => null,
        getNextTrack: () => null,
        resolveTrackUrl: (t) => (t && t.url) || '',
        isAbLoopActive: () => false,
        onSwappedMeta: () => {},
        /* UI 过渡动画（封面/背景/next-up 过渡态）消费交叉进度；未注入时空转 */
        onCrossfadeProgress: () => {},
        schedule: (fn, ms) => setTimeout(fn, ms),
        analyzeImpl: (track) => analyzeTrack(track),
    }, deps || {});
    /* crossfader 的时钟/调度句柄可透传（测试手控时间）；未注入用默认 */
    const cfDeps = {
        getDecks: () => {
            const a = getActiveAudio();
            const b = getShadowAudio();
            return (a && b) ? { a, b } : null;
        },
        /* ★ 交接点（进度过半）：提前做角色顶替，UI 整体切到下一首而音频继续交叉 */
        onSwapPoint: (info) => _applySwap(info && info.plan),
        onProgress: (p, info) => {
            try {
                if (typeof _deps.onCrossfadeProgress === 'function') {
                    /* 带上 next：UI 过渡期要显示「正在切到 XXX」。交接点之后
                       _armedNext 已清空（那时播放栏本身已经切过去了）。 */
                    _deps.onCrossfadeProgress(p, { plan: info && info.plan, next: _armedNext });
                }
            } catch (e) { logCatch('automix.scheduler', e); }
        },
        onSwapped: (info) => _handleCrossfadeDone(info),
        onAborted: (reason) => {
            _armedNext = null;
            _clearShadowProbe();
            if (reason !== 'too-late') logInfo('automix.scheduler', `本轮 automix 放弃：${reason}`);
        },
    };
    for (const k of ['now', 'schedule', 'cancelScheduled', 'raf', 'caf']) {
        if (deps && typeof deps[k] === 'function') cfDeps[k] = deps[k];
    }
    initCrossfader(cfDeps);
}

/**
 * 当前曲起播后调用：后台分析 A（有缓存时秒回，无缓存时离线解码 ~1-2s）。
 * @param {object} track
 * @param {boolean} [prewarm] 起播（play 事件 / 交叉 swap）传 true → 同时预分析
 *   队列下一曲。★ 真机根因修复：在线曲经 /api/audio/stream 流代理是**整首
 *   回源下载**（server 无论带不带 Range 都向上游 Range: bytes=0-），高码率 mp3
 *   要数秒~数十秒；原来 B 只在歌尾前 armLeadMs(15s) 才开始分析，装不下 →
 *   anB=null → decision 'none' → 永不交叉（E2E 用短 wav 直连掩盖了这条真机路径）。
 *   提前到起播，B 有整首歌的时间完成，结果按 track.id 进 IndexedDB，ARM 时秒回。
 */
export function notifyTrackStarted(track, prewarm = false) {
    if (!_deps || !_deps.isEnabled()) return;
    const t = _normTrack(track);
    const url = _deps.resolveTrackUrl(t);
    if (!url) {
        logInfo('automix.scheduler', `起播分析跳过：无法解析当前曲 URL（title=${(t && t.title) || '?'}）`);
        return;
    }
    _currentUrl = url;
    ensureAnalyzed(t, url).catch((e) => logCatch('automix.scheduler', e));
    if (prewarm) _prewarmNext();
}

/**
 * 预分析「队列下一曲」：把 B 的分析从「歌尾前 armLeadMs」提前到「A 刚开始播」。
 * best-effort——在线曲先解析直链（175 预载命中优先，否则完整解析链）再分析；
 * 解析/分析任何一步失败都静默，绝不影响当前播放与 ARM 主流程。
 * 进程内 memo 按 URL 去重、持久缓存按 track.id——ARM 期即使重解析出新链也不重算。
 */
function _prewarmNext() {
    try {
        const next = _deps.getNextTrack();
        const t = _normTrack(next && next.track);
        if (!t) return;
        if (t.source || t.id) {
            if (typeof _deps.resolveOnlinePlayUrl !== 'function') return;
            Promise.resolve(_deps.resolveOnlinePlayUrl(t))
                .then((u) => { if (u) ensureAnalyzed(t, u).catch(() => {}); })
                .catch(() => {});
        } else {
            const u = _deps.resolveTrackUrl(t);
            if (u) ensureAnalyzed(t, u).catch(() => {});
        }
    } catch (e) { logCatch('automix.scheduler', e); }
}

/** 分析（进程内 memo + analyzer 的 IndexedDB 持久缓存两层）。 */
export function ensureAnalyzed(track, resolvedUrl) {
    const url = resolvedUrl || _deps.resolveTrackUrl(track);
    if (!url) return Promise.resolve(null);
    if (_analysisMemo.has(url)) return _analysisMemo.get(url);
    const p = _deps.analyzeImpl({ ...track, url })
        .then((r) => { if (!r) _analysisMemo.delete(url); return r; })
        .catch((e) => { _analysisMemo.delete(url); logCatch('automix.scheduler', e); return null; });
    _analysisMemo.set(url, p);
    return p;
}

/** 换歌（含 automix 自己的 swap）后失效当前曲 memo——同一 URL 的 B 侧分析不受影响。 */
export function invalidateCurrentAnalysis() {
    _currentUrl = null;
}

/**
 * timeupdate 钩子（app 层在常驻 timeupdate 监听里每帧调用；内部全部短路判，
 * 未开启时开销 ≈ 一次函数调用）。
 */
export function onTimeUpdate() {
    if (!_deps || !_deps.isEnabled()) return;
    const phase = crossfaderPhase();
    if (phase !== CROSSFADER_IDLE && phase !== CROSSFADER_ARMED) return;
    if (_deps.isAbLoopActive()) return;
    const a = getActiveAudio();
    if (!a) return;
    /* ★ 诊断锚点（一次性）：duration 非有限会让 ARM 判定永久失真——在线曲经
       /api/audio/stream 流代理时若上游没给 Content-Length，浏览器可能给出
       Infinity/NaN 的 duration。此前这里静默 return，外部表现为「automix 完全
       无日志、无任何效果」，是排查中最难看见的盲区。打一条把环境问题暴露出来。 */
    if (!Number.isFinite(a.duration) || a.duration <= 0) {
        if (!_warnedDuration) {
            _warnedDuration = true;
            let seekEnd = '无';
            try { if (a.seekable && a.seekable.length) seekEnd = a.seekable.end(0).toFixed(1) + 's'; } catch { /* ignore */ }
            logInfo('automix.scheduler',
                `onTimeUpdate 跳过：A 的 duration 非有限（dur=${a.duration}，seekable.end=${seekEnd}）`
                + '——在线流未拿到长度时如此，automix 无法判定歌尾位置。');
        }
        return;
    }
    if (a.paused) return;
    /* 当前曲尚未进分析管线（用户播放中途才打开开关 / play 事件错过）→ 补挂。
       _currentUrl 一旦设置就不再进入，每帧只剩一次比较。 */
    if (_currentUrl === null) {
        const cur = _deps.getCurrentTrack();
        if (cur) notifyTrackStarted(cur);
    }
    const remainingMs = (a.duration - a.currentTime) * 1000;
    if (phase === CROSSFADER_ARMED) {
        /* 交叉开始窗口：A 剩余 ≤ 计划重叠时长 且 B 已就绪。canplay 只标记
           就绪、不直接开交叉——ARM 在剩 15s，B 缓存命中后 1s 内就能 canplay，
           「canplay 即开」会把交叉打在 A 的正常播放段并提前结束（实测踩坑）。 */
        const overlap = _plannedOverlapMs || AUTOMIX_DEFAULTS.overlapMs;
        if (remainingMs <= overlap && _shadowReady) {
            _clearShadowProbe();
            startCrossing();
            return;
        }
        /* 窗口下沿还没就绪 → 放弃，让原生 ended 接管 */
        if (remainingMs < overlap * 0.6) abortCrossfade('too-late');
        return;
    }
    if (_arming || remainingMs > AUTOMIX_DEFAULTS.armLeadMs) return;
    /* ARM 重试节流（见 ARM_MAX_ATTEMPTS 注释）：失败即永久放弃会错过「预载稍后
       就绪」，无节流重试则刷屏打爆网络——取中道：同一首最多 3 次、间隔 3s。 */
    if (_armUrl !== _currentUrl) { _armUrl = _currentUrl; _armAttempts = 0; _lastArmTs = 0; }
    if (_armAttempts >= ARM_MAX_ATTEMPTS) return;
    const tNow = (_deps && typeof _deps.now === 'function') ? _deps.now() : Date.now();
    if (_armAttempts > 0 && tNow - _lastArmTs < ARM_RETRY_INTERVAL_MS) return;
    _armAttempts++;
    _lastArmTs = tNow;
    _armAndGo();
}

/** ARM：决策下一曲 → 双方分析 → 三层策略 → 预载 B → 交叉计划登记。 */
async function _armAndGo() {
    _arming = true;
    try {
        const a = getActiveAudio();
        if (!a) { logInfo('automix.scheduler', 'ARM 跳过：无活跃音频元素（dualDeck 未初始化）'); return; }
        const cur = _normTrack(_deps.getCurrentTrack());
        if (!cur) { logInfo('automix.scheduler', 'ARM 跳过：无当前曲信息'); return; }
        const nextRaw = _deps.getNextTrack();
        const next = nextRaw ? { track: _normTrack(nextRaw.track), index: nextRaw.index } : null;
        if (!next || !next.track) {
            logInfo('automix.scheduler', 'ARM：无下一曲（队列仅一首/单曲循环），本轮跳过');
            return;
        }
        logInfo('automix.scheduler',
            `ARM 开始：A=${cur.title || '?'} → B=${next.track.title || next.index}`
            + `${(next.track.source || next.track.id) ? '（在线，需取链）' : '（本地）'}`);

        const curUrl = _deps.resolveTrackUrl(cur);
        let nextUrl = _deps.resolveTrackUrl(next.track);
        /* v2（在线源支持）：直链有时效，必须在 ARM 期即时解析——app 层注入的
           resolveOnlinePlayUrl 优先命中 175 的 nextSongPreload 预载，未命中走
           fetchPlayUrlForPreload 解析链，最后包一层流代理。解析失败/超窗 →
           放弃本轮走原生 ended（宁可放弃，不能拿过期链开交叉）。
           playlist 里的在线 track.url 常是搜索期外链或为空，一律不用。 */
        if (next.track.source || next.track.id) {
            if (typeof _deps.resolveOnlinePlayUrl !== 'function') {
                logInfo('automix.scheduler', 'ARM 放弃：下一曲是在线曲但未注入 resolveOnlinePlayUrl');
                return;
            }
            /* ★ 取链（175 预载命中 → fetchPlayUrlForPreload → 流代理包装）是纯网络
               操作，必须限时。无超时的话，ARM 期任一环节挂起会让 _arming 永远为 true，
               之后每次 timeupdate 都在第一行静默 return——automix 从此零日志瘫痪
               （与 analyzer.fetch 同类型坑，真机实测教训）。预算见
               AUTOMIX_DEFAULTS.resolveTimeoutMs，与 armLeadMs 的不变量绑定。 */
            let resolveTimedOut = false;
            nextUrl = await Promise.race([
                Promise.resolve(_deps.resolveOnlinePlayUrl(next.track)).catch(() => ''),
                new Promise((r) => setTimeout(() => { resolveTimedOut = true; r(''); }, AUTOMIX_DEFAULTS.resolveTimeoutMs)),
            ]);
            if (!nextUrl) {
                /* ★ 区分「取链超时」与「解析链明确返回空」——排查方向完全不同：
                   前者是超时预算/网络，后者是这首歌在所有渠道都没有可用直链。 */
                logInfo('automix.scheduler',
                    resolveTimedOut
                        ? `在线下一曲取链超时（${AUTOMIX_DEFAULTS.resolveTimeoutMs / 1000}s），放弃本轮 automix`
                        : '在线下一曲解析链返回空（所有渠道均未取到直链），放弃本轮 automix');
                return;
            }
        }
        /* 超时兜底：ensureAnalyzed 内部 fetch 若挂起（无响应/代理截胡），race
           到 null 让决策走 none 放弃本轮，_arming 由 finally 释放 */
        const raceTimeout = (p) => Promise.race([
            p, new Promise((r) => setTimeout(() => r(null), ANALYZE_TIMEOUT_MS)),
        ]);
        const [anA, anB] = await Promise.all([
            raceTimeout(ensureAnalyzed(cur, curUrl)),
            raceTimeout(ensureAnalyzed(next.track, nextUrl)),
        ]);
        /* ARM 途中用户已切歌 / 暂停（代际粗守卫：active 元素已不是 ARM 开始那个） */
        if (getActiveAudio() !== a || a.paused) {
            logInfo('automix.scheduler', 'ARM 放弃：分析期间切歌或暂停');
            return;
        }

        const verdict = decideCrossfade(anA, anB);
        if (verdict === 'none') {
            const why = !anA ? 'A 分析缺失' : (!anB ? 'B 分析缺失' : 'A 无有效出口点');
            logInfo('automix.scheduler',
                `决策 none（${why}），走原生播放（A[bpm=${_fmtBpm(anA)} conf=${_fmtConf(anA)} outro=${_fmtOutro(anA)}] `
                + `B[bpm=${_fmtBpm(anB)} conf=${_fmtConf(anB)}]）`);
            return;
        }

        const b = getShadowAudio();
        if (!b || !nextUrl) {
            logInfo('automix.scheduler', `ARM 放弃：影子 deck ${b ? '就绪' : '缺失'} / 下一曲 URL ${nextUrl ? '就绪' : '缺失'}`);
            return;
        }
        try {
            b.src = nextUrl;
            b.load();
        } catch (e) { logCatch('automix.scheduler', e); return; }

        /* 交叉计划：重叠时长由 A 的结构出口决定（_resolveOverlap），三层策略只
           决定「要不要变速」——beatmatch 对拍变速，breath/segue 两端都不动速率。
           不做交叉的只有 none（分析缺失 / 无处可出）。 */
        const plan = {
            overlapMs: _resolveOverlap(anA),
            rate: verdict === 'beatmatch' ? beatmatchRate(anA, anB) : 1,
            introOffsetMs: (anB && anB.introPointMs) || 0,
        };
        if (!armCrossfade(plan)) {
            logInfo('automix.scheduler', `ARM 放弃：crossfader 状态非 IDLE（当前 ${crossfaderPhase()}）`);
            return;
        }
        _armedNext = next;
        _plannedOverlapMs = plan.overlapMs;
        _swapApplied = false;
        _armShadowProbe(b);
        logInfo('automix.scheduler',
            `已 ARM：${verdict}，overlap=${Math.round(plan.overlapMs / 1000)}s，rate=${plan.rate.toFixed(3)}，`
            + `A[bpm=${_fmtBpm(anA)} conf=${_fmtConf(anA)} outro=${_fmtOutro(anA)} sparse=${_fmtSparse(anA)}]，`
            + `B=${next.track.title || next.index}`);
    } catch (e) {
        logCatch('automix.scheduler', e);
    } finally {
        _arming = false;
    }
}

/** 影子 deck canplay 一次性探针：只标记 _shadowReady，交叉开始的时机由
 *  onTimeUpdate 的时间窗决定（见 ARMED 分支注释）。 */
function _armShadowProbe(b) {
    _clearShadowProbe();
    _shadowReady = false;
    const fn = () => { _shadowReady = true; _shadowProbe = null; };
    _shadowProbe = [b, 'canplay', fn];
    try { b.addEventListener('canplay', fn, { once: true }); } catch (e) { logCatch('automix.scheduler', e); }
}

function _clearShadowProbe() {
    if (!_shadowProbe) return;
    const [el, type, fn] = _shadowProbe;
    try { el.removeEventListener(type, fn); } catch (e) { logCatch('automix.scheduler', e); }
    _shadowProbe = null;
}

/* 决策日志格式化（诊断用：一眼看出为什么落在某一层） */
function _fmtBpm(an) { return an && an.bpm != null ? an.bpm.toFixed(1) : '—'; }
function _fmtConf(an) { return an ? Number(an.bpmConfidence || 0).toFixed(2) : '—'; }
function _fmtOutro(an) { return an && an.outroPointMs > 0 ? (an.outroPointMs / 1000).toFixed(1) + 's' : '无'; }
function _fmtSparse(an) { return an && an.outroSparsePointMs > 0 ? (an.outroSparsePointMs / 1000).toFixed(1) + 's' : '无'; }

/**
 * ★ 角色顶替（交接点调用，也可由曲线收尾兜底补做）：把「当前曲」整体切到 B。
 *
 * 为什么提前到交叉过半：这是 Apple Music 的行为——视觉上已经换歌（播放栏标题、
 * 封面、背景、进度条、时长全部切到下一首），耳朵里还在交叉。它同时根治了一类
 * 老问题：等曲线走完再切，B 的 loadedmetadata/durationchange 早已在 ARM 预载期
 * 派发完毕（那时 B 还不是活跃元素、常驻监听收不到），交接瞬间只能靠手工补数据，
 * 极易出现「时长显示 00:00 / 进度条不动」的中间态；而交接点处 B 早已 canplay、
 * duration 就绪，一次写对。
 *
 * ★ 顺序要紧：先 swapRoles 把常驻监听搬到 B，再让 app 层同步元数据。旧 A 的停播
 * **不在这里**——交叉曲线还要走完，A 必须继续出声淡出，收尾时才由
 * _handleCrossfadeDone 停掉（那时它是影子 deck）。
 * @param {object} plan 交叉计划
 */
function _applySwap(plan) {
    if (_swapApplied) return;
    _swapApplied = true;
    const meta = _armedNext;
    _armedNext = null;
    swapRoles();
    invalidateCurrentAnalysis();
    try { _deps.onSwappedMeta({ plan, next: meta }); } catch (e) { logCatch('automix.scheduler', e); }
    /* 新 A 立即进入分析管线，为再下一轮交叉备料（有 IndexedDB 缓存时零成本） */
    const cur = _normTrack(_deps.getCurrentTrack());
    if (cur) notifyTrackStarted(cur, true);
}

/** 交叉曲线走完（收尾）：停掉已退役的旧 A，复位本轮状态。
 *  交接点没跑到就结束（极短交叉）时在此补做顶替，保证 UI 一定切过。 */
function _handleCrossfadeDone(info) {
    if (!_swapApplied) _applySwap(info && info.plan);
    /* swapRoles 之后旧 A 正是影子 deck。它此时已无任何常驻监听，
       停播是静默的（不会再触发 pause 处理器把播放图标刷回「已暂停」）。 */
    const retired = getShadowAudio();
    try { if (retired) { retired.pause(); retired.currentTime = 0; } } catch (e) { logCatch('automix.scheduler', e); }
    _plannedOverlapMs = 0;
    _shadowReady = false;
    _swapApplied = false;
}

/**
 * ★ 诊断快照（零副作用）：console 一次性 dump automix 全部内部状态。
 * 用法：
 *   console.table((await import('/src/core/automix/scheduler.js')).automixSnapshot())
 * 真机排查专用——能一眼区分：开关未生效 / deck 未就绪 / duration 非有限 /
 * 无下一曲 / 分析缺失 / 未进 ARM 窗口 / 已 ARM 未交叉。
 */
export function automixSnapshot() {
    const a = getActiveAudio();
    const b = getShadowAudio();
    let cur = null;
    let next = null;
    try { cur = (_deps && _deps.getCurrentTrack) ? _normTrack(_deps.getCurrentTrack()) : null; } catch { /* ignore */ }
    try {
        const n = (_deps && _deps.getNextTrack) ? _deps.getNextTrack() : null;
        next = n ? { track: _normTrack(n.track), index: n.index } : null;
    } catch { /* ignore */ }
    const finite = !!(a && Number.isFinite(a.duration) && a.duration > 0);
    let seekEnd = null;
    try { if (a && a.seekable && a.seekable.length) seekEnd = +a.seekable.end(0).toFixed(2); } catch { /* ignore */ }
    return {
        enabled: _deps ? !!_deps.isEnabled() : null,
        hasDeps: !!_deps,
        abLoopActive: _deps && _deps.isAbLoopActive ? !!_deps.isAbLoopActive() : null,
        phase: crossfaderPhase(),
        crossfadeProgress: crossfadeProgress(),
        arming: _arming,
        swapApplied: _swapApplied,
        shadowReady: _shadowReady,
        plannedOverlapMs: _plannedOverlapMs,
        currentUrl: _currentUrl ? String(_currentUrl).slice(0, 90) : null,
        memoSize: _analysisMemo.size,
        deckA: a ? a.tagName : null,
        deckB: b ? b.tagName : null,
        aSrc: a ? String(a.src).slice(0, 90) : null,
        aPaused: a ? a.paused : null,
        aDuration: a ? a.duration : null,
        aDurationFinite: finite,
        aCurrentTime: a ? +(+a.currentTime).toFixed(2) : null,
        aRemainingSec: finite ? +(a.duration - a.currentTime).toFixed(2) : null,
        aSeekableEnd: seekEnd,
        armLeadSec: AUTOMIX_DEFAULTS.armLeadMs / 1000,
        currentTrack: cur ? { title: cur.title, source: cur.source || 'local', id: cur.id || null } : null,
        nextTrack: (next && next.track)
            ? { title: next.track.title, source: next.track.source || 'local', id: next.track.id || null, index: next.index }
            : null,
    };
}

/** 测试钩子 */
export function _resetSchedulerForTest() {
    _deps = null;
    _analysisMemo = new Map();
    _currentUrl = null;
    _arming = false;
    _armedNext = null;
    _plannedOverlapMs = 0;
    _shadowReady = false;
    _swapApplied = false;
    _warnedDuration = false;
    _armUrl = null;
    _armAttempts = 0;
    _lastArmTs = 0;
    _clearShadowProbe();
}
