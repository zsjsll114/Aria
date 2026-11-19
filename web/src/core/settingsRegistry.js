/* ============================================================
 * core/settingsRegistry.js — 设置面板声明式扩展注册表
 *
 * 替代各扩展分片（250/282/289/290/292/309）各自挂 MutationObserver
 * 监听 #settingsOverlay / #settingsBody 并手动往 DOM 塞节点的做法：
 * - registerSettingsGroup(tab, def): 向指定 tab 声明一个追加组（render + onMount + onShow）
 * - registerSettingsHook(tab, def):  在已有静态/Schema DOM 就位后执行绑定（onMount + onShow）
 *
 * 约定：同 tab 内按 order 升序渲染/执行；同 id 重复注册幂等覆盖，确保热重载/测试可重复调用。
 * ============================================================ */

/** @typedef {{ id: string, order?: number, searchText?: string, render?: (host: HTMLElement, secEl?: HTMLElement) => HTMLElement|string|void, onMount?: (host: HTMLElement) => void, onShow?: (host: HTMLElement) => void }} SettingsGroupDef */
/** @typedef {{ id: string, order?: number, onMount?: (host: HTMLElement) => void, onShow?: (host: HTMLElement) => void }} SettingsHookDef */

/** @type {Map<string, Map<string, SettingsGroupDef>>} */
const _groupsByTab = new Map();
/** @type {Map<string, Map<string, SettingsHookDef>>} */
const _hooksByTab = new Map();

/**
 * @param {Map<string, Map<string, any>>} store
 * @param {string} tab
 * @param {any} def
 * @returns {boolean}
 */
function upsertEntry(store, tab, def) {
    if (!tab || !def || !def.id) return false;
    let bucket = store.get(tab);
    if (!bucket) {
        bucket = new Map();
        store.set(tab, bucket);
    }
    bucket.set(def.id, { ...def, order: typeof def.order === 'number' ? def.order : 100 });
    return true;
}

/**
 * @param {Map<string, Map<string, any>>} store
 * @param {string} tab
 * @returns {any[]}
 */
function listEntries(store, tab) {
    const bucket = store.get(tab);
    if (!bucket) return [];
    return Array.from(bucket.values()).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/**
 * 向指定设置页签注册声明式扩展分组。
 * @param {string} tab
 * @param {SettingsGroupDef} def
 */
export function registerSettingsGroup(tab, def) {
    return upsertEntry(_groupsByTab, tab, def);
}

/**
 * 向指定设置页签注册生命周期钩子（无新增组 DOM 时使用，如按钮绑定或懒刷新）。
 * @param {string} tab
 * @param {SettingsHookDef} def
 */
export function registerSettingsHook(tab, def) {
    return upsertEntry(_hooksByTab, tab, def);
}

/**
 * 读取某个设置页签已注册的全部扩展分组（按 order 排序）。
 * @param {string} tab
 * @returns {SettingsGroupDef[]}
 */
export function getGroupsForTab(tab) {
    return listEntries(_groupsByTab, tab);
}

/**
 * 读取某个设置页签已注册的全部生命周期钩子（按 order 排序）。
 * @param {string} tab
 * @returns {SettingsHookDef[]}
 */
export function getHooksForTab(tab) {
    return listEntries(_hooksByTab, tab);
}

/**
 * 列出所有已注册分组的 tab 名称。
 * @returns {string[]}
 */
export function listRegisteredTabs() {
    const tabs = new Set([..._groupsByTab.keys(), ..._hooksByTab.keys()]);
    return Array.from(tabs);
}

/** 仅供单元测试隔离状态使用 */
export function clearSettingsRegistryForTest() {
    _groupsByTab.clear();
    _hooksByTab.clear();
}
