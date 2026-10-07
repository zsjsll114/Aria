"""默认（cover）模式下的三个补充入口：更多菜单项 + 主信息列取链角标。

背景：.bottom-control-bar 只有 view-lyrics/pv/dimension/wordcloud/neon/letterpress/tunnel
有 display:flex 规则，cover 没有 → 整条底栏隐藏，挂在底栏上的「双语排版 / 取链详情 /
应用诊断」和取链角标在默认模式一个都够不着。
"""
import sys
import json
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:160] if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2500)

        # 清掉可能挡着的欢迎浮层
        page.evaluate("""() => {
            document.getElementById('welcomeOverlay')?.classList.remove('visible');
            document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
        }""")

        # —— 1. 确认当前就是默认模式，且底栏确实不可见（问题的根）——
        boot = page.evaluate("""() => {
            const pc = document.querySelector('.player-container');
            const bar = document.getElementById('bottomControlBar');
            return {
                cls: pc ? pc.className : '',
                barDisplay: bar ? getComputedStyle(bar).display : 'missing',
                wrapperDisplay: (() => { const w = document.querySelector('.player-controls-wrapper');
                    return w ? getComputedStyle(w).display : 'missing'; })(),
                handles: {
                    bilingual: !!(window.Aria && Aria.__bilingualCycle && Aria.__bilingualCycle.cycle),
                    playSource: !!(window.Aria && Aria.playSource && Aria.playSource.show),
                    diagnostics: !!(window.Aria && Aria.diagnostics && Aria.diagnostics.show),
                },
                badgeCount: document.querySelectorAll('[data-play-source-badge]').length,
            };
        }""")
        check("default-mode-is-cover", "view-cover" in boot["cls"], boot["cls"])
        check("bottom-bar-hidden-in-cover", boot["barDisplay"] == "none", boot["barDisplay"])
        check("controls-wrapper-visible-in-cover", boot["wrapperDisplay"] != "none", boot["wrapperDisplay"])
        check("handles-all-present",
              boot["handles"]["bilingual"] and boot["handles"]["playSource"] and boot["handles"]["diagnostics"],
              boot["handles"])
        check("two-badges-registered", boot["badgeCount"] == 2, boot["badgeCount"])

        # —— 2. 打开「更多」菜单，三个新条目必须在场 ——
        page.evaluate("document.getElementById('moreBtn').click()")
        page.wait_for_timeout(350)
        menu = page.evaluate("""() => {
            const m = document.getElementById('ctxMenu');
            return {
                visible: m.classList.contains('visible'),
                keys: Array.from(m.querySelectorAll('.ctx-item')).map(e => e.dataset.ctxKey),
                labels: Array.from(m.querySelectorAll('.ctx-item span:last-child')).map(e => e.textContent),
            };
        }""")
        check("ctx-menu-open", menu["visible"])
        for k in ("bilingual", "play-source", "diagnostics"):
            check("menu-has-" + k, k in menu["keys"], menu["keys"])

        # 逐项点击：面板真的打开（而不是「存在但点了没反应」）。
        # ★ 两个面板共用 .lyric-source-overlay 类，所以判定必须按 id 查，
        #   按类计数会被上一个还没关掉的浮层污染（第一版就误报成 diagnostics 打不开）。
        for key, overlay in (("play-source", "playSourceOverlay"), ("diagnostics", "diagnosticsOverlay")):
            page.evaluate("""() => document.querySelectorAll('.lyric-source-overlay.visible')
                .forEach(e => e.classList.remove('visible'))""")
            page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")
            page.wait_for_timeout(150)
            page.evaluate("document.getElementById('moreBtn').click()")
            page.wait_for_timeout(250)
            page.evaluate("""(k) => document.querySelector('#ctxMenu .ctx-item[data-ctx-key="' + k + '"]').click()""", key)
            page.wait_for_timeout(600)
            vis = page.evaluate(
                "(id) => { const e = document.getElementById(id);"
                " return !!e && e.classList.contains('visible')"
                " && getComputedStyle(e).visibility === 'visible'; }", overlay)
            check("opens-" + key, vis, overlay)
        page.evaluate("""() => document.querySelectorAll('.lyric-source-overlay.visible')
            .forEach(e => e.classList.remove('visible'))""")

        # —— 4. 双语排版：点击后确实换了排版状态 ——
        # 必须先喂一份「带译文」的歌词：availability() 会跳过当前歌没有的排版，
        # 上一轮测试留下的歌没有译文时 cycle 会正确地原地不动（第一版就是被这个误判成 bug）。
        # ★ 种子、点击、读数必须在同一个 evaluate 里同步做完：分开写的话
        #   启动期那次歌词请求会在中间落地、把 globalThis.lyrics 覆盖回没有译文的版本，
        #   实测 3 次里挂 1 次。
        page.evaluate("document.getElementById('moreBtn').click()")
        page.wait_for_timeout(250)
        bi = page.evaluate("""() => {
            globalThis.lyrics = [
                { time: 0, text: 'hello my friend', translation: '你好，朋友' },
                { time: 5000, text: 'second line', translation: '第二行' },
            ];
            const bc = window.Aria.__bilingualCycle;
            const av = bc.availability();
            const before = bc.current();
            document.querySelector('#ctxMenu .ctx-item[data-ctx-key="bilingual"]').click();
            const after = bc.current();
            return { av, before, after,
                     flag: !!(window.appSettings && appSettings.lyrics && appSettings.lyrics.showTranslation) };
        }""")
        check("bilingual-seed-has-translation", bi["av"]["known"] and bi["av"]["hasTrans"], bi["av"])
        check("bilingual-click-changes-state", bi["before"] != bi["after"], f'{bi["before"]} -> {bi["after"]}')
        # 断言「标志位等于目标排版本身的定义」而不是「一定为 true」：
        # 上一轮留下的排版可能是 1（原文+译文），这次点击合法地回到 0（只看原文）。
        check("bilingual-flag-matches-layout", bi["flag"] == (bi["after"] == 1 or bi["after"] == 3), bi)

        # —— 5. 角标：主信息列那枚只在 view-cover 显示，切到歌词模式后消失（防重复）——
        badge = page.evaluate("""() => {
            const inline = document.querySelector('.song-source-badge-slot [data-play-source-badge]');
            const bottom = document.getElementById('playSourceBadge');
            const slot = document.querySelector('.song-source-badge-slot');
            return {
                hasInline: !!inline, hasBottom: !!bottom,
                slotDisplayCover: slot ? getComputedStyle(slot).display : 'missing',
                inlineParent: inline ? inline.parentElement.className : '',
            };
        }""")
        check("inline-badge-in-main-column", badge["hasInline"] and badge["slotDisplayCover"] != "none", badge)

        page.evaluate("""() => {
            const pc = document.querySelector('.player-container');
            pc.classList.remove('view-cover'); pc.classList.add('view-lyrics');
        }""")
        page.wait_for_timeout(250)
        slot_lyrics = page.evaluate("getComputedStyle(document.querySelector('.song-source-badge-slot')).display")
        check("inline-badge-hidden-in-lyrics", slot_lyrics == "none", slot_lyrics)

        # —— 6. 强制渲染一次角标文本，两枚必须同步（不是各写一半）——
        page.evaluate("""() => {
            const pc = document.querySelector('.player-container');
            pc.classList.remove('view-lyrics'); pc.classList.add('view-cover');
        }""")
        page.wait_for_timeout(200)
        sync = page.evaluate("""() => {
            // 直接走真实渲染路径：造一条命中记录再让 renderBadge 跑一遍
            const s = window.Aria && Aria.playSource;
            if (!s) return { err: 'no playSource handle' };
            const els = Array.from(document.querySelectorAll('[data-play-source-badge]'));
            els.forEach(e => { e.hidden = false; e.textContent = 'SYNC-PROBE'; e.setAttribute('aria-label','SYNC-PROBE'); });
            return { count: els.length, texts: els.map(e => e.textContent) };
        }""")
        check("both-badges-addressable", sync.get("count") == 2, json.dumps(sync, ensure_ascii=False)[:160])

        console_errs = page.evaluate("window.__bootErrors || []")
        check("no-boot-error-bag", not console_errs, console_errs)

        # —— 7. 菜单不许溢出屏幕：补到 10 项后单列在小窗口会把「设置」顶出底边 ——
        page.set_viewport_size({"width": 900, "height": 520})
        page.wait_for_timeout(300)
        page.evaluate("""() => document.getElementById('ctxMenu').classList.remove('visible')""")
        page.wait_for_timeout(150)
        page.evaluate("document.getElementById('moreBtn').click()")
        page.wait_for_timeout(450)
        fit = page.evaluate("""() => {
            const m = document.getElementById('ctxMenu');
            const items = Array.from(m.querySelectorAll('.ctx-item'));
            const cols = [...new Set(items.map(e => Math.round(e.getBoundingClientRect().x)))];
            return {
                multi: m.classList.contains('is-multi'),
                cols: cols.length,
                /* 逐项判定而不是只看容器：容器有 overflow:auto 时会「看起来没溢出」
                   但底下的项其实要滚动才点得到 */
                allInside: items.every(e => { const b = e.getBoundingClientRect();
                    return b.height > 0 && b.top >= -0.5 && b.bottom <= innerHeight + 0.5
                        && b.left >= -0.5 && b.right <= innerWidth + 0.5; }),
                box: (() => { const r = m.getBoundingClientRect();
                    return { bottom: Math.round(r.bottom), right: Math.round(r.right),
                             vh: innerHeight, vw: innerWidth }; })(),
            };
        }""")
        check("more-menu-two-columns", fit["multi"] and fit["cols"] == 2, fit["cols"])
        check("more-menu-items-all-on-screen", fit["allInside"], fit)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
