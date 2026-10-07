"""标题栏三大金刚键随背景实时变色（感知亮度 + 迟滞 + 缓动）。

用户原话：「右上角三大金刚键不会实时随着背景颜色变化而变化，比如打开暗色窗口之后
就不会从黑色按钮变为亮色以区分（变化时记得非线性变化）」。

旧实现两处错（都在 240-titlebar.js 的 updateBrandColor）：
① 亮度用 (0.2126R+0.7152G+0.0722B)/255 —— 把 sRGB 编码值当光强算，没有 gamma 解码，
   中灰算出 0.504 判成"亮"，真实相对亮度只有 0.216；
② 完全忽略 .blur-background 的 brightness(0.35) —— 按钮底下那层比封面主色暗得多，
   于是白封面时判成亮背景→深色墨，在真实的暗背景上就"变成黑色按钮看不见"。
现在改成：读背景层**实际合成**出来的颜色算 WCAG 相对亮度，按两墨对比度取边 + 迟滞防抖。
"""
import re
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))


SETUP = """(a) => {
    const blur = document.getElementById('blurBackground');
    /* ★ 亮度要写进 appSettings，不要只写 inline filter：无显卡/软件渲染设备上降级段会把
       .blur-background 的 filter 打成 none（预烘焙路径），inline 样式根本到不了 computed。
       240 的读法就是「computed filter 优先、拿不到退回 appSettings」，所以驱动 appSettings
       在两种设备上都是同一个旋钮——也正是用户拖设置里那个滑块时走的路径。 */
    window.appSettings.background.brightness = a.brightness;
    blur.style.filter = `blur(60px) brightness(${a.brightness})`;
    blur.style.backgroundImage = 'url(data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)';
    blur.classList.add('visible');
    const ov = document.getElementById('colorOverlay');
    if (a.overlay === null) { ov.classList.remove('visible'); ov.style.backgroundColor = 'rgba(0,0,0,0)'; }
    else { ov.style.backgroundColor = `rgba(${a.overlay}, ${a.overlay}, ${a.overlay}, ${a.overlayA})`; ov.classList.add('visible'); }
    window.dominantColor = { r: a.cover, g: a.cover, b: a.cover };
    if (a.mode) {
        const pc = document.querySelector('.player-container');
        pc.className = 'player-container view-' + a.mode;
    }
    globalThis.__updateBrandColor();
    const cs = getComputedStyle(document.documentElement);
    return {
        fg: cs.getPropertyValue('--titlebar-fg').trim(),
        hover: cs.getPropertyValue('--titlebar-hover-bg').trim(),
        veil: cs.getPropertyValue('--titlebar-veil-bg').trim(),
        btnColor: getComputedStyle(document.getElementById('tbMinimize')).color,
        filterComputed: getComputedStyle(blur).filter,
    };
}"""


LIGHT = 'rgba(255,255,255,0.92)'
DARK = 'rgba(20,20,24,0.92)'


