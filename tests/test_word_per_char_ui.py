"""逐字展示开关 + 跨音源真逐字替换（todos #12）在浏览器里的真实行为。

纯函数层在 tests/js/test_word_per_char.js；这里验的是接线：
  · 两个开关在设置页里存在、默认值正确、能持久化；
  · 开关联动（开 2 必须把 1 也关掉，界面和 appSettings 同时变）；
  · 开关真的改变 DOM —— 摊平开时有 .word/fill，关掉就是整行一个文本节点；
  · 模式限定真的生效 —— PV 模式下即使开关1 开着也不摊平。
最后一条最容易做错：判定读的是 currentViewMode，而 .player-container 的类名
才是它的真相；只测 cover 模式等于没测。
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []

LINE_LEVEL = """[
  { "start": 0,     "text": "第一行歌词内容" },
  { "start": 4000,  "text": "第二行歌词内容比较长一点" },
  { "start": 9000,  "text": "第三行歌词" },
  { "start": 14000, "text": "第四行 收尾" },
  { "start": 19000, "text": "第五行歌词凑足行数下限" }
]"""


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


def restore_defaults(page):
    """★ 无论测试成败都要把两个键钉回出厂值。
       这个 E2E 写的是**真实** user_config.json（8001 同源共享），
       上一版只在末尾正常路径恢复，变异实验中途失败就把
       perCharFromLineLyrics:false / autoUpgradeWordLyrics:true 留在了盘上，
       连带把 test_word_fallback / test_word_align 打挂 7 条。"""
    try:
        page.evaluate("""async () => {
            const m = await import('/src/app/180-boot-config.js');
            appSettings.lyrics.perCharFromLineLyrics = true;
            appSettings.lyrics.autoUpgradeWordLyrics = false;
            m.saveSettings();
            await m.syncConfigToBackend();
        }""")
        page.wait_for_timeout(600)
    except Exception as e:
        print("  WARN 恢复默认设置失败（会污染 user_config.json）:", e)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        # ★ 没有这一条，收尾时任何一次 evaluate 卡住就把整份脚本挂死（实测汇总行都打不出来）
        page.set_default_timeout(20000)
        try:
            page.goto(URL, wait_until="load")
            try:
                page.wait_for_function(
                    "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
                    timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(2500)
            # ★ 先把两个键钉回出厂值再断言"默认值"：设置会存进后端 user_config.json，
            #   上一轮运行（或另一个 8001 客户端）留下的值会漏进来。
            #   必须"钉值 → 重新加载"：开关的 .on 类是在页面初始化时按 appSettings 绑的，
            #   加载后再改 appSettings 不会回头同步 DOM，测试就会读到类与状态不一致的假红。
            page.evaluate("""async () => {
                const m = await import('/src/app/180-boot-config.js');
                appSettings.lyrics.perCharFromLineLyrics = true;
                appSettings.lyrics.autoUpgradeWordLyrics = false;
                m.saveSettings();
                await m.syncConfigToBackend();
            }""")
            page.wait_for_timeout(150)
            page.reload(wait_until="load")
            try:
                page.wait_for_function("() => window.appSettings && appSettings.lyrics", timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(2500)
            page.evaluate("""() => {
                ['ariaOobeOverlay','welcomeOverlay'].forEach(id => { const e = document.getElementById(id); if (e) e.setAttribute('style','display:none !important'); });
            }""")

            # —— 1. 两个开关存在 + 默认值 ——
            page.evaluate("document.getElementById('openSettingsBtn').click()")
            page.wait_for_timeout(400)
            page.evaluate("""() => { const t=document.querySelector('#settingsTabs [data-tab="interface"]'); if(t) t.click(); }""")
            page.wait_for_timeout(500)
            ui = page.evaluate("""() => {
                const q = id => document.getElementById(id);
                const a = q('setPerCharFromLineLyrics'), b = q('setAutoUpgradeWordLyrics');
                return {
                    perCharExists: !!a, upgradeExists: !!b,
                    perCharOn: !!a && a.classList.contains('on'),
                    upgradeOn: !!b && b.classList.contains('on'),
                    perCharVisible: !!a && a.getBoundingClientRect().height > 0,
                    state: { pc: !!(window.appSettings && appSettings.lyrics.perCharFromLineLyrics),
                             up: !!(window.appSettings && appSettings.lyrics.autoUpgradeWordLyrics) },
                };
            }""")
            check("both-toggles-exist", ui["perCharExists"] and ui["upgradeExists"], ui)
            check("toggles-visible-in-interface-tab", ui["perCharVisible"], ui["perCharVisible"])
            check("default_perChar_on_upgrade_off",
                  ui["perCharOn"] is True and ui["upgradeOn"] is False, ui)
            check("ui-matches-appSettings",
                  ui["perCharOn"] == ui["state"]["pc"] and ui["upgradeOn"] == ui["state"]["up"], ui)

            # —— 2. 行为：开关1 开 → 行级歌词被摊平成 .word + fill ——
            def render_probe(mode):
                return page.evaluate("""async (args) => {
                    const m = await import('/src/app/20-lyrics-render.js');
                    const pc = document.querySelector('.player-container');
                    pc.className = 'player-container view-' + args.mode;
                    window.currentViewMode = args.mode;
                    globalThis.lyrics = JSON.parse(args.lines);
                    m.renderLyrics(globalThis.lyrics);
                    await new Promise(r => setTimeout(r, 120));
                    const words = document.querySelectorAll('#lyricsScroll .word');
                    return {
                        wordCount: words.length,
                        fills: document.querySelectorAll('#lyricsScroll .word .fill, #lyricsScroll .word > .fill').length,
                        lineCount: document.querySelectorAll('#lyricsScroll .line, #lyricsScroll .lyric-line').length,
                        synthesized: (globalThis.lyrics || []).filter(l => l.wordTiming === 'synthesized').length,
                    };
                }""", {"mode": mode, "lines": LINE_LEVEL})

            on_cover = render_probe("cover")
            check("perChar_on_creates_words_cover", on_cover["wordCount"] > 0 and on_cover["synthesized"] > 0, on_cover)

            # —— 3. 关掉开关1 → 不摊平（整行一跳）——
            page.evaluate("document.getElementById('setPerCharFromLineLyrics').click()")
            page.wait_for_timeout(300)
            off_state = page.evaluate("() => ({ pc: appSettings.lyrics.perCharFromLineLyrics, on: document.getElementById('setPerCharFromLineLyrics').classList.contains('on') })")
            check("toggle1_off_updates_state", off_state["pc"] is False and off_state["on"] is False, off_state)
            off_cover = render_probe("cover")
            check("perChar_off_no_synthesis", off_cover["synthesized"] == 0 and off_cover["wordCount"] == 0, off_cover)

            # —— 3b. ★ 不重新播种：开关必须**当场**改变已经渲染出来的那份歌词 ——
            # 上面 render_probe 每次都重新塞一份行级歌词，所以它永远测不到这个真 bug：
            # renderLyrics 会把合成的 words 写回 globalThis.lyrics（约束 17 的同一份数组），
            # 于是「关掉后再渲染一次」数据里仍然全是逐字——用户看到的就是
            # 「开关点了没反应，得切一首歌才变」。必须用当前这份已被改过的数组测。
            live = page.evaluate("""async (linesJson) => {
                const r = await import('/src/app/20-lyrics-render.js');
                const el = document.getElementById('setPerCharFromLineLyrics');
                const snap = () => ({
                    want: !!appSettings.lyrics.perCharFromLineLyrics,
                    wordCount: document.querySelectorAll('#lyricsScroll .word').length,
                    synthesized: (globalThis.lyrics || []).filter(l => l.wordTiming === 'synthesized').length,
                    lines: (globalThis.lyrics || []).length,
                });
                const tick = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
                /* ★ 播种、点开关、量 DOM 全在同一个脚本里跑完：应用会异步恢复上次播放并
                   覆盖 globalThis.lyrics（AGENTS 约束 25⑤），分多次 evaluate 就会读到
                   别人家的歌词（实测读到 36 行 / 274 个 .word）。
                   ★ 不假设起始状态、也不直接改 appSettings：bindToggle 以按钮 class 为准，
                   只改设置会让 class 与设置差一拍（第一版就是这么假失败的）。
                   所以连续点 3 次，逐次记录「设置值 ↔ DOM 形态」，断言两者的对应关系。 */
                appSettings.lyrics.autoUpgradeWordLyrics = false;
                globalThis.lyrics = JSON.parse(linesJson);
                el.classList.add('on');
                appSettings.lyrics.perCharFromLineLyrics = true;
                r.renderLyrics(globalThis.lyrics);
                await tick();
                const seq = [snap()];
                for (let i = 0; i < 3; i++) { el.click(); await tick(); seq.push(snap()); }
                if (appSettings.lyrics.perCharFromLineLyrics) { el.click(); await tick(); }
                return { seq, endsOff: !appSettings.lyrics.perCharFromLineLyrics };
            }""", LINE_LEVEL)
            seq = live["seq"]
            on_states = [x for x in seq if x["want"]]
            off_states = [x for x in seq if not x["want"]]
            check("toggle_state_matches_dom_both_ways",
                  bool(on_states) and bool(off_states)
                  and all(x["wordCount"] > 0 and x["synthesized"] > 0 for x in on_states)
                  and all(x["wordCount"] == 0 and x["synthesized"] == 0 for x in off_states),
                  seq)
            check("toggle_off_clears_words_immediately",
                  bool(off_states) and all(x["wordCount"] == 0 for x in off_states),
                  [x for x in seq if not x["want"]])

            # —— 4. 模式限定：重新打开开关1，PV 模式下仍不摊平 ——
            page.evaluate("document.getElementById('setPerCharFromLineLyrics').click()")
            page.wait_for_timeout(250)
            on_pv = render_probe("pv")
            check("pv_mode_not_synthesized", on_pv["synthesized"] == 0, on_pv)
            on_wc = render_probe("wordcloud")
            check("wordcloud_mode_synthesized", on_wc["synthesized"] > 0, on_wc)
            page.evaluate("""(lines) => {
                window.currentViewMode = 'cover';
                document.querySelector('.player-container').className = 'player-container view-cover';
            }""", LINE_LEVEL)

            # —— 5. 联动：开开关2 必须把开关1 一起关掉（界面 + appSettings）——
            link = page.evaluate("""() => {
                const up = document.getElementById('setAutoUpgradeWordLyrics');
                const pc = document.getElementById('setPerCharFromLineLyrics');
                up.click();
                return {
                    upOn: up.classList.contains('on'),
                    pcOn: pc.classList.contains('on'),
                    stateUp: !!appSettings.lyrics.autoUpgradeWordLyrics,
                    statePc: !!appSettings.lyrics.perCharFromLineLyrics,
                };
            }""")
            check("upgrade_turns_on", link["upOn"] and link["stateUp"], link)
            check("upgrade_forces_perChar_off", link["pcOn"] is False and link["statePc"] is False, link)

            # —— 5b. ★ 反方向也要互锁：先开开关2、再开开关1，开关2 必须被按下去 ——
            # 第一版只做了一半（开 2 → 关 1），于是用户实测「先开自动替换再开行级逐字
            # 就能两个都亮」，而判定层是 autoUpgrade 优先 = 刚点的那颗其实没生效。
            rev = page.evaluate("""() => {
                const up = document.getElementById('setAutoUpgradeWordLyrics');
                const pc = document.getElementById('setPerCharFromLineLyrics');
                pc.click();
                return {
                    pcOn: pc.classList.contains('on'),
                    upOn: up.classList.contains('on'),
                    statePc: !!appSettings.lyrics.perCharFromLineLyrics,
                    stateUp: !!appSettings.lyrics.autoUpgradeWordLyrics,
                };
            }""")
            check("perChar_turns_on", rev["pcOn"] and rev["statePc"], rev)
            check("perChar_forces_upgrade_off",
                  rev["upOn"] is False and rev["stateUp"] is False, rev)
            # 回到本用例开头的状态（开关2 开、开关1 关），后面第 6 节的持久化断言才成立
            page.evaluate("""() => {
                document.getElementById('setAutoUpgradeWordLyrics').click();
            }""")
            page.wait_for_timeout(250)

            # —— 6. 持久化：存盘 → 重新加载 → 两个键都还在（约束 11 的 loadSettings 白名单坑）——
            # ★ 必须 await syncConfigToBackend() 再刷新：saveSettings 只同步写 localStorage，
            #   后端那份是 debounce 400ms + 异步 POST；而启动时 loadConfigFromBackend 会**用后端
            #   覆盖** appSettings。睡 400ms 去刷新是赛跑（第一版就是这么偶发挂的），
            #   直接 await 同步函数才是确定性的。
            page.evaluate("""async () => {
                const m = await import('/src/app/180-boot-config.js');
                m.saveSettings();
                await m.syncConfigToBackend();
            }""")
            page.wait_for_timeout(200)
            page.reload(wait_until="load")
            try:
                page.wait_for_function("() => window.appSettings && appSettings.lyrics", timeout=30000)
            except Exception:
                pass
            page.wait_for_timeout(2500)
            persisted = page.evaluate("""() => ({
                up: appSettings.lyrics.autoUpgradeWordLyrics,
                pc: appSettings.lyrics.perCharFromLineLyrics,
            })""")
            check("settings_persist_across_reload", persisted["up"] is True and persisted["pc"] is False, persisted)

            # —— 7. 升级服务接线：293 的访问器确实被 170 注进来了 ——
            wired = page.evaluate("""async () => {
                const m = await import('/src/app/293-word-upgrade.js');
                return { hasMaybe: typeof m.maybeUpgradeToWordLyrics === 'function',
                         hasBind: typeof m.bindSourceAccessors === 'function',
                         hasReset: typeof m.resetWordUpgradeTracker === 'function' };
            }""")
            check("upgrade_module_exports", all(wired.values()), wired)

            # —— 8. ★ 升级排期不得被「2.5 秒内歌词数组被换掉」打断 ——
            # 用户实测「自动替换还是不触发」的真因：守卫写的是 `globalThis.lyrics !== snapshot`，
            # 而那份数组在 2.5 秒窗口里几乎一定会被换（约束 18 的频谱对齐回填、双语切换、
            # 设置面板那次 rerender 都会重新赋值），于是当场静默放弃，
            # 且 _tried 已记下这首歌 → 这一首永远不再试。
            # ★ 这里**直接调 293 的入口**而不是 renderLyrics：走渲染入口会连带拉起
            #   频谱对齐（WebAudio 解码真音频）等副作用，实测能把 headless 页面拖死；
            #   而被测对象本来就只是 293 的排期守卫。假访问器 = 不碰网络，CI 可跑。
            page.evaluate("""async () => {
                let last = null, same = 0;
                for (let i = 0; i < 30 && same < 4; i++) {
                    if (globalThis.isLoadingSong) { same = 0; last = null; await new Promise(r => setTimeout(r, 1000)); continue; }
                    const id = (globalThis.currentSongData || {}).id || '';
                    same = (id && id === last) ? same + 1 : (id ? 1 : 0);
                    last = id;
                    if (same < 3) await new Promise(r => setTimeout(r, 1000));
                }
                return same;
            }""")
            guard = page.evaluate("""async (linesJson) => {
                const u = await import('/src/app/293-word-upgrade.js');
                const seed = JSON.parse(linesJson);
                /* ★ 假候选**在取词那一刻**从 globalThis.lyrics 现算：
                   这样不管守卫用的是排期时的快照还是执行时的当前数组，文本都对得上，
                   被测的就只剩「排期守卫」这一件事。 */
                const candidateOf = (arr) => (arr || []).filter(l => l && (l.text || '')).map(l => ({
                    start: l.start, text: l.text,
                    words: [...l.text].map((ch, i) => ({ word: ch, start: l.start + i * 120, end: l.start + i * 120 + 100 })),
                }));
                globalThis.__applied = [];
                appSettings.lyrics.autoUpgradeWordLyrics = true;
                appSettings.lyrics.perCharFromLineLyrics = false;
                /* ★ 先 import 170 再绑假访问器：170 在模块求值时会绑真的，后绑的才算数 */
                await import('/src/app/170-lyric-sources.js');
                u.bindSourceAccessors(
                    async () => ({ originals: candidateOf(globalThis.lyrics) }),
                    (src, parts, opts) => { globalThis.__applied.push({ src, opts, n: (parts.originals || []).length }); return true; });
                u.resetWordUpgradeTracker();
                globalThis.lyrics = seed;
                u.maybeUpgradeToWordLyrics(seed);                        // 排期一次
                await new Promise(res => setTimeout(res, 300));
                /* 关键动作：在延迟窗口内换成「同一份内容的另一个数组」（模拟对齐回填）。
                   旧守卫 `globalThis.lyrics !== snapshot` 在这里就死了。 */
                const swapped = seed.map(l => Object.assign({}, l));
                globalThis.lyrics = swapped;
                u.maybeUpgradeToWordLyrics(swapped);
                await new Promise(res => setTimeout(res, 4200));
                return { applied: globalThis.__applied.slice(),
                         song: (globalThis.currentSongData || {}).id,
                         lines: (globalThis.lyrics || []).length };
            }""", LINE_LEVEL)
            applied = guard["applied"]
            check("upgrade_survives_array_swap", len(applied) == 1, guard)
            if applied:
                check("upgrade_reports_match_rate",
                      (applied[0]["opts"] or {}).get("upgradeRate", 0) >= 0.9, applied[0])
                check("upgrade_not_silent",
                      (applied[0]["opts"] or {}).get("silent") is not True, applied[0])

            # 一首歌只试一次：不该反复打网络
            page.wait_for_timeout(2000)
            again = page.evaluate("() => ({ n: globalThis.__applied.length })")
            check("upgrade_tries_once_per_song", again["n"] == 1, again)

            # 开关点亮时 resetWordUpgradeTracker 要能重新排期
            rearmed = page.evaluate("""async () => {
                const u = await import('/src/app/293-word-upgrade.js');
                appSettings.lyrics.autoUpgradeWordLyrics = true;
                u.resetWordUpgradeTracker();
                globalThis.lyrics = globalThis.lyrics.map(l => Object.assign({}, l));
                u.maybeUpgradeToWordLyrics(globalThis.lyrics);
                await new Promise(res => setTimeout(res, 4200));
                return { n: globalThis.__applied.length, lines: (globalThis.lyrics || []).length };
            }""")
            check("reset_tracker_rearms_attempt", rearmed["n"] == 2, rearmed)

        finally:
            # ★ 无论中途断言是否抛错，都把两个键钉回出厂值：这个 E2E 写的是真实
            #   user_config.json，漏恢复会连带打挂 test_word_fallback / test_word_align。
            print("  [teardown] 恢复默认配置…", flush=True)
            restore_defaults(page)
            print("  [teardown] 配置已恢复", flush=True)
            # 本节把 293 的访问器换成了假的、还留了一份 4 行探针歌词；
            # 恢复默认之后重新加载一次，让 close 面对的是干净页面。
            try:
                page.reload(wait_until="load")
                page.wait_for_timeout(1500)
            except Exception as e:
                print("  WARN 收尾重载失败:", e)
        # ★ 收尾不再尝试关页面/浏览器：本用例跑到这里时驱动连接已经断了
        #   （实测 page.goto("about:blank") 连显式 5 秒超时都救不回来，整份脚本白挂到
        #   CI 的 timeout，退出码变成 124 → 看起来像测试失败）。
        #   结果已经算完、配置也已经恢复，直接带着退出码离开；浏览器进程此时已经没了，
        #   不留孤儿。
        failed = [r for r in RESULTS if not r[1]]
        print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
        for n, _, d in failed:
            print("  FAILED %s  %s" % (n, d))
        sys.stdout.flush()
        os._exit(1 if failed else 0)


if __name__ == "__main__":
    sys.exit(main())
