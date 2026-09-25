/* ============================================================
 * tests/js/test_vfx_recipe.js — core/vfxRecipe.js 行为回归（todos #9 视觉配方）
 *
 * 盯住五条「外部输入入口」的性质，它们都是「编译期看不出来、跑一次也不一定撞」的：
 *   1. 往返一致：collect → encode → decode 必须回到同一份值（含数字字符串归一化），
 *      且校验和稳定（canonicalJSON 键排序）——不稳定的话用户第二次复制的代码就解不开。
 *   2. 版本不符必须拒绝：前缀版本号与 payload.sv 两处分别检查。
 *   3. 超范围/类型错/未知键一律拒绝并给出条目 ——「静默写入半份配方」是本功能
 *      最难查的 bug（用户以为导入了，其实是某根滑杆没落上去）。
 *   4. 恶意字符串不产生副作用：原型污染键、超长串、伪颜色串（要落进
 *      style.textContent 的模板）都不得改变全局对象原型，也不得被收下。
 *   5. 敏感键（apiKey / token / 路径 / 登录态）在编码侧结构上进不去、
 *      在解码侧被点名拒绝；且校验失败时 appSettings 一个字节都没被改。
 * 手法：纯逻辑，不 stub DOM ——core 零 DOM 依赖正是为了能这样测。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const R = await import('../../web/src/core/vfxRecipe.js');
const { DEFAULT_SETTINGS } = await import('../../web/src/config/defaults.js');

/* 一份「像真的」appSettings：深拷默认值，再塞进若干必须被挡在外面的东西 */
function makeSettings() {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    s.lyrics.fontSize = 1.35;
    s.lyrics.blurLevel = 6;
    s.lyrics.align = 'center';
    s.lyrics.highlightInactiveColor = 'rgba(255,255,255,0.6)';
    s.background.blur = 90;
    s.background.brightness = 0.2;
    s.background.swayAmp = 18;
    s.interface.themeColor = '#66ccff';
    s.interface.glassStrength = 44;
    s.interface.fontFamily = 'kai';
    s.interface.compactMode = true;
    /* modeSettings 里的值故意写成滑块产出的字符串形状（200 就是这么存的），
       归一化不认它的话真实用户配置会被当成非法值拒掉 */
    s.modeSettings.pv.fontSize = '1.5';
    s.modeSettings.pv.cameraSpeed = 0.8;
    s.modeSettings.pv.showHud = false;
    s.modeSettings.tunnel.rowGap = '120';
    s.modeSettings.wordcloud.wcFontMax = 4.5;
    /* —— 以下全都不该进配方 —— */
    s.ai.apiKey = 'sk-super-secret-should-never-leave';
    s.ai.providerConfigs.openai.apiKey = 'sk-another-secret';
    s.nowPlaying.url = 'http://localhost:9863/api/query';
    s.quality.qqPlayback = 'flac';
    s.shortcuts.next = 'F9';
    s.interface.language = 'en-US';
    s.interface.desktopLyrics.fontSize = 60;
    s.interface.advancedFonts.fonts = { custom_a: 'C:\\Users\\boo\\fonts\\x.woff2' };
    s.interface.vfxRecipes = { items: [{ name: '已有的配方', recipe: { sv: 1, mode: 'pv' } }] };
    return s;
}

const SECRET_MARKERS = [
    'sk-super-secret', 'sk-another-secret', 'localhost:9863', 'boo',
    'woff2', 'apiKey', 'apiBase', 'providerConfigs', 'desktopLyrics',
    'advancedFonts', 'vfxRecipes', 'en-US', 'flac', '"F9"', '已有的配方',
];

/* ---------- 1. 往返一致 ---------- */

test('collect → encode → decode 回到同一份配方', () => {
    const recipe = R.collectRecipe(makeSettings(), 'pv');
    const code = R.encodeRecipe(recipe);
    const back = R.decodeRecipe(code);
    assert.equal(back.ok, true, JSON.stringify(back.errors));
    assert.deepEqual(back.recipe, recipe);
});

