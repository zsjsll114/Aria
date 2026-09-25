/* ============================================================
 * tests/js/test_i18n_coverage.js — i18n 词表单一化 + 覆盖复扫门禁的行为测试
 * 运行方式：node --test tests/js/test_i18n_coverage.js
 *
 * 守的四件事：
 *  1. 复扫脚本本身有牙：合成片段里的未登记 UI 串必须被点名，
 *     带 {占位符} 的动态句必须被放过（AGENTS 约束 7 的边界）。
 *  2. 日志正文不算漏（AGENTS 约束 9 允许中文日志），否则门禁第一天就会被当噪音绕开。
 *  3. 284 的私有 PHRASE_EN 真的删干净了、并且改成走共享词表 ——
 *     「迁进来但还在用自己那份」是最容易发生的假接管。
 *  4. 迁移时与既有键同名的条目**保留的是既有英文值**，没被 284 的写法覆盖。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { setLanguage, translatePhrase, getLanguage } from '../../web/src/core/i18n.js';
import { scanSources, isPhraseRegistered } from '../../scripts/audits/i18n-coverage.mjs';

const DIAG = 'web/src/app/284-diagnostics.js';

/** 合成片段：文件名随便给，scanSources 不碰磁盘 */
const run = (src, name = 'web/src/app/_synthetic.js') => scanSources([[name, src]]);

test('复扫能点名未登记的中文 UI 文本', () => {
    const r = run(`
        function paint(el) {
            el.textContent = '合成串测试甲';
            el.setAttribute('data-tooltip', '合成串测试乙');
        }
    `);
    const phrases = r.unregisteredList.map(x => x.phrase).sort();
    assert.deepEqual(phrases, ['合成串测试乙', '合成串测试甲'], '两条挂在 UI 出口上的中文串都该被抓出来');
    assert.equal(r.dynamicList.length, 0);
    assert.equal(r.restList.length, 0, '有明确 UI 出口时不该掉进「判不出归类」桶');
});

test('已登记的串不报，重复出现也只认一次', () => {
    const r = run(`
        a.textContent = '应用诊断';
        b.textContent = '应用诊断';
    `);
    assert.equal(r.unregisteredList.length, 0, '应用诊断 已在词表里');
    assert.equal(r.registeredHits, 2, '两处命中都要记上');
});

test('带 {占位符} 的动态句放过，但单独列出来给人复核', () => {
    const r = run(`
        status.textContent = '合成串丙 · 剩余 {t}';
        setHint('合成串丁 {m} 分钟后停止播放');
    `);
    assert.equal(r.unregisteredList.length, 0, 'STATIC_PHRASE_MAP 是整句精确匹配，占位符句命中不了，不该算漏');
    const dyn = r.dynamicList.map(x => x.phrase).sort();
    assert.equal(dyn.length, 2, '两条占位符句都要单独列出来给人复核');
    assert.ok(dyn.includes('合成串丙 · 剩余 {t}'));
    assert.ok(dyn.includes('合成串丁 {m} 分钟后停止播放'));
    /* 模板字符串的 ${} 同样折成占位符，插值表达式**里**的字面量另计 */
    const t = run('  el.textContent = `合成串戊 剩余 ${remain} 分钟`;\n');
    assert.deepEqual(t.dynamicList.map(x => x.phrase), ['合成串戊 剩余 {} 分钟']);
    assert.equal(t.unregisteredList.length, 0);
});

test('日志正文允许中文（约束 9），不进任何失败桶', () => {
    const r = run(`
        try { x(); } catch (e) { logCatch('t', e); }
        logWarn('诊断页采集失败合成串戊:', e);
        console.log('合成串己 调试输出');
    `);
    assert.equal(r.unregisteredList.length, 0);
    assert.equal(r.dynamicList.length, 0);
    assert.equal(r.restList.length, 0, '日志行要整条剔掉，不能留在待复核桶里刷量');
});

test('词法器不会把跨行代码片段当成中文串（scratch 版脚本的原始 bug）', () => {
    /* 旧实现用 /'([^'\\]*[一-鿿][^'\\]*)'/g 全文匹配，`);` 换行 `}, delay);` 这种
       片段会被当成一条「中文串」。带真换行的字面量在 JS 里是语法错误，必须直接丢掉。 */
    const r = run(`
        // 行注释里的 合成串己 不该被扫到
        /* 块注释里的 合成串庚 也不该
           跨行继续写 合成串辛 */
        function later(delay) {
            setTimeout(() => {
                doSomething('');
            }, delay);
        }
        const plain = 'no-han-here';
    `);
    assert.equal(r.unregisteredList.length, 0);
    assert.equal(r.dynamicList.length, 0);
    assert.equal(r.restList.length, 0, '注释与代码片段一个都不该进桶，否则报告全是噪音');
});

test('情感词/标签查表（中文 : 单个小写标识符）不当成 UI 文案', () => {
    /* TunnelDirector 里 67 条 '悲しみ': 'sorrow' 形状的情感词分类表，
       光看形状和「中文: 英文」词表项一模一样，误判会让门禁变成噪音机。 */
    const r = run(`
        const EMOTION = {
            '合成标签甲': 'sorrow',
            '合成标签乙': 'love',
        };
    `);
    assert.equal(r.unregisteredList.length, 0);
});

