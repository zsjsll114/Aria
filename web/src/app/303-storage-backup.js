/* ============================================================
 * app/303-storage-backup.js — 存储空间管理（需求 13）+ 自动备份（需求 23）
 *
 * 与 200-settings-panel 的分工：本分片是独立接入层（自带 DOM 装配），
 * 因为它要做的事跨越「低频交互 + 定时任务」，塞进 200 那样的大分片只会更难维护。
 *
 * ★★ 两条不可退让的安全约束（需求 13 原文）：
 *   · **绝不删用户歌单 / 收藏 / 播放记录** —— 由 core/storageManager 的 kind 分类保证，
 *     清理目标只从 cache / high 里选（有单测钉死）。
 *   · **高价值数据清理必须二次确认** —— AI 分析 / 逐字对齐 / 高潮检测都走 confirm。
 *
 * ★ 目录句柄（File System Access）在 WebView2 上不一定可用：全部 try/catch，
 *   不可用就降级为「下载到浏览器默认位置」，且自动备份自动关掉（不能静默什么都不做）。
 * ============================================================ */
import { FAV_STORAGE_KEY, PLAYLIST_STORAGE_KEY, EQ_STORAGE_KEY, SETTINGS_STORAGE_KEY } from '../config/constants.js';
import {
    IDB_TARGETS, LS_GROUPS, STORAGE_LIMIT_DEFAULT, STORAGE_LIMIT_KEY,
    classifyLocalStorage, formatBytes, pickAutoPruneTargets, pruneWarning,
} from '../core/storageManager.js';
import { backupFilename, buildBackup, describeBackup, validateBackup } from '../core/backupService.js';
import { downloadJSON, importData } from './220-shortcuts-viewmode.js';
import { saveSettings } from './180-boot-config.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'storage';
const HANDLE_DB = 'aria_backup';
const HANDLE_STORE = 'kv';
const HANDLE_KEY = 'dir';
const KEEP_BACKUPS = 10;
const AUTO_CHECK_MS = 60 * 1000;

let _dirHandle = null;      /* FileSystemDirectoryHandle | null */
let _dirUnsupported = false;
let _lastUsage = null;

/* ============================ 工具 ============================ */

const g = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** 打开已存在的库（不带版本 ⇒ 不动 schema）。库不存在返回 null。 */
function openExistingDb(name) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(name); } catch { resolve(null); return; }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        /* 库不存在时 open 会创建空库（版本 1）——这是可接受的副作用（无 store、几乎不占空间） */
        req.onupgradeneeded = () => { /* 不建任何 store */ };
    });
}

async function countStore(dbName, storeName) {
    const db = await openExistingDb(dbName);
    if (!db) return -1;
    try {
        if (!db.objectStoreNames.contains(storeName)) return -1;
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        const n = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        db.close();
        return n;
    } catch (e) { try { db.close(); } catch { /* 已关 */ } logCatch(TAG, e); return -1; }
}

/** 删掉某个 store 里**最旧的** max(1, count/2) 条（游标按插入序），返回删除条数 */
async function pruneOldest(dbName, storeName) {
    const db = await openExistingDb(dbName);
    if (!db) return 0;
    try {
        if (!db.objectStoreNames.contains(storeName)) return 0;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const total = await new Promise((res, rej) => { const r = store.count(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const target = Math.max(1, Math.ceil(total / 2));
        let removed = 0;
        await new Promise((res, rej) => {
            const cur = store.openCursor();
            cur.onsuccess = () => {
                const c = cur.result;
                if (!c || removed >= target) { res(); return; }
                c.delete();
                removed++;
                c.continue();
            };
            cur.onerror = () => rej(cur.error);
        });
        await txDone(tx);
        db.close();
        return removed;
    } catch (e) { try { db.close(); } catch { /* 已关 */ } logCatch(TAG, e); return 0; }
}

function lsEntries() {
    const out = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k == null) continue;
            const v = localStorage.getItem(k) || '';
            /* UTF-16：每字符 2 字节（Chrome 的实际计量口径） */
            out.push({ key: k, bytes: (k.length + v.length) * 2 });
        }
    } catch (e) { logCatch(TAG, e); }
    return out;
}

