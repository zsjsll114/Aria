"""Automix 全链路真浏览器 E2E（Automix-技术方案.md Phase 2 验收）。

core 层的状态机/决策/分析在 tests/js/test_automix_*.js 测过了；这里测的是
**真浏览器接线**：真实 OfflineAudioContext 解码分析 → ARM 窗口判定 → 影子 deck
预载 → canplay 推进 CROSSING → GainNode/volume 交叉跑完 → swapRoles 后
30 个分片的 live binding 真的跟随、元数据真的同步。

音源用两段 120 BPM 节拍调制正弦 WAV 的 data: URL（走 getStreamCachedAudioUrl
原样放行），playlist 两首无 source/id 的本地轨 → 决策 beatmatch、rate=1、
重叠 6s。不联网，全程在 page 内跑完。
"""
import base64
import io
import math
import sys
import wave
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8001/index.html"
RESULTS = []


def beated_wav_b64(seconds=30, rate=8000, fade_tail_s=0.0):
    """120 BPM 节拍感 WAV：2Hz 幅度调制 440Hz 载波（test_automix_envelope.js
    同款 fixture 形态，自相关收敛 120 BPM）。fade_tail_s>0 时结尾线性淡出，
    让 findOutroPoints 能找到 outroPoint（决策 'none' 的前置否决就是它）。"""
    n = rate * seconds
    buf = io.BytesIO()
    w = wave.open(buf, 'wb')
    w.setnchannels(1)
    w.setsampwidth(1)
    w.setframerate(rate)
    frames = bytearray()
    for i in range(n):
        t = i / rate
        m = 0.5 + 0.45 * math.sin(2 * math.pi * 2.0 * t)      # 2Hz 拍 = 120 BPM
        s = 100.0 * m * math.sin(2 * math.pi * 440.0 * t)
        if fade_tail_s > 0 and t > seconds - fade_tail_s:
            s *= max(0.0, (seconds - t) / fade_tail_s)
        frames.append(int(128 + max(-127, min(127, s))))
    w.writeframes(bytes(frames))
    w.close()
    return base64.b64encode(buf.getvalue()).decode('ascii')


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:300] if detail else ""))


