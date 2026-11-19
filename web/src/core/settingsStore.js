/**
 * core/settingsStore.js — 统一设置状态读写、路径访问与字体键归一化
 *
 * 目标：
 * 1. 消除 190-settings-fontsize.js 与 202-settings-appearance.js 之间的键值双向映射碎片；
 * 2. 统一修复 202 reverseFontMap 仅覆盖部分内置字体的历史缺陷；
 * 3. 提供纯函数化的路径读写与模式值存取，便于脱离 DOM 单测。
 */
import { state } from '../infrastructure/state.js';
import { SETTINGS_STORAGE_KEY, VOLUME_STORAGE_KEY, VOLUME_TS_STORAGE_KEY } from '../config/constants.js';
import { DEFAULT_SETTINGS, playerConfig } from '../config/defaults.js';
import { logCatch } from '../services/log.js';

export const BUILTIN_FONT_FAMILY_MAP = {
    default: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    serif: "'SimSun', 'Songti SC', 'STSong', serif",
    kai: "'KaiTi', 'STKaiti', '楷体', serif",
    hei: "'SimHei', 'Microsoft YaHei', 'STHeiti', '黑体', sans-serif",
    fangsong: "'FangSong', 'STFangsong', '仿宋', serif",
    mono: "'Consolas', 'Courier New', 'Microsoft YaHei', monospace",
};

const _FONT_STACK_TO_KEY = new Map([
    ['', 'default'],
    ['inherit', 'default'],
    ['default', 'default'],
    ['monospace', 'mono'],
    ["'microsoft yahei', sans-serif", 'default'],
]);
for (const [key, stack] of Object.entries(BUILTIN_FONT_FAMILY_MAP)) {
    _FONT_STACK_TO_KEY.set(key, key);
    _FONT_STACK_TO_KEY.set(stack.toLowerCase(), key);
    _FONT_STACK_TO_KEY.set(stack.replace(/\s+/g, ' ').trim().toLowerCase(), key);
}

/**
 * 将历史 CSS 字体栈、inherit 或短键统一归一化为内置/自定义字体键。
 * 保留 custom_* 等自定义字体键不变。
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function normalizeFontKey(raw) {
    if (raw == null) return 'default';
    const trimmed = String(raw).trim();
    if (!trimmed) return 'default';
    if (Object.prototype.hasOwnProperty.call(BUILTIN_FONT_FAMILY_MAP, trimmed)) {
        return trimmed;
    }
    if (trimmed.startsWith('custom_')) return trimmed;
    const lower = trimmed.replace(/\s+/g, ' ').toLowerCase();
    if (_FONT_STACK_TO_KEY.has(lower)) {
        return _FONT_STACK_TO_KEY.get(lower) || trimmed;
    }
    return trimmed;
}

/** 点分路径到 appSettings 字段映射（扁平 setting key -> 嵌套路径） */
export const SETTING_PATH_MAP = {
    defaultPlayMode: { path: 'playback.defaultPlayMode', fallback: 'sequence' },
    defaultRate: { path: 'playback.defaultRate', fallback: '1', asString: true },
    defaultEqPreset: { path: 'audio.defaultEqPreset', fallback: 'default' },
    fontFamily: { path: 'interface.fontFamily', fallback: 'default' },
    aiProvider: { path: 'ai.provider', fallback: 'openai' },
    qqPlaybackQuality: { path: 'quality.qqPlayback', fallback: '320' },
    qqDownloadQuality: { path: 'quality.qqDownload', fallback: 'flac' },
    neteasePlaybackQuality: { path: 'quality.neteasePlayback', fallback: 'exhigh' },
    neteaseDownloadQuality: { path: 'quality.neteaseDownload', fallback: 'lossless' },
    kugouPlaybackQuality: { path: 'quality.kugouPlayback', fallback: '320' },
    kugouDownloadQuality: { path: 'quality.kugouDownload', fallback: 'flac' },
    mvUpscaleTier: { path: 'background.mvUpscaleTier', fallback: 'S' },
};

/**
 * 读取点分路径的值（如 'playback.defaultPlayMode'）。
 * @param {Record<string, any>|null|undefined} obj
 * @param {string} path
 * @param {*} [fallback]
 * @returns {*}
 */
export function getByPath(obj, path, fallback) {
    if (!obj || !path) return fallback;
    const parts = path.split('.');
    let cur = obj;
    for (const k of parts) {
        if (cur == null || typeof cur !== 'object') return fallback;
        cur = cur[k];
    }
    return cur !== undefined ? cur : fallback;
}