/* ============================ 扫描与渲染 ============================ */

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

async function scanUsage() {
    const ls = classifyLocalStorage(lsEntries());
    const idb = [];
    for (const t of IDB_TARGETS) {
        const count = await countStore(t.db, t.store);
        idb.push({ ...t, count });
    }
    let quota = null;
    try {
        if (navigator.storage && navigator.storage.estimate) {
            const e = await navigator.storage.estimate();
            quota = { usage: e.usage || 0, quota: e.quota || 0 };
        }
    } catch (e) { logCatch(TAG, e); }
    const usage = { ls, idb, quota, totalBytes: (quota && quota.usage) || ls.totalBytes };
    _lastUsage = usage;
    return usage;
}

function rowHtml(text, value, cls) {
    return `<div class="storage-row${cls ? ' ' + cls : ''}"><span class="storage-row-label">${esc(text)}</span><span class="storage-row-value">${esc(value)}</span></div>`;
}

function renderUsage(usage) {
    const host = g('storagePanel');
    if (!host) return;
    const parts = [];
    const q = usage.quota;
    if (q) {
        parts.push(rowHtml('总占用', `${formatBytes(q.usage)} / ${formatBytes(q.quota)}`, 'total'));
    } else {
        parts.push(rowHtml('总占用', `localStorage ${formatBytes(usage.ls.totalBytes)}（浏览器不支持用量查询）`, 'total'));
    }
    parts.push('<div class="storage-sub">高价值数据（清理需确认）</div>');
    for (const t of usage.idb) {
        if (t.kind !== 'high') continue;
        parts.push(rowHtml(`${t.label} · 高价值`, t.count >= 0 ? `${t.count} 条` : '—'));
    }
    parts.push('<div class="storage-sub">可清理缓存</div>');
    for (const t of usage.idb) {
        if (t.kind === 'high') continue;
        parts.push(rowHtml(t.label, t.count >= 0 ? `${t.count} 条` : '—'));
    }
    for (const grp of usage.ls.groups) {
        if (grp.kind !== 'cache' || !grp.count) continue;
        parts.push(rowHtml(grp.label, formatBytes(grp.bytes)));
    }
    if (usage.ls.unlisted.count) {
        parts.push(rowHtml('其他键', `${usage.ls.unlisted.count} 项 · ${formatBytes(usage.ls.unlisted.bytes)}`));
    }
    parts.push('<div class="storage-sub">受保护（永不自动清理）</div>');
    for (const grp of usage.ls.groups) {
        if (grp.kind !== 'user') continue;
        parts.push(rowHtml(grp.label, formatBytes(grp.bytes), 'protected'));
    }
    host.innerHTML = parts.join('');
    const ov = g('storageOverview');
    if (ov) {
        const bad = usage.idb.filter(t => t.kind === 'high').reduce((a, t) => a + Math.max(0, t.count), 0);
        ov.textContent = `${formatBytes(usage.totalBytes)} 已用 · 高价值缓存 ${bad} 条`;
    }
}

/* ============================ 清理 ============================ */

