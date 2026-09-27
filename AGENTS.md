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

- 交付物：`dist/AriaPortable/` + `dist/Aria-Portable.zip`；双入口 `Aria.exe`（Tauri 桌面窗口）与 `StartAria.bat`（网页版）。
- 重打包步骤与踩坑清单见 `docs/打包分发方案.md` §0（frozen 路径 / _find_node 三级解析 / QQ 去 npx / vendor 复制必校验 / bat 纯 ASCII / 目录名必须 ASCII）。
- 复现：`pyinstaller --onefile --console --name server --paths . server.py` + `cargo build --release`（src-tauri）→ 组装 → `tar -a -c -f`。
- ⚠ **`src-tauri/tauri.conf.json` 的 `build.frontendDist` 必须是 `dist-stub`，别「优化」回 `../web`**（2026-09-26 实测）：两个窗口的 URL 都是 `http://localhost:8001/...`，前端由 server.exe 提供，内嵌那份从未被加载；指回 `../web` = 把 145MB 静态资源（含 120MB 字体）压缩塞进二进制，Aria.exe 从 9.8MB 涨回 96MB。
- ⚠ **`web/src/font/` 里被 `.gitignore` 掉的是作者本机私人字体（实测 89.4MB），不属于应用**：`build_portable.bat` 默认只把 git 跟踪的那批放进主包，其余单独打成 `dist/AriaFonts-Extra.zip`（两包合起来 = 磁盘上的全部字体，零丢失）。肥包模式：`build_portable.bat --with-local-fonts`。字体选择列表就是扫这个目录（`215-multilang-fonts.js`），所以「包里有 = 界面里可选」。
- ⚠ 该脚本必须在**纯 cmd/资源管理器**环境跑：从 git-bash 里调 `cmd //c build_portable.bat` 时 PATH 会抢走 `find.exe`/`timeout.exe`（实测 `timeout: invalid time interval '/t'` + GNU find 扫整盘），计数类判断会失真。

## 约束速查（硬性）

1. Python 后端纯标准库（为 PyInstaller 打包）。
2. 前端只维护 `web/src/app/*.js` 分片；原单文件 `web/src/app.js` 已删除，勿恢复、勿按旧行号定位。
3. 端口固定：8001(server) 3100/3200/3201(vendors) 18089(shazam)。其中 **8001 默认只绑
   `127.0.0.1`**，`--lan` 才绑 `0.0.0.0`（见上方「关键约定」）。
   ✅ 三个 vendor 的监听收口（2026-09-26 已修，别再写「未完成项」）：第三方代码自行
   `app.listen(port)`，不传 host 也不读 `HOST`。**实测默认绑的是 `::`（IPv6 任意地址），
   比原先记的「绑 0.0.0.0」更宽**。做法是 `selfhost_service.py` 在 spawn 时注入
   `NODE_OPTIONS=--require scripts/vendor-loopback-guard.cjs`，把「只给端口」和
   显式 `0.0.0.0` 两种形态改到 `127.0.0.1`；显式给了别的 host 一律尊重。
   ⚠ **不要改成 `patches/*.patch`**：那需要精确上下文行号，而 `_eval/` 是 clone 来的
   第三方仓库，上游一改行号补丁就**静默不生效**——安全修复以这种方式失效比不修更糟。
   因此配套了一个黑盒探针 `selfhost_service.probe_vendor_exposed()`：拿本机非回环 IPv4
   去连 vendor 端口，连得上就是还在裸奔，结果进 `status_all()` 的 `exposed` 字段。
   回归 `python -m unittest tests.python.test_vendor_loopback_guard`（已进 CI）——
   它同时测「不加守卫必须报暴露」，否则探针恒 False 时后面所有结论都没意义。
   要故意对局域网开放：设 `ARIA_VENDOR_HOST=0.0.0.0`（或 `off` 完全跳过注入）。
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
    `node scripts/audits/module-reachability.mjs`（2026-09-27 实测 161 模块 / 不可达 4）。
    ⚠ 它的 import 抽取曾把**副作用 import 整条吃掉**（`[\s\S]*?` 越界撞到下一条 `from`），
    于是只被 `import 'x.js';` 引用的模块（实测 `utils/numberStepper.js`）被误报成影子模块，
    不可达数 4→5。现已抽成 `scripts/audits/lib/import-scan.mjs` 并由
    `tests/js/test_module_reachability.js` 钉住——**门禁报假阳性比漏报更糟**：人会照着它删代码。
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
   `awk 'NR>=411 && NR<=1100 && /playUrl =/{a++} NR>=411 && NR<=1100 && /recordResolveHit/{b++} END{print a,b}' web/src/app/175-track-index-online.js`
   （2026-09-26 基线：19 19；区间 = `loadOnlineSong` 起于 411 行，改过本分片后记得同步行号）。
   三个实测坑：① **两面都不常显，必须各挂一份**——`view-lyrics`/`view-pv`/`view-dimension`/
   `view-tunnel` 下 `.player-controls-wrapper` 整列 `display:none`（元素存在但尺寸 0×0，
   `getBoundingClientRect()` 才发现的），而 **默认（cover）模式下反过来**：`.bottom-control-bar`
   只有那四个视觉模式 + neon/letterpress 有 `display:flex` 规则，**cover 没有对应规则 → 整条底栏隐藏**
   （此前这里写的「常显面只有底栏」是反的，2026-09-26 实测纠正）。所以角标有两枚
   （底栏 `#playSourceBadge` + 主信息列 `[data-play-source-badge]`，由 `275-play-source.js`
   按属性一次刷新，主信息列那枚用 `.song-source-badge-slot` 只在 view-cover 显示以免重复），
   入口也有两处（底栏 + 「更多 → 取链详情」）。
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

