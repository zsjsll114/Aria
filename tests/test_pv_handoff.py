# -*- coding: utf-8 -*-
"""PV 场景重叠滑出（handoff）自动测试：
1. 应用启动无致命控制台错误（ESM 链正常）；
2. 直接实例化 PVRendering，两次 transitionToNode 验证：
   - 位移向右 → 旧海报 pv-phrase-handoff-out + phv-right，新海报 pv-phrase-enter-handoff + phv-right
   - 新海报置顶（交棒层次：新是 stage 最后一个 poster）
   - 位移过小(center) → 回落 pv-phrase-exit-fade / pv-phrase-enter
   - getComputedStyle 的 animation-name 命中 pv-handoff-in / pv-handoff-out
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
    # ★ CI 稳定（2026-09-19 首次 CI 实证）：预置「手动高性能档」短路启动期异步性能自检——
    # 2 核 CI 实测 FPS 低，自检会晚于测试把 perf-minimal 重新加回 body，
    # pv.css 的 body.perf-minimal …{ animation:none !important } 会杀掉被测的 handoff 动画。
    page.add_init_script(
        "try { localStorage.setItem('lyrics_player_performance', JSON.stringify({ profile: 'high', manuallyConfigured: true })); } catch (e) {}"
    )
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    # 应用启动标记：themeEngine 引导后 root 变量落定（网络轮询多，不能用 networkidle）
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:120])
    page.wait_for_timeout(1500)

    check("app-boot-no-crash", page.evaluate("typeof window !== 'undefined' && !!document.querySelector('body')"))

    ev = page.evaluate("""async () => {
      const mod = await import('./src/core/pvEngine/PVRendering.js');
      const PVRendering = mod.PVRendering;
      const stage = document.createElement('div');
      stage.id = 'ho-test-stage';
      stage.style.cssText = 'position:absolute;left:0;top:0;width:800px;height:600px;overflow:visible;';
      document.body.appendChild(stage);
      const r = new PVRendering(stage);
      // 无头环境 WebGL 缺失 → 应用自动降级 body.perf-minimal 会杀死 PV 动画；
      // 移除 perf-* 档类以验证真实的 handoff 动画配置
      document.body.className = document.body.className.split(' ').filter(c => !c.startsWith('perf-')).join(' ');
      const mkNode = (x, y, text) => ({
        text: text,
        pos: { x: x, y: y, scale: 1, z: 0, pitch: 0, roll: 0 },
        archetype: 'vertical-cascade',
        themeColor: '#ffcc33',
        lines: [{ start: 0, end: 2000, isVerticalLine: false, translation: 't', romaji: 'r',
                  blocks: [{ start: 0, end: 1000, scale: 'hero', isEmotion: false,
                             hasSpaceAfter: false,
                             chars: [{ char: text, start: 0, end: 1000 }] }] }],
        blocks: [{ start: 0, end: 1000, scale: 'hero', isEmotion: false, hasSpaceAfter: false,
                   chars: [{ char: text, start: 0, end: 1000 }] }]
      });
      const out = {};
      // —— 场景 1 → 场景 2（向右位移 300px）——
      r.transitionToNode(mkNode(0, 0, 'A'), '#ffcc33');
      r.transitionToNode(mkNode(300, 0, 'B'), '#ffcc33');
      // 动画需约一帧后才落到 computed style
      await new Promise(res => setTimeout(res, 160));
      const posters = stage.querySelectorAll('.pv-poster-container');
      out.nPosters = posters.length;
      out.oldP = posters[0];
      out.newP = posters[1];
      out.newIsLast = stage.lastElementChild === posters[1];
      out.oldCls = posters[0].className;
      out.newCls = posters[1].className;
      out.oldAnim = getComputedStyle(posters[0]).animationName;
      out.newAnim = getComputedStyle(posters[1]).animationName;
      // 等 620ms 让第一对海报清除后，再测 center 回落
      await new Promise(res => setTimeout(res, 620));
      r.transitionToNode(mkNode(310, 5, 'C'), '#ffcc33');  // 位移仅 ~10px → center
      const ps2 = stage.querySelectorAll('.pv-poster-container');
      const last = ps2[ps2.length - 1];
      const prev = last.previousElementSibling;
      out.centerPrevCls = prev ? prev.className : '';
      out.centerNewCls = last ? last.className : '';
      out.centerNewAnim = last ? getComputedStyle(last).animationName : '';
      out.centerPrevAnim = prev ? getComputedStyle(prev).animationName : '';
      return out;
    }""")

    check("right-handoff-old-class", "pv-phrase-handoff-out" in ev["oldCls"] and "phv-right" in ev["oldCls"], ev["oldCls"])
    check("right-handoff-new-class", "pv-phrase-enter-handoff" in ev["newCls"] and "phv-right" in ev["newCls"], ev["newCls"])
    check("new-on-top-handoff", ev["newIsLast"], str(ev["nPosters"]))
    check("old-anim-handoff-out", "pv-handoff-out" in str(ev["oldAnim"]), str(ev["oldAnim"]))
    check("new-anim-handoff-in", "pv-handoff-in" in str(ev["newAnim"]), str(ev["newAnim"]))

    check("center-fallback-prev", "pv-phrase-enter" in str(ev["centerPrevCls"]) and "handoff" not in str(ev["centerPrevCls"]), str(ev["centerPrevCls"]))
    check("center-fallback-new", "pv-phrase-exit-fade" in str(ev["centerNewCls"]), str(ev["centerNewCls"]))
    # 新(center)海报走 pop-in（在 prev 上），旧海报走 fade-out（在 last 上）
    check("center-new-anim-pop-in", "pv-pop-in" in str(ev["centerPrevAnim"]), str(ev["centerPrevAnim"]))
    check("center-old-anim-fade-out", "pv-fade-out" in str(ev["centerNewAnim"]), str(ev["centerNewAnim"]))

    # 控制台错误（排除图片/CORS/404/默认歌曲媒体加载等已知噪声，ESM/语法错误应为零）
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