SETUP = """async (args) => {
    appSettings.playback.automix = { enabled: true };
    globalThis.playlist = [
        { title: '甲', url: args.wavA },
        { title: '乙', url: args.wavB },
    ];
    globalThis.currentTrackIndex = 0;
    globalThis.playMode = 'sequence';

    const a = document.querySelector('audio');
    a.src = args.wavA;
    await new Promise(res => {
        if (a.readyState >= 1) return res();
        a.addEventListener('loadedmetadata', () => res(), { once: true });
        setTimeout(res, 6000);
    });
    a.volume = 0.8;
    await a.play();          /* 真 play 事件 → 96 → notifyTrackStarted → 后台分析 A */
    return { duration: a.duration, ready: a.readyState };
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required",
                                                         "--mute-audio", "--no-sandbox",
                                                         "--proxy-server=direct://",
                                                         "--proxy-bypass-list=*"])
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        # ★ 环境隔离（同 test_ab_loop_ui.py 五道闸）：断网 + 掐掉后端全部业务路由，
        #   boot 的默认曲/热歌榜异步链不得重写 harness 的 playlist 或抢走 audio.src
        #   （loadOnlineSong 无条件 pause+removeAttribute('src')，预载晚到会毁掉
        #   进行中的交叉——全屏蔽后取链瞬时失败，不再触碰播放元素）。
        import re as _re
        context.route(_re.compile(r"^http://127\.0\.0\.1:8001/api/"), lambda r: r.abort())
        context.route(_re.compile(r"^https?://(?!127\.0\.0\.1|localhost)"), lambda r: r.abort())
        page = context.new_page()
        CONSOLE = []
        page.on("console", lambda m: CONSOLE.append(m.text))
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2500)
        page.evaluate("() => ['ariaOobeOverlay','welcomeOverlay'].forEach(id => { const e=document.getElementById(id); if(e) e.setAttribute('style','display:none !important'); })")

        wav_a = "data:audio/wav;base64," + beated_wav_b64(seconds=30, fade_tail_s=2.0)
        wav_b = "data:audio/wav;base64," + beated_wav_b64(seconds=20, fade_tail_s=2.0)

        setup = page.evaluate(SETUP, {"wavA": wav_a, "wavB": wav_b})
        check("audio-loaded", setup["ready"] >= 1 and abs(setup["duration"] - 30.0) < 0.5, setup)

        # 模块句柄（同 URL 动态 import = 与分片共享同一实例）
        page.evaluate("""async () => {
            globalThis.__am = {
                sched: await import('/src/core/automix/scheduler.js'),
                cf: await import('/src/core/automix/crossfader.js'),
                dd: await import('/src/core/dualDeck.js'),
            };
        }""")

        # —— 1. A 的后台分析真的跑了（play 事件 → notifyTrackStarted → memo 命中）——
        page.wait_for_timeout(2500)
        an = page.evaluate("""async () => {
            const { sched, dd } = globalThis.__am;
            const a = dd.getActiveAudio();
            return await sched.ensureAnalyzed(globalThis.playlist[0], a.src);
        }""")
        check("analysis-A-done", an is not None and an.get("bpm") is not None
              and an.get("bpmConfidence", 0) >= 1.5 and an.get("outroPointMs", 0) > 0, an)

        # —— 2. seek 进 ARM 窗（剩 7.5s < armLead 8.5s）→ timeupdate 触发 ARM ——
        arm = page.evaluate("""async () => {
            const { cf, dd } = globalThis.__am;
            const a = dd.getActiveAudio();
            a.currentTime = a.duration - 7.5;
            a.dispatchEvent(new Event('timeupdate'));
            /* _armAndGo 异步：决策+分析 B+预载+canplay 探针，轮询到 CROSSING */
            for (let i = 0; i < 80; i++) {
                const ph = cf.crossfaderPhase();
                if (ph === cf.CROSSFADER_CROSSING || ph === cf.CROSSFADER_IDLE && i > 20) return { phase: ph, i };
                await new Promise(r => setTimeout(r, 100));
            }
            return { phase: cf.crossfaderPhase(), i: 80 };
        }""")
        check("crossing-started", arm["phase"] == "CROSSING", arm)

        # ARM 期捕获影子元素句柄（swap 后它变成 active）
        page.evaluate("""() => { globalThis.__bEl = globalThis.__am.dd.getShadowAudio(); }""")

        # —— 3. 交叉中：B 真的在播（音量爬坡不管哪条路径，B 起播是共同的）——
        mid = page.evaluate("""async () => {
            const b = globalThis.__bEl;
            await new Promise(r => setTimeout(r, 800));
            return { bPlaying: !b.paused, bTime: b.currentTime, phase: globalThis.__am.cf.crossfaderPhase() };
        }""")
        check("b-started-during-crossing", mid["bPlaying"] and mid["bTime"] > 0.3, mid)
        check("phase-still-crossing", mid["phase"] == "CROSSING", mid)

        # —— 4. 等交叉完成（重叠 6s + 余量）→ swap 已发生 ——
        done = page.evaluate("""async () => {
            const { cf, dd } = globalThis.__am;
            for (let i = 0; i < 300; i++) {
                if (cf.crossfaderPhase() === 'IDLE') {
                    const b = globalThis.__bEl;
                    return {
                        phase: 'IDLE', swapped: dd.getActiveAudio() === b,
                        globalAudioIsB: globalThis.audio === b,
                        bTime: b.currentTime,
                        i,
                    };
                }
                await new Promise(r => setTimeout(r, 100));
            }
            return { phase: cf.crossfaderPhase(), swapped: false };
        }""")
        check("crossing-completed", done["phase"] == "IDLE" and done["i"] < 290, done)
        check("active-deck-is-old-shadow", done["swapped"], done)
        check("live-binding-follows", done["globalAudioIsB"], done)
        check("b-keeps-playing", done["bTime"] > 3.0, done)

        # —— 5. 元数据同步：标题/索引/进度条总时长 ——
        meta = page.evaluate("""() => ({
            title: (document.getElementById('songTitle') || {}).textContent,
            idx: globalThis.currentTrackIndex,
            song: globalThis.currentSongData ? globalThis.currentSongData.title : null,
        })""")
        check("meta-title-updated", meta["title"] == "乙", meta)
        check("meta-index-updated", meta["idx"] == 1, meta)
        check("meta-songdata-updated", meta["song"] == "乙", meta)

        # —— 6. B 起播后自身进入分析管线（为再下一轮备料）+ 监听跟随 B ——
        page.wait_for_timeout(1500)
        an2 = page.evaluate("""async () => {
            const { sched, dd } = globalThis.__am;
            const b = dd.getActiveAudio();
            return await sched.ensureAnalyzed(globalThis.playlist[1], b.src);
        }""")
        check("analysis-B-done-after-swap", an2 is not None and an2.get("bpm") is not None, an2)

        # —— 7. 旧 A 收尾：暂停 + 归零（_completeSwap 语义）——
        old = page.evaluate("""() => {
            const a = document.getElementById('audioPlayer');
            return { paused: a.paused, t: a.currentTime };
        }""")
        check("old-deck-settled", old["paused"] and old["t"] == 0, old)

        print("\n---- console (automix/crossfader/engine) ----")
        for line in CONSOLE:
            if any(k in line for k in ('automix', 'crossfader', 'audioEngine', 'PROBE')):
                print(line)

        try:
            browser.close()
        except Exception:
            pass

    failed = [r for r in RESULTS if not r[1]]
    print("\n---- console (automix/crossfader/engine/probe) ----")
    for line in CONSOLE:
        if any(k in line for k in ('automix', 'crossfader', 'audioEngine', 'PROBE')):
            print(line)
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
