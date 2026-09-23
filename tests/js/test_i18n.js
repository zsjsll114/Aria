/* ============================================================
 * tests/js/test_i18n.js — 国际化 i18n 模块单测
 * 运行方式：node --test tests/js/test_i18n.js
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DICTIONARY,
  getLanguage,
  setLanguage,
  t
} from '../../web/src/core/i18n.js';

test('i18n 词典包含完整中英文对应项', () => {
  assert.ok(DICTIONARY['zh-CN'], '应包含中文词典');
  assert.ok(DICTIONARY['en-US'], '应包含英文词典');
  assert.equal(DICTIONARY['zh-CN']['nav.search'], '搜索');
  assert.equal(DICTIONARY['en-US']['nav.search'], 'Search');
  assert.equal(DICTIONARY['en-US']['btn.shuffle'], 'Shuffle');
});

test('t() 翻译与回退机制', () => {
  setLanguage('zh-CN');
  assert.equal(t('nav.playlists'), '歌单');
  assert.equal(t('non.existent.key', '默认值'), '默认值');

  setLanguage('en-US');
  assert.equal(t('nav.playlists'), 'Playlists');
  assert.equal(t('btn.playAll'), 'Play All');

  // 切回默认
  setLanguage('zh-CN');
  assert.equal(getLanguage(), 'zh-CN');
});
