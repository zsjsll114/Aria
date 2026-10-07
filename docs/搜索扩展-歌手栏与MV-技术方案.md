# 搜索扩展：歌手栏 + MV（技术方案）

> **状态**：**已实现并真机验证**（2026-10-03）。
> 本文档的 §一~§二 是**能力实测结论**，§三~§四 是落地形态，§五 是**踩坑记录**（改这块前必读）。
> 适用对象：Aria（网页版 + Tauri 桌面壳）。
> 前置：歌手页 Phase 1 已完成（见 `docs/歌手页面-技术方案.md`），
> `services/artistApi.js` 的 `searchArtists()` / `openArtist()` 可直接复用。
>
> **落地清单**（全部已提交进工作区，未 commit）：
> - `web/src/services/mvApi.js` — MV 搜索/取址/精选（三源）
> - `web/src/app/101-mv-background.js` — MV 动态背景层
> - `web/src/app/150-search-engine.js` — 歌手卡 / MV 卡渲染与拉取
> - `web/src/styles/mv.css`、`web/src/styles/base.css` — 卡片与背景层样式
> - `web/index.html` — `<video id="mvBgVideo">` + 设置页「MV 动态背景」三项
> - `tests/js/test_mv_api.js` — 21 条单测

---

## 一、先回答「能不能」

| 想要的东西 | 能不能 | 关键约束 |
|---|---|---|
| 搜索页加「歌手」分组（搜关键词顺带出歌手卡） | **能，且成本最低** | 只有**网易、酷狗**支持关键词搜歌手；QQ / 汽水没有（酷我 2026-10-03 起已从搜索移除入口）→ 必须为「不支持」设计可见提示，不能静默少一块 |
| 搜索页加「MV」 | **能，三家都通**（酷狗 / 网易 / QQ，2026-10-03 实测） | 三条链路**各不相同**：**酷狗**走 `/search?type=mv`（关键词直搜，最干净）；**网易**走 `/search?type=1004`（是**视频**检索，混访谈/预告，必须后置过滤）；**QQ** 没有关键词搜 MV，只能**走歌手维度** `/getSingerMv?singermid=` → `/getMvPlay?vid=`。**汽水做不了**（底层库零 video 方法，见 §二 第 3 条） |
| MV 当**背景**而不是当播放器 | **能，已落地** | ① 三家直链都是 **http**，但 **CDN 同时支持 https**（实测换协议后仍 206 + `video/mp4` + Range）→ 统一升 https + 失败回落一次 http；② 极端性能模式（`perf-minimal` / 软件渲染）**主动拒绝**并给文案，不当"背景"烧 CPU；③ 无需后端流式代理——`<video>` 原生支持 Range，实测 82MB 级 MV 直接播 |

---

## 二、能力矩阵（2026-10-03 实测原始响应）

取数方式：直连本机自建 vendor（QQ 3200 / 酷狗 3100 / 网易 3201 / 汽水 3300）。
**前端不直连 vendor，一律过 `selfhostKeyOf()` 收口后走 `/api/selfhost/<key>/proxy?path=…`**
（`selfhostKeyOf('tencent') === 'qq'`，直接拼 `tencent` 会 404 —— 这条坑见 §五 第 1 条）。

### 关键词搜 MV

| 源 | 结论 | 实测证据与要点 |
|---|---|---|
| 酷狗 | ✔ **最干净** | `GET /search?keywords=周杰伦&type=mv&page=1&pagesize=18` → `data.lists[]`，每条 `{MvID, MvName, MvHash, SingerName, Duration(秒), HistoryHeat, Pic}`。搜「周杰伦」返回 6 支正牌 MV（晴天/青花瓷/稻香/…），**无需过滤** |
| 网易 | ✔ **但要过滤** | `GET /search?type=1004&keywords=周杰伦&limit=12` → `result.mvs[]`。⚠ 这是**视频**检索：12 条里 6 条是《超级面对面》访谈、2 条预告片、1 条 9 秒问候，**搜到的"MV"点开是主持人聊天**（周杰伦在网易云无 MV 版权） |
| QQ | ✔ **但走歌手维度** | `getSearchByKey` 实测 `mv=None`（**没有按关键词搜 MV 的能力**）。可行路径：先拿歌手 `mid` → `GET /getSingerMv?singermid=<mid>&limit=6` → `response.data.list[{vid,id,title,pic,singer_name,listenCount}]`。取址 `GET /getMvPlay?vid=` → `response.getMVUrl.data.<vid>.mp4[]`（**多档，前几档常是 `code:2000` + 空 url**，要挑可用最小档） |
| 汽水 | ✘ | `scripts/qishui-server.mjs` 无任何 artist/mv 路由（`grep -n "mv\|video"` **0 命中**）；本机底层库 `ly-music-source` 的 `dist/client.d.ts` 能力清单**零 video** |
| 酷我 | ✘ | 无自建 vendor（`_eval/` 只有四家），无歌手/MV 接口 |
| vkeys 公网 | △ **只宜兜底** | QQ MV 搜索是 `/music/tencent/search/mv`（**没有 `v2/` 前缀**），但它是**全站视频检索**——实测 keyword=追光使者 首条是抖音 UGC。且 `meta.perPage` 恒回 `1`、带 `limit` 触发 `code 110000 需要安全验证` |

