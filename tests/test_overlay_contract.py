# -*- coding: utf-8 -*-
"""P3 浮层契约行为回归（web/src/ui/overlay.js + 021-aria-dialog.js）

考的是**行为**；源码长相由 tests/js/test_overlay_contract.js 钉住。
下面每一条断言都对应一个已经发生过的真实缺陷：

1. **层级**：旧对话框把 z-index 写死 2400，被 .settings-overlay(10000) 盖住 ——
   从设置面板里弹的提示用户看不见（"点了没反应"）。这里在设置面板开着的情况下
   用 elementFromPoint 验证对话框真的在最上层。
2. **dialog 语义**：全仓 role="dialog" 覆盖率此前只有 4/36。
3. **焦点陷阱与焦点归还**：此前 0 处（Esc 关掉后焦点留在 body，键盘用户丢失位置）。
4. **ESC 只关最顶层**：此前 24 个分片各自绑 keydown，嵌套浮层会被一次 ESC 全关。
5. **prompt 的 await 形态**：258 同名覆盖后返回 DOM 元素，200-settings-panel 的
   `await window.showGlassPrompt(...)` 拿到 HTMLDivElement，AutoEQ 导入静默失效。
6. **静态浮层收编**（P3-b，第 0 节）：index.html 里 26 个静态浮层的
   role / aria-modal / aria-labelledby 由 ui/static-overlays.js 统一注入
   （此前 26 个里只有 1 个手写过）；首跑层层级夹在 panel 与 modal 之间
   （原写死 99999，会盖住任何对话框）；桌面壳隐藏欢迎页；
   一次 ESC 只关一层（曾因 120/125 各自绑 ESC 与 150 的逐层链叠加而连关两层）。

运行前提：python server.py 已在 :8001 启动。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
results = []


def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)


SETUP = """
try {
    localStorage.setItem('aria_oobe_done', '1');
    localStorage.setItem('aria_ai_proxy_notice', '1');
} catch (e) {}
"""


def strip_first_run_layers(page):
    """清掉首跑引导 / 欢迎 / 性能档弹窗。

    实测（2026-10-05）有两层，且**都**带 .welcome-overlay 类、z-index 都是 99999
    高于本用例要验的对话框（12000）：
      · #welcomeOverlay   —— index.html 里的启动公告；
      · #performanceDialog —— 180-boot-config.js 在硬件探测后动态创建的「性能档」询问。
    后者是异步追加的，所以必须**轮询到指针真的能到达下方**为止，而不是删一次就完。
    真实用户点完就没了，它们不是本用例的被测对象。"""
    last = None
    for _ in range(30):
        last = page.evaluate("""() => {
            document.querySelectorAll('.welcome-overlay, #ariaOobeOverlay').forEach((el) => el.remove());
            const x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2);
            const el = document.elementFromPoint(x, y);
            const over = el && el.closest
                ? el.closest('.welcome-overlay, #ariaOobeOverlay')
                : null;
            return { blocked: !!over, cls: el ? String(el.className) : null };
        }""")
        if not last["blocked"]:
            return last
        page.wait_for_timeout(200)
    return last

# 打开对话框一律「点火即忘」：Promise 落到 window.__x 上，避免 page.evaluate
# 阻塞在对话框的 Promise 上（它要等用户操作才结算）。


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(SETUP)
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)

    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent');"
            " return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:120])
    page.wait_for_timeout(1200)

    # 首跑向导 / 欢迎层会拦截指针，且它们的 z-index 高于任何对话框 —— 本用例只考
    # 浮层契约本身，先把这两层摘掉（真实用户点完就没了，不是被测对象）。
    # 只清首跑向导层（它在按键测试里会抢事件）。
    # ★ 不要在这里动 #welcomeOverlay：section 0 要断言"桌面壳隐藏欢迎页"，
    #   需要它还在 DOM 里；它由 section 0 末尾的 strip_first_run_layers 统一清掉。
    #   （第一版就是把两个都清了，导致 26 个收编面板只剩 25 个可见、欢迎层断言全崩。）
    page.evaluate("""() => {
        const o = document.getElementById('ariaOobeOverlay');
        if (o) o.remove();
    }""")

    check("four-entrypoints-exist", page.evaluate(
        "() => ['showGlassAlert','showGlassConfirm','showGlassPrompt','showGlassPick']"
        ".every((k) => typeof window[k] === 'function')"))

    # ══ 0. 静态浮层收编（P3-b）——必须赶在 strip 之前跑，
    #      因为 #welcomeOverlay 就是被 strip 移除的，下面 S6 要用到它 ══
    rep = page.evaluate("() => (window.Aria && window.Aria.get('staticOverlays')) || null")
    check("static-overlay-report-present", bool(rep), rep)
    if rep:
        check("static-overlay-registry-all-found",
              len(rep["missing"]) == 0 and len(rep["adopted"]) >= 26, rep)
        check("static-overlay-labelledby-coverage", rep["labelled"] >= 22, rep)

    panels = page.evaluate("""() => {
        const all = Array.from(document.querySelectorAll('.aria-static-modal'));
        return {
            n: all.length,
            ok: all.filter((el) => el.getAttribute('role') === 'dialog'
                && el.getAttribute('aria-modal') === 'true').length,
            unlabelled: all.filter((el) => !el.hasAttribute('aria-labelledby'))
                .map((el) => el.closest('[id]') ? el.closest('[id]').id : el.className).slice(0, 6),
        };
    }""")
    check("every-adopted-panel-has-dialog-semantics",
          panels["n"] >= 26 and panels["ok"] == panels["n"], panels)

    # 首跑层必须夹在 panel 与 modal 之间（用临时探针元素读计算值，不依赖真实节点还在）
    zzz = page.evaluate("""() => {
        const cs = getComputedStyle(document.documentElement);
        const token = (n) => Number(cs.getPropertyValue(n).trim()) || 0;
        const probe = document.createElement('div');
        probe.className = 'welcome-overlay';
        document.body.appendChild(probe);
        const real = Number(getComputedStyle(probe).zIndex) || 0;
        probe.remove();
        return { welcome: token('--aria-z-welcome'), modal: token('--aria-z-modal'), real: real };
    }""")
    # .aria-dialog-overlay 的层级是 **行内** 注入的（openOverlay 时按令牌算），
    # 所以这里不能拿一个新建的空壳去读计算值（读到 0）；改为：真实元素的
    # 计算值必须等于令牌，且令牌夹在面板档与 modal 档之间。
    check("welcome-layer-sits-between-panel-and-modal",
          zzz["real"] == zzz["welcome"] and 10001 < zzz["welcome"] < zzz["modal"], zzz)

    # 桌面壳隐藏欢迎页（浏览器里手动打上 aria-desktop 模拟桌面环境）
    desk = page.evaluate("""() => {
        const root = document.documentElement;
        const el = document.getElementById('welcomeOverlay');
        root.classList.add('aria-desktop');
        const hiddenInDesktop = el ? getComputedStyle(el).display === 'none' : null;
        const perf = document.createElement('div');
        perf.className = 'welcome-overlay';
        perf.id = 'perfProbe';
        document.body.appendChild(perf);
        const perfShown = getComputedStyle(perf).display !== 'none';
        perf.remove();
        root.classList.remove('aria-desktop');
        const backVisible = el ? getComputedStyle(el).display !== 'none' : null;
        return { hiddenInDesktop, perfShown, backVisible };
    }""")
    check("desktop-hides-the-welcome-overlay", desk["hiddenInDesktop"] is True, desk)
    check("desktop-keeps-the-performance-dialog", desk["perfShown"] is True, desk)
    check("browser-still-shows-the-welcome-overlay", desk["backVisible"] is True, desk)

    # 一次 ESC 只关一层（回归：120/125 各自绑过 ESC，与 150 的逐层链叠加会连关两层）
    esc = page.evaluate("""() => {
        const open = (id) => document.getElementById(id).classList.add('visible');
        const vis = (id) => document.getElementById(id).classList.contains('visible');
        open('searchOverlay');
        open('favoritesOverlay');
        return { before: [vis('searchOverlay'), vis('favoritesOverlay')] };
    }""")
    page.wait_for_timeout(150)
    page.keyboard.press('Escape')
    page.wait_for_timeout(250)
    after1 = page.evaluate("""() => ({
        search: document.getElementById('searchOverlay').classList.contains('visible'),
        fav: document.getElementById('favoritesOverlay').classList.contains('visible'),
    })""")
    check("esc-closes-only-the-top-static-layer",
          after1["search"] is True and after1["fav"] is False,
          {"before": esc["before"], "after": after1})
    page.keyboard.press('Escape')
    page.wait_for_timeout(250)
    after2 = page.evaluate("() => document.getElementById('searchOverlay').classList.contains('visible')")
    check("second-esc-closes-the-next-layer", after2 is False, after2)

    strip_first_run_layers(page)

    # ══ 1. 层级：设置面板开着时，对话框必须在它之上 ══
    page.evaluate("() => document.getElementById('openSettingsBtn').click()")
    page.wait_for_timeout(600)
    page.evaluate("""() => {
        window.__dlg = { done: false, value: undefined };
        window.showGlassAlert({ title: '层级', desc: 'x' })
            .then((v) => { window.__dlg.value = v; window.__dlg.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-overlay', timeout=4000)
    page.wait_for_timeout(250)
    # ★ 清理必须紧贴断言：#performanceDialog 是硬件探测完成后**异步**追加的，
    #   在用例开头清一次时它还不存在（实测漏掉 → center 被 .welcome-desc 盖住）。
    strip_first_run_layers(page)

    zz = page.evaluate("""() => {
        const ov = document.querySelector('.aria-dialog-overlay');
        const st = document.getElementById('settingsOverlay');
        const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
        const chain = [];
        for (let e = top, i = 0; e && i < 6; i++, e = e.parentElement) {
            chain.push(e.tagName + (e.id ? '#' + e.id : '') +
                (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : ''));
        }
        return {
            dialogZ: Number(getComputedStyle(ov).zIndex) || 0,
            settingsZ: st ? (Number(getComputedStyle(st).zIndex) || 0) : 0,
            topIsDialog: !!(top && top.closest && top.closest('.aria-dialog')),
            chain: chain,
            topZ: top ? (getComputedStyle(top).zIndex || 'auto') : null,
        };
    }""")
    check("dialog-z-above-settings-panel", zz["dialogZ"] > zz["settingsZ"] > 0, zz)
    check("dialog-actually-on-top-of-settings", zz["topIsDialog"], zz)

    a11y = page.evaluate("""() => {
        const ov = document.querySelector('.aria-dialog-overlay');
        const sh = document.querySelector('.aria-dialog');
        const lb = sh.getAttribute('aria-labelledby');
        const t = lb ? document.getElementById(lb) : null;
        return {
            backdropClass: ov.classList.contains('aria-modal-backdrop'),
            shellClass: sh.classList.contains('aria-modal-shell'),
            role: sh.getAttribute('role'),
            modal: sh.getAttribute('aria-modal'),
            label: t ? t.textContent : null,
        };
    }""")
    check("container-has-backdrop-class", a11y["backdropClass"], a11y)
    check("shell-has-modal-class", a11y["shellClass"], a11y)
    check("shell-has-dialog-semantics", a11y["role"] == "dialog" and a11y["modal"] == "true", a11y)
    check("shell-labelled-by-its-title", a11y["label"] == "层级", a11y)

    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    closed = page.evaluate("""() => ({
        n: document.querySelectorAll('.aria-dialog-overlay').length,
        done: window.__dlg.done, value: window.__dlg.value,
    })""")
    check("esc-removes-dialog-from-dom", closed["n"] == 0, closed)
    check("esc-settles-promise", closed["done"] and closed["value"] is True, closed)

    # ══ 2. ESC 只关最顶层 ══
    page.evaluate("""() => {
        window.__outer = { done: false, value: undefined };
        window.__inner = { done: false, value: undefined };
        window.showGlassConfirm({ title: '外层' })
            .then((v) => { window.__outer.value = v; window.__outer.done = true; });
        window.showGlassConfirm({ title: '内层' })
            .then((v) => { window.__inner.value = v; window.__inner.done = true; });
    }""")
    page.wait_for_function(
        "() => document.querySelectorAll('.aria-dialog').length === 2", timeout=4000)
    page.wait_for_timeout(200)
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    nest1 = page.evaluate("""() => ({
        open: document.querySelectorAll('.aria-dialog').length,
        innerDone: window.__inner.done, innerVal: window.__inner.value,
        outerDone: window.__outer.done,
    })""")
    check("esc-closes-only-topmost",
          nest1["open"] == 1 and nest1["innerDone"] and nest1["innerVal"] is False
          and not nest1["outerDone"], nest1)

    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    nest2 = page.evaluate("""() => ({
        open: document.querySelectorAll('.aria-dialog').length,
        outerDone: window.__outer.done, outerVal: window.__outer.value,
    })""")
    check("second-esc-closes-the-outer-one",
          nest2["open"] == 0 and nest2["outerDone"] and nest2["outerVal"] is False, nest2)

    # ══ 3. 点遮罩关闭（真实鼠标；先确认指针真的能到达遮罩）══
    strip_first_run_layers(page)
    page.evaluate("""() => {
        window.__bd = { done: false, value: undefined };
        window.showGlassConfirm({ title: '遮罩' })
            .then((v) => { window.__bd.value = v; window.__bd.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-overlay', timeout=4000)
    page.wait_for_timeout(250)
    hit = page.evaluate("() => { const t = document.elementFromPoint(8, 8);"
                        " return t ? String(t.className) : null; }")
    check("corner-point-hits-the-dialog-backdrop",
          bool(hit) and 'aria-dialog-overlay' in hit, hit)
    page.mouse.click(8, 8)
    page.wait_for_timeout(350)
    bd = page.evaluate("""() => ({
        n: document.querySelectorAll('.aria-dialog-overlay').length,
        done: window.__bd.done, value: window.__bd.value,
    })""")
    check("backdrop-click-cancels", bd["done"] and bd["value"] is False and bd["n"] == 0, bd)

    # ══ 4. 焦点移入 + Tab 陷阱 + 关闭后归还 ══
    strip_first_run_layers(page)
    page.evaluate("() => { const b = document.getElementById('openSettingsBtn'); if (b) b.focus(); }")
    page.wait_for_timeout(100)
    page.evaluate("""() => {
        window.__fc = { done: false, value: undefined };
        window.showGlassConfirm({ title: '焦点' })
            .then((v) => { window.__fc.value = v; window.__fc.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-overlay', timeout=4000)
    page.wait_for_timeout(350)
    f1 = page.evaluate("""() => {
        const sh = document.querySelector('.aria-dialog');
        const a = document.activeElement;
        return { inside: !!(sh && a && sh.contains(a)), cls: a ? String(a.className) : null };
    }""")
    check("focus-moves-into-dialog", f1["inside"], f1)

    trapped = True
    for _ in range(10):
        page.keyboard.press('Tab')
        inside = page.evaluate("""() => {
            const sh = document.querySelector('.aria-dialog');
            const a = document.activeElement;
            return !!(sh && a && sh.contains(a));
        }""")
        if not inside:
            trapped = False
            break
    check("tab-is-trapped-inside-shell", trapped)

    page.keyboard.press('Escape')
    page.wait_for_timeout(350)
    f2 = page.evaluate("() => { const a = document.activeElement;"
                       " return { id: a ? a.id : null, done: window.__fc.done, value: window.__fc.value }; }")
    check("focus-restored-to-opener-after-close", f2["id"] == "openSettingsBtn", f2)

    # ══ 5. prompt：await 拿到字符串 + onSubmit 同步回调（AutoEQ 的失效点）══
    page.evaluate("""() => {
        window.__pr = { done: false, value: undefined, submitted: 'NOT_CALLED' };
        window.showGlassPrompt({
            title: '输入', placeholder: 'p', value: '',
            onSubmit: (v) => { window.__pr.submitted = v; },
        }).then((v) => { window.__pr.value = v; window.__pr.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-input', timeout=4000)
    page.wait_for_timeout(300)
    focused = page.evaluate("() => document.activeElement === document.querySelector('.aria-dialog-input')")
    check("prompt-input-autofocused", focused)

    typed = 'Filter 1: ON PK Fc 105 Hz Gain 6.1 dB Q 0.70'
    page.keyboard.type(typed)
    page.keyboard.press('Enter')
    page.wait_for_timeout(350)
    pr = page.evaluate("""() => ({
        done: window.__pr.done, value: window.__pr.value, submitted: window.__pr.submitted,
        n: document.querySelectorAll('.aria-dialog-overlay').length,
    })""")
    check("prompt-await-returns-the-string",
          pr["done"] and pr["value"] == typed, pr)
    check("prompt-onSubmit-gets-same-value", pr["submitted"] == typed, pr)
    check("prompt-closed-after-enter", pr["n"] == 0, pr)

    page.evaluate("""() => {
        window.__pc = { done: false, value: 'UNSET', submitted: 'NOT_CALLED' };
        window.showGlassPrompt({ title: '取消', onSubmit: (v) => { window.__pc.submitted = v; } })
            .then((v) => { window.__pc.value = v; window.__pc.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-input', timeout=4000)
    page.wait_for_timeout(250)
    page.keyboard.press('Escape')
    page.wait_for_timeout(350)
    pc = page.evaluate("() => ({ done: window.__pc.done, value: window.__pc.value,"
                       " submitted: window.__pc.submitted })")
    check("prompt-cancel-resolves-null", pc["done"] and pc["value"] is None, pc)
    check("prompt-cancel-does-NOT-call-onSubmit", pc["submitted"] == 'NOT_CALLED', pc)

    # ══ 6. pick：返回下标；onPick 只在真选中时回调 ══
    page.evaluate("""() => {
        window.__pk = { done: false, value: undefined, picked: 'NOT_CALLED' };
        window.showGlassPick({
            title: '选择', items: [{ name: '甲' }, { name: '乙', meta: '2 首' }],
            onPick: (i) => { window.__pk.picked = i; },
        }).then((v) => { window.__pk.value = v; window.__pk.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-pick-item', timeout=4000)
    page.wait_for_timeout(250)
    page.evaluate("() => document.querySelectorAll('.aria-dialog-pick-item')[1].click()")
    page.wait_for_timeout(350)
    pk = page.evaluate("""() => ({
        done: window.__pk.done, value: window.__pk.value, picked: window.__pk.picked,
        n: document.querySelectorAll('.aria-dialog-overlay').length,
    })""")
    check("pick-returns-index-and-closes",
          pk["done"] and pk["value"] == 1 and pk["picked"] == 1 and pk["n"] == 0, pk)

    page.evaluate("""() => {
        window.__pk2 = { done: false, value: 'UNSET', picked: 'NOT_CALLED' };
        window.showGlassPick({
            title: '选择2', items: [{ name: '甲' }],
            onPick: (i) => { window.__pk2.picked = i; },
        }).then((v) => { window.__pk2.value = v; window.__pk2.done = true; });
    }""")
    page.wait_for_selector('.aria-dialog-pick-item', timeout=4000)
    page.wait_for_timeout(250)
    page.keyboard.press('Escape')
    page.wait_for_timeout(350)
    pk2 = page.evaluate("() => ({ done: window.__pk2.done, value: window.__pk2.value,"
                        " picked: window.__pk2.picked })")
    check("pick-cancel-resolves-null-without-onPick",
          pk2["done"] and pk2["value"] is None and pk2["picked"] == 'NOT_CALLED', pk2)

    # ══ 7. 收尾：不该有 JS 异常（网络噪声不算）══
    noisy = ('y.gtimg', 'ERR_FAILED', 'ERR_CONNECTION', 'Failed to load resource')
    relevant = [e for e in errors if not any(n in e for n in noisy)]
    check("no-unexpected-page-errors", len(relevant) == 0, relevant[:2])

    browser.close()

failed = [n for n, ok, _ in results if not ok]
print("\n" + "=" * 46)
print(f"TOTAL: {len(results)}  PASS: {len(results) - len(failed)}  FAIL: {len(failed)}")
if failed:
    for n in failed:
        print("  FAILED", n)
    sys.exit(1)
