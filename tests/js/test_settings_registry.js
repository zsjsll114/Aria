/* ============================================================
 * tests/js/test_settings_registry.js — 声明式设置扩展注册表与去 Observer 契约单测
 * 运行方式：node --test tests/js/test_settings_registry.js
 * ============================================================ */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  registerSettingsGroup,
  registerSettingsHook,
  getGroupsForTab,
  getHooksForTab,
  listRegisteredTabs,
  clearSettingsRegistryForTest,
} from '../../web/src/core/settingsRegistry.js';
import { listSchemaTabs } from '../../web/src/ui/settingsRenderer.js';

const REPO = path.resolve(import.meta.dirname, '../..');

afterEach(() => {
  clearSettingsRegistryForTest();
});

test('SR1 参数校验：缺失 tab / def / id 时返回 false 且不抛错', () => {
  assert.equal(registerSettingsGroup('', { id: 'x' }), false);
  assert.equal(registerSettingsGroup('playback', null), false);
  assert.equal(registerSettingsGroup('playback', /** @type {any} */ ({})), false);
  assert.equal(registerSettingsHook('', { id: 'y' }), false);
  assert.equal(registerSettingsHook('playback', /** @type {any} */ ({ order: 1 })), false);
  assert.deepEqual(listRegisteredTabs(), []);
});

test('SR2 同 tab 内按 order 升序排列，默认 order = 100', () => {
  registerSettingsGroup('playback', { id: 'late', order: 200 });
  registerSettingsGroup('playback', { id: 'defaultOrder' });
  registerSettingsGroup('playback', { id: 'early', order: 10 });
  registerSettingsGroup('playback', { id: 'negative', order: -5 });

  assert.deepEqual(
    getGroupsForTab('playback').map((g) => g.id),
    ['negative', 'early', 'defaultOrder', 'late'],
  );

  registerSettingsHook('audio', { id: 'h2', order: 50 });
  registerSettingsHook('audio', { id: 'h1', order: 5 });
  assert.deepEqual(
    getHooksForTab('audio').map((h) => h.id),
    ['h1', 'h2'],
  );
});

test('SR3 同 id 重复注册幂等覆盖，且 group 与 hook 互不冲突', () => {
  registerSettingsGroup('lyrics', { id: 'shared', order: 30, render: () => 'v1' });
  registerSettingsGroup('lyrics', { id: 'shared', order: 15, render: () => 'v2' });
  registerSettingsHook('lyrics', { id: 'shared', order: 5, onShow: () => {} });

  const groups = getGroupsForTab('lyrics');
  const hooks = getHooksForTab('lyrics');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].order, 15);
  assert.equal(groups[0].render?.(/** @type {any} */ (null)), 'v2');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].order, 5);
});

test('SR4 tab 隔离与返回值防篡改', () => {
  registerSettingsGroup('lyrics', { id: 'zen', order: 30 });
  registerSettingsHook('interface', { id: 'reset', order: 10 });

  assert.deepEqual(listRegisteredTabs().sort(), ['interface', 'lyrics']);
  const snapshot = getGroupsForTab('lyrics');
  snapshot.push(/** @type {any} */ ({ id: 'injected' }));
  assert.equal(getGroupsForTab('lyrics').length, 1);

  clearSettingsRegistryForTest();
  assert.deepEqual(listRegisteredTabs(), []);
  assert.deepEqual(getGroupsForTab('lyrics'), []);
});

test('SR5 6 个扩展模块已全部迁出设置面板 MutationObserver 并对接到合法 tab', () => {
  const validTabs = new Set(listSchemaTabs());
  const migratedFiles = [
    'web/src/app/250-desktop-lyrics.js',
    'web/src/app/282-zen-mode.js',
    'web/src/app/289-next-up.js',
    'web/src/app/290-vfx-recipe.js',
    'web/src/app/292-toolbar.js',
    'web/src/app/309-jizura-fontpack.js',
  ];

  for (const rel of migratedFiles) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const regCalls = [...src.matchAll(/registerSettings(?:Group|Hook)\(\s*'([^']+)'/g)];
    assert.ok(regCalls.length >= 1, `${rel} 必须调用 registerSettingsGroup/Hook`);
    for (const m of regCalls) {
      assert.ok(validTabs.has(m[1]), `${rel} 注册了不存在的设置页签 '${m[1]}'`);
    }
    assert.ok(
      !/MutationObserver[\s\S]{0,400}(settingsOverlay|settingsBody|document\.body)/.test(src),
      `${rel} 不得保留监听设置面板/body 的 MutationObserver`,
    );
  }
});