function limitMb() {
    const raw = parseInt(localStorage.getItem(STORAGE_LIMIT_KEY) || String(STORAGE_LIMIT_DEFAULT), 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

async function pruneToLimit(interactive = true) {
    const usage = await scanUsage();
    const plan = pickAutoPruneTargets({ idb: usage.idb, ls: usage.ls.groups, totalBytes: usage.totalBytes, limitMb: limitMb() });
    if (!plan.need) {
        if (interactive) hint('未超过上限，无需清理');
        return 0;
    }
    const names = plan.targets.map(t => t.label).join('、');
    const worst = plan.targets[0];
    if (interactive) {
        const ok = await confirm2('清理缓存', `已超出上限 ${formatBytes(plan.overflowBytes)}，将依次清理：${names}。\n${worst ? pruneWarning(worst) : ''}`);
        if (!ok) return 0;
    }
    let cleared = 0;
    for (const t of plan.targets) {
        if (t.type === 'idb') {
            const target = IDB_TARGETS.find(x => x.id === t.id);
            if (target) cleared += await pruneOldest(target.db, target.store);
        } else {
            /* LS 组：只可能是 cache 组（pickAutoPruneTargets 已保证），删组内键 */
            for (const k of storageKeysOfGroup(t.id)) {
                try { localStorage.removeItem(k); cleared++; } catch (e) { logCatch(TAG, e); }
            }
        }
    }
    await renderUsage(await scanUsage());
    logInfo(TAG, `已清理 ${cleared} 项缓存（未触碰歌单/收藏/记录）`);
    if (interactive) hint(`已清理 ${cleared} 项缓存`);
    return cleared;
}

/** 取某个分组内的键名；★ 非 cache 组一律返回空（永不清理 user 类） */
function storageKeysOfGroup(groupId) {
    const grp = LS_GROUPS.find(x => x.id === groupId);
    if (!grp || grp.kind !== 'cache') return [];
    return grp.keys.slice();
}

/* ============================ 备份 ============================ */

function collectBackupData() {
    const j = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
    return buildBackup({
        favorites: j(FAV_STORAGE_KEY) || [],
        playlists: j(PLAYLIST_STORAGE_KEY) || [],
        settings: j(SETTINGS_STORAGE_KEY),
        eq: j(EQ_STORAGE_KEY),
        offsets: j('lyrics_player_offsets'),
    });
}

async function saveDirHandle(handle) {
    const db = await new Promise((res) => {
        const r = indexedDB.open(HANDLE_DB, 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(HANDLE_STORE)) d.createObjectStore(HANDLE_STORE); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
    });
    if (!db) return;
    try {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
        await txDone(tx);
        db.close();
    } catch (e) { logCatch(TAG, e); }
}

async function loadDirHandle() {
    const db = await new Promise((res) => {
        const r = indexedDB.open(HANDLE_DB, 1);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains(HANDLE_STORE)) d.createObjectStore(HANDLE_STORE); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
    });
    if (!db) return null;
    try {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
        const v = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(null); });
        db.close();
        return v || null;
    } catch (e) { logCatch(TAG, e); return null; }
}

async function ensureDirPermission(handle) {
    if (!handle || !handle.queryPermission) return false;
    try {
        const st = await handle.queryPermission({ mode: 'readwrite' });
        if (st === 'granted') return true;
        const req = await handle.requestPermission({ mode: 'readwrite' });
        return req === 'granted';
    } catch (e) { logCatch(TAG, e); return false; }
}

