"""单句 / A-B 循环（todos #3）在浏览器里的真实接线。

core/abLoop.js 的边界判据在 tests/js/test_ab_loop.js 测过了；这里测的是接线：
audio.currentTime 真的被改、timeupdate 真的回头、手动拖出区间真的取消、换歌真的清掉。
用一段 1.2 秒的静音 WAV 当音源，这样 currentTime 可读写、duration 已知，
不需要联网也不依赖某首歌能不能取到链。
"""
import base64
import io
import sys
import wave
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def silent_wav_b64(seconds=20, rate=8000):
    """生成一段真正可解码、可 seek 的静音 WAV。
    ★ 别手写 base64 —— 编出来的字节流过不了音频解码器，测试会以
      「duration=NaN」这种和循环逻辑毫无关系的方式失败，非常误导。
      20 秒是为了给"拖到区间外"留出足够空间（循环区间落在 4~9 秒）。"""
    buf = io.BytesIO()
    w = wave.open(buf, 'wb')
    w.setnchannels(1)
    w.setsampwidth(1)
    w.setframerate(rate)
    w.writeframes(b'\x80' * (rate * seconds))
    w.close()
    return base64.b64encode(buf.getvalue()).decode('ascii')


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))


SETUP = """async (args) => {
    const a = document.querySelector('audio');
    window.__origAudioSrc = a.src;
    a.src = args.wav;
    await new Promise(res => {
        if (a.readyState >= 1) return res();
        a.addEventListener('loadedmetadata', () => res(), { once: true });
        setTimeout(res, 3000);
    });
    globalThis.lyrics = JSON.parse(args.lines);
    globalThis.activeLineIndex = 1;
    globalThis.currentSongData = { id: 'songA', source: 'netease', title: '甲' };
    a.currentTime = 0;
    return { duration: a.duration, ready: a.readyState };
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required",
                                                         "--mute-audio"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        # ★ 环境隔离（同 test_phone_remote.py 五道闸，2026-09-27 CI 实测）：boot 的
        #   默认曲/热歌榜异步加载链会在 harness SETUP 之后的任意时刻重写
        #   globalThis.lyrics/audio.src——CI 时序下 toggleLineLoop 读到网络真歌的
        #   行时间（startMs=4176≠4000），flaky 两连。断网后歌词只属于 harness。
        import re as _re
        context.route(_re.compile(r"/api/config/load"), lambda r: r.fulfill(
            status=200, body="{}", content_type="application/json"))
        context.route(_re.compile(r"^https?://(?!127\.0\.0\.1|localhost)"), lambda r: r.abort())
        context.route(_re.compile(r"/api/rank/"), lambda r: r.fulfill(
            status=200, body="{}", content_type="application/json"))
        context.route(_re.compile(r"/api/selfhost/"), lambda r: r.abort())
        context.route(_re.compile(r"/api/audio/stream"), lambda r: r.abort())
        context.route(_re.compile(r"/proxy"), lambda r: r.abort())
        page = context.new_page()
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2500)
        page.evaluate("() => ['ariaOobeOverlay','welcomeOverlay'].forEach(id => { const e=document.getElementById(id); if(e) e.setAttribute('style','display:none !important'); })")

        lines = ('[{"start":0,"text":"第一行"},{"start":4000,"text":"第二行"},'
                 '{"start":9000,"text":"第三行"},{"start":14000,"text":"第四行"}]')
        setup = page.evaluate(SETUP, {"wav": "data:audio/wav;base64," + silent_wav_b64(), "lines": lines})
        check("audio-seekable-for-harness", setup["ready"] >= 1 and setup["duration"] > 15, setup)

        # —— 1. 句柄与菜单入口 ——
        entry = page.evaluate("""() => ({
            handle: !!(window.Aria && Aria.abLoop),
            api: Aria.abLoop ? Object.keys(Aria.abLoop) : [],
        })""")
        check("abloop-handle-exposed", entry["handle"], entry)
        page.evaluate("document.getElementById('moreBtn').click()")
        page.wait_for_timeout(350)
        keys = page.evaluate("""() => Array.from(document.querySelectorAll('#ctxMenu .ctx-item')).map(e=>e.dataset.ctxKey)""")
        check("menu-has-loop-items", "ab-line" in keys and "ab-mark" in keys, keys)
        page.evaluate("document.getElementById('ctxMenu').classList.remove('visible')")

        # —— 2. 单句循环：状态 + 真的 seek 到行首 ——
        # ★ toggle 前把播放位置落在第二行内：主循环每帧按 currentTime 刷
        #   activeLineIndex，SETUP 里设的 1 会被 currentTime=0 刷回 0（CI 时序下必现），
        #   让「当前行」的判定与自动刷新一致才稳定。
        r = page.evaluate("""() => {
            const a = document.querySelector('audio');
            globalThis.activeLineIndex = 1;
            a.currentTime = 4.2;
            Aria.abLoop.toggleLineLoop();
            return { state: Aria.abLoop.state(), currentTimeMs: Math.round(a.currentTime * 1000) };
        }""")
        check("line-loop-activates", r["state"]["mode"] == "line", r)
        check("line-loop-range_is_current_line", r["state"]["startMs"] == 4000 and r["state"]["endMs"] == 9000, r["state"])
        check("line-loop-seeks_to_start", abs(r["currentTimeMs"] - 4000) < 120, r["currentTimeMs"])

        # —— 3. timeupdate 越过行尾 → 回头 ——
        rew = page.evaluate("""async () => {
            const a = document.querySelector('audio');
            a.pause();
            a.currentTime = 9.4;                       /* 已过 end=9.0，但在 tail skew 内 */
            a.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 120));
            return Math.round(a.currentTime * 1000);
        }""")
        check("rewinds_past_line_end", abs(rew - 4000) < 200, rew)

        far = page.evaluate("""async () => {
            const a = document.querySelector('audio');
            a.currentTime = 18.0;                      /* 远超区间：视为用户自己拖走 */
            a.dispatchEvent(new Event('seeked'));
            a.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 120));
            return { ms: Math.round(a.currentTime * 1000), mode: Aria.abLoop.state().mode };
        }""")
        check("seek-outside_cancels_loop", far["mode"] == "off", far)
        check("seek-outside_not_dragged_back", far["ms"] > 17000, far["ms"])

        # —— 4. A-B 两点标记 ——
        ab = page.evaluate("""async () => {
            const a = document.querySelector('audio');
            a.currentTime = 1.0; Aria.abLoop.markBoundary();
            const pending = Aria.abLoop.state();
            a.currentTime = 6.5; Aria.abLoop.markBoundary();
            return { pending, active: Aria.abLoop.state() };
        }""")
        check("markA_pending_recorded", ab["pending"]["pendingA"] is not None and ab["pending"]["mode"] == "off", ab["pending"])
        check("markB_activates_ab", ab["active"]["mode"] == "ab" and ab["active"]["startMs"] == 1000
              and abs(ab["active"]["endMs"] - 6500) < 200, ab["active"])

        # —— 5. 换歌必须清掉循环（旧时间戳贴新歌上 = 立刻乱窜）——
        switched = page.evaluate("""async () => {
            globalThis.currentSongData = { id: 'songB', source: 'netease', title: '乙' };
            const a = document.querySelector('audio');
            a.currentTime = 5.0;
            a.dispatchEvent(new Event('timeupdate'));
            await new Promise(r => setTimeout(r, 120));
            return Aria.abLoop.state();
        }""")
        check("song_change_clears_loop", switched["mode"] == "off", switched)

        # —— 6. 无效区间不激活（end<=start 会死循环）——
        bad = page.evaluate("""async () => {
            const a = document.querySelector('audio');
            a.currentTime = 3.0; Aria.abLoop.markBoundary();
            a.currentTime = 2.0; Aria.abLoop.markBoundary();   /* B 早于 A */
            await new Promise(r => setTimeout(r, 60));
            return Aria.abLoop.state();
        }""")
        check("invalid_range_rejected", bad["mode"] == "off", bad)
        page.evaluate("Aria.abLoop.clearAbLoop({silent:true})")

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
