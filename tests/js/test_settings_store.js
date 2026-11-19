/* ============================================================
 * test_settings_store.js — core/settingsStore 纯函数单测
 *
 * 锁定重点：
 * 1. normalizeFontKey 兼容内置全套字体（含 hei / fangsong / mono / serif / kai / inherit / 栈字符串）
 *    并完整保留 custom_* 自定义上传字体键；
 * 2. getByPath / setByPath 路径访问与自动建中间层行为；
 * 3. readFlatSettingValue / writeFlatSettingValue 类型转换（倍率转数字、字体归一化）；
 * 4. getModeSetting / setModeSetting 缺省回落 DEFAULT_SETTINGS.modeSettings 与隔离写入。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = await import(new URL('../../web/src/core/settingsStore.js', import.meta.url));
const { DEFAULT_SETTINGS } = await import(new URL('../../web/src/config/defaults.js', import.meta.url));

test('normalizeFontKey：所有内置短键与完整字体栈均归一化为短键', () => {
    assert.equal(store.normalizeFontKey(undefined), 'default');
    assert.equal(store.normalizeFontKey(''), 'default');
    assert.equal(store.normalizeFontKey('inherit'), 'default');
    assert.equal(store.normalizeFontKey("'Microsoft YaHei', sans-serif"), 'default');

    for (const [key, stack] of Object.entries(store.BUILTIN_FONT_FAMILY_MAP)) {
        assert.equal(store.normalizeFontKey(key), key);
        assert.equal(store.normalizeFontKey(stack), key, `完整字体栈应映射回 ${key}`);
        assert.equal(store.normalizeFontKey(stack.toUpperCase()), key, `大小写不敏感映射 ${key}`);
    }
    assert.equal(store.normalizeFontKey('monospace'), 'mono');
});

test('normalizeFontKey：保留 custom_* 自定义字体键且不被内置表覆盖', () => {
    assert.equal(store.normalizeFontKey('custom_myfont_123'), 'custom_myfont_123');
    assert.equal(store.normalizeFontKey('  custom_lxgw_wenkai  '), 'custom_lxgw_wenkai');
    assert.equal(store.normalizeFontKey("'Some Third Party Font', sans-serif"), "'Some Third Party Font', sans-serif");
});

test('getByPath / setByPath：读取、回落与深层写入自动补中间对象', () => {
    const obj = { a: { b: 42 }, zero: 0, off: false };
    assert.equal(store.getByPath(obj, 'a.b', 99), 42);
    assert.equal(store.getByPath(obj, 'zero', 99), 0);
    assert.equal(store.getByPath(obj, 'off', true), false);
    assert.equal(store.getByPath(obj, 'a.missing.deep', 'fb'), 'fb');
    assert.equal(store.getByPath(null, 'a.b', 'fb'), 'fb');

    assert.equal(store.setByPath(obj, 'x.y.z', 'hello'), true);
    assert.equal(obj.x.y.z, 'hello');
    assert.equal(store.setByPath(null, 'x.y', 1), false);
});

test('readFlatSettingValue / writeFlatSettingValue：倍率与字体键规范化', () => {
    const mockSettings = {
        playback: { defaultPlayMode: 'random', defaultRate: 1.5 },
        audio: { defaultEqPreset: 'rock' },
        interface: { fontFamily: store.BUILTIN_FONT_FAMILY_MAP.kai },
        ai: { provider: 'gemini' },
        quality: { qqPlayback: 'flac', neteasePlayback: 'hires', kugouDownload: 'lossless' },
        background: { mvUpscaleTier: 'B' },
    };

    assert.equal(store.readFlatSettingValue('defaultPlayMode', mockSettings), 'random');
    assert.equal(store.readFlatSettingValue('defaultRate', mockSettings), '1.5');
    assert.equal(store.readFlatSettingValue('mvUpscaleTier', mockSettings), 'B');
    assert.equal(store.readFlatSettingValue('nonexistentKey', mockSettings), '');

    assert.equal(store.writeFlatSettingValue('defaultRate', '1.25', mockSettings), true);
    assert.equal(mockSettings.playback.defaultRate, 1.25);

    assert.equal(store.writeFlatSettingValue('fontFamily', store.BUILTIN_FONT_FAMILY_MAP.fangsong, mockSettings), true);
    assert.equal(mockSettings.interface.fontFamily, 'fangsong');

    assert.equal(store.writeFlatSettingValue('fontFamily', 'custom_test_1', mockSettings), true);
    assert.equal(mockSettings.interface.fontFamily, 'custom_test_1');

    assert.equal(store.writeFlatSettingValue('unknownKey', 'v', mockSettings), false);
});

test('getModeSetting / setModeSetting：缺省回落 DEFAULT_SETTINGS.modeSettings 并隔离写入', () => {
    const mockSettings = { modeSettings: {} };
    const pvDefColor = DEFAULT_SETTINGS.modeSettings?.pv?.themeColor;
    assert.equal(store.getModeSetting('pv', 'themeColor', '#fff', mockSettings), pvDefColor);
    assert.equal(store.getModeSetting('pv', 'missingParam', 77, mockSettings), 77);

    assert.equal(store.setModeSetting('pv', 'customProp', 'abc', mockSettings), true);
    assert.equal(store.getModeSetting('pv', 'customProp', null, mockSettings), 'abc');
    assert.equal(store.setModeSetting('', 'k', 1, mockSettings), false);
});
