# AGENTS.md

本文件供开发/AI Agent 协作时快速了解项目结构与约束。详细演进历史见各模块头注释与 `CODE_WIKI.md`。

## 项目概览

自研桌面音乐播放器「Aria」（网页版 + Tauri 桌面壳），核心能力：
在线多源搜索/播放（QQ/酷狗/网易/酷我 + 自建服务）、逐字歌词高亮、情感词上色、多种视觉模式（词云/PV/全景/飞入）、桌面歌词窗口、本地音乐、歌单/收藏、AI 智能情绪分析、均衡器等。

## 运行时架构（重要）

```
┌─ Tauri 2 壳（src-tauri，Rust） ─ 窗口加载 http://127.0.0.1:8001/index.html ─┐
│  启动时 spawn Python server(server.py 端口 8001) + Node shazam(18089)        │
└──────────────────────────────────────────────────────────────────────────────┘
        │ 8001
┌───────▼──────────────────────────────────────────────────────────────────┐
│ Python 后端（纯标准库: http.server/urllib；无第三方依赖）                   │
│  ├ 静态服务 web/  + /proxy 通用代理 + /api/* 业务                          │
│  └ 自建服务(selfhost_service.py)：管理三个 Node 副进程                     │
│       ├ _eval/qq-music-api-node     端口 3200 (npx tsx src/app.ts)        │
│       ├ _eval/KuGouMusicApi         端口 3100 (node app.js)               │
│       └ _eval/NeteaseCloudMusicApi  端口 3201 (node app.js)               │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键约定**
- 前端全部走 `http://127.0.0.1:8001`（含 API）。开发时直接 `python server.py`。
- **页面 URL 必须用 `localhost`，不能用 `127.0.0.1`**：AI 走 Gemini 反代 Worker
  （`docs/cf-gemini-auth-worker.js`），它按 `ALLOWED_ORIGINS` 校验浏览器 `Origin`，线上只放行了
  `http://localhost:8001`；换成 127.0.0.1 会 403 `Forbidden: origin not allowed`，AI 全废
  （`src-tauri/src/lib.rs` 与 `tauri.conf.json` 的窗口 URL 因此固定写 localhost，别"优化"成 127.0.0.1）。
  局域网/手机访问的 Origin 是 `http://<局域网IP>:8001`，需显式加进该白名单。
- **监听地址默认只绑本机回环**（`server.py` 的 `BIND_HOST = '127.0.0.1'`）。加 `--lan` 才绑
  `0.0.0.0` 开放局域网（手机/平板连接用，见「启动本地服务器-局域网.bat」）。
- Python 侧只允许标准库；Node vendor 位于 `_eval/`，启动命令在 `selfhost_service.py _SERVICES`。
- 打包分发：用户机器无 Python/Node → 方案见 `docs/打包分发方案.md`（PyInstaller server.exe + 便携 node）。

## 前端目录（web/）

- `index.html` 挂载 `src/app/index.js`（分片模块按序 import，是唯一源码形态；原单文件 `web/src/app.js` 已删除）。
- `web/src/app/*.js` 核心分片（编号=加载顺序）：
  - `10-config-state.js`：全局 state（currentSongData 等在 globalThis）
  - `20-lyrics-render.js`：歌词渲染/逐字 DOM 管理
  - `57-wordcloud-camera.js`：`updateLyricsHighlight()`（自动滚动/高亮/模糊）
  - `95-track-loading.js`：在线播放加载/切歌
  - `100-cover-background.js`：封面背景 + 歌词行点击跳转(单次滚动) + 滚轮浏览
  - `110-keyboard-nav.js`、`125-favorites.js`、`130-playlists.js`(歌单页+自建平台歌单)、`135-crossfade.js`、`140-playlist-ui-events.js`(歌单交互/返回钩子)、`145-playlist-import.js`(导入+本地音乐+行点击委托)
  - `175-track-index-online.js`：在线解析/播放链接池（QQ 自建高音质在步骤0）
  - `200-settings-panel.js`：设置 + AI 分析（`triggerAiAnalysisIfNeeded` 必须查 `appSettings.ai.enabled`）
  - `245-playlist-manager.js`：右下角当前播放队列
  - `250-desktop-lyrics.js`、`258-rankings.js`(榜单/日推/最近/统计/批量操作)、`259-selfhost-favorites.js`(自建收藏+缓存)
  - `selfhost-runtime.js`：/api/selfhost 客户端（日推、歌单、我喜欢、缓存键）
  - `selfhost-settings.js`：设置页自建服务三平台分栏