18. **频谱逐字对齐在前端做，结果按「歌曲 × 歌词签名」缓存（2026-09-26 确立）。**
    约束 17 的摊平只是近似节拍；`core/wordAligner.js`（纯函数）用音频包络把每个字起点
    拉到真实发声处，`services/wordAlign.js` 负责 WebAudio 解码 + 缓存 + 回填。
    **为什么不用 stable-whisper/强制对齐**：约束 1 要求后端纯标准库（PyInstaller 绿色包，
    用户机器没有 Python/Node），而 stable-whisper 要拖 torch + 模型（GB 级）；
    WebAudio `decodeAudioData` 已能解本工程实际用到的 FLAC（`chorusDetector.js:693` 早就在这么干）。
    代价说清楚：**只能定位能量起始、认不出音素**，精度低于强制对齐；拖腔内部仍按权重摊。
    三个要点：
    ① 触发点仍锚在 `renderLyrics`（`maybeAlignLyrics`），**不要**回到各加载点分别接。
    必须有 `_alignTried` 键集：音频没给出信息时 `applyAlignment` 会把那几行标回
    `synthesized`，`needsAlign` 于是仍为真，不记就会「重渲染→再对齐」死循环（实测靠它收敛到 2 次渲染）。
    ② 缓存键必须含**歌词签名**（`lyricSignature` 把行级 start 也进哈希）：播放直链是短时签名的
    （QQ vkey 几分钟失效）不能当键；而同一首歌换歌词源时文本可能一样、行时间戳不一样，
    只按歌曲键会把上一份歌词的对齐结果贴到这一份上。store 走 `aiCache.js` 的
    `wordTimingCache`（`LyricsPlayerDB` v5，该文件是唯一属主，别处不得再 `indexedDB.open`）。
    ③ 对齐成功的行要**清掉** `wordTiming` 标记（`applyAlignment` 里按
    `maxDeviationFromEvenSplit >= 60ms` 判"音频确实给出了信息"），否则 `realWordsOf`
    仍当它是假的，下载歌词和 AI 喂词两条路都拿不到对齐成果（与约束 17 互为反向）。
    退化是设计的一部分：`alignLine` 在帧数不足或包络全 0 时返回 `evenSplit`，
    所以任何情况下都不会比约束 17 的摊平更差——这条有专门的测试钉住。
    复扫 + 回归：`node --test tests/js/test_word_aligner.js`（12 条，合成 PCM 用 LCG 保证可复现）、
    `tests/js/test_word_align_service.js`（6 条）、`python tests/test_word_align.py`（15 条 E2E，
    含「FLAC 真能解」「起点明显偏离等分」「二次命中缓存且条数不涨」「UI 路径不死循环」；
    `local_music/` 在 .gitignore 里，无音频时整脚本 SKIP 不报红）。