test('分享的码带真实模式与四个组的值（不是空壳）', () => {
    const recipe = R.collectRecipe(makeSettings(), 'pv');
    assert.equal(recipe.mode, 'pv');
    assert.equal(recipe.lyrics.fontSize, 1.35);
    assert.equal(recipe.lyrics.highlightInactiveColor, 'rgba(255,255,255,0.6)');
    assert.equal(recipe.background.blur, 90);
    assert.equal(recipe.interface.themeColor, '#66ccff');
    assert.equal(recipe.interface.compactMode, true);
    assert.equal(recipe.modeSettings.pv.showHud, false);
});

test('滑块写进的数字字符串归一化为数字（否则真实配置会被当非法值拒掉）', () => {
    const recipe = R.collectRecipe(makeSettings(), 'pv', R.VIEW_MODES);
    assert.equal(recipe.modeSettings.pv.fontSize, 1.5);
    assert.equal(typeof recipe.modeSettings.pv.fontSize, 'number');
    assert.equal(recipe.modeSettings.tunnel.rowGap, 120);
    assert.equal(typeof recipe.modeSettings.tunnel.rowGap, 'number');
});

test('校验和稳定：同一配方的两次编码逐字节相同，且乱序 key 也相同', () => {
    const a = R.encodeRecipe({ sv: 1, mode: 'pv', lyrics: { fontSize: 1.2, align: 'left' } });
    const b = R.encodeRecipe({ lyrics: { align: 'left', fontSize: 1.2 }, mode: 'pv', sv: 1 });
    assert.equal(a, b);
});

test('只带一个组时不会把其它组写成默认值（应用是覆盖而非重建）', () => {
    const only = { sv: 1, background: { blur: 30 } };
    const settings = makeSettings();
    const before = JSON.parse(JSON.stringify(settings));
    assert.equal(R.applyRecipeToSettings(settings, only).ok, true);
    assert.equal(settings.background.blur, 30);
    assert.deepEqual(settings.lyrics, before.lyrics);
    assert.deepEqual(settings.interface, before.interface);
    assert.deepEqual(settings.modeSettings, before.modeSettings);
});

test('applyRecipeToSettings 把四个组写进 appSettings 并保留配方没提的键', () => {
    const settings = makeSettings();
    const recipe = R.collectRecipe(settings, 'tunnel');
    settings.modeSettings.pv.halftoneSize = 11;
    const res = R.applyRecipeToSettings(settings, recipe);
    assert.equal(res.ok, true);
    /* lyrics.blurLevel 会被 active 模式（tunnel）的版式偏好 shadow 掉：
       collectRecipe 把 modeSettings.tunnel.blurLevel（默认 5）一并采进配方，
       applyRecipeToSettings 尾部 shadowInto 按「模式偏好 > 全局配方值」归一
       （与 190 运行时判定一致，见其尾部注释）——所以是 5 不是全局配方写的 6 */
    assert.equal(res.shadowedByMode > 0, true, '模式偏好应 shadow 全局配方值');
    assert.equal(settings.lyrics.blurLevel, settings.modeSettings.tunnel.blurLevel);
    assert.equal(settings.modeSettings.tunnel.rowGap, 120);
    assert.equal(settings.modeSettings.pv.halftoneSize, 11, '配方没提的键必须原样留下');
});

/* ---------- 2. 版本不符 ---------- */

test('前缀版本号不符 → 拒绝（拿 v9 的码不该被当成本版本解析）', () => {
    const code = R.encodeRecipe({ sv: 1, mode: 'pv', lyrics: { align: 'left' } });
    const v9 = code.replace(/^AriaVFX1\./, 'AriaVFX9.');
    const back = R.decodeRecipe(v9);
    assert.equal(back.ok, false);
    assert.equal(back.errors[0].code, 'version-prefix-mismatch');
});

