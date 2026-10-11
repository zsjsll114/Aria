/* ============================================================
 * tests/js/test_settings_contract.js — 配置键契约门禁本身必须会响
 *
 * 这条门禁是为了治「往 DEFAULT_SETTINGS 加顶层新键、忘了在 loadSettings 重建块补一行
 * → 有存档时该键被静默丢弃」。仓库已踩过（backup 键即活标本），历史上靠人肉发现。
 * 所以重点不是「现在齐了」（那由 CI 跑），而是**故意抽掉一个键时必须报**：
 *   ① 真实文件必须零缺键（这条就是 CI 里那条断言的本地版）；
 *   ② 抽掉 backup 定义行 → 只报 backup（证明逐键判定，不是「少一行所以整体糊」）；
 *   ③ 只留一个键的假重建块 → 报出其余全部（防止扫描器把「没扫到」当成「都齐了」）；
 *   ④ 结构被改（没有 appSettings = {）→ 必须报 error，而不是静默通过；
 *   ⑤ 嵌套里的同名属性不得被误当顶层键。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan, extractRebuildKeys } from '../../scripts/audits/settings-contract.mjs';
import { DEFAULT_SETTINGS } from '../../web/src/config/defaults.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REBUILD_FILE = resolve(ROOT, 'web/src/app/180-boot-config.js');
const REAL_TEXT = readFileSync(REBUILD_FILE, 'utf8');
const KEYS = Object.keys(DEFAULT_SETTINGS);

test('① 真实文件必须零缺键（CI 里那条断言的本地版）', () => {
    const r = scan({ defaultsKeys: KEYS, rebuildText: REAL_TEXT });
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.missing, [], `漏合并的顶层键: ${r.missing.join(', ')}`);
});

test('② 抽掉 backup 定义行 → 只报 backup', () => {
    const withoutBackup = REAL_TEXT
        .split('\n')
        .filter((l) => !l.includes('backup: { ...DEFAULT_SETTINGS.backup'))
        .join('\n');
    const r = scan({ defaultsKeys: KEYS, rebuildText: withoutBackup });
    assert.deepEqual(r.missing, ['backup'], r.missing);
});

test('③ 只剩一个键的假重建块 → 报出其余全部（防止「没扫到」被当「都齐了」）', () => {
    const fake = 'function loadSettings() {\n    appSettings = {\n        playback: {},\n    };\n}\n';
    const r = scan({ defaultsKeys: KEYS, rebuildText: fake });
    assert.equal(r.found, 1, `应只解析出 1 个键，实际 ${r.found}`);
    assert.equal(r.missing.length, KEYS.length - 1);
    assert.ok(r.missing.includes('lyrics') && r.missing.includes('ai'), r.missing);
});

test('④ 结构被改（无重建块）→ 报 error 而不是静默通过', () => {
    const r = scan({ defaultsKeys: KEYS, rebuildText: 'const x = 1;\n' });
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.includes('未在'), r.error);
    assert.deepEqual(r.missing, []);
});

test('⑤ 嵌套里的同名属性不得被误当顶层键', () => {
    const src = [
        '    appSettings = {',
        '        interface: {',
        '            lyrics: 1,',
        '        },',
        '    };',
    ].join('\n');
    const keys = extractRebuildKeys(src);
    assert.deepEqual([...keys], ['interface'], [...keys]);
});

test('⑥ 字符串/注释里的花括号不得把括号配对带偏', () => {
    const src = [
        '    appSettings = {',
        '        // 说明里有花括号 { 不算数',
        "        ai: { provider: '{' },",
        '        quality: {},',
        '    };',
    ].join('\n');
    const keys = extractRebuildKeys(src);
    assert.deepEqual([...keys].sort(), ['ai', 'quality']);
});