19. **音源标识只有一张别名表，取链分支按歌曲判定不按全局（2026-09-26 确立）。**
    同一平台在各处的字段值不一样：搜索页签用 `'tencent'`、自建 QQ 服务返回 `'qq'`、网易有
    `'wangyiyun'/'ne'/'163'`、酷狗有 `'kg'`。`services/playSource.js` 的 `platformKeyOf()` 是唯一
    登记处，`resolveSourceOf(songInfo, currentSource)` 是取链分支的唯一判据。
    起因是三个用户反馈同一个根因：`loadOnlineSong` 的 kugou/kuwo 分支写成
    `currentSource === X || songInfo.source === X`，而 **tencent/netease 两个分支只查全局**，
    全局默认停在 `'tencent'` → 网易/酷狗的歌被塞进 QQ 分支，拿网易 id 去查 QQ mid，
    整条链空转（= 加载慢），标题又因为读 `songInfo.song`（自建条目只有 `name`）显示「未知歌曲」，
    历史再按 `source:id` 建键于是记成两遍。四条硬约定：
    ① **分支判据用 `resolveSourceOf`，不要写回 `currentSource ===`**：`currentSource` 会被搜索页签
    和预加载并发改写（175 里 12 处赋值点），拿它判分支等于拿"上一个界面"决定"这一首歌"。
    ② **只认 `RESOLVE_SOURCES` 那四个**：`'local'/'selfhost'`/拼写错的值必须退回全局而不是硬用，
    否则会掉进末尾的 `else`（未知音源 → vkeys）——比原来的错法更糟。`preloadNextSong` 反过来：
    它只做别名归一（`platformKeyOf`）不做兜底替换，因为 `source:'local'` 原样传下去才是"不去抢在线直链"。
    ③ **标题/歌手一律走 `lyricIndex.js` 的 `titleOf()`/`artistOf()`**（该模块零 import，无环）。
    `loadOnlineSong` 入口已把 `songInfo.song`/`singer` 就地补齐一次，所以函数体内那二十多处
    `songInfo.song` 是安全的——**新增字段名不同的平台时改这两个归一函数，不要改调用点**。
    ④ **自建条目必须带 `mid`（QQ）/ `hash`（酷狗）**，不能只塞进 `id`：`258-rankings.js` 三处
    「日推条目 → 播放条目」的映射原先各写一份且把它们全丢了，`loadOnlineSong` 只能拿 mid 当
    数字 id 去 `_fetchQQMeta` 反查（多一次往返），酷狗条目更是直接缺标识（= 点了没反应）。
    现在收敛成 `toPlayItem()` 一个函数。复扫：
    `grep -rn "source: s.source }" web/src/app` 应为空、
    `grep -rn "currentSource === '" web/src/app/175-track-index-online.js` 只许出现在注释里。
    回归：`node --test tests/js/test_play_source.js`（22 条，含别名表与分支判定 5 条）、
    `python tests/test_source_routing.py`（17 条，含「trace.songKey 证明走了哪条分支」）、
    `python tests/test_daily_recommend_click.py`（8 条，用假日推接口喂，不依赖登录与网络）。
