# -*- coding: utf-8 -*-
"""汽水音乐（字节 / 抖音系）接入回归：搜索源按钮、取链分支、设置页第四个自建卡片。

接入形状与 QQ/网易/酷狗三个自建平台**不同**，这些差异就是本用例要钉住的东西：
  · 汽水只有**本机自建 vendor** 一条路（ly-music-source 库 + scripts/qishui-server.mjs
    适配层，端口 3300），没有可回退的公网源 —— 搜索失败必须**明确报错**，
    绝不能像 QQ/网易那样静默换源；
  · 搜索 / 逐字歌词**匿名可用**，只有播放需要扫码登录；
  · 音频是**加密字节**不是 URL：vendor 解密后前端当普通 URL 用
    （→ getStreamCachedAudioUrl → /api/audio/stream 的 Range + 磁盘缓存链路原样复用）；
  · 汽水**没有平台启用开关**（搜索与播放只有本机这一条路，开关盖不到任何分支），
    也**没有手动填 Cookie**（登录会话由 vendor 自己落盘，粘 cookie 无从注入）。

回归点：
 1. 搜索弹窗第 4 个音源按钮 data-source="qishui"，点击后占位符切到「搜索汽水音乐歌曲...」；
 2. playSource 层：qishui/soda/qs 三个别名都归一，且 source:'qishui' 不被 stale 全局源劫持；
 3. selfhostQishuiPlayUrl 在副进程离线 / 未登录时返回 null（交给跨源兜底）而不是抛；
 4. 设置页自建区块 4 个 tab，汽水卡片无开关、无 Cookie 输入框，但有会话说明；
 5. qishuiLinesToKrc → parseKrc 往返（浏览器内真实模块图，而非 node 单测的复刻）；
 6. 搜索链路：在线必须出结果；离线必须给出「需本机自建服务在线」的明确提示；
 7. 扫码轮询的两条可见性契约（回归「扫了码没反应」）：后端 ok:false 时前端必须
    显式报错并继续重试（不得兜底成「等待扫码…」、不得 stopPoll）；scanned 状态下
    必须优先透出 vendor 的 progress message（否则手机已确认、界面还停在「已扫码」）；
 8. 每日推荐栏必须出现第 4 个 tab（汽水）；点开要么出歌，要么给
    「本机汽水服务未就绪」——汽水没有平台开关，「去设置里启用」的引导对它是错的；
 9. 歌单页必须有汽水入口；后端 200+{ok:false,code:'UNAUTHENTICATED'} 必须映射成
    「未登录」而不是「该账号暂无歌单」（后者会让用户以为账号是空的、不会去登录）；
10. 全程无新增致命控制台错误。

运行前提：python server.py 已在 :8001 启动。
"""
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""), flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    try:
        page.wait_for_function(
            "() => { const v = document.documentElement.style.getPropertyValue('--aria-accent');"
            " return !!v && v.trim() !== ''; }",
            timeout=30000)
    except Exception as e:
        check("app-boot-marker", False, str(e)[:120])
    page.wait_for_timeout(1500)
    page.evaluate("""() => {
        document.getElementById('welcomeOverlay')?.classList.remove('visible');
        document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
    }""")

    # ---------- 1. 搜索弹窗音源按钮 ----------
    src = page.evaluate("""() => {
        const btns = Array.from(document.querySelectorAll('#searchOverlay .source-btn[data-source]'));
        const q = document.querySelector('#searchOverlay .source-btn[data-source="qishui"]');
        return { all: btns.map(b => b.dataset.source), qText: q ? q.textContent.trim() : null };
    }""")
    check("qishui-btn-exists", src["qText"] is not None, src)
    check("qishui-btn-label", src["qText"] == "汽水音乐", src["qText"])
    # ★ 2026-10-03：酷我（第 4 个按钮）已从搜索里摘掉入口 → 音源按钮由 5 个变 4 个。
    check("search-source-btns-4", len(src["all"]) == 4, src["all"])
    check("qishui-btn-is-last", src["all"][-1:] == ["qishui"], src["all"])

    # ---------- 2. 点击切换：active 唯一 + 占位符 ----------
    sw = page.evaluate("""() => {
        document.getElementById('searchOverlay').classList.add('visible');
        const q = document.querySelector('#searchOverlay .source-btn[data-source="qishui"]');
        q.click();
        const inp = document.getElementById('searchInput');
        const active = document.querySelector('#searchOverlay .source-btn.active');
        return {
            activeSrc: active ? active.dataset.source : null,
            activeCount: document.querySelectorAll('#searchOverlay .source-btn.active').length,
            placeholder: inp ? inp.placeholder : null,
        };
    }""")
    check("qishui-click-becomes-active", sw["activeSrc"] == "qishui", sw)
    check("qishui-click-single-active", sw["activeCount"] == 1, sw)
    check("qishui-placeholder", sw["placeholder"] == "搜索汽水音乐歌曲...", sw["placeholder"])

    # ---------- 3. playSource 纯函数层 ----------
    pure = page.evaluate("""async () => {
        const m = await import('/src/services/playSource.js');
        const ch = m.channelMeta('selfhostQishui') || null;
        return {
            alias_qishui: m.platformKeyOf('qishui'),
            alias_soda: m.platformKeyOf('soda'),
            alias_qs: m.platformKeyOf('qs'),
            branch_keeps_qishui: m.resolveSourceOf({ source: 'qishui' }, 'tencent'),
            branch_overrides_stale: m.resolveSourceOf({ source: 'qishui' }, 'kugou'),
            inResolveSources: m.RESOLVE_SOURCES ? m.RESOLVE_SOURCES.has('qishui') : 'no-RESOLVE_SOURCES',
            channel: ch,
        };
    }""")
    check("alias-qishui", pure["alias_qishui"] == "qishui", pure["alias_qishui"])
    check("alias-soda", pure["alias_soda"] == "qishui", pure["alias_soda"])
    check("alias-qs", pure["alias_qs"] == "qishui", pure["alias_qs"])
    check("branch-qishui-not-hijacked", pure["branch_keeps_qishui"] == "qishui", pure["branch_keeps_qishui"])
    check("branch-qishui-overrides-stale-global", pure["branch_overrides_stale"] == "qishui", pure["branch_overrides_stale"])
    check("qishui-in-RESOLVE_SOURCES", pure["inResolveSources"] is True,
          "若为 False，qishui 会被当未知源丢给 vkeys /qishui（该端不存在）")
    ch = pure["channel"] or {}
    check("channel-selfhostQishui-registered",
          ch.get("platform") == "汽水音乐" and ch.get("tier") == "selfhost", ch)

    # ---------- 4. selfhost-runtime：取链回退语义 ----------
    rt = page.evaluate("""async () => {
        const m = await import('/src/app/selfhost-runtime.js');
        const out = { hasFn: typeof m.selfhostQishuiPlayUrl === 'function' };
        if (!out.hasFn) return out;
        try {
            out.emptyId = await m.selfhostQishuiPlayUrl('');
            out.notLoggedIn = await m.selfhostQishuiPlayUrl('7400000000000000001');
            out.returnedType = typeof out.notLoggedIn;
        } catch (e) { out.threw = String(e); }
        return out;
    }""")
    check("selfhostQishuiPlayUrl-exported", rt.get("hasFn") is True, rt)
    check("selfhostQishuiPlayUrl-empty-id-null", rt.get("emptyId") is None, rt)
    check("selfhostQishuiPlayUrl-not-logged-in-null-no-throw",
          rt.get("threw") is None and rt.get("notLoggedIn") is None, rt)

    # ---------- 5. 歌词：qishuiLinesToKrc → parseKrc 往返 ----------
    # vendor 行式：{ timeMs, text, words:[{ timeMs, text }] }，词时长由下一个词 / 下一行推算
    lyric = page.evaluate("""async () => {
        const { qishuiLinesToKrc } = await import('/src/services/musicApi.js');
        const { parseKrc } = await import('/src/services/krcParser.js');
        const lines = [
            { timeMs: 1000, words: [ { timeMs: 1000, text: '甲' }, { timeMs: 1400, text: '乙' } ] },
            { timeMs: 2000, words: [ { timeMs: 2000, text: '丙' } ] },
        ];
        const krc = qishuiLinesToKrc(lines);
        const parsed = parseKrc(krc);
        const w0 = parsed[0] ? (parsed[0].words || []).map(w => [w.text, w.start, w.end]) : null;
        return {
            krc,
            n: parsed.length,
            original0: parsed[0] ? parsed[0].original : null,
            start0: parsed[0] ? parsed[0].start : null,
            words0: w0,
            start1: parsed[1] ? parsed[1].start : null,
        };
    }""")
    # 乙 的起始是相对行首 1400-1000=400（不是 600）；600 是它到下一行 2000 的时长
    check("krc-emit-exact", lyric["krc"] == "[1000,1000]<0,400,0>甲<400,600,0>乙\n[2000,800]<0,800,0>丙",
          repr(lyric["krc"]))
    check("krc-roundtrip-line-count", lyric["n"] == 2, lyric)
    check("krc-roundtrip-text", lyric["original0"] == "甲乙", lyric["original0"])
    check("krc-roundtrip-line0-abs-start", lyric["start0"] == 1000, lyric["start0"])
    check("krc-roundtrip-line1-abs-start", lyric["start1"] == 2000, lyric["start1"])
    check("krc-roundtrip-word-abs-times", lyric["words0"] == [["甲", 1000, 1400], ["乙", 1400, 2000]],
          lyric["words0"])

    # ---------- 6. 设置页自建区块：4 tab + 汽水卡片形态 ----------
    panel = page.evaluate("""async () => {
        const m = await import('/src/app/selfhost-settings.js');
        const host = document.getElementById('selfhostContainer');
        if (!host) return { err: 'no #selfhostContainer' };
        /* 真机路径：设置面板切到「自建服务」分区时会调 initSelfhostSection；
           这里直接调导出函数，避开分区切换的动效等待 */
        m.initSelfhostSection();
        await new Promise(r => setTimeout(r, 200));
        const tabs = Array.from(host.querySelectorAll('.setting-btn[data-sname]'));
        const names = tabs.map(b => b.dataset.sname);
        const qTab = tabs.find(b => b.dataset.sname === 'qishui');
        if (qTab) qTab.click();
        /* ★ showTab 走的是 renderTabBody(..., undefined) → 内部 getStatus().then() 异步
           渲染。固定 sleep 会在慢机器/dev 首启时抢跑，拿到空面板 —— 那样「无开关/无输入框」
           会**假绿**（空 DIV 当然两个都没有）。这里必须轮询到面板真出现再断言。 */
        const bodyWrap = host.lastElementChild || host;
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            if (bodyWrap.textContent && bodyWrap.textContent.includes('登录状态')) break;
            await new Promise(r => setTimeout(r, 250));
        }
        return {
            names,
            qTabLabel: qTab ? qTab.textContent.trim() : null,
            panelText: bodyWrap.textContent || '',
            rendered: !!(bodyWrap.textContent && bodyWrap.textContent.includes('登录状态')),
            hasToggle: !!bodyWrap.querySelector('.setting-toggle'),
            hasLoginBtn: !!bodyWrap.querySelector('.setting-btn'),
            hasInput: !!bodyWrap.querySelector('input'),
        };
    }""")
    if panel.get("err"):
        check("selfhost-section-mounted", False, panel["err"])
    else:
        check("selfhost-section-mounted", True, "")
        check("selfhost-tabs-4", panel["names"] == ["kugou", "qq", "netease", "qishui"], panel["names"])
        check("qishui-tab-label", panel["qTabLabel"] == "汽水音乐", panel["qTabLabel"])
        check("qishui-panel-rendered", panel["rendered"] is True and panel["hasLoginBtn"] is True,
              panel["panelText"][:120])
        check("qishui-panel-no-toggle", panel["hasToggle"] is False,
              "开关对汽水盖不到任何分支，必须不渲染")
        check("qishui-panel-no-cookie-input", panel["hasInput"] is False,
              "汽水会话由 vendor 落盘，cookie 输入框必然是误导")
        check("qishui-panel-session-note", "登录会话由本机服务保管" in panel["panelText"],
              panel["panelText"][:160])

    # ---------- 6.5 扫码轮询：失败必须显式报错、进度必须透出 ----------
    # ★ 回归用户 2026-10-03 的「扫了码没反应」。
    #   用 fetch 打桩直接驱动弹窗，不依赖副进程在不在——本节的被测对象是前端对
    #   {ok:false,err} 与 scanned+message 的处理，与 vendor 是否可用无关（CI 里
    #   _eval/ 不装 vendor，打桩才能让这条回归在 CI 上也真跑）。
    qr_front = page.evaluate("""async () => {
        const host = document.getElementById('selfhostContainer');
        const bodyWrap = host && host.lastElementChild;
        if (!bodyWrap) return { err: 'no panel' };
        const btn = Array.from(bodyWrap.querySelectorAll('.setting-btn'))
            .find(b => b.textContent.trim() === '扫码登录');
        if (!btn) return { err: 'no login btn' };

        const realFetch = window.fetch.bind(window);
        const stub = { mode: 'error', err: '探针：汽水服务未就绪', msg: '', checkCalls: 0 };
        const json = (o) => new Response(JSON.stringify(o),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = (url, opts) => {
            const u = String(url);
            if (u.indexOf('/api/selfhost/qishui/qr') >= 0) {
                return Promise.resolve(json({ ok: true, platform: 'qishui', key: 'stub-token',
                    img: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', hint: 'STUB' }));
            }
            if (u.indexOf('/api/selfhost/qishui/check') >= 0) {
                stub.checkCalls++;
                if (stub.mode === 'error') return Promise.resolve(json({ ok: false, err: stub.err }));
                return Promise.resolve(json({ ok: true, loggedIn: false, status: 'scanned', message: stub.msg }));
            }
            return realFetch(url, opts);
        };
        const hintOf = () => {
            const h = document.getElementById('selfhostQrHint');
            return h ? h.textContent.trim() : null;
        };

        /* 副进程离线时登录按钮是 disabled 的（那是无关此 bug 的 UI 守卫），
           这里强制解开，好让点击真正走到轮询逻辑。 */
        btn.disabled = false;
        btn.click();

        let t0 = Date.now();
        while (Date.now() - t0 < 6000 && !(hintOf() || '').includes('探针')) {
            await new Promise(r => setTimeout(r, 150));
        }
        const onError = hintOf();
        const callsAfterError = stub.checkCalls;

        /* 切换成「已扫码待确认」，并带上 vendor 的进度文案：
           这一条是「手机确认了但界面停住」的直接回归。 */
        stub.mode = 'ok';
        stub.msg = '手机已确认，正在等待下发 Cookie（请勿刷新）…';
        t0 = Date.now();
        while (Date.now() - t0 < 9000 && !(hintOf() || '').includes('手机已确认')) {
            await new Promise(r => setTimeout(r, 150));
        }
        const onScanned = hintOf();
        const keptPolling = stub.checkCalls > callsAfterError;

        /* 走真正的关闭路径（stopPoll + 清 qrState），别让轮询泄漏到后续小节 */
        document.getElementById('selfhostQrCloseBtn')?.click();
        window.fetch = realFetch;
        return { onError, onScanned, keptPolling, checkCalls: stub.checkCalls };
    }""")
    if qr_front.get("err"):
        check("qishui-qr-front-harness", False, qr_front["err"])
    else:
        check("qishui-qr-error-surfaced",
              "探针：汽水服务未就绪" in (qr_front["onError"] or ""),
              "ok:false 必须显式报错；旧实现不带 status 就会掉进 describeStatus 兜底、"
              "显示成「等待扫码…」，扫码后即表现为没反应。got=%r" % qr_front["onError"])
        check("qishui-qr-error-keeps-polling", qr_front["keptPolling"] is True,
              "可恢复失败必须继续轮询（不得 stopPoll），否则一次抖动就废掉整次扫码")
        check("qishui-qr-progress-message-shown",
              "手机已确认" in (qr_front["onScanned"] or ""),
              "vendor 的 message 是唯一进度来源，不能被 status 硬编码文案吃掉。got=%r"
              % qr_front["onScanned"])

    # ---------- 6.6 每日推荐：第 4 个 tab（汽水）+ 推荐流 ----------
    # ★ 汽水的「日推」= 字节推荐流 /luna/pc/feed/song-tab，**匿名可用**且没有平台开关。
    #   这里的契约是「它必须出现在日推栏里、点开能出歌」—— 若本机没有 vendor
    #   （CI 不装 _eval/），必须走「本机汽水服务未就绪」这条明确分支，
    #   而不是悄悄少一个 tab（那才是真回归）。
    daily = page.evaluate("""async () => {
        document.getElementById('openDailyBtn').click();
        await new Promise(r => setTimeout(r, 500));
        const tabs = Array.from(document.querySelectorAll('#rankTabs .source-btn'));
        const names = tabs.map(b => b.dataset.daily);
        const q = tabs.find(b => b.dataset.daily === 'qishui');
        /* ★ 探针失败字段刻意不叫 err：下面 out 里的 err 是**页面上那条合法的离线提示**
           （"本机汽水服务未就绪"），两者同名会把「无 vendor 时的正确降级」误判成失败
           —— CI（无 _eval/）一直红在这条上。 */
        if (!q) return { probeErr: 'no qishui daily tab', names };
        const qLabel = q.textContent.trim();
        q.click();
        await new Promise(r => setTimeout(r, 9000));
        const rows = Array.from(document.querySelectorAll('#rankList .result-item'));
        const errEl = document.querySelector('#rankList .rank-error');
        const out = {
            names, qLabel, rows: rows.length,
            err: errEl ? errEl.textContent.trim() : null,
            pageTitle: (document.getElementById('rankPageTitle') || {}).textContent,
        };
        document.getElementById('rankingsOverlay')?.classList.remove('visible');
        return out;
    }""")
    if daily.get("probeErr"):
        check("qishui-daily-tab-exists", False, daily["probeErr"])
    else:
        check("qishui-daily-tab-exists", daily["names"] == ["qq", "kugou", "netease", "qishui"],
              "dailySrcOrder 必须含汽水且追加在末位。got=%s" % daily["names"])
        check("qishui-daily-tab-label", daily["qLabel"] == "汽水音乐", daily["qLabel"])
        if daily["rows"] > 0:
            check("qishui-daily-feed-returns-rows", True, "rows=%d" % daily["rows"])
        elif "本机汽水服务未就绪" in (daily["err"] or ""):
            # 无 vendor 的机器（CI）：这条分支本身就是要被钉住的行为 ——
            # 汽水没有平台开关，"去设置里启用" 的引导对它是错的。
            check("qishui-daily-offline-explicit", True, "offline -> %s" % (daily["err"] or "")[:90])
        else:
            check("qishui-daily-outcome-recognized", False,
                  "rows=0 且不是明确的离线提示：err=%r" % (daily["err"],))

    # ---------- 6.7 歌单页：汽水入口（我的歌单 / 未登录不得伪装成空账号）----------
    # ★ 两个契约：
    #   ① 歌单页必须有汽水入口，点进去渲染平台歌单卡片；
    #   ② 未登录时后端回 200 + {ok:false,code:'UNAUTHENTICATED'}（不是 HTTP 错误！），
    #      前端若只看 res.ok 就会渲染成「该账号暂无歌单」—— 用户会以为账号是空的，
    #      根本不会想到去登录。所以这里用打桩把这条分支单独钉住。
    pl = page.evaluate("""async () => {
        const realFetch = window.fetch.bind(window);
        const json = (o) => new Response(JSON.stringify(o),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        const stub = { mode: 'ok' };
        window.fetch = (url, opts) => {
            const u = String(url);
            if (u.indexOf('/api/selfhost/status') >= 0) {
                return Promise.resolve(json({ qishui: { label: '汽水', alive: true, loggedIn: true,
                    uid: 'stub-uid', hasSource: true } }));
            }
            if (u.indexOf('/api/selfhost/qishui/proxy') >= 0) {
                const target = decodeURIComponent(u.split('path=')[1] || '');
                if (target.indexOf('/playlists') === 0) {
                    if (stub.mode === 'unauth') {
                        return Promise.resolve(json({ ok: false, code: 'UNAUTHENTICATED',
                            err: 'Qishui session required' }));
                    }
                    return Promise.resolve(json({ ok: true, playlists: [
                        { id: '111', name: '探针歌单甲', cover: '', count: 12 },
                        { id: '222', name: '探针歌单乙', cover: '', count: 34 },
                    ] }));
                }
                if (target.indexOf('/playlist?') === 0) {
                    return Promise.resolve(json({ ok: true, name: '探针歌单甲', songs: [
                        { id: '9001', title: '探针曲一', artists: [{ name: '探针歌手' }], coverUrl: '' },
                    ] }));
                }
            }
            return realFetch(url, opts);
        };

        const rt = await import('/src/app/selfhost-runtime.js');
        await rt.fetchStatus(true);                       /* 让登录态缓存先就位 */
        const pmod = await import('/src/app/130-playlists.js');

        /* ① 先测「未登录」：首次进入没有缓存卡片，失败必须给出明确原因。
           （顺序不能反：renderSelfPlatList 是缓存优先的 —— 已有卡片时后台刷新失败
             会被静默忽略、不覆盖成错误态。那是四平台共用的既有设计，不是汽水特有；
             这里要钉的是「没有缓存时的失败呈现」，所以放在第一次访问。） */
        /* ★ 等「打桩状态真的落到入口上」再点（原来是死等 900ms）：
           入口能否点击由 selfPlatMetaCache 决定，而它由后台 _refreshPlaylistDynamic
           异步填充；无 vendor 的机器上 /api/selfhost/status 要十几秒，900ms 常落在
           「缓存还没填」或「旧响应正覆盖新状态」的窗口里 —— 点下去会被「未登录」闸门
           挡掉，表现成「卡片空、也没有报错」这种极难定位的失败（CI 上就红在这里）。
           最多等 2s、命中即早退；等待结果与点击瞬间的入口状态都回传，失败能直接看出因。 */
        const waitEntryStubState = async () => {
          for (let i = 0; i < 20; i++) {
            const e = document.querySelector('#playlistsList .selfplat-entry[data-selfplat="qishui"]');
            const meta = (e && (e.querySelector('.playlist-meta') || {}).textContent) || '';
            if (e && !e.classList.contains('selfplat-off') && /我的/.test(meta)) return true;
            await new Promise(r => setTimeout(r, 100));
          }
          return false;
        };

        stub.mode = 'unauth';
        pmod.renderPlaylistsView();
        const stubStateOk = await waitEntryStubState();
        const entry = document.querySelector('#playlistsList .selfplat-entry[data-selfplat="qishui"]');
        if (!entry) { window.fetch = realFetch; return { err: 'no qishui selfplat entry' }; }
        const offClass = entry.classList.contains('selfplat-off');
        const metaBefore = (entry.querySelector('.playlist-meta') || {}).textContent || '';

        entry.click();
        let t0 = Date.now();
        while (Date.now() - t0 < 6000
               && !document.querySelector('#playlistsList .rank-error')
               && document.querySelectorAll('#playlistsList .rank-board-card').length === 0) {
            await new Promise(r => setTimeout(r, 150));
        }
        const unauthEl = document.querySelector('#playlistsList .rank-error');
        const unauthText = unauthEl ? unauthEl.textContent.trim() : null;
        const unauthProbe = {
          hasError: !!unauthEl,
          cards: document.querySelectorAll('#playlistsList .rank-board-card').length,
          skeleton: !!document.querySelector('#playlistsList .skeleton'),
          offAtClick: offClass,
          inner: ((document.getElementById('playlistsList') || {}).innerHTML || '')
              .replace(/\s+/g, ' ').slice(0, 150),
        };

        /* ② 再切回「已登录」：回到列表重新进入，应渲染平台歌单卡片 */
        stub.mode = 'ok';
        pmod.renderPlaylistsView();
        await waitEntryStubState();
        const entry2 = document.querySelector('#playlistsList .selfplat-entry[data-selfplat="qishui"]');
        if (entry2) entry2.click();
        t0 = Date.now();
        while (Date.now() - t0 < 6000
               && document.querySelectorAll('#playlistsList .rank-board-card').length === 0
               && !document.querySelector('#playlistsList .rank-error')) {
            await new Promise(r => setTimeout(r, 150));
        }
        const cards = Array.from(document.querySelectorAll('#playlistsList .rank-board-card'))
            .map(c => ((c.querySelector('.rank-board-name') || {}).textContent || '').trim());
        const createdByCount = (document.querySelector('#playlistsList .rank-board-count') || {}).textContent || '';
        const okProbe = {
          hasError: !!document.querySelector('#playlistsList .rank-error'),
          errorText: ((document.querySelector('#playlistsList .rank-error') || {}).textContent || '').slice(0, 80),
          skeleton: !!document.querySelector('#playlistsList .skeleton'),
        };

        document.getElementById('playlistsCloseBtn')?.click();
        window.fetch = realFetch;
        return { offClass, metaBefore, cards, createdByCount, unauthText,
                 stubStateOk, unauthProbe, okProbe };
    }""")
    if pl.get("err"):
        check("qishui-selfplat-entry-exists", False, pl["err"])
    else:
        check("qishui-selfplat-entry-exists", True, "meta=%r off=%s" % (pl["metaBefore"], pl["offClass"]))
        check("qishui-selfplat-entry-logged-in", pl["offClass"] is False,
              "状态缓存为已登录时入口不得置灰。meta=%r" % pl["metaBefore"])
        # ★ 失败信息里带上诊断：这段过去失败时只报一个 [] 或 None，看不出是
        #   「状态没落到入口（闸门挡掉点击）」还是「渲染了但映射错」。
        check("qishui-selfplat-cards-rendered",
              pl["cards"][:2] == ["探针歌单甲", "探针歌单乙"],
              "cards=%s ｜ 点击前状态就位=%s ｜ 点击后=%s"
              % (pl["cards"], pl.get("stubStateOk"), pl.get("okProbe")))
        check("qishui-selfplat-card-count", "12" in (pl["createdByCount"] or ""),
              "count=%r" % pl["createdByCount"])
        check("qishui-playlists-unauth-explicit",
              "未登录" in (pl["unauthText"] or ""),
              "后端 200+{ok:false,UNAUTHENTICATED} 必须映射成「未登录」，"
              "否则渲染成空账号、用户不会去登录。got=%r ｜ %s"
              % (pl["unauthText"], pl.get("unauthProbe")))
        check("qishui-playlists-no-fake-empty",
              "暂无歌单" not in (pl["unauthText"] or ""),
              "未登录不得显示成「该账号暂无歌单」。got=%r" % pl["unauthText"])

    # ---------- 7. 预热：等副进程就绪（首启需一次 npm 库加载 + 端口监听）----------
    # ★ 不做硬断言：CI 不跑 setup-vendors.bat（_eval/ 整个目录被 gitignore），
    #   副进程永远起不来。这里只探测「本机是否具备 vendor」，决定第 8 节走哪条分支。
    warm = page.evaluate("""async () => {
        const t0 = Date.now();
        let last = null, lastHasSource = false;
        while (Date.now() - t0 < 25000) {
            try {
                const r = await fetch('/api/selfhost/status');
                const j = await r.json();
                last = j && j.qishui ? j.qishui : null;
                if (last) lastHasSource = !!last.hasSource;
                if (last && last.alive) return { alive: true, hasSource: last.hasSource, ms: Date.now() - t0, st: last };
            } catch (e) { /* 继续轮询 */ }
            await new Promise(r => setTimeout(r, 1200));
        }
        return { alive: false, hasSource: lastHasSource, ms: Date.now() - t0, st: last };
    }""")
    print("INFO vendor alive=%s hasSource=%s upped_in=%sms  %s"
          % (warm.get("alive"), warm.get("hasSource"), warm.get("ms"), warm.get("st")), flush=True)

    # ---------- 8. 汽水搜索链路：在线出结果 / 离线明确报错且不静默换源 ----------
    live = page.evaluate("""async () => {
        document.getElementById('searchOverlay').classList.add('visible');
        const q = document.querySelector('#searchOverlay .source-btn[data-source="qishui"]');
        q.click();
        const inp = document.getElementById('searchInput');
        inp.value = '牵丝戏';
        document.getElementById('searchBtn').click();
        await new Promise(r => setTimeout(r, 9000));
        const hint = document.getElementById('searchHint');
        const items = Array.from(document.querySelectorAll('#searchResults .result-item'));
        const firstTitle = items[0] ? (items[0].querySelector('.result-title') || {}).textContent : null;
        /* ★ 真源判定读归一化后的缓存，而不是 DOM：结果条目上没有 data-source 属性。
           goToSearchPage 把 fetchSourcePage 的返回值原样写进 searchPageCache.qishui.pages[1]，
           所以这里的 source 字段就是「这条结果到底是哪个源的」的直接读数。 */
        const cache = (globalThis.searchPageCache || {}).qishui;
        const page1 = (cache && cache.pages) ? (cache.pages[1] || []) : [];
        return {
            hint: hint ? hint.textContent.trim() : null,
            rows: items.length,
            firstTitle,
            cached: page1.length,
            cachedSources: Array.from(new Set(page1.map(i => (i && i.source) || ''))),
        };
    }""")
    hint_txt = live.get("hint") or ""
    if warm.get("alive"):
        check("qishui-search-live-returns-results", live["rows"] > 0,
              "rows=%d first=%s hint=%s" % (live["rows"], live.get("firstTitle"), hint_txt))
        check("qishui-results-all-tagged-qishui",
              live["cached"] > 0 and live["cachedSources"] == ["qishui"],
              "cached=%d sources=%s" % (live["cached"], live["cachedSources"]))
    else:
        # 副进程不在的机器（含 CI）：这条路必须**明确报错**，绝不能像 QQ/网易那样静默换源
        check("qishui-offline-explicit-error", "需本机自建服务在线" in hint_txt,
              "rows=%d hint=%s" % (live["rows"], hint_txt))
        check("qishui-offline-no-silent-cross-source", live["rows"] == 0 and live["cached"] == 0,
              "rows=%d cached=%d" % (live["rows"], live["cached"]))

    # ---------- 9. 控制台错误 ----------
    noise = ("favicon", "net::", "404", "CORS", "blocked by CORS", "Access to image",
             "Failed to load resource", "加载歌曲出错", "音频错误", "DEMUXER", "audio_load_error",
             "Failed to fetch", "ERR_", "汽水音乐搜索暂无结果")
    fatal = [e for e in console_errors if not any(k in e for k in noise)]
    check("no-fatal-console-errors", len(fatal) == 0, "; ".join(fatal[:4]))

    try:
        browser.close()
    except Exception:
        pass

failed = [r for r in RESULTS if not r[1]]
print()
print("=" * 52)
print("TOTAL:", len(RESULTS), " PASS:", len(RESULTS) - len(failed), " FAIL:", len(failed))
for n, _, d in failed:
    print("  FAILED", n, d)
sys.exit(1 if failed else 0)
