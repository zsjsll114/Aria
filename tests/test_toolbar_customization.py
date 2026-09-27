"""右上角工具栏自定义（292-toolbar.js）：隐藏 → 「更多」菜单 → 原按钮行为 → 刷新后仍在。

需求：被移除的按钮不许真的消失，得能在「更多」菜单里点到，而且点的还是那颗按钮
自己的处理函数（不是复制一份逻辑）。

两个判据上的坑（都是本仓库踩过的）：
  · 「不在了」用 getBoundingClientRect()/computed display 判，不用「还是不是孩子」判：
    292 刻意把隐藏的按钮留在原父节点上只加 display:none（搬走会留在 Tab 序列里，
    而 cloneNode 会静默丢掉别的分片绑的监听器）。所以断言写的是「看不见」+「不在可见序列里」。
  · 「更多」菜单有两面，cover 模式下只有 #moreBtn 那张动态 ctx 菜单够得着，
    底栏的静态 .more-submenu 只在歌词/PV 那几面可见 —— 两面都得有条目。
"""
import sys
import json
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
LYRICS_URL = "http://localhost:8001/lyrics.html"
RESULTS = []

TARGET = "openStatsBtn"        # 播放统计：点击后 #statsOverlay 变 visible，判据干净
SWAPPED = "openRankingsBtn"    # 音乐榜单：用来验证「挪位置之后监听器还活着」→ #rankingsOverlay


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))


def settle(page, ms=4000):
    """等首屏装配完（Aria.__toolbar 由 292 的 boot 挂上，晚于它的是 999 审计）"""
    page.wait_for_function(
        "() => !!(window.Aria && Aria.__toolbar && Aria.__toolbar.controls "
        "&& Aria.__toolbar.controls().length > 0)", timeout=30000)
    page.wait_for_timeout(ms)


def dismiss_blockers(page):
    """欢迎层 / 首次设置向导 / 021 的动态确认框都会拦住指针事件
       （test_settings_smoke.py 里那批用例之所以全程用 evaluate 点击就是这个原因），
       本用例要走真实点击，先摘掉。"""
    page.evaluate("""() => {
        ['welcomeOverlay', 'ariaOobeOverlay'].forEach(id => {
            const e = document.getElementById(id);
            if (e) { e.classList.remove('visible'); e.style.display = 'none'; }
        });
        document.querySelectorAll('.aria-dialog-overlay').forEach(e => e.remove());
    }""")
    page.wait_for_timeout(150)


# ★ 本机实测（2026-09-26）的两个间歇性拦路者，必须在 goto 之前预置掉（dismiss_blockers
#   跑在 4~5s，摘不到一个「还没出生」的浮层，所以只能从源头不让它出生）：
#   1) AI 反代隐私确认：boot 的「开篇歌单」预加载 preloadDefaultSong()
#      → loadPlaylistTrack(preloadOnly=true) → 175-track-index-online.js:1027 在**预加载
#      分支**里就调了 triggerAiAnalysisIfNeeded() → 201-settings-ai.js:1393 那份一次性
#      确认（showGlassConfirm → 021 的 .aria-dialog-overlay，fixed inset:0 / z-index:2400）
#      在启动后 ~6-8s 落屏并把整页挡住，直到有人点它。实测同一条入口 A/B：
#      不种标记 overlays=1（正是 step4 报的那句 "intercepts pointer events"），种了 overlays=0。
#      它只在本机 user_config.json 里 ai.enabled + apiBase 含 de5.net 时才走到
#      （CI 默认 ai.enabled:false，201 第 1386 行直接 return），且要预加载真取到直链——
#      这就是本用例「上一次跑绿、这一次超时」的来源。
#   2) 首次打开引导 OOBE：000-tooltip.js 在 window load 之后 900ms 才 build()，
#      比 dismiss_blockers 还晚，z-index 2147483000 盖住全页（实测拦过 step4/step7 的点击）。
#   两个都是**别的功能**的一次性浮层，与右上角工具栏无关。做法沿用本仓库先例
#   （test_pv_handoff / test_pv_scene_group / test_pv_geo_mosaic 用 add_init_script 预置
#   lyrics_player_performance 短路启动期性能自检），把「已看过」标记种进 localStorage。
SEED_INIT_SCRIPT = """
try {
    localStorage.setItem('aria_ai_proxy_notice', '1');
    localStorage.setItem('aria_oobe_done', '1');
} catch (e) {}
"""