20. **背景自适应一律用感知亮度，且必须算「实际合成出来的那一层」（2026-09-26 确立）。**
    `utils/colorUtils.js` 的 `srgbToLinear` / `relativeLuminance` / `contrastRatio` / `pickInk`
    是全仓**唯一**一份亮度实现。起因是「右上角三大金刚键不随背景变色」：旧 `updateBrandColor`
    写的是 `(0.2126R+0.7152G+0.0722B)/255` 再比阈值 `0.48`，两个错叠在一起——
    ① 那是把 **sRGB 编码值当光强**加权，没有 gamma 解码：中灰 128 算出 0.504 判成"亮"，
       真实相对亮度只有 0.216（`tunnelEngine/TunnelEngine.js:107`、`283-readability.js:129`
       是同一份错公式的另外两个副本，改它们要先重调各自阈值，本次没动）；
    ② 完全忽略 `.blur-background` 的 `brightness(0.35)`——按钮底下的实际颜色比封面主色暗得多，
       于是白封面被判成亮背景 → 深色墨 → 正是用户看到的"黑按钮贴在暗背景上看不见"。
    四条硬约定：
    ① **算亮度要按 z 序自下而上合成**：`body::before` 不透明 #000 地板 → `.blur-background`
       （主色 × brightness）→ `.color-overlay`（未压暗的主色，alpha 写在 backgroundColor 里）。
       只算主色 × brightness 会漏掉叠色那一档。
    ② **brightness 一律读 `getComputedStyle(...).filter`，不要抄第二份"各模式亮度表"**：
       `view-letterpress/neon/tunnel/dimension/pv/flyin/wordcloud` 全用 `!important` 把自己钉死
       （`viewmode.css:369` 钉 .12、`:730` 钉 .1），抄表必漏（旧版就漏了 flyin/wordcloud），
       而且设置页拖滑块后就不一致了。**computed 是 `none` 时退回 `appSettings.background.brightness`**
       ——软件渲染设备上 `modals.css:1677` 会把 filter 打成 `none !important`，
       压暗改由预烘焙图承担（`shouldUsePrebakedBlur()` 与那条降级同一组条件），
       而预烘焙用的正是 appSettings 那对值，所以这个退回口径和屏幕上是同一件事。
    ③ **层的可见性读 `.visible` 类，不要读 computed opacity**：
       两层都有 `transition: opacity .8s/.5s`，交叉淡入中途读到 0.0x 会把背景算成纯黑，
       而且淡入完成时没有任何属性变更再触发观察器，会**永久**停在错的那一边
       （第一版测试假失败就是这么找出来的）。
    ④ **取墨用 `pickInk()` 的两墨对比度比较，不用阈值**；迟滞的写法只有一个对的：
       `if (currentLight && lead < 0 && lead > -margin)`——写成 `if (currentLight && lead < margin)`
       会让"很亮的背景"仍被判成亮墨（第一版就写错了）。转场必须走动效令牌
       （`.tb-btn` 用 `--t-base`、品牌字用 `--t-slow`），硬切会看着"跳一下"而不是"适应了"。
    复扫（`0.2126` 的副本数只许减不许增）：
    `grep -rn "0\.2126" web/src --include=*.js` → 除 `utils/colorUtils.js` 外只剩
    `TunnelEngine.js:107` 与 `283-readability.js:129` 两处历史副本。
    回归：`node --test tests/js/test_color_contrast.js`（7 条，含"中灰 128→0.216 不是 0.502"
    与迟滞边界）、`python tests/test_titlebar_contrast.py`（23 条 E2E，覆盖白封面默认档必须
    保持亮墨、拉满亮度必须翻暗墨、七个自暗舞台、降级退回 appSettings、无主色兜底）。