### 播放地址（取址）

| 源 | 端点 | 返回值 | 备注 |
|---|---|---|---|
| 酷狗 | `/video/url?hash=<MvHash>` | `data.<hash>.downurl` | **要 `MvHash`，不是 `MvID`** |
| 网易 | `/mv/url?id=<id>&r=1080` | `data.url` | 带 `wsTime` / `expi:3600` → **临时地址，绝不持久化** |
| QQ | `/getMvPlay?vid=<vid>` | `…mp4[].freeflow_url[]` | 多档，挑**最小可用档**（背景播放不需要 1080P）；无鉴权参数 |

---

## 三、方案 A：搜索页「歌手」分组（已实现）

### 3.1 形态

```
┌ 搜索结果 ────────────────────────────────────────────┐
│ [歌手]  ● 周杰伦   ● 陈奕迅   ● 五月天        （横向卡）│   ← 仅 netease / kugou
│ [MV]    ▷ 晴天     ▷ 青花瓷   ▷ 稻香          （横向卡）│   ← kugou / netease / tencent
│ [播放全部（60）]                                      │
│ 1 …                                                   │
└──────────────────────────────────────────────────────┘
```
- 当前源不支持时，原位显示一行灰字：**「该源暂不支持 MV · 切到 QQ 音乐／网易云音乐／酷狗音乐试试」**
  （明确文案 > 静默消失）
- 点歌手卡 → 现有 `openArtist()`，歌手页叠在搜索页上，ESC 逐层关
- 点 MV 卡 → 铺成动态背景（见 §四），卡片带「背景中」角标

### 3.2 改动点（实际落地）

| # | 位置 | 做法 |
|---|---|---|
| A1 | `150-search-engine.js` `ensureSearchExtras()` | 独立于歌曲搜索的**第三条腿**：`fetchArtistCards()` → `searchMvs({artists})`；失败即空，不拖累歌曲结果 |
| A2 | `renderSearchResults()` | 顶部插 `<div class="search-extra" id="searchExtraRows">`；`extraRowsHtml()` 是**纯同步函数**，只读 `globalThis.searchExtras` 缓存 |
| A3 | 点击 | **事件委托**在 `searchResultsEl` 上一次监听（`.artist-card` / `.mv-card`） |
| A4 | i18n | 13 条文案进 `core/i18n.js`（歌手/MV 标题、空态、取址中、性能模式拒绝等） |
| A5 | 转义 | 歌手名 `escapeHtml()`、封面 URL 走 `upHttps()` |
| A6 | 歌手卡去重 | `dedupeArtists()`：去掉全部空白/标点/符号（`[\s\p{P}\p{S}]`）后同名只留一条。上游会把同一个人换装饰符当成不同歌手（"周杰伦" / "周杰伦." / "周杰伦♚"）。**刻意不做"包含即重复"**，否则「周杰伦音乐张」也被删、搜「周杰伦」一张卡都不剩。见 §五 第 8 条后附 |

---

## 四、方案 B：MV（已实现）

### 4.1 形态：MV 当**背景层**，不做独立 MV 播放器

Aria 是歌词播放器，不是视频客户端。把 MV 铺成动态背景、歌词/PV 照旧跑在上层。

**z-index 契约**（`base.css`，别改）：

```
.mv-background      z-index: -2   ← <video id="mvBgVideo">，常驻 DOM
.blur-background    z-index: -2   ← 封面模糊背景（MV 播放时动画 paused）
.color-overlay      z-index: -1
.player-container   z-index:  1   ← 歌词 / PV / 控件
```

- video 按 **112% 铺开 + 6% 负偏移**：blur 会把画面外的透明像素卷进来，不留余量四边会出现一圈黑边
- `filter = blur(Npx) brightness(max(0.1, 1 - dim))` 内联写在 video 上，由设置滑杆直接驱动
- `<video muted loop playsinline preload="none">`：**必须 muted**，不能和播放器的音频抢输出
- 窗口 `visibilitychange` 隐藏时暂停解码

### 4.2 设置项（`data-section="background"`）

