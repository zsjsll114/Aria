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

/**
 * 失败/降级留痕的统一出口。
 * @param {string} tag   模块标识，如 'musicApi' / 'lyricSource' / 'trackIndex'
 * @param {...any} args  被吞掉的异常或补充信息（错误对象尽量放最前）
 */
export function logWarn(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.warn(`[${tag}]`, ...args);
}

/**
 * 信息/调试日志统一出口（替代裸 console.log，给日志加模块前缀）。
 * @param {string} tag   模块标识
 * @param {...any} args
 */
export function logInfo(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.log(`[${tag}]`, ...args);
}

/**
 * 错误日志统一出口（替代裸 console.error；catch 块内建议配合 logWarn 保留上下文）。
 * @param {string} tag   模块标识
 * @param {...any} args  错误对象尽量放最前
 */
export function logError(tag, ...args) {
    if (typeof console === 'undefined') return;
    console.error(`[${tag}]`, ...args);
}