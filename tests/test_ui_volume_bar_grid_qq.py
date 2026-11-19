# -*- coding: utf-8 -*-
"""端到端 Playwright 回归（隔离 ARIA_USER_DATA_DIR + 随机端口，不触碰真实配置/缓存）：
1. 上次关闭音量持久化（含精确 0），且「默认音量 / 音量标准化」设置项已移除；
2. 底部播放控件栏新版 UI 与非线性收缩/展开（收缩后仅留可交互进度条与展开按钮，并持久化）；
3. 列表/宫格模式统一样式与切屏/空态防卡死（播放全部不拉高、切回卡片/空态不缩成 1/3 列）；
4. QQ 音乐自建服务「我喜欢的歌」（有歌单曲目 & 空歌单均带 dirid=201 正常渲染、无报错横幅）。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if detail else ""))


def pick_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_server(base_url, timeout=15.0):
    deadline = time.time() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    last_err = None
    while time.time() < deadline:
        try:
            with opener.open(base_url, timeout=2) as r:
                if r.status == 200:
                    return True, ""
        except Exception as e:
            last_err = repr(e)
            time.sleep(0.2)
    return False, last_err or "timeout"


def dismiss_oobe(page):
    page.evaluate("""() => {
        const oobe = document.getElementById('ariaOobeOverlay');
        if (oobe) oobe.remove();
        const perf = document.getElementById('performanceDialog');
        if (perf) perf.remove();
        const w = document.getElementById('welcomeOverlay');
        if (w) { w.classList.add('hidden'); w.remove(); }
    }""")


def wait_boot(page):
    page.wait_for_function(
        "() => window.appSettings && appSettings.playback && typeof window.updateVolume === 'function'",
        timeout=25000,
    )
    page.wait_for_timeout(400)
    dismiss_oobe(page)


def run_tests(base_url):
    qq_mode = {"state": "populated", "hits": []}
    tracks_payload = {
        "response": {
            "code": 0,
            "cdlist": [{
                "dissname": "我喜欢",
                "songnum": 2,
                "songlist": [
                    {
                        "mid": "0039MnYb0qxYhV",
                        "title": "晴天",
                        "singer": [{"name": "周杰伦"}],
                        "album": {"mid": "000MkMNI19ClKG", "name": "叶惠美"},
                    },
                    {
                        "mid": "002B2EAA3brD5b",
                        "title": "七里香",
                        "singer": [{"name": "周杰伦"}],
                        "album": {"mid": "003DFxbG192O6a", "name": "七里香"},
                    },
                ],
            }],
        }
    }
    empty_payload = {
        "response": {
            "code": 0,
            "cdlist": [{
                "dissname": "我喜欢",
                "songnum": 0,
                "songlist": [],
            }],
        }
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-proxy-server"])
        context = browser.new_context(viewport={"width": 1280, "height": 800}, reduced_motion="no-preference")
        context.add_init_script("""
            if (!localStorage.getItem('aria_oobe_done')) localStorage.setItem('aria_oobe_done', '1');
            if (!localStorage.getItem('lyrics_player_performance')) {
                localStorage.setItem('lyrics_player_performance', JSON.stringify({
                    profile: 'high', testFps: 60, stressFps: 60, effectiveFps: 60,
                    detectedAt: Date.now(), manuallyConfigured: true
                }));
            }
            if (!localStorage.getItem('selfhost_prefs')) {
                localStorage.setItem('selfhost_prefs', JSON.stringify({
                    enabled: { kugou: false, qq: true, netease: false },
                    dailySource: 'qq'
                }));
            }
        """)
        context.route("**/*", lambda route: route.continue_() if ("127.0.0.1" in route.request.url or "localhost" in route.request.url or route.request.url.startswith("data:") or route.request.url.startswith("blob:")) else route.abort())

        def handle_status(route):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "qq": {"alive": True, "loggedIn": True, "uid": "wx_e2e_uid"},
                    "netease": {"alive": False, "loggedIn": False},
                    "kugou": {"alive": False, "loggedIn": False},
                }),
            )

        def handle_qq_proxy(route):
            parsed = urllib.parse.urlparse(route.request.url)
            qs = urllib.parse.parse_qs(parsed.query)
            inner_path = qs.get("path", [""])[0]
            qq_mode["hits"].append(inner_path)
            if "/user/getUserLikedSongs" in inner_path:
                body = {"response": {"data": {"info": {"id": "201999", "songCount": 2 if qq_mode["state"] == "populated" else 0, "cover": ""}}}}
            elif "/user/getUserPlaylists" in inner_path:
                body = {"response": {"code": 0, "data": {"playlists": [{"disstid": "88001", "dirname": "工作背景乐", "songnum": 5, "picurl": ""}]}}}
            elif "/getSongListDetail" in inner_path:
                body = tracks_payload if (qq_mode["state"] == "populated" and "dirid=201" in inner_path) else empty_payload
                if "dirid=201" not in inner_path and "disstid=201999" in inner_path:
                    body = {"response": {"code": 1000, "cdlist": []}}
            elif "/getSearchByKey" in inner_path:
                body = {
                    "response": {
                        "code": 0,
                        "data": {
                            "song": {
                                "list": [
                                    {"songid": 108879872, "songmid": "0039MnYb0qxYhV", "songname": "晴天", "singer": [{"id": 4558, "mid": "0025NhlN2yWrP4", "name": "周杰伦"}], "albumname": "叶惠美", "albummid": "000MkMni19ClKG", "interval": 269},
                                    {"songid": 108879873, "songmid": "004Z8Ihr0JIu5s", "songname": "七里香", "singer": [{"id": 4558, "mid": "0025NhlN2yWrP4", "name": "周杰伦"}], "albumname": "七里香", "albummid": "003RMaRI1iFoYd", "interval": 299},
                                ],
                                "totalnum": 2,
                            }
                        },
                    }
                }
            else:
                body = {"response": {"code": 0}}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

        def handle_local_music(route):
            route.fulfill(status=200, content_type="application/json", body=json.dumps([]))

        context.route("**/api/selfhost/status**", handle_status)
        context.route("**/api/selfhost/qq/proxy**", handle_qq_proxy)
        context.route("**/api/local-music/list**", handle_local_music)

        page = context.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)

        # ---- 1. 上次音量持久化 & 设置项移除 ----
        page.evaluate("document.getElementById('openSettingsBtn').click()")
        page.wait_for_timeout(300)
        removed = page.evaluate("""() => ({
            initialVol: !!document.getElementById('setInitialVolume'),
            volNorm: !!document.getElementById('setVolumeNorm'),
        })""")
        check("vol_settings_removed", not removed["initialVol"] and not removed["volNorm"], removed)
        page.evaluate("document.querySelector('#settingsOverlay .settings-close')?.click()")

        # 设音量为 37 并等待后端防抖保存 → 重载验证
        page.evaluate("window.updateVolume(37)")
        page.wait_for_timeout(1200)
        ls_vol_37 = page.evaluate("""() => ({
            ls: localStorage.getItem('aria_last_volume'),
            vol: window.volume,
            barW: document.getElementById('bottomVolumeBar')?.style?.width || '',
            txt: document.getElementById('bottomVolumeValue')?.textContent || '',
        })""")
        check("vol_37_applied", ls_vol_37["ls"] == "37" and ls_vol_37["vol"] == 37 and ls_vol_37["txt"] == "37", ls_vol_37)

        page.reload(wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        reloaded_37 = page.evaluate("""() => ({
            vol: window.volume,
            ls: localStorage.getItem('aria_last_volume'),
            barW: document.getElementById('bottomVolumeBar')?.style?.width || '',
            txt: document.getElementById('bottomVolumeValue')?.textContent || '',
        })""")
        check("vol_37_persisted_after_reload", reloaded_37["vol"] == 37 and reloaded_37["txt"] == "37", reloaded_37)

        # 精确 0 音量持久化（不可被 falsy 误回退到 80）
        page.evaluate("window.updateVolume(0)")
        page.wait_for_timeout(200)
        page.reload(wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        reloaded_0 = page.evaluate("""() => ({
            vol: window.volume,
            ls: localStorage.getItem('aria_last_volume'),
            barW: document.getElementById('bottomVolumeBar')?.style?.width || '',
            txt: document.getElementById('bottomVolumeValue')?.textContent || '',
        })""")
        check("vol_zero_persisted_after_reload", reloaded_0["vol"] == 0 and reloaded_0["ls"] == "0" and reloaded_0["txt"] == "0", reloaded_0)

        # ---- 2. 底部控件栏 UI 与非线性收缩/展开 ----
        # 默认 cover 模式下底栏保持隐藏；切至 flyin 模式展示底栏
        cover_hidden = page.evaluate("getComputedStyle(document.getElementById('bottomControlBar')).display === 'none'")
        check("bottom_bar_hidden_in_cover", cover_hidden)

        page.evaluate("""() => {
            document.getElementById('openViewModeBtn').click();
            document.querySelector('#viewModeOverlay .view-mode-card[data-mode="flyin"]').click();
        }""")
        page.wait_for_timeout(750)

        bar_before = page.evaluate("""() => {
            const bar = document.getElementById('bottomControlBar');
            const collapse = bar.querySelector('.bottom-controls-collapse');
            const btn = document.getElementById('bottomCollapseBtn');
            const prog = document.getElementById('bottomProgressTrack');
            const controls = bar.querySelector('.bottom-controls-row');
            const songCard = bar.querySelector('.bottom-song-card');
            const timeDisp = bar.querySelector('.bottom-time-display');
            const csBar = getComputedStyle(bar);
            const csCol = getComputedStyle(collapse);
            return {
                display: csBar.display,
                collapsed: bar.classList.contains('is-collapsed'),
                ariaExpanded: btn?.getAttribute('aria-expanded'),
                barH: bar.getBoundingClientRect().height,
                ctrlH: controls.getBoundingClientRect().height,
                songH: songCard.getBoundingClientRect().height,
                timeH: timeDisp.getBoundingClientRect().height,
                progH: prog.getBoundingClientRect().height,
                barTiming: csBar.transitionTimingFunction,
                colTiming: csCol.transitionTimingFunction,
                colDur: csCol.transitionDuration,
            };
        }""")
        check(
            "bottom_bar_expanded_and_nonlinear",
            bar_before["display"] != "none"
            and not bar_before["collapsed"]
            and bar_before["ariaExpanded"] == "true"
            and bar_before["ctrlH"] > 20
            and bar_before["progH"] > 0
            and "cubic-bezier(" in bar_before["barTiming"]
            and "cubic-bezier(" in bar_before["colTiming"],
            bar_before,
        )

        # 点击收缩按钮 → 仅保留进度条与展开按钮
        page.click("#bottomCollapseBtn")
        page.wait_for_timeout(650)
        bar_after = page.evaluate("""() => {
            const bar = document.getElementById('bottomControlBar');
            const collapse = bar.querySelector('.bottom-controls-collapse');
            const btn = document.getElementById('bottomCollapseBtn');
            const prog = document.getElementById('bottomProgressTrack');
            const controls = bar.querySelector('.bottom-controls-row');
            const songCard = bar.querySelector('.bottom-song-card');
            const timeDisp = bar.querySelector('.bottom-time-display');
            const rProg = prog.getBoundingClientRect();
            const hit = document.elementFromPoint(rProg.left + rProg.width / 2, rProg.top + rProg.height / 2);
            return {
                collapsed: bar.classList.contains('is-collapsed'),
                ariaExpanded: btn?.getAttribute('aria-expanded'),
                barH: bar.getBoundingClientRect().height,
                colH: collapse.getBoundingClientRect().height,
                ctrlOp: parseFloat(getComputedStyle(controls).opacity || '1'),
                songVis: getComputedStyle(songCard).visibility,
                timeVis: getComputedStyle(timeDisp).visibility,
                progW: rProg.width,
                progH: rProg.height,
                btnW: btn.getBoundingClientRect().width,
                hitId: hit?.id || hit?.className || '',
                savedCollapsed: !!(appSettings?.interface?.bottomBarCollapsed),
            };
        }""")
        check(
            "bottom_bar_collapsed_only_progress_and_toggle",
            bar_after["collapsed"]
            and bar_after["ariaExpanded"] == "false"
            and bar_after["savedCollapsed"]
            and bar_after["barH"] <= 46
            and bar_after["barH"] < bar_before["barH"] - 35
            and bar_after["colH"] <= 1.0
            and bar_after["ctrlOp"] <= 0.05
            and bar_after["songVis"] == "hidden"
            and bar_after["timeVis"] == "hidden"
            and bar_after["progW"] > 100 and bar_after["progH"] >= 4
            and bar_after["btnW"] >= 20
            and ("bottomProgress" in bar_after["hitId"] or "bottom-progress" in bar_after["hitId"]),
            bar_after,
        )

        # 重载保持收缩态，再点一次恢复展开
        page.reload(wait_until="domcontentloaded", timeout=30000)
        wait_boot(page)
        page.evaluate("""() => {
            if (!document.querySelector('.player-container')?.classList.contains('view-flyin')) {
                document.getElementById('openViewModeBtn').click();
                document.querySelector('#viewModeOverlay .view-mode-card[data-mode="flyin"]').click();
            }
        }""")
        page.wait_for_timeout(750)
        persisted_collapsed = page.evaluate("""() => ({
            collapsed: document.getElementById('bottomControlBar')?.classList.contains('is-collapsed'),
            expanded: document.getElementById('bottomCollapseBtn')?.getAttribute('aria-expanded'),
        })""")
        check("bottom_bar_collapsed_persists", persisted_collapsed["collapsed"] and persisted_collapsed["expanded"] == "false", persisted_collapsed)

        page.click("#bottomCollapseBtn")
        page.wait_for_timeout(650)
        reexpanded = page.evaluate("""() => ({
            collapsed: document.getElementById('bottomControlBar')?.classList.contains('is-collapsed'),
            expanded: document.getElementById('bottomCollapseBtn')?.getAttribute('aria-expanded'),
            colH: document.querySelector('#bottomControlBar .bottom-controls-collapse')?.getBoundingClientRect().height || 0,
        })""")
        check("bottom_bar_reexpanded", (not reexpanded["collapsed"]) and reexpanded["expanded"] == "true" and reexpanded["colH"] > 20, reexpanded)

        # ---- 3. 歌单/收藏 宫格切换与容器高度/宽度防异常 ----
        # 注入 2 条收藏歌曲 → 打开收藏弹窗 → 切换宫格 → 检查 #favPlayAllBtn 高度与宽度 → 清空重开 → 不残余 .song-grid-view
        page.evaluate("""() => {
            localStorage.setItem('lyrics_player_favorites', JSON.stringify([
                { key: 'netease:101', id: '101', song: '测试收藏一', singer: '歌手甲', source: 'netease', cover: '' },
                { key: 'netease:102', id: '102', song: '测试收藏二', singer: '歌手乙', source: 'netease', cover: '' },
            ]));
            localStorage.setItem('lyrics_player_playlists', JSON.stringify([
                { id: 'pl_filled', name: '有歌歌单', songs: [
                    { key: 'netease:201', id: '201', song: '歌单一号', singer: '歌手A', source: 'netease', cover: '' },
                    { key: 'netease:202', id: '202', song: '歌单二号', singer: '歌手B', source: 'netease', cover: '' },
                ] },
                { id: 'pl_empty', name: '空歌单测试', songs: [] },
            ]));
            localStorage.setItem('aria_song_view', '0');
            if (window.Aria) Aria.__songView = 'list';
            document.getElementById('openFavoritesBtn').click();
        }""")
        page.wait_for_timeout(300)

        # 点击宫格切换按钮
        page.click("#favoritesList [data-song-view-btn='1']")
        page.wait_for_timeout(200)
        fav_grid = page.evaluate("""() => {
            const list = document.getElementById('favoritesList');
            const head = list.querySelector('.rank-list-head');
            const btn = document.getElementById('favPlayAllBtn');
            const item = list.querySelector('.result-item');
            const lr = list.getBoundingClientRect();
            const hr = head.getBoundingClientRect();
            const br = btn.getBoundingClientRect();
            const ir = item.getBoundingClientRect();
            const cs = getComputedStyle(list);
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: cs.display,
                cols: cs.gridTemplateColumns.trim().split(/\\s+/).length,
                headW: hr.width, listClientW: list.clientWidth,
                headH: hr.height, btnH: br.height, itemH: ir.height,
            };
        }""")
        check(
            "favorites_grid_head_not_stretched",
            fav_grid["hasGrid"]
            and fav_grid["display"] == "grid"
            and fav_grid["cols"] == 3
            and fav_grid["btnH"] <= 56
            and fav_grid["headH"] <= 56
            and fav_grid["headW"] >= fav_grid["listClientW"] * 0.85,
            fav_grid,
        )

        # 清空收藏后再打开收藏列表（在宫格全局偏好开启时也不得残留 song-grid-view）
        page.evaluate("""() => {
            localStorage.setItem('lyrics_player_favorites', '[]');
            document.getElementById('favoritesCloseBtn').click();
            document.getElementById('openFavoritesBtn').click();
        }""")
        page.wait_for_timeout(250)
        fav_empty = page.evaluate("""() => {
            const list = document.getElementById('favoritesList');
            const hint = list.querySelector('.empty-hint');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: getComputedStyle(list).display,
                hintW: hint ? hint.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check(
            "favorites_empty_clears_grid",
            (not fav_empty["hasGrid"]) and fav_empty["display"] != "grid" and fav_empty["hintW"] >= fav_empty["listClientW"] * 0.85,
            fav_empty,
        )
        page.click("#favoritesCloseBtn")

        # 歌单列表：在宫格全局开启时切「有歌歌单 → 返回歌单首页 → 空歌单 → 本地音乐(空)」
        page.click("#openPlaylistsBtn")
        page.wait_for_timeout(300)
        index_before = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const card = list.querySelector('.custom-playlist-item');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                cardW: card ? card.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check("playlist_index_full_width", (not index_before["hasGrid"]) and index_before["cardW"] >= index_before["listClientW"] * 0.85, index_before)

        # 打开「有歌歌单」
        page.click("#playlistsList .custom-playlist-item[data-pid='pl_filled']")
        page.wait_for_timeout(250)
        pl_filled = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const head = list.querySelector('.rank-list-head');
            const btn = document.getElementById('playAllBtn');
            const cs = getComputedStyle(list);
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: cs.display,
                cols: cs.gridTemplateColumns.trim().split(/\\s+/).length,
                headH: head?.getBoundingClientRect().height || 0,
                btnH: btn?.getBoundingClientRect().height || 0,
                headW: head?.getBoundingClientRect().width || 0,
                listClientW: list.clientWidth,
            };
        }""")
        check(
            "playlist_detail_grid_head_compact",
            pl_filled["hasGrid"] and pl_filled["display"] == "grid" and pl_filled["cols"] == 3 and pl_filled["btnH"] <= 56 and pl_filled["headW"] >= pl_filled["listClientW"] * 0.85,
            pl_filled,
        )

        # 返回歌单首页：不得把歌单首页卡片缩成 1/3 宽！
        page.click("#playlistBackBtn")
        page.wait_for_timeout(250)
        index_after_back = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const card = list.querySelector('.custom-playlist-item');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: getComputedStyle(list).display,
                cardW: card ? card.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check(
            "playlist_back_clears_grid_full_width",
            (not index_after_back["hasGrid"]) and index_after_back["display"] != "grid" and index_after_back["cardW"] >= index_after_back["listClientW"] * 0.85,
            index_after_back,
        )

        # 打开「空歌单测试」：空态占满宽且不留 song-grid-view
        page.click("#playlistsList .custom-playlist-item[data-pid='pl_empty']")
        page.wait_for_timeout(250)
        pl_empty = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const hint = list.querySelector('.empty-hint');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: getComputedStyle(list).display,
                hintW: hint ? hint.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check("playlist_empty_clears_grid", (not pl_empty["hasGrid"]) and pl_empty["display"] != "grid" and pl_empty["hintW"] >= pl_empty["listClientW"] * 0.85, pl_empty)

        # 返回 → 本地音乐（空）
        page.click("#playlistBackBtn")
        page.wait_for_timeout(200)
        page.click("#playlistsList .playlist-item[data-pid='__local_music__']")
        page.wait_for_timeout(300)
        local_empty = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const hint = list.querySelector('.empty-hint');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                display: getComputedStyle(list).display,
                hintW: hint ? hint.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check("local_empty_clears_grid", (not local_empty["hasGrid"]) and local_empty["display"] != "grid" and local_empty["hintW"] >= local_empty["listClientW"] * 0.85, local_empty)

        # ---- 4. QQ 音乐自建服务「我喜欢的歌」有曲 & 空歌单 ----
        # 4a) 歌单入口 -> QQ音乐自建歌单 -> 我喜欢的歌
        page.click("#playlistBackBtn")
        page.wait_for_timeout(200)
        page.evaluate("""() => {
            if (window.Aria?.invalidateSelfhostCaches) Aria.invalidateSelfhostCaches();
        }""")
        page.click("#playlistsList .selfplat-entry[data-selfplat='qq']")
        page.wait_for_selector("#playlistsList .rank-board-card", timeout=10000)
        page.click("#playlistsList .rank-board-card[data-i='0']")
        page.wait_for_selector("#playlistsList .result-item", timeout=10000)
        qq_pl_liked = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const items = Array.from(list.querySelectorAll('.result-item')).map(el => el.textContent.trim());
            const head = list.querySelector('.rank-list-head');
            const btn = document.getElementById('selfPlatPlayAll');
            return {
                hasErr: !!list.querySelector('.rank-error'),
                count: items.length,
                hasSunny: items.some(t => t.includes('晴天')),
                headH: head?.getBoundingClientRect().height || 0,
                btnH: btn?.getBoundingClientRect().height || 0,
            };
        }""")
        check(
            "qq_playlist_liked_populated_ok",
            (not qq_pl_liked["hasErr"]) and qq_pl_liked["count"] == 2 and qq_pl_liked["hasSunny"] and qq_pl_liked["btnH"] <= 56,
            qq_pl_liked,
        )
        page.click("#playlistsCloseBtn")

        # 4b) #selfFavOverlay -> QQ 音乐「我喜欢的歌」有曲目 + 空歌单切换
        page.evaluate("window.openSelfFavorites('qq')")
        page.wait_for_selector("#selfFavList .result-item", timeout=10000)
        sf_pop = page.evaluate("""() => {
            const list = document.getElementById('selfFavList');
            const head = list.querySelector('.rank-list-head');
            const bar = list.querySelector('.rank-playall');
            return {
                hasErr: !!list.querySelector('.rank-error'),
                items: list.querySelectorAll('.result-item').length,
                hasHead: !!head,
                barH: bar?.getBoundingClientRect().height || 0,
                hasToggle: !!head?.querySelector('[data-song-view-btn="1"]'),
                hasGrid: list.classList.contains('song-grid-view'),
            };
        }""")
        check(
            "selffav_qq_liked_populated_unified_head",
            (not sf_pop["hasErr"]) and sf_pop["items"] == 2 and sf_pop["hasHead"] and sf_pop["hasToggle"] and sf_pop["barH"] <= 56 and sf_pop["hasGrid"],
            sf_pop,
        )

        # 切换到「我的歌单」卡片 → 必须清除 .song-grid-view 且卡片全宽显示
        page.click("#selfFavModes .rank-chip[data-fmode='playlists']")
        page.wait_for_selector("#selfFavList .rank-board-grid", timeout=10000)
        sf_cards = page.evaluate("""() => {
            const list = document.getElementById('selfFavList');
            const grid = list.querySelector('.rank-board-grid');
            return {
                hasGrid: list.classList.contains('song-grid-view'),
                gridW: grid ? grid.getBoundingClientRect().width : 0,
                listClientW: list.clientWidth,
            };
        }""")
        check("selffav_cards_clears_song_grid", (not sf_cards["hasGrid"]) and sf_cards["gridW"] >= sf_cards["listClientW"] * 0.85, sf_cards)

        # 切换空「我喜欢的歌」状态并强制刷新
        qq_mode["state"] = "empty"
        page.click("#selfFavModes .rank-chip[data-fmode='liked']")
        page.click("#selfFavRefreshBtn")
        page.wait_for_selector("#selfFavList .rank-empty", timeout=10000)
        sf_empty = page.evaluate("""() => {
            const list = document.getElementById('selfFavList');
            return {
                hasErr: !!list.querySelector('.rank-error'),
                emptyText: list.querySelector('.rank-empty')?.textContent || '',
                hasGrid: list.classList.contains('song-grid-view'),
            };
        }""")
        check(
            "selffav_qq_empty_liked_no_error",
            (not sf_empty["hasErr"]) and ("还没有歌曲" in sf_empty["emptyText"]) and (not sf_empty["hasGrid"]),
            sf_empty,
        )
        check("qq_dirid_201_sent", any("dirid=201" in u for u in qq_mode["hits"]), qq_mode["hits"])

        # 关闭 selfFav 弹窗，进入 flyin 视图检验底栏纯白进度条 & 动画帧不变形
        page.click("#selfFavCloseBtn")
        page.evaluate("""() => {
            document.getElementById('openViewModeBtn')?.click();
            document.querySelector('#viewModeOverlay .view-mode-card[data-mode="flyin"]')?.click();
            if (window.Aria?.setBottomBarCollapsed) Aria.setBottomBarCollapsed(false, { animate: false, save: false });
        }""")
        page.wait_for_timeout(400)

        prog_style = page.evaluate("""() => {
            const el = document.getElementById('bottomProgressBar');
            const cs = getComputedStyle(el);
            return { bgImg: cs.backgroundImage, bgCol: cs.backgroundColor };
        }""")
        check(
            "bottom_progress_bar_pure_white",
            prog_style["bgImg"] == "none" and prog_style["bgCol"] == "rgb(255, 255, 255)",
            prog_style,
        )

        # 逐帧采集收缩与展开：验证播放按钮始终保持 1:1 圆形、进度条宽单调变化不反跳、静止不溢出
        anim_probe = page.evaluate("""() => new Promise(resolve => {
            const sample = () => {
                const bar = document.getElementById('bottomControlBar');
                const center = bar.querySelector('.bottom-center-area');
                const row = bar.querySelector('.bottom-controls-row');
                const play = document.getElementById('bottomPlayBtn');
                const prog = document.getElementById('bottomProgressTrack');
                const br = bar.getBoundingClientRect();
                const cr = center.getBoundingClientRect();
                const rr = row.getBoundingClientRect();
                const pr = play.getBoundingClientRect();
                const tr = prog.getBoundingClientRect();
                return {
                    bw: Math.round(br.width * 10) / 10,
                    cw: Math.round(cr.width * 10) / 10,
                    rw: Math.round(rr.width * 10) / 10,
                    pw: Math.round(pr.width * 10) / 10,
                    ph: Math.round(pr.height * 10) / 10,
                    tw: Math.round(tr.width * 10) / 10,
                    rop: Math.round(parseFloat(getComputedStyle(row).opacity || '1') * 100) / 100,
                };
            };
            const runPhase = () => new Promise(done => {
                const frames = [sample()];
                const t0 = performance.now();
                document.getElementById('bottomCollapseBtn').click();
                const step = () => {
                    frames.push(sample());
                    if (performance.now() - t0 >= 480) return done(frames);
                    requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            });
            runPhase().then(collapseFrames => {
                runPhase().then(expandFrames => resolve({ collapseFrames, expandFrames }));
            });
        })""")
        cf = anim_probe["collapseFrames"]
        ef = anim_probe["expandFrames"]
        max_oval_diff = max(abs(f["pw"] - f["ph"]) for f in (cf + ef))
        rest_no_overflow = cf[0]["rw"] <= cf[0]["cw"] + 1.0 and ef[-1]["rw"] <= ef[-1]["cw"] + 1.0
        col_prog_monotonic = all(cf[i]["tw"] <= cf[i - 1]["tw"] + 1.0 for i in range(1, len(cf)))
        exp_prog_monotonic = all(ef[i]["tw"] >= ef[i - 1]["tw"] - 1.0 for i in range(1, len(ef)))
        check(
            "bottom_bar_anim_smooth_no_squish",
            max_oval_diff <= 0.5
            and rest_no_overflow
            and col_prog_monotonic
            and exp_prog_monotonic
            and cf[-1]["bw"] <= 400
            and ef[-1]["bw"] >= 860
            and ef[-1]["rop"] >= 0.98,
            {
                "max_oval_diff": max_oval_diff,
                "rest_no_overflow": rest_no_overflow,
                "col_prog_monotonic": col_prog_monotonic,
                "exp_prog_monotonic": exp_prog_monotonic,
                "c0": cf[0],
                "cEnd": cf[-1],
                "eEnd": ef[-1],
            },
        )

        # ---- 6. 搜索页切换音源清空旧结果，不遮挡视图 ----
        page.evaluate("""() => {
            localStorage.setItem('aria_search_history_v1', JSON.stringify({ netease: ['夜曲'] }));
        }""")
        page.click("#openSearchBtn")
        page.wait_for_selector("#searchOverlay.visible", timeout=5000)
        page.click("#searchOverlay .source-btn[data-source='tencent']")
        page.fill("#searchInput", "晴天")
        page.click("#searchBtn")
        page.wait_for_selector("#searchResults .result-item", timeout=10000)

        qq_search_count = page.locator("#searchResults .result-item").count()
        page.click("#searchOverlay .source-btn[data-source='netease']")
        page.wait_for_timeout(150)
        after_switch_netease = page.evaluate("""() => {
            const res = document.getElementById('searchResults');
            return {
                childCount: res ? res.children.length : -1,
                htmlEmpty: res ? res.innerHTML.trim() === '' : false,
                resDisplay: res ? getComputedStyle(res).display : '',
                resH: res ? res.getBoundingClientRect().height : -1,
                activeSrc: document.querySelector('#searchOverlay .source-btn.active')?.dataset?.source || '',
            };
        }""")
        check(
            "search_switch_source_clears_old_results",
            qq_search_count == 2
            and after_switch_netease["activeSrc"] == "netease"
            and after_switch_netease["childCount"] == 0
            and after_switch_netease["htmlEmpty"]
            and after_switch_netease["resDisplay"] == "none"
            and after_switch_netease["resH"] == 0,
            {"qq_search_count": qq_search_count, **after_switch_netease},
        )

        # 清空输入框后，#searchHistory 正常显示，不被旧搜索结果遮挡
        page.fill("#searchInput", "")
        page.dispatch_event("#searchInput", "input")
        page.wait_for_timeout(150)
        after_clear_hist = page.evaluate("""() => {
            const res = document.getElementById('searchResults');
            const hist = document.getElementById('searchHistory');
            return {
                resDisplay: res ? getComputedStyle(res).display : '',
                histDisplay: hist ? getComputedStyle(hist).display : '',
                histH: hist ? hist.getBoundingClientRect().height : 0,
                hasSeededChip: hist ? hist.textContent.includes('夜曲') : false,
            };
        }""")
        check(
            "search_history_visible_after_source_switch",
            after_clear_hist["resDisplay"] == "none"
            and after_clear_hist["histDisplay"] != "none"
            and after_clear_hist["histH"] > 0
            and after_clear_hist["hasSeededChip"],
            after_clear_hist,
        )

        # 填回「晴天」切回 QQ 仍可立即复用已有 QQ 缓存结果；随后输入新词并切酷狗/再切回 QQ，若词与缓存不一致不得显示过期结果
        page.fill("#searchInput", "晴天")
        page.dispatch_event("#searchInput", "input")
        page.click("#searchOverlay .source-btn[data-source='tencent']")
        page.wait_for_selector("#searchResults .result-item", timeout=5000)
        page.fill("#searchInput", "稻香")
        page.dispatch_event("#searchInput", "input")
        page.click("#searchOverlay .source-btn[data-source='kugou']")
        page.wait_for_timeout(150)
        page.click("#searchOverlay .source-btn[data-source='tencent']")
        page.wait_for_timeout(150)
        after_word_switch = page.evaluate("""() => {
            const res = document.getElementById('searchResults');
            return {
                childCount: res ? res.children.length : -1,
                resDisplay: res ? getComputedStyle(res).display : '',
            };
        }""")
        check(
            "search_new_word_switch_source_stays_clear",
            after_word_switch["childCount"] == 0 and after_word_switch["resDisplay"] == "none",
            after_word_switch,
        )
        page.click("#searchCloseBtn")

        # ---- 7. 听歌统计「声音手账 / 情绪档案」空态、富情感视图、纪念卡导出与重置 ----
        page.evaluate("""() => {
            localStorage.removeItem('aria_play_stats');
            localStorage.removeItem('aria_recent_history');
        }""")
        page.click("#openStatsBtn")
        page.wait_for_selector("#statsOverlay.visible .stats-empty-stage", timeout=5000)
        stats_empty = page.evaluate("""() => ({
            visible: document.getElementById('statsOverlay')?.classList.contains('visible'),
            title: document.querySelector('#statsBody .stats-empty-title')?.textContent?.trim() || '',
            hasBtn: !!document.getElementById('statsExploreBtn'),
        })""")
        check("stats_empty_stage_rendered", stats_empty["visible"] and stats_empty["title"] == "初遇频段" and stats_empty["hasBtn"], stats_empty)
        page.click("#statsCloseBtn")
        page.wait_for_timeout(150)

        # 注入丰富本地听歌档案 + 收藏 + 历史 + AI 情绪缓存，重新打开验证
        svg_cover_a = "data:image/svg+xml;utf8," + urllib.parse.quote(
            "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#6A88C9'/><stop offset='100%' stop-color='#1F2744'/></linearGradient></defs><rect width='120' height='120' fill='url(#g)'/><circle cx='60' cy='60' r='26' fill='none' stroke='#E8BE6A' stroke-width='4'/></svg>"
        )
        svg_cover_b = "data:image/svg+xml;utf8," + urllib.parse.quote(
            "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='#38263C'/><circle cx='60' cy='60' r='30' fill='#E8BE6A' opacity='0.65'/></svg>"
        )
        page.evaluate("""async ({ covA, covB }) => {
            const pad2 = n => String(n).padStart(2, '0');
            const localKey = (ts) => {
                const d = new Date(ts);
                return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
            };
            const now = Date.now();
            const days = {};
            for (let i = 0; i < 6; i++) {
                days[localKey(now - i * 86400000)] = (6 - i) * 320000;
            }
            const hours = new Array(24).fill(0);
            hours[23] = 1650000;
            hours[0] = 780000;
            hours[1] = 420000;
            hours[20] = 360000;
            hours[15] = 240000;

            localStorage.setItem('aria_play_stats', JSON.stringify({
                totalPlays: 24,
                totalMs: 6420000,
                firstAt: now - 9 * 86400000,
                songs: {
                    'netease:185924': { title: '夜曲', artist: '周杰伦', n: 11, ms: 2680000, cover: covA, source: 'netease', id: '185924' },
                    'tencent:0039MnYb0qxYhV': { title: '晴天', artist: '周杰伦', n: 8, ms: 1940000, cover: covB, source: 'tencent', mid: '0039MnYb0qxYhV' },
                    'netease:287035': { title: '遇见', artist: '孙燕姿', n: 5, ms: 1120000, cover: covB, source: 'netease', id: '287035' },
                },
                artists: {
                    '周杰伦': { n: 19, ms: 4620000, cover: covA, source: 'netease' },
                    '孙燕姿': { n: 5, ms: 1120000, cover: covB, source: 'netease' },
                },
                days,
                hours,
            }));
            localStorage.setItem('lyrics_player_favorites', JSON.stringify([
                { key: 'netease:185924', title: '夜曲', artist: '周杰伦', source: 'netease', id: '185924', cover: covA },
            ]));
            localStorage.setItem('aria_recent_history', JSON.stringify([
                { key: 'netease:185924', title: '夜曲', artist: '周杰伦', source: 'netease', id: '185924', cover: covA, at: now - 1800000 },
            ]));

            await new Promise((resolve) => {
                const req = indexedDB.open('LyricsPlayerDB');
                req.onsuccess = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('aiThemeCache')) { db.close(); return resolve(false); }
                    const tx = db.transaction('aiThemeCache', 'readwrite');
                    const store = tx.objectStore('aiThemeCache');
                    store.put({
                        key: '夜曲|周杰伦',
                        ts: now,
                        data: {
                            mood: '微凉思念',
                            primary_color: '#7EA2E6',
                            emotion_words: [
                                { word: '夜色', color: '#7EA2E6', emotion: 'nostalgia' },
                                { word: '思念', color: '#C29EEB', emotion: 'longing' },
                                { word: '风声', color: '#6BB8D9', emotion: 'quiet' },
                            ],
                        },
                    });
                    store.put({
                        key: '晴天|周杰伦',
                        ts: now,
                        data: {
                            mood: '温柔怀旧',
                            primary_color: '#E8BE6A',
                            emotion_words: [
                                { word: '晴朗', color: '#E8BE6A', emotion: 'warm' },
                                { word: '微风', color: '#8FD3B6', emotion: 'fresh' },
                            ],
                        },
                    });
                    tx.oncomplete = () => { db.close(); resolve(true); };
                    tx.onerror = () => { db.close(); resolve(false); };
                };
                req.onerror = () => resolve(false);
            });
        }""", {"covA": svg_cover_a, "covB": svg_cover_b})

        page.click("#openStatsBtn")
        page.wait_for_selector("#statsOverlay.visible #statsMoodMount .stats-ew-pill", timeout=5000)
        page.wait_for_timeout(350)

        stats_rich = page.evaluate("""() => {
            const b = document.getElementById('statsBody');
            const spotCover = b.querySelector('.stats-spot-cover');
            return {
                personaTitle: b.querySelector('.stats-persona-title')?.textContent?.trim() || '',
                heroH: Math.round(b.querySelector('.stats-hero')?.getBoundingClientRect().height || 0),
                spotH: Math.round(b.querySelector('.stats-spotlight')?.getBoundingClientRect().height || 0),
                kpiCount: b.querySelectorAll('.stats-kpi').length,
                chipCount: b.querySelectorAll('.stats-chip').length,
                spotTitle: b.querySelector('.stats-spot-title')?.textContent?.trim() || '',
                spotHasFav: !!b.querySelector('.stats-spot-fav'),
                spotCoverLoaded: !!(spotCover && spotCover.complete && spotCover.naturalWidth > 0),
                swatches: b.querySelectorAll('#statsMoodMount .stats-swatch').length,
                emotionWords: b.querySelectorAll('#statsMoodMount .stats-ew-pill').length,
                hourCols: b.querySelectorAll('.stats-hour-col').length,
                dayCols: b.querySelectorAll('.stats-day-col').length,
                songRows: b.querySelectorAll('.stats-song-row').length,
                artistRows: b.querySelectorAll('.stats-artist-row').length,
                overflowX: b.scrollWidth > b.clientWidth + 2,
                modalW: Math.round(document.querySelector('#statsOverlay .search-modal')?.getBoundingClientRect().width || 0),
            };
        }""")
        check(
            "stats_emotional_journal_rendered",
            stats_rich["personaTitle"] == "零点守夜人"
            and stats_rich["heroH"] >= 140
            and stats_rich["spotH"] >= 80
            and stats_rich["kpiCount"] == 4
            and stats_rich["chipCount"] >= 3
            and stats_rich["spotTitle"] == "夜曲"
            and stats_rich["spotHasFav"]
            and stats_rich["spotCoverLoaded"]
            and stats_rich["swatches"] >= 2
            and stats_rich["emotionWords"] >= 4
            and stats_rich["hourCols"] == 24
            and stats_rich["dayCols"] == 14
            and stats_rich["songRows"] == 3
            and stats_rich["artistRows"] == 2
            and not stats_rich["overflowX"],
            stats_rich,
        )

        # 悬停 24h 与 14日 柱条，验证动态读数更新
        hour_before = page.locator("#statsHourReadout").text_content()
        page.locator(".stats-hour-col").nth(15).hover()
        hour_after = page.locator("#statsHourReadout").text_content()
        day_before = page.locator("#statsDayReadout").text_content()
        page.locator(".stats-day-col").nth(0).hover()
        day_after = page.locator("#statsDayReadout").text_content()
        check(
            "stats_charts_hover_readout_interactive",
            hour_after != hour_before and "15:00" in hour_after and day_after != day_before,
            {"hour_before": hour_before, "hour_after": hour_after, "day_before": day_before, "day_after": day_after},
        )

        # 可选截图落盘至外部人工检查路径（不写进仓库）
        shot_dir = os.environ.get("ARIA_STATS_SHOT_DIR", "")
        if shot_dir:
            os.makedirs(shot_dir, exist_ok=True)
            page.evaluate("document.getElementById('statsBody').scrollTop = 0")
            page.wait_for_timeout(150)
            page.screenshot(path=os.path.join(shot_dir, "verify_stats_top.png"))
            page.evaluate("document.getElementById('statsBody').scrollTop = 440")
            page.wait_for_timeout(150)
            page.screenshot(path=os.path.join(shot_dir, "verify_stats_mid.png"))
            page.evaluate("document.getElementById('statsBody').scrollTop = 0")

        # 导出声音纪念卡 PNG
        with page.expect_download(timeout=10000) as dl_info:
            page.click("#statsExportCardBtn")
        dl = dl_info.value
        dl_path = dl.path()
        if shot_dir and dl_path:
            shutil.copyfile(dl_path, os.path.join(shot_dir, "verify_stats_card.png"))
        check(
            "stats_export_keepsake_card_png",
            dl.suggested_filename.startswith("aria-sound-journal-")
            and dl.suggested_filename.endswith(".png")
            and bool(dl_path)
            and os.path.getsize(dl_path) > 5000,
            {"filename": dl.suggested_filename, "bytes": os.path.getsize(dl_path) if dl_path else 0},
        )

        # 清空统计二次确认弹窗 -> 确认后回到空态
        page.click("#statsResetBtn")
        page.wait_for_selector(".aria-dialog-overlay", timeout=4000)
        page.click(".aria-dialog-overlay .aria-dialog-btn.primary")
        page.wait_for_selector("#statsOverlay.visible .stats-empty-stage", timeout=5000)
        reset_empty = page.evaluate("""() => ({
            isEmptyStage: !!document.querySelector('#statsBody .stats-empty-stage'),
            totalPlays: JSON.parse(localStorage.getItem('aria_play_stats') || '{}').totalPlays || 0,
        })""")
        check("stats_reset_confirm_clears_to_empty", reset_empty["isEmptyStage"] and reset_empty["totalPlays"] == 0, reset_empty)
        page.click("#statsCloseBtn")

        check("zero_page_errors", len(page_errors) == 0, page_errors)

        browser.close()


def main():
    port = pick_free_port()
    tmp_dir = tempfile.mkdtemp(prefix="aria_e2e_vbgq_")
    log_path = os.path.join(tmp_dir, "server.log")
    env = os.environ.copy()
    env["ARIA_PORT"] = str(port)
    env["ARIA_NO_PORT_KILL"] = "1"
    env["ARIA_USER_DATA_DIR"] = tmp_dir
    base_url = f"http://127.0.0.1:{port}/index.html"

    log_f = open(log_path, "w+", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "server.py")],
        cwd=ROOT,
        env=env,
        stdout=log_f,
        stderr=subprocess.STDOUT,
    )
    try:
        ready, probe_err = wait_server(base_url, timeout=15.0)
        if not ready:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
            log_f.flush()
            log_f.seek(0)
            text = log_f.read()
            raise RuntimeError(f"isolated server failed to start on {base_url} ({probe_err})\n--- server output ---\n{text[-1500:]}")
        run_tests(base_url)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        log_f.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    failed = [r for r in RESULTS if not r[1]]
    print(f"\nSUMMARY: {len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
