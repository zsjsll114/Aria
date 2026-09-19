/* ============================================================
 * core/globalRegistry.js — 全局状态注册中心（P1 全局状态收敛）
 *
 * 背景：全库沿用「globalThis.x = ... 建立状态，裸标识符跨分片读写」的
 * 浏览器全局 env 协议（10-config-state.js 注册 76 键，另有 26 文件散布
 * 100+ 处赋值）。历史问题是：键的权威清单、owner、写入者无记录，
 * 改键名/顺序只会静默失效（不报错）。
 *
 * 本模块只做「登记 + 审计」，不改变赋值行为：
 *   - registerGlobal(key, meta)   登记键（owner / type / desc / multiWrite）
 *   - assignGlobal(key, value)    赋值并记录写入者（可选替代裸赋值）
 *   - auditGlobals()              启动时校验：未定义/类型不符/多处写入 → 日志
 * 调用方继续裸读写 globalThis[key] 完全兼容（本模块不替换任何既有赋值）。
 * ============================================================ */
import { logInfo, logWarn, logError } from '../services/log.js';

const registry = new Map(); // key -> { owner, type, desc, writers: [file...] }

/**
 * 登记一个全局键（不赋值）。
 * @param {string} key
 * @param {{owner?: string, type?: string, desc?: string, multiWrite?: boolean}} meta
 */
export function registerGlobal(key, meta = {}) {
    const prev = registry.get(key);
    const rec = {
        owner: meta.owner || prev?.owner || 'unknown',
        type: meta.type || prev?.type || 'autodetect',
        desc: meta.desc || prev?.desc || '',
        writers: prev ? prev.writers : [],
        multiWrite: prev ? prev.multiWrite : !!meta.multiWrite,
    };
    registry.set(key, rec);
    // 惰性类型修正：留到 auditGlobals 用实际值校准
    return rec;
}

/**
 * 经注册中心赋值（可选路径）。等价 globalThis[key] = value，
 * 仅额外记录写入文件，供 audit 检测多处写入冲突。
 * @param {string} key
 * @param {*} value
 */
export function assignGlobal(key, value) {
    const rec = registry.get(key);
    if (rec) {
        try {
            const caller = new Error().stack.split('\n')[2] || '';
            const file = /([\w-]+\.js)/.exec(caller)?.[1] || 'unknown';
            if (!rec.writers.includes(file)) {
                rec.writers.push(file);
                if (rec.multiWrite && rec.writers.length > 1) {
                    logWarn('globalRegistry', `多写键 ${key} 由 ${rec.writers.join(' ← ')} 写入`);
                }
            }
        } catch (e) { /* 堆栈不可用时跳过记录 */ }
    }
    globalThis[key] = value;
    return value;
}

/**
 * 启动期审计：遍历登记键，校验 globalThis 上实际状态。
 * 只打日志，不抛错、不修改状态 —— 收敛改键的「安全网」。
 * @param {{strict?: boolean}} [opts]
 */
export function auditGlobals({ strict = false } = {}) {
    let missing = 0;
    let typeMismatch = 0;
    let multiWrite = 0;
    for (const [key, rec] of registry) {
        const v = globalThis[key];
        if (v === undefined) {
            missing++;
            const msg = `[globalRegistry] 未定义键 ${key} (owner=${rec.owner})`;
            if (strict) logError('globalRegistry', msg);
            else logWarn('globalRegistry', msg);
            continue;
        }
        if (rec.type && rec.type !== 'autodetect') {
            const actual = Array.isArray(v) ? 'array' : typeof v;
            if (actual !== rec.type) {
                typeMismatch++;
                logWarn('globalRegistry', `键 ${key} 类型漂移：声明 ${rec.type}，实际 ${actual}（owner=${rec.owner}）`);
            }
        }
        if (rec.multiWrite || rec.writers.length > 1) {
            multiWrite++;
            // 声明多写（10-config-state 登记的跨分片共享键）或运行期实测多写
            logInfo('globalRegistry', `多写键 ${key}: ${rec.writers.length > 0 ? rec.writers.join(' ← ') : '(声明多写,初始未实测)'}`);
        }
    }
    logInfo('globalRegistry',
        `全局状态审计完成：登记 ${registry.size} 键 | 未定义 ${missing} | 类型漂移 ${typeMismatch} | 多写 ${multiWrite}`);
    return { total: registry.size, missing, typeMismatch, multiWrite };
}

/** 返回注册表快照（DevTools / 调试） */
export function listGlobals() {
    const out = {};
    for (const [key, rec] of registry) {
        out[key] = {
            owner: rec.owner,
            type: rec.type === 'autodetect' ? typeof globalThis[key] : rec.type,
            writers: rec.writers,
            defined: globalThis[key] !== undefined,
        };
    }
    return out;
}