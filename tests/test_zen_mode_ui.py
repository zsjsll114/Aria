"""专注模式（todos #7）的浏览器接线回归。

用户定的语义（2026-09-27 重做）：
  · 设置里的开关只管「这个功能开不开」——点亮后**不**立刻清空界面（样式必须当场变）；
  · 进入条件 = 在 N 秒内没有「点击/按键」活动；**鼠标移动不算活动**，不重置倒计时；
  · 在专注态里移动鼠标 → 暂时唤回控件（开关保持开），之后连移动都算活动，
    安静满 N 秒再自动进去；
  · 顶栏那颗按钮是「立刻切换」，并且要能被 292 的自定义按钮栏收纳。

★ 全程用 evaluate 派发事件，不用真鼠标：本文件要精确区分「移动」与「点击」两类活动。
★ 静止时长设成 1 秒，否则每条断言都要等 4 秒。
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []

TARGETS = {
    "top": ".player-container .top-action-buttons",
    "info": ".player-container .player-controls-wrapper",
    "lyrics": "#lyricsScroll",
}


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


def visibility(page):
    """等淡出过渡走完再量（opacity 是过渡属性，同步读会读到起点值）。"""
    page.wait_for_timeout(900)
    return page.evaluate("""(targets) => {
        const out = {};
        for (const [k, sel] of Object.entries(targets)) {
            const el = document.querySelector(sel);
            if (!el) { out[k] = 'MISSING'; continue; }
            const cs = getComputedStyle(el);
            out[k] = cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05 ? 'hidden' : 'shown';
        }
        out.zen = document.documentElement.classList.contains('is-zen');
        out.enabled = !!(appSettings.interface.zen || {}).enabled;
        out.btnOn = !!(document.getElementById('zenModeBtn') || {}).classList
            && document.getElementById('zenModeBtn').classList.contains('on');
        return out;
    }""", TARGETS)


def peek(page):
    """立刻量：断言「还没进入」时必须用它——visibility() 自带 900ms 沉降，
       用错就会把「等太久所以真进去了」读成「开关立刻进入」。"""
    return page.evaluate("""() => ({
        zen: document.documentElement.classList.contains('is-zen'),
        enabled: !!(appSettings.interface.zen || {}).enabled,
        top: getComputedStyle(document.querySelector('.player-container .top-action-buttons')).visibility,
    })""")


def fire(page, kind, count=1):
    """kind: 'move' | 'click' | 'key' —— 派发真实事件类型，不碰真鼠标。"""
    page.evaluate("""(args) => {
        for (let i = 0; i < args.n; i++) {
            if (args.kind === 'move') {
                document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400 + i, clientY: 300 }));
            } else if (args.kind === 'click') {
                document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            } else {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }));
            }
        }
    }""", {"kind": kind, "n": count})


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(20000)
        errors = []
        initial_zen = None
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            page.goto(URL, wait_until="load")
            page.wait_for_timeout(4500)
            page.evaluate("""() => {
                document.getElementById('ariaOobeOverlay')?.remove();
                document.getElementById('welcomeOverlay')?.classList.add('hidden');
                document.querySelectorAll('.search-overlay, .settings-overlay').forEach(e => e.classList.remove('visible'));
            }""")
            page.wait_for_timeout(400)
            snap = page.evaluate("() => JSON.parse(JSON.stringify(appSettings.interface.zen || {}))")
            initial_zen = snap

            mounted = page.evaluate("""() => ({
                toggle: !!document.getElementById('zenEnabledToggle'),
                btn: !!document.getElementById('zenModeBtn'),
                inTopBar: !!document.querySelector('.top-action-buttons #zenModeBtn'),
                ariaPressed: (document.getElementById('zenModeBtn') || {}).getAttribute?.('aria-pressed'),
                hasIcon: !!document.querySelector('#zenModeBtn svg'),
                cssLoaded: [...document.styleSheets].some(s => (s.href || '').includes('zen.css')),
            })""")
            check("toggle-and-button-mounted", all([mounted["toggle"], mounted["btn"],
                                                   mounted["inTopBar"], mounted["hasIcon"], mounted["cssLoaded"]]), mounted)
            check("button-exposes-pressed-state", mounted["ariaPressed"] in ("true", "false"), mounted)

            # 292 的可自定义按钮栏必须认识这颗按钮（能被隐藏/排序、隐藏后进「更多」）
            reg = page.evaluate("""async () => {
                const m = await import('/src/core/toolbarLayout.js');
                const hit = (m.TOOLBAR_CONTROLS || []).find(c => c.id === 'zenModeBtn');
                const A = window.Aria || {};
                const listed = typeof A.__toolbar?.controls === 'function'
                    ? A.__toolbar.controls().some(c => c.id === 'zenModeBtn') : null;
                return { registered: !!hit, removable: hit ? hit.removable : null, listed };
            }""")
            check("button-registered-in-toolbar-layout", reg["registered"] and reg["removable"] is True, reg)
            check("button-listed-by-toolbar-runtime", reg["listed"] is True, reg)

            # —— 1. 点亮开关：样式当场变，但界面**不**立刻清空 ——
            page.evaluate("""() => {
                appSettings.interface.zen = Object.assign({}, appSettings.interface.zen,
                    { enabled: false, idleSeconds: 3, scopes: { top: true, bottom: true, info: true } });
                document.getElementById('zenEnabledToggle').classList.remove('on');
                if (document.documentElement.classList.contains('is-zen')) {
                    document.getElementById('zenEnabledToggle').click();
                }
            }""")
            page.wait_for_timeout(300)
            before = visibility(page)
            check("starts-off", before["enabled"] is False and before["zen"] is False, before)
            page.evaluate("() => document.getElementById('zenEnabledToggle').click()")
            page.wait_for_timeout(400)
            just_on = peek(page)
            check("switch-style-flips-immediately", just_on["enabled"] is True, just_on)
            check("switch-does-not-enter-zen-immediately",
                  just_on["zen"] is False and just_on["top"] in ("shown", "visible"), just_on)

            # —— 2. 静止满 N 秒自动进入（鼠标移动**不**打断）——
            fire(page, "move", 6)          # 移动不该打断「没有点击就进入」
            page.wait_for_timeout(3400)
            moved = visibility(page)
            check("mousemove-does-not-block-entering", moved["zen"] is True, moved)
            check("scopes-hidden", moved["top"] == "hidden" and moved["info"] == "hidden", moved)
            check("lyrics-untouched", moved["lyrics"] == "shown", moved)
            check("button-reflects-state", moved["btnOn"] is True, moved)

            # —— 3. 移动鼠标 → 暂时唤回，开关保持开 ——
            fire(page, "move", 1)
            back = visibility(page)
            check("mousemove-brings-controls-back",
                  back["zen"] is False and back["top"] == "shown", back)
            check("mousemove-keeps-switch-on", back["enabled"] is True, back)

            # —— 4. 唤回之后连移动也算活动：一直动就不该再进去 ——
            for _ in range(3):
                fire(page, "move", 2)
                page.wait_for_timeout(1200)     # 每次都没超过 3 秒静止
            still_moving = peek(page)
            check("continuous-movement-does-not-re-enter", still_moving["zen"] is False, still_moving)
            page.wait_for_timeout(3400)
            reentered = visibility(page)
            check("quiet-again-re-enters", reentered["zen"] is True, reentered)

            # —— 5. 点击/按键立刻退出并重置倒计时 ——
            fire(page, "click", 1)
            after_click = visibility(page)
            check("click-exits-zen", after_click["zen"] is False, after_click)

            # —— 6. 顶栏按钮 = 立刻切换 ——
            page.evaluate("() => document.getElementById('zenModeBtn').click()")
            via_btn = visibility(page)
            check("button-enters-immediately",
                  via_btn["zen"] is True and via_btn["top"] == "hidden", via_btn)
            page.evaluate("() => document.getElementById('zenModeBtn').click()")
            check("button-exits", visibility(page)["zen"] is False, "")

            # —— 7. 关掉开关：正在专注必须退出，且不再自动进入 ——
            page.evaluate("() => document.getElementById('zenModeBtn').click()")
            page.wait_for_timeout(300)
            page.evaluate("() => document.getElementById('zenEnabledToggle').click()")
            page.wait_for_timeout(1800)
            off = visibility(page)
            check("disable-exits-and-stops-arming",
                  off["enabled"] is False and off["zen"] is False and off["top"] == "shown", off)

            check("no-page-errors", not errors, errors[:3])
        finally:
            try:
                page.evaluate("""async (zen) => {
                    const m = await import('/src/app/180-boot-config.js');
                    appSettings.interface.zen = zen;
                    m.saveSettings();
                    await m.syncConfigToBackend();
                }""", initial_zen if initial_zen is not None else {})
                page.wait_for_timeout(400)
            except Exception as e:
                print("  WARN 恢复默认失败:", e)

        failed = [r for r in RESULTS if not r[1]]
        print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
        for name, _, detail in failed:
            print("  FAIL", name, detail)
        sys.stdout.flush()
        # 收尾不关浏览器：驱动连接在本应用（手机遥控器长轮询）下会挂住 close，
        # 结果已经算完，直接带退出码离开，否则 CI 会白挂到超时并误判失败。
        os._exit(1 if failed else 0)


if __name__ == "__main__":
    sys.exit(main())