- `lyrics.html`：桌面歌词窗口独立页（`#tEmc` 情感词开关、逐字 fill 进度、`--dtk-hl` 主题色）。
- `src/styles/rankings.css`：榜单/收藏/批量 checkbox 等共享样式。

## 请求链路注意

- **★ 全链路数据通道优先级（2026-09-22 确立）：本机自建 vendor 第一优先，公网上游仅作兜底。**
  公网上游（vkeys.cn / ygking / byfuns）会整体失联（2026-09-22 实测三者同时超时，QQ/网易搜索/取链/歌词全灭而 vendor 毫秒级正常）。
  用户登录自建服务后，搜索/歌词/取链都应先走 `/api/selfhost/{src}/proxy`（4s 超时、失败静默回退公网）：
  - 搜索：QQ `/getSearchByKey?key=&num=&page=`、网易 `/search?keywords=&limit=&offset=&type=1`（150-search-engine `fetchVendorSearchPage`）。
  - 歌词：QQ `/getLyric?songmid=`（`response.lyric` 纯 LRC）、网易 `/lyric?id=`（`lrc.lyric` + `tlyric.lyric` 翻译）（musicApi `fetchVendorLyric`）。
  - 取链：`selfhostQQPlayUrl` / `selfhostNeteasePlayUrl`（本就在链首）。
  新增任何公网数据依赖前，先考虑同数据 vendor 接口；规范化返回需与原公网形状一致。
- vendor 响应常见外套 `{response:{...}}`（QQ）/ `{data:{...}}`（酷狗/网易）——前端归一化须先解包。
- QQ c6.y.qq.com 对 node axios TLS 指纹风控(code:1000) → 用户资料类接口必须用 undici fetch。
- 自建接口统一经 server.py `_handle_selfhost` → `selfhost_service.proxy_drop_in`；对应 vendor GET 需带 `_t` 毫秒时间戳绕过 apicache。
- 播放链接池/HTTP:8001 服务的静态资源要 `Cache-Control: no-cache`。

## 常用操作

- 启动：`python server.py`（8001）；桌面版：`restart-aria.bat`（原名「强制重启Aria.bat」，2026-09-21 改英文名——中文名经 git/编码链路在 GitHub 显示为乱码；Chromium/pywebview 旧壳已删除）。仓库内没有 `启动Tauri桌面版.bat`，README/AGENTS 若引用该文件名属过期描述。
- 全新 clone 后先跑 `scripts/setup-vendors.bat` 重建 `_eval/` 运行时 vendor（clone 4 仓库 + npm install + 应用 `patches/` 本地补丁；`_eval/` 不入库）。
- 自建服务登录态落盘 `cache/selfhost_login.json`（结束时清理敏感信息勿入库）。
- 修改后端：server.py / selfhost_service.py；改后需重启 8001 进程。
- 修改前端分片：直接改 `web/src/app/*.js` 即可（浏览器刷新生效；分片按编号 import，找不到归属时新建独立分片并加入 `index.js`）。
- 回归测试在 `tests/`（PV 交棒/场景分组/蒙德里安方格，playwright）：先起 server 再 `python tests/test_pv_*.py`。

## 绿色版打包（便携免安装，方案 B，已落地）

- 交付物：`dist/AriaPortable/` + `dist/Aria-Portable.zip`；双入口 `Aria.exe`（Tauri 桌面窗口）与 `启动Aria.bat`（网页版）。
- 重打包步骤与踩坑清单见 `docs/打包分发方案.md` §0（frozen 路径 / _find_node 三级解析 / QQ 去 npx / vendor 复制必校验 / bat 纯 ASCII / 目录名必须 ASCII）。
- 复现：`pyinstaller --onefile --console --name server --paths . server.py` + `cargo build --release`（src-tauri）→ 组装 → `tar -a -c -f`。

## 约束速查（硬性）

