/* ============================================================
 * tests/js/test_html_escape_rule.js — aria/no-unescaped-html 规则回归
 *
 * 规则本身是安全门禁，所以它自己必须有测试：否则一次「顺手改正则」
 * 就会把门禁改成静默放行，而 lint 依然全绿。
 * 每个 case 对应 2026-09-25 三选一分类时踩到的一类判定：
 *   valid   = 已转义 / 数值 / 大写常量表 / 计算下标 / 三元条件 / 比较表达式
 *   invalid = 远程文本字段裸插值（含属性上下文、先拼后赋）
 * ============================================================ */
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../../scripts/eslint-rules/no-unescaped-html.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = (text, fn) => it.only(text, fn);

const tester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('aria/no-unescaped-html', rule, {
    valid: [
        /* 已转义：短名、全名、下划线别名都认 */
        { code: 'el.innerHTML = `<div>${esc(song.title)}</div>`;' },
        { code: 'el.innerHTML = `<div>${escapeHtml(song.title)}</div>`;' },
        { code: 'el.innerHTML = `<div>${_escapeHtml(song.title)}</div>`;' },
        /* 属性上下文里已转义（封面 URL / data-* 键） */
        { code: 'el.innerHTML = `<img src="${esc(cover)}">`;' },
        /* const t = escapeHtml(...) 之后复用 t：视为已安全 */
        { code: 'const title = escapeHtml(f.title); el.innerHTML = `<div>${title}</div>`;' },
        /* 大写常量表 + 计算下标（EQ_LABELS[i] / SRC_LABEL[src]） */
        { code: 'el.innerHTML = `<span>${EQ_LABELS[i]}</span>`;' },
        { code: 'el.innerHTML = `<span>${SRC_LABEL[src]}</span>`;' },
        /* 以 HTML 结尾的片段产出器（Aria.__platformIconHTML） */
        { code: 'el.innerHTML = `<span>${Aria.__platformIconHTML(src)}</span>`;' },
        /* 先拼好的 HTML 片段变量（其内部模板各自受检） */
        { code: 'const coverHtml = cover ? `<img src="${esc(cover)}">` : \'<i></i>\'; el.innerHTML = `<div>${coverHtml}</div>`;' },
        /* 数值 / 长度 / 布尔标志 */
        { code: 'el.innerHTML = `<li data-i="${i}">${list.length}</li>`;' },
        { code: 'el.innerHTML = `<span>${p.lyrics.blurLevel}</span>`;' },
        /* 三元条件位与比较表达式只做判断，不流入 HTML */
        { code: 'el.innerHTML = `<div>${title ? "<b></b>" : ""}</div>`;' },
        { code: 'el.innerHTML = `<button class="${src === cur ? "active" : ""}">x</button>`;' },
        /* 非 HTML 上下文（纯文本模板）不参与 */
        { code: 'const tip = `已合并 ${songs.length} 首到「${target.name}」`;' },
    ],
    invalid: [
        /* 搜索/榜单返回的歌名裸插值 */
        {
            code: 'listEl.innerHTML = `<div class="result-title">${name}</div>`;',
            errors: [{ message: /命中字段 name，/ }],
        },
        {
            code: 'listEl.innerHTML = `<div>${it.title}</div>`;',
            errors: [{ message: /命中字段 title，/ }],
        },
        /* 属性上下文同样要转义：封面 URL 带引号即可逃逸 */
        {
            code: 'listEl.innerHTML = `<img src="${item.cover}">`;',
            errors: [{ message: /命中字段 cover，/ }],
        },
        /* 先 map 拼串、后赋给 innerHTML 的形态 */
        {
            code: 'const rows = list.map(s => `<div>${s.singer}</div>`).join(""); listEl.innerHTML = rows;',
            errors: [{ message: /命中字段 singer，/ }],
        },
        /* 兜底默认值不改变危险性：err 仍来自后端/平台 */
        {
            code: 'body.innerHTML = `<div>${qr.err || "取码失败"}</div>`;',
            errors: [{ message: /命中字段 err，/ }],
        },
        /* 三元条件位安全，但 consequent/alternate 里的文本仍要转义 */
        {
            code: 'box.innerHTML = `<p>${has ? m.desc : "暂无"}</p>`;',
            errors: [{ message: /命中字段 desc，/ }],
        },
        /* 未知格式化函数不能代替转义 */
        {
            code: 'box.innerHTML = `<p>${fmt(song.album)}</p>`;',
            errors: [{ message: /命中字段 album，/ }],
        },
    ],
});