21. **弹层定位测量一律用 `offsetWidth/offsetHeight`，长菜单要能变列（2026-09-26 确立）。**
    `80-context-menu.js` 的溢出夹取原先读 `getBoundingClientRect()`，而这一行紧跟在
    `classList.add('visible')` 之后——`.ctx-menu` 基态是 `transform: scale(0.95)`，transition 还没跑，
    量到的是**缩放后**的盒子，比真实尺寸小 5% → 夹不准，菜单底部照样顶出屏幕
    （默认模式「更多」补到 10 项后实测 bottom=521 > vh=520）。`offset*` 是布局盒，不受 transform 影响。
    同一条测量规则也修了二级菜单（它在 add('visible') 之前测量）。
    列数走 `showCtxMenu(items, x, y, { columns: 2 })` + `.ctx-menu.is-multi`（CSS 网格，
    分隔线 `grid-column: 1/-1` 跨整行，≤560px 退回单列 + 滚动），**不要在调用方手抄 grid 样式**。
    回归：`python tests/test_cover_mode_entries.py`（逐项判 `getBoundingClientRect()` 是否完整落在视口内，
    而不是只看容器——容器有 `overflow:auto` 时"看起来没溢出"但底下的项要点开滚动才点得到）。
22. **预设色板只有一份，且"丑"是可以量出来的（2026-09-26 确立）。**
    `web/src/config/themePalette.js` 是唯一登记处：`ACCENT_PRESETS`（key/zh/en/hex）、
    `DEFAULT_ACCENT`、`PALETTES`（accent / accent+white / text / dim 四种 `data-palette`）、
    `isPresetAccent()`、`CUSTOM_SWATCH_SVG`。起因是用户「预设主题色好丑」。
    两个维度一起处理：
    ① **收口**——同一串 6 个色值原先在 `index.html` 手抄 17 份（每份还内联同一个 12 路径彩虹
       SVG，那玩意儿复制了 15 遍），`202-settings-appearance.js` 里为判断"是不是预设色"又抄第
       18 份，首跑向导 `000-tooltip.js` 更有第 19 份**且 6 个色值完全不同**——用户在向导里选
       「晴空蓝」，进设置页那颗亮的是「自定义」且再也点不回预设。现在 HTML 只写
       `<div class="setting-color-row" data-var="…" data-palette="accent" data-active="…">`，
       色值一颗都不出现在 HTML，由 `210-color-multilang.js` 的 `hydrateColorRows()` 在模块
       import 时生成（deferred module，DOM 已解析）。
       ★ 点击**只有 210 里那一颗 document 级委托**：目标由行的 `data-var` + 是否处在
       `[data-mode-section]` 里决定（模式行 → `appSettings.modeSettings[mode].<field>`，
       否则全局），写入再统一落到 `200` 的 `writeColorField` → `syncPreviewToMain`。
       **不要再给 `.color-swatch` 挂节点级 click**——`hydrateColorRows` 会整体重写
       `row.innerHTML`，绑在旧节点上的监听当场蒸发，而且旧写法靠 `getElementById(容器 id)`
       找容器，重构把 id 换掉时是**静默**失效（约束 22 的第一版就静默丢了 17/18 行）。
       解析不出落点时必须 `logCatch('colorMultilang', …)`，不许 `if (!container) return`。
       收益：index.html 从 242KB 降到 199KB。
    ② **可测的设计契约**——旧 6 颗全是 `S=1.00` 的纯色（`#a8ff51` 荧光绿、`#ff8aff` 桃红），
       且金色 45° 与橙色 27° 只差 18°，六颗里两颗几乎同色。新色板按三条硬指标挑：
       饱和度 ≤ 0.75、对面板底 `#20222e` 对比度 ≥ 5.4:1（强调色要当文字用）、
       色相两两间隔 ≥ 28°。`tests/js/test_theme_palette.js` 的 B1–B5 钉住这三条，
       B5 还反向验证旧色板确实过不了——**下次改色板不用投票，跑不过契约就是不合格**。
    三个踩过的坑：
    ① 主题色有**两种写法**：十六进制和 `rgba(var(--theme-color-rgb, 255,204,51), α)`。
       只换十六进制会在同一条规则里留下两个金色（`pv-tunnel.css:545` 实测就是
       `color:#E8BE6A` 配 `text-shadow:rgba(255,204,51,.85)`）。`base.css:3` 的
       `--theme-color-rgb` 声明也必须跟着改。复扫：
       `grep -rn "255, *204, *51" web/src --include=*.css --include=*.js`
       只许剩 `201-settings-ai.js`（高亮笔 marker）与 `DimensionBackground.js`（视觉器自己的能量光）
       两处装饰色，`#ffcc33` 只许剩 `PVEngine.js:138`（dream 预设的 accent，和 `#ff3366`/`#00ffcc` 并列）。
    ② **别把装饰色当主题色改**：视觉器/PV 预设自己 palette 里的金色是作品的一部分，不跟主题走。
    ③ 用脚本批量改写 HTML 结构时，**闭合标签**是头号事故点：第一版 18 行全少了 `</div>`，
       症状完全不在色板上——后面每个元素嵌套深一层，`#sleepTimerOverlay` 掉进 `.settings-group`
       变成 0×0，睡眠定时器面板整个看不见，而"水合出色块了吗"这类断言照样全绿。
       现在两侧各有一道不变量：Node 侧数 `<div>`/`</div>` 是否配对，
       浏览器侧断言所有 overlay 仍是 `document.body` 的直接子元素且面板宽度 > 200px。
    回归：`node --test tests/js/test_theme_palette.js`（12 条）、
    `python tests/test_theme_palette_ui.py`（40 条，含水合/幂等/点击生效/结构完整性，
    以及**逐行**点一遍 18 个 `[data-palette]` 行断言各自落点真的变了——第 4 节那种
    「只点还留着 id 的那一行」的写法等于没测）。
