/* ============================================================
 * core/nativeBridge.js — 原生音频引擎的 IPC 通道（原生输出线 Phase 2b）
 *
 * 一句话：把「Tauri 命令名 + 参数」收口成一个带超时与可用性探测的 invoke。
 *
 * 为什么不能直接 `window.__TAURI__.core.invoke(...)`：
 *  1. **注入时机不定。** `__TAURI__` 由外壳在文档早期注入，但远程 URL
 *     （本项目的窗口就是 `http://localhost:8001/index.html`）下它可能晚于
 *     模块求值。所有解析必须**推迟到调用那一刻**——模块顶层 const 抓一次
 *     引用，早晚会在慢机器上变成 undefined（250-desktop-lyrics 已经踩过）。
 *  2. **必须有超时。** 独占模式体检要真开一次设备（`native_audio_check_exclusive`
 *     最长约 600ms），而设备被别的进程占住时可能更久。没有超时的话设置面板
 *     会永远停在「检测中」，用户只能重启。
 *  3. **可用性要说准。** 「不是桌面壳」和「是桌面壳但这个命令被 ACL 拦了」
 *     是两回事，前者静默隐藏 UI，后者要给人看原因。probe 把两者分开返回。
 *
 * 层级纪律：core 层不 import app/ 分片，也不做翻译（文案在 app/298）。
 * ============================================================ */
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'nativeBridge';

/** 命令名与 src-tauri/src/lib.rs 的 generate_handler! 一一对应，改一边必须改另一边 */
export const CMD = {
    STATUS: 'native_audio_status',
    DEVICES: 'native_audio_devices',
    CHECK_EXCLUSIVE: 'native_audio_check_exclusive',
    LOAD: 'native_audio_load',
    PLAY: 'native_audio_play',
    PAUSE: 'native_audio_pause',
    SEEK: 'native_audio_seek',
    SET_VOLUME: 'native_audio_set_volume',
    SET_EQ: 'native_audio_set_eq',
    SET_SPATIAL: 'native_audio_set_spatial',
    SET_RATE: 'native_audio_set_rate',
    SET_OUTPUT: 'native_audio_set_output',
    RELEASE_OUTPUT: 'native_audio_release_output',
    SNAPSHOT: 'native_audio_snapshot',
};

/** 一般命令超时：IPC 本身是本地消息往返，超过这个数说明对方卡住了 */
const CALL_TIMEOUT_MS = 4000;
/** 独占体检超时：引擎侧等端点消费的预算上限是 600ms，留三倍余量 */
const CHECK_TIMEOUT_MS = 3000;

/** 不可用原因（probe 结果，供 UI 区分「没壳」与「被 ACL 拦」） */
export const UNAVAILABLE = {
    NO_SHELL: 'no-shell',
    NO_COMMAND: 'no-command',
    ERROR: 'error',
};

/**
 * 「没外壳」时的重试参数。
 *
 * 外壳是 init script，理论上先于页面脚本执行；但本窗口的 URL 是远程的
 * （`http://localhost:8001/index.html`），注入与远程文档就绪之间存在竞态，
 * 慢机器上出现过晚到的情况。既然「没外壳」的结论只用来隐藏一行设置，
 * 多等 300ms 换来「不会因为抢跑而永久隐藏功能」是划算的。
 * 测试把它调成 attempts=1 即可免掉这段等待。
 */
export const SHELL_PROBE_RETRY = { attempts: 2, delayMs: 300 };

let _probe = null;          /* Promise<{available, reason, detail}> | null —— 缓存 */
let _coreRef = null;        /* 上次成功解析到的 core 对象 */
let _warnedMissing = false; /* 「没壳」只提示一次，避免网页版每次轮询都刷屏 */

/**
 * 解析 Tauri 的 core 对象。**每次都重新解析**（见文件头 1），
 * 但解析成功后会缓存引用，避免高频轮询反复穿透 window。
 * @returns {{invoke?:Function}|null}
 */
function resolveCore() {
    if (_coreRef && typeof _coreRef.invoke === 'function') return _coreRef;
    try {
        const t = typeof window !== 'undefined' ? window.__TAURI__ : null;
        const core = t && t.core ? t.core : null;
        if (core && typeof core.invoke === 'function') {
            _coreRef = core;
            return core;
        }
    } catch (e) {
        logCatch(TAG, e);
    }
    return null;
}

/**
 * 调用一条原生命令。
 * @param {string} cmd
 * @param {object} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 * @throws {Error} 无外壳 / 超时 / 后端 Err（错误消息原文保留，含设备的真实原因）
 */
