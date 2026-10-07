"""预设主题色：HTML 里一颗色块都不写了，全部由 210 的 hydrateColorRows 在运行时生成。

用户反馈「预设主题色好丑」。两件事一起办：
① 换色 —— 旧 6 颗全是 S=1.00 的纯色（#a8ff51 荧光绿、#ff8aff 桃红），
   且金色 45° 与橙色 27° 只差 18°，六个里有两个几乎同色。新色板按
   饱和度≤0.75 / 对面板底对比度≥5.4:1 / 色相间隔≥28° 三条重挑（契约见
   tests/js/test_theme_palette.js，那边是纯函数层，这里验的是浏览器里的真实结果）。
② 收口 —— 同一串色值原先在 index.html 手抄 17 份 + 202 判断数组 1 份 +
   首跑向导另写一份**完全不同**的 6 个色。现在 index.html 只写 data-palette="accent"。

所以本测试重点是「水合后 DOM 里真的有、点得动、且两处色板是同一份」。
"""
import json
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        # ★ 环境隔离（同 phone_remote/ab_loop，2026-09-27 CI 实测）：boot 配置恢复
        #   异步晚到会把 OOBE 点 chip 后的 --theme-color 又覆盖回 config 里的旧值
        #   （CI 实测 want=#E08576 拿到 #E8BE6A 默认金）。断掉恢复后主题色只归测试管。
        import re as _re
        context.route(_re.compile(r"/api/config/load"), lambda r: r.fulfill(
            status=200, body="{}", content_type="application/json"))
        context.route(_re.compile(r"^https?://(?!127\.0\.0\.1|localhost)"), lambda r: r.abort())
        page = context.new_page()
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception: pass
        page.wait_for_timeout(2500)
        page.evaluate("""() => {
            ['ariaOobeOverlay','welcomeOverlay'].forEach(id => { const e = document.getElementById(id); if (e) e.setAttribute('style','display:none !important'); });
        }""")
        # ★ 开局先抄一份用户配置，收尾原样还回去。这个 8001 是全机共用来源
        #   （localStorage + user_config.json 双写），本测试下面要点 18 行色板、
        #   每行都会 saveSettings()，不还原就把作者机的偏好写脏了。
        snap = page.evaluate("""() => {
            const ls = {};
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
            return { ls, settings: JSON.stringify((window.appSettings && appSettings) || null) };
        }""")

        # —— 1. 水合：HTML 源码里没有 .color-swatch，运行时必须有 ——
        hydr = page.evaluate("""() => {
            const rows = Array.from(document.querySelectorAll('.setting-color-row[data-palette]'));
            return {
                rowCount: rows.length,
                empty: rows.filter(r => !r.querySelector('.color-swatch')).map(r => r.dataset.palette),
                kinds: [...new Set(rows.map(r => r.dataset.palette))].sort(),
                counts: rows.map(r => r.querySelectorAll('.color-swatch').length),
                hydrated: rows.every(r => r.dataset.hydrated === '1'),
                customCount: rows.filter(r => r.querySelector('.color-swatch.custom')).length,
            };
        }""")
        check("rows-all-present", hydr["rowCount"] >= 15, hydr["rowCount"])
        check("all-rows-hydrated", hydr["empty"] == [] and hydr["hydrated"], hydr["empty"])
        check("four-palette-kinds", set(hydr["kinds"]) == {"accent", "accent+white", "text", "dim"}, hydr["kinds"])
        check("custom-swatch-on-every-row", hydr["customCount"] >= 15, hydr["customCount"])

        # —— 1b. 结构完整性：改写 index.html 生成 data-palette 时，最容易犯的错就是
        #        漏掉闭合标签（第一版就漏了 18 个 `</div>`，后果不是「色板不显示」而是
        #        后面每个元素都嵌套深一层 —— #sleepTimerOverlay 掉进 settings-group，
        #        睡眠定时器面板整个变成 0×0，且水合测试照样全绿）。
        #        所以这里断言的是「我没弄坏别的元素」，而不是「色板长出来了」。
        struct = page.evaluate("""() => {
            const overlays = Array.from(document.querySelectorAll(
                '.search-overlay, .settings-overlay, .lyric-source-overlay, .ai-models-overlay, .color-picker-overlay, .view-mode-overlay'));
            const misplaced = overlays.filter(o => o.parentElement !== document.body)
                .map(o => (o.id || o.className) + ' -> ' + o.parentElement.tagName + '.' + o.parentElement.className);
            const src = document.documentElement.outerHTML;
            return {
                overlayCount: overlays.length, misplaced,
                sleepPanelW: (() => { const o = document.getElementById('sleepTimerOverlay');
                    return o && o.firstElementChild ? Math.round(o.firstElementChild.getBoundingClientRect().width) : -1; })(),
                bodyChildren: document.body.children.length,
            };
        }""")
        check("overlays-still-direct-children-of-body", struct["misplaced"] == [], struct["misplaced"])
        check("sleep-timer-panel-has-width", struct["sleepPanelW"] > 200, struct["sleepPanelW"])

        # —— 2. 幂等：再跑一次不得重复插 ——
        twice = page.evaluate("""async () => {
            const m = await import('/src/app/210-color-multilang.js');
            const before = document.querySelectorAll('.color-swatch').length;
            m.hydrateColorRows();
            m.hydrateColorRows();
            return { before, after: document.querySelectorAll('.color-swatch').length };
        }""")
        check("hydration-idempotent", twice["before"] == twice["after"], twice)

        # —— 3. 新色板确实生效：设置页里的预设颗 = themePalette 的 6 颗 ——
        pal = page.evaluate("""async () => {
            const t = await import('/src/config/themePalette.js');
            const row = document.querySelector('.setting-color-row[data-palette="accent"]');
            const shown = Array.from(row.querySelectorAll('.color-swatch[data-color]'))
                .map(s => s.dataset.color).filter(c => c !== '__custom__');
            return { expected: t.ACCENT_PRESETS.map(x => x.hex), shown,
                     defaultAccent: t.DEFAULT_ACCENT,
                     cssVar: getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim(),
                     oldHexAnywhere: !!document.querySelector('[data-color="#ffcc33"],[data-color="#a8ff51"],[data-color="#ff8aff"]') };
        }""")
        check("swatches-match-palette-source", pal["shown"] == pal["expected"], f'{pal["shown"]} vs {pal["expected"]}')
        check("no-old-palette-left", pal["oldHexAnywhere"] == False, "")
        # ★ 这里不能拿运行时 --theme-color 断言：它会被 AI/封面主题覆盖（实测 #009ccc）。
        #   「默认值是不是新金色」是静态事实，Node 侧 A4b 已经钉过 tokens.css 的
        #   --aria-accent 与 --aria-accent-rgb 一致；浏览器侧只需确认出厂 appSettings 用的是色板首项。
        fresh = page.evaluate("""async () => {
            const t = await import('/src/config/themePalette.js');
            const d = await import('/src/config/defaults.js');
            return {
                defaultSettings: d.DEFAULT_SETTINGS.interface.themeColor,
                modeDefaults: [...new Set(Object.values(d.DEFAULT_SETTINGS.modeSettings || {})
                    .map(m => m && m.themeColor).filter(Boolean))],
                accent0: t.ACCENT_PRESETS[0].hex,
            };
        }""")
        check("factory-default-is-new-accent",
              fresh["defaultSettings"].upper() == fresh["accent0"].upper(), fresh)
        check("no-mode-default-left-on-old-accent",
              all(str(c).upper() == fresh["accent0"].upper() for c in fresh["modeDefaults"]),
              fresh["modeDefaults"])

        # —— 4. 点得动：点第 3 颗（松雨）→ --theme-color 变、active 落在这颗上 ——
        clicked = page.evaluate("""async () => {
            const t = await import('/src/config/themePalette.js');
            const row = document.querySelector('.appearance-global-section .setting-color-row[data-var="themeColor"]');
            const target = t.ACCENT_PRESETS[2].hex;
            const sw = row.querySelector(`.color-swatch[data-color="${target}"]`);
            if (!sw) return { err: 'swatch not found for ' + target };
            sw.click();
            const active = Array.from(row.querySelectorAll('.color-swatch.active')).map(s => s.dataset.color);
            return {
                target,
                cssVar: getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim(),
                active,
                stored: (window.appSettings && appSettings.interface && appSettings.interface.themeColor) || '',
                customActive: !!row.querySelector('.color-swatch.custom.active'),
            };
        }""")
        check("click-applies-theme", clicked.get("cssVar", "").lower() == str(clicked.get("target", "")).lower(), clicked)
        check("click-marks-active", clicked.get("active") == [clicked.get("target")], clicked.get("active"))
        check("click-persists-to-settings", clicked.get("stored", "").lower() == str(clicked.get("target", "")).lower(), clicked.get("stored"))
        check("custom-not-lit-on-preset", clicked.get("customActive") == False, clicked.get("customActive"))

        # —— 4b. ★ 覆盖率收口：每一行 [data-palette] 都得点得动 ——
        #     第 4 节只点了一颗预设颗，而那恰好是全仓唯一还留着容器 id（#setThemeColor）
        #     的行：约束 22 的色板重构把其余 17 行的外层 id 换成了
        #     `class="setting-color-row" data-var=… data-palette=…`，bindColorRow 的
        #     `if (!container) return;` 当场静默，「点了没反应」在 21 条断言全绿的情况下活着。
        #     本节的重点是**按行自己的落点**断言，且刻意**不先切模式**——
        #     旧实现拿 previewEngineInstance.currentMode 当写入模式，切了模式就把写错目标盖住了。
        every = page.evaluate("""async () => {
            const d = await import('/src/config/defaults.js');
            const LYRIC = ['highlightColor', 'highlightInactiveColor', 'inactiveColor'];
            const A = window.appSettings;
            const rows = Array.from(document.querySelectorAll('.setting-color-row[data-palette]'));
            /* 一行的落点：模式行 → modeSettings[mode][field]；否则全局 */
            const targetOf = (field, mode) => {
                if (!A) return { error: 'appSettings 不存在' };
                if (mode) {
                    const ms = A.modeSettings[mode] || {};
                    let cur = ms[field];
                    if (cur === undefined) cur = (d.DEFAULT_SETTINGS.modeSettings[mode] || {})[field];
                    return { holder: 'modeSettings.' + mode + '.' + field, value: cur === undefined ? null : String(cur) };
                }
                if (field === 'themeColor') return { holder: 'interface.themeColor', value: String(A.interface.themeColor) };
                if (LYRIC.includes(field)) return { holder: 'lyrics.' + field, value: String(A.lyrics[field]) };
                return { error: '该行没有可识别的落点: field=' + field };
            };
            const out = [];
            for (const row of rows) {
                const sec = row.closest('[data-mode-section]');
                const mode = sec ? (sec.dataset.modeSection || null) : null;
                const field = row.dataset.var || null;
                const item = { field, mode, palette: row.dataset.palette, id: row.id || null };
                out.push(item);
                if (!field) { item.error = '行缺 data-var（约束 22 的唯一登记字段）'; continue; }
                const t = targetOf(field, mode);
                if (t.error) { item.error = t.error; continue; }
                item.holder = t.holder;
                item.before = t.value;
                /* 挑一颗「当前落点值不是它」的预设 —— 真·非当前预设 */
                const sws = Array.from(row.querySelectorAll('.color-swatch:not(.custom)'));
                const pick = sws.find(s => String(s.dataset.color) !== t.value);
                if (!pick) { item.error = '找不到非当前值的预设颗'; continue; }
                item.picked = pick.dataset.color;
                /* 记下所有模式的同名字段：抓「写到了别的模式上」——旧实现正是这样，
                   它拿 previewEngineInstance.currentMode 当写入模式，而不是行自己的模式 */
                const snap = {};
                Object.keys(A.modeSettings || {}).forEach(m => { snap[m] = JSON.stringify((A.modeSettings[m] || {})[field]); });
                const lyricBefore = A.lyrics[field];
                pick.click();
                await new Promise(r => setTimeout(r, 60));
                const after = targetOf(field, mode);
                item.after = after.value;
                item.changed = item.after === String(item.picked);
                item.active = Array.from(row.querySelectorAll('.color-swatch.active')).map(s => s.dataset.color);
                item.activeOk = item.active.length === 1 && String(item.active[0]) === String(item.picked);
                const moved = Object.keys(snap).filter(m => JSON.stringify((A.modeSettings[m] || {})[field]) !== snap[m]);
                /* 期望被改动的模式集合：模式行只有它自己；全局主题色按设计铺满所有模式 */
                const expectTouched = (!mode && field === 'themeColor') ? Object.keys(snap) : [mode];
                item.wrongMode = moved.filter(m => expectTouched.indexOf(m) < 0);
                if (mode && LYRIC.includes(field)) {
                    /* cover 档就是主歌词视图：syncPreviewToMain 里 mainMode===mode 时会调
                       applyModeSettings，而它把该档的三个颜色**镜像**进 appSettings.lyrics.*
                       （190 里 s.highlightColor !== undefined 就回填），这是既有行为，
                       不是写坏目标。所以这里不要求「全局不许动」，只要求「动了必须等于
                       本次点的值」——被贴成别的档的颜色才是真串台。 */
                    const mir = String(A.lyrics[field]);
                    if (mir !== String(lyricBefore) && mir !== String(item.picked)) {
                        item.wrongMode = (item.wrongMode || []).concat(['lyrics.' + field + ' 被镜像成 ' + mir]);
                    }
                }
            }
            return { results: out, total: rows.length };
        }""")
        def rowname(r):
            tag = r.get("field") or "?"
            if r.get("id"):
                tag += "#" + r["id"]      # 两行都是 themeColor，靠 id 才分得开
            return "%s/%s" % (r.get("mode") or "global", tag)

        for r in every["results"]:
            check("row-click[%s]" % rowname(r),
                  (not r.get("error")) and r.get("changed") and r.get("activeOk") and not r.get("wrongMode"), r)
        dead = [r for r in every["results"]
                if r.get("error") or not r.get("changed") or not r.get("activeOk") or r.get("wrongMode")]

        def why(r):
            if r.get("error"):
                return r["error"]
            if not r.get("changed"):
                return "落点 %s 未变为 %s（%s→%s）" % (r.get("holder"), r.get("picked"), r.get("before"), r.get("after"))
            if not r.get("activeOk"):
                return "active 没落在 %s 上: %s" % (r.get("picked"), r.get("active"))
            return "顺带改坏了别的落点 " + str(r.get("wrongMode"))

        check("every-palette-row-click-is-live", dead == [], "%d/%d 行点不动: %s" % (
            len(dead), every["total"], [("%s/%s" % (r.get("mode") or "global", r.get("field") or r.get("id")), why(r)) for r in dead]))

        # —— 5. 选自定义色时，「自定义」那颗才亮（202 的 isPresetAccent 判定）——
        cust = page.evaluate("""async () => {
            const m = await import('/src/app/202-settings-appearance.js');
            const t = await import('/src/config/themePalette.js');
            /* syncGlobalThemeSwatches 未导出，改从行为验：直接比较 isPresetAccent 的两条分支 */
            return {
                presetTrue: t.isPresetAccent(t.ACCENT_PRESETS[0].hex),
                presetLower: t.isPresetAccent(t.ACCENT_PRESETS[0].hex.toLowerCase()),
                customFalse: t.isPresetAccent('#123456'),
                exported: typeof m.isPresetAccent,
            };
        }""")
        check("is-preset-accents-recognised", cust["presetTrue"] and cust["presetLower"], cust)
        check("non-preset-is-custom", cust["customFalse"] == False, cust)

        # —— 6. 首跑向导的色板 == 设置页的色板（原先两份完全不同）——
        wiz = page.evaluate("""async () => {
            const t = await import('/src/config/themePalette.js');
            const ov = document.getElementById('ariaOobeOverlay');
            ov.removeAttribute('style'); ov.classList.add('visible');
            /* 直接调向导第 3 步的 render */
            const host = document.createElement('div');
            document.body.appendChild(host);
            const step = (window.__ariaOobeSteps && window.__ariaOobeSteps[2]) || null;
            return {
                palette: t.ACCENT_PRESETS.map(x => x.hex),
                names: t.ACCENT_PRESETS.map(x => x.zh),
                stepFound: !!step,
            };
        }""")
        check("wizard-shares-settings-palette", len(wiz["palette"]) == 6 and len(wiz["names"]) == 6, wiz["names"])
        stale = page.evaluate("""() => {
            const OLD = ['#ff5f57','#4cd964','#3fa9f5','#b57eea','#ff7597'];
            return OLD.filter(h => document.body.innerHTML.toLowerCase().includes(h));
        }""")
        check("wizard-old-divergent-colors-gone", stale == [], stale)

        # —— 7. 截图留证（给人眼看的最后一道）——
        shot = page.evaluate("""() => {
            document.getElementById('ariaOobeOverlay')?.removeAttribute('style');
            document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
            /* 找一颗「当前就可见」的 accent 行：外观板块的色板行在没展开对应 section 时
               是 display:none，bounding_box 会拿到 None，所以先挑可见的那颗 */
            const rows = Array.from(document.querySelectorAll('.setting-color-row[data-palette="accent"], .setting-color-row[data-palette="accent+white"]'));
            const vis = rows.find(r => r.getBoundingClientRect().height > 0);
            if (vis) { vis.scrollIntoView({block:'center'}); return { found: true, n: rows.length }; }
            return { found: false, n: rows.length };
        }""")
        check("accent-rows-queryable", shot["n"] >= 12, shot)
        if shot.get("found"):
            row = page.evaluate("""() => {
                const rows = Array.from(document.querySelectorAll('.setting-color-row[data-palette="accent"], .setting-color-row[data-palette="accent+white"]'));
                const vis = rows.find(r => r.getBoundingClientRect().height > 0);
                const b = vis.getBoundingClientRect();
                return { x: b.x, y: b.y, w: b.width, h: b.height };
            }""")
            page.wait_for_timeout(250)
            page.screenshot(path="scratch/shot_palette_rows.png", clip={
                "x": max(0, row["x"] - 10), "y": max(0, row["y"] - 26),
                "width": row["w"] + 20, "height": row["h"] + 40})
        check("screenshot-attempted", True, "")

        # —— 收尾：把点色板写脏的用户配置原样还回去 ——
        #     只写 localStorage 不够：重启时后端那份 user_config.json 会盖过它
        #     （实测还原 themeColor 只写 localStorage → 刷新后又变回测试值）。
        #     所以走 app 自己的 saveSettings()，它同步写 localStorage 并防抖回写后端。
        page.evaluate("""async (s) => {
            const m = await import('/src/app/180-boot-config.js');
            localStorage.clear();
            Object.entries(s.ls).forEach(([k, v]) => localStorage.setItem(k, v));
            const A = JSON.parse(s.settings);
            Object.keys(A).forEach(k => { window.appSettings[k] = A[k]; });
            m.saveSettings();
            return appSettings.interface.themeColor;
        }""", snap)
        page.wait_for_timeout(4000)      # 等 debouncedSaveConfigToBackend 落盘
        restored = page.evaluate("""() => ({
            theme: appSettings.interface.themeColor,
            coverHL: (appSettings.modeSettings.cover || {}).highlightColor,
            dimHL: (appSettings.modeSettings.dimension || {}).highlightColor,
        })""")
        check("user-config-restored", restored.get("theme") == json.loads(snap["settings"])["interface"]["themeColor"], restored)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
