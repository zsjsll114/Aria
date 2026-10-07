/* ============================================================
 * test_storage_backup.js — 存储分类/清理决策（需求 13）+ 备份包（需求 23）
 *
 * 需求 13 唯一不可退让的约束是「**绝对别删用户歌单收藏和播放记录**」，
 * 所以这里重点钉：user 类分组**永远不出现在清理目标里**，哪怕它占得最多。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sm = await import(new URL('../../web/src/core/storageManager.js', import.meta.url));
const bs = await import(new URL('../../web/src/core/backupService.js', import.meta.url));

/* ---------------- 需求 13 ---------------- */

test('formatBytes：各量级单位正确', () => {
    assert.equal(sm.formatBytes(512), '512 B');
    assert.equal(sm.formatBytes(2048), '2.0 KB');
    assert.equal(sm.formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(sm.formatBytes(2.5 * 1024 * 1024 * 1024), '2.50 GB');
    assert.equal(sm.formatBytes(undefined), '0 B');
});

test('classifyLocalStorage：按组归类 + 未登记项单列 + 总量', () => {
    const r = sm.classifyLocalStorage([
        { key: 'lyrics_player_favorites', bytes: 3000 },
        { key: 'lyrics_player_playlists', bytes: 5000 },
        { key: 'aria_perf_pref', bytes: 100 },
        { key: 'some_unknown_key', bytes: 700 },
    ]);
    const by = Object.fromEntries(r.groups.map(g => [g.id, g]));
    assert.equal(by.favorites.bytes, 3000);
    assert.equal(by.favorites.kind, 'user');
    assert.equal(by.playlists.bytes, 5000);
    assert.equal(by.perf.bytes, 100);
    assert.equal(r.unlisted.count, 1);
    assert.deepEqual(r.unlisted.keys, ['some_unknown_key']);
    assert.equal(r.totalBytes, 8800);
});

test('classifyLocalStorage：空输入不抛', () => {
    const r = sm.classifyLocalStorage(null);
    assert.equal(r.totalBytes, 0);
    assert.equal(r.groups.length, sm.LS_GROUPS.length);
});

test('pickAutoPruneTargets：未超限（或未设上限）时不出清理建议', () => {
    const usage = { totalBytes: 999 * 1024 * 1024, limitMb: 0, idb: [{ id: 'aiTheme', kind: 'high', count: 10 }], ls: [] };
    assert.equal(sm.pickAutoPruneTargets(usage).need, false);
    const u2 = { totalBytes: 100, limitMb: 100, idb: [], ls: [] };
    assert.equal(sm.pickAutoPruneTargets(u2).need, false);
});

test('pickAutoPruneTargets：★★ user 类永不入选（哪怕占最大头）', () => {
    const usage = {
        totalBytes: 900 * 1024 * 1024,
        limitMb: 100,
        idb: [{ id: 'aiTheme', kind: 'high', count: 5, label: 'AI' }],
        ls: [
            { id: 'favorites', label: '收藏', kind: 'user', bytes: 500 * 1024 * 1024 },
            { id: 'playlists', label: '歌单', kind: 'user', bytes: 300 * 1024 * 1024 },
            { id: 'perf', label: '性能偏好', kind: 'cache', bytes: 1000 },
        ],
    };
    const r = sm.pickAutoPruneTargets(usage);
    assert.equal(r.need, true);
    assert.ok(r.overflowBytes > 0);
    for (const t of r.targets) {
        assert.notEqual(t.id, 'favorites', '收藏绝不能进清理目标');
        assert.notEqual(t.id, 'playlists', '歌单绝不能进清理目标');
    }
    assert.ok(r.targets.some(t => t.id === 'perf'));
    assert.ok(r.targets.some(t => t.id === 'aiTheme'));
});

test('pickAutoPruneTargets：排序 = 普通缓存 → 高价值 → LS 缓存', () => {
    const usage = {
        totalBytes: 10 * 1024 * 1024, limitMb: 1,
        idb: [
            { id: 'aiTheme', kind: 'high', label: 'AI' },
            { id: 'automix', kind: 'cache', label: '混音' },
        ],
        ls: [{ id: 'perf', label: '性能', kind: 'cache', bytes: 10 }],
    };
    const ids = sm.pickAutoPruneTargets(usage).targets.map(t => t.id);
    assert.deepEqual(ids, ['automix', 'aiTheme', 'perf']);
});

test('pruneWarning：高价值数据给出"需重新分析"的提示', () => {
    assert.ok(sm.pruneWarning({ label: 'AI 分析', kind: 'high' }).includes('重新分析'));
    assert.ok(sm.pruneWarning({ label: '混音', kind: 'cache' }).includes('自动重建'));
});

/* ---------------- 需求 23 ---------------- */

test('buildBackup：包带 app/schema/时间戳，字段齐全', () => {
    const b = bs.buildBackup({ favorites: [1, 2], playlists: [{ id: 'p', songs: [] }], settings: { a: 1 }, eq: { gains: [] } }, 12345);
    assert.equal(b.app, 'aria');
    assert.equal(b.schema, bs.BACKUP_SCHEMA);
    assert.equal(b.exportedAt, 12345);
    assert.deepEqual(b.data.favorites, [1, 2]);
    assert.equal(b.data.playlists.length, 1);
    assert.deepEqual(b.data.settings, { a: 1 });
});

test('buildBackup：非法入参归一为空数组/ null（不产生 undefined 字段）', () => {
    const b = bs.buildBackup({ favorites: 'x', playlists: null, settings: 5 }, 0);
    assert.deepEqual(b.data.favorites, []);
    assert.deepEqual(b.data.playlists, []);
    assert.equal(b.data.settings, null);
    assert.equal(b.data.eq, null);
});

test('backupFilename：含日期时间且以 .json 结尾', () => {
    const n = bs.backupFilename(new Date(2026, 9, 5, 8, 7, 6));
    assert.equal(n, 'aria-backup-20261005-080706.json');
});

test('validateBackup：完整包识别为 full 并给摘要', () => {
    const b = bs.buildBackup({ favorites: [1, 2, 3], playlists: [{ songs: [] }, { songs: [] }], settings: {}, eq: {}, offsets: {} }, 1);
    const v = bs.validateBackup(b);
    assert.equal(v.ok, true);
    assert.equal(v.kind, 'full');
    assert.equal(v.summary.favorites, 3);
    assert.equal(v.summary.playlists, 2);
    assert.equal(v.summary.hasSettings, true);
    assert.equal(v.summary.hasOffsets, true);
});

test('validateBackup：兼容旧「导出全部」（无 app/schema 包装）', () => {
    const v = bs.validateBackup({ favorites: [1], playlists: [], settings: {} });
    assert.equal(v.ok, true);
    assert.equal(v.kind, 'full');
    assert.equal(v.summary.favorites, 1);
});

test('validateBackup：单数组识别收藏 / 歌单', () => {
    assert.equal(bs.validateBackup([{ title: 'a', artist: 'b' }]).kind, 'favorites');
    const pl = bs.validateBackup([{ id: 'p1', name: '我喜欢的', songs: [] }]);
    assert.equal(pl.kind, 'playlists');
    assert.equal(pl.summary.count, 1);
});

test('validateBackup：垃圾输入 → ok:false（不炸）', () => {
    for (const x of [null, 42, 'str', {}, []]) {
        const v = bs.validateBackup(x);
        assert.equal(v.ok, false, JSON.stringify(x));
        assert.equal(v.kind, 'unknown');
    }
});

test('describeBackup：人话摘要', () => {
    assert.equal(bs.describeBackup([{ title: 'a' }]), '收藏 1 首');
    const full = bs.buildBackup({ favorites: [1, 2], playlists: [{ songs: [] }], settings: {}, eq: {}, offsets: {} }, 1);
    const d = bs.describeBackup(full);
    assert.ok(d.includes('收藏 2 首') && d.includes('歌单 1 个') && d.includes('歌词偏移'), d);
    assert.equal(bs.describeBackup(null), '');
});
