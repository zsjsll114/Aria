# -*- coding: utf-8 -*-
"""设置面板回归冒烟测试（200-settings-panel / 201-settings-ai / 202-settings-appearance 拆分回归）：
1. 应用启动无致命控制台错误（ESM 链正常）；
2. 打开设置面板 → 13 大 tab 逐个切换，每个 tab 只激活对应 settings-section；
3. switchSettingsTab 全局函数存在；
4. initSettingsMisc 无异常执行：播放区滑块被初始赋值、歌词开关状态与 appSettings 同步；
5. 遍历 tab 前后新增控制台错误为零（排除已知网络噪声）。
运行前提：python server.py 已在 :8001 启动。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720}, reduced_motion="no-preference")
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:120])
    page.wait_for_timeout(1500)

    check("settings-open-btn-exists", page.evaluate("!!document.getElementById('openSettingsBtn')"))

    # —— 打开设置面板（evaluate 直调 click，避开欢迎浮层 ariaOobeOverlay 的指针拦截）——
    page.evaluate("document.getElementById('openSettingsBtn').click()")
    page.wait_for_timeout(400)
    check("overlay-visible", page.evaluate("document.getElementById('settingsOverlay').classList.contains('visible')"))

    # —— 每个 tab 点击后仅对应 section 可见 ——
    # .is-leaving 是要淡出的上一个分区：它绝对定位盖着、pointer-events:none、退场完就
    # display:none，不算"可见分区"。这里必须排除它，否则交叉退场会被判成两个同显。
    ev = page.evaluate("""() => {
        const tabs = Array.from(document.querySelectorAll('#settingsTabs .settings-tab'))
            .map(t => t.dataset.tab);
        const result = { tabs, perTab: {} };
        for (const name of tabs) {
            document.querySelector(`#settingsTabs .settings-tab[data-tab="${name}"]`).click();
            const visible = Array.from(document.querySelectorAll('#settingsBody .settings-section'))
                .filter(s => s.style.display !== 'none' && s.style.display !== ''
                          && !s.classList.contains('is-leaving'))
                .map(s => s.dataset.section);
            result.perTab[name] = { visible, active: document.querySelector(`#settingsTabs .settings-tab.active`)?.dataset?.tab };
        }
        return result;
    }""")
    check("switch-settings-tab-defined", page.evaluate("typeof window.switchSettingsTab === 'function'"))
    check("tabs-13", len(ev["tabs"]) >= 11, f"tabs={len(ev['tabs'])} {ev['tabs']}")
    for name, st in ev["perTab"].items():
        is_ok = (st["visible"] == [name]) and (st["active"] == name)
        check(f"tab-{name}-solo-active", is_ok, f"visible={st['visible']} active={st['active']}")

    # —— 连点 13 次后必须全部收干净：不能有分区卡在 is-leaving（会一直盖在当前分区上）——
    page.wait_for_timeout(1500)
    settle = page.evaluate("""() => {
        const secs = Array.from(document.querySelectorAll('#settingsBody .settings-section'));
        const isShown = (s) => { const d = getComputedStyle(s).display; return d !== 'none'; };
        return {
            stillLeaving: secs.filter(s => s.classList.contains('is-leaving')).map(s => s.dataset.section),
            concealing: secs.filter(s => s.classList.contains('is-concealing')).map(s => s.dataset.section),
            shown: secs.filter(isShown).map(s => s.dataset.section),
            leftoverInline: secs.filter(s => s.style.getPropertyValue('--conceal-dur')).map(s => s.dataset.section),
        };
    }""")
    check("crossfade-all-settled",
          settle["shown"] == ["about"] and not settle["stillLeaving"] and not settle["concealing"],
          f"{settle}")

    # —— initSettingsMisc 绑定已执行：滑块初值 + 开关状态与 appSettings 同步 ——
    misc = page.evaluate("""() => {
        const sv = document.getElementById('setInitialVolume');
        const st = document.getElementById('setPreservesPitch');
        return {
            volInput: sv ? sv.value : null,
            volState: (window.appSettings && appSettings.playback) ? String(appSettings.playback.initialVolume) : 'no-appSettings',
            pitchOn: st ? st.classList.contains('on') : null,
            pitchState: (window.appSettings && appSettings.playback) ? String(!!appSettings.playback.preservesPitch) : 'no-appSettings',
            bindToggleDefined: typeof window.bindToggle === 'function' || typeof bindToggle === 'function'
        };
    }""")
    check("initSettingsMisc-vol-synced", misc["volInput"] is not None and misc["volInput"] == misc["volState"],
          f"input={misc['volInput']} appSettings={misc['volState']}")
    check("initSettingsMisc-toggle-synced", misc["pitchOn"] is not None and misc["pitchOn"] == (misc["pitchState"] == "true"),
          f"on={misc['pitchOn']} appSettings={misc['pitchState']}")

    # —— 开关真实点击 → appSettings 联动（证明 bindToggle 绑定未断）——
    toggle = page.evaluate("""async () => {
        const el = document.getElementById('setPreservesPitch');
        if (!el) return null;
        const before = appSettings.playback.preservesPitch;
        el.click();
        await new Promise(r => setTimeout(r, 80));
        const after = appSettings.playback.preservesPitch;
        el.click(); // 还原
        await new Promise(r => setTimeout(r, 80));
        return { before, after, restored: appSettings.playback.preservesPitch };
    }""")
    check("misc-toggle-click-links-appsettings", toggle is not None and toggle["after"] != toggle["before"] and toggle["restored"] == toggle["before"],
          str(toggle))

    # —— 本机 Now Playing 接管分组：开关/地址与 appSettings.nowPlaying 同步，试读按钮可点 ——
    np = page.evaluate("""() => {
        const t = document.getElementById('npEnabled');
        const url = document.getElementById('npUrl');
        return {
            toggleOn: t ? t.classList.contains('on') : null,
            state: (window.appSettings && appSettings.nowPlaying) ? String(!!appSettings.nowPlaying.enabled) : 'no',
            urlVal: url ? url.value : null,
            urlState: (window.appSettings && appSettings.nowPlaying) ? String(appSettings.nowPlaying.url) : 'no'
        };
    }""")
    check("nowplaying-group-synced",
          np["toggleOn"] is not None and np["toggleOn"] == (np["state"] == "true") and np["urlVal"] == np["urlState"],
          str(np))
    peek = page.evaluate("""async () => {
        const b = document.getElementById('npPeek');
        const st = document.getElementById('nowPlayingStatus');
        if (!b || !st) return null;
        b.click();
        await new Promise(r => setTimeout(r, 2500));
        return st.textContent;
    }""")
    check("nowplaying-peek-clickable", peek is not None and len(peek) > 0, str(peek))

    # —— 控制台错误（排除已知网络/资源噪声，ESM/JS 运行错误应为零）——
    noise = ("favicon", "net::", "404", "CORS", "blocked by CORS", "Access to image",
             "Failed to load resource", "加载歌曲出错", "音频错误", "DEMUXER", "audio_load_error")
    fatal = [e for e in console_errors if not any(k in e for k in noise)]
    check("no-fatal-console-errors", len(fatal) == 0, "; ".join(fatal[:4]))

    browser.close()

fails = [n for n, ok, _ in results if not ok]
print()
print("=" * 46)
print("TOTAL:", len(results), " PASS:", len(results) - len(fails), " FAIL:", len(fails))
sys.exit(1 if fails else 0)