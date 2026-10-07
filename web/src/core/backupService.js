/* ============================================================
 * core/backupService.js — 备份包的构造与校验（需求 23）
 *
 * 「把歌单、收藏、播放历史、设置导出成 JSON，支持手动触发备份和恢复」——
 * 项目里**已有**导出/导入（`220-shortcuts-viewmode.js` 的 downloadJSON / importData），
 * 本模块补的是三件它没做的事：
 *   ① 备份包**带 schema 与时间戳**（旧实现是裸对象，导入时只能靠字段名猜）；
 *   ② 覆盖**更全**（+ 歌词偏移、播放会话、播放模式）；
 *   ③ 提供**校验与摘要**（导入前能告诉用户"这个包里有 3 个歌单、120 首收藏"）。
 *
 * 纯函数（无 IO / 无 DOM），带单测。
 * ============================================================ */

export const BACKUP_APP = 'aria';
export const BACKUP_SCHEMA = 1;

/**
 * 构造备份包。
 * @param {{favorites?:Array, playlists?:Array, settings?:object, eq?:object,
 *          offsets?:object}} input
 * @param {number} [now]
 */
export function buildBackup(input, now = Date.now()) {
    const i = input || {};
    return {
        app: BACKUP_APP,
        schema: BACKUP_SCHEMA,
        exportedAt: now,
        data: {
            favorites: Array.isArray(i.favorites) ? i.favorites : [],
            playlists: Array.isArray(i.playlists) ? i.playlists : [],
            settings: (i.settings && typeof i.settings === 'object') ? i.settings : null,
            eq: (i.eq && typeof i.eq === 'object') ? i.eq : null,
            offsets: (i.offsets && typeof i.offsets === 'object') ? i.offsets : null,
        },
    };
}

/** 备份文件名（本地时间，可排序） */
export function backupFilename(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `aria-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`;
}

/**
 * 校验并识别备份内容。
 * @param {any} raw 已 JSON.parse 的对象
 * @returns {{ok:boolean, kind:'full'|'favorites'|'playlists'|'unknown', summary:object}}
 */
export function validateBackup(raw) {
    const bad = { ok: false, kind: 'unknown', summary: {} };
    if (raw === null || typeof raw !== 'object') return bad;

    /* 单数组：旧版「单独导出收藏 / 歌单」 */
    if (Array.isArray(raw)) {
        if (raw.length === 0) return { ok: false, kind: 'unknown', summary: { count: 0 } };
        const isPlaylists = !!(raw[0] && typeof raw[0] === 'object' && (raw[0].songs || (raw[0].id && raw[0].name)));
        return {
            ok: true,
            kind: isPlaylists ? 'playlists' : 'favorites',
            summary: { count: raw.length },
        };
    }

    const d = (raw.data && typeof raw.data === 'object') ? raw.data : raw;   /* 兼容无包装的旧「导出全部」 */
    const hasAny = ['favorites', 'playlists', 'settings', 'eq'].some(k => d[k] !== undefined);
    if (!hasAny) return bad;
    return {
        ok: true,
        kind: 'full',
        summary: {
            schema: Number.isFinite(raw.schema) ? raw.schema : null,
            exportedAt: Number.isFinite(raw.exportedAt) ? raw.exportedAt : null,
            favorites: Array.isArray(d.favorites) ? d.favorites.length : 0,
            playlists: Array.isArray(d.playlists) ? d.playlists.length : 0,
            hasSettings: !!d.settings,
            hasEq: !!d.eq,
            hasOffsets: !!d.offsets,
        },
    };
}

/** 摘要文案（UI 提示用；纯函数便于单测） */
export function describeBackup(v) {
    const r = validateBackup(v);
    if (!r.ok) return '';
    if (r.kind === 'favorites') return `收藏 ${r.summary.count} 首`;
    if (r.kind === 'playlists') return `歌单 ${r.summary.count} 个`;
    const s = r.summary;
    const parts = [`收藏 ${s.favorites} 首`, `歌单 ${s.playlists} 个`];
    if (s.hasSettings) parts.push('设置');
    if (s.hasEq) parts.push('均衡器');
    if (s.hasOffsets) parts.push('歌词偏移');
    return parts.join(' · ');
}