def reset_stale_pref(page):
    """清掉上一次运行残留的工具栏偏好。

    saveSettings() 会把整份 settings POST 到 /api/config/save 落进 user_config.json，
    而 8001 这份配置是全机共享的（本机那个正在播的 Aria 客户端也读写它）。
    上一次运行只要中途崩在 step4~step8 之间，「藏了 openStatsBtn / 换了顺序」就留在
    配置里，下一次运行第 1 步的 default-pref-absent 会因此假失败（实测踩过）。
    走 292 自己的 reset（= 写回默认布局，buildPref 判等后把键整个删掉），不硬写 localStorage。
    """
    if pref(page) is None:
        return
    page.evaluate("Aria.__toolbar.reset()")
    page.wait_for_function(
        "() => { const itf = (window.appSettings && appSettings.interface) || {}; return !itf.toolbar; }",
        timeout=8000)
    # 400ms 防抖 + 一次 POST 要落地，否则 step7 reload 又会把脏偏好读回来
    page.wait_for_timeout(900)
    check("stale-pref-reset-before-run", pref(page) is None, pref(page))


def bar_state(page):
    """顶栏与各按钮的可见性快照（全部按 rect 判，不按「在不在 DOM 里」判）"""
    return page.evaluate("""() => {
        const host = document.querySelector('.top-action-buttons');
        const hr = host.getBoundingClientRect();
        const kids = Array.from(host.children);
        const shown = kids.filter(e => e.getBoundingClientRect().width > 0);
        return {
            barVisible: hr.width > 0 && hr.height > 0,
            barRect: {w: Math.round(hr.width), h: Math.round(hr.height)},
            ids: kids.map(e => e.id),
            shownIds: shown.map(e => e.id),
            hiddenClass: kids.filter(e => e.classList.contains('tb-ctl-hidden')).map(e => e.id),
            zeroSized: kids.filter(e => e.classList.contains('tb-ctl-hidden'))
                           .map(e => [e.id, Math.round(e.getBoundingClientRect().width),
                                      getComputedStyle(e).display]),
            targetDisplay: getComputedStyle(document.getElementById('openStatsBtn')).display,
            targetRect: (() => { const r = document.getElementById('openStatsBtn').getBoundingClientRect();
                                 return {w: Math.round(r.width), h: Math.round(r.height)}; })(),
        };
    }""")


def pref(page):
    return page.evaluate(
        "() => (window.appSettings && appSettings.interface && appSettings.interface.toolbar) || null")


def ctx_entries(page):
    return page.evaluate("""() => {
        const menu = document.getElementById('ctxMenu');
        const items = Array.from(menu.querySelectorAll('.tb-overflow-item'));
        return {
            visible: menu.classList.contains('visible'),
            ids: items.map(e => e.dataset.toolbarId),
            labels: items.filter(e => e.dataset.toolbarId !== '@separator')
                         .map(e => e.textContent.trim()),
            /* 短名 / 悬停长说明 / 选中态三件事，按条目 id 一起取回来 */
            byId: items.filter(e => e.dataset.toolbarId !== '@separator')
                       .reduce((acc, e) => {
                            const label = e.querySelector('.tb-overflow-label');
                            acc[e.dataset.toolbarId] = {
                                label: label ? label.textContent.trim() : '',
                                tip: e.getAttribute('data-tooltip') || '',
                                on: e.dataset.on,
                                checked: !!e.querySelector('.tb-overflow-check svg'),
                                bg: getComputedStyle(e).backgroundColor,
                            };
                            return acc; }, {}),
            inside: items.map(e => { const b = e.getBoundingClientRect();
                return b.width > 0 && b.top >= -0.5 && b.bottom <= innerHeight + 0.5
                    && b.left >= -0.5 && b.right <= innerWidth + 0.5; }),
        };
    }""")


def submenu_entries(page):
    return page.evaluate("""() => {
        const sub = document.getElementById('moreSubmenu');
        if (!sub) return null;
        return {
            ids: Array.from(sub.querySelectorAll(':scope > .tb-overflow-item')).map(e => e.dataset.toolbarId),
            flag: sub.classList.contains('has-toolbar-items'),
            total: sub.querySelectorAll('.more-item').length,
        };
    }""")


def open_interface_settings(page):
    page.evaluate("document.getElementById('openSettingsBtn').click()")
    page.wait_for_timeout(500)
    page.evaluate("switchSettingsTab('interface')")
    page.wait_for_timeout(600)


