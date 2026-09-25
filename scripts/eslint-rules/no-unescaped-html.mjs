/* ============================================================
 * scripts/eslint-rules/no-unescaped-html.mjs — HTML/SVG 模板插值转义门禁
 *
 * 动机（2026-09-25 评价清单 ②）：全库 224 处 innerHTML，但 escapeHtml 只有
 * 7 个分片 import。同一个文件里 258-rankings.js:693 走 esc()、:303 裸插 ${name}
 * ——转义全靠个人记忆，新代码随时会漏。歌名/歌单名/搜索词/导入文件名都是外部可控
 * 输入，而 Tauri webview 里的后端正握着三平台登录态。
 *
 * 判定策略
 *   1) 上下文：模板静态段里出现开标签 → 认定处于 HTML/SVG 上下文。
 *      不依赖赋值目标，因此覆盖「先 map 拼串、后赋给 innerHTML」的形态。
 *   2) 插值：递归收集表达式里「未经转义直达模板」的字段名；遇到 esc/sanitize
 *      等转义调用即停止下探；字段名按驼峰分词后命中文本词元表（TEXT_WORDS）才报。
 *   3) 只做布尔判断的子表达式不收集：三元的条件、=== / > 之类的比较、
 *      计算属性下标（LABELS[i]）、大写常量基名（EQ_LABELS、SRC_LABEL）。
 *   4) `const t = escapeHtml(x.title)` 后 `${t}` 视为已安全（SAFE_VAR 文件级表）。
 *
 * 为什么按字段名报而不是「一律要求证明安全」：本仓库大量模板是视觉引擎生成的
 * SVG（${px(cy)} / ${N(rng()*500)}），纯数值插值无法逐个证明类型，一律拦截会
 * 产出 400+ 条噪音——一条全是噪音的规则等于没有规则，最后会被整体关掉。
 * 代价是：外部数据若挂在不在名单里的字段名上，本规则看不到；跨分片传递的值
 * （经 globalThis 总线）也追不到。因此它是「兜底网 + 提醒」，不是证明，
 * 新增外部数据入口时仍要人工确认渲染点。
 * ============================================================ */

/* 静态段里出现开标签即视为 HTML/SVG 上下文 */
const HTML_TAG_RE = /<[a-zA-Z][\w-]*(?:[\s>/]|$)/;

/* 已转义/已净化：命中即整棵子树视为安全，不再下探（允许 _escapeHtml 这类别名） */
const SAFE_WRAPPER_RE = /^(esc|escape|escapehtml|sanitize|ariaesc)/i;

/* 产出受控 HTML 片段的函数（骨架屏/版式工厂/平台图标，内容由开发者写死）。
 * 约定：函数名以 HTML 结尾（Aria.__platformIconHTML）即视为片段产出器。 */
const SAFE_HTML_PRODUCER_RE = /(skeleton|fragment$|html$|^render[a-z]|^build[a-z])/i;

/* 必然产出数值或受控片段的调用 */
const SAFE_CALL_RE = /^(number|parseint|parsefloat|tofixed|join|map|filter|flat|foreach|padstart|touppercase|tolowercase|trim|tomediumstring|tolocalestring)$/i;

/* 文本型外部数据字段名——按驼峰/下划线分词后精确匹配词元，命中才报。
 * 刻意不用子串匹配：'blurLevel' 里含 'url'、'duplicate' 里含 'cat'，
 * 子串匹配会造出一批无法解释的误报。 */
const TEXT_WORDS = new Set([
    'title', 'subtitle', 'name', 'artist', 'artists', 'singer', 'singers', 'author', 'authors',
    'album', 'albums', 'keyword', 'keywords', 'query', 'text', 'content', 'contents',
    'desc', 'description', 'detail', 'msg', 'message', 'err', 'error', 'reason',
    'lyric', 'lyrics', 'trans', 'translation', 'romaji',
    'cover', 'pic', 'avatar', 'img', 'image', 'url', 'link', 'href', 'src', 'path', 'filepath', 'filename', 'fname',
    'label', 'labels', 'caption', 'nickname', 'remark', 'note', 'comment',
    'tag', 'tags', 'genre', 'category', 'board', 'playlist', 'plname', 'groupname',
    'username', 'uname', 'prompt', 'hint',
]);