1. Python 后端纯标准库（为 PyInstaller 打包）。
2. 前端只维护 `web/src/app/*.js` 分片；原单文件 `web/src/app.js` 已删除，勿恢复、勿按旧行号定位。
3. 端口固定：8001(server) 3100/3200/3201(vendors) 18089(shazam)。其中 **8001 默认只绑
   `127.0.0.1`**，`--lan` 才绑 `0.0.0.0`（见上方「关键约定」）。
   ⚠ 已知残留：三个 vendor（3100/3200/3201）由第三方代码自行 `app.listen(port)`（未传 host
   参数，也不读 `HOST` 环境变量，见 `qq-music-api-node/src/server.ts:59`），**即使不开 --lan
   仍绑 0.0.0.0**。要彻底收口需经 `patches/` 给三个 vendor 打 host 补丁，属未完成项。
4. 歌词/榜单/收藏滚动容器为共享元素时，视图切换必须重置 scrollTop。
5. 情感词着色：桌面歌词只允许「扫过/进度层」上色；主界面保持渐变填充从左到右。
6. 全局字体/主题：`--theme-color`、`--dtk-hl` 等变量，busy 控件不得写死主题色。
7. **i18n 硬性约定（2026-09-22 用户确立）：新增任何中文 UI 文本时，必须同时在
   `web/src/core/i18n.js` 的 STATIC_PHRASE_MAP 里补上英文翻译**（写死方案，不搞运行时
   猜测）。静态导航数据（settingsNav.js）直接带 `labelEn/groupEn` 双字段。可复扫
   `scratch/i18n_scan.mjs`（历史脚本思路：提取 index.html 中文文本对照词表找缺失）。
8. **HTML 插值必须转义（2026-09-25 确立）：任何 `innerHTML`/`outerHTML`/`insertAdjacentHTML`
   模板里插入外部数据（歌名/歌手/封面 URL/搜索词/错误信息/导入文件名）必须走
   `web/src/utils/formatters.js` 的 `esc()`（= `escapeHtml`，同一实现，别再写第三份本地副本）。**
   门禁是 `eslint.config.mjs` 里的自定义规则 `aria/no-unescaped-html`（实现在
   `scripts/eslint-rules/no-unescaped-html.mjs`，规则自带回归测试
   `tests/js/test_html_escape_rule.js`）：按「模板里有标签 + 插值字段名是文本」判定，
   error 级、CI 阻断。它只是兜底网——数值/大写常量表/已转义变量会被放过，跨分片
   globalThis 传进来的值追不到，所以新增外部数据入口时仍要人工核对渲染点。
   URL 属性另有 `sanitizeImageUrl()`（`100-cover-background.js`）做 scheme 白名单。
9. **catch 不得静默（2026-09-25 确立）：`no-empty` 已收紧为 error 且 `allowEmptyCatch: false`。**
   吞掉异常处一律 `logCatch(tag, e)`（`services/log.js`，按 tag+错误信息 5s 去重，
   所以逐帧/逐词热路径也可以无脑留痕，不会刷屏掉帧）。确实有意忽略的异常写注释说明
   理由即可（`no-empty` 放过含注释的块），不要留 `{}`。日志 tag 用文件内既有
   `logInfo/logWarn` 的同一名字，别为同一模块再造第二个前缀。
   Promise 形态的 `.catch(() => {})` 也已收口（2026-09-25）：19 处改 `logCatch`，2 处属
   「预期拒绝」保留静默并就地注释（`165-audio-recognize.js` 的 `AudioContext.close()`
   AbortError、`232-nowplaying-follow.js` 摘 play() 未处理 rejection）。