test('双语对照表 [中文, English] 的中文侧要登记', () => {
    const r = run(`
        const STR = {
            hintCancel: ['合成串庚已取消', 'Synthetic hint cancelled'],
        };
    `);
    assert.deepEqual(r.unregisteredList.map(x => x.phrase), ['合成串庚已取消']);
});

test('284 的私有 PHRASE_EN 已删除，改走 core/i18n.js 的共享词表', () => {
    const src = fs.readFileSync(DIAG, 'utf8');
    /* 注释里保留一段「原来这里是一张私有 PHRASE_EN」的历史说明是刻意的（防止有人再建一张），
       所以判「不存在」要先把注释剥掉，只看真实代码里还有没有这个名字。 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/PHRASE_EN/.test(code), 'PHRASE_EN 这个标识符不该再出现在 284 的任何一行代码里');
    assert.ok(!/const\s+PHRASE/.test(code), '不得留下改名后的私有表');
    assert.ok(/import\s*\{[^}]*translatePhrase[^}]*\}\s*from\s*'\.\.\/core\/i18n\.js'/.test(code),
        '必须 import 共享查询函数，而不是自己再写一张表');
    assert.ok(/const\s+tx\s*=\s*translatePhrase/.test(code), 'tx 只是共享函数的别名');
    assert.ok(/PHRASE_EN/.test(src), '文件头要留下「别再自建词表」的说明');
});

test('迁移后 284 的文案在英文模式下仍能取到英文', () => {
    setLanguage('en-US');
    assert.equal(getLanguage(), 'en-US');
    /* 三条都只存在于「原 PHRASE_EN」里，取不到就说明迁移漏了 */
    assert.equal(translatePhrase('外壳'), 'Shell');
    assert.equal(translatePhrase('显卡与渲染后端'), 'GPU & render backend');
    assert.equal(translatePhrase('取链详情（最近一次）'), 'Playback resolve (latest)');
    /* 表外补登记的：原先是写死在渲染处的三元分支 */
    assert.equal(translatePhrase('重新采集数据'), 'Reload diagnostics');
    /* 取不到就原样返回，绝不机翻兜底 */
    assert.equal(translatePhrase('这句词表里绝对没有的合成串'), '这句词表里绝对没有的合成串');
    setLanguage('zh-CN');
    assert.equal(translatePhrase('外壳'), '外壳', '中文模式下必须原样返回，否则面板会变英文');
});

test('与既有键同名的条目保留了既有英文值，没被 284 的写法覆盖', () => {
    setLanguage('en-US');
    /* 左边 = 词表既有值（保留），右边是 284 私有表原本想用的写法（不得生效） */
    const kept = {
        '音质': 'Audio Quality',      // 284 想写 Quality
        '耗时': 'Elapsed',            // 284 想写 Duration
        '性能档位': 'Performance Tier', // 284 想写 Performance profile
        '关闭': 'Close',
        '容器': 'Container',
        '缓存': 'Cache',
        '应用诊断': 'App diagnostics', // 284 想写 App Diagnostics
        '是': 'Yes',                  // 284 想写 yes
        '否': 'No',
        '失败': 'Failed',             // 284 想写 failed
        '离线': 'Offline',            // 284 想写 offline
        '命中渠道': 'Resolved via',    // 284 想写 Channel
    };
    for (const [zh, en] of Object.entries(kept)) {
        assert.equal(translatePhrase(zh), en, `${zh} 应保留词表既有英文值`);
        assert.ok(isPhraseRegistered(zh), `${zh} 应在词表里`);
    }
    setLanguage('zh-CN');
});

test('真实库扫描：基线棘轮没有被突破（只许降不许升）', () => {
    /* scanSources 内部会把语言钉到 en-US（词表查询只在英文模式下有意义）；
       这里再显式切一次，是为了让这个断言不依赖被测试函数的实现细节。 */
    setLanguage('en-US');
    const base = JSON.parse(fs.readFileSync('scripts/audits/i18n-coverage.baseline.json', 'utf8'));
    const allow = new Set(base.keys);
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) { if (!['node_modules', 'vendor', 'font', 'img'].includes(e.name)) walk(rel); }
            else if (/\.(js|mjs)$/.test(e.name) && rel !== 'web/src/core/i18n.js') files.push(rel);
        }
    })('web/src');
    const r = scanSources(files.map(f => [f.replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')]));
    const fresh = [...r.allKeys].filter(k => !allow.has(k));
    assert.deepEqual(fresh, [], '出现了基线之外的新未登记中文 UI 文本');
    assert.ok(r.allKeys.size <= allow.size, `存量应从 ${allow.size} 只减不增，现在 ${r.allKeys.size}`);
    /* 本轮迁移的战果：新分片不该再有任何欠账（288 是并阵中另开的分片，另计） */
    const mine = r.unregisteredList.filter(x => /28[0-7]-|275-/.test(x.files.join(',')));
    assert.deepEqual(mine, [], '275/280/282/283/284/287 应已全部登记干净');
});