test('payload 内 sv 与本版本不符 → 拒绝（前缀被手改成对的也拦得住）', () => {
    const json = R.canonicalJSON({ sv: 2, mode: 'pv', lyrics: { align: 'left' } });
    const code = 'AriaVFX1.' + R.base64urlEncode(Buffer.from(json, 'utf8')) + '.' + R.checksum32(json);
    const back = R.decodeRecipe(code);
    assert.equal(back.ok, false);
    assert.equal(back.errors[0].code, 'schema-version-mismatch');
});

test('sv 写成非整数 → 拒绝', () => {
    const v = R.validateRecipe({ sv: 1.5, mode: 'pv' });
    assert.equal(v.ok, false);
    assert.equal(v.errors[0].code, 'bad-schema-version');
});

/* ---------- 3. 超范围 / 类型 / 未知键 ---------- */

test('超范围数值一律拒绝并点名参数', () => {
    const cases = [
        [{ sv: 1, background: { blur: 100000 } }, 'background.blur'],
        [{ sv: 1, background: { blur: -5 } }, 'background.blur'],
        [{ sv: 1, lyrics: { blurLevel: 99 } }, 'lyrics.blurLevel'],
        [{ sv: 1, lyrics: { fontSize: 0 } }, 'lyrics.fontSize'],
        [{ sv: 1, interface: { glassStrength: 9999 } }, 'interface.glassStrength'],
        [{ sv: 1, modeSettings: { pv: { cameraZoom: 1e9 } } }, 'modeSettings.pv.cameraZoom'],
    ];
    for (const [recipe, path] of cases) {
        const v = R.validateRecipe(recipe);
        assert.equal(v.ok, false, path + ' 该被拒');
        assert.ok(v.errors.some(e => e.path === path && (e.code === 'out-of-range' || e.code === 'bad-number')),
            path + ' 的错误码不对：' + JSON.stringify(v.errors));
    }
});

test('类型不对 / 枚举越界 / 非整数都拒', () => {
    assert.equal(R.validateRecipe({ sv: 1, lyrics: { align: 'justify' } }).ok, false);
    assert.equal(R.validateRecipe({ sv: 1, lyrics: { blurLevel: 3.5 } }).errors[0].code, 'not-integer');
    assert.equal(R.validateRecipe({ sv: 1, lyrics: { showRomaji: 'maybe' } }).ok, false);
    assert.equal(R.validateRecipe({ sv: 1, mode: 'karaokemode' }).errors[0].code, 'bad-enum');
    assert.equal(R.validateRecipe({ sv: 1, modeSettings: { karaoke: { fontSize: 1 } } }).errors[0].code, 'unknown-mode');
});

test('未知键拒绝而不是静默丢弃（静默会让用户以为滑杆坏了）', () => {
    const v = R.validateRecipe({ sv: 1, lyrics: { fontSize: 1.2, madeUpKnob: 7 } });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => e.path === 'lyrics.madeUpKnob' && e.code === 'unknown-field'));
});

test('颜色只收安全写法：伪颜色串（会落进 style.textContent）必须拒', () => {
    const bad = [
        '#fff; background:url(https://evil)',
        'expression(alert(1))',
        '#12345',
        'url(https://evil/x)',
        '#fff}\\}{color:red',
        'rgb(255,255,255,0.6);x',
    ];
    for (const c of bad) {
        assert.equal(R.validateRecipe({ sv: 1, lyrics: { highlightColor: c } }).ok, false, c + ' 竟被收下');
    }
    for (const c of ['#fff', '#ffffff', '#FFFFFFFF', 'rgba(255,255,255,0.6)', 'rgb(1,2,3)']) {
        assert.equal(R.validateRecipe({ sv: 1, lyrics: { highlightColor: c } }).ok, true, c + ' 该被收下');
    }
});

