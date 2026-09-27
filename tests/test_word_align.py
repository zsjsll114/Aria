# -*- coding: utf-8 -*-
"""频谱逐字对齐 E2E（行级歌词 → 音频实测逐字 + 缓存）

覆盖三件在 Node 里证不了的事：
  1. WebAudio 真能解本工程实际用到的 FLAC 并跑完整链路（services/wordAlign.js 里
     任何一处运行时错都会被 try/catch 咽掉、表现为「对齐没生效」，所以必须端到端跑）；
  2. 对齐结果不是均分——字起点要明显偏离等分点，且落进行窗口内、单调不重叠；
  3. 缓存真的命中：同一 (歌曲 × 歌词) 第二次不再解码，fromCache 为真、条数不涨。

运行前提：python server.py 已在 :8001 启动，且 local_music 下有可播的曲目。
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []


def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS" if cond else "FAIL"), name, extra)


def find_track():
    """从 local_music 里挑一个音频文件，URL 编码好给 audio.src"""
    from urllib.parse import quote
    d = os.path.join(ROOT, "local_music")
    if not os.path.isdir(d):
        return None
    for sub in sorted(os.listdir(d)):
        if sub.startswith("_temp"):
            continue
        p = os.path.join(d, sub)
        if not os.path.isdir(p):
            continue
        for f in sorted(os.listdir(p)):
            if f.lower().endswith((".flac", ".mp3", ".m4a", ".wav", ".ogg")):
                return f"/local_music/{quote(sub + '/' + f)}"
    return None


TRACK = find_track()

if not TRACK:
    """local_music/ 在 .gitignore 里，全新 clone（含 CI）没有音频可比对。
    纯算法部分由 tests/js/test_word_aligner.js 覆盖，这里只做跳过提示，不让 CI 变红。"""
    print("SKIP test_word_align: local_music 下没有音频文件，跳过端到端对齐验证"
          "（纯算法见 tests/js/test_word_aligner.js）")
    sys.exit(0)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
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

    check("track-available", True, TRACK)

    # —— 1. 解码链路可用（直接问服务，绕开 4s 延迟，先确认真能解）——
    dec = page.evaluate("""async (url) => {
        const m = await import('/src/services/wordAlign.js');
        const env = await m.decodeOnsetEnvelope(url);
        return env ? { frames: env.values.length, hopMs: env.hopMs,
                       max: Math.max(...Array.from(env.values).slice(0, 4000)) } : null;
    }""", TRACK)
    check("flac-decodes-to-envelope", dec is not None and dec["frames"] > 1000, str(dec))

    # —— 2. 端到端：行级歌词 → 真实逐字 ——
    res = page.evaluate("""async (url) => {
        const m = await import('/src/services/wordAlign.js');
        const wt = await import('/src/parsers/wordTiming.js');
        const lines = [
            { start: 1000,  end: 6000,  text: '第一行歌词内容', original: '第一行歌词内容' },
            { start: 6000,  end: 11000, text: '第二行歌词内容', original: '第二行歌词内容' },
            { start: 11000, end: 16000, text: 'third line here', original: 'third line here' },
        ];
        const flat = wt.ensureWordTiming(lines, { totalMs: 200000 });
        const song = { source: 'local', url: url, title: 'align-e2e', artist: 'test' };
        const r = await m.alignLyrics({ lines: flat, audioUrl: url, song });
        if (!r) return { null: true };
        const row = (i) => {
            const l = r.lines[i];
            const w = l.words || [];
            const dur = l.end - l.start;
            const even = w.map((_, k) => Math.round(l.start + dur * (k / w.length)));
            const dev = w.length ? Math.max(...w.map((x, k) => Math.abs(x.start - even[k]))) : 0;
            return { n: w.length, dev,
                     first: w[0] ? w[0].start : null,
                     last: w.length ? w[w.length - 1].end : null,
                     mark: l.wordTiming === undefined ? 'real' : 'syn',
                     monotonic: w.every((x, k) => k === 0 || (x.start >= w[k-1].end && x.end > x.start)) };
        };
        return { aligned: r.aligned, fromCache: r.fromCache,
                 rows: [row(0), row(1), row(2)] };
    }""", TRACK)

    if res.get("null"):
        check("align-ran", False, "alignLyrics 返回 null（解码失败或无需对齐）")
    else:
        check("align-ran", True, f"aligned={res['aligned']} fromCache={res['fromCache']}")
        check("align-produced-words", all(r["n"] > 0 for r in res["rows"]), str(res["rows"]))
        # 只看偏离量：mark 现在恒为 syn（对齐结果不许冒充真值），dev 才说明有没有动起来
        check("align-not-even-split",
              sum(1 for r in res["rows"] if r["dev"] > 60) >= 1,
              f"偏差={[r['dev'] for r in res['rows']]}（全为 0 说明音频没给出信息）")
        check("align-monotonic-and-in-window",
              all(r["monotonic"] for r in res["rows"])
              and res["rows"][0]["first"] >= 1000 and res["rows"][0]["last"] <= 6000,
              str(res["rows"][0]))
        # 对齐结果必须仍标 synthesized：实测对拍真值平均误差 547ms、±100ms 命中 36%，
        # 清掉标记会让 547ms 级误差被写进用户下载的 .lrc、并被当节奏喂给 AI 打权重
        check("aligned-results-stay-marked-synthetic",
              all(r["mark"] == "syn" for r in res["rows"]), str([r["mark"] for r in res["rows"]]))
        # 但渲染侧仍拿到逐字 words（观感目标达成），且不是均分
        check("aligned-words-still-reach-renderer",
              all(r["n"] > 1 for r in res["rows"]), str([r["n"] for r in res["rows"]]))

        # —— 3. 缓存：同键第二次应命中，不再解码 ——
        cache = page.evaluate("""async (url) => {
            const m = await import('/src/services/wordAlign.js');
            const wt = await import('/src/parsers/wordTiming.js');
            const ac = await import('/src/services/aiCache.js');
            const lines = [
                { start: 1000,  end: 6000,  text: '第一行歌词内容', original: '第一行歌词内容' },
                { start: 6000,  end: 11000, text: '第二行歌词内容', original: '第二行歌词内容' },
                { start: 11000, end: 16000, text: 'third line here', original: 'third line here' },
            ];
            const song = { source: 'local', url: url, title: 'align-e2e', artist: 'test' };
            const before = await ac.wordTimingCacheCount();
            const flat = wt.ensureWordTiming(lines, { totalMs: 200000 });
            const r2 = await m.alignLyrics({ lines: flat, audioUrl: url, song });
            const after = await ac.wordTimingCacheCount();
            /* 换一份歌词（文本不同）→ 键不同 → 不该复用上一条的对齐结果 */
            const other = wt.ensureWordTiming(
                [{ start: 1000, end: 6000, text: '完全不同的一句词', original: '完全不同的一句词' },
                 { start: 6000, end: 11000, text: '再来一句', original: '再来一句' },
                 { start: 11000, end: 16000, text: 'and another', original: 'and another' }],
                { totalMs: 200000 });
            const kSame = m.wordAlignKey(song, lines);
            const kOther = m.wordAlignKey(song, other);
            return { before, after, fromCache: r2 && r2.fromCache,
                     keyDiffers: kSame !== kOther };
        }""", TRACK)
        check("cache-hit-on-second-run", cache.get("fromCache") is True, str(cache))
        check("cache-does-not-grow", cache.get("before") == cache.get("after"), str(cache))
        check("cache-key-includes-lyric-signature", cache.get("keyDiffers") is True, str(cache))

    # —— 4. 真实 UI 路径：renderLyrics 自己触发对齐并重渲染，且不会死循环 ——
    ui = page.evaluate("""async (url) => {
        const m = await import('/src/app/20-lyrics-render.js');
        const audio = document.getElementById('audioPlayer');
        /* 默认关闭（精度不足以冒充真值），这里显式打开以验证开关本身生效 */
        window.appSettings.interface.wordAlign = true;
        window.currentSongData = { source: 'local', url: url, title: 'align-ui', artist: 'test' };
        audio.src = url;
        await new Promise((res) => {
            if (audio.currentSrc) return res();
            audio.addEventListener('loadedmetadata', () => res(), { once: true });
            setTimeout(res, 8000);
        });
        const lines = [];
        for (let i = 0; i < 8; i++) {
            const t = 1000 + i * 4000;
            lines.push({ start: t, end: t + 4000, text: '第' + (i + 1) + '行测试歌词', original: '第' + (i + 1) + '行测试歌词' });
        }
        /* 数 renderLyrics 被重入的次数：对齐成功只应多渲染一次，多了就是死循环 */
        let renders = 0;
        const obs = new MutationObserver(() => { renders++; });
        obs.observe(document.getElementById('lyricsScroll'), { childList: true, subtree: true });
        m.renderLyrics(lines);
        const before = (window.Aria.__ariaLyrics[0].words || []).map(w => w.start).join(',');
        /* 轮询到「对齐落地」为止——固定 sleep 会在解码没跑完时误判 */
        const t0 = Date.now();
        let mark = 'syn';
        while (Date.now() - t0 < 60000) {
            await new Promise(r => setTimeout(r, 1000));
            const l0 = window.Aria.__ariaLyrics[0];
            /* 落地判据：applyAlignment 会写诊断量 wordAlignDeviationMs；
               标记仍是 synthesized（对齐结果不许冒充真实逐字） */
            if (l0 && typeof l0.wordAlignDeviationMs === 'number') { mark = 'aligned'; break; }
        }
        const l0 = window.Aria.__ariaLyrics[0];
        const after = (l0.words || []).map(w => w.start).join(',');
        await new Promise(r => setTimeout(r, 1500));
        obs.disconnect();
        return {
            currentSrc: !!audio.currentSrc,
            changed: before !== after,
            secs: Math.round((Date.now() - t0) / 1000),
            mark,
            lineWords: document.querySelectorAll('#lyricsScroll .word[data-index=\\"0\\"]').length,
            line0Exists: !!document.querySelector('#lyricsScroll .line[data-index=\\"0\\"]'),
            renders,
        };
    }""", TRACK)
    check("ui-path-current-src-ready", ui.get("currentSrc") is True, str(ui.get("currentSrc")))
    # changed 不能当判据：line 0 若 DP 找不到可用 onset 会退化回均分，起点自然不变。
    # 落地与否看 wordAlignDeviationMs（applyAlignment 专属字段）。
    check("ui-path-auto-aligned", ui.get("mark") == "aligned", str(ui))
    check("ui-path-words-in-dom", ui.get("lineWords", 0) >= 7,
          f"lineWords={ui.get('lineWords')} line0={ui.get('line0Exists')}")
    check("ui-path-no-render-loop", ui.get("renders", 99) <= 8,
          f"renders={ui.get('renders')}（对齐成功只该多渲染一次）")

    check("no-page-errors", len(console_errors) == 0, "; ".join(console_errors[:3]))

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print("\n==============================================")
print(f"TOTAL: {len(results)}  PASS: {passed}  FAIL: {len(results) - passed}")
sys.exit(0 if passed == len(results) else 1)