| 控件 | key | 范围 | 默认 |
|---|---|---|---|
| MV 动态背景（开关） | `background.mvBg` | bool | `true` |
| MV 压暗 | `background.mvDim` | 0 ~ 0.9 | `0.45` |
| MV 背景模糊 | `background.mvBlur` | 0 ~ 30 px | `8` |

**缺省视为开**：点 MV 卡片是一次明确动作，默认关掉会让人以为功能坏了。
开关关着时点卡片 = 明确表达"我要看"，会**自动开启并落盘**（`setMvBackground` 返回 `autoEnabled`，UI 提示）。

### 4.3 明确不做

MV 下载、MV 收藏、跨源 MV 合并（ID 域不通）、画中画、独立 MV 路由页。

---

## 五、踩坑记录（改这块前必读）

1. **`selfhostKeyOf()` 是唯一入口**：搜索页的 source 是 `'tencent'`，后端 `_SERVICES` 的键是 `'qq'`。
   直接拼 `/api/selfhost/tencent/proxy` → 后端按 `platform not in _SERVICES` 判 404 → 被上层 `catch { return null }` 静默吞掉。
   **症状是"QQ 自建搜索从未真正生效，一路悄悄回退公网 vkeys"**。
2. **网易 `duration` 恒为毫秒**：542060 → 542s。**别用"大于 10000 当毫秒"的启发式** ——
   9.4 秒的短片会被读成 9400 秒（2 小时 36 分），卡片上直接是个荒谬的数字。
   （QQ 的 `getSingerMv` **不给时长**，填 0 并不显示，不编造。）
3. **网易的"MV"里混着访谈**：必须两层过滤（见 `finalizeMvs`）——
   ① **时长下限 45 秒**（挡 9s 问候 / 36s、40s 预告）；
   ② **标题黑名单**（`超级面对面|访谈|专访|预告|花絮|幕后|探班|纪录片|彩排|发布会|记者会|播放次数最多`，挡 428~646 秒的访谈节目）。
   ⚠ 判定必须是 `duration > 0 && duration < 45`：QQ 不给时长（0），写 `duration < 45` 会把整排 QQ 卡片误杀。
   ⚠ 黑名单**刻意收窄**：只放"出现在歌名里概率≈0"的节目词。《对话》真是歌名，所以"对话"**不能**进表。
4. **绝不"一条不匹配就退回全量"**：`finalizeMvs` 按 `名称|歌手` 去重 + 歌手一致过滤（双向包含，兼容 `"初音未来;巡音流歌;KAITO"` 这种长串）。
   实测网易搜「晴天」前三条是高伟/邓天晴的翻唱（网易没有周杰伦版权）——退回全量就会把别人的翻唱当成《晴天》的 MV 摆出来。**宁可不显示，也不指错。**
5. **酷狗封面 `Pic` 是裸文件名**，必须自己拼 `https://imge.kugou.com/mvhdpic/480/<Pic>`（`mvpic` 也有 200，但 `mvhdpic` 同尺寸清晰得多：16KB vs 37KB）。
6. **MV 直链 https→http 回落**：三家 CDN 都同时支持两种协议，统一升 https 是为了兼容手机遥控那种 https 页面。
   万一某条 CDN 的 https 端点不通，`onVideoError` 只回落**一次**（`data-mv-http-fallback`），避免 error → 换 src → error 死循环。
   实测酷狗 `fsmvpc.tx.kugou.com` 的 https 在本地确实不通，这条兜底真实生效过。
7. **`searchPagingBusy` 全局单标志会吞掉切源的搜索**（已修）：
   用户在 A 源搜索飞行途中点 B 源按钮 → `searchSongs()` 建了 B 的 cache、铺了骨架屏 →
   `goToSearchPage(1)` 看见全局 busy 还是 true 就 `return` → **B 源的搜索被静默丢弃**；
   随后 A 的响应回来判 stale，又把这层骨架和提示清掉 → B 源页面全空，**再点一次搜索才正常**。
   修法：标志**挂在 cache 对象上**（`cache.busy`），切源/换词天然隔离；清缓存把 cache 置 null，标志随之消失。
   顺带在 stale 分支加了 `if (live && live.busy) return;`——新源正在飞时，旧响应不许去动它的骨架和提示。
