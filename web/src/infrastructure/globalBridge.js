/* ============================================================
 * infrastructure/globalBridge.js — globalThis 裸键 → state 的访问器桥
 *
 * 要解决的问题（scripts/audits/state-split-scan.mjs 的结论）：
 * 同一份状态存在两个名字——分片写 `globalThis.volume = x`（或裸 `volume = x`），
 * core/* 模块读 `state.volume`，两者是互不相干的存储。结果是 core 层一旦被接线，
 * 读到的永远是 state.js 里的初始值，且不会有任何报错。
 *
 * 本模块把「谁是权威」这件事一次性定死：state 是唯一存储，globalThis 上的同名键
 * 降级为读写视图。分片一行不用改（裸标识符经作用域链落到 globalThis 的属性，
 * 属性再转发进 state），而 state.xxx 与 globalThis.xxx 从此不可能分歧。
 *
 * 为什么方向是「globalThis 变视图」而不是反过来：终局是分片改成 import 模块导出、
 * 全局面逐步缩小。若 state 只是 globalThis 的视图，将来删全局还得把 59 个键
 * 重新写回数据属性；现在这个方向，删除时只需把桥接列表缩短。
 *
 * 安全性前置扫描（2026-09-25，见 scripts/audits/accessor-safety-scan.mjs）：
 *   delete globalThis.K           0 处  —— accessor 被 delete 后裸读会抛 ReferenceError
 *   html 里 var/function K 撞名    0 处  —— 全局 var 声明不会重置 configurable accessor
 *   typeof K === 'undefined' 探测 27 处，但全部落在 boot 已赋值的键上（探测本就恒真），
 *                                    0 处会因桥接翻转
 *   window.K = ...                 8 处  —— 同一属性，走 setter，语义不变
 *
 * 长期计划：core 层逐模块接管完成后，BRIDGED 列表应随之缩短；全部缩到 0 时删除本文件。
 * ============================================================ */
import { state } from './state.js';
import { logWarn } from '../services/log.js';

/* 桥接作用面 = state 与 globalThis 的重叠键（由 scripts/audits/state-split-scan.mjs 生成）。
 * 只减不增：新增共享状态请走「所属模块 export + 使用方 import」，不要往这里加。 */
export const BRIDGED = [
    'isPlaying', 'currentTime', 'volume', 'playMode', 'currentPlaybackRate', 'preservesPitch',
    'lyrics', 'activeLineIndex', 'lineElements', 'wordElementsByLine', 'wordHighlightElementsByLine',
    'lastWordProgress', 'isUserScrolling', 'currentScrollY', 'scrollTimeout', 'lyricsRafId',
    'isLyricsLoopRunning', 'playlist', 'currentTrackIndex', 'isLoadingSong', 'playbackGeneration',
    'retryCount', 'lastLoadedSongInfo', 'currentSongKey', 'currentSongData', 'currentSource',
    'searchResultsCache', 'lastSearchKeyword', 'currentAiTheme', 'aiEmotionWords', 'isAiAnalyzing',
    'currentAiAbortController', 'audioCtx', 'eqSourceNode', 'eqFilterNodes', 'eqGains',
    'eqActivePreset', 'eqInited', 'eqInitFailed', 'stallTimer', 'isBuffering', 'stallLastTime',
    'stallCheckGeneration', 'lastPercent', 'lastFormattedTime', 'ctxSubmenuEl', 'ctxConfirmCallback',
    'submenuHideTimer', 'initSongStarted', 'preloadedSongReady', 'pendingPlayAfterPreload',
    'playlistViewMode', 'currentPlaylistId', 'customFonts', 'appSettings',
];

/**
 * 安装访问器桥。必须在任何分片读写这些键之前调用（10-config-state.js 模块体最前面）。
 * @param {string[]} [keys]
 * @returns {{bridged: number, skipped: number}}
 */
export function bridgeGlobalsToState(keys = BRIDGED) {
    let bridged = 0;
    let skipped = 0;
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(state, key)) {
            /* state 里没有这个键 = 列表过期（键已被删或改名），不能凭空造一个 undefined 存储 */
            logWarn('globalBridge', `跳过过期键 ${key}：infrastructure/state.js 中不存在`);
            skipped++;
            continue;
        }
        const desc = Object.getOwnPropertyDescriptor(globalThis, key);
        if (desc && !desc.configurable) {
            logWarn('globalBridge', `跳过 ${key}：globalThis 上该属性不可配置`);
            skipped++;
            continue;
        }
        const isAccessor = !!(desc && (desc.get || desc.set));
        if (desc && !isAccessor && globalThis[key] !== undefined) {
            /* 用已有值播种，避免桥接前就写进去的初值被 state 的默认值盖掉 */
            state[key] = globalThis[key];
        }
        Object.defineProperty(globalThis, key, {
            configurable: true,
            enumerable: true,
            get: () => state[key],
            set: (value) => { state[key] = value; },
        });
        bridged++;
    }
    return { bridged, skipped };
}

/** 供 DevTools / 审计确认某个键是否已桥接（而不是仍有独立存储） */
export function isBridged(key) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    return !!(desc && desc.get && desc.set);
}