10. **影子层封存 + core 层接管（2026-09-25 起，逐个模块推进）。** `web/src` 曾有 9 个从入口
    `app/index.js` 静态不可达的模块，与分片里的活实现**同名并存**，是「改了不生效」的
    头号陷阱。当前进度：
    - **已接管 4 个**（均为「以分片活实现为准重新抽取」，不是接线旧快照——旧快照普遍缺
      活实现后来补的修复，接线等于退回旧行为）：`stallDetector`（缺后台节流/6s 确认窗/
      bufferedEnd 诊断）、`fadeController`（缺双向取消与 rAF 被节流时的 setTimeout 兜底）、
      `shortcutManager`（音量单位 0~1 vs 0~100 不同、双监听会让空格互相抵消）、
      `equalizer`（缺自定义预设与响度归一化压缩器）。行为测试见 `tests/js/test_*.js`。
    - **已删除 1 个**：`visualizers/PolyphonyVisualizer.js` —— 「和鸣」模式本身已被移除
      （`index.html` 无 `data-mode="polyphony"`），连同残渣一起删，CODE_WIKI/README 已同步。
    - **剩 4 个**：`services/{favoritesService,playlistService,fontService}.js`（纯数据层，
      可抽未抽）、`core/audioPlayer.js`（**已判定不做机械接管**：它是 56/65/70/95 四个
      分片关注点的门面，还重复定义了 PLAY/PAUSE_ICON_PATH；接管=重写播放主链路，
      而主链路活路径目前无测试覆盖，理由写在其文件头）。
    门禁 A（`no-restricted-imports`）禁止存活模块 import 未解冻的那些。复扫：
    `node scripts/audits/module-reachability.mjs`（当前 123 模块 / 不可达 4）。
    ⚠ **嵌套目录模块的 import 深度**（2026-09-25 实测）：`core/pvEngine/` 这类二级目录里
    引 `services/log.js` 必须写 `../../services/`——写错深度不会报控制台错误，而是整条
    静态 import 链**静默死亡**（PVRendering 曾因此把 PV 全家 + 291-phone-remote 一起带死，
    表象只是「功能没接上」）。复扫（二级目录里单 `../` 只许指向 core 根文件，
    不许指向 services/utils/config 等仓库根目录）：
    `grep -rn "from '\.\./" web/src/core/pvEngine web/src/core/tunnelEngine web/src/core/visualizers | grep -E "from '\.\./(services|utils|config|core|infrastructure|app|parsers)/"`
    **接管一个模块的标准流程**：① 以分片活实现为准重写 core 模块（保留其修复与注释）；
    ② 分片删内联实现、改成 import；③ 从 `eslint.config.mjs` 门禁 A 名单移除；
    ④ 补行为测试并接进 CI；⑤ 跑 4 套 playwright 回归 + 浏览器实测（含不变量专项，
    如「拖频段不得重建滑块」）。
11. **状态单一来源（2026-09-25 确立）：`infrastructure/state.js` 是唯一存储，
    `globalThis` 上的 55 个同名键是 `infrastructure/globalBridge.js` 装的读写视图。**
    所以 `globalThis.volume`、裸 `volume`、`state.volume` 三种写法指向同一个值——
    不要再假设它们各自独立，也不要用 `Object.assign(globalThis, ...)` 绕开。
    新增共享状态的正确做法：所属模块 export + 使用方 import；**不要往 `BRIDGED` 加键**
    （该列表只减不增，缩到 0 时删除 globalBridge.js）。
    裸全局键写入侧另有棘轮：门禁 B（`no-restricted-syntax`）禁止新文件写
    `globalThis.x =` / `Object.assign(globalThis, ...)`，已有 30 个声明分片在白名单里
    （`eslint.config.mjs` 末尾，只减不增）。确需裸全局时，必须在 `10-config-state.js`
    走 `registerGlobal` 登记并同步 `PROJECT_GLOBAL_KEYS`。
    复扫双写面：`node scripts/audits/state-split-scan.mjs`、
    accessor 化前置检查：`node scripts/audits/accessor-safety-scan.mjs`。
    注：`assignGlobal()`（带写入者追踪）目前仍无人使用。
    ⚠ **`loadSettings()`（`app/180-boot-config.js`）是按固定键白名单整体重建 `appSettings` 的**，
    只有 `interface` / `shortcuts` 是全量展开。所以往 `DEFAULT_SETTINGS` 加**顶层新键**时必须同时在
    `loadSettings` 的合并块里补一行 `{ ...DEFAULT_SETTINGS.x, ...(saved.x || {}) }`，否则该键
    重启后被静默丢弃、持久化功能**不报错但永远失效**（2026-09-25 两个新功能都踩过，靠人肉发现）。
    规避办法：把偏好挂到 `appSettings.interface.<key>` 下（已全量展开，无需改 180）。
    复扫（**按名字查，不要按 spread 模式查**——同一个键可能写成 `x: (() => {…})()` 的 IIFE，
    只 grep `...DEFAULT_SETTINGS.x` 会把 `ai`/`modeSettings` 误报成没处理）：
    `grep -o "^    [a-zA-Z]*: {" web/src/config/defaults.js` 取顶层组名，逐个在
    `web/src/app/180-boot-config.js` 的 `loadSettings` 重建块里确认有对应键。
