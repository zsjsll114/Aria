# -*- coding: utf-8 -*-
"""AI 反代隐私确认：开机/无手势不得弹窗（2026-09-26 产品修复的回归钉）

背景：开机预加载（180-boot-config → 175 loadOnlineSong(preloadOnly)）在页面加载后
几秒就会自己调到 AI 分析。Gemini 走反代时那条路径上挂着一个 await 用户点击的隐私
确认框，而预加载**没有任何用户手势**——用户什么都没做，弹窗就杵在屏幕中央拦住整页。
修复是两层：预加载调用点声明 silent，外加「没有用户手势就不弹」的机制兜底
（读 navigator.userActivation.hasBeenActive），跳过时只留一条日志、不发任何数据。

钉住四件事：
1. 无手势时调用（开机预加载同一条路径）不弹窗，且确实走到了确认闸门；
2. 有手势后必须照常弹——静默只是**推迟**确认，不是把确认取消掉；
3. 点「取消」= 不 consent：弹窗收起且 localStorage 标记仍为空（下次还会问）；
4. 带 silent 的调用点即使页面已有手势也不弹（挡住「用户点过别的东西之后预加载才
   完成」这条更隐蔽的弹窗路径）。

★ 为什么用 add_init_script 桩掉 userActivation：Playwright/CDP 的 evaluate 自带
userGesture，跑第一行脚本时页面就已经「有手势」了，真机开机那一刻的
hasBeenActive=false 在测试里读不到（实测第一次 evaluate 就返回 true）。所以把开关
做成可控的——被测的是代码读到 false 时的行为。真机侧已人工验证：清掉标记 → 刷新 →
开机无弹窗，控制台留痕「AI 反代隐私确认：预加载路径不弹窗」。

前提：python server.py 已在 :8001 启动；且本机 AI 配置确实走反代
（provider=gemini + apiBase 含 de5.net + enabled）。不满足时整体 SKIP——
CI 的全新 checkout 里 ai.enabled 是 false，正好走这条分支。
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
results = []

# 闸门留痕文案（201-settings-ai.js 的 logWarn），改文案要同步改这里
NO_GESTURE_LOG = "还没有用户手势"
PRELOAD_LOG = "预加载路径不弹窗"


def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)


def boot(browser, gesture, warns):
    """开一个把 userActivation 桩成可控值的页面。gesture=False 复刻开机状态。"""
    page = browser.new_page(viewport={"width": 1280, "height": 720}, reduced_motion="no-preference")
    page.on("console", lambda m: warns.append(m.text) if m.type in ("warning", "warn") else None)
    page.on("pageerror", lambda e: warns.append("PAGEERROR " + str(e)))
    page.add_init_script("""(() => {
        let v = %s;
        Object.defineProperty(navigator, 'userActivation', {
            configurable: true, get: () => ({ hasBeenActive: v, isActive: v }),
        });
        window.__setGesture = (x) => { v = !!x; };
    })();""" % ("true" if gesture else "false"))
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function("() => typeof window.triggerAiAnalysisIfNeeded === 'function'", timeout=25000)
    return page


def call_ai(page, opts=None):
    """调一次 triggerAiAnalysisIfNeeded，返回弹窗与确认标记的快照。"""
    return page.evaluate("""async (opts) => {
        window.triggerAiAnalysisIfNeeded(opts);
        await new Promise(r => setTimeout(r, 700));
        const ov = document.querySelector('.aria-dialog-overlay');
        return { shown: !!ov,
                 title: ov ? (ov.querySelector('.aria-dialog-title') || {}).textContent : '',
                 notice: localStorage.getItem('aria_ai_proxy_notice') };
    }""", opts if opts is not None else {})


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    warns = []
    page = boot(browser, gesture=False, warns=warns)

    # 配置是异步从 /api/config/load 落地的，落地前 appSettings.ai 还是 defaults
    # （enabled:false），所以这里等到它真的 armed 为止；到点仍不 armed 就是环境问题。
    ARMED_JS = """() => {
        const ai = (window.appSettings && appSettings.ai) || {};
        return ai.enabled !== false && ai.provider === 'gemini'
            && (!ai.apiBase || ai.apiBase.indexOf('de5.net') >= 0);
    }"""
    try:
        page.wait_for_function(ARMED_JS, timeout=15000)
        armed = True
    except Exception:
        armed = page.evaluate(ARMED_JS)
    if not armed:
        for n in ("no-gesture-stays-silent", "no-gesture-keeps-notice-empty",
                  "gesture-still-asks", "cancel-keeps-notice-empty",
                  "preload-call-stays-silent"):
            results.append((n, True, "SKIP 本机 AI 未走反代（或智能分析已关闭），确认框本就不该出现"))
            print("SKIP", n)
    else:
        # —— 1. 无手势：开机预加载同一条路径必须静默（修复前的代码在这里弹窗）——
        r1 = call_ai(page)
        check("no-gesture-stays-silent",
              not r1["shown"] and any(NO_GESTURE_LOG in w for w in warns),
              f"dialog={r1['shown']} log={[w for w in warns if '隐私确认' in w][:1]}")
        check("no-gesture-keeps-notice-empty", r1["notice"] is None,
              "静默跳过不许顺手把确认标记写上（那等于永久免问）")

        # —— 2. 有手势：再调一次必须弹（静默只是推迟，不是取消确认）——
        page.evaluate("window.__setGesture(true)")
        r2 = call_ai(page)
        check("gesture-still-asks", r2["shown"] and "反代" in (r2["title"] or ""), str(r2))

        # —— 3. 取消 = 不同意：收起且不留标记（留了标记等于永远不再问）——
        after = page.evaluate("""async () => {
            const cancel = document.querySelector('.aria-dialog-overlay .aria-dialog-btn:not(.primary)');
            if (cancel) cancel.click();
            await new Promise(r => setTimeout(r, 700));
            return { gone: !document.querySelector('.aria-dialog-overlay'),
                     notice: localStorage.getItem('aria_ai_proxy_notice') };
        }""")
        check("cancel-keeps-notice-empty", after["gone"] and after["notice"] is None, str(after))

        # —— 4. silent 调用点：手势已经有了也不弹（175 preloadOnly 那一次的语义）——
        r4 = call_ai(page, {"silent": True})
        check("preload-call-stays-silent",
              not r4["shown"] and any(PRELOAD_LOG in w for w in warns),
              f"dialog={r4['shown']} log={[w for w in warns if PRELOAD_LOG in w][-1:]}")

    browser.close()

fails = [n for n, ok, _ in results if not ok]
print()
print("=" * 46)
print("TOTAL:", len(results), " PASS:", len(results) - len(fails), " FAIL:", len(fails))
sys.exit(1 if fails else 0)