8. **★「卡片时有时无」的真正根因：骨架屏的延迟写入 × 渲染函数里同步读异步缓存。**
   现象：酷狗搜「周杰伦」，`globalThis.searchExtras.kugou` 里明明 `done` 且有 6 歌手/6 MV，
   界面却一张卡都没有（约 1/6 概率复现，重搜一次就好）。
   链路（每一环单看都对，叠在一起才出错）：
   1) `renderSearchResults` 是在**拼 html 字符串**时同步调用 `extraRowsHtml(searchSource)` 的；
      那一刻 extras 若还没回来，`extraHtml` 就是空串，**空串被固化进 html**。
   2) 拼完调 `showResults(html)`（120），它走 `Aria.skeleton.settle()`；
      `005-skeleton.js` 的时序规范在「骨架已经显示过」时会**延迟 `SK_MIN_VISIBLE`(280ms)**
      才 `el.innerHTML = html`（避免"闪一下"）。
   3) 于是 extras 回来（~200ms）时，`#searchExtraRows` 还在骨架后面、**根本没进文档** ——
      `document.getElementById('searchExtraRows')` 返回 `null`（探针实测 `getEl NULL`）。
   4) 延迟写入落地的是**第 1 步那份空串**，之后再没有任何人补画 → 卡片永久丢失。
   修法：`_fillExtraRowsWhenReady(src)` —— 容器不在就**轮询等它出现**（80ms × 最多 12 次
   ≈ 1s > 280ms 的等待窗口），切源立即收手。
   ⚠ 教训：**只补一拍（`setTimeout(…, 0)`）是不够的**，因为 DOM 写入被骨架延迟了整整 280ms。
   ⚠ 同类隐患的判据：**任何"在 `renderSearchResults` 里同步读某个异步缓存"的写法都会踩这个坑**
      （`getFavorites()` / `currentSongData` 是同步的所以没事）。新增这类内容时，一律走
      「容器就绪后再补画」的路径，别指望拼字符串那一刻数据已经到齐。
9. **极端性能模式主动拒绝**：`perf-minimal` / `is-software-renderer` / `window.__isSoftwareRenderer` 命中时，
   `setMvBackground` 直接返回 `{ok:false, reason:'perf'}` 并给文案，不静默失败。
   ⚠ 注意 headless chrome 的 GPU 是 `Microsoft Basic Render Driver`（真·软件渲染），
   所以 **headless 里永远验证不到 MV 背景播放**——要么真机，要么临时摘掉该标记再测。
10. **`toSec()` 只留给酷狗**（它的 `Duration` 是秒，且偶有毫秒歧义）；网易已改成固定 `/1000`。
11. **探针读状态要读 `globalThis`，不要读模块内变量**：`searchSource` / `searchPageCache` /
   `searchExtras` 都是隐式全局（150 里裸赋值），CDP 能直接读；而 `searchResultsCache` 是模块内
   `let`，读不到。另外 `Aria.setSearchSource()` 要**读它的返回值**（`true` 才是真的换了源，
   `false` 表示本来就是那个源）——否则会把「没切过去」误判成「切过去了但没结果」。

---

## 六、落地顺序（实际）

| 顺序 | 内容 | 状态 |
|---|---|---|
| 1 | 方案 A 歌手分组（`artistApi` 已就绪） | ✅ 完成 |
| 2 | B1 MV 数据层（三源 `searchMvs` + `fetchMvUrl`） | ✅ 完成 |
| 3 | B1 MV 动态背景层 + 设置三项 | ✅ 完成 |
| 4 | B2 搜索页 MV 卡片（与歌手卡同排） | ✅ 完成 |
| 5 | B3 歌手页 MV 标签 | ⏳ 未做（`/artist/mv`、`/artist/videos` 已探通） |

---

## 七、附：本次取数可复现命令

```bash
# 一律走自建服务的自建 vendor（注意 QQ 的键是 qq，不是 tencent）
curl -s --noproxy "*" "http://127.0.0.1:3201/search?type=1004&keywords=周杰伦&limit=12"   # 网易：视频检索（含访谈，需过滤）
curl -s --noproxy "*" "http://127.0.0.1:3201/mv/url?id=10973163&r=1080"                    # 网易取址
curl -s --noproxy "*" "http://127.0.0.1:3100/search?keywords=周杰伦&type=mv&pagesize=18"   # 酷狗：关键词搜 MV（最干净）
curl -s --noproxy "*" "http://127.0.0.1:3100/video/url?hash=<MvHash>"                      # 酷狗取址（要 hash）
curl -s --noproxy "*" "http://127.0.0.1:3200/getSingerMv?singermid=<mid>&limit=6"          # QQ：歌手维度（没有关键词搜 MV）
curl -s --noproxy "*" "http://127.0.0.1:3200/getMvPlay?vid=d0040igj7eo"                    # QQ 取址（多档，挑可用最小档）

# 公网 vkeys（★ 没有 v2/ 前缀；只宜兜底：perPage 恒 1、带 limit 触发风控）
curl -s --noproxy "*" "https://api.vkeys.cn/music/tencent/search/mv?keyword=追光使者"
```