test('字体只收内置键；CSS stack 与自定义字体引用一律拒（那是 CSS 注入面 + 本机死链）', () => {
    for (const f of R.BUILTIN_FONTS) {
        assert.equal(R.validateRecipe({ sv: 1, interface: { fontFamily: f } }).ok, true, f + ' 该被收下');
    }
    for (const f of [
        "'SimHei', sans-serif", "'Noto Sans SC', sans-serif", 'custom_2024_song',
        'kai; color:red', '<script>', 'font}x', 'kai}', '  kai', 'url(x)', '@import "evil"',
    ]) {
        assert.equal(R.validateRecipe({ sv: 1, interface: { fontFamily: f } }).ok, false, f + ' 竟被收下');
    }
    /* 编码侧：用户存的是 stack 时该安静跳过这个键，而不是把 stack 分享出去 */
    const s = makeSettings();
    s.interface.fontFamily = "'Noto Sans SC', sans-serif";
    s.modeSettings.pv.fontFamily = 'custom_my_font';
    const recipe = R.collectRecipe(s, 'pv');
    assert.equal(recipe.interface.fontFamily, undefined, '不可分享的字体不该进配方');
    assert.equal(recipe.modeSettings.pv.fontFamily, undefined);
});

test('空配方拒绝（否则会显示「导入成功」却什么都没变）', () => {
    assert.equal(R.validateRecipe({ sv: 1 }).ok, false);
    assert.equal(R.validateRecipe({ sv: 1, lyrics: {} }).errors[0].code, 'empty');
});

/* ---------- 4. 恶意字符串不产生副作用 ---------- */