/**
 * 写入点分路径的值，沿途缺省节点自动创建普通对象。
 * @param {Record<string, any>} obj
 * @param {string} path
 * @param {*} value
 * @returns {boolean} 是否实际写入
 */
export function setByPath(obj, path, value) {
    if (!obj || !path) return false;
    const parts = path.split('.');
    const last = parts[parts.length - 1];
    if (!last) return false;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (!k) continue;
        if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
    }
    cur[last] = value;
    return true;
}

/**
 * 读取指定扁平 setting key 的当前值；无对应路径时返回 ''。
 * @param {string} key
 * @param {Record<string, any>|null} [settings]
 * @returns {string}
 */
export function readFlatSettingValue(key, settings = state.appSettings) {
    if (!settings) return '';
    const pathMap = /** @type {Record<string, { path: string, fallback: string, asString?: boolean }>} */ (SETTING_PATH_MAP);
    const spec = pathMap[key];
    if (!spec) return '';
    const v = getByPath(settings, spec.path, spec.fallback);
    if (v === undefined || v === null) return spec.fallback ?? '';
    return spec.asString ? String(v) : String(v);
}

/**
 * 写入指定扁平 setting key 到设置对象（不负责副作用与持久化）。
 * @param {string} key
 * @param {*} value
 * @param {Record<string, any>|null} [settings]
 * @returns {boolean}
 */
export function writeFlatSettingValue(key, value, settings = state.appSettings) {
    if (!settings) return false;
    const pathMap = /** @type {Record<string, { path: string, fallback: string, asString?: boolean }>} */ (SETTING_PATH_MAP);
    const spec = pathMap[key];
    if (!spec) return false;
    let next = value;
    if (key === 'defaultRate') next = parseFloat(value) || 1;
    else if (key === 'fontFamily') next = normalizeFontKey(value);
    return setByPath(settings, spec.path, next);
}

/**
 * 读取指定视觉模式的独立参数值（缺省回落 DEFAULT_SETTINGS.modeSettings）。
 * @param {string} mode
 * @param {string} key
 * @param {*} [fallback]
 * @param {Record<string, any>|null} [settings]
 * @returns {*}
 */
export function getModeSetting(mode, key, fallback, settings = state.appSettings) {
    const ms = settings?.modeSettings?.[mode];
    if (ms && ms[key] !== undefined) return ms[key];
    const modeDefaults = /** @type {Record<string, Record<string, any>>} */ (DEFAULT_SETTINGS.modeSettings || {});
    const def = modeDefaults[mode];
    if (def && def[key] !== undefined) return def[key];
    return fallback;
}

/**
 * 写入指定视觉模式的独立参数值。
 * @param {string} mode
 * @param {string} key
 * @param {*} value
 * @param {Record<string, any>|null} [settings]
 * @returns {boolean}
 */
export function setModeSetting(mode, key, value, settings = state.appSettings) {
    if (!settings || !mode || !key) return false;
    if (!settings.modeSettings || typeof settings.modeSettings !== 'object') {
        settings.modeSettings = {};
    }
    if (!settings.modeSettings[mode] || typeof settings.modeSettings[mode] !== 'object') {
        settings.modeSettings[mode] = {};
    }
    settings.modeSettings[mode][key] = value;
    return true;
}

/**
 * 读取持久化的上次关闭音量（0..100，支持精确 0 与旧配置迁移）。
 * @param {number} [fallback]
 * @returns {number}
 */
export function readSavedVolume(fallback = playerConfig.defaultVolume ?? 80) {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
            if (raw !== null && raw !== '') {
                const n = Number(raw);
                if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
            }
            const rawSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (rawSettings) {
                const parsed = JSON.parse(rawSettings);
                const legacy = parsed && parsed.playback && (parsed.playback.lastVolume ?? parsed.playback.initialVolume);
                if (legacy !== undefined && legacy !== null && legacy !== '') {
                    const n = Number(legacy);
                    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
                }
            }
        }
    } catch (e) {
        logCatch('configState', e);
    }
    return fallback;
}

/**
 * 持久化当前音量（0..100 整数）及修改时间戳。
 * @param {*} vol
 * @returns {number|undefined}
 */
export function writeSavedVolume(vol) {
    const n = Number(vol);
    if (!Number.isFinite(n)) return undefined;
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
            localStorage.setItem(VOLUME_TS_STORAGE_KEY, String(Date.now()));
        }
    } catch (e) {
        logCatch('configState', e);
    }
    return clamped;
}
