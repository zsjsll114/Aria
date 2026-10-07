/* ============================================================
 * 309-jizura-fontpack.js — 「字面 · Jizura」的日文字体包导入
 *
 * 上游那 27 套版式是**围绕日文字面**设计的（Noto Sans JP / Noto Serif JP / 明朝 /
 * デラゴシック …）。我们不打包这些字体（省体积，也免掉"随包附 OFL 声明"的义务），
 * 但给出**一条导入通路**：用户自己拿到字体文件后，这里把它注册成**上游那个家族名**
 * （例如 `Noto Sans JP`），引擎的 `J.FONTS[k].family` 就直接命中它 ——
 * 不需要改引擎，也不需要我们维护一张字体映射表。
 *
 * 三条设计约束：
 *   ① 家族名匹配表**取自引擎自己**（`jizuraFamilyNames`），不硬编 ——
 *      上游加字族我们自动跟上，也不会因为拼错一个名字而"导入了却用不上"；
 *   ② 持久化复用 Aria 现成的字体库（`215` 的 `loadFontFace` + `saveFontToDB`，
 *      落 IndexedDB）：重启后仍生效，并且能与其它模式的字体下拉共用同一份；
 *   ③ 导入后**必须清引擎的字形/度量缓存** —— 两者是按"css font 串 + 字符"烘出来的，
 *      不清就会继续用旧字面的字形与度量（上游 addUserFont 也是这么做的）。
 * ============================================================ */
import { loadFontFace, saveFontToDB } from './215-multilang-fonts.js';
import {
    clearJizuraFontCaches, getJizuraEngine, jizuraFamilyNames, pickJizuraFamily,
} from '../core/visualizers/jizura/jizuraBridge.js';
import { setHint } from './120-search-results.js';
import { logInfo, logWarn, logCatch } from '../services/log.js';

const TAG = 'jizuraFontPack';

/** 文件名里可能是可变字体（要声明字重区间，否则 900 字重靠合成仿粗） */
function looksVariable(name) {
    return /(^|[-_.\s])vf([-_.\s]|$)|variable/i.test(String(name || ''));
}

/* ============================================================ 导入 ============================================================ */

async function importFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return 0;
    let J = null;
    try { J = await getJizuraEngine(); } catch (e) { logCatch(TAG, e); }
    const canonicals = J ? jizuraFamilyNames(J) : [];
    let ok = 0;
    let mapped = 0;
    for (const file of list) {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const family = pickJizuraFamily(canonicals, baseName);
        if (!family) continue;
        const isEngineFamily = canonicals.some((c) => c === family);
        const key = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        try {
            const buffer = await file.arrayBuffer();
            const descriptors = looksVariable(baseName) ? { weight: '100 900' } : null;
            const loaded = await loadFontFace(key, family, buffer, baseName, descriptors);
            if (!loaded) { logWarn(TAG, `字体加载失败：${file.name}`); continue; }
            /* 复用 Aria 的字体库：重启后 initCustomFonts 会把它们再注册回来 */
            try { await saveFontToDB(key, family, baseName, buffer, file.name, file.size); }
            catch (e) { logCatch(TAG, e); }
            ok++;
            if (isEngineFamily) mapped++;
            logInfo(TAG, `导入 ${file.name} → 家族「${family}」${isEngineFamily ? '（命中引擎字面）' : '（未命中引擎字族，仍可在其它模式选用）'}`);
        } catch (e) {
            logCatch(TAG, e);
        }
    }
    /* ★ 引擎的字形/度量缓存必须清：它们按"css font 串 + 字符"烘出来，不清就还是旧字面 */
    const cleared = J ? clearJizuraFontCaches(J) : false;
    return { ok, mapped, cleared };
}

/* ============================================================ 接线 ============================================================ */

function bindFontPackButton() {
    const btn = document.querySelector('.jizura-font-pack-btn');
    if (!btn || btn._hasJizuraFontPack) return;
    btn._hasJizuraFontPack = true;
    btn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.ttf,.otf,.woff,.woff2';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const files = input.files;
            input.remove();
            if (!files || !files.length) return;
            setHint('正在导入日文字体…');
            try {
                const r = await importFiles(files);
                if (!r || !r.ok) { setHint('字体导入失败，请看日志'); return; }
                /* 刻意不做"已导入 3 个"这类插值：提示语保持整串，i18n 词表才收得住
                   （带表达式的模板串会让门禁只抓到半句）。 */
                setHint(r.mapped
                    ? '日文字体已导入，画面将按上游原貌排版'
                    : '字体已导入，但没有命中引擎用的日文字族（文件名需含 Noto Sans JP 等家族名）');
            } catch (e) {
                logCatch(TAG, e);
                setHint('字体导入出错，请看日志');
            }
        });
        input.click();
    });
}

/* 设置面板是按需渲染/反复打开的，所以挂一个轻量的观察者持续补绑（幂等） */
function init() {
    bindFontPackButton();
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    try {
        const mo = new MutationObserver(() => bindFontPackButton());
        mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        logCatch(TAG, e);
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}