/* 数值/结构/布尔语义：即使命中文本词根也不报 */
const NON_TEXT_RE = /(length|size|count|total|index|idx|num|width|height|top|left|zoom|scale|hue|opacity|version|ids?|keys?|rows?|cols?)$/i;
const BOOL_FLAG_RE = /^(show|is|has|can|enable|allow|use|need)[A-Z_]/;

/* displayname → display + name；song_title → song + title */
function wordsOf(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.toLowerCase())
        .filter(Boolean);
}

/* 大写常量表（模块内作者手写，如 EQ_LABELS / SRC_LABEL / ICON_PATHS） */
const UPPER_CONST_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/* 只做布尔/数值判断、其操作数不会流入 HTML 的比较运算符 */
const COMPARISON_OPS = new Set([
    '===', '==', '!==', '!=', '>', '<', '>=', '<=',
    '&', '|', '^', '<<', '>>', '>>>', '%', '*', '/', '-',
]);

function calleeName(node) {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && node.property && !node.computed) {
        return node.property.name || '';
    }
    if (node.type === 'MemberExpression' && node.property && node.computed) {
        return null; /* 计算属性调用（DECORATION_LIBRARY[name](...)）名字不可知 */
    }
    return '';
}

function isSafeCallName(cn) {
    if (!cn) return false;
    const bare = cn.replace(/^_+/, '').toLowerCase();
    return SAFE_WRAPPER_RE.test(bare) || SAFE_HTML_PRODUCER_RE.test(bare) || SAFE_CALL_RE.test(bare);
}