def close_settings(page):
    """设置面板是 fullscreen-mode，不关掉会盖住底栏那颗 #moreBtn 的指针事件。
       必须等 visibility 真的翻过去（motion.css 的退场是 visibility 0s linear <退场时长>），
       只 remove class 就点会被自己刚关掉的面板挡住。"""
    page.evaluate("document.getElementById('settingsOverlay').classList.remove('visible')")
    page.wait_for_function(
        "() => getComputedStyle(document.getElementById('settingsOverlay')).visibility === 'hidden'",
        timeout=8000)
    page.wait_for_timeout(250)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script(SEED_INIT_SCRIPT)
        errors = []
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

        page.goto(URL, wait_until="load")
        settle(page)
        dismiss_blockers(page)
        reset_stale_pref(page)

        # —— 1. 默认态：整条工具栏可见，一颗都没藏 ——
        # 样式必须在 index.html 里 link 上：本仓库有过 feature CSS 被漏掉、浮层裸奔的先例，
        # 而 2026-09-26 那次脚本重写 index.html 真的把这一行冲掉过（症状只是「设置里没样式」）。
        css = page.evaluate(
            "() => { const l = document.querySelector('link[href*=\"toolbar.css\"]');"
            " return l ? (l.sheet ? 'loaded' : 'linked-unloaded') : null; }")
        check("toolbar-css-linked", css is not None, css)
        base = bar_state(page)
        check("top-bar-is-visible", base["barVisible"], base["barRect"])
        check("default-nothing-hidden", base["hiddenClass"] == [], base["hiddenClass"])
        check("default-pref-absent", pref(page) is None, pref(page))
        check("registry-covers-bar", set(base["shownIds"]) >= {
            "openSearchBtn", "openDailyBtn", "openRankingsBtn", TARGET,
            "openFavoritesBtn", "openPlaylistsBtn", "openViewModeBtn", "openSettingsBtn"},
            base["shownIds"])

        # —— 2. 设置页那一组必须真的渲染出来（本仓库的 index.html 有未闭合 div，
        #       [data-section="interface"] 会被解析进隐藏的 .appearance-section 里，
        #       292 的 syncGroupHost 负责在这种情形下把组挪到看得见的地方）——
        open_interface_settings(page)
        grp = page.evaluate("""() => {
            const g = document.getElementById('toolbarSettingsGroup');
            if (!g) return {missing: true};
            const r = g.getBoundingClientRect();
            const rows = Array.from(g.querySelectorAll('[data-toolbar-id]'));
            return {parent: g.parentElement.id || g.parentElement.className, rendered: !!g.offsetParent,
                    h: Math.round(r.height), rows: rows.map(e => e.dataset.toolbarId),
                    rowHeights: rows.map(e => Math.round(e.getBoundingClientRect().height)),
                    restoreBtn: !!g.querySelector('#tbRestoreDefaults')};
        }""")
        check("settings-group-mounted", not grp.get("missing"), grp.get("parent"))
        check("settings-group-rendered", grp["rendered"] and grp["h"] > 100,
              {"parent": grp["parent"], "h": grp["h"]})
        check("settings-lists-controls", TARGET in grp["rows"] and "openSettingsBtn" in grp["rows"],
              grp["rows"])
        check("every-row-has-height", all(h > 0 for h in grp["rowHeights"]), grp["rowHeights"])
        check("restore-default-present", grp["restoreBtn"])

        # 「设置」是唯一的固定项（藏掉它就等于把自己锁在配置外面）
        pinned = page.evaluate("""() => {
            const row = document.querySelector('#toolbarCtlRows [data-toolbar-id="openSettingsBtn"]');
            return {disabled: !!row.querySelector('[data-tb-act="toggle"]').disabled,
                    on: !!row.querySelector('.setting-toggle.on')};
        }""")
        check("settings-btn-pinned", pinned["disabled"] and pinned["on"], pinned)
        page.evaluate("Aria.__toolbar.hide('openSettingsBtn')")
        page.wait_for_timeout(250)
        check("pinned-cannot-be-hidden-by-api",
              bar_state(page)["hiddenClass"] == [], bar_state(page)["hiddenClass"])

        # —— 3. 真实点击「隐藏」：按钮从可见序列里消失 —— 
        page.click('#toolbarCtlRows [data-toolbar-id="%s"] [data-tb-act="toggle"]' % TARGET)
        page.wait_for_timeout(400)
        after = bar_state(page)
        check("hidden-is-zero-sized", after["targetRect"] == {"w": 0, "h": 0}
              and after["targetDisplay"] == "none",
              {"rect": after["targetRect"], "display": after["targetDisplay"]})
        check("hidden-not-in-visible-sequence", TARGET not in after["shownIds"], after["shownIds"])
        check("bar-still-visible-after-hide", after["barVisible"]
              and after["barRect"]["h"] == base["barRect"]["h"]
              and after["barRect"]["w"] < base["barRect"]["w"],
              {"after": after["barRect"], "base": base["barRect"]})
        check("visible-and-hidden-disjoint",
              set(after["shownIds"]).isdisjoint(set(after["hiddenClass"]))
              and len(after["shownIds"]) + len(after["hiddenClass"]) == len(after["ids"]),
              {"shown": after["shownIds"], "hidden": after["hiddenClass"]})
        check("hidden-node-kept-in-place", TARGET in after["ids"],
              "隐藏=display:none，节点留在原父节点（搬走会留在 Tab 序列里）")
        check("pref-persisted-shape", (pref(page) or {}).get("bars", {}).get("top", {}).get("hidden")
              == [TARGET], pref(page))
        row_state = page.evaluate("""() => {
            const row = document.querySelector('#toolbarCtlRows [data-toolbar-id="openStatsBtn"]');
            return {isHidden: row.classList.contains('is-hidden'),
                    toggleOn: !!row.querySelector('.setting-toggle.on')};
        }""")
        check("settings-row-reflects-hidden", row_state["isHidden"] and not row_state["toggleOn"],
              row_state)

        # —— 4. cover 模式下够得着的那面「更多」：#moreBtn → 动态 ctx 菜单 ——
        # 设置面板是 fullscreen-mode，不关掉会盖住底栏那颗 #moreBtn 的指针事件
        close_settings(page)
        page.click("#moreBtn")
        page.wait_for_timeout(400)
        menu = ctx_entries(page)
        check("ctx-menu-open", menu["visible"], menu)
        check("ctx-menu-has-entry", TARGET in menu["ids"], menu["ids"])
        check("ctx-entry-uses-button-label", menu["labels"] == ["播放统计"], menu["labels"])
        check("ctx-entry-on-screen", all(menu["inside"]), menu["inside"])
        page.click('#ctxMenu .tb-overflow-item[data-toolbar-id="%s"]' % TARGET)
        page.wait_for_timeout(700)
        opened = page.evaluate("""() => ({
            stats: document.getElementById('statsOverlay')?.classList.contains('visible'),
            menuClosed: !document.getElementById('ctxMenu').classList.contains('visible'),
        })""")
        check("menu-entry-fires-original-handler", opened["stats"], opened)
        check("menu-entry-closes-menu", opened["menuClosed"], opened)
        page.evaluate("document.getElementById('statsOverlay')?.classList.remove('visible')")

        # —— 5. 底栏那面静态 .more-submenu（歌词/PV 模式下唯一入口）也要有 ——
        sub = submenu_entries(page)
        check("static-submenu-has-entry", sub and TARGET in sub["ids"], sub)
        check("static-submenu-scrollable", sub and sub["flag"], sub)
        fired = page.evaluate("""() => {
            const item = document.querySelector('#moreSubmenu .tb-overflow-item[data-toolbar-id="openStatsBtn"]');
            item.click();
            return {closed: !document.getElementById('moreSubmenu').classList.contains('open')};
        }""")
        page.wait_for_timeout(600)
        check("static-submenu-entry-fires-handler",
              page.evaluate("document.getElementById('statsOverlay').classList.contains('visible')"),
              fired)
        page.evaluate("document.getElementById('statsOverlay')?.classList.remove('visible')")

        # —— 6. 溢出条目的名字与「开没开」（2026-09-26 用户实测反馈的两条）——
        #   ① 条目名照 data-tooltip 取名会撑出一整行
        #      （「本机 Now Playing 接管（跟播其它播放器）」），短名在 aria-label 里；
        #   ② 收进「更多」的开关按钮开没开完全没有视觉差别。
        page.evaluate("Aria.__toolbar.hide('npQuickToggle')")
        settle(page, ms=600)
        page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")
        page.click("#moreBtn")
        page.wait_for_timeout(400)
        m1 = ctx_entries(page)
        np = m1["byId"].get("npQuickToggle", {})
        check("overflow-label-is-short", np.get("label") == "本机 Now Playing 接管", np)
        check("overflow-long-text-moves-to-hover", "跟播其它播放器" in np.get("tip", ""), np.get("tip"))
        check("overflow-off-has-no-check",
              np.get("on") == "0" and not np.get("checked"), np)
        # 只挂类不走 232 的 setter：这里验的是「菜单读得出状态」，不是接管功能本身
        page.evaluate("document.getElementById('npQuickToggle').classList.add('on')")
        page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")
        page.click("#moreBtn")
        page.wait_for_timeout(400)
        np2 = ctx_entries(page)["byId"].get("npQuickToggle", {})
        check("overflow-on-marks-selected", np2.get("on") == "1" and np2.get("checked"), np2)
        check("overflow-on-tinted-like-speed-item",
              np2.get("bg") != np.get("bg") and np2.get("bg", "").startswith("rgba("),
              {"on": np2.get("bg"), "off": np.get("bg")})
        page.evaluate("""() => {
            document.getElementById('npQuickToggle').classList.remove('on');
            document.getElementById('ctxMenu').classList.remove('visible');
            Aria.__toolbar.show('npQuickToggle');
        }""")
        settle(page, ms=600)

        # —— 7. 排序：insertBefore 之后监听器必须还活着（cloneNode 会静默丢）——
        before_order = bar_state(page)["ids"]
        open_interface_settings(page)
        page.click('#toolbarCtlRows [data-toolbar-id="%s"] [data-tb-act="up"]' % SWAPPED)
        page.wait_for_timeout(400)
        after_order = bar_state(page)["ids"]
        check("reorder-changed-dom-order",
              after_order.index(SWAPPED) < after_order.index("openDailyBtn")
              and before_order.index(SWAPPED) > after_order.index(SWAPPED),
              {"before": before_order[:5], "after": after_order[:5]})
        check("reorder-kept-same-set", sorted(after_order) == sorted(before_order), after_order)
        check("hidden-survives-reorder", TARGET in bar_state(page)["hiddenClass"])
        close_settings(page)
        page.click("#%s" % SWAPPED)
        page.wait_for_timeout(800)
        check("moved-button-still-works",
              page.evaluate("!!document.querySelector('#rankingsOverlay.visible, .search-overlay.visible')"),
              "挪过位置的按钮点下去仍然开它自己的面板")
        page.evaluate("""() => document.querySelectorAll('.search-overlay.visible, .lyric-source-overlay.visible')
            .forEach(e => e.classList.remove('visible'))""")

        # —— 8. 刷新后仍在（偏好走 appSettings.interface.toolbar → localStorage + /api/config）——
        page.reload(wait_until="load")
        settle(page, ms=3000)
        dismiss_blockers(page)
        reloaded = bar_state(page)
        check("persisted-hidden-after-reload", TARGET not in reloaded["shownIds"]
              and reloaded["targetDisplay"] == "none",
              {"shown": reloaded["shownIds"], "display": reloaded["targetDisplay"]})
        check("persisted-order-after-reload",
              reloaded["ids"].index(SWAPPED) < reloaded["ids"].index("openDailyBtn"),
              reloaded["ids"][:5])
        check("pref-still-there-after-reload",
              (pref(page) or {}).get("bars", {}).get("top", {}).get("hidden") == [TARGET], pref(page))
        page.click("#moreBtn")
        page.wait_for_timeout(400)
        check("menu-entry-after-reload", TARGET in ctx_entries(page)["ids"], ctx_entries(page)["ids"])
        page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")

        # —— 9. 恢复默认：全部回来、偏好整份删掉、菜单条目一起消失 ——
        open_interface_settings(page)
        page.click("#tbRestoreDefaults")
        page.wait_for_timeout(500)
        restored = bar_state(page)
        check("restore-shows-everything", restored["hiddenClass"] == []
              and len(restored["shownIds"]) == len(restored["ids"]), restored["hiddenClass"])
        check("restore-clears-pref", pref(page) is None, pref(page))
        check("restore-drops-menu-entries", TARGET not in submenu_entries(page)["ids"],
              submenu_entries(page))
        # 关掉面板再点底栏那颗 #moreBtn（设置面板是 fullscreen-mode，会挡指针）
        close_settings(page)
        page.click("#moreBtn")
        page.wait_for_timeout(400)
        check("restore-drops-ctx-entries", ctx_entries(page)["ids"] == [], ctx_entries(page))
        page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")
        check("bar-back-to-default-geometry", bar_state(page)["barRect"] == base["barRect"],
              bar_state(page)["barRect"])

        # —— 10. 桌面歌词窗口没有右上角工具栏：整套功能必须静默缺席、不报错 ——
        page.goto(LYRICS_URL, wait_until="load")
        page.wait_for_timeout(2500)
        lyrics = page.evaluate("""() => ({
            hasBar: !!document.querySelector('.top-action-buttons'),
            hasGroup: !!document.getElementById('toolbarSettingsGroup'),
            hasStyle: !!document.getElementById('toolbarStyleGuard'),
            hiddenLeftover: document.querySelectorAll('.tb-ctl-hidden').length,
        })""")
        check("lyrics-window-has-no-top-bar", not lyrics["hasBar"], lyrics)
        check("lyrics-window-noop", not lyrics["hasGroup"] and lyrics["hiddenLeftover"] == 0, lyrics)

        check("no-page-errors", not errors, errors[:3])
        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
