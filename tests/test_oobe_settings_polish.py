# -*- coding: utf-8 -*-
"""首跑向导（OOBE）与设置面板的四项打磨（2026-09-26 用户反馈）。

用户报的三件事，加上测出来的第四件：
1. **OOBE 不是标准毛玻璃**——卡片底色是 rgba(26,29,38,.92) 的近实心暗板，
   92% 不透明把 blur 完全盖住了。现在必须命中 AGENTS 约束 16 那份配方。
2. **英文模式下 OOBE 仍是中文**——词条早就在 STATIC_PHRASE_MAP 里、类名也在
   _scanI18n 名单里，真正的原因是 applyLanguageToUiRoots 的 6ms 预算被**整轮共享**，
   而 .settings-overlay 一个容器就吃光它（实测单轮 15ms）→ 排在它后面的
   #ariaOobeOverlay 每轮都从第 1 个容器重新开始，永远轮不到（实测连扫 12 轮仍是中文）。
   现在：轮转游标保证公平 + 向导自己渲染完只扫自己那一个容器。
3. **主题色只改文字/图标，控件背景不动**——向导里点色块只写强调色令牌，
   而所有背景/描边读的是它的 rgb 形态 rgba(…,α)。现在走 190 那份
   唯一的 applyThemeColor（两个变量一起写）。P1 起键名为 --aria-accent /
   --aria-accent-rgb，--theme-color 已退化为只读别名（本用例改用新键名读
   **行内**样式；计算值那条仍走 --theme-color，顺便验证别名有效），并且完成时把颜色落进
   appSettings.interface.themeColor（原先只写 aria_theme_color 这个没人读的键，
   重启就被旧值覆盖 = 选了等于没选）。
4. **切页签时中间内容左右跳**——.settings-body 是 overflow-y:auto，短页没滚动条、
   长页有，宽度差一个槽宽。现在 scrollbar-gutter: stable，两个方向都不跳。

★ 本用例把 POST /api/config/save 整个拦掉：8001 那份 user_config.json 是全机共享的
   （本机日常在用的客户端也读写它），测试改到语言/主题色绝不能落盘。
前提：python server.py 已在 :8001 启动。
"""
import re
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
CJK = "[\\u3400-\\u4dbf\\u4e00-\\u9fff]"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


SETUP = """
try {
    localStorage.setItem('aria_ai_proxy_notice', '1');
    localStorage.setItem('aria_oobe_done', '1');
    localStorage.setItem('aria_i18n_lang', 'en-US');
} catch (e) {}
"""


def settle(page, ms=2500):
    page.wait_for_function("() => !!(window.Aria && Aria.__toolbar)", timeout=30000)
    page.wait_for_timeout(ms)


def open_oobe(page):
    page.evaluate("() => { try { localStorage.removeItem('aria_oobe_done'); } catch (e) {} "
                  "window.showAriaOobe && window.showAriaOobe(true); }")
    page.wait_for_selector("#ariaOobeOverlay", timeout=8000)
    page.wait_for_timeout(700)