23. **会 await 用户点击的确认框，不得挂在没有手势的自动路径上（2026-09-26 用户确立）。**
    开机预加载（`180-boot-config` → `175 loadOnlineSong(preloadOnly)` → `triggerAiAnalysisIfNeeded`）
    在页面加载后几秒自己调到 AI，而 Gemini 走反代时那条路上挂着一个 `await showGlassConfirm`
    的隐私确认框——用户什么都没点，弹窗就杵在屏幕中央拦住整页。判据两层，别只做一层：
    ① 调用点自己声明「这条路径永远不该问」：`triggerAiAnalysisIfNeeded({ silent: true })`；
    ② 机制兜底：`201-settings-ai.js` 的 `userActivated()` 读
    `navigator.userActivation.hasBeenActive`，false 就不弹、只留一条 `logWarn`，**且不发任何数据**。
    有了 ② 之后，新增自动触发路径（手机遥控 `291`、交叉淡入预载、以后的定时器）默认静默，
    不必逐个补标志。宿主不支持该 API 时 `userActivated()` 退回 true，此时只剩 ①。
    跳过只丢这一次分析，不丢功能：用户点「进入」或点任何一首歌都会重新触发并正常弹一次。
    ★ 两个反直觉点：**Playwright/CDP 的 `evaluate` 自带 userGesture**，跑第一行脚本时页面就已经
    「有手势」了（实测首读 `hasBeenActive === true`），所以测试里必须用 `add_init_script` 把它
    桩成可控值，否则等于没测无手势分支；**Tab/keydown 算激活事件，mousemove 与 wheel 不算**。
    回归：`python tests/test_ai_privacy_boot.py`（5 条：无手势静默且确实走到闸门 / 有手势必须弹 /
    取消不留 consent 标记 / 无手势时也不许偷写标记 / silent 调用点有手势也不弹）。
