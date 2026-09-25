/* ============================================================
 * services/log.js — 统一观测入口（零依赖，可被任意分片安全 import）
 * 评价清单 ④：给「静默 catch」加可观测性 —— 失败不再吞掉，
 * 统一走 logWarn(tag, e)，多源降级链/播放链路排查时一眼可见。
 * 说明：源接口失效是常态（降级链设计使然），本工具只负责「留痕」，
 * 不改变业务分支 —— 调用方仍自行 return 兜底值继续降级。
 *
 * 全库约定：本文件为唯一直接 console.* 使用点；其余模块一律经
 * logInfo/logWarn/logError 输出（带模块前缀，便于按 tag 过滤）。
 * ============================================================ */

/* ============================================================
 * 有界环形缓冲 —— 让日志变成「应用内可查的观测数据」
 *
 * 为什么在 log.js 里做而不是给各链路单独加 trace 回调：多源取链的降级点散在
 * loadOnlineSong 的 19 个分支里，逐处埋 trace 要改控制流（风险大）；而这些分支
 * 本就已经 logWarn/logInfo 留痕。所以「记录一次运行走过的每一级 + 每级为什么失败」
 * 只需在这里统一收口，调用方零改动。取链详情面板与诊断页共用这一个查询口。
 *
 * 上限 400 条 / 单条正文 240 字：够覆盖一次完整取链（含重试）与一段播放期，
 * 又保证最坏情况 <200KB，不做淘汰策略（环形覆盖写入即是有界）。
 * ============================================================ */
const RING_LIMIT = 400;
const MSG_LIMIT = 240;
const ring = [];
let ringSeq = 0;

function stringifyArg(a) {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (_) { return '[unserializable]'; }
    }
    return String(a);
}

function pushRecord(level, tag, args) {
    let msg;
    try {
        msg = args.map(stringifyArg).join(' ');
    } catch (_) {
        msg = '[日志正文无法序列化]';
    }
    if (msg.length > MSG_LIMIT) msg = msg.slice(0, MSG_LIMIT) + '…';
    ring.push({ seq: ++ringSeq, ts: Date.now(), level, tag, msg });
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
}

/**
 * 读取缓冲中的日志（新→旧）。
 * @param {Object} [opts]
 * @param {string[]} [opts.tags]    只取这些 tag，如 ['trackIndexOnline','musicApi']
 * @param {number}   [opts.sinceSeq] 只取该序号之后（配合 beginResolveTrace 取「本次运行」）
 *                                   用序号而非时间戳：同一毫秒内先打的日志不会漏进来
 * @param {number}   [opts.untilSeq] 只取该序号及之前（把轨迹截在命中那一刻）
 * @param {number}   [opts.limit]   最多返回条数，默认 120
 * @returns {{seq:number,ts:number,level:string,tag:string,msg:string}[]}
 */
export function getLogs(opts = {}) {
    const { tags = null, sinceSeq = 0, untilSeq = Infinity, limit = 120 } = opts;
    const tagSet = tags && tags.length ? new Set(tags) : null;
    const out = [];
    for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
        const r = ring[i];
        if (r.seq <= sinceSeq || r.seq > untilSeq) continue;
        if (tagSet && !tagSet.has(r.tag)) continue;
        out.push(r);
    }
    return out;
}

/** 当前日志序号水位，用作「本次运行」的起点 */
export function lastLogSeq() {
    return ringSeq;
}

/** 清空缓冲（诊断页「重新开始」用） */
export function clearLogs() {
    ring.length = 0;
}

/**
 * 失败/降级留痕的统一出口。
 * @param {string} tag   模块标识，如 'musicApi' / 'lyricSource' / 'trackIndex'
 * @param {...any} args  被吞掉的异常或补充信息（错误对象尽量放最前）
 */
export function logWarn(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.warn(`[${tag}]`, ...args);
    pushRecord('warn', tag, args);
}

/**
 * 信息/调试日志统一出口（替代裸 console.log，给日志加模块前缀）。
 * @param {string} tag   模块标识
 * @param {...any} args
 */
export function logInfo(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.log(`[${tag}]`, ...args);
    pushRecord('info', tag, args);
}

/**
 * 错误日志统一出口（替代裸 console.error；catch 块内建议配合 logWarn 保留上下文）。
 * @param {string} tag   模块标识
 * @param {...any} args  错误对象尽量放最前
 */
export function logError(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.error(`[${tag}]`, ...args);
    pushRecord('error', tag, args);
}

/* ============================================================
 * logCatch — 空 catch 的统一留痕出口（评价清单 ③：静默失败可观测化）
 *
 * 为什么不是直接用 logWarn：catch 点会分布在逐帧渲染、逐词分词这类热路径里，
 * 无节流地 console.warn 会刷屏并掉帧，结果就是「要么不敢加、要么加完被要求删掉」。
 * 这里按 (tag + 错误信息) 做 5s 去重，热路径反复命中也只留一条，
 * 于是「所有 catch 都留痕」第一次变成可以无脑执行、不需要逐处判断的约定。
 * ============================================================ */
const CATCH_DEDUPE_MS = 5000;
const CATCH_SEEN = new Map();

/**
 * @param {string} tag 模块标识（与文件内既有 logInfo/logWarn 用同一个 tag）
 * @param {any} e      被吞掉的异常
 */
export function logCatch(tag, e) {
    if (typeof console === 'undefined') return;
    let key;
    try {
        key = tag + '|' + (e && e.message ? e.message : String(e));
    } catch (_) {
        key = tag + '|?';
    }
    const now = Date.now();
    const last = CATCH_SEEN.get(key);
    if (last !== undefined && now - last < CATCH_DEDUPE_MS) return;
    /* 只防无界增长，不做精细淘汰 */
    if (CATCH_SEEN.size > 300) CATCH_SEEN.clear();
    CATCH_SEEN.set(key, now);
    console.warn(`[${tag}] 已捕获异常（5s 内同类只报一次）:`, e);
    pushRecord('catch', tag, [e && e.message ? e.message : e]);
}