12. **性能降级选择器必须锚在 `#ariaRoot` 上（2026-09-25 确立）。** `<html id="ariaRoot">` 是
    刻意留的**特异性锚点**：`modals.css` 里 `body.perf-low *` / `.is-software-renderer *` 这类
    纯类降级规则只有 (0,1,0)，会被组件里 `.search-overlay .search-modal { backdrop-filter: …
    !important }` 按「同重要度先比特异性」顶掉（实测残留 62 个元素仍跑实时高斯）。新增降级规则
    一律写成 `html#ariaRoot.is-software-renderer …` 或 `html#ariaRoot body.perf-low …`。
    另两个坑：验证降级效果要等 ≥900ms（`.icon-action-btn` 有 transition，短窗口会误判成残留）；
    **软件渲染标记与性能档位是两件事**——`markSoftwareRenderer()` 已与档位解耦，手动档分支也要
    `await detectHardware()` 才挂得上（此前该分支直接 return，纯 CPU 设备设过手动档就全无降级）。
    降级段（modals.css 1600+）里最贵的目标是 `.blur-background`：`filter: blur(60~80px)` 作用在
    150% 面积的全屏层上，且 `ai.css` 的 `@keyframes ai-glitch` **每帧**都写一次 filter——CSS 动画
    在层叠里高于普通内联样式，所以 JS 侧 `el.style.filter='none'`（预烘焙路径）会被动画顶掉，
    必须同时下 `animation: none`。该段选择器已全部锚到 `#ariaRoot`（61 条）。
    ⚠ 低性能/无显卡的实际帧率**无法在开发机上测**：DevTools 的 CPU 降频只慢 JS 主线程，
    而 blur 的代价在合成器软件光栅化；要量必须回 VM 实测。
13. **分词 vendor 库不得在启动期加载（2026-09-25 确立）。** `segmentit.js`(3.7MB) +
   `kuromoji.js` 及其 **17MB 日文词典**原先是 `index.html` head 里两条无条件
   `<script async>`；一旦 `window.kuromoji` 就位，`WordSegmenter` 的模块级单例
   （`export const wordSegmenter = new WordSegmenter()`，PV 引擎被 import 就跑构造函数）
   立刻在启动瞬间拉起全部词典。实测启动期 121 个 JS 请求 / 6.5MB JS、DOMContentLoaded 936ms。
   现在的机制：脚本由 `index.html` 的延迟加载器注入并**按语种分档**——中文 `segmentit`
   在 `load` + `requestIdleCallback` 后预热，日文 `kuromoji`（连同 17MB 词典）要等
   `WordSegmenter._segmentJapanese()` 真的被调用才经 `window.__ensureSegLibs('ja')` 触发；
   `WordSegmenter._initSync()` 在库缺失时按需触发中文档。
   **两个坑**：① 触发点必须放 `_initSync()` / `_segmentJapanese()`（首次分词才走到），
   放构造函数等于没延迟——构造函数本身就是 boot 期执行的，第一版就踩过这个，
   实测 2 秒内词典仍全部下完；② 保持 `async` 语义不要改成 `defer`——`page_loaded` 信标
   会被外部脚本拖慢，Rust 端会超时重试导航。未就绪期间走 `Intl.Segmenter` 兜底
   （日文还有正则一级），库落地后下一次分词自动升级，不改变输出路径。
   收益（实测）：DOMContentLoaded 936→551ms；2 秒内传输 31.2MB→9.1MB；
   不播日文时 vendor 开销 21MB→3.7MB（词典 12 个 .dat.gz 完全不请求）。
