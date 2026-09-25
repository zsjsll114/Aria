# -*- coding: utf-8 -*-
"""逐字兜底回归（只有行级时间戳的歌词也要逐字推进）

背景：renderLyrics 只在 line.words 存在时才建 .word/.word-highlight 层
（app/20-lyrics-render.js 的 buildWordsInto 分支），行级 LRC 没有 words，
于是整行一跳。web/src/parsers/wordTiming.js 早已能按行时长摊平合成逐字，
但只接了 NPS 接管那一条路径（232-nowplaying-follow.js），常规加载全绕过。

本测试盯三件事：
  1. 行级歌词经 renderLyrics 后，DOM 里真的出现了逐字层，且时间是绝对 ms、单调不重叠；
  2. 平台给的**真实逐字**不被覆盖（引用原样、不带合成标记）；
  3. 合成行带 wordTiming='synthesized' 标记——下游拿 line.words.length 判真值的
     地方（下载/标签/选源）靠它区分，否则假时间戳会被当真货卖出去。

手法：无打包 ESM 应用，页面里 dynamic import 拿到的就是已加载的同一模块实例，
所以直接调 renderLyrics，不必伪造整首歌加载链。
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
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
            timeout=25000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:120])
    page.wait_for_timeout(1200)

    # 不点任何按钮：欢迎浮层/OOBE 会拦指针，而本测试全部经模块直接调 renderLyrics。

    # —— 1. 行级歌词 → 逐字层 ——
    line_only = page.evaluate("""async () => {
        const m = await import('/src/app/20-lyrics-render.js');
        const lines = [
            { start: 0,    end: 2000, text: '第一行字', original: '第一行字' },
            { start: 2000, end: 4000, text: '第二行字', original: '第二行字' },
            { start: 4000, end: 6000, text: 'third line here', original: 'third line here' },
        ];
        m.renderLyrics(lines);
        const first = document.querySelector('#lyricsScroll .line');
        const words = first ? first.querySelectorAll('.word') : [];
        const stamps = Array.from(words).map(w => ({
            s: Number(w.dataset.start), e: Number(w.dataset.end), t: w.dataset.text || w.textContent
        }));
        return {
            globalWords: (window.Aria && Aria.__ariaLyrics && Aria.__ariaLyrics[0] && Aria.__ariaLyrics[0].words)
                ? Aria.__ariaLyrics[0].words.length : 0,
            mark: (window.Aria && Aria.__ariaLyrics && Aria.__ariaLyrics[0]) ? Aria.__ariaLyrics[0].wordTiming : null,
            containers: first ? first.querySelectorAll('.words-container').length : 0,
            wordCount: words.length,
            stamps,
        };
    }""")
    check("line-only-gets-words-container", line_only["containers"] >= 1, str(line_only["containers"]))
    check("line-only-gets-word-nodes", line_only["wordCount"] >= 4,
          f"words={line_only['wordCount']}（4 个汉字应各成一个 .word）")
    check("synthesized-words-reach-global", line_only["globalWords"] >= 4, str(line_only["globalWords"]))
    check("synthesized-line-marked", line_only["mark"] == "synthesized", f"wordTiming={line_only['mark']}")

    st = line_only["stamps"]
    monotonic = all(st[i]["e"] > st[i]["s"] for i in range(len(st))) and \
        all(st[i]["s"] >= st[i - 1]["e"] for i in range(1, len(st)))
    check("word-stamps-monotonic-nonempty", monotonic and len(st) > 0, str(st[:5]))
    covers_line = len(st) > 0 and st[0]["s"] == 0 and st[-1]["e"] <= 6000
    check("word-stamps-inside-line-range", covers_line, str(st[:2]) + "..." + str(st[-2:]))

    # —— 2. 真实逐字不被覆盖 ——
    real_kept = page.evaluate("""async () => {
        const m = await import('/src/app/20-lyrics-render.js');
        const real = [
            { start: 0, end: 1000, text: '你好', original: '你好',
              words: [{ text: '你', start: 0, end: 120 }, { text: '好', start: 120, end: 900 }] },
            { start: 2000, end: 3000, text: '世界', original: '世界',
              words: [{ text: '世', start: 2000, end: 2100 }, { text: '界', start: 2100, end: 2900 }] },
        ];
        m.renderLyrics(real);
        const g = window.Aria.__ariaLyrics;
        return {
            firstWordEnd: g[0].words[1].end,
            mark: g[0].wordTiming === undefined ? 'none' : String(g[0].wordTiming),
            wordNodes: document.querySelectorAll('#lyricsScroll .line')[0].querySelectorAll('.word').length,
        };
    }""")
    check("real-word-timing-not-overwritten", real_kept["firstWordEnd"] == 900, str(real_kept))
    check("real-line-unmarked", real_kept["mark"] == "none", real_kept["mark"])
    check("real-words-still-render", real_kept["wordNodes"] >= 2, str(real_kept["wordNodes"]))

    # —— 3. 混合：只给缺 words 的那些行补，不碰有的 ——
    mixed = page.evaluate("""async () => {
        const m = await import('/src/app/20-lyrics-render.js');
        m.renderLyrics([
            { start: 0, end: 1000, text: '甲乙', original: '甲乙',
              words: [{ text: '甲', start: 0, end: 111 }, { text: '乙', start: 111, end: 999 }] },
            { start: 1000, end: 2000, text: '丙丁', original: '丙丁' },
        ]);
        return window.Aria.__ariaLyrics.map(l => ({
            marks: l.wordTiming === undefined ? 'real' : 'syn',
            first: (l.words && l.words[0]) ? l.words[0].end : null
        }));
    }""")
    check("mixed-first-line-stays-real", mixed[0]["marks"] == "real" and mixed[0]["first"] == 111, str(mixed[0]))
    check("mixed-second-line-synthesized", mixed[1]["marks"] == "syn", str(mixed[1]))

    # —— 4. 下载歌词不得把合成的假节拍当平台精确逐字写进文件 ——
    # _krcText 的数据源就是 Aria.__ariaLyrics（90-eq.js:460），正是被合成过的那份。
    dl = page.evaluate("""async () => {
        const m = await import('/src/app/20-lyrics-render.js');
        const e = await import('/src/app/90-eq.js');
        m.renderLyrics([
            { start: 0,    end: 2000, text: '甲乙丙', original: '甲乙丙' },
            { start: 2000, end: 4000, text: '丁戊己', original: '丁戊己' },
        ]);
        const synthesizedText = e._krcText(window.Aria.__ariaLyrics);

        m.renderLyrics([
            { start: 0, end: 2000, text: '甲乙', original: '甲乙',
              words: [{ text: '甲', start: 0, end: 700 }, { text: '乙', start: 700, end: 1800 }] },
            { start: 2000, end: 4000, text: '丁戊', original: '丁戊',
              words: [{ text: '丁', start: 2000, end: 2600 }, { text: '戊', start: 2600, end: 3800 }] },
        ]);
        const realText = e._krcText(window.Aria.__ariaLyrics);
        const stamps = (s) => (s.match(/<\\d+,\\d+,\\d+>/g) || []).length;
        return { synStamps: stamps(synthesizedText), realStamps: stamps(realText),
                 synSample: synthesizedText.split('\\n')[0] };
    }""")
    # 合成行应退回「整行一个 <0,dur,0>」的行级形状；两行 = 2 个戳，而不是 6 个假字戳
    check("download-drops-synthetic-stamps", dl["synStamps"] == 2, str(dl))
    check("download-keeps-real-stamps", dl["realStamps"] >= 4, str(dl["realStamps"]))

    # —— 5. 桌面歌词窗口：拿到合成 words 后应出现逐字 fill（否则整行一跳）——
    # 250-desktop-lyrics.js 只在 cur.words 非空时才往 payload 里放 words1，
    # lyrics.html 的 buildLineRow 又只在有 words 时才生成 .fill 层。
    dtk = page.evaluate("""async () => {
        const wt = await import('/src/parsers/wordTiming.js');
        const syn = wt.ensureWordTiming([
            { start: 0, end: 2000, text: '甲乙丙丁', original: '甲乙丙丁' },
            { start: 2000, end: 4000, text: '戊己', original: '戊己' },
        ]);
        return JSON.stringify({
            line: 0, l1: '甲乙丙丁', words1: syn[0].words, l2: '戊己', words2: syn[1].words,
            trans1: '', curStart: 0, nextStart: 2000, playing: true, tms: 900
        });
    }""")
    dpage = browser.new_page(viewport={"width": 600, "height": 200})
    dpage.goto("http://localhost:8001/lyrics.html", wait_until="domcontentloaded", timeout=30000)
    dpage.evaluate("""(payload) => {
        localStorage.setItem('aria_dtk_state', payload);
        localStorage.setItem('aria_dtk_meta', String(Date.now()));
    }""", dtk)
    dpage.reload(wait_until="domcontentloaded")
    dpage.wait_for_timeout(1500)
    dtk_dom = dpage.evaluate("""() => ({
        words: document.querySelectorAll('.word').length,
        fills: document.querySelectorAll('.fill').length,
        text: (document.querySelector('#tLine1') || {}).textContent || document.body.innerText.slice(0, 40)
    })""")
    dpage.close()
    check("dtk-window-gets-per-word-fills", dtk_dom["fills"] >= 4,
          f"words={dtk_dom['words']} fills={dtk_dom['fills']}")

    check("no-page-errors", len(console_errors) == 0, "; ".join(console_errors[:3]))

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print("\n==============================================")
print(f"TOTAL: {len(results)}  PASS: {passed}  FAIL: {len(results) - passed}")
sys.exit(0 if passed == len(results) else 1)
