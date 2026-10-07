/* ============================================================
 * core/storageManager.js — 存储占用分类与清理决策（需求 13）
 *
 * 「列出各类缓存占用，分普通缓存 / 高价值数据，清理要二次确认，加上限自动清理最旧，
 *  **绝对别删用户歌单收藏和播放记录**」—— 这几条里只有最后一条是硬约束，
 * 所以本模块的第一原则是：**user 类永不出现在任何清理目标里**（连候选都不算）。
 *
 * 纯函数部分（classifyLocalStorage / pickAutoPruneTargets / formatBytes）带单测；
 * 真正的 IndexedDB / localStorage 读写与 UI 在 app/303-storage-backup.js。
 *
 * ★ IndexedDB 没有"分库大小"API。这里对 IDB 只给**条数**，整体字节数交给
 *   `navigator.storage.estimate()`（它已含 IndexedDB + CacheStorage + localStorage）。
 *   遍历每条记录做 JSON.stringify 求长度在 AI 缓存上会卡住主线程 —— 不值得。
 * ============================================================ */

/** 自动清理上限（MB）的 localStorage 键；0 = 不限 */
export const STORAGE_LIMIT_KEY = 'aria_storage_limit_mb';
/** 默认上限：0（不限）。用户显式设置后才启用自动清理。 */
export const STORAGE_LIMIT_DEFAULT = 0;

/** localStorage 已登记的键 → 分组（kind: 'user' 永不清理 / 'cache' 可清理） */
export const LS_GROUPS = [
    { id: 'favorites', label: '收藏', kind: 'user', keys: ['lyrics_player_favorites'] },
    { id: 'playlists', label: '歌单', kind: 'user', keys: ['lyrics_player_playlists'] },
    { id: 'settings', label: '应用设置', kind: 'user', keys: ['lyrics_player_settings'] },
    { id: 'eq', label: '均衡器设置', kind: 'user', keys: ['lyrics_player_eq'] },
    { id: 'offsets', label: '歌词偏移', kind: 'user', keys: ['lyrics_player_offsets'] },
    { id: 'perf', label: '性能偏好', kind: 'cache', keys: ['lyrics_player_performance', 'aria_perf_pref'] },
    { id: 'uiPref', label: '界面偏好', kind: 'cache', keys: ['aria_i18n_lang', 'aria_dtk_emwords', 'aria_dtk_fontfamily', 'aria_dtk_fontsize', 'aria_fontcat_collapsed', 'player_view_mode'] },
];

/** IndexedDB 目标（high = 高价值数据，清理需更强的二次确认） */
export const IDB_TARGETS = [
    { id: 'aiTheme', db: 'LyricsPlayerDB', store: 'aiThemeCache', label: 'AI 情绪分析结果', kind: 'high' },
    { id: 'wordTiming', db: 'LyricsPlayerDB', store: 'wordTimingCache', label: '逐字对齐数据', kind: 'high' },
    { id: 'chorus', db: 'LyricsPlayerDB', store: 'chorusCache', label: '高潮检测缓存', kind: 'high' },
    { id: 'automix', db: 'LyricsPlayerDB', store: 'automixCache', label: '混音分析缓存', kind: 'cache' },
    { id: 'lyricIndex', db: 'aria_lyric_index', store: 'docs', label: '歌词索引', kind: 'cache' },
];

/** 人类可读字节数 */
export function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 把 localStorage 快照归类。
 * @param {Array<{key:string, bytes:number}>} entries
 * @returns {{groups:Array<{id:string,label:string,kind:string,count:number,bytes:number}>,
 *            unlisted:{count:number,bytes:number,keys:string[]}, totalBytes:number}}
 */
export function classifyLocalStorage(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const groups = LS_GROUPS.map(g => ({ id: g.id, label: g.label, kind: g.kind, count: 0, bytes: 0 }));
    const byKey = new Map();
    for (const g of LS_GROUPS) for (const k of g.keys) byKey.set(k, g.id);
    const idxOf = new Map(groups.map((g, i) => [g.id, i]));
    const unlisted = { count: 0, bytes: 0, keys: [] };
    let totalBytes = 0;
    for (const e of list) {
        if (!e || typeof e.key !== 'string') continue;
        const b = Number(e.bytes) || 0;
        totalBytes += b;
        const gid = byKey.get(e.key);
        if (gid && idxOf.has(gid)) {
            const gl = groups[idxOf.get(gid)];
            gl.count++;
            gl.bytes += b;
        } else {
            unlisted.count++;
            unlisted.bytes += b;
            unlisted.keys.push(e.key);
        }
    }
    return { groups, unlisted, totalBytes };
}

/**
 * 达到上限时该清理谁（按「低价值 → 高价值」顺序给出建议）。
 * ★ 只从 cache / high 里选；**user 类永不入选**（需求 13 硬约束）。
 * @param {{idb?:Array, ls?:Array, totalBytes:number, limitMb:number}} usage
 * @returns {{need:boolean, overflowBytes:number, targets:Array}}
 */
export function pickAutoPruneTargets(usage) {
    const u = usage || {};
    const limitBytes = Math.max(0, (Number(u.limitMb) || 0)) * 1024 * 1024;
    const total = Number(u.totalBytes) || 0;
    if (!limitBytes || total <= limitBytes) {
        return { need: false, overflowBytes: 0, targets: [] };
    }
    const overflowBytes = total - limitBytes;
    /* 排序：① IDB 普通缓存 → ② IDB 高价值 → ③ localStorage 缓存组。
       IDB 优先于 LS，因为占用大头在 IDB（AI/对齐/分析），清它才降得下来。
       同级按占用倒序（先清大户，见效快）。 */
    const rank = (type, kind) => {
        if (type === 'idb') return kind === 'high' ? 1 : 0;
        return 2;
    };
    const cand = [];
    for (const x of (u.idb || [])) {
        if (!x || (x.kind !== 'cache' && x.kind !== 'high')) continue;
        cand.push({ type: 'idb', id: x.id, label: x.label, kind: x.kind, count: x.count || 0 });
    }
    for (const g of (u.ls || [])) {
        if (!g || g.kind !== 'cache') continue;
        if (!g.bytes) continue;
        cand.push({ type: 'ls', id: g.id, label: g.label, kind: g.kind, bytes: g.bytes });
    }
    cand.sort((a, b) => {
        const r = rank(a.type, a.kind) - rank(b.type, b.kind);
        if (r !== 0) return r;
        return (b.bytes || 0) - (a.bytes || 0);
    });
    return { need: true, overflowBytes, targets: cand };
}

/** 清理前的风险文案（供 UI 直接显示；纯函数便于单测） */
export function pruneWarning(target) {
    const t = target || {};
    if (t.kind === 'high') {
        return `「${t.label}」是高价值数据，清掉后需要重新分析才能恢复（不影响播放）。`;
    }
    return `「${t.label || '缓存'}」可以在下次使用时自动重建。`;
}