14. **新增取链分支必须同时 `recordResolveHit`（2026-09-25 确立，todos #15）。**
   `loadOnlineSong` 里每个 `playUrl = …` 赋值点后面跟一行
   `recordResolveHit(channelId, playUrl, quality)`（`services/playSource.js`），底栏角标与
   「更多 → 取链详情」全靠它。复扫（两个计数必须相等，注意函数边界——同文件另一个
   `fetchPlayUrlForPreload` 也有 14 处 `playUrl =`，那是**预加载下一首**的链，故意不埋点，
   埋了角标会显示成还没播的那首）：
   `awk 'NR>=404 && NR<=800 && /playUrl =/{a++} NR>=404 && NR<=800 && /recordResolveHit/{b++} END{print a,b}' web/src/app/175-track-index-online.js`
   （2026-09-25 基线：19 19）。
   三个实测坑：① **不要挂 `.player-controls-wrapper`**——`view-lyrics`/`view-pv` 等模式下整列
   `display:none`，元素存在但尺寸 0×0，`getBoundingClientRect()` 才发现的；常显面只有底栏
   `.bottom-control-bar`，且它自己在 `view-pv` 等模式也有样式分支，所以详情必须另留菜单入口。
   ② **解析池的 `quality` 不是音质**，它是 provider 的档位标识（实测值 `'song_play_url'`），
   `qualityLabel()` 用 `QUALITY_TOKEN_RE` 白名单挡掉，挡不住就退回容器名 `ext`，宁可保守。
   ③ **从 URL 猜音质只能匹配 pathname**：QQ 直链的 `vkey` 是 hex 签名，实测出现过以
   `…F320__v2…` 结尾的 key，整串匹配 `/320/` 会把 m4a 谎报成 320k。
   另外 `musicApi.qqResolveUrl` 历史上把服务端的 `quality/ext/provider/tried[]` 全丢掉，
   现在要完整负载请用 `qqResolveInfo`；`tried[]`（逐 provider + 耗时 + 失败原因）就是
   详情面板的降级轨迹数据源，比抓日志行准。日志轨迹本身走 `services/log.js` 的环形缓冲
   （400 条 / 正文 240 字），按 **seq 序号**而非时间戳切窗——同一毫秒的日志用 `ts` 会漏进来。
15. **动效只有一套令牌，且退场是机制不是逐处补丁（2026-09-25 确立）。**
    `web/src/styles/motion.css` 是动效唯一事实源：曲线**只有三条**（`--e-enter` / `--e-enter-soft`
    /`--e-exit`），另有 `--d-instant..--d-layer`、`--dy-in*/--dy-out*`、`--t-fast/--t-base/--t-slow`。
    复扫 + 棘轮门禁：`node scripts/audits/motion-audit.mjs --check`（已接进 CI）。基线是
    `offCurve 0 / bounce 0 / transitionAll 0 / willChangeShell 4`，**只许降**。表现层文件
    （`pv*.css` `visualizers.css` `letterpress.css` `neon.css` `appearance.css`）不受壳层纪律约束。
    两个硬约定：
    ① **浮层显隐一律 `opacity + visibility 0s linear <退场时长>`，不许回到 `display:none↔flex`**——
    display 是离散属性，用它的浮层只能"出现"不能"离开"。20 个 overlay 其实只共用 6 个类根
    （`.search-overlay`×12 / `.lyric-source-overlay`×4 / `.ai-models-overlay`×2 / 另 3 个单例），
    所以 motion.css 里那**一段**选择器列表就是全部入口，新增浮层只要复用这些类。
    ② **退场后需真卸载/隐藏的元素必须走 `utils/motion.js` 的 `conceal(el,{onHidden})`**，
    不要自己 `style.opacity=0` + 手抄 `setTimeout(...,400)`（那是两个各调一半的数字）。
    ⚠ `conceal` 刻意用 CSS animation + `animationend`，**不要改成 `element.animate()`**：窗口
    切到后台时 WAAPI 时间轴会被冻住（实测 `playState:'running'` 而 `currentTime` 恒为 0），
    退场永不结束；CSS animation 不受影响。兜底是 `min(1000ms, dur+250ms)`，按动画时长收紧而非
    固定 1 秒——退场中的分区是绝对定位盖在新分区上的（`.is-leaving`），兜底多久就遮挡多久。
    实测两个反直觉点：**back-out（回弹）只属于表现层**，壳层曾有 24 处（含 8 处挂在
    `transition: all` 上，等于 width/color 也跟着弹），清零后"廉价感"主要来自这里；
    **`transition: all` 在壳层实测只需 8 个属性**（扫过这些选择器的 `:hover/:focus/.active`
    实际改动的属性得出 `--t-props`），但 `.source-btn.active` 是唯一需要例外的一项
    （`.active` 才出现的 `blur(20px)`，不收进令牌是怕 50 处控件都去过渡模糊）。
    **低配机上 `will-change` 的取舍量不出来**：`.line` 与 `.plm-item` 两处常驻合成层是真候选，
    但删了是否掉帧只能在无显卡设备实测（同第 12 条的教训），所以只挡住新增、不动存量。
