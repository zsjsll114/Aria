/* ============================================================
 * tests/js/test_theme_mod.js — 外观 mod 文件（.aria-theme.json）契约
 *
 * 外观 mod = 「一段带名字的配方」。分享码与 mod 文件是同一份数据的两种载体，
 * 共用 core/vfxRecipe.js 的同一套白名单校验 —— 这份测试就是那条契约的钉子。
 *
 * 最重要的一条是 M1：仓库里随附的 mod 文件必须**真能通过校验**。
 * 手写 JSON 最容易出的错是某个模式用了它不支持的键、或数值越界，
 * 而那种错在 UI 上的表现是「导入被拒，逐条列原因」——用户看到的是坏 mod，
 * 不是坏代码。放在 CI 上挡住，作者本人才会第一时间发现。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    INTERFACE_FIELDS, THEME_MOD_VERSION, collectRecipe, parseThemeMod,
    serializeThemeMod,
} from '../../web/src/core/vfxRecipe.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const MODS_DIR = path.join(REPO, 'mods');

/** 一份最小的合法配方（两键 => 过得了「全空配方」那道门） */
const MINIMAL_RECIPE = { sv: 1, interface: { themeColor: '#4285F4' } };

function modFile(recipe, extra) {
    return JSON.stringify(Object.assign({ ariaTheme: THEME_MOD_VERSION, recipe }, extra || {}));
}

test('M1 仓库随附的每个 mod 文件都必须真能通过白名单校验', () => {
    assert.ok(fs.existsSync(MODS_DIR), 'mods/ 目录必须存在');
    const files = fs.readdirSync(MODS_DIR).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, 'mods/ 下至少要有随附的 mod 文件');
    for (const f of files) {
        const text = fs.readFileSync(path.join(MODS_DIR, f), 'utf8');
        const r = parseThemeMod(text);
        assert.ok(r.ok, `${f} 校验失败：` + (r.ok ? '' : JSON.stringify(r.errors)));
        assert.ok(r.meta.name, `${f} 必须带 name 字段（导入时用作配方名）`);
        assert.ok(r.meta.description, `${f} 建议带 description（导入确认框里会展示）`);
        assert.equal(r.recipe.sv, 1, `${f} 的 recipe.sv 必须是当前 schema 版本`);
    }
});

test('M2 mod 文件顶层只认 5 个键，多出来的（含敏感键）必须报错而不是静默忽略', () => {
    const unknown = parseThemeMod(modFile(MINIMAL_RECIPE, { tokenOverride: { '--aria-accent': '#f00' } }));
    assert.equal(unknown.ok, false, '顶层未知键必须被拒（静默忽略会变成"改了没反应"）');
    assert.equal(unknown.errors[0].code, 'unknown-field');

    const forbidden = parseThemeMod(modFile(MINIMAL_RECIPE, { apiKey: 'sk-secret' }));
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.errors[0].code, 'forbidden-key');
});

test('M3 裸配方对象也是合法 mod（分享码里的那段 JSON 可直接存成文件）', () => {
    const r = parseThemeMod(JSON.stringify(MINIMAL_RECIPE));
    assert.ok(r.ok, JSON.stringify(r.ok ? '' : r.errors));
    assert.deepEqual(r.recipe, MINIMAL_RECIPE);
    assert.deepEqual(r.meta, { name: '', author: '', description: '' });
});

test('M4 往返不变：serialize → parse 得到同一份配方', () => {
    const recipe = {
        sv: 1,
        mode: 'lyrics',
        interface: { themeColor: '#8AB4F8', glassStrength: 0, compactMode: true, vfxIntensity: 15 },
        lyrics: { align: 'left', fontSize: 1.15 },
    };
    const text = serializeThemeMod(recipe, { name: '往返', author: 'a', description: 'd' });
    const back = parseThemeMod(text);
    assert.ok(back.ok, JSON.stringify(back.ok ? '' : back.errors));
    assert.deepEqual(back.recipe, recipe);
    assert.equal(back.meta.name, '往返');
    assert.equal(back.meta.author, 'a');
});

