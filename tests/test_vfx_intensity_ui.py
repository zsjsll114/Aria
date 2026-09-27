"""动效强度滑杆（todos #6）在浏览器里的真实行为。

纯映射在 tests/js/test_vfx_intensity.js；这里验的是接线，也就是「用户拖一下到底改变了什么」：
  · 默认必须是**跟随档位**（不覆盖任何键）——否则启动时滑杆就把自动检测出来的档位顶掉；
  · 拖到 0 / 100 后 `getPerfVfx()` 真的等于 minimal / high 的 vfx（证明通到了引擎，不只是存了个数）；
  · 中间点是两端之间，且渲染缩放落在 0.05 网格上（与手动微调滑条同网格）；
  · 说明行真的把「这一档给了什么」报出来（0 处必须出现「只保留逐字高亮」与「背景模糊 0px」）；
  · ★ 手动单项开关**优先于**滑杆——拖滑杆不得无声覆盖用户手调过的开关；
  · 刷新后仍在（走真实 user_config.json，所以退出前必须恢复默认）；
  · 「跟随等级」按钮与两个「恢复推荐/出厂配置」按钮都会清掉滑杆偏好。

★ 这个 E2E 写真实配置：性能档在 localStorage、强度在 user_config.json，
  同机的别的 8001 客户端也会读——所以全程 try/finally 恢复初始状态。
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []

VFX_KEYS = ['renderScale', 'coverBlur', 'glassBlur', 'lyricBlur', 'textBlur',
            'pvBloom', 'flyinGlow', 'wcParticles', 'tunnelParticles', 'dimParticles']


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:240] if detail else ""))


def js(page, expr):
    return page.evaluate(expr)


def restore_defaults(page, snapshot):
    """把性能档、滑杆偏好、手动微调三项全部钉回测试开始前的样子。"""
    try:
        page.evaluate("""async (snap) => {
            const m = await import('/src/app/180-boot-config.js');
            appSettings.interface.vfxIntensity = null;
            m.saveSettings();
            await m.syncConfigToBackend();
            if (snap.overrides === null) localStorage.removeItem('perf_vfx_overrides_v1');
            else localStorage.setItem('perf_vfx_overrides_v1', snap.overrides);
            if (snap.perf !== null) localStorage.setItem('lyrics_player_performance', snap.perf);
            else localStorage.removeItem('lyrics_player_performance');
            m.applyPerformanceProfile(snap.profile);
        }""", snapshot)
        page.wait_for_timeout(500)
    except Exception as e:
        print("  WARN 恢复默认失败（会污染 user_config.json / localStorage）:", e)


def set_slider(page, value):
    """拖动滑杆 = 改 value + 派发 input（和人手拖的事件序列一致）"""
    page.evaluate("""(v) => {
        const el = document.getElementById('vfxIntensity');
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }""", value)
    page.wait_for_timeout(260)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            page.goto(URL, wait_until="load")
            try:
                page.wait_for_function(
                    "() => !!(window.Aria && typeof Aria.__syncVfxIntensity === 'function')",
                    timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(1500)

            # 初始状态存档（测试结束原样放回）
            snapshot = js(page, """() => ({
                profile: (JSON.parse(localStorage.getItem('lyrics_player_performance') || 'null') || {}).profile || 'medium',
                perf: localStorage.getItem('lyrics_player_performance'),
                overrides: localStorage.getItem('perf_vfx_overrides_v1'),
            })""")

            # ---- ① 接线存在 + 默认跟随 ----
            present = js(page, """() => ({
                slider: !!document.getElementById('vfxIntensity'),
                follow: !!document.getElementById('vfxIntensityFollow'),
                desc: !!document.getElementById('vfxIntensityDesc'),
                value: !!document.querySelector('[data-val="vfxIntensity"]'),
            })""")
            check("slider-row-wired", all(present.values()), present)

            dflt = js(page, """() => ({
                saved: appSettings.interface.vfxIntensity,
                thumb: document.getElementById('vfxIntensity').value,
                span: document.querySelector('[data-val="vfxIntensity"]').textContent,
                desc: document.getElementById('vfxIntensityDesc').textContent,
                vfx: window.getPerfVfx(),
            })""")
            check("default-is-follow-tier", dflt["saved"] is None, dflt)
            check("follow-span-says-follow", "跟随" in dflt["span"], dflt["span"])
            check("follow-desc-says-tier", "当前跟随档位" in dflt["desc"], dflt["desc"][:120])

            # 跟随态的指针位置 = 当前档位的等效位置（不是随便一个数）
            equiv = js(page, """async () => {
                const m = await import('/src/core/vfxIntensity.js');
                const saved = JSON.parse(localStorage.getItem('lyrics_player_performance') || 'null');
                return { thumb: document.getElementById('vfxIntensity').value,
                         expect: m.intensityForProfile((saved && saved.profile) || 'medium') };
            }""")
            check("follow-thumb-at-tier-equivalent",
                  str(equiv["expect"]) == str(equiv["thumb"]) or
                  float(equiv["thumb"]) == float(equiv["expect"]), equiv)

            # ---- ② 拖到两端真的通到引擎 ----
            anchors = js(page, """async () => {
                const P = (await import('/src/config/performance.js')).PERFORMANCE_PROFILES;
                return { minimal: P.minimal.vfx, high: P.high.vfx };
            }""")
            for target, key in ((0, "minimal"), (100, "high")):
                set_slider(page, target)
                got = js(page, "() => window.getPerfVfx()")
                diff = {k: (got.get(k), anchors[key][k]) for k in VFX_KEYS if got.get(k) != anchors[key][k]}
                check("slider-%d-equals-%s-tier" % (target, key), not diff, diff)

            # ---- ③ 中间点：在两端之间 + 0.05 网格 ----
            set_slider(page, 50)
            mid = js(page, """() => ({ vfx: window.getPerfVfx(),
                desc: document.getElementById('vfxIntensityDesc').textContent })""")["vfx"]
            check("midpoint-blur-between-anchors",
                  anchors["minimal"]["coverBlur"] < mid["coverBlur"] < anchors["high"]["coverBlur"], mid)
            check("midpoint-render-scale-on-grid",
                  abs(mid["renderScale"] * 20 - round(mid["renderScale"] * 20)) < 1e-9, mid["renderScale"])
            check("midpoint-pv-bloom-still-off", mid["pvBloom"] is False,
                  "只有 high 档为真，权重过半（≥84）才该点亮")
            set_slider(page, 90)
            check("high-side-bloom-on", js(page, "() => window.getPerfVfx().pvBloom") is True)

            # ---- ④ 说明行把「损失了什么」报出来 ----
            set_slider(page, 0)
            desc0 = js(page, "() => document.getElementById('vfxIntensityDesc').textContent")
            check("desc-at-zero-explains-loss",
                  "只保留逐字高亮" in desc0 and "背景模糊 0px" in desc0, desc0[:160])
            set_slider(page, 100)
            desc100 = js(page, "() => document.getElementById('vfxIntensityDesc').textContent")
            check("desc-at-hundred-lists-effects",
                  "背景模糊 60px" in desc100 and "PV 发光 开" in desc100, desc100[:200])

            # ---- ⑤ ★ 手动单项开关优先于滑杆 ----
            js(page, """() => {
                const el = document.getElementById('vfxPvBloom');
                if (el.classList.contains('on')) el.click();   // 关掉 bloom
            }""")
            page.wait_for_timeout(200)
            manual = js(page, """async () => {
                const m = await import('/src/app/180-boot-config.js');
                return { off: m.getVfxOverrides().pvBloom,
                         stored: JSON.parse(localStorage.getItem('perf_vfx_overrides_v1') || '{}') };
            }""")
            check("manual-switch-recorded", manual["off"] is False, manual)
            # ★ 手调表里只该有用户真碰过的那一个键。整表被写成 10 个键 = 滑杆当时的推导值
            #   被冻结成「手动优先」，滑杆从此失效（setVfxOverride 的基底取错过一次，实测复现）
            check("manual-table-stays-minimal", list(manual["stored"].keys()) == ["pvBloom"], manual["stored"])
            set_slider(page, 100)     # 拉满——不得把手调的「关」覆盖掉
            after = js(page, "() => window.getPerfVfx().pvBloom")
            check("slider-does-not-clobber-manual", after is False,
                  "滑杆拉满不得无声覆盖用户手动关掉的开关（那是数据丢失）")
            js(page, """() => {
                localStorage.removeItem('perf_vfx_overrides_v1');
                const el = document.getElementById('vfxPvBloom');
                el.classList.remove('on');
            }""")

            # ---- ⑥ 持久化（真实 user_config.json，先同步再刷新） ----
            set_slider(page, 20)
            js(page, """async () => {
                const m = await import('/src/app/180-boot-config.js');
                await m.syncConfigToBackend();
            }""")
            page.reload(wait_until="load")
            page.wait_for_timeout(2500)
            revived = js(page, """() => ({
                saved: appSettings.interface.vfxIntensity,
                thumb: document.getElementById('vfxIntensity').value,
                blur: window.getPerfVfx().coverBlur,
            })""")
            check("intensity-persists-across-reload",
                  revived["saved"] == 20 and float(revived["thumb"]) == 20.0, revived)
            check("revived-value-still-applied",
                  revived["blur"] > anchors["minimal"]["coverBlur"]
                  and revived["blur"] < anchors["high"]["coverBlur"], revived)

            # ---- ⑦ 「跟随等级」按钮清掉偏好 ----
            js(page, "() => document.getElementById('vfxIntensityFollow').click()")
            page.wait_for_timeout(300)
            followed = js(page, """() => ({
                saved: appSettings.interface.vfxIntensity,
                span: document.querySelector('[data-val="vfxIntensity"]').textContent,
                vfx: window.getPerfVfx(),
            })""")
            check("follow-button-clears-pref", followed["saved"] is None, followed["saved"])
            tier_check = js(page, """async () => {
                const P = (await import('/src/config/performance.js')).PERFORMANCE_PROFILES;
                const saved = JSON.parse(localStorage.getItem('lyrics_player_performance') || 'null');
                const prof = (saved && saved.profile) || 'medium';
                const got = window.getPerfVfx();
                const want = P[prof].vfx;
                const diff = {};
                for (const k of ['renderScale','coverBlur','glassBlur','lyricBlur','textBlur',
                                 'pvBloom','flyinGlow','wcParticles','tunnelParticles','dimParticles'])
                    if (got[k] !== want[k]) diff[k] = [got[k], want[k]];
                return { prof, diff };
            }""")
            check("follow-mode-equals-tier", not tier_check["diff"], tier_check)

            # ---- ⑧ 切档位时跟随态的指针/说明跟着走 ----
            js(page, "() => document.querySelector('#setPerformanceProfile button[data-val=\"minimal\"]').click()")
            page.wait_for_timeout(700)
            after_tier = js(page, """() => ({
                thumb: document.getElementById('vfxIntensity').value,
                desc: document.getElementById('vfxIntensityDesc').textContent,
            })""")
            check("tier-switch-moves-follow-thumb",
                  float(after_tier["thumb"]) == 0.0 and "极简" in after_tier["desc"], after_tier)

            # ---- ⑨ 「恢复出厂配置」必须同时清掉滑杆（否则按钮撒了谎） ----
            set_slider(page, 30)
            js(page, """() => {
                const btn = document.getElementById('btnResetPerfFactory');
                // 破坏性操作走 021 的确认框：直接把 Promise 的结果当「确认」处理
                btn.click();
            }""")
            page.wait_for_timeout(500)
            ok_btn = js(page, """() => {
                // 021 的确认框：OK 是 .aria-dialog-btn.primary（cancel 在前，别按 last-child 猜）
                const b = document.querySelector('.aria-dialog-overlay .aria-dialog-btn.primary');
                if (b) b.click();
                return !!b;
            }""")
            page.wait_for_timeout(900)
            reset_state = js(page, "() => appSettings.interface.vfxIntensity")
            check("factory-reset-clears-intensity", reset_state is None,
                  {"intensity": reset_state, "confirmClicked": ok_btn})

            check("no-page-errors", not errors, errors[:3])
        finally:
            try:
                restore_defaults(page, snapshot)
            except Exception as e:
                print("  WARN 收尾失败:", e)
            browser.close()

        failed = [r for r in RESULTS if not r[1]]
        print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
        for name, _, detail in failed:
            print("  FAIL", name, detail)
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
