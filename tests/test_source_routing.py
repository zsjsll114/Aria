"""取链分支的音源判定 + 标题字段归一（用户反馈：日推/自建来源的歌显示「未知歌曲」、加载慢、历史记两遍）。

回归点：
1. source:'qq'（自建服务返回值）必须走 QQ 分支，不能因为全局 currentSource 不是 'tencent' 就被塞错分支；
2. source:'netease' 的歌即使全局停在 'tencent' 也必须走网易分支；
3. 只带 name 没有 song 字段的条目，标题栏不能出现「未知歌曲」；
4. 同一首歌经 258 与 175 两条路径记录后，历史里只能有一条。
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8001/index.html"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + str(detail)[:200] if detail else ""))


JS_BOOT = """async (arg) => {
    const out = { steps: [] };
    const mod = await import('/src/app/175-track-index-online.js');
    const loadOnlineSong = mod.loadOnlineSong;
    const ps = await import('/src/services/playSource.js');
    if (typeof loadOnlineSong !== 'function') { out.err = 'no loadOnlineSong export'; return out; }
    /* beginResolveTrace 在任何网络请求之前跑，所以每条轨迹的 songKey 就是分支判定的
       直接读数——比事后读 getTrace() 准：取链失败会自动重试并改写 trace，
       实测一条假 id 会串到 kugou/crossNetease 上去。
       playSource 只有 onResolveChange 没有 off，所以常驻一个订阅、按当前桶归集。 */
    let bucket = null;
    ps.onResolveChange(t => { if (bucket) bucket.push((t && t.songKey) || ''); });
    for (const song of arg.songs) {
        const keys = [];
        bucket = keys;
        const t0 = performance.now();
        /* preloadOnly=true：完整跑取链分支但不真的播放 */
        try { await loadOnlineSong(song.info, true, false, true); } catch (e) { out.lastErr = String(e); }
        bucket = null;
        out.steps.push({
            tag: song.tag,
            ms: Math.round(performance.now() - t0),
            keys,
            title: (document.getElementById('songTitle') || {}).textContent,
            artist: (document.getElementById('songArtist') || {}).textContent,
        });
    }
    return out;
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(URL, wait_until="load")
        try:
            page.wait_for_function(
                "() => { const v = document.documentElement.style.getPropertyValue('--theme-color'); return !!v && v.trim() !== ''; }",
                timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(2500)
        page.evaluate("""() => {
            document.getElementById('welcomeOverlay')?.classList.remove('visible');
            document.getElementById('ariaOobeOverlay')?.classList.remove('visible');
        }""")

        # —— 纯函数层：别名表与分支判定 ——
        pure = page.evaluate("""async () => {
            const m = await import('/src/services/playSource.js');
            const q = (s, g) => m.resolveSourceOf({ source: s }, g);
            return {
                qq: m.platformKeyOf('qq'),
                kg: m.platformKeyOf('KG'),
                wangyi: m.platformKeyOf('wangyiyun'),
                n163: m.platformKeyOf('163'),
                local: m.platformKeyOf('local'),
                branch_qq_with_stale_global: q('qq', 'kugou'),
                branch_netease_with_stale_global: q('netease', 'tencent'),
                branch_no_song_source: q('', 'kugou'),
                branch_local_keeps_global: q('local', 'tencent'),
                branch_gibberish_keeps_global: q('selfhost', 'netease'),
                hasHelper: typeof m.resolveSourceOf === 'function',
            };
        }""")
        check("platform-alias-qq", pure["qq"] == "tencent", pure["qq"])
        check("platform-alias-kg", pure["kg"] == "kugou", pure["kg"])
        check("platform-alias-wangyiyun", pure["wangyi"] == "netease", pure["wangyi"])
        check("platform-alias-163", pure["n163"] == "netease", pure["n163"])
        check("platform-local-passthrough", pure["local"] == "local", pure["local"])
        check("branch-qq-overrides-stale-global", pure["branch_qq_with_stale_global"] == "tencent", pure)
        check("branch-netease-overrides-stale-global", pure["branch_netease_with_stale_global"] == "netease", "")
        check("branch-falls-back-to-global", pure["branch_no_song_source"] == "kugou", "")
        check("branch-local-not-hijacked", pure["branch_local_keeps_global"] == "tencent", "")
        check("branch-unknown-not-hijacked", pure["branch_gibberish_keeps_global"] == "netease", "")

        # —— 端到端：source:'qq' 且只有 name 字段的条目 ——
        res = page.evaluate(JS_BOOT, {"songs": [
            {"tag": "qq-name-only", "info": {"id": "004ZDmkJ1GJLML", "source": "qq",
                                             "name": "晴天", "artist": "周杰伦"}},
            {"tag": "netease-name-only", "info": {"id": "186016", "source": "netease",
                                                  "name": "稻香", "artist": "周杰伦"}},
        ]})
        if res.get("err"):
            check("harness-loaded", False, res["err"])
        steps = {s["tag"]: s for s in res.get("steps", [])}

        # 分支证据：beginResolveTrace 写的就是 `${effSource}:${id}`，第一条即本次判定的音源
        qq = steps.get("qq-name-only", {})
        ne = steps.get("netease-name-only", {})
        check("qq-trace-keyed-as-tencent", (qq.get("keys") or [""])[0] == "tencent:004ZDmkJ1GJLML",
              qq.get("keys"))
        check("netease-trace-keyed-as-netease", (ne.get("keys") or [""])[0] == "netease:186016",
              ne.get("keys"))
        check("qq-title-not-unknown", qq.get("title") and "未知" not in qq["title"], qq.get("title"))
        check("qq-artist-not-unknown", qq.get("artist") and "未知" not in qq["artist"], qq.get("artist"))
        check("netease-title-not-unknown", ne.get("title") and "未知" not in ne["title"], ne.get("title"))

        # —— 历史去重：同一首歌经两条路径各记一次，只能留一条 ——
        hist = page.evaluate("""() => {
            localStorage.removeItem('aria_recent_history');
            const song = { id: '004ZDmkJ1GJLML', mid: '004ZDmkJ1GJLML', source: 'qq', name: '晴天', artist: '周杰伦' };
            window.recordRecentPlay(song);
            const viaTencent = Object.assign({}, song, { source: 'tencent', song: '晴天', singer: '周杰伦' });
            window.recordRecentPlay(viaTencent);
            const list = JSON.parse(localStorage.getItem('aria_recent_history') || '[]');
            return { n: list.length, titles: list.map(x => x.title), keys: list.map(x => x.key) };
        }""")
        check("history-dedupes-qq-vs-tencent", hist["n"] == 1, hist)
        check("history-title-normalized", hist["titles"] == ["晴天"], hist["titles"])

        browser.close()

    failed = [r for r in RESULTS if not r[1]]
    print("\n==== %d/%d passed ====" % (len(RESULTS) - len(failed), len(RESULTS)))
    for n, _, d in failed:
        print("  FAILED %s  %s" % (n, d))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