export default {
    meta: {
        type: 'problem',
        docs: {
            description: 'HTML/SVG 模板中的文本数据插值必须经转义',
        },
        schema: [],
        messages: {
            unescaped:
                'HTML 模板插值「{{name}}」是文本数据却未转义（命中字段 {{field}}，外部可控内容可注入标签）。'
                + '文本用 esc()/escapeHtml() 包裹，URL 用 sanitizeImageUrl()；'
                + '确为开发者写死的静态串，请加 eslint-disable-next-line 并在注释里说明来源。',
        },
    },
    create(context) {
        const src = context.sourceCode;

        /* 策略 4：const t = escapeHtml(...) / 受控模板 → 后续 ${t} 不再报 */
        const safeVars = new Set();
        const isSafeInitializer = (node) => {
            if (!node) return false;
            if (node.type === 'TemplateLiteral') return true; /* 该模板自身已被本规则检查 */
            if (node.type === 'Literal') return true;
            if (node.type === 'CallExpression') return isSafeCallName(calleeName(node.callee));
            if (node.type === 'ConditionalExpression') {
                return isSafeInitializer(node.consequent) && isSafeInitializer(node.alternate);
            }
            if (node.type === 'LogicalExpression') {
                return isSafeInitializer(node.left) && isSafeInitializer(node.right);
            }
            if (node.type === 'BinaryExpression' && node.operator === '+') {
                return isSafeInitializer(node.left) && isSafeInitializer(node.right);
            }
            return false;
        };

        /* 递归收集「未经转义直达模板」的字段名 */
        const collect = (node, acc) => {
            if (!node) return acc;
            switch (node.type) {
                case 'Identifier':
                    if (!safeVars.has(node.name) && !UPPER_CONST_RE.test(node.name)) acc.push(node.name);
                    return acc;
                case 'MemberExpression': {
                    /* obj 为大写常量表 → 整体安全；否则只看属性名，不看基名 */
                    const baseRoot = rootName(node);
                    if (baseRoot && UPPER_CONST_RE.test(baseRoot)) return acc;
                    if (safeVars.has(memberLabel(node))) return acc;
                    if (node.computed) {
                        /* LABELS[i] / SRC_LABEL[src] —— 下标只可能是 key/枚举值 */
                        if (node.property.type !== 'Literal') collectIndex(node.property, acc);
                        return acc;
                    }
                    if (node.property && node.property.type === 'Identifier') {
                        acc.push(node.property.name);
                    }
                    return acc;
                }
                case 'ChainExpression':
                    return collect(node.expression, acc);
                case 'ConditionalExpression':
                    /* 条件本身只做布尔判断，不流入 HTML */
                    collect(node.consequent, acc);
                    return collect(node.alternate, acc);
                case 'LogicalExpression':
                    collect(node.left, acc);
                    return collect(node.right, acc);
                case 'BinaryExpression':
                    if (COMPARISON_OPS.has(node.operator)) return acc;
                    collect(node.left, acc);
                    return collect(node.right, acc);
                case 'UnaryExpression':
                    return node.operator === '!' ? acc : collect(node.argument, acc);
                case 'ArrayExpression':
                    node.elements.forEach((e) => collect(e, acc));
                    return acc;
                case 'ObjectExpression':
                    node.properties.forEach((p) => collect(p.value, acc));
                    return acc;
                case 'AssignmentExpression':
                    return collect(node.right, acc);
                case 'SequenceExpression':
                    node.expressions.forEach((e) => collect(e, acc));
                    return acc;
                case 'CallExpression': {
                    const cn = calleeName(node.callee);
                    if (isSafeCallName(cn)) return acc;
                    node.arguments.forEach((a) => collect(a, acc));
                    if (cn === null) collectIndex(node.callee.property, acc);
                    return acc;
                }
                case 'NewExpression':
                    node.arguments.forEach((a) => collect(a, acc));
                    return acc;
                case 'FunctionExpression':
                case 'ArrowFunctionExpression':
                case 'TemplateLiteral':
                    /* 回调/嵌套模板由各自的访问路径负责 */
                    return acc;
                default:
                    /* Literal / ThisExpression 等：无字段名可判 */
                    return acc;
            }
        };

        /* 计算下标里的变量：LABELS[i] 的 i 是枚举键，不该当作文本内容报 */
        const collectIndex = (node, acc) => {
            if (!node) return acc;
            if (node.type === 'Identifier') return acc;
            if (node.type === 'MemberExpression' && !node.computed) return acc;
            return collect(node, acc);
        };

        function rootName(node) {
            let cur = node;
            while (cur && (cur.type === 'MemberExpression' || cur.type === 'ChainExpression')) {
                cur = cur.type === 'ChainExpression' ? cur.expression : cur.object;
            }
            return cur && cur.type === 'Identifier' ? cur.name : '';
        }

        function memberLabel(node) {
            if (node.type === 'Identifier') return node.name;
            if (node.type === 'MemberExpression' && !node.computed && node.property) {
                const base = rootName(node);
                return base ? `${base}.${node.property.name}` : String(node.property.name);
            }
            return '';
        }

        const matchedTextField = (names) => {
            for (const n of names) {
                if (!n || NON_TEXT_RE.test(n) || BOOL_FLAG_RE.test(n)) continue;
                const hit = wordsOf(n).find((w) => TEXT_WORDS.has(w));
                if (hit) return hit;
            }
            return '';
        };

        const labelOf = (node) => {
            if (node.type === 'Identifier') return node.name;
            if (node.type === 'MemberExpression') return memberLabel(node) || src.getText(node).slice(0, 30);
            return src.getText(node).replace(/\s+/g, ' ').slice(0, 42);
        };

        return {
            VariableDeclarator(node) {
                if (node.id && node.id.type === 'Identifier' && isSafeInitializer(node.init)) {
                    safeVars.add(node.id.name);
                }
            },

            TemplateLiteral(node) {
                const inHtml = (node.quasis || []).some(
                    (q) => HTML_TAG_RE.test((q.value && q.value.raw) || '')
                );
                if (!inHtml) return;

                for (const expr of node.expressions) {
                    const names = collect(expr, []);
                    const field = matchedTextField(names);
                    if (!field) continue;
                    context.report({
                        node: expr,
                        messageId: 'unescaped',
                        data: { name: labelOf(expr), field },
                    });
                }
            },
        };
    },
};
