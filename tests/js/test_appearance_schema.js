/* ============================================================
 * tests/js/test_appearance_schema.js — 视觉工坊与设置 Schema 完整性单测
 * 运行方式：node --test tests/js/test_appearance_schema.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  APPEARANCE_FAMILIES,
  APPEARANCE_MODES,
  APPEARANCE_MODE_MAP,
  APPEARANCE_TIER_META,
  APPEARANCE_SECTIONS,
  collectSchemaModeVars,
} from '../../web/src/config/appearanceSchema.js';
import { SETTINGS_NAV } from '../../web/src/config/settingsNav.js';
import { SETTINGS_SECTIONS_SCHEMA } from '../../web/src/config/settingsSchema.js';
import { MODE_FIELDS_BY_MODE, VIEW_MODES } from '../../web/src/core/vfxRecipe.js';
import { listSchemaTabs } from '../../web/src/ui/settingsRenderer.js';
import { setLanguage, translatePhrase } from '../../web/src/core/i18n.js';

const REPO = path.resolve(import.meta.dirname, '../..');

test('AS1 视觉工坊定义 4 家族、14 模式、3 分层，ID 唯一且全数入图', () => {
  assert.deepEqual(
    APPEARANCE_FAMILIES.map((f) => f.id),
    ['classic', 'spatial', 'kinetic', 'editorial'],
  );
  assert.equal(APPEARANCE_MODES.length, 14);
  assert.deepEqual(Object.keys(APPEARANCE_TIER_META), ['core', 'advanced', 'override']);

  const famIds = new Set(APPEARANCE_FAMILIES.map((f) => f.id));
  const seen = new Set();
  for (const m of APPEARANCE_MODES) {
    assert.ok(!seen.has(m.id), `重复的模式 ID: ${m.id}`);
    seen.add(m.id);
    assert.ok(famIds.has(m.family), `${m.id} 引用了未知家族 '${m.family}'`);
    assert.ok(VIEW_MODES.includes(m.id), `${m.id} 不在 vfxRecipe.VIEW_MODES 中`);
    assert.equal(APPEARANCE_MODE_MAP[m.id]?.id, m.id);
    assert.ok(APPEARANCE_SECTIONS[m.id], `APPEARANCE_SECTIONS 缺模式 ${m.id}`);
  }
});

test('AS2 全 13 模式的 Schema 变量全收录于 MODE_FIELDS_BY_MODE，且不重复放 themeColor', () => {
  for (const m of APPEARANCE_MODES) {
    const vars = collectSchemaModeVars(m.id);
    assert.ok(vars.length >= 4, `${m.id} 的 schema 控件过少: ${vars.length}`);
    const allowed = MODE_FIELDS_BY_MODE[m.id] || [];
    const missing = vars.filter((v) => !allowed.includes(v));
    assert.deepEqual(missing, [], `${m.id} 中未进 MODE_FIELDS_BY_MODE 的键: ${missing.join(', ')}`);
    assert.ok(!vars.includes('themeColor'), `${m.id} 不得再重复出现全局 themeColor`);
  }
});

test('AS3 SETTINGS_NAV 的 4 组 13 页签与 SETTINGS_SECTIONS_SCHEMA / listSchemaTabs 严格 1:1', () => {
  assert.equal(SETTINGS_NAV.length, 4);
  const navTabs = SETTINGS_NAV.flatMap((g) => g.items.map((it) => it.tab));
  assert.equal(navTabs.length, 13);
  assert.equal(new Set(navTabs).size, 13, 'SETTINGS_NAV 存在重复页签');
  assert.deepEqual(listSchemaTabs(), navTabs);

  const nonAppearance = navTabs.filter((t) => t !== 'appearance');
  assert.deepEqual(Object.keys(SETTINGS_SECTIONS_SCHEMA).sort(), [...nonAppearance].sort());

  const allSchemaHtml = Object.values(SETTINGS_SECTIONS_SCHEMA)
    .flat()
    .map((g) => g.html || '')
    .join('\n');
  assert.ok(allSchemaHtml.includes('data-var="themeColor"'), '全局 themeColor 必须仍在 interface schema 中');
  assert.ok(allSchemaHtml.includes('id="btnOpenFontsFromInterface"'), 'interface 页签需含前往字体管理的快捷按钮');
});

test('AS4 appearanceSchema 与 settingsSchema 不得包含手抄十六进制色块', () => {
  const srcA = fs.readFileSync(path.join(REPO, 'web/src/config/appearanceSchema.js'), 'utf8');
  const srcS = fs.readFileSync(path.join(REPO, 'web/src/config/settingsSchema.js'), 'utf8');
  for (const [name, src] of [['appearanceSchema.js', srcA], ['settingsSchema.js', srcS]]) {
    assert.ok(!/data-color="#/.test(src), `${name} 不得含手抄 data-color`);
    assert.ok(!/color-swatch/.test(src), `${name} 不得含手抄 .color-swatch`);
    assert.ok(!/style="background:/.test(src), `${name} 不得含内联 background 色值`);
  }
});

test('AS5 家族、分层、模式短语与导航分组全部在 i18n 词表有英文译名', () => {
  setLanguage('en-US');
  try {
    for (const g of SETTINGS_NAV) {
      assert.notEqual(translatePhrase(g.group), g.group, `导航分组缺少英文译文: ${g.group}`);
      for (const it of g.items) {
        assert.ok(it.labelEn && it.labelEn !== it.label, `导航项缺少 labelEn: ${it.tab}`);
      }
    }
    for (const fam of APPEARANCE_FAMILIES) {
      assert.notEqual(translatePhrase(fam.label), fam.label, `家族名缺少英文译文: ${fam.label}`);
    }
    for (const tier of Object.values(APPEARANCE_TIER_META)) {
      assert.notEqual(translatePhrase(tier.label), tier.label, `分层名缺少英文译文: ${tier.label}`);
      assert.ok(tier.labelEn && tier.labelEn !== tier.label, `分层缺少 labelEn: ${tier.label}`);
    }
  } finally {
    setLanguage('zh-CN');
  }
});