24. **「更多」菜单的条目名只取 `aria-label`，开关态必须画出来（2026-09-26 用户确立）。**
    右上角按钮被藏进「更多」后，条目文案由 `292-toolbar.js` 的 `labelOf()` 决定：
    **只读 `aria-label`（短名）**。`data-tooltip` 是给人看的长说明（会带
    「（跟播其它播放器）」「· 已开启（点击关闭）」这类从句），照它取名就撑出一整行
    ——用户圈出来的正是这条。所以开关类按钮的分工从此固定：长说明进 `data-tooltip`、
    短名进 `aria-label`、状态走 `.on` + `aria-pressed`（283 / 285 已按此改回去，
    原先它们把整句 tip 也写进 aria-label，读屏还会把「已开启（点击关闭）」重念一遍）。
    选中态全仓只有一份声明：`menus.css` 的 `.ctx-item.active-rate, .ctx-item.is-on,
    .more-item.is-on`（主题色底 + 主题色字，和倍速那颗同一条规则），勾是**内联 SVG**
    （`292` 的 `CHECK_ICON`）。★ 不要用 ✓ 这类 unicode 字符当图标或选中标记（用户明确要求：
    字体缺字就掉豆腐块，线宽永远对不齐旁边的图标）。新增开关按钮请复用 `.on`，
    别再引入第五个类名（现状：`.on` / `.is-active` / `.active-dl` / `aria-pressed` 已由
    `isOnOf()` 一处收口）。
    回归：`python tests/test_toolbar_customization.py` 第 6 节（短名 / 长说明改挂悬停 /
    开与关两种态各断言一次）。
    把 `201` 的闸门条件改成 `if (false && …)` 跑一遍确认它真的报红——这个测试文件是这么验证过的。


24. **「动效强度」滑杆只叠一层，且写入侧读原样表（2026-09-27 确立）。**
    生效值 = 档位 vfx ⊕ 滑杆 ⊕ 手动单项微调，顺序写在 `app/180-boot-config.js` 的
    `getVfxOverrides()` 一处（数学在 `core/vfxIntensity.js`，纯函数）。两条硬约束：
    ① **手动在最上层**——滑杆不得覆盖用户手调过的开关（那是数据丢失不是重置），所以滑杆值
      存 `appSettings.interface.vfxIntensity` 而**不写进** `perf_vfx_overrides_v1`；
    ② `setVfxOverride` 的基底必须是 `getManualVfxOverrides()`（原样表），不能是合并视图——
      用错就会把滑杆的 10 个推导值冻结进手调表，滑杆当场失效（E2E 实测复现过）。
    两个「恢复推荐/出厂配置」按钮必须同时调 `Aria.__resetVfxIntensity()`，否则按钮撒了谎。
    未设定的语义是 **null 而不是 0**（`Number(null) === 0`，混同等于每次启动把用户拖到极简档）。
    回归：`node --test tests/js/test_vfx_intensity.js`（11 例）+ `python tests/test_vfx_intensity_ui.py`
    （23 例，含变异验证：摘叠加→4 条红、基底取错→`manual-table-stays-minimal` 红、摘重置钩子→`factory-reset-clears-intensity` 红）。

