# -*- coding: utf-8 -*-
"""外观 mod 文件导入的端到端回归（290 + core/vfxRecipe.js + 021 确认框）

单元测试（tests/js/test_theme_mod.js）只证明解析与校验是对的；
这条链路剩下的部分必须真的在浏览器里走一遍：

  · 面板里的 <input type=file> 的 change 监听有没有接上 ——
    最容易漏的一环（type=file 在部分浏览器不发 input 事件，接错事件就"选了没反应"）；
  · 仓库随附的 mods/google-minimal.aria-theme.json 能不能真的导入成功；
  · 导入后 appSettings **真的变了**（而不是只弹了个提示）；
  · 主题色走的是受管写入口（190 applyThemeColor → --aria-accent），
    不是裸写令牌（裸写会被下一次 applyInterfaceSettings 冲掉）；
  · 配方真的落库（用户下次还找得到）；
  · 不合法的 mod 文件必须被**整份拒绝且不改动任何设置**。

运行前提：python server.py 已在 :8001 启动。
"""
import json
import os
import shutil
import sys
import tempfile

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOOD_MOD = os.path.join(REPO, 'mods', 'google-minimal.aria-theme.json')
results = []


def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL") + name + ("  " + str(extra)[:200] if extra else ""))


SETUP = """
try {
    localStorage.setItem('aria_oobe_done', '1');
    localStorage.setItem('aria_ai_proxy_notice', '1');
} catch (e) {}
"""

READ_STATE = """() => {
    const items = (appSettings.interface.vfxRecipes && appSettings.interface.vfxRecipes.items) || [];
    return {
        theme: appSettings.interface.themeColor,
        glass: appSettings.interface.glassStrength,
        compact: appSettings.interface.compactMode,
        vfx: appSettings.interface.vfxIntensity,
        presetCount: items.length,
        names: items.map((i) => i.name),
        cssAccent: getComputedStyle(document.documentElement).getPropertyValue('--aria-accent').trim(),
        containerClass: (document.querySelector('.player-container') || {}).className || '',
    };
}"""


def strip_first_run(page):
    """清首跑层：它们 z-index 高于对话框、且会拦截指针（详见 test_overlay_contract.py）"""
    page.evaluate("() => { document.querySelectorAll('.welcome-overlay, #ariaOobeOverlay').forEach((el) => el.remove()); }")


def main():
    tmpdir = tempfile.mkdtemp(prefix='aria-mod-test-')
    try:
        bad_mod = os.path.join(tmpdir, 'bad.aria-theme.json')
        with open(bad_mod, 'w', encoding='utf-8') as f:
            # 越界值：fontSize 上限是 3
            f.write(json.dumps({"ariaTheme": 1, "recipe": {"sv": 1, "lyrics": {"fontSize": 999}}}))

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            saved = []

            def block_save(route):
                saved.append(route.request.url)
                route.fulfill(status=200, content_type="application/json", body='{"ok":true}')

            page.route("**/api/config/save", block_save)
            page.add_init_script(SETUP)
            page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_function(
                    "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent');"
                    " return !!v && v.trim() !== ''; }",
                    timeout=25000)
            except Exception as e:
                check("app-boot-marker", False, str(e)[:120])
            page.wait_for_timeout(1500)
            strip_first_run(page)

            check("config-save-intercepted", len(saved) > 0, f"{len(saved)} 次写入已拦截")
            before = page.evaluate(READ_STATE)

            # —— 打开「视觉配方」面板 ——
            page.evaluate("() => document.getElementById('openSettingsBtn').click()")
            page.wait_for_timeout(900)
            strip_first_run(page)
            check("settings-group-mounted", page.evaluate("() => !!document.getElementById('vrOpenFromSettings')"))
            page.evaluate("() => { const b = document.getElementById('vrOpenFromSettings'); if (b) b.click(); }")
            # 文件输入是 hidden 的（点按钮代它 popup），必须等 attached 而不是 visible
            page.wait_for_selector('#vrModFile', state='attached', timeout=6000)
            check("mod-file-input-rendered", page.evaluate("() => !!document.getElementById('vrModFile')"))
            check("mod-block-buttons-rendered", page.evaluate(
                "() => !!document.querySelector('[data-act=\"pick-mod\"]')"
                " && !!document.querySelector('[data-act=\"export-mod\"]')"))

            # —— 导入随附的 Google 极简 mod ——
            page.set_input_files('#vrModFile', GOOD_MOD)
            page.wait_for_selector('.aria-dialog-overlay', timeout=6000)
            page.wait_for_timeout(300)
            dlg_title = page.evaluate(
                "() => { const t = document.querySelector('.aria-dialog-title'); return t ? t.textContent.trim() : null; }")
            check("import-asks-for-confirmation",
                  bool(dlg_title) and 'mod' in dlg_title.lower(), dlg_title)

            page.evaluate("() => { const b = document.querySelector('.aria-dialog-actions .aria-dialog-btn.primary'); if (b) b.click(); }")
            page.wait_for_timeout(800)
            after = page.evaluate(READ_STATE)

            check("mod-applied-theme-color", str(after["theme"]).upper() == '#8AB4F8', after)
            check("mod-accent-reaches-css-token",
                  str(after["cssAccent"]).upper() == '#8AB4F8',
                  {'cssAccent': after["cssAccent"]})
            check("mod-applied-interface-knobs",
                  after["glass"] == 0 and after["compact"] is True and after["vfx"] == 15, after)
            check("mod-saved-as-preset",
                  after["presetCount"] == before["presetCount"] + 1
                  and any('Google' in n for n in after["names"]), after)
            check("mod-switched-the-view-mode", 'view-lyrics' in (after["containerClass"] or ''), after)
            check("dialog-closed-after-confirm",
                  page.evaluate("() => document.querySelectorAll('.aria-dialog-overlay').length") == 0)

            # —— 不合法的 mod：整份拒绝且零副作用 ——
            page.set_input_files('#vrModFile', bad_mod)
            page.wait_for_timeout(700)
            rejected = page.evaluate("""() => {
                const box = document.querySelector('.vr-result-bad');
                const items = (appSettings.interface.vfxRecipes && appSettings.interface.vfxRecipes.items) || [];
                return {
                    theme: appSettings.interface.themeColor,
                    presetCount: items.length,
                    reasons: box ? box.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
                };
            }""")
            check("invalid-mod-is-rejected-with-reasons",
                  rejected["reasons"] is not None and 'fontSize' in (rejected["reasons"] or ''), rejected)
            check("invalid-mod-has-no-side-effects",
                  str(rejected["theme"]).upper() == '#8AB4F8'
                  and rejected["presetCount"] == after["presetCount"], rejected)

            noisy = ('y.gtimg', 'ERR_FAILED', 'ERR_CONNECTION', 'Failed to load resource')
            relevant = [e for e in errors if not any(n in e for n in noisy)]
            check("no-unexpected-page-errors", len(relevant) == 0, relevant[:2])

            browser.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    failed = [n for n, ok, _ in results if not ok]
    print("\n" + "=" * 46)
    print(f"TOTAL: {len(results)}  PASS: {len(results) - len(failed)}  FAIL: {len(failed)}")
    if failed:
        for n in failed:
            print("  FAILED", n)
        sys.exit(1)


main()