16. **毛玻璃面板只有一套配方，照搜索页抄（2026-09-25 用户确立）。** 任何带模糊的面板/弹窗一律用
   `.search-modal` 那组值：`background: rgba(255,255,255,.12)` +
   `backdrop-filter: saturate(2) blur(40px)`（含 `-webkit-`）+ `border: 1px solid rgba(255,255,255,.18)`
   + `border-radius: 24px` + `box-shadow: 0 8px 32px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.15)`。
   **不要自创更弱的值**（`blur(8px)`、近乎不透明的实色底都会被一眼看出「没有模糊」）。
   ⚠ 约束 12 说的是「降级选择器必须锚 `#ariaRoot`」，**不是**「禁止写 `backdrop-filter`」——
   2026-09-25 睡眠定时器弹层就是拿约束 12 当理由写成实色底，结果完全没有毛玻璃。
   正确做法：照上面写玻璃，**同时**补一条 `html#ariaRoot.is-software-renderer …` /
   `body.perf-low` 的退化为实色的规则（模糊的代价在合成器软件光栅化，无显卡设备必须退掉）。
   例外：OSD 这类每次按键都出现的瞬时浮层刻意保持实色（不给合成器加常驻高斯），偏离本条要写明理由。

17. **逐字兜底在 `renderLyrics` 一处生效，但「有 words」不再等于「真实逐字」（2026-09-25 确立）。**
    只有行级时间戳的歌词（普通 LRC、多数外部源）由 `parsers/wordTiming.js` 按行时长摊平出
    `words`，接线点唯一：`app/20-lyrics-render.js` 的 `renderLyrics` 入口——23 个调用点一次覆盖，
    且 `globalThis.lyrics` 一起补齐，桌面歌词窗口/PV/词云/手机远端都受益（实测 `lyrics.html`
    从「1 个 word、0 个 fill」变成「4 个 word、4 个 fill」）。**不要**回到各加载点分别补。
    ⚠ 代价是 `line.words.length` 从此**不再能证明真实性**：合成行带 `wordTiming: 'synthesized'`，
    任何拿 words 判**真值**的代码必须改走 `realWordsOf(line)` / `hasRealWordTiming(lines)`
    （它们忽略合成行），否则会把编造的节拍当真货。已收口的三处：
    ① `app/90-eq.js` 的 `_krcText`（下载歌词）——不加护栏时实测两行歌词里写出 6 个假时间戳
    （`[0,2000]<0,667,0>甲<667,666,0>乙…`）进用户的文件；
    ② `core/aiAnalyzer.js` 的 `getLyricsTextForAI`——它用 words 跨度算 `duration` 再打 ★/◆
    高潮权重喂 LLM，合成值还被 `maxLineMs` 截断过，实测会把 20s 的行报成 `[10000ms]★`；
    ③ 导出前用 `stripSyntheticWords(lines)`。
    渲染侧反过来：**有就用**，别加护栏（合成的也比整行一跳好）。
    选源/标签那几处（`170-lyric-sources` 的 `isWord`、`130-playlists:1201` 的 `r.isWordLevel`）
    读的是刚 parse 出来的数组、不经 `renderLyrics`，所以不受影响——新增同类判定时注意数据来源
    是不是 `globalThis.lyrics` / `Aria.__ariaLyrics`，是的话必须走 `realWordsOf`。
    复扫 + 回归：`node --test tests/js/test_parsers.js`（合成标记/幂等/strip 共 10 条）、
    `tests/js/test_ai_lyrics_word_fallback.js`、`python tests/test_word_fallback.py`（15 条，含
    「合成行不得进下载」「dtk 窗口出 fill」）。
    另：`ensureWordTiming` 是**逐行**补的（混合形状里带真实节拍的行原引用保留），
    全组都真实时才返回原数组引用——调用方靠引用相等判「没动过」，别改成总是新建。