export async function call(cmd, args, timeoutMs) {
    const core = resolveCore();
    if (!core) throw new Error(UNAVAILABLE.NO_SHELL);
    const budget = timeoutMs || CALL_TIMEOUT_MS;
    /* 超时用 race 而不是 AbortSignal：Tauri 的 invoke 不吃 signal，
       这里只是保证**调用方**不会被永久挂住（底层命令仍在跑完，它自己的
       状态最终会被下一次 snapshot 看见）。 */
    let timer = null;
    try {
        return await Promise.race([
            core.invoke(cmd, args || {}),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`native call timeout: ${cmd}`)), budget);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 探测原生引擎链路是否可用（结果缓存，同一次会话只问一次）。
 * 不缓存失败：网页版第一次探测失败后可能用户装了桌面壳再刷新，
 * 但刷新即重载模块——所以缓存本身没问题。
 * @returns {Promise<{available:boolean, reason?:string, mode?:string, sampleFormat?:string, detail?:string}>}
 */
export function probe() {
    if (_probe) return _probe;
    _probe = (async () => {
        for (let attempt = 0; attempt < SHELL_PROBE_RETRY.attempts; attempt += 1) {
            if (resolveCore()) break;
            if (attempt + 1 < SHELL_PROBE_RETRY.attempts) {
                await new Promise((r) => setTimeout(r, SHELL_PROBE_RETRY.delayMs));
            }
        }
        if (!resolveCore()) {
            if (!_warnedMissing) {
                _warnedMissing = true;
                logInfo(TAG, 'no Tauri shell, native output stays hidden');
            }
            return { available: false, reason: UNAVAILABLE.NO_SHELL };
        }
        try {
            const st = await call(CMD.STATUS, {}, 2500);
            if (st && st.available) {
                return {
                    available: true,
                    mode: st.mode,
                    sampleFormat: st.sampleFormat,
                };
            }
            /* 外壳在、命令也在，但引擎起不来：reason 是引擎给的原文 */
            return {
                available: false,
                reason: UNAVAILABLE.ERROR,
                detail: (st && st.reason) || '',
            };
        } catch (e) {
            /* ACL 未放行时 Tauri 会 reject 一个 "not allowed" 类错误。
               与「没壳」区分开：前者是配置问题，值得写进日志。 */
            logWarn(TAG, 'native_audio_status failed:', String(e && e.message || e));
            return {
                available: false,
                reason: UNAVAILABLE.NO_COMMAND,
                detail: String((e && e.message) || e || ''),
            };
        }
    })();
    return _probe;
}

/** 测试钩子：清掉探测缓存与引用（生产代码勿调） */
export function _resetNativeBridgeForTest() {
    _probe = null;
    _coreRef = null;
    _warnedMissing = false;
}

/* ============================ 命令包装 ============================ */
/* 全部薄封装：只加参数名映射与默认值，不加业务判断（判断在 app/298）。 */

export const status = () => call(CMD.STATUS);
export const devices = () => call(CMD.DEVICES);

/**
 * 独占模式端到端体检。**会短暂独占设备**，所以只在用户显式点开关时调用。
 * @param {string|null} deviceId 空 = 系统默认
 * @param {number} sampleRate 0 = 后端按 44.1k 取默认
 */
export const checkExclusive = (deviceId, sampleRate) =>
    call(CMD.CHECK_EXCLUSIVE, { deviceId: deviceId || null, sampleRate: sampleRate || 0 }, CHECK_TIMEOUT_MS);

/** 加载一首。发完即返回（加载结果由 20Hz snapshot 发现，见 native_audio.rs 文件头） */
export const load = (src, autoplay) => call(CMD.LOAD, { src, autoplay: !!autoplay });
export const play = () => call(CMD.PLAY);
export const pause = () => call(CMD.PAUSE);
export const seek = (sec) => call(CMD.SEEK, { sec });
export const setVolume = (gain) => call(CMD.SET_VOLUME, { volume: gain });
export const setEq = (enabled, gainsDb) => call(CMD.SET_EQ, { eq: { enabled: !!enabled, gainsDb } });

/**
 * 空间处理设置下发（空间音频 HRTF + 虚拟声场）。
 * ★ 参数名与 Rust 侧 `SpatialDto` 的 camelCase 严格对齐（serde rename_all）。
 * ★ 档位传**字符串**而非索引：索引是引擎内部表示，暴露到 IPC 等于把「表顺序」
 *   变成跨语言契约，将来在表中间插一档会静默错位（Rust 侧 index_of 负责翻译）。
 * @param {{spatialEnabled:boolean, spatialLevel:string, ir:string,
 *          stageEnabled:boolean, stageLevel:string}} s
 */
export const setSpatial = (s) => call(CMD.SET_SPATIAL, {
    spatial: {
        spatialEnabled: !!s.spatialEnabled,
        spatialLevel: String(s.spatialLevel || 'light'),
        ir: String(s.ir || 'near'),
        stageEnabled: !!s.stageEnabled,
        stageLevel: String(s.stageLevel || 'light'),
    },
});
export const setOutput = (deviceId, exclusive) =>
    call(CMD.SET_OUTPUT, { output: { deviceId: deviceId || null, exclusive: !!exclusive } });

/**
 * 播放速率下发（变速 / 练习模式）。
 * ★ 参数是**裸 f64**，不带对象包装 —— 与 Rust 侧 `native_audio_set_rate(rate: f64)` 对齐。
 * ★ 为什么必须下发：独占路径的音频是 **Rust 自己解码**的，`<audio>.playbackRate`
 *   根本到不了那里；不下发就等于"独占模式下变速完全没反应"。
 * ★ 非有限值在 Rust 侧会被夹掉（那里再挡一次），这里只做防御性过滤。
 * @param {number} rate
 */
export const setRate = (rate) => {
    const r = Number(rate);
    return call(CMD.SET_RATE, { rate: Number.isFinite(r) ? r : 1 });
};

/**
 * 交还输出设备。关掉原生输出时必须调——引擎不交还的话，端点一直被占着，
 * 下一次打开独占会撞 AUDCLNT_E_DEVICE_IN_USE（见 engine.rs release_output 注释）。
 */
export const releaseOutput = () => call(CMD.RELEASE_OUTPUT);
export const snapshot = () => call(CMD.SNAPSHOT);