test('M5 拒绝面：坏 JSON / 版本不符 / 空文件 / 超长', () => {
    const badJson = parseThemeMod('{oops');
    assert.equal(badJson.ok, false);
    assert.equal(badJson.errors[0].code, 'bad-json');

    const badVer = parseThemeMod(JSON.stringify({ ariaTheme: 99, recipe: MINIMAL_RECIPE }));
    assert.equal(badVer.ok, false);
    assert.equal(badVer.errors[0].code, 'bad-mod-version');

    const empty = parseThemeMod('   ');
    assert.equal(empty.ok, false);
    assert.equal(empty.errors[0].code, 'empty-text');

    const long = parseThemeMod('x'.repeat(20001));
    assert.equal(long.ok, false);
    assert.equal(long.errors[0].code, 'too-large');
});

test('M6 mod 的展示字段是外部输入：控制字符必须剥掉、长度必须截断', () => {
    const r = parseThemeMod(modFile(MINIMAL_RECIPE, {
        name: 'x\u0000y\nz',
        author: 'a'.repeat(80),
        description: 'd'.repeat(300),
    }));
    assert.ok(r.ok);
    /* 不用正则写控制字符类：eslint 的 no-control-regex 会直接报 error */
    const hasControlChar = Array.from(String(r.meta.name))
        .some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
    assert.ok(!hasControlChar, '控制字符必须被剥掉：' + JSON.stringify(r.meta.name));
    assert.equal(r.meta.author.length, 40);
    assert.equal(r.meta.description.length, 160);
});

test('M7 动效强度已进配方：显式值收，null（跟随性能档）不收', () => {
    assert.ok(INTERFACE_FIELDS.vfxIntensity, 'vfxIntensity 必须在 INTERFACE_FIELDS 里');

    const withVal = collectRecipe({ interface: { vfxIntensity: 30 } }, '');
    assert.equal(withVal.interface.vfxIntensity, 30);

    /* null = 用户没表过态（跟随性能档）：它不是"要这个值"，收了会把人家的档位钉死 */
    const withNull = collectRecipe({ interface: { vfxIntensity: null } }, '');
    assert.equal(withNull.interface, undefined, 'null 不该进配方');

    const outOfRange = collectRecipe({ interface: { vfxIntensity: 500 } }, '');
    assert.equal(outOfRange.interface, undefined, '越界值不该进配方');
});

test('M8 端到端：采集 → 导出 mod 文本 → 读回，配方逐键一致', () => {
    const settings = {
        interface: { themeColor: '#8AB4F8', glassStrength: 0, compactMode: true, vfxIntensity: 15, language: 'zh-CN' },
        lyrics: { fontSize: 1.15, align: 'left', showRomaji: false },
        background: { dynamicBg: false, blur: 0, brightness: 0.18, swayEnabled: false },
        modeSettings: {
            lyrics: { align: 'left', bgBlur: 0, emotionGlow: 0 },
            letterpress: { themeColor: '#8AB4F8', emotionGlow: 0 },
        },
    };
    const recipe = collectRecipe(settings, 'lyrics');
    const text = serializeThemeMod(recipe, { name: '端到端' });
    const back = parseThemeMod(text);
    assert.ok(back.ok, JSON.stringify(back.ok ? '' : back.errors));
    assert.deepEqual(back.recipe, recipe);
    /* language 是「不能进配方」的，必须确实没进去 */
    assert.ok(!/language/.test(text), '语言偏好不该出现在 mod 文件里');
    assert.ok(back.recipe.modeSettings.letterpress, '各模式版式必须带上');
});

test('M9 导出一份不合法配方时必须抛错，而不是写出一个坏文件', () => {
    assert.throws(() => serializeThemeMod({ sv: 1, lyrics: { fontSize: 99 } }, {}), /不合法/);
});
