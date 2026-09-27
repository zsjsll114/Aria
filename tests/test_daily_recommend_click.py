"""日推歌曲卡片：能渲染出标题、点得动、并且把 mid/hash 带到取链层。

用户反馈：「每日推荐的歌曲卡片点不动」。两层原因：
1. playRankSong 原先收的是下标并回查 rankState.boards[boardIdx]，而日推视图从不设 boardIdx
   （初值 -1）→ 取到 undefined 就静默 return；
2. 三处「自建条目 → 播放条目」的映射各写一份且把 mid/hash 全丢了 → QQ 条目只剩
   id=mid，取链时先拿 mid 当数字 id 去反查元数据（慢），酷狗条目直接缺 hash。
断言用假日推接口喂进去，所以不依赖登录态与网络。
"""
import json
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []

NETEASE_DAILY = {"code": 200, "data": {"dailySongs": [
    {"id": 111, "name": "日推网易曲", "ar": [{"name": "歌手甲"}],
     "al": {"name": "专辑甲", "picUrl": ""}, "duration": 200000},
]}}
# QQ 日推走「热门歌单聚合」：先列单、再逐单取详情，两个接口同一个前缀，必须按 URL 分流
QQ_LISTS = {"response": {"code": 0, "data": {"list": [{"dissid": 777, "title": "热门歌单"}]}}}
QQ_DETAIL = {"response": {"code": 0, "data": {"cdlist": [{"songlist": [
    {"mid": "QQMIDTEST01", "title": "日推QQ曲", "singer": [{"name": "歌手乙"}],
     "album": {"name": "专辑乙", "pmid": "PMID1"}},
]}]}}}


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:220] if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        hits = {"qqmeta": [], "selfhost": []}

        def route_handler(path, status, body):
            def h(route):
                route.fulfill(status=status, body=json.dumps(body),
                              content_type="application/json")
            return h

        page.route("**/api/selfhost/status",
                   route_handler("", 200, {"netease": {"alive": True, "logged_in": True},
                                           "qq": {"alive": True, "logged_in": True},
                                           "kugou": {"alive": True, "logged_in": True}}))
        page.route("**/api/selfhost/netease/proxy**", route_handler("", 200, NETEASE_DAILY))
        page.route("**/api/selfhost/kugou/proxy**", route_handler("", 500, {"err": "off"}))

        # QQ 日推走「热门歌单聚合」：列单与取详情共用同一个 /qq/proxy 前缀，只能按 query 分流
        def qq_router(route):
            url = route.request.url
            body = QQ_DETAIL if "getSongListDetail" in url else QQ_LISTS
            route.fulfill(status=200, body=json.dumps(body), content_type="application/json")
        page.route("**/api/selfhost/qq/proxy**", qq_router)

        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2200)
        page.evaluate("""() => {
            document.getElementById('welcomeOverlay')?.classList.remove('visible');
            document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
            localStorage.setItem('selfhost_prefs', JSON.stringify(
                { enabled: { kugou: false, qq: true, netease: true }, dailySource: 'netease' }));
        }""")

        # —— 1. 日推大列表：卡片必须有标题（原先 s.song 取不到 name → 整行空标题）——
        page.evaluate("() => Aria.__openDefaultPlaylistView()")
        page.wait_for_timeout(1500)
        rows = page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            return Array.from(list.querySelectorAll('.result-item')).map(el => ({
                title: (el.querySelector('.result-title') || {}).textContent || '',
                artist: (el.querySelector('.result-artist') || {}).textContent || '',
                i: el.dataset.i,
            }));
        }""")
        check("daily-rows-rendered", len(rows) >= 2, rows)
        check("daily-rows-have-titles", all(r["title"].strip() for r in rows), rows)
        check("daily-rows-have-artists", all(r["artist"].strip() for r in rows), rows)

        # —— 2. 点卡片：必须真的走到取链（原先静默 return） ——
        # 订阅必须 await 完再点，否则 onResolveChange 还没挂上就错过了 beginResolveTrace
        page.evaluate("""async () => {
            window.__traceKeys = [];
            const m = await import('/src/services/playSource.js');
            m.onResolveChange(t => window.__traceKeys.push((t && t.songKey) || ''));
        }""")
        page.evaluate("""() => {
            const list = document.getElementById('playlistsList');
            const el = list.querySelector('.result-item');
            el.scrollIntoView();
            el.click();
        }""")
        page.wait_for_timeout(1200)
        clicked = page.evaluate("""() => ({
            keys: window.__traceKeys || [],
            hist: JSON.parse(localStorage.getItem('aria_recent_history') || '[]'),
            title: (document.getElementById('songTitle') || {}).textContent,
        })""")
        check("daily-click-starts-resolve", len(clicked["keys"]) >= 1, clicked["keys"])
        check("daily-click-records-history", len(clicked["hist"]) >= 1, clicked["hist"])
        check("daily-history-not-unknown",
              bool(clicked["hist"]) and "未知" not in (clicked["hist"][0].get("title") or ""),
              clicked["hist"][:1])

        # —— 3. mid 必须带到取链层：键是 tencent:<id>，且不再拿 mid 去反查数字 id ——
        check("qq-or-netease-key-carries-identity",
              any(k.startswith("tencent:") or k.startswith("netease:") for k in clicked["keys"]),
              clicked["keys"])

        # —— 4. 日推 tab 与歌单大列表共用同一个映射（三处收敛成一个 toPlayItem）：
        #        点 QQ 那一行，trace 键必须是 tencent: 前缀（source:'qq' 的别名归一 + mid 带过去了）
        page.evaluate("""() => {
            window.__traceKeys = [];
            const list = document.getElementById('playlistsList');
            const items = list.querySelectorAll('.result-item');
            const qq = Array.from(items).find(e => (e.querySelector('.result-title')||{}).textContent === '日推QQ曲');
            if (qq) qq.click();
        }""")
        page.wait_for_timeout(1200)
        qq_keys = page.evaluate("() => window.__traceKeys || []")
        check("qq-daily-routes-to-tencent-branch",
              any(k.startswith("tencent:") for k in qq_keys), qq_keys)

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
