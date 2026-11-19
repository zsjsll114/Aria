"""专注模式的浏览器接线回归（2026-09-27 重设计版）。

用户定的语义（2026-09-27 重设计，覆盖旧「静止自动进入」版）：
  · **没有自动进入**：删掉鼠标/事件静止检测，等多久都不会自己淡出；
  · 进入/退出只有两个显式开关：右上角 zenModeBtn 与 Z 键；
  · 专注态下 top-action-buttons 内其它按钮隐藏、#zenModeBtn 留在容器最右侧且容器收缩；
  · 再次点击 #zenModeBtn 可无障碍切回并完整恢复 .top-action-buttons 宽度与按钮原位；
  · info scope 只藏 .song-info-container——封面（.cover-area）留在画面并由
    coverShiftToCenter 以 FLIP 平移到视口中心，退出回原位；
  · queue scope 默认开：#plmPanel 与 #playlistManagerToggle 一起隐藏；
  · 旧配置里的 interface.zen.enabled / idleSeconds 读到了也忽略。

★ 全程 evaluate 驱动（点击用真实 click 走按钮处理器）。
"""
import json
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


def probe(page):
    """等淡出/平移过渡走完再量。"""
    page.wait_for_timeout(1100)
    return page.evaluate("""() => {
        const vis = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return 'MISSING';
            const cs = getComputedStyle(el);
            return cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05 ? 'hidden' : 'shown';
        };
        const cover = document.querySelector('.cover-area');
        const bar = document.querySelector('.top-action-buttons');
        const btn = document.getElementById('zenModeBtn');
        const normalTopBtn = document.querySelector('.top-action-buttons > *:not(#zenModeBtn)');
        const barRect = bar ? bar.getBoundingClientRect() : null;
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        return {
            zen: document.documentElement.classList.contains('is-zen'),
            scope: document.documentElement.getAttribute('data-zen-scope') || '',
            normalTopBtn: vis('.top-action-buttons > *:not(#zenModeBtn)'),
            normalTopBtnTag: normalTopBtn ? (normalTopBtn.id || normalTopBtn.className) : 'MISSING',
            zenBtn: vis('#zenModeBtn'),
            zenBtnPos: btn ? getComputedStyle(btn).position : 'MISSING',
            barWidth: barRect ? Math.round(barRect.width) : 0,
            barRight: barRect ? Math.round(barRect.right) : 0,
            btnLeft: btnRect ? Math.round(btnRect.left) : 0,
            btnRight: btnRect ? Math.round(btnRect.right) : 0,
            btnInsideViewport: !!(btnRect && btnRect.right <= window.innerWidth && btnRect.left >= 0),
            btnInBar: !!(bar && btn && btn.parentElement === bar),
            info: vis('.player-container .song-info-container'),
            cover: vis('.cover-area'),
            queuePanel: vis('#plmPanel'),
            queueFab: vis('#playlistManagerToggle'),
            coverTransform: cover ? (cover.style.transform || '(none)') : 'MISSING',
            btnPressed: btn ? btn.getAttribute('aria-pressed') : 'MISSING',
            enabledKey: 'enabled' in ((appSettings.interface.zen || {})),
        };
    }""")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function("() => window.appSettings && appSettings.lyrics", timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2000)
        page.evaluate("""() => {
            /* ★ 模拟「已完成引导」的真实状态：welcomeOverlay 带 .hidden 类留在 DOM，
               ariaOobeOverlay 完成 build 后即被 remove（000-tooltip 的机制）。
               只改 style 不行——282 的弹窗守卫按 class/DOM 存在性判定，
               hasBlockingModal() 恒真会让按钮/Z 键全被拒（测不出正路）。 */
            const perf = document.getElementById('performanceDialog');
            if (perf) perf.remove();
            const oobe = document.getElementById('ariaOobeOverlay');
            if (oobe) oobe.remove();
            const w = document.getElementById('welcomeOverlay');
            if (w) w.classList.add('hidden');
            /* 清掉持久化的 zen 偏好，回到出厂默认断言 */
            if (appSettings.interface) appSettings.interface.zen = {};
        }""")
        # 清掉可能已触发的软件渲染降级标记后的残余弹窗
        page.wait_for_timeout(1200)
        page.evaluate("document.getElementById('performanceDialog')?.remove()")

        # —— 1. 无自动进入：静置 5 秒仍不在专注态 ——
        page.wait_for_timeout(5000)
        idle = probe(page)
        check("no_idle_autocenter", idle["zen"] is False, {"zen": idle["zen"]})

        # —— 2. 真实鼠标点击右上角按钮进入：容器收缩 + 按钮留在最右侧 + 队列/控件隐藏 + 封面下移 ——
        page.locator("#zenModeBtn").click()
        zen1 = probe(page)
        check("button_enters_zen", zen1["zen"] is True and zen1["btnPressed"] == "true", zen1)
        check("top_others_hidden_bar_contracted_btn_rightmost",
              zen1["normalTopBtn"] == "hidden" and zen1["zenBtn"] == "shown"
              and zen1["zenBtnPos"] != "fixed" and zen1["btnInBar"]
              and zen1["btnInsideViewport"]
              and zen1["barWidth"] < idle["barWidth"] * 0.4
              and abs(zen1["barRight"] - zen1["btnRight"]) <= 12
              and abs(zen1["barRight"] - idle["barRight"]) <= 4, zen1)
        check("info_text_hidden_cover_shown",
              zen1["info"] == "hidden" and zen1["cover"] == "shown", zen1)
        check("queue_fab_and_panel_hidden",
              zen1["queuePanel"] == "hidden" and zen1["queueFab"] == "hidden", zen1)
        check("cover_shifted_down",
              "translateY" in zen1["coverTransform"], {"transform": zen1["coverTransform"]})

        # —— 3. 再次真实鼠标点击按钮退出：封面回原位、容器展开与按钮恢复原样式 ——
        page.locator("#zenModeBtn").click()
        zen2 = probe(page)
        check("button_exits_zen", zen2["zen"] is False and zen2["btnPressed"] == "false", zen2)
        check("cover_restored", "translateY" not in zen2["coverTransform"],
              {"transform": zen2["coverTransform"]})
        check("top_restored",
              zen2["normalTopBtn"] == "shown" and zen2["zenBtnPos"] != "fixed"
              and abs(zen2["barWidth"] - idle["barWidth"]) <= 2
              and abs(zen2["btnLeft"] - idle["btnLeft"]) <= 2, zen2)

        # —— 4. Z 键切换 ——
        page.evaluate("""() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
        }""")
        zen3 = probe(page)
        check("zkey_enters_zen", zen3["zen"] is True, {"zen": zen3["zen"]})
        page.evaluate("""() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
        }""")
        zen4 = probe(page)
        check("zkey_exits_zen", zen4["zen"] is False, {"zen": zen4["zen"]})

        # —— 5. 旧偏好键被忽略：enabled 写进配置也不影响行为 ——
        page.evaluate("""() => {
            appSettings.interface.zen = { enabled: true, idleSeconds: 1 };
        }""")
        page.wait_for_timeout(1500)
        stale = probe(page)
        check("legacy_enabled_ignored", stale["zen"] is False, {"zen": stale["zen"]})

        browser.close()

    fails = [r for r in RESULTS if not r[1]]
    print(f"== {len(RESULTS) - len(fails)}/{len(RESULTS)} PASS ==")
    # browser.close() 在某些环境下会卡住（chrome-headless-shell 收尾挂起），
    # 结果已打印完毕，直接硬退。
    import os
    sys.stdout.flush()
    os._exit(1 if fails else 0)


if __name__ == "__main__":
    main()