def norm(s):
    """自定义属性保留**写入时**的字面量（不带空格），而 getComputedStyle(color) 会规范化成
    带空格的 —— 两边都去掉空格再比，否则断言会自己制造假失败。"""
    return (s or '').replace(' ', '').strip()


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
            ['ariaOobeOverlay','welcomeOverlay'].forEach(id => { const e = document.getElementById(id); if (e) e.setAttribute('style','display:none !important'); });
        }""")

        LIGHT = 'rgba(255, 255, 255, 0.92)'
        DARK = 'rgba(20, 20, 24, 0.92)'

        # —— 1. 核心回归：白封面 + 默认 brightness(0.35) → 背景其实很暗，必须保持亮墨 ——
        #      旧公式在这里给深色墨（= 用户看到的"不变亮、看不清"）
        r1 = page.evaluate(SETUP, {"cover": 255, "brightness": 0.35, "overlay": None, "mode": "cover"})
        check("white-cover-dimmed-keeps-light-ink", norm(r1["fg"]) == norm(LIGHT), r1)
        check("btn-color-follows-token", norm(r1["btnColor"]) in (norm(LIGHT), "rgb(255,255,255)"), r1["btnColor"])

        # —— 2. 把背景亮度拉满：白封面 → 背景真亮了 → 必须翻成暗墨 ——
        r2 = page.evaluate(SETUP, {"cover": 255, "brightness": 1.0, "overlay": None, "mode": "cover"})
        check("bright-backdrop-flips-to-dark-ink", norm(r2["fg"]) == norm(DARK), r2)
        check("hover-token-flips-too", norm(r2["hover"]).startswith("rgba(0,0,0"), r2["hover"])
        check("veil-token-flips-too", norm(r2["veil"]).startswith("rgba(0,0,0"), r2["veil"])

        # —— 3. 反向：黑封面 + 满亮度 → 暗墨会被判错吗？必须仍是亮墨 ——
        r3 = page.evaluate(SETUP, {"cover": 0, "brightness": 1.0, "overlay": None, "mode": "cover"})
        check("black-cover-stays-light-ink", norm(r3["fg"]) == norm(LIGHT), r3)

        # —— 4. 中间调（旧线性阈值 0.48 会判错的那一档）：128 灰 × 满亮度 ≈ 感知 0.216，偏暗 → 亮墨 ——
        r4 = page.evaluate(SETUP, {"cover": 128, "brightness": 1.0, "overlay": None, "mode": "cover"})
        check("midgray-uses-perceptual-not-linear", norm(r4["fg"]) == norm(LIGHT), r4)

        # —— 5. color-overlay 叠色要参与合成：满亮度白封面 + 30% 白叠层 → 更亮 → 暗墨 ——
        r5 = page.evaluate(SETUP, {"cover": 255, "brightness": 0.6, "overlay": 255, "overlayA": 0.5, "mode": "cover"})
        check("overlay-tint-counts-in-composite", norm(r5["fg"]) == norm(DARK), r5)

        # —— 6. 深色舞台模式恒亮墨（旧版漏了 flyin / wordcloud）——
        for m in ("letterpress", "neon", "tunnel", "dimension", "pv", "flyin", "wordcloud"):
            r = page.evaluate(SETUP, {"cover": 255, "brightness": 1.0, "overlay": None, "mode": m})
            check(f"self-dark-stage-{m}-forces-light-ink", norm(r["fg"]) == norm(LIGHT), r)
        # 恢复 cover 模式
        page.evaluate(SETUP, {"cover": 255, "brightness": 1.0, "overlay": None, "mode": "cover"})
        page.wait_for_timeout(200)

        # —— 7. 实时：模拟「拖设置里的背景亮度滑块」——applyBackgroundSettings 同时写
        #        appSettings 与 inline filter，后者触发我挂的 style 观察器，前者是被读到的值。
        page.evaluate("""() => {
            window.__fgSeen = [];
            const root = document.documentElement;
            new MutationObserver(() => window.__fgSeen.push(getComputedStyle(root).getPropertyValue('--titlebar-fg').trim()))
                .observe(root, { attributes: true, attributeFilter: ['style'] });
        }""")
        before = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--titlebar-fg').trim()")
        page.evaluate("""() => {
            window.appSettings.background.brightness = 0.15;      /* 突然压暗：白封面也变暗背景 */
            document.getElementById('blurBackground').style.filter = 'blur(60px) brightness(0.15)';
        }""")
        page.wait_for_timeout(500)
        after = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--titlebar-fg').trim()")
        check("reacts-without-manual-call", norm(after) == norm(LIGHT) and norm(before) == norm(DARK), f"{before} -> {after}")

        # —— 7b. 软件渲染设备上 .blur-background 的 filter 被降级成 none（预烘焙路径）：
        #         此时必须退回 appSettings 的亮度，而不是当成 brightness=1 处理。
        fb = page.evaluate("""() => {
            const blur = document.getElementById('blurBackground');
            blur.style.filter = 'none';
            window.appSettings.background.brightness = 0.35;
            window.dominantColor = { r: 255, g: 255, b: 255 };
            const pc = document.querySelector('.player-container');
            pc.className = 'player-container view-cover';
            globalThis.__updateBrandColor();
            return { computed: getComputedStyle(blur).filter,
                     fg: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-fg').trim() };
        }""")
        check("degraded-filter-falls-back-to-settings",
              ("none" in fb["computed"]) == True and norm(fb["fg"]) == norm(LIGHT), fb)

        # —— 8. 设置页预览壳（.preview-player）不得把全局亮暗档带跑 ——
        prev = page.evaluate("""() => {
            /* 造一个带 .preview-player 的容器并给它 view-letterpress，
               若判定没排掉它，全局墨色会被预览拖走 */
            const fake = document.createElement('div');
            fake.className = 'player-container preview-player view-letterpress';
            document.body.appendChild(fake);
            globalThis.__updateBrandColor();
            const fg = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-fg').trim();
            fake.remove();
            return fg;
        }""")
        check("preview-player-ignored", norm(prev) == norm(LIGHT), prev)

        # —— 9. 换边必须是缓动而不是硬切（用户："变化时记得非线性变化"）——
        motion = page.evaluate("""() => {
            const btn = getComputedStyle(document.getElementById('tbMinimize'));
            const brand = getComputedStyle(document.querySelector('.tb-brand'));
            const parse = (s) => (s || '').split(/,(?![^(]*\\))/).map(x => {
                const parts = x.trim().split(/\\s+/);
                return { prop: parts[0], dur: parts[1] };
            });
            return { btn: parse(btn.transition), brand: parse(brand.transition) };
        }""")
        def has_eased(props, prop):
            hit = [x for x in props if x["prop"] == prop]
            return bool(hit) and hit[0]["dur"] not in ("0s", "")
        check("btn-color-transition-eased", has_eased(motion["btn"], "color"), motion["btn"])
        check("btn-bg-transition-eased", has_eased(motion["btn"], "background"), motion["btn"])
        check("brand-color-transition-eased", has_eased(motion["brand"], "color"), motion["brand"])
        # 缓动曲线必须是动效令牌里的三条之一，不许再抄 ease/linear
        curve = page.evaluate("""() => {
            const t = getComputedStyle(document.getElementById('tbMinimize')).transitionTimingFunction;
            return t;
        }""")
        ALLOWED_CURVES = ("cubic-bezier(0.16,1,0.3,1)", "cubic-bezier(0.22,1,0.36,1)", "cubic-bezier(0.4,0,1,1)")
        parts = [norm(c) for c in re.split(r",\s*(?![^()]*\))", curve)]
        check("uses-motion-token-curve", bool(parts) and all(p in ALLOWED_CURVES for p in parts), curve[:120])

        # —— 10. 无封面主色时（首帧/CORS 污染）不许崩，保持亮墨 ——
        fallback = page.evaluate("""() => {
            delete window.dominantColor;
            globalThis.__updateBrandColor();
            return getComputedStyle(document.documentElement).getPropertyValue('--titlebar-fg').trim();
        }""")
        check("no-dominant-color-safe-fallback", norm(fallback) == norm(LIGHT), fallback)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