async function writeBackupToDir(handle) {
    const data = collectBackupData();
    const fh = await handle.getFileHandle(backupFilename(), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
    /* 轮转：只保留最近 KEEP_BACKUPS 份 */
    try {
        const names = [];
        for await (const name of handle.keys()) {
            if (/^aria-backup-.*\.json$/.test(name)) names.push(name);
        }
        names.sort();   /* 文件名含零填充时间戳 ⇒ 字典序即时间序 */
        while (names.length > KEEP_BACKUPS) {
            const del = names.shift();
            try { await handle.removeEntry(del); } catch (e) { logCatch(TAG, e); }
        }
    } catch (e) { logCatch(TAG, e); }
    return data;
}

async function doBackup(reason) {
    const data = collectBackupData();
    if (_dirHandle) {
        const ok = await ensureDirPermission(_dirHandle);
        if (ok) {
            try {
                await writeBackupToDir(_dirHandle);
                markBackupDone();
                hint('已备份到所选文件夹');
                logInfo(TAG, `备份完成（${reason}）→ 文件夹`);
                return true;
            } catch (e) {
                logWarn(TAG, '写入备份文件夹失败，改为下载:', e && e.message ? e.message : e);
            }
        }
    }
    downloadJSON(data, backupFilename());
    markBackupDone();
    logInfo(TAG, `备份完成（${reason}）→ 下载`);
    return true;
}

function markBackupDone() {
    try {
        const app = globalThis.appSettings;
        if (app && app.backup) { app.backup.lastAt = Date.now(); saveSettings(); }
        const info = g('backupLastInfo');
        if (info) info.textContent = `上次：${new Date().toLocaleString()}`;
    } catch (e) { logCatch(TAG, e); }
}

/* ============================ 提示与确认 ============================ */

function hint(text) {
    if (window.Aria && typeof window.Aria.showHint === 'function') window.Aria.showHint(text);
}

async function confirm2(title, desc, danger = false) {
    if (typeof window.showGlassConfirm === 'function') {
        return !!(await window.showGlassConfirm({ title, desc, okText: '确定', cancelText: '取消', danger }));
    }
    return true;
}

/* ============================ 自动备份调度 ============================ */

function autoBackupEnabled() {
    const b = globalThis.appSettings && globalThis.appSettings.backup;
    return !!(b && b.autoEnabled);
}

function backupIntervalMs() {
    const b = globalThis.appSettings && globalThis.appSettings.backup;
    const h = (b && Number(b.intervalHours)) || 24;
    return Math.max(1, h) * 3600 * 1000;
}

function lastBackupAt() {
    const b = globalThis.appSettings && globalThis.appSettings.backup;
    return (b && Number(b.lastAt)) || 0;
}

async function autoBackupTick() {
    if (!autoBackupEnabled() || _dirUnsupported) return;
    if (Date.now() - lastBackupAt() < backupIntervalMs()) return;
    if (!_dirHandle) return;   /* 没选文件夹就不静默下载（避免一堆重复文件） */
    try { await doBackup('auto'); } catch (e) { logCatch(TAG, e); }
}

/* ============================ 存储上限后台巡检 ============================ */

/* 巡检周期单独定：主间隔是 60s，但"扫一遍占用"要遍历 localStorage 键 + 数个
   IndexedDB count + navigator.storage.estimate()，每 60 秒做一次纯属浪费。
   10 分钟一次足够（上限是 MB 级的粗粒度约束，不是实时配额）。 */
const LIMIT_CHECK_MS = 10 * 60 * 1000;
let _lastLimitCheck = 0;
let _limitBusy = false;

/**
 * ★ 上限自动清理（需求 13 的"超过自动清理最旧的"）此前**只在两处交互式触发**：
 * 改上限输入框、点"立即清理"。也就是说用户设了上限之后放着不管，它会一直超着
 * ——"自动清理"名不副实。
 * 这里补一条后台巡检：**只在设了非 0 上限时**才扫（默认 0=不限 → 零成本），
 * 且走 `pruneToLimit(false)` 静默路径：二次确认属于用户主动点"清理"那条路径，
 * 后台巡检自己弹窗会把用户从歌里打断。
 * 白名单由 pickAutoPruneTargets 保证（歌单/收藏/播放记录属 user 组，永不入选）。
 */
async function autoPruneTick() {
    if (_limitBusy) return;
    if (limitMb() <= 0) return;
    const now = Date.now();
    if (now - _lastLimitCheck < LIMIT_CHECK_MS) return;
    _lastLimitCheck = now;
    _limitBusy = true;
    try {
        const cleared = await pruneToLimit(false);
        if (cleared) logInfo(TAG, `上限巡检：静默清理 ${cleared} 项最旧缓存`);
    } catch (e) {
        logCatch(TAG, e);
    } finally {
        _limitBusy = false;
    }
}

/* ============================ 装配 ============================ */

async function initUI() {
    const limitEl = g('setStorageLimit');
    if (limitEl) {
        limitEl.value = String(limitMb() || 0);
        limitEl.addEventListener('change', async () => {
            let v = parseInt(limitEl.value, 10);
            if (!Number.isFinite(v) || v < 0) v = 0;
            limitEl.value = String(v);
            try { localStorage.setItem(STORAGE_LIMIT_KEY, String(v)); } catch (e) { logCatch(TAG, e); }
            if (v > 0) await pruneToLimit(true);
        });
    }

    g('setStorageRefresh')?.addEventListener('click', async () => {
        await renderUsage(await scanUsage());
        hint('已刷新');
    });

    g('setStoragePrune')?.addEventListener('click', async () => {
        const c = await pruneToLimit(true);
        if (!c) await renderUsage(await scanUsage());
    });

    /* ---- 备份 ---- */
    const intervalEl = g('setBackupInterval');
    const intervalVal = g('setBackupIntervalVal');
    if (intervalEl) {
        const h = backupIntervalMs() / 3600000;
        intervalEl.value = String(h);
        if (intervalVal) intervalVal.textContent = String(h);
        intervalEl.addEventListener('input', () => {
            if (intervalVal) intervalVal.textContent = intervalEl.value;
            try {
                const app = globalThis.appSettings;
                if (app && app.backup) { app.backup.intervalHours = parseInt(intervalEl.value, 10) || 24; saveSettings(); }
            } catch (e) { logCatch(TAG, e); }
        });
    }

    const tgl = g('setAutoBackup');
    const syncToggle = () => { if (tgl) tgl.classList.toggle('on', autoBackupEnabled()); };
    syncToggle();
    tgl?.addEventListener('click', async () => {
        const next = !autoBackupEnabled();
        try {
            const app = globalThis.appSettings;
            if (app) { app.backup = app.backup || {}; app.backup.autoEnabled = next; saveSettings(); }
        } catch (e) { logCatch(TAG, e); }
        syncToggle();
        if (next && !_dirHandle) hint('请先选择备份文件夹');
    });

    _dirHandle = await loadDirHandle();
    const nameEl = g('backupDirName');
    if (nameEl) nameEl.textContent = _dirHandle ? (_dirHandle.name || '已选择') : (typeof window.showDirectoryPicker === 'function' ? '未选择' : '当前环境不支持，将下载到默认位置');
    if (typeof window.showDirectoryPicker !== 'function') _dirUnsupported = true;

    g('setBackupDir')?.addEventListener('click', async () => {
        if (typeof window.showDirectoryPicker !== 'function') { hint('当前环境不支持选择文件夹，备份将下载为文件'); return; }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            if (!handle) return;
            _dirHandle = handle;
            await saveDirHandle(handle);
            if (nameEl) nameEl.textContent = handle.name || '已选择';
            hint('已设置备份文件夹');
        } catch (e) { logCatch(TAG, e); }
    });

    g('setBackupNow')?.addEventListener('click', async () => {
        hint('正在备份…');
        await doBackup('manual');
    });

    g('setRestoreBtn')?.addEventListener('click', () => g('setRestoreFile')?.click());
    g('setRestoreFile')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let raw;
        try { raw = JSON.parse(await file.text()); } catch { hint('文件不是合法 JSON'); return; }
        const v = validateBackup(raw);
        if (!v.ok) { hint('未识别到有效备份内容'); return; }
        const desc = describeBackup(raw);
        const ok = await confirm2('从备份恢复', `将导入：${desc}。\n现有的收藏/歌单会被覆盖。`, true);
        if (!ok) return;
        /* 解包（兼容带 data 包装的新格式与旧的裸对象） */
        const payload = (raw && raw.data && typeof raw.data === 'object') ? raw.data : raw;
        importData(payload);
        hint('已从备份恢复');
    });

    const info = g('backupLastInfo');
    if (info) info.textContent = lastBackupAt() ? `上次：${new Date(lastBackupAt()).toLocaleString()}` : '上次：—';

    setInterval(() => {
        void autoBackupTick();
        void autoPruneTick();
    }, AUTO_CHECK_MS);
    /* 启动即扫一次占用，用户打开设置页时数值已就绪 */
    renderUsage(await scanUsage());
}

if (typeof document !== 'undefined') {
    const boot = () => { initUI().catch((e) => logCatch(TAG, e)); };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });
}

export { doBackup, pruneToLimit, scanUsage };