25. **逐字高亮渲染的性能与形态铁律（2026-09-27 用户确立，两轮实测教训）。**
    默认/歌词模式英文歌卡顿，两轮修复史与硬边界：
    ① **NaN 双端钳位（2026-09-26）**：短词/单字符词 `duration < charCount ms` 时
      `20-lyrics-render.js` 词内切字符 `Math.round` 产生 charStart==charEnd →
      `57-wordcloud-camera.js` 除零 pct=NaN → lastWordProgress(Map) 以 NaN 为值永 miss
      （NaN!==NaN）→ 每帧无条件重写 mask。修法双端：渲染端 charEnd 钳到 charStart+1；
      消费端 end==start 兜底 pct 0/100。**动切字符时间轴的代码必须保持这两处钳位**。
    ② **整词渲染被用户否决（2026-09-27）**：曾把词云的拉丁整词上采样（`isLatinWholeMode`）
      扩到歌词/默认三模式治卡顿（DOM 572→120，headless 实测 max 485→85ms），但
      **逐字符上浮与情感词逐字符高亮是刻意设计**，整词上浮/整词直显不可接受——已撤回，
      整词路径仍仅限 view-wordcloud。不要再提。
    ③ **`.done` 不得切 mask（2026-09-27）**：每词唱完瞬间把 `mask-image` 切成 none 会触发
      整层重栅格化（英文每秒唱完 2-4 词）。现行做法：mask 常驻，pct>=100 时 JS 写
      `--reveal: 120%` 让前沿完全出界（渐变起点 106% 已超元素宽），视觉等价零切换。
      主画面（57 + base.css）与预览（previewEngine + appearance.css）同机制。
    ④ **切行不得逐词重置旧行（2026-09-27）**：旧实现切行瞬间对旧行全部字符写
      `--reveal:0%` + 移除 done/delete 缓存——英文一行 40-60 元素同帧几十次 mask 写入，
      是切行巨刺（实测 485ms）的直接来源。现行做法：旧行只摘 active class，
      **保留满高亮**（Apple Music 风格）；该行再次成为活动行时主循环第一帧按当前 t
      计算 pct，残留值与新值不同必然写入，无停留风险。
    ⑤ **headless 测量有两坑**：playwright 无 GPU，mask 栅格化瓶颈测不出来（EN≈ZH 是假象，
      只能测 JS 侧）；headless 页面 boot 会恢复上次播放并异步加载**真歌词**覆盖测试注入
      （`globalThis.lyrics` 变别人家数据，DOM 词元数对不上），必须先预热耗尽恢复任务
      或用 `globalThis.lyrics === myLines` 守卫校验。测量脚本模板：`scratch/prof_modes.py`。
    ⑥ **现场诊断手段**：诊断页「帧时（实时采样）」的 `lyricsFx` 行
      （57 registerLoop FX_PROBE_SOURCE）= 默认/歌词模式滚动循环帧时中位/p95/max；
      与内置心跳对照可区分「本循环 JS 瓶颈」与「合成器瓶颈」。

26. **切歌竞态守卫：迟到回调必须带「失败时刻的代际」（2026-09-27 用户确立）。**
    `playbackGeneration` 在三个切歌入口递增（95 loadTrack / 135 loadPlaylistTrack 本地
    分支 / 175 loadOnlineSong），此后所有异步回调凭 `gen === playbackGeneration`
    判定自己是否过期。两条硬规则：
    ① **失败重试的代际必须在「失败发生点」捕获，不能在安排重试时捕获**。
      `135 handlePlayFailure(songInfo, isFromPlaylist, failGen)` 的第三参由调用方传
      自己作用域里的 gen（175:802/1023 取链失败与加载失败、135:245/266 本地分支）。
      此前 handlePlayFailure 内部才捕获 gen——A 的失败回调可能在用户已切到 B 且
      B 播放数秒后才落地（取链多源探测/加载超时迟到），捕获到的是 B 的代际，
      重试校验必然通过 → loadOnlineSong(A 重试) gen++ 把 B 顶掉。实测症状：
      「另一首歌都放出来几秒了，结果又切回去了」。新增任何失败/超时驱动的
      自动动作，一律传失败时刻的代际，禁止「回调落地时再读当前值」。
    ② **切歌必须取消进行中的 AI 分析**：统一调 `globalThis.cancelAiAnalysis()`
      （定义在 95-track-loading.js，abort + `_manualCancel` 标记 + 复位
      isAiAnalyzing/currentAiAbortController；操作对象是 201-settings-ai 的
      裸全局分析套件）。三个 gen++ 入口都要调——此前只有 175 有内联取消，
      本地路径切歌后旧歌的 AI 分析会一直跑到出结果，用户得手动停止。
      新增切歌入口（遥测/远控/定时器等）时，gen++ 与 cancelAiAnalysis 必须成对出现。