def main():
    with sync_playwright() as p:
        # ★ 必须关掉 overlay 滚动条：headless 默认的浮动滚动条不吃布局宽度，
        #   「有没有滚动条槽」这件事就量不出来（实测 clientWidth 恒等），
        #   第 4 节的偏移断言与反向自检都会变成假绿。真机（WebView2）是经典滚动条。
        browser = p.chromium.launch(headless=True,
                                    args=["--disable-features=OverlayScrollbar,FluentScrollbar"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        saved = []

        def block_save(route):
            saved.append(route.request.url)
            route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

        page.route("**/api/config/save", block_save)
        page.add_init_script(SETUP)
        page.goto(URL, wait_until="load", timeout=45000)
        settle(page)

        # —— 0. 切到英文模式 ——
        # 不能在 init_script 里种 aria_i18n_lang：loadSettings() 之后 i18n 会按
        # appSettings.interface.language（后端配置）覆盖回来，实测种了仍是 zh-CN。
        # 这里直接调 setLanguage（只改内存 + localStorage，写盘已被拦）。
        page.evaluate("() => AriaI18n.setLanguage('en-US')")
        page.wait_for_timeout(600)
        check("booted-in-english", page.evaluate("AriaI18n.getLanguage()") == "en-US")
        check("config-save-intercepted", len(saved) > 0, f"{len(saved)} 次写入已拦截")

        # ★ 先制造「那个吃掉整轮预算的容器」：设置面板一旦被打开，13 个分区的 DOM 就
        #   全部建好并留在 .settings-overlay 里（关掉只是 display:none，扫描照样走它）。
        #   这正是用户真实路径（先在设置里把语言切成英语，再看到向导仍是中文）。
        #   不制造这个前提， starvation bug 复现不出来，第 2 节就成了假绿（实测过）。
        page.evaluate("() => document.getElementById('openSettingsBtn').click()")
        page.wait_for_timeout(900)
        page.evaluate("""() => { ['appearance','interface','fonts','ai','data'].forEach(t => switchSettingsTab(t)); }""")
        page.wait_for_timeout(700)
        page.evaluate("() => document.getElementById('settingsCloseBtn').click()")
        page.wait_for_timeout(600)

        # —— 1. OOBE 卡片必须是标准毛玻璃（约束 16 那份配方）——
        open_oobe(page)
        # 无 GPU 的环境（headless / 软件渲染）本来就该退化成实色，
        # 所以先摘掉退化标记验「玻璃那一档」，再戴回去验「退化那一档」。
        degrade = page.evaluate("""() => {
            const root = document.documentElement, body = document.body;
            const read = () => { const cs = getComputedStyle(document.querySelector('.aria-oobe-card.win11-oobe'));
                return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter,
                         radius: cs.borderTopLeftRadius }; };
            // 摘掉退化标记 → 读「玻璃那一档」；再强制戴上 → 读「退化那一档」。
            // 不依赖本机有没有 GPU，两档都必定能测到。
            const off = root.classList.contains('is-software-renderer');
            const offB = ['perf-low', 'perf-minimal'].filter(c => body.classList.contains(c));
            root.classList.remove('is-software-renderer');
            offB.forEach(c => body.classList.remove(c));
            const glass = read();
            root.classList.add('is-software-renderer');
            const solid = read();
            root.classList.remove('is-software-renderer');
            if (off) root.classList.add('is-software-renderer');
            offB.forEach(c => body.classList.add(c));
            return { glass, solid };
        }""")
        check("oobe-card-glass-background", degrade["glass"]["bg"] == "rgba(255, 255, 255, 0.12)", degrade)
        check("oobe-card-glass-blur",
              "blur(40px)" in degrade["glass"]["bf"] and "saturate(2" in degrade["glass"]["bf"],
              degrade["glass"]["bf"])
        check("oobe-card-glass-radius", degrade["glass"]["radius"] == "24px", degrade)
        check("oobe-card-degrades-on-software-renderer",
              degrade["solid"]["bg"] != "rgba(255, 255, 255, 0.12)" and degrade["solid"]["bf"] == "none",
              degrade["solid"])

        # —— 2. 英文模式下向导文案必须真的被翻（旧 bug：6ms 预算饿死后面的容器）——
        zh = page.evaluate("""() => {
            const sel = '#ariaOobeTitle, #ariaOobeSub, #ariaOobeStepTag, .aria-oobe-btn, .aria-oobe-hero-sub';
            return Array.from(document.querySelectorAll(sel)).map(e => e.textContent.trim()).join(' | ');
        }""")
        check("oobe-translated-in-english", zh and not re.search(CJK, zh), zh[:160])

        # 切步（音质+主题色那一步）后仍要是英文
        page.evaluate("() => document.querySelector('#ariaOobeNext').click()")
        page.wait_for_timeout(600)
        page.evaluate("() => document.querySelector('#ariaOobeNext').click()")
        page.wait_for_timeout(700)
        step3 = page.evaluate("""() => Array.from(document.querySelectorAll(
            '#ariaOobeTitle, #ariaOobeSub, .aria-oobe-label, .aria-oobe-title, .aria-oobe-desc, .aria-oobe-swatch-name'
        )).map(e => e.textContent.trim()).join(' | ')""")
        check("oobe-step3-translated", step3 and not re.search(CJK, step3), step3[:160])

        # —— 3. 点主题色：--aria-accent 与 --aria-accent-rgb 必须一起变（行内写入）——
        before = page.evaluate("""() => ({
            c: document.documentElement.style.getPropertyValue('--aria-accent').trim(),
            rgb: document.documentElement.style.getPropertyValue('--aria-accent-rgb').trim(),
            stored: (window.appSettings && appSettings.interface && appSettings.interface.themeColor) || ''
        })""")
        picked = page.evaluate("""() => {
            const cur = document.documentElement.style.getPropertyValue('--aria-accent').trim().toLowerCase();
            const chips = Array.from(document.querySelectorAll('.aria-oobe-colorchip'));
            const target = chips.find(c => c.dataset.c.toLowerCase() !== cur) || chips[chips.length - 1];
            target.click();
            return { hex: target.dataset.c, sel: target.classList.contains('sel'), n: chips.length };
        }""")
        # ★ 不能固定睡眠后直接读（2026-10-05 用写入栈钩子定位）：
        #   OOBE 点色块只把颜色写进令牌、暂存在向导局部变量里，appSettings 要到
        #   「完成向导」才落盘；而点后约 1.37s，applyAllSettings() 会按**尚未更新**的
        #   appSettings.interface.themeColor 重放 applyThemeColor 把预览色回写
        #   （实测三条栈：190:57 applyInterfaceSettings / 190:244 applyModeSettings /
        #    200-settings-panel.js:476 syncPreviewToMain）。
        #   固定睡 600ms 正好可能落在回写之后 → 断言随机红。
        #   改为有界轮询：令牌约 50ms 内写入，命中即通过，不等回写。
        for _ in range(30):
            if page.evaluate("() => document.documentElement.style.getPropertyValue('--aria-accent')"
                             ".trim().toLowerCase()") == picked["hex"].lower():
                break
            page.wait_for_timeout(50)
        after = page.evaluate("""() => ({
            c: document.documentElement.style.getPropertyValue('--aria-accent').trim(),
            rgb: document.documentElement.style.getPropertyValue('--aria-accent-rgb').trim(),
            chipBg: (document.querySelector('.aria-oobe-colorchip.sel') || {}).textContent
        })""")
        want = page.evaluate("""(hex) => { const n = parseInt(hex.slice(1), 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', '); }""", picked["hex"])
        check("oobe-chip-click-selects", picked["sel"], picked)
        check("theme-color-var-follows", after["c"].lower() == picked["hex"].lower(), after)
        check("theme-color-rgb-follows", after["rgb"] == want, {"rgb": after["rgb"], "want": want})
        # ★ 反向钉住「预览色被异步回写」的 bug（2026-10-05 修）：点后约 1.37s，
        #   applyAllSettings() 会按 appSettings.interface.themeColor 重放主题色
        #   （栈：190:57 applyInterfaceSettings / 190:244 applyModeSettings /
        #    200-settings-panel.js:476 syncPreviewToMain）。修复前向导只把颜色存在
        #   局部变量里、appSettings 要到「完成向导」才更新，重放就会把它回写成旧色。
        #   这里跨过重放窗口再读一次，必须仍是选中色。
        page.wait_for_timeout(2200)
        survived = page.evaluate("() => document.documentElement.style.getPropertyValue('--aria-accent').trim()")
        check("theme-color-survives-reapply", survived.lower() == picked["hex"].lower(), {"after": survived})

        # 完成向导：颜色要落进 appSettings（原先只写没人读的 aria_theme_color）
        page.evaluate("""async () => {
            for (let i = 0; i < 6; i++) {
                const b = document.querySelector('#ariaOobeNext');
                if (!b || !document.getElementById('ariaOobeOverlay')) break;
                b.click();
                await new Promise(r => setTimeout(r, 450));
            }
        }""")
        page.wait_for_timeout(900)
        done = page.evaluate("""() => ({
            gone: !document.getElementById('ariaOobeOverlay'),
            stored: (window.appSettings && appSettings.interface && appSettings.interface.themeColor) || ''
        })""")
        check("oobe-persists-theme-into-settings",
              done["gone"] and done["stored"].lower() == picked["hex"].lower(), done)
        check("oobe-finish-writes-through-blocked-save", len(saved) > 0, f"{len(saved)} 次")

        # —— 4. 切页签不得让内容左右跳（滚动条槽常驻）——
        page.evaluate("() => document.getElementById('openSettingsBtn').click()")
        page.wait_for_timeout(700)
        gutter = page.evaluate("() => getComputedStyle(document.getElementById('settingsBody')).scrollbarGutter")
        check("settings-scroll-gutter-stable", gutter.startswith("stable"), gutter)

        def probe(tab):
            return page.evaluate("""(tab) => {
                switchSettingsTab(tab);
                const body = document.getElementById('settingsBody');
                const sec = body.querySelector('.settings-section[data-section="' + tab + '"]');
                const first = sec && (sec.querySelector('.settings-group')
                    || sec.querySelector('.setting-row') || sec.firstElementChild);
                if (!first) return null;
                return { cw: body.clientWidth, x: Math.round(first.getBoundingClientRect().x * 10) / 10,
                         scrollH: body.scrollHeight, clientH: body.clientHeight,
                         /* 外观节是**两栏**（左侧模式栏），首元素 x 天然比别人靠右，
                            不能拿它当"单栏长页"基准，否则"左右不跳"永远是假红 */
                         twoCol: !!sec.querySelector('[data-mode-section]') };
            }""", tab)

        # ★ 不再写死"关于页一定短"：关于页现在承载许可与第三方声明（约 270 行），
        #   高度早就超过视口了 —— 写死节名只会随内容增长再次变红。
        #   被测的是「scrollbar-gutter 让内容宽度/左边界在"有滚动条/无滚动条"两种页面上
        #   都保持不变」，与具体是哪一节无关，所以这里**动态挑**一个真的不出滚动条的节
        #   （以及一个一定出的节）来对比。
        tabs = page.evaluate("() => [...document.querySelectorAll('.settings-section[data-section]')]"
                             ".map(s => s.dataset.section)")
        scan = []
        for t in tabs:
            m = probe(t)
            page.wait_for_timeout(180)
            if m:
                m["tab"] = t
                scan.append(m)
        # 两栏节（外观）不参与对比：它的首元素 x 天然靠右（见 probe 里的 twoCol 说明）
        single = [s for s in scan if not s.get("twoCol")]
        shorts = [s for s in single if s["scrollH"] <= s["clientH"] + 1]
        longs = [s for s in single if s["scrollH"] > s["clientH"] + 1]
        short = shorts[0] if shorts else None
        long = longs[0] if longs else None
        back = probe(short["tab"]) if short else None
        page.wait_for_timeout(400)
        scan_brief = [{k: s[k] for k in ("tab", "scrollH", "clientH", "twoCol")} for s in scan]
        check("short-page-really-has-no-scrollbar", bool(short), {"short": short, "scan": scan_brief})
        check("long-page-really-scrolls", bool(long), {"long": long, "scan": scan_brief})
        check("content-width-stable-across-tabs", short and long and short["cw"] == long["cw"],
              {"short": short, "long": long})
        check("no-h-shift-between-tabs", short and long and abs(short["x"] - long["x"]) < 0.6,
              {"short": short, "long": long})
        check("no-h-shift-round-trip", back and short and abs(back["x"] - short["x"]) < 0.6,
              {"first": short, "back": back})
        # ★ 反向自检（想证明上面三条不是假绿）：把 scrollbar-gutter 改回 auto，
        #   看短页/长页的内容宽度会不会重新出现差值。
        #   ⚠ 实测在本机 headless Chromium 里**不会出现**：即使加了
        #   --disable-features=OverlayScrollbar（stable 时确实留出了 10px 槽，
        #   1245 vs 1255 可证），auto 时长页的 clientWidth 仍与短页相同 =
        #   这个构建里滚动条不吃布局宽度。所以偏移只在真机（WebView2 的经典滚动条）
        #   成立，这里只打印不断言；机制本身由上面 settings-scroll-gutter-stable
        #   那条**声明级**断言钉住。
        page.evaluate("""() => {
            const s = document.createElement('style');
            s.id = 'abNoGutter';
            s.textContent = '#settingsBody{scrollbar-gutter:auto !important}';
            document.head.appendChild(s);
        }""")
        a = probe("about")
        page.wait_for_timeout(400)
        c = probe("playback")
        page.wait_for_timeout(400)
        page.evaluate("() => document.getElementById('abNoGutter').remove()")
        print("INFO  去掉 gutter 后 短/长页 clientWidth = %s / %s（相等 = 本环境滚动条不吃宽度，"
              "偏移需在真机看）" % (a and a["cw"], c and c["cw"]))
        page.evaluate("() => document.getElementById('settingsCloseBtn').click()")

        check("no-page-errors", not errors, errors[:3])
        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