test('原型污染：JSON 文本里的 __proto__ 既是未知键也污染不到 Object.prototype', () => {
    /* 对象字面量里的 __proto__: 会改原型链而不是造出自有键，
       所以必须经 JSON.parse 才能复现「外部数据带 __proto__ 键」的真实形状 */
    const json = R.canonicalJSON({ sv: 1, lyrics: { fontSize: 1.2 } })
        .slice(0, -1) + ',"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}';
    const code = 'AriaVFX1.' + R.base64urlEncode(Buffer.from(json, 'utf8')) + '.' + R.checksum32(json);
    const back = R.decodeRecipe(code);
    assert.equal(back.ok, false, '污染键该被当未知键拒绝');
    assert.ok(back.errors.some(e => e.code === 'unknown-field'), JSON.stringify(back.errors));
    assert.equal({}.polluted, undefined);
    assert.equal({}.polluted2, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    /* 编码侧同样带不上去 */
    const enc = R.encodeRecipe(R.collectRecipe(makeSettings(), 'pv'));
    assert.ok(!/polluted|__proto__|constructor/i.test(enc));
});

test('校验和被改一个字符 → 拒绝（截断/粘错的码不会写进设置）', () => {
    const code = R.encodeRecipe({ sv: 1, lyrics: { fontSize: 1.2 } });
    const last = code.slice(-1);
    const flipped = last === '0' ? '1' : '0';
    assert.equal(R.decodeRecipe(code).ok, true, '原码该能解开');
    const back = R.decodeRecipe(code.slice(0, -1) + flipped);
    assert.equal(back.ok, false);
    assert.equal(back.errors[0].code, 'checksum-mismatch');
    /* 中间少粘一段：payload 变了 → 校验和对不上（结构也一起坏时同样是拒） */
    const chopped = code.slice(0, 14) + code.slice(18);
    const back2 = R.decodeRecipe(chopped);
    assert.equal(back2.ok, false);
    assert.ok(['checksum-mismatch', 'bad-structure', 'bad-base64', 'bad-json', 'bad-utf8']
        .includes(back2.errors[0].code), back2.errors[0].code);
});

test('非分享码 / 空串 / 超长串：拒绝而不是抛异常', () => {
    for (const junk of ['', '   ', null, undefined, 'hello world', 'AriaEQ1.eyJnIjpbXX0=']) {
        const back = R.decodeRecipe(junk);
        assert.equal(back.ok, false, String(junk) + ' 竟被接受');
        assert.ok(Array.isArray(back.errors) && back.errors.length === 1);
    }
    const back = R.decodeRecipe('AriaVFX1.' + 'A'.repeat(R.MAX_CODE_CHARS));
    assert.equal(back.ok, false);
    assert.equal(back.errors[0].code, 'too-large');
});

test('payload 声明得很大也撑不爆：字节数超限即拒', () => {
    const big = R.base64urlEncode(new Array(200000).fill(65));
    const back = R.decodeRecipe('AriaVFX1.' + big + '.00000000');
    assert.equal(back.ok, false);
    assert.equal(back.errors[0].code, 'too-large');
});

test('恶意名字清洗后不含标签/控制字符，且渲染侧仍需 esc()', () => {
    const evil = '<img src=x onerror="alert(1)">  \u0000\u001f  换   行\n名字';
    const clean = R.sanitizeRecipeName(evil);
    assert.ok(!/[<>{}"'`\\]/.test(clean), clean);
    /* 用码点扫而不是 /[\x00-\x1f]/：测试侧的 no-control-regex 是 error 级，
       而这里要证的正是「控制字符没被留下」 */
    let hasControl = false;
    for (let i = 0; i < clean.length; i++) {
        const c = clean.codePointAt(i);
        if (c < 0x20 || c === 0x7f) hasControl = true;
    }
    assert.equal(hasControl, false, JSON.stringify(clean));
    assert.ok(clean.length <= R.MAX_NAME_CHARS);
    const long = '很'.repeat(300);
    assert.equal(R.sanitizeRecipeName(long).length, R.MAX_NAME_CHARS);
    assert.equal(R.sanitizeRecipeName('   '), '');
});

/* ---------- 5. 敏感键 ---------- */

test('编码侧结构上收不到敏感数据（分享码里搜不到任何一个标记）', () => {
    const code = R.encodeRecipe(R.collectRecipe(makeSettings(), 'pv'));
    const back = R.decodeRecipe(code);
    assert.equal(back.ok, true);
    const decodedText = R.canonicalJSON(back.recipe);
    for (const marker of SECRET_MARKERS) {
        assert.ok(!code.includes(marker), '码文本里出现了敏感标记：' + marker);
        assert.ok(!decodedText.includes(marker), '配方里出现了敏感标记：' + marker);
    }
});

test('解码侧遇到敏感键是「点名拒绝」而不是含糊的未知键', () => {
    const v = R.validateRecipe({
        sv: 1,
        lyrics: { fontSize: 1.2 },
        ai: { apiKey: 'sk-x' },
        interface: { token: 'abc', language: 'en-US' },
    });
    assert.equal(v.ok, false);
    const codes = v.errors.map(e => e.code);
    assert.ok(codes.includes('forbidden-key'), JSON.stringify(v.errors));
    for (const p of ['ai', 'interface.token', 'interface.language']) {
        assert.ok(v.errors.some(e => e.path === p), '漏了 ' + p);
    }
});

test('敏感键判定覆盖登录态与令牌的各种写法', () => {
    for (const k of ['token', 'SESSION_TOKEN', 'cookie', 'q36', 'musicu', 'password', 'secret', 'apiKey']) {
        assert.equal(R.isForbiddenKey(k), true, k + ' 该被认成敏感键');
    }
    /* 反面：常见视觉参数名不能被误判（否则功能会自断） */
    for (const k of ['blurLevel', 'fontSize', 'highlightColor', 'themeColor', 'showTranslation', 'cameraSpeed']) {
        assert.equal(R.isForbiddenKey(k), false, k + ' 被误判为敏感键');
    }
});

test('FORBIDDEN_KEYS 每一项都有理由，且没有一个键会被白名单收进来', () => {
    const fields = new Set([
        ...Object.keys(R.LYRICS_FIELDS), ...Object.keys(R.BACKGROUND_FIELDS),
        ...Object.keys(R.INTERFACE_FIELDS), ...Object.keys(R.MODE_FIELD_POOL),
    ]);
    for (const f of R.FORBIDDEN_KEYS) {
        assert.ok(typeof f.key === 'string' && f.key.length > 0);
        assert.ok(typeof f.reason === 'string' && f.reason.length > 8, f.key + ' 缺理由');
        assert.equal(fields.has(f.key), false, f.key + ' 同时在白名单和黑名单里');
    }
});

test('校验失败时 applyRecipeToSettings 一个字节都不写', () => {
    const settings = makeSettings();
    const before = JSON.stringify(settings);
    const res = R.applyRecipeToSettings(settings, { sv: 1, lyrics: { fontSize: 99 } });
    assert.equal(res.ok, false);
    assert.equal(JSON.stringify(settings), before, '非法配方不得改动 appSettings');
});

test('非法配方在 encode 阶段就抛错（不会产出一个解不开的码）', () => {
    assert.throws(() => R.encodeRecipe({ sv: 1, lyrics: { fontSize: 99 } }), /配方不合法/);
});

/* ---------- 预设清单纯函数 ---------- */

test('同名预设是覆盖，不同名是新增；重名不产生两条', () => {
    const r = { sv: 1, lyrics: { fontSize: 1.2 } };
    let res = R.upsertPreset([], { name: '夜窗', recipe: r });
    assert.equal(res.action, 'added');
    assert.equal(res.list.length, 1);
    const firstId = res.list[0].id;
    res = R.upsertPreset(res.list, { name: '夜窗', recipe: { sv: 1, lyrics: { fontSize: 1.8 } } });
    assert.equal(res.action, 'overwritten');
    assert.equal(res.list.length, 1);
    assert.equal(res.list[0].id, firstId, '覆盖要保住原 id，否则 UI 选中会跳');
    assert.equal(res.list[0].recipe.lyrics.fontSize, 1.8);
    res = R.upsertPreset(res.list, { name: ' 晨雾 ', recipe: r });
    assert.equal(res.list.length, 2);
    assert.equal(res.list[1].name, '晨雾', '名字要 trim');
});

test('空名 / 非法配方 / 超出上限都拒绝，且不动原清单', () => {
    const r = { sv: 1, lyrics: { fontSize: 1.2 } };
    const base = R.upsertPreset([], { name: 'ok', recipe: r }).list;
    assert.equal(R.upsertPreset(base, { name: '   ', recipe: r }).action, 'rejected');
    assert.equal(R.upsertPreset(base, { name: '坏', recipe: { sv: 1, lyrics: { fontSize: 99 } } }).action, 'rejected');
    assert.equal(R.upsertPreset(base, { name: '坏', recipe: { sv: 1, ai: { apiKey: 'x' } } }).reason, 'invalid-recipe');
    const full = Array.from({ length: R.MAX_PRESETS }, (_, i) => ({ id: 'x' + i, name: 'n' + i, recipe: r, createdAt: 0, updatedAt: 0 }));
    assert.equal(R.upsertPreset(full, { name: '再来一个', recipe: r }).reason, 'too-many');
    assert.equal(R.upsertPreset(full, { name: '再来一个', recipe: r }).list.length, R.MAX_PRESETS);
});

test('重命名：撞名拒绝，找不到 id 拒绝', () => {
    let list = R.upsertPreset([], { name: 'A', recipe: { sv: 1, mode: 'pv' } }).list;
    list = R.upsertPreset(list, { name: 'B', recipe: { sv: 1, mode: 'lyrics' } }).list;
    assert.equal(R.renamePreset(list, list[0].id, 'B').reason, 'duplicate-name');
    assert.equal(R.renamePreset(list, 'nope', 'C').reason, 'not-found');
    assert.equal(R.renamePreset(list, list[0].id, '<b>C</b>').list[0].name, 'bC/b');
    assert.equal(R.removePreset(list, list[1].id).list.length, 1);
    assert.equal(R.removePreset(list, 'nope').action, 'rejected');
});

test('normalizePresetList 能扛住用户手改过的存储：坏条目丢掉、脏 id 换掉、好条目留下', () => {
    const out = R.normalizePresetList([
        null, 'x', 42,
        { name: '好', recipe: { sv: 1, lyrics: { fontSize: 1.2 } } },
        { name: '坏值', recipe: { sv: 1, lyrics: { fontSize: 1e9 } } },
        { name: '敏感', recipe: { sv: 1, ai: { apiKey: 'x' } } },
        { name: '好', recipe: { sv: 1, mode: 'pv' } },
        { name: '脏 id', id: '__proto__', recipe: { sv: 1, mode: 'neon' } },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(p => p.name), ['好', '脏 id']);
    assert.notEqual(out[1].id, '__proto__');
    assert.ok(out.every(p => p.id && /^[A-Za-z0-9_-]+$/.test(p.id)));
    assert.equal({}.polluted, undefined);
});

/* ---------- schema 自校对：别和 defaults.js 走散 ---------- */

test('schema 覆盖 defaults.js modeSettings 的每一个键（漏一个就存不下来）', () => {
    const missing = [];
    for (const mode of Object.keys(DEFAULT_SETTINGS.modeSettings)) {
        assert.ok(R.MODE_FIELDS_BY_MODE[mode], '缺模式 ' + mode);
        for (const key of Object.keys(DEFAULT_SETTINGS.modeSettings[mode])) {
            const inList = (R.MODE_FIELDS_BY_MODE[mode] || []).indexOf(key) >= 0;
            const inPool = Object.prototype.hasOwnProperty.call(R.MODE_FIELD_POOL, key);
            if (!inList || !inPool) missing.push(mode + '.' + key);
        }
    }
    assert.deepEqual(missing, [], '这些默认键没被 schema 覆盖：' + missing.join(', '));
});

test('schema 里的每个模式都在 VIEW_MODES 里，每个字段都有校验规则', () => {
    for (const mode of Object.keys(R.MODE_FIELDS_BY_MODE)) {
        assert.ok(R.VIEW_MODES.includes(mode), '模式 ' + mode + ' 不在 VIEW_MODES');
        for (const key of R.MODE_FIELDS_BY_MODE[mode]) {
            assert.ok(R.MODE_FIELD_POOL[key], key + ' 缺校验规则');
        }
    }
    for (const g of R.RECIPE_GROUPS) assert.ok(g.label && g.desc, g.key + ' 缺 UI 说明');
});

test('真实默认配置能被完整收集回来（含九个模式）', () => {
    const all = R.collectRecipe(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), 'cover', R.VIEW_MODES);
    assert.equal(all.mode, 'cover');
    assert.equal(Object.keys(all.modeSettings).length, R.VIEW_MODES.length);
    const back = R.decodeRecipe(R.encodeRecipe(all));
    assert.equal(back.ok, true, JSON.stringify(back.errors));
    assert.deepEqual(back.recipe, all);
});

test('默认配置收集回来的配方里没有黑名单键（interface 只留观感那四个）', () => {
    const all = R.collectRecipe(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), 'cover');
    assert.deepEqual(Object.keys(all.interface).sort(),
        ['compactMode', 'fontFamily', 'glassStrength', 'themeColor']);
    assert.equal(all.interface.language, undefined);
    assert.equal(all.interface.desktopLyrics, undefined);
    assert.equal(all.interface.advancedFonts, undefined);
    assert.equal(all.interface.lyricWidth, undefined, '有键无实现的死键不该进来');
    assert.equal(all.ai, undefined);
});
