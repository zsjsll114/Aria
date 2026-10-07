"""自定义分钟数输入框：原生 ± 箭头已关掉，改由 utils/numberStepper.js 的真实按钮驱动。

用户原话：「自定义分钟数那个数字框好丑，做个自定义样式」。
要点不是好看与否（那要人眼判），而是：
1. UA 影子箭头确实关掉了（appearance/textfield + spin-button 宽度为 0）；
2. ± 按钮存在、可点，且按 min/max 收口（点到底不会越界）；
3. 点击会派发 input 事件 —— 睡眠定时器的既有监听依赖它；
4. 设置页「每次跳转秒数」那个数字框同样不再带行内样式。
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))


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
        page.evaluate("""() => {
            document.getElementById('welcomeOverlay')?.classList.remove('visible');
            document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
        }""")

        # 打开睡眠定时器面板
        page.evaluate("""async () => {
            const m = await import('/src/app/280-sleep-timer.js');
            const ov = document.getElementById('sleepTimerOverlay');
            if (ov) ov.classList.add('visible');
        }""")
        page.wait_for_timeout(300)

        geom = page.evaluate("""() => {
            const input = document.getElementById('sleepTimerCustomInput');
            const wrap = input && input.closest('.num-stepper');
            const btns = wrap ? Array.from(wrap.querySelectorAll('[data-num-step]')) : [];
            const cs = input ? getComputedStyle(input) : null;
            const b0 = btns[0] ? getComputedStyle(btns[0]) : null;
            return {
                hasWrap: !!wrap,
                btnCount: btns.length,
                appearance: cs ? (cs.appearance || cs.webkitAppearance || '') : '',
                btnText: btns.map(b => b.textContent.trim()),
                btnW: b0 ? b0.width : '',
                inputVisible: !!input && input.getBoundingClientRect().width > 0,
                labels: btns.map(b => b.getAttribute('aria-label') || ''),
            };
        }""")
        check("stepper-wrapped", geom["hasWrap"] and geom["btnCount"] == 2, geom)
        check("native-spinner-off", geom["appearance"] in ("textfield", "none", ""), geom["appearance"])
        check("step-buttons-visible", geom["inputVisible"] and geom["btnW"] not in ("", "0px"), geom["btnW"])
        check("step-buttons-labelled", all(geom["labels"]), geom["labels"])

        # ± 行为：从空值起步、按 min 收口、按 max 收口、派发 input 事件
        behavior = page.evaluate("""() => {
            const input = document.getElementById('sleepTimerCustomInput');
            const wrap = input.closest('.num-stepper');
            const minus = wrap.querySelector('[data-num-step="-1"]');
            const plus = wrap.querySelector('[data-num-step="1"]');
            let inputEvents = 0, changeEvents = 0;
            input.addEventListener('input', () => { inputEvents++; });
            input.addEventListener('change', () => { changeEvents++; });
            const out = { seq: [] };
            input.value = '';
            plus.click(); out.seq.push(input.value);          /* 空框 +1 → 收口到 min=1 */
            plus.click(); out.seq.push(input.value);          /* 2 */
            minus.click(); out.seq.push(input.value);         /* 1 */
            minus.click(); out.seq.push(input.value);         /* 停在 min，不越界到 0 */
            minus.click(); out.seq.push(input.value);
            input.value = '599'; plus.click(); out.seq.push(input.value); /* 600 */
            plus.click(); out.seq.push(input.value);                       /* 停在 max */
            plus.click(); out.seq.push(input.value);
            out.events = { inputEvents, changeEvents };
            return out;
        }""")
        check("step-from-empty-clamps-to-min", behavior["seq"][0] == "1", behavior["seq"])
        check("step-up-and-down", behavior["seq"][1:3] == ["2", "1"], behavior["seq"])
        check("clamped-at-min", behavior["seq"][3] == "1" and behavior["seq"][4] == "1", behavior["seq"])
        check("clamped-at-max", behavior["seq"][5] == "600" and behavior["seq"][7] == "600", behavior["seq"])
        # 8 次点击 = 8 次 input + 8 次 change（既有监听依赖 input）
        check("dispatches-input-and-change",
              behavior["events"]["inputEvents"] == 8 and behavior["events"]["changeEvents"] == 8,
              behavior["events"])

        # 纯函数：小数 step 不得漂出 0.30000000000000004
        frac = page.evaluate("""async () => {
            const m = await import('/src/utils/numberStepper.js');
            const el = document.createElement('input');
            el.type = 'number'; el.min = '0'; el.max = '2'; el.step = '0.1'; el.value = '0.2';
            document.body.appendChild(el);
            m.stepNumberInput(el, 1);
            const v = el.value;
            el.remove();
            return v;
        }""")
        check("decimal-step-no-float-drift", frac == "0.3", frac)

        # 设置页那个紧跟滑块的数字框：行内样式已摘掉，形状由 .setting-number-input 给
        seek = page.evaluate("""() => {
            const el = document.getElementById('setSeekStepInput');
            const cs = getComputedStyle(el);
            return { inline: el.getAttribute('style'), radius: cs.borderRadius,
                     align: cs.textAlign, appearance: cs.appearance || cs.webkitAppearance };
        }""")
        check("seek-step-inline-style-removed", seek["inline"] is None, seek)
        check("seek-step-styled-by-class", seek["radius"] not in ("0px", "") and seek["align"] == "center", seek)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
