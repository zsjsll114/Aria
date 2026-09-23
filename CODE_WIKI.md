# Aria 歌词播放器 — Code Wiki

> 本文档是对整个项目的结构化代码说明，覆盖：整体架构、模块职责、关键类与函数、依赖关系、运行与构建方式。

---

## 1. 项目概览

**Aria** 是一款功能完整的在线歌词播放器（桌面应用），核心能力包括：

- 多源在线音乐搜索与播放（QQ 音乐、网易云、酷我、咪咕、聚合兜底、任意存量 API）
- 逐字（卡拉OK式）歌词高亮渲染，支持原词 / 翻译 / 罗马音三行布局
- 多种歌词可视化模式：**词云模式**（3D 螺旋词云 + 相机运镜）、**PV 模式**（上游式构图池分镜：60 版式 × 段落情绪分池 × 内容哈希轮换 + hero 竖柱）、**流光隧道模式**（Tunnel，仿《妄想感傷代償連盟》文字 PV：词级竖/横/斜独立排版 + 摄像机焦点锁定 + 3D 深度堆叠 + 蒙德里安五族版式子模式）、**浮空模式**（Dimension）、**和鸣模式**（Polyphony）、**活字模式**（Letterpress，印刷压印隐喻 + 30 版式 + 纸色随段落情绪）、**霓虹模式**（Neon Sign，街角灯牌隐喻：单线灯管 + 逐字通电 + SVG 圆角店招）
- 听歌识曲（Node sidecar 调用 Shazam 指纹识别；Shazam 失败时回退到 Vosk 语音转写 + 歌词反查）
- 本地音乐管理（上传、结构化落盘、Enhanced LRC 逐字歌词生成）
- AI 情绪分析（Gemini API，分析歌词情绪 → 生成主题色 / PV 主题）
- 桌面歌词悬浮窗（透明、可自由拖动、可锁定穿透、逐字本地插值动画）
- 收藏 / 歌单 / 歌单导入（网易云、QQ） / 搜索历史 / 快捷键 / 触控手势
- 10 段音频均衡器、倍速（变速不变调）、下载、无缝切歌淡入淡出

**部署形态**：Web 前端（ES Module 分片架构）+ Python 本地后端（单文件 `server.py`，纯标准库）+ Node 识曲 sidecar + Tauri v2 桌面壳（自动拉起上述两个 sidecar）。

---

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Tauri v2（Rust + WebView2） | `src-tauri/`，打包桌面版（Electron / pywebview 旧壳已删除） |
| 前端 | 原生 HTML / CSS / JS（ES Module） | `web/`，无前端框架，分片式全局脚本架构 |
| 歌词分词 | segmentit（中文）、kuromoji.js（日文） | CDN 引入 |
| 后端主服务 | Python 3 纯标准库 `http.server` | `server.py`，端口 8001 |
| 识曲服务 | Node.js `http` + shazamio-core + ffmpeg | `scripts/shazam-server.mjs`，端口 18089 |
| AI 分析 | Gemini API（OpenAI 兼容代理转发） | `web/src/services/aiClient.js` |
| 数据持久化 | localStorage / IndexedDB / 服务端文件缓存 | 配置、收藏、歌单、AI 缓存、字体、音频缓存 |
| 语音转写 | Vosk（本地模型，系统 Python） | `models/vosk-model-small-cn-0.22/` |

---

## 3. 目录结构总览

```
歌词播放器/
├── server.py                    # ★ 后端主服务（CORS 代理 + 音频流代理 + 全部 API）
├── qq_resolver.py               # QQ 音乐多源解析池（Tier A~D 竞速/降级 + 防试听校验）
├── agg_resolver.py              # 聚合跨源兜底（gdstudio：酷我→网易） + 酷我独立源
├── local_music_server.py        # 本地音乐扫描 / 音频缓存 / 用户配置 / 字体 / 识曲缓存
├── selfhost_service.py          # 自建服务三平台副进程托管（酷狗/QQ/网易云，3099~3201 端口）
├── scripts/
│   ├── shazam-server.mjs        # ★ Node 识曲 sidecar（18089：/health /proxy /recognize）
│   └── sidecar-bindings.js      # 端口等约定
├── sidecar/
│   ├── run-node.cmd             # Tauri 侧车 Node 启动包装（Tauri v1 遗留）
│   └── run-python.cmd           # Tauri 侧车 Python 启动包装
├── docs/
│   ├── PV-技术方案.md           # PV 模式设计文档
│   └── 流光隧道-记忆导出.md      # 流光隧道模式设计沉淀
├── kugou_api doc/doc.md         # 酷狗 API 接口参考
├── src-tauri/                   # ★ Tauri v2 桌面壳
│   ├── src/main.rs / lib.rs     # sidecar 拉启 + 桌面歌词窗口控制命令
│   ├── tauri.conf.json          # 应用配置（frontendDist=../web，窗口定义）
│   ├── build.rs / build-dev.bat # 构建
│   └── capabilities/default.json
├── web/                         # ★ 前端
│   ├── index.html               # 主界面（仅引一个 module：src/app/index.js）
│   ├── lyrics.html              # 桌面歌词子窗口页面（内嵌脚本 + rAF 本地插值）
│   ├── version.json / build_info.json  # 构建版本信息
│   └── src/
│       ├── app/                 # 41 个分片（000~250）+ index.js 加载器
│       ├── core/                # 音频/歌词/主题/预览/AI/峰值检测/均衡器/PV/流光隧道/可视化引擎
│       ├── core/pvEngine/       # ★ PV 模式（PVEngine + PVLyricLayout + PVCamera + WordSegmenter 等）
│       ├── core/pvEngine_backup/# PV 引擎旧版备份（已不再使用，勿删，可对照回滚）
│       ├── core/tunnelEngine/   # ★ 流光隧道（TunnelEngine 主时间线 + Director + Camera + DepthStack + Animations + AILyricSegmenter）
│       ├── core/visualizers/    # 浮空/和鸣可视化：VisualizerBase + VisualizerManager + dimension/ 子模块
│       ├── services/            # API、AI、本地音乐、收藏/歌单/字体、歌词匹配等
│       ├── parsers/             # LRC/YRC/罗马音/KRC/增强LRC/多源合并
│       ├── infrastructure/      # dom / eventBus / state
│       ├── config/              # constants / defaults / performance
│       ├── utils/               # colorUtils / formatters
│       ├── font/                # 内置自定义字体文件（.ttf）
│       ├── img/                 # 内置占位封面等图片
│       └── styles/              # 全套 CSS
├── cache/                       # 运行时生成：audio/*.mp3(.tmp/.meta/.ok)、recognize/
├── local_music/                 # 本地结构化音乐库（每曲一个文件夹）
├── models/vosk-model-small-cn-0.22/   # Vosk 中文语音模型
├── new_style/                   # PV 参考素材（帧序列、提示词）
├── 强制重启Aria.bat / 启动Tauri桌面版.bat / 启动本地服务器.bat / StartAria.bat / StopAria.bat   # 一键启动脚本
└── 根目录调试/临时文件（非核心，已随旧壳清理删除）: probe_exact.py / probe_from_zero.py / probe_stall.py / repro_stall.py（停滞复现）、diag-webview.mjs（WebView 诊断）、scratch_chunk.js / _idx.html / _t.js / _vk_test.json / _verify_sample.mp3 / __test_font.ttf / node_shazam_temp.pcm / chorus_detection_demo.py / chorus_demo_requirements.txt（频谱/高潮实验）
```

---

## 4. 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                        Tauri 桌面壳 (Rust)                       │
│  src-tauri/lib.rs                                              │
│  · 启动时 spawn sidecar: python server.py(8001) + node         │
│    shazam-server.mjs(18089)                                    │
│  · 桌面歌词窗口控制命令: show/move/pos/click_through/drag/resize│
└───────────────┬──────────────────────────────────┬─────────────┘
                │ frontendDist = web/（同源）        │ WebView / 浏览器
┌───────────────▼──────────────────────────────────▼─────────────┐
│  Web 前端 (web/)                                               │
│  index.html → src/app/index.js → 顺序 import 41 个分片          │
│  ✦ 分片 000-95：tooltip/配置/渲染/播放引擎基础链路                │
│  ✦ 分片 100-250：封面/键盘/搜索/收藏/歌单/识曲/歌词源/设置/触控    │
│  ✦ core/: lyricEngine / audioPlayer / themeEngine / previewEngine│
│          / PVEngine / TunnelEngine / VisualizerManager / aiAnalyzer │
│  ✦ services/: musicApi / aiClient / localMusicManager ...       │
│  lyrics.html（desktop_lyrics 窗口，经 localStorage + storage     │
│  事件接收主界面的逐字歌词推送，rAF 本地插值渲染）                  │
└───────────────┬──────────────────────────────────┬─────────────┘
                │ fetch(同源或跨域走 /proxy)          │
┌───────────────▼──────────────────────────────────▼─────────────┐
│  Python 后端 server.py :8001                                  │
│  /api/audio/stream (206, .tmp 无缝续流)  /api/audio/check      │
│  /api/qq/resolve  /api/agg/resolve  /api/kuwo/*  /api/migu/*   │
│  /api/local-music/*  /api/font/list  /api/config/load          │
│  /api/recognize/cache  /proxy?url=  静态文件(web/)             │
│  ├── qq_resolver  ── TierA~D 多源竞速解析+校验                  │
│  ├── agg_resolver ── gdstudio 酷我/网易 跨源兜底                │
│  └── local_music_server ── 本地曲库/缓存/配置                  │
└───────────────┬────────────────────────────────────────────────┘
                │ 外网
      QQ系CDN / 网易云 / 酷我 / 咪咕 / gdstudio / vkeys / ygking / byfuns
      (Node 18089) → amp.shazam.com 识曲 / OpenAI 兼容 AI 代理
```

**运行路径**：
1. Tauri 启动 → Rust `lib.rs` 直接 `spawn` `python server.py` 与 `node scripts/shazam-server.mjs`（不依赖 `cmd &&`）。
2. WebView 加载 `web/index.html`。
3. 主界面为单 `module script`（`src/app/index.js`），按编写顺序 import 全部 41 个分片，分片共享全局作用域并彼此 `import` 对方导出的函数。
4. 前端所有跨域请求（搜索/取链/歌词/CDN 封面）优先走同源 `server.py` 的 `/proxy` 与各 `/api/*`，避免跨域。

---

## 5. 后端服务

### 5.1 server.py — 主 HTTP 服务器

单文件、纯标准库、约 1200 行。`LyricServerHandler`（继承 `SimpleHTTPRequestHandler`）在 `do_GET` 中按路径前缀路由。启动时自动写 `version.json` / `build_info.json`（构建时间戳取 server.py 自身 mtime），端口占用时自动 `taskkill` 自愈（3 次重试）。

**API 端点表**：

| 端点 | 处理函数 | 用途 |
|---|---|---|
| `/proxy?url=<URL>` | `_handle_proxy` | 通用 CORS 代理，转发外部资源并附加 CORS 头 |
| `/api/version`、`/version.json`、`/build_info.json` | `_handle_version_api` | 构建版本信息 |
| `/api/local-music/list` | → `local_music_server.list_local_songs` | 本地音乐列表 |
| `/api/font/list` | → `local_music_server.list_local_fonts` | 本机字体列表 |
| `/api/config/load` | → `local_music_server.load_user_config` | 用户全量配置（localStorage 侧另有全量保存） |
| `/api/recognize/cache` | → `local_music_server.load_recognize_cache` | 识曲 ISRC 本地化缓存 |
| `/api/audio/stream?url=&songId=&nc=` | `_handle_audio_stream` | ★ 在线音频流式代理（边下边转、.tmp 缓存、无缝续流） |
| `/api/audio/check?url=` | `_handle_audio_check` | 轻量探测播放性（Range 读 2KB 即断） |
| `/api/migu/search?keyword=` | `_handle_migu` | 咪咕搜索（官方 H5 接口 + 加密解密） |
| `/api/migu/url?contentId=&copyrightId=` | `_handle_migu` | 咪咕取链（HQ/SQ/ZQ24/PQ 降级 + 免登录兜底 + 探测） |
| `/api/qq/resolve?mid=&dur=&q=&skip_cache=&stats=` | `_handle_qq_resolve` | QQ 解析池取链（详见 qq_resolver） |
| `/api/agg/resolve?title=&artist=&stats=` | `_handle_agg_resolve` | 聚合跨源兜底取链 |
| `/api/kuwo/search?word=` `/api/kuwo/url?id=&q=` `/api/kuwo/pic?id=` `/api/kuwo/lyric?id=` | `_handle_kuwo` | 酷我独立源（gdstudio 通道） |

**关键函数**：

- `_probe_audio_url(url)` — Range 读首 2KB，验证 2xx + 非 HTML 响应；用于取链结果前置过滤。
- `_sanitize_audio_ctype(url, upstream_ctype)` / `_audio_ctype_from_url` — 按合法 audio 头 → URL 扩展名 → `audio/mpeg` 兜底净化 Content-Type；避免 QQ 系 CDN 返回 `application/x-www-form-urlencoded` 之类错误 MIME 导致浏览器不解码（**停滞元凶之一**）。
- `_read_meta_total/_read_meta_url/_read_meta_ctype/_write_meta_audio` — `.meta` 文件读写：记录真实总长（Content-Range 分母）、上游 URL、真实 Content-Type。
- `_launch_bg_audio_download` — 完整缓存构建线程：边下边写 `.tmp`，完整后再 `os.replace` 为正式缓存并写 `.ok` 哨兵。
- `_try_seamless_tmp_stream` — **无缝续流**：把本地 `.tmp` 残片 + 上游续流拼成**同一个 206 响应**（先发响应头与残片保秒开，后台线程预连接上游 `bytes=<tmp_size>`，残片发完即可接力），消除"从头播放 1~4 秒断档"。
- `_serve_file_with_range(path, total_override, content_type)` — 206 Range 服务；`total_override` 用 `.meta` 真实总长做 Content-Range 分母（浏览器才能做时间→字节映射）；代码类文件（js/css/html/json/svg/mjs）强制 `Cache-Control: no-cache`。

**音频流缓存状态机（`_handle_audio_stream` 核心策略）**：

```
请求 /api/audio/stream?url=&songId=
  │
  ├─ ① nc=1（播放失败重试）→ 绕过全部缓存直接回源
  ├─ ② 完整缓存(.mp3 + .ok 哨兵字节数一致 + .meta 有 ctype) → 直读本地 206 秒开
  ├─ ③ 旧 .tmp 无 ctype 记录 → 删残片强制重建（防异源拼接）
  ├─ ④ 从头播放(start=0) + 陈旧残片(>10s) → 清残片，走 writer 纯净回源
  └─ ⑤ 通用：单线程 Writer 认领（_AUDIO_CACHE_WRITERS 互斥），其余请求只代理
```

- **Writer 认领互斥**：同一 `song_id` 仅一个从头请求负责写 `.tmp`（`_AUDIO_WRITERS_LOCK`），杜绝"截断半成品 + 交错写入 + 晋升损坏缓存"竞态（Windows 文件锁问题根源）。
- 上游断连后 writer 认领权移交后台续传线程，保证 `.tmp` 不中断。

### 5.2 qq_resolver.py — QQ 音乐多源解析池

供 `/api/qq/resolve` 使用，纯标准库。核心是 `resolve(mid, dur, quality, skip_cache)`。

**返回链（实测排序，均带 8s 竞速超时）**：

| 层级 | 源 | 说明 |
|---|---|---|
| Tier A 竞速（先到先得） | vkeys 新接口 q14 母带 / ygking(master) / nki(sq) | 三源并行 `_race()` |
| Tier A2 竞速降档 | vkeys q10 无损 / ygking(flac) | |
| Tier B 顺序降级 | tang(sq) → xcvts(HQ/SQ) → moeyao(meting) | |
| Tier C 节流备胎（防 429） | xianyuw(hires) → hk0cc(sq) | |
| Tier D 官方兜底 | GetVkey F000(flac) → M800(320) → M500(128) | 直接带 GUID 的官方接口 |

**防伪校验 `validate_url(url, expect_dur)`**：Range 抓首 128KB + 魔数嗅探（`fLaC`/`ID3`/`OggS`/`ftypM4A`/裸 MP3 帧）；FLAC 解析 STREAMINFO 时长、MP3 按字节数×8/码率估算时长，与官方时长比对（容差 ±5s 或 5%）。目的：拦截 API 返回的 30~60s **试听片段**伪装完整曲。

**健康度**：连续失败 ≥3 进入 120s 冷却；死链阈值 5。**缓存**：LRU 256 条，TTL 15 分钟，5 分钟内直接返回不做预检。

### 5.3 agg_resolver.py — 聚合跨源兜底 / 酷我独立源

- `resolve_same_song(title, artist)` — gdstudio `api.php` 多源（kuwo → netease）搜索 + 名称相似度排序（完全相等 > 括号前缀 > 包含）+ 取链 + 复用 qq_resolver 的校验；10 分钟 LRU 缓存、源健康度记录。
- 同时提供酷我独立接口给 `/api/kuwo/*`：`search_kuwo(word, num, page)`、`resolve_kuwo_song(sid, quality)`（br 999/400/320 降级）、`kuwo_pic(sid)`、`kuwo_lyric(sid)`。
- 仅当 QQ 主链 + 酷狗 + 咪咕全失败后才被前端触发（低延迟旁路）。

### 5.4 local_music_server.py — 本地音乐 / 缓存 / 配置

- 目录约定：`local_music/<歌手> - <歌名>/` 下含 `song.mp3`、`cover.jpg`、`lyrics.lrc`、`lyrics.elrc`（增强逐字）、`metadata.json`。
- `list_local_songs()` 扫描整库；`list_local_fonts()` 返回系统字体。
- `sanitize_filename()` 清洗非法字符；`get_or_cache_audio_file()` 预缓存音频到 `cache/audio/`。
- `load_user_config/load_recognize_cache`：用户配置与识曲 ISRC 缓存。
- `cleanup_audio_cache(keep_id)`：整曲写完后清理其它累积缓存。

### 5.5 scripts/shazam-server.mjs — 识曲 Node sidecar

端口 `127.0.0.1:18089`。路由：

- `GET /health` — `{ ok, service, port, up: {shazamioCore, ffmpeg} }`
- `GET /proxy?url=` — 通用 CORS 代理（musicApi 的 `proxyFetch` 备选）
- `POST /recognize` — body `{ audioBase64, filename }` → **Shazam 声学指纹识曲**

识别流程 `recognizeFile`：用 ffmpeg（`@ffmpeg-installer/ffmpeg`）截取 `[0,20,45,75,100]` 秒多点 16kHz 单声道 10s WAV 片段 → `shazamio-core` 计算指纹 → 多 offset 提交 Apple Shazam 官方识别服务器（`amp.shazam.com/discovery/v5`），任一命中即返回 `track` 信息。前端 Shazam 全部 misses 时回退 Vosk 语音转写 + 歌词反查（见 8.3）。

### 5.6 遗留入口（已删除）

- `app.py`（pywebview 壳）、`main.js`（Electron 壳）与根目录 `index.html` 单文件版已随旧壳清理一并移除（见 git 历史）。桌面壳唯一入口为 Tauri v2（`src-tauri/`）。

---

## 6. 前端架构

### 6.1 入口与分片加载机制

- `web/index.html` 仅引入一个 ES Module：`<script type="module" src="./src/app/index.js">`（外加 segmentit / kuromoji 两个 `async` CDN 分析脚本；`async` 非阻塞、不参与 DOMContentLoaded 等待，晚到不影响功能）。
- `web/src/app/index.js`（自动生成）按**求值顺序** `import` 41 个分片（`000-tooltip.js` → `250-desktop-lyrics.js`）。分片间通过 ES module 显式 `import` 共享函数（如 `245-playlist-manager.js` import 20/120/135；`95-track-loading.js` import 20/30/40/65/70/85/120/135/155/180 等），并共用 `globalThis` 上的全局状态。
- **防缓存**：分片 import 语句不再带 `?v=`；统一依赖服务端对 js/css/html/json/svg/mjs 强制 `Cache-Control: no-cache`（见 5.1 `_serve_file_with_range`），个别资源仍保留手动版本串（如 `pv-tunnel.css?v=tunnel_fix_2`、`/icons/icon.png?v=aria1`）。
- 每个分片头部注明"由 `split_app.js` 从原 `web/src/app.js` 拆分，来源区间 X-Y 行"。
- `web/src/app.js` 原保留作为拆分参照源，已于 2026-09 删除（分片拆分完成、无代码引用）；头部注释中的历史行号仅供溯源。

### 6.2 分片清单（web/src/app/）

| 分片 | 职责 | 关键函数/导出 |
|---|---|---|
| `000-tooltip.js` | ★ 全局统一 tooltip：无论 `data-tooltip` 还是原生 `title`，悬停统一渲染为黑色圆角气泡（挂在 `<body>`，`position:fixed`，不随父级旋转/缩放动画），并自动迁移 `title`→`data-tooltip` 消除系统白色原生提示 | 自执行 IIFE，全局注入 `#aria-tip` 样式与元素 |
| `10-config-state.js` | 全局状态与配置初始化：词云状态、歌词偏移、代际计数器、下一曲预加载、播放方式、倍速/下载、EQ、在线搜索、预设合集、`tunnelEngineInstance` | `PERFORMANCE_PROFILES`、`langFamilyName()`、`initDomCache()` |
| `20-lyrics-render.js` | ★ 基础歌词渲染：创建/维护 `audio` 元素、DOM 引用、歌词行渲染 | `audio`、`renderLyrics` |
| `30-dom-refs.js` | DOM 引用集中缓存，避免各分片重复 querySelector | `playBtn`、`progressEl`… |
| `40-playback-state.js` | 播放状态数据（播放/暂停/当前行/子行时间） | `updateLineTimes()`、`getLyricOffset()` |
| `55-wc-tuning.js` | 词云模式参数驱动（滑块 → 词云布局） | — |
| `56-playback-misc.js` | 播放杂项：时长获取、飞入模式翻译/罗马音区更新 | `getDuration()`、`updateFlyinTranslation()` |
| `57-wordcloud-camera.js` | ★ 词云相机：焦点字选择、缩放/平移非线性补间、双向移动、上下采样 | `updateWordcloudCamera()` |
| `60-mobile-dual-page.js` | 触控双页（控件页 ↔ 歌词页）左右滑动 | — |
| `65-playback-position.js` | 播放位置：进度条/时间更新、`play/pause` 统一入口 | `waitForAudioReady()`、`togglePlayPause()`、`PLAY_ICON_PATH` |
| `70-audio-engine.js` | ★ 音频引擎：事件驱动 + 停滞自愈（8s 无进度→回退 2s 续播、3 连败整曲重试）、缓冲状态同步 | `handleAudioPlayError()`、`attemptStallRecovery()` |
| `75-play-mode.js` | 播放方式（顺序/循环/随机）图标与切换 | `updatePlayModeIcon()` |
| `80-context-menu.js` | 右键菜单与确认弹窗 | `showCtxMenu/ctxConfirmOk…` |
| `85-rate-download.js` | 倍速/变速不变调/下载 | `applyPlaybackRate()`、`applyPreservesPitch()`、`downloadCurrentSong()` |
| `90-eq.js` | Web Audio 10 段均衡器 + 上一曲/下一曲按钮 + 菜单挂接 | `initEqAudioGraph/cleanupEqAudioGraph()` |
| `95-track-loading.js` | 队列切歌：加载本地/在线曲目、代际控制 | `loadTrack()`/`loadPlaylistTrack()` |
| `100-cover-background.js` | 封面加载（Image 对象校验）、双层模糊背景、颜色遮罩、歌词行点击跳转（currentTime 钳制 ≥0） | — |
| `110-keyboard-nav.js` | 全键盘 Tab 导航 + 滑块 aria 同步 | — |
| `120-search-results.js` | 搜索结果交互、收藏按钮状态、音源按钮同步 | `makeSongKey/updateFavoriteBtn/closeSearch` |
| `125-favorites.js` | 收藏列表渲染/播放/管理 | — |
| `130-playlists.js` | 歌单系统：创建/删除/重命名/拖拽排序/右键/渲染/整单播放/本地曲播放 | `getPlaylists/savePlaylists`、FLIP 排序 |
| `135-crossfade.js` | 切歌音量处理（标准化+淡入）、播放失败自动重试（强制重取 URL + 指数退避 + 备用源）、AI 分析错峰触发 | `applyVolumeOnSongChange()`、`loadPlaylistTrack()` |
| `140-playlist-ui-events.js` | 歌单 UI 事件：返回/新建/保存队列/URL 导入/来源判断/短链解析 | — |
| `145-playlist-import.js` | 歌单导入：网易云（apicx 分页 + unmeta 兜底）、QQ（分页）、短链 | `importExternalPlaylist()` |
| `150-search-engine.js` | 搜索核心：按音源缓存分页数据、回车/按钮/结果点击/播放全部 | `searchSongs()` |
| `155-random-toast-match.js` | 随机歌曲 API（限流 2s/4 次）、匹配度计算 | `fetchAndPlayRandomSong()`、`calculateSongMatchScore()` |
| `157-search-history.js` | 搜索历史（按音源分开存储、去重置顶） | — |
| `160-text-normalize.js` | 听歌识曲：ISRC 缓存/本地化命名、文字脚本检测 | `detectScript/getIsrcCache/localizeRecognizedName` |
| `165-audio-recognize.js` | 识曲 UI + 录音/上传 + Shazam 对接；失败 → Vosk 转写 + 歌词反查 | — |
| `170-lyric-sources.js` | 多源歌词：真实探测（并发）+ 匹配度 + 来源徽章/弹窗/极速切换 | `switchLyricSource()`、`lyricSourceProbeCache` |
| `175-track-index-online.js` | ★ 在线歌曲加载链路：QQ 主链（解析池 + ygking 并行竞速 → vkeys）→ 网易（byfuns 降级 → 外链）→ 关联源接管；预加载 | `loadOnlineSong()`、`initPlayer()`、`pickInitialTrackSelection()` |
| `180-boot-config.js` | 启动引导：预加载默认曲、配置装载、设置面板初始化 | `preloadDefaultSong()`、`getStreamCachedAudioUrl()` |
| `190-settings-fontsize.js` | 全局设置应用（`applyAllSettings`）与字号 | `applyAllSettings()` |
| `200-settings-panel.js` | 设置面板（外观/视图/均衡器等）事件绑定 | `initSettingsPanel()`、`refreshSettingsUI()` |
| `210-color-multilang.js` | 颜色与多语言字体统一 | — |
| `215-multilang-fonts.js` | 自定义字体（FontFace + unicode-range 分语言族），IndexedDB 加载 | `initCustomFonts()` |
| `220-shortcuts-viewmode.js` | 快捷键 + 视图模式切换、设置提示、★流光隧道 AI 分析确认框（token 提醒/三模式/缓存记忆） | `showSettingsHint()`、`ensureTunnelAnalysis()` |
| `230-touch-gestures.js` | 触控适配：双页滑动、滑杆拖拽、目标尺寸/热区外扩 | — |
| `240-titlebar.js` | 自定义标题栏（透明背景、SVG 三键、随背景变色） | — |
| `245-playlist-manager.js` | ★ 右下角「当前播放队列」快捷管理面板：列表样式与搜索页一致（封面/歌名/歌手/收藏）、点击切歌、丝滑拖拽排序（其余歌曲 FLIP 动画让位）、清空队列；import 20/120/135 | `render()`、FLIP 拖拽排序 |
| `250-desktop-lyrics.js` | ★ 桌面歌词主窗口侧：开关状态 + 每 120ms 推送当前行/进度/逐字词/翻译/主题色到 localStorage('aria_dtk_state')，调 Tauri 命令 | `invoke('desktop_lyrics_show/click_through')` |
| `258-rankings.js` | ★ 手写分片：音乐榜单页（QQ/酷狗/网易三大 Tab，右上角按钮、三源数据走服务端 /api/rank/*）、最近播放历史(localStorage，歌单列表入口)、播放统计(常听歌曲/歌手/近7日)、EQ 分享码(复制/导入，AriaEQ1.+base64) | `openRankings()`、`openRecent()`、`openStats()`、`recordRecentPlay()`、`ensureKugouFull()`、`copyEqShareCode()` |

> 注意：`250-desktop-lyrics.js` 是桌面歌词**主界面侧**的控制器；歌词渲染本体在 `lyrics.html`。

### 6.3 核心引擎（web/src/core/）

| 模块 | 职责 | 关键类/函数 |
|---|---|---|
| `audioPlayer.js` | 音频播放核心（Audio 元素封装） | `getDuration()`、`togglePlayPause()`、`handleAudioPlayError()`、`waitForAudioReady()`、`updatePlaybackPosition()`、`initAudioEvents()` |
| `lyricEngine.js` | 歌词渲染引擎：LRC/YRC、逐字高亮、虚拟滚动、DOM 缓存 | `renderLyrics()`、`cacheLyricElements()` |
| `themeEngine.js` | 主题/字体：字号、模糊、高亮色、背景、主题色、封面主色提取 | `applyLyricFontSize()`、`applyHighlightColor()`、`extractMainColor()` |
| `previewEngine.js` | 设置面板外观预览（PV + 可视化 + YRC 硬编码数据） | `PreviewEngine`、`resolveFontFamily()` |
| `aiAnalyzer.js` | AI 情绪分析入口（→ 主题 JSON） | `getLyricsTextForAI()`、`buildAIRequest()`、`extractAIStreamChunk()` |
| `chorusDetector.js` | 纯 JS 高潮检测（降采样/FFT/band 聚合/重复检测，可走 Worker） | `_fft()`、`_cosineSim()` |
| `stallDetector.js` | 播放停滞检测（轮询 currentTime + stalled/waiting/playing） | `startStallCheck/stopStallCheck/setBuffering` |
| `equalizer.js` | 10 段 Web Audio EQ 图 | `initEqAudioGraph/cleanupEqAudioGraph` |
| `fadeController.js` | rAF 平滑音量淡入淡出 | `fadeOutVolume/fadeInVolume/cancelAllFades` |
| `shortcutManager.js` | 键盘快捷键统一管理 | `initShortcutManager()` |
| `visualizers/VisualizerBase.js` | 可视化渲染器基类：标准化生命周期（`init/setLyrics/update/start/stop/destroy`）+ 通用工具（建容器、resize、rAF 管理）；子类实现 `getModeId()/onInit()` | `VisualizerBase`（`init/update/resize`） |
| `visualizers/VisualizerManager.js` | 可视化模式调度（dimension/polyphony 注册切换） | `switchMode/setLyrics/update/applySettings` |
| `visualizers/DimensionVisualizer.js` | 浮空模式（Dimension）：**逐字符**染色（非整词）、染色平滑渐变（0.18s 进主题色、唱过停留 0.15s 后 0.45s 变白）、零发光、独立实体空格（`.dim-space`）、摄像机实时平滑追踪唱到字符中心；组合下方四个 dimension/ 子模块 | `onInit/start/stop` |
| `visualizers/dimension/DimensionAudio.js` | 浮空模式 - 非侵入式安全频谱/节奏分析器（不劫持媒体节点），输出 bass/mid/treble/overall/peakEnergy | `connect()`、`update()` |
| `visualizers/dimension/DimensionBackground.js` | 浮空模式 - 3D 空间纵深背景（渐变舞台/纵深网格等） | — |
| `visualizers/dimension/DimensionCamera.js` | 浮空模式 - 3D 位置(XYZ) + 欧拉角(Pitch/Yaw/Roll) 平滑阻尼摄像机，支持冲击震屏 | `setTarget()`、`addImpulse()`、`update()` |
| `visualizers/dimension/DimensionShapes.js` | 浮空模式 - 纯点阵粒子几何引擎（圆柱/立方体星群，逐粒子映射频谱频段实时起伏，无棱边线条） | `createCylinderGeometry()` 等 |
| `visualizers/PolyphonyVisualizer.js` | 和鸣模式：多声部气泡对话流、歌手徽章、主/伴唱分栏 | `onLyricsLoaded()`、`_renderBubbles()` |
| `pvEngine/PVEngine.js` | ★ PV 模式主调度（编排 layout/camera/rendering/decorations/background） | `init()`、`applySettings()` |
| `pvEngine/PVLyricLayout.js` 等 | PV 布局、相机、渲染（SVG/CSS 逐字）、装饰、AI 主题背景 | — |
| `pvEngine/WordSegmenter.js` | PV 逐字分词（含过长单词按字符上浮的切分）；`segmentFine()` 细粒度分词（日文 ≤4 字聚合） | `segment()`、`segmentFine()` |
| `pvEngine_backup/`（目录） | PV 引擎旧版完整备份（`PVEngine.js/PVLyricLayout.js/...`），当前未启用，供对照与回滚，勿删 | — |
| `tunnelEngine/TunnelEngine.js` | ★ 流光隧道主时间线：三级层级过渡检测（Shot→Group→Section）+ 词级排版构建 + 字符三态 + 焦点纯计算（防抖）+ 深浅背景反色 + shot 色相偏移 | `init()`、`setLyrics()`、`update()`、`applySettings()` |
| `tunnelEngine/TunnelDirector.js` | 导演层：三级层级构建、ShotParams 参数化生成、四维样式合成、`assignWordLayouts()` 词级槽位（竖/横/斜）、`_refineBlocks()` 细拆、拆字粒度三档 | `build()`、`findShotAt()` |
| `tunnelEngine/AILyricSegmenter.js` | ★ AI 驱动句意分段器：将词块按句意划为「页」(4~7 词/页)、页内按词组划分换行、分配对齐(left/center/right)与背景主题；消费 AI `line_analyses`（含 `page_index/line_breaks/alignment`），无 AI 数据时纯规则降级；与 Director 集成（`_refineBlocks()` 调用） | `segmentBlocksByAI()`、`multiPageSegment()` |
| `tunnelEngine/TunnelCameraTrack.js` | 摄像机：Catmull-Rom 组轨道 + 运镜马达混合（push/dive/orbit/spiral…）+ 弹簧速度积分 + 焦点优先锁定 | `update()`、`planGroupTrack()` |
| `tunnelEngine/TunnelDepthStack.js` | 3D 深度堆叠背景层（演完句组推入 Z 轴）+ 视差/涟漪/运动拉伸/方向光/DOF + 3D 粒子 Canvas | `pushGroupToBackground()`、`update()` |
| `tunnelEngine/TunnelAnimations.js` | 8 大类 WAAPI 入场/出场库、几何蒙版转场、37 种装饰库（`DECORATION_LIBRARY`）、`splitToCharAnimParams()` 每字独立参数 | `playEnterAnimation()`、`pickDecorationCombo()` |

### 6.4 服务层（web/src/services/）

| 模块 | 职责 | 关键函数 |
|---|---|---|
| `musicApi.js` | ★ 多源搜索/取链/歌词/代理封装 | `jsonp()`、`proxyFetch()`、`searchKugouSongs()`、`getPlayUrl()`、`fetchLyricFromOiapi()`、`fetchLyricWithFallback()`、`fetchRandomSong()`、`checkAudioUrlPlayable()`、`qqResolveUrl()`、`fetchSameSongUrlFrom()`、`fetchMiguSameSongUrl()` |
| `aiClient.js` | Gemini/OpenAI 兼容客户端 + 代理 URL 统一 | `cleanApiBase()`、`buildGeminiUrl()`、`geminiGenerateContent()`、`testGeminiConnection()` |
| `aiCache.js` | AI 分析结果 IndexedDB 缓存（**勿删**） | `aiCacheGet/Set/GetAll/BulkSet/Clear/Count` |
| `localMusicManager.js` | 本地音乐生命周期：上传/识曲/歌词检索/匹配/Enhanced LRC 落盘 | `LocalMusicManager`、`processLocalMusicUpload()` |
| `favoritesService.js` | 收藏 CRUD（localStorage） | `getFavorites/saveFavorites/makeSongKey` |
| `playlistService.js` | 歌单 CRUD | `getPlaylists/savePlaylists/createPlaylistData/deletePlaylistData` |
| `fontService.js` | 自定义字体 IndexedDB 存储 + FontFace 加载 | `saveFontToDB/loadFontFace` |
| `krcParser.js` | 酷狗 KRC 解密（base64 → XOR → zlib → 解析） | `decryptKrc()`、`parseKrc()` |
| `lyricMatcher.js` | 四维加权歌词匹配度（文本/歌手/版本/时长/精度） | `calculateLyricMatchScore()` |
| `enhancedLrcConverter.js` | Enhanced LRC（毫秒 + 逐字打点）双向编解码 | `convertToEnhancedLrc()`、`formatWordTimestamp()` |

### 6.5 解析器（web/src/parsers/）

| 模块 | 职责 |
|---|---|
| `lrcParser.js` | 标准 LRC 解析（过滤 QQ 元数据标签、兼容多种时间戳） |
| `yrcParser.js` | 网易云 YRC（逐字）解析 |
| `romaParser.js` | 罗马音 LRC 解析 |
| `lyricMerger.js` | 原词/翻译/罗马音多源按时间对齐合并；`detectAndParseLyrics()` 自动识别格式 |
| `krcParser.js`（services/） | 酷狗 KRC 解密解析 |

### 6.6 基础设施与配置（infrastructure / config / utils）

- `infrastructure/dom.js` — DOM 获取与双背景/封面层管理（`getBlurBgLayers/getCoverLayers`）；`eventBus.js` — 事件总线（`EVENTS`）；`state.js` — 全局 `state` 对象。
- `config/constants.js` — 存储键、API 基址、EQ 频段、虚拟滚动参数、IndexedDB 名、AI 供应商等常量。
- `config/defaults.js` — `DEFAULT_SETTINGS`、`playerConfig`、`DEFAULT_SONG`、`DEFAULT_SHORTCUTS`。
- `config/performance.js` — 性能档位。
- `utils/formatters.js` — `formatTime/escapeHtml/processTextForLatin/splitLongLine`（拉丁词间距、超长行拆分）。
- `utils/colorUtils.js` — HSL/RGB 互转、提色、封面色板。

### 6.7 桌面歌词子窗口（web/lyrics.html）

独立透明窗口 `desktop_lyrics`，由 Tauri 加载。**数据通道**：主界面 `250-desktop-lyrics.js` 每 120ms 将当前行/逐字词/翻译/进度写入 `localStorage('aria_dtk_state')`；歌词窗口监听同源 `storage` 事件即时渲染（跨窗口同源共享存储）。**渲染细节**：

- `.line` 单行不换行，窗口宽度随内容自适应；拉丁词 `.word-latin` 保留 0.25em 词间距。
- **逐字本地插值**：rAF 每帧以墙上时钟推进 (`lineFillRatio`/`applySmoothFills`)，消除 120ms 推送颗粒的阶梯感（Apple Music 风格逐字上浮/填色）。
- 顶部 34px 工具条区（锁定/解锁、字号 ±、关闭、拖动），与歌词容器不重叠；解锁提示在锁定状态下延迟显示。
- 锁定 → 调 `desktop_lyrics_click_through(enable:true)` 实现全局穿透点击。

---

## 7. Tauri 壳层（src-tauri/）

- `lib.rs`：
  - **Sidecar 状态机** `SidecarState{children, running}` — `spawn_sidecars()` 在 Windows 直接 `Command::new("python").arg("server.py")` 与 `node scripts/shazam-server.mjs` 并行拉启；`project_root()` 从 exe 路径反推工程根规避 CWD 问题。
  - Tauri 命令：`sidecar_status/start/stop`；桌面歌词 `desktop_lyrics_show/move/pos/click_through/start_drag/resize`（`click_through` 用 `AppHandle` 显式取目标窗口，避免注入到调用方窗口）。
  - 窗口 resize 保持中心点不变。
- `tauri.conf.json`：产品名 Aria、2.6.0、`frontendDist: ../web`、主窗口 + `desktop_lyrics` 透明无边框窗口（`decorations:false, transparent:true, alwaysOnTop`）。
- `capabilities/default.json`：core/window/shell 权限声明。
- `build-dev.bat`：加载 VS2026 x64 环境 → `cargo build`。

---

## 8. 关键数据流

### 8.1 在线播放链路

```
搜索/歌单/收藏选歌
  → loadOnlineSong()（175-track-index-online.js）
       QQ: /api/qq/resolve(mid,dur) 解析池 ←→ 并行直连 ygking.top 竞速，先到先得
            解析池命中则跳过 ygking；ygking 各音质(master→atmos→flac→320→128)失败后
            回退 /api/qq/resolve + vkeys；仍败 → 同歌手/同类目跨源接管
       网易: byfuns API（exhigh→lossless→higher→standard→hires 降级）→ 163.com 外链
       最后兜底: /api/agg/resolve（酷我→网易，gdstudio）
  → 每条取链结果先 checkAudioUrlPlayable（/api/audio/check 2KB 探测）
  → audio.src = getStreamCachedAudioUrl(url, id)  # /api/audio/stream?url=&songId=
  → server 206 边下边转 + .tmp 缓存（见 5.1 状态机）
  → 前沿 JS 停滞自愈：8s 无进度/stalled/9s 无数据 → 回退 2s + audio.load() 重建请求；
     同一位置 3 次无效 → 整曲重试（skipCache=nc=1 强制回源）
  → 失败重试：强制重取 URL + 指数退避 + 备用源切换
```

### 8.2 搜索链路

`150-search-engine.js` 调用 `musicApi` 的 vkeys/酷我/咪咕等接口（带 `/api/kuwo/search` 等后端归一化），按音源缓存分页数据；搜索结果支持收藏、加歌单、播放全部、加入队列。

### 8.3 听歌识曲链路

```
录音/上传 → 165-audio-recognize.js
  → POST http://127.0.0.1:18089/recognize（node-shazam 指纹，多 offset 扫描）
  → 命中 → ISRC 本地化命名（160-text-normalize）→ 搜索播放
  → 未命中（未知歌曲）→ Vosk(系统 Python) 转写歌词片段
      → 在线按词反查曲目（网易→QQ，取最像歌词前段的候选）
  → 识曲结果进 recognize_cache.json 本地缓存，记忆化重复歌曲
```

### 8.4 多源歌词

`170-lyric-sources.js` 对 QQ/网易/酷狗/本地等多源**并发真实探测**（真正获取歌词验证逐字与翻译），结合 `lyricMatcher` 匹配度打分，弹窗展示带徽章的源列表；切换极速，结果全局缓存。

### 8.5 AI 情绪分析

`aiAnalyzer.js`（受 135-crossfade 错峰触发，避开播放起步 1-2s）→ 组装歌词文本 + 情绪提取 Prompt → `aiClient.geminiGenerateContent()`（可走用户配置的 OpenAI 兼容代理）→ 流式解析主题 JSON → `themeEngine` + `PVEngine` 应用背景/主题。结果存 IndexedDB（`aiCache.js`）。

**排版分页（line_analyses）为程序化本地生成，不走 LLM**（folia 作者方案：排版本是「文字分词测量 + 二维搜索」的确定性计算）——`proceduralLayout.generateLineAnalyses()` 用与 PVLyricLayout/TunnelDirector 同一条 wordSegmenter 管线分词（group_indices 精确对齐）、宽度 DP 断行分页、情感词典投票定情绪、副歌区间与 `chorusDetector._estimateTempo()` 实测 BPM 调制能量；`themeObj.rhythm` 携带 `{bpm, confidence, beatOffsetSec}`。全确定性：无 Math.random，同一首歌每次结果一致。

---

## 9. 依赖关系

### 后端（Python，仅标准库）
```
server.py ──→ local_music_server（本地库/缓存/配置）
          └→ qq_resolver（QQ 解析池；agg_resolver 复用其 validate_url）
          └→ agg_resolver（gdstudio；依赖 qq_resolver 校验）
```

### 前端核心依赖链
```
index.html
  └→ src/app/index.js（按序 import 41 分片）
        ├→ 000-tooltip（全局 tooltip，无依赖）
        ├→ 10-config-state ←── 全局状态
        ├→ 20-lyrics-render → audio 元素
        ├→ 30-dom-refs
        ├→ 65-playback-position ├→ 70-audio-engine（停滞自愈）
        ├→ 95-track-loading ──→ 135-crossfade（重试/淡入）→ 175-track-index-online（在线加载）
        ├→ 245-playlist-manager → 20/120/135（队列管理）
        ├→ 170-lyric-sources → parsers/lyricMerger + services/lyricMatcher + musicApi
        ├→ 165-audio-recognize → 18089 sidecar + Vosk
        ├→ 215-multilang-fonts → fontService(IndexedDB) → FontFace
        └→ 200-settings-panel → themeEngine/previewEngine/PVEngine/VisualizerManager
```

**引擎内部依赖**：
```
PVEngine → PVLyricLayout → WordSegmenter（segment/segmentFine）
TunnelEngine → TunnelDirector → AILyricSegmenter（segmentBlocksByAI/multiPageSegment）
            → TunnelCameraTrack / TunnelDepthStack / TunnelAnimations
            → PVLyricLayout + WordSegmenter（复用 PV 分词）
VisualizerManager → DimensionVisualizer → dimension/{Audio,Background,Camera,Shapes} + VisualizerBase
                 → PolyphonyVisualizer → VisualizerBase
```

### 第三方依赖
- **前端**：segmentit、kuromoji（CDN）。
- **Node**：shazamio-core、@ffmpeg-installer/ffmpeg（`scripts/`）。
- **Rust**：tauri 2、tauri-plugin-opener、tauri-plugin-shell、image（`src-tauri/Cargo.toml`）。
- **Python**：无（纯标准库）；识别转写需系统 Python 装有 `vosk`。

---

## 10. 构建与运行

### 前置依赖
- Python 3（含 `vosk`，供语音转写；后端本身无需第三方包）
- Node.js ≥ 18（shazam-server 依赖 `node_modules`：`shazamio-core`、`@ffmpeg-installer/ffmpeg`）
- Rust + VS 2026 x64 工具链（Tauri 桌面构建）；Web 运行不需要

### 方式一：浏览器直接运行
```bash
python server.py
# 打开 http://localhost:8001/index.html
# 不依赖 Node；Shazam 识曲功能不可用（需 18089）
```
如仅需识曲再开一个终端：`node scripts/shazam-server.mjs`。

### 方式二：Tauri 桌面版（推荐）
```bash
# 一键启动（含结束旧进程 + 清理占用 8001/18089 的进程 + cargo build + 启动）
强制重启Aria.bat
# 或
启动Tauri桌面版.bat
# 或手动：
cargo build --manifest-path src-tauri/Cargo.toml
src-tauri/target/debug/aria-player.exe
```
Tauri 启动时自动拉起 `server.py`(8001) 与 `shazam-server.mjs`(18089)，关闭应用即连带终止。

### 版本防缓存机制
- **主防线**：服务端对 js/css/html/json/svg/mjs 强制 `Cache-Control: no-cache`（`_serve_file_with_range`），每次改动刷新即生效，无需手工递增版本号。
- **辅助**：个别静态资源（如 `pv-tunnel.css`、`/icons/icon.png`）仍带手工 `?v=` 版本串，改动该资源时顺手递增即可。
- 服务端构建时间戳：启动时写入 `version.json` / `build_info.json`（server.py mtime），Web 端 `/api/version` 与 Tauri 并行校验版本。

---

## 11. 端口与配置约定

| 项 | 值 |
|---|---|
| 后端 HTTP | `8001`（WEB_DIR=`web/`，静态根） |
| Node 识曲 | `127.0.0.1:18089` |
| 缓存目录 | `cache/audio/`：`<songId>.mp3` + `.tmp`（残片）+ `.meta`（total/url/ctype）+ `.ok`（字节哨兵） |
| 本地曲库 | `local_music/<歌手> - <歌名>/` |
| 调试日志 | `server_debug.log`（`[AudioStream]`/`[Seamless]` 流式代理明细）与标准输出 |
| localStorage 键 | `aria_dtk_enabled/locked/pos/state`、收藏/歌单/设置/EQ/性能键见 `constants.js` |
| IndexedDB | AI 缓存库、字体库（见 `constants.js`：`AI_DB_NAME`、`FONT_DB_NAME`） |

---

## 12. 关键设计要点（踩坑沉淀）

1. **高亮必须是左右渐变填充（clipPath/--reveal）**：强制整词激活 CSS 会瞬间全亮；渐变填充随进度推进，情感词/普通词一致。
2. **缓存一致性三件套**：`进行时 .tmp` + `.meta`(总长/URL/ctype) + `.ok`(字节哨兵)。无 `.ok` 或 mtime 过旧的 `.tmp` 一律不直读、重建回源；**缓存重建必须同时删 `.tmp` 与 `.meta`**，杜绝异源拼接。
3. **Writer 认领互斥**：一个 song_id 只允许一个线程写缓存，防 Windows 文件锁 + 交错写入损坏。
4. **MIME 净化**：QQ 系 CDN 假 Content-Type 按 URL 扩展名兜底；`.meta` 记录 **真实** Content-Type，所有直读/续流路径沿用，防 MIME 突变导致解码停滞。
5. **无缝续流**：`.tmp` 残片与上游 `bytes=<tmp_size>` 续流合并为一个 206 响应，头部先发、残片秒发，消除 1~4s 断档；上游未按预期 206 则提前收尾交给浏览器续段重发（标准恢复，不损坏流）。
6. **停滞自愈**：前端 8s 无进度 / stalled / 9s 无数据 → `audio.load()` 重建请求 + 回退 2s；需 `stallRecovering` 锁 + `stallSeq` 代际防多定时器并发抢占；`play()` 的 AbortError 在恢复期间视为正常流程。缓冲期间置 `playing=false`，同步桌面歌词与主界面。
7. **切歌重试**：强制重取 URL（`skip_cache`/`nc=1` 绕过全部缓存）+ 指数退避 + 备用源，避免"旧 URL 反复失败"循环。
8. **QQ 解析池**：Tier A~D 竞速/顺序降级 + 试听片段防伪校验（魔数 + 时长比对）+ 健康冷却，保证链接真实可播。
9. **多语言字体**：每语言独立 FontFace 族名（`MultiLangFont-zh/ja/ko/...`），按 unicode-range 命中，防止跨语言回退串字体；`unicode-range` 区间必须合法（start ≤ end）。
10. **性能**：词云三阶段批量读/写（读布局→计算→写 DOM）避免强制回流；缓存 `getBoundingClientRect`；滑杆 200ms debounce；rAF 保持 ~60fps；桌面歌词用本地墙上时钟插值。
11. **识曲回退**：Shazam「未知歌曲」不回退到临时文件名伪造元数据；改为 Vosk 转写歌词 + 在线按词反查。
12. **歌词跳转**：点击歌词行计算的 `currentTime` 钳制 ≥0，防止负值导致播放锁死。
13. **静态文件 no-cache**：js/css/html/json/svg/mjs 强制 no-cache（分片防缓存的主防线，个别资源另有手工 `?v=`）。
14. **窗口透明与背景衔接（切歌透出桌面）**：Tauri 主窗口 `transparent: true`，且 `html.aria-desktop, body.aria-desktop` 强制 `background: transparent !important`。页面背景完全由双层 `.blur-background`(z-index:-2) + `.color-overlay`(z-index:-1) 承担。切歌/换封面时 `setBlurBackground/setCoverImage` 的 `tryCrossfade` 让新层 opacity 0→1、旧层 1→0（均 0.8s 过渡），**任一瞬间两层叠加合成不透明度 <100%**（如各 0.5 → 区域合成≈75%），底层透出透明 html/body → 短暂显示桌面内容。修复：`body::before` 固定全视口 `z-index:-3` 纯黑不透明保底层，垫在所有背景层之下；窗口内部永不露桌面，圆角镂空观感由 `body{overflow:hidden;border-radius:12px}` 裁剪保留。
15. **`/api/qq/resolve` 的 dur 传参规范**：`dur=0`（或缺失）在 `qq_resolver.validate_url` 中为假值，**整体跳过防试听时长比对**——能拿到链接但也可能放进 30~60s 试听片段/低码率残片；传**真实时长**（由 vkeys 搜索结果的 `interval`("4分25秒") 经 `intervalToSec` 归一）时校验生效，时长不符 → `invalid:trial` → 落入下一 provider。主播放链（175-track-index-online）与下载/预加载路径必须统一传真实时长；当年份/专辑版本与 mid 不匹配导致长度差异过大时（容差 ±5s 或 5%），全源失败返回 `all_providers_failed`，前端走强制重取 + 备用源兜底。
16. **服务进程自愈（"突然不播放"排查）**：前端所有请求都打到 `server.py`(8001) 与 shazam sidecar(18089)；两个进程意外退出（如 `强制重启Aria.bat` 在 PowerShell 下输入重定向失效、被杀进程组残留）后，表现为"窗口能开但歌永远加载不出"。Tauri lib.rs 已用 `spawn` 直接拉起并记录 `SidecarState`；排查顺序：`Get-NetTCPConnection -LocalPort 8001,18089` 确认监听 → `/api/version` 返回 JSON 而非 HTML → curl 直测 `/api/qq/resolve` → 再排查前端 dur/缓存。构建时间戳（server.py mtime）写入 `/api/version` 可核对运行版本。
17. **流光隧道 · 镜头防抖（已踩坑）**：摄像机焦点目标必须**纯计算**（读词块预计算槽位 `__wordLayout.x/y` 百分比 × 视口尺寸 → 世界坐标），**禁止 `getBoundingClientRect` 读词块中心**——词块位于已被摄像机 transform 移动过的 stageLayer 内，rect 会随镜头移动变化，形成"镜头动→坐标变→目标变→镜头再动"的**反馈振荡**（表现为视角持续抖动）。且焦点只在词块切换时更新（`_focusBlockEl` 对比），同一词块逐字唱时镜头不抖；运镜旋转幅度 ≤7°（spiral/dive 只用慢速正弦），节拍脉冲 scale 微调 ≤0.015；聚光灯按 500ms 时间节流而非 `Math.random` 概率。
18. **流光隧道 · 分镜节奏**：`PVLyricLayout.process` 第三参 `maxSceneLines` 控制每景行数（默认 5 供 PV 海报，流光隧道传 2 → 每 2 句一景、12 句→6 分镜）；shot 切换 `_applyShotShift()` 给背景幕加 -18°~18° 色相微偏（`--hue-jitter`，0.9s 过渡）增强"换镜"感知。词级排版：句子经 `WordSegmenter.segmentFine()`（日文 ≤4 字聚合）+ `_refineBlocks()`（孤立单字块并入前块）细拆，每个词块绝对定位到 10 槽位池（竖/横各半），竖排用 `writing-mode: vertical-rl` + `text-orientation: upright`，绝不"一句一整行"。
19. **流光隧道 · waiting 完全隐藏 + 深浅反色**：`.tunnel-char.waiting` 必须 `opacity:0 + visibility:hidden + color:transparent`（未唱文本零预览，唱响由入场动画 `fill:backwards` 现形）；段落能量驱动 `--tunnel-veil`（0.12 深底 → 0.75 副歌亮幕，bg::after 渐变 1.2s），文本墨色 `--tunnel-ink`/`--tunnel-ink-dim` 随幕反色（veil>0.45 → 深墨字）；37 种装饰库中每句组只选 2-3 种（主角 opacity 0.55 / 陪衬 0.22），纹理层透明度减半防杂乱。
20. **流光隧道 · 进入需 AI 确认（token 提醒）**：切换 `view-tunnel` 走 `ensureTunnelAnalysis()`——先查 AI 缓存（命中不耗 token），未命中弹确认框（预计 Token = 行数×8+2000、15-30s、三模式：AI 完整 / 轻量词典 / 纯预设），选择记忆在 `localStorage('tunnel_analysis_mode')`；无 API Key 时禁用 AI 项，取消=纯预设不阻断。AI 触发走 `triggerAiAnalysisIfNeeded()`（内存 + IndexedDB 缓存）→ `themeEngine.applyAITheme()` → 从 `state.currentAiTheme` 取结果回传 `tunnelEngine.setLyrics()`。

---

## 13. 调试指南

- **服务端**：`server.py` 控制台 + `server_debug.log`（带毫秒时间戳）：`[Seamless]`（续流）、`[Migu]`、`[Agg]`、`[Kuwo]`、`[AudioStream]` 前缀分别对应各链路；排查"1~4 秒卡死"看 `[AudioStream]/[Seamless]` 的 Range、分支命中与结束原因。
- **前端**：DevTools Console（Tauri 需右键 WebView / 或者浏览器直开 `http://localhost:8001/index.html?forceMobile=1` 模拟手机布局）。
- **版本核对**：`/api/version` 返回 `build_time`（server.py mtime）；网页右下/横幅可见构建时间。分片已依赖 no-cache，改动后强刷（Ctrl+Shift+R / 重启 Tauri）即加载最新代码。
- **端口问题**：8001/18089 被占时 `server.py` 会自动 taskkill 自愈；`强制重启Aria.bat` 会前置清理所有 server.py / shazam-server.mjs 进程。
- **缓存清理**：删除 `cache/audio/` 下对应 `.tmp/.meta/.ok` 即强制整曲回源重建（或播放失败后走自动重试）。
- **播放失败先查端口**：`Get-NetTCPConnection -LocalPort 8001,18089 -State Listen` 两个端口必须都有监听。任一为空 → 后端没起，窗口能开但歌永远加载不出，与解析池/缓存无关。

---

## 14. 窗口透明与背景衔接（切歌透出桌面）

**现象**：切歌/换封面时，渐隐渐显的过渡瞬间窗口变透明，透出桌面/窗口之下的内容，闪烁一下又恢复。

**根因**：Tauri 主窗口 `transparent: true`，且 `html.aria-desktop, body.aria-desktop` 被强制为 `background: transparent !important`——页面背景完全由双层 `.blur-background`(z-index:-2) + `.color-overlay`(z-index:-1) 承担。切歌时 `setBlurBackground/setCoverImage` 的 `tryCrossfade` 让新层 opacity 0→1、旧层 1→0（均 0.8s 过渡）；**任一瞬间两层叠加合成不透明度 < 100%**（如各 0.5 → 区域合成 ≈75%），底层透明 html/body 直接露出窗口下方的桌面。

**修复**：在 [base.css](file:///d:/旧电脑/下载/歌词/歌词播放器/web/src/styles/base.css) 增加固定不透明保底层：

```css
body::before {
    content: '';
    position: fixed; top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: -3;            /* 垫在所有背景层之下 */
    background: #000;
    pointer-events: none;
}
```

窗口内部永不露桌面；圆角镂空观感由 `body{overflow:hidden;border-radius:12px}` 裁剪保留。**结构铁律**：无论背景层怎么动，`z-index:-3` 的 `body::before` 必须保持全不透明，它是窗口视觉的最底层安全垫。

## 15. `/api/qq/resolve` 的 dur 传参规范

- `dur=0`（或缺失）在 `qq_resolver.validate_url` 中为**假值** → **整体跳过防试听时长比对**。能拿到链接，但也可能放进来 30~60s 试听片段/低码率残片。
- 传**真实时长**（vkeys 搜索结果 `interval`("4分25秒") 经 `intervalToSec` 归一为秒）时校验生效：时长不符 → `invalid:trial` → 落入下一 provider。
- **主播放链（175-track-index-online.js）、下载（85-rate-download.js）、预加载（fetchPlayUrlForPreload）必须统一传真实时长**，否则"能跑通但拿到残片"与"取不到链"这类怪问题会在三处出现不一致。
- 逐年份/专辑版本与 mid 不匹配导致长度差异过大（容差 ±5s 或 5%）时全源失败返回 `all_providers_failed`，前端走强制重取 + 备用源兜底。
- **实测**（2026-08-26，mid `003l4k0L1xHyRI`）：
  - `dur=0`：7.6s 返回 ygking(master,flac)，duration 265.1。
  - `dur=265`：11.5s 返回 ygking(flac,flac)，duration 265.1 —— 与官方"4分25秒"一致，校验通过，无失败。

## 16. 播放失败排查（"为什么不会播放歌曲了"）

**症状**：应用窗口正常，搜索/歌词都能显示，但点播放永远加载不出（无 URL / 转圈 / instantly pause），停走停走或完全无声。

**排查顺序**（缺一不可）：

1. **服务端进程与端口** —— 最高频根因。`server.py`(8001) 与 `scripts/shazam-server.mjs`(18089) 任一退出（如 `强制重启Aria.bat` 在部分环境输入重定向失效、被杀进程组残留）后：
   ```
   Get-NetTCPConnection -LocalPort 8001,18089 -State Listen   # 两个都要有监听
   Invoke-WebRequest http://localhost:8001/api/version        # 必须返回 JSON 而非 HTML
   ```
   ② 失败 → 服务没起，先 `python server.py` 拉起来，不要先怀疑解析池/缓存。
2. **解析池连通性** —— `curl "http://localhost:8001/api/qq/resolve?mid=<mid>&dur=<真实秒>&quality=flac&skip_cache=1"`。超时（exit 28）→ 单源慢/被墙，但 wait 说明分层超时（竞速 8s、顺序 7s）+ 前端 18s 会在 2~3 个慢源后失效；返回 `all_providers_failed` → 看 `tried` 里各源 `err` 前缀（`trial()` 居多说明 dur 校验触发）。
3. **前端版本** —— 分片虽依赖 no-cache，但 WebView/浏览器命中启发式缓存时仍会跑旧代码。改动分片后先强刷（Ctrl+Shift+R 或重启 Tauri）；查询时核对 `/api/version` 的 `build_time` 与页面横幅构建时间。
4. **缓存一致性** —— 异源数据拼接（重建缓存未删旧 `.tmp/.meta`）导致音频错乱；播放失败重试已带 `skipCache` 强制回源。

**历史案例**（2026-08-26）：`/api/version` 与静态资源全部正常，但 8001/18089 无监听 → 歌永远加载不出。重启 `python server.py` 后解析池 7.6s~11.5s 返回直链，问题消失。结论：**先验端口，再怀疑解析池**。

---

## 17. 榜单页 / 统计 / 最近播放 / EQ 分享码 / 响度等新增功能（2026-08-29 批次）

### 17.1 音乐榜单（右上角「榜单」按钮 → `258-rankings.js` / `rankings.css` / `rankingsOverlay`）

| 源 | 数据路径 | 说明 |
|---|---|---|
| QQ | `GET /api/rank/qq` → 服务端 `https://api.ygking.top/api/top` | 返回 `data.group[].toplist[]`，每榜内嵌 `song[]`（ygking 每榜仅回前 3 首左右）；前端默认选中「歌曲最多的榜」展示 |
| 酷狗 | `GET /api/rank/kugou` → `mobilecdnbj.kugou.com/api/v3/rank/list?withsong=1` | list 接口每榜仅 3 首预览；选中某榜自动 `GET /api/rank/kugou?id=<rankid>`：服务端先取最新期号(`rank/vol` → `info[0].vols[0].volid`)再拉 `rank/song?pagesize=100` 全量，返回 `{code, data:[歌曲数组]}`（字段对齐 songname/authors/hash/album_sizable_cover，见 `normalizeRankSong`） |
| 网易云 | `GET /api/rank/ncm`（榜单目录 63 个）→ `60s.viki.moe/v2/ncm-rank/list`；`/api/rank/ncm?id=` → `v2/ncm-rank/song/{id}` | 目录可用；**歌曲端点在 viki 上不稳定（实测 25~45s 超时/空）**，前端 25s 超时 + 明确错误提示，不阻塞其它 Tab |

- 三源统一由服务端 `server.py::_handle_rank` 拉取（45s 超时、可控 UA/Referer，酷狗自动剥离 `HTML裹JSON`；服务端内建 1 次失败重试），前端仅调同源 `/api/rank/*`，规避 CORS 与超时不可控。
- 榜单歌曲点击 → `normalizeRankSong()` 生成 `{source,id/hash,song,singer,cover}` → 复用 `loadOnlineSong`（QQ/网易走解析+取词，酷狗走 hash→getKugouPlayInfo），并自动记入最近播放。
- 弹窗样式与搜索完全一致（`.search-overlay > .search-modal`，宽 640 圆角毛玻璃 + `.search-modal-header` 内 `.source-toggle` 三个音源按钮）；交互为两级：**① 榜列表 = 封面宫格**（`.rank-board-grid > .rank-board-card`，方形封面 + 底部榜名）→ **② 点榜进入该榜**（返回条 `#rankNav` + 歌曲为**普通歌单样式** `.result-item` 行式列表，左侧序号）。

### 17.2 最近播放历史
- `localStorage('aria_recent_history')`（上限 60 条去重置顶）；`loadOnlineSong` 播放成功回调调 `window.recordRecentPlay`（175 分片经 window 调用，避免循环依赖）。
- 入口：歌单列表顶部「最近播放」卡片（`130-playlists.js` renderPlaylistsView，`data-pid="__recent__"` → `window.openRecent()`，`145-playlist-import.js` 点击分支）→ `#recentOverlay` 列表（可单条目删除/点击重播）。

### 17.3 播放统计（右上角「统计」按钮 → `#statsOverlay`）
- `localStorage('aria_play_stats')`：`{totalPlays,totalMs,songs{},artists{},days{}}`；主界面 5s 定时器 `window.recordPlayStats(dt)` 累计时长，累计 ≥30s 记 1 次播放。
- 展示：4 个 KPI（累计播放/收听时长/听过歌曲数/歌手数）+ 常听歌曲 Top8 + 常听歌手 Top8 + 近 7 日收听时长条形图。

### 17.4 EQ 分享码（均衡器面板「分享码 / 导入」按钮）
- 编码：`'AriaEQ1.' + base64(encodeURIComponent(JSON.stringify({v:1,g:eqGains,p:preset})))`；`navigator.clipboard` 失败回退手动拷贝提示；导入时 `prompt()` 粘贴 → 解码 → `applyEqGains`。

### 17.5 响度归一化
- `90-eq.js initEqAudioGraph()` 在 EQ 串后、输出前插 `DynamicsCompressor`（threshold -22 / ratio 3.2 / knee 8 / 温和压缩），不同音源响度更一致（无 UI 开关，固定启用）。

### 17.6 歌单批量操作
- `130-playlists.js renderPlaylistDetail`：详情页「播放全部」旁新增「多选」按钮 → 编辑模式显示每行勾选框（`globalThis.plMultiEdit/plMultiSel` Set）→ 按钮变「删除选中(N)」（倒序 splice + savePlaylists），编辑模式下禁拖拽排序。CSS 见 `rankings.css`（`.pl-multi-cb` / `.pl-edit-on`）。

### 17.7 桌面歌词增强（主题色跟随）
- `250-desktop-lyrics.js` 推送 payload 增加 `themeColor`（主界面 `--theme-color` 计算值）；`lyrics.html` 经 `applyTheme()` 把主题色应用到逐字高亮 `--dtk-hl` 与光晕 `--dtk-hl-glow`（默认回退青蓝 #7cd7ff）。

### 17.8 其它相关
- 搜索端（`150-search-engine.js`）移除「静默切酷我」：QQ/网易/酷狗 搜索无结果时明确提示（`QQ音乐服务暂时不可用(503)…可尝试切换音源`），不再混入其它源的结果。
- 播放退回链统一为 **当前歌曲源 → QQ → 酷狗 → 网易云 → 酷我（去重）**，见 `135-crossfade.js handlePlayFailure` 与 `175-track-index-online.js` 跨源兜底（移除咪咕/聚合）。

### 17.9 新增文件
- `web/src/app/258-rankings.js`（榜单/历史/统计/EQ分享码，已在 `index.js` 注册）
- `web/src/styles/rankings.css`（榜单/统计/批量操作样式，`index.html` 引入）
- `server.py` 新增 `_handle_rank`（`/api/rank/{qq,kugou,ncm}`）

---

## 18. 交互细节增强批次（2026-08-29 第二轮）

### 18.1 毛玻璃输入/选择弹窗（`window.showGlassPrompt` / `window.showGlassPick`，258-rankings.js）
- 统一毛玻璃规范（`.gp-modal`：`rgba(24,26,34,.82)` + `blur(40px)` + 圆角 16 + `modalIn` 动画），替代浏览器原生 `prompt`。
- 接入场景：
  - **新建歌单 / 保存当前队列为新歌单**（`140-playlist-ui-events.js` 的新建与保存队列按钮 → showGlassPrompt 命名，替代原「歌单上方新建输入框」）
  - **EQ 分享码导入**（`258 importEqShareCode` → showGlassPrompt）
  - **EQ 保存为自定义预设**（`90-eq.js` 的「保存」按钮 → showGlassPrompt → `window.saveEqPreset(name)` 写 `localStorage('aria_eq_custom')`；`buildEqPresets` 合并渲染内置+自定义；`applyEqPreset` 兼容自定义）
  - **歌单合并**（`window.mergePlaylistInto` → showGlassPick 列出其它歌单 → 去重合并歌曲）

### 18.2 榜单两级交互（最终形态）
- 榜列表 = 封面宫格（`.rank-board-grid`），点榜 → 返回条（`#rankNav`）+ 普通歌单样式歌曲列表（`.result-item` 行式 + 序号）。酷狗全量 100 首、QQ 每榜前几首、网易榜单目录/歌曲依赖接口连通性。

### 18.3 最近播放记录前置
- `175-track-index-online.js` 在 `currentSongData` 赋值（设 audio.src 前）即 `window.recordRecentPlay`，`135-crossfade.js` 本地直链也能记录 —— 不再依赖 `play()` 成功（自动播放策略挂起也不漏记）。

### 18.4 AI 情感词即时显示
- `200-settings-panel.js`：第一路情绪结果清洗完成后立即 `globalThis.aiEmotionWords=...` + `applyEmotionWordColors()` 着色歌词。蒙德里安排版已改程序化本地生成（proceduralLayout，同步零等待），原「第二路 LLM 排版请求」已移除。

### 18.5 歌单批量下载 / 合并
- 歌单详情操作行新增「批量下载」「合并到...」：
  - `window.batchDownloadSongs`（258）：逐首 `fetchPlayUrlForPreload` 取直链 → fetch Blob（失败走 `/proxy`）→ 触发浏览器下载，串行 400ms 间隔 + 成功/失败统计。
  - `window.mergePlaylistInto`：showGlassPick 选目标歌单 → 去重（`key=source:id`）合并 → `savePlaylists`。

### 18.6 桌面歌词增强：情感词颜色
- 工具条新增彩色切换按钮（`#tEmc`，状态存 `localStorage('aria_dtk_emcolor')`）。
- `250-desktop-lyrics.js` 推送 payload 增加 `emColors`（由 `aiEmotionWords` 构建 {word:color}，≤120 条）与既有 `themeColor`；
- `lyrics.html`：`renderState` 缓存 `emColors`；`wordHTMLs` 命中情感词时着色 `.stroke` 底色（高亮 fill 不变）；启动/切歌即应用；`#tEmc.on` 高亮态。

### 18.7 本轮其它
- 播放统计与最近播放窗口统一为 640 宽 `search-modal`（与搜索一致）。
- 榜单/统计/最近播放的 JS 错误清零（`258-rankings.js?v=3` 模块版本推进）。

---

## 19. 「浏览器手动访问能成、应用内容易失败」诊断（2026-08-30）

### 19.1 结论（三层根因）
1. **付费墙曲目（Bad Apple 等热门 VIP）**：实测该曲在**所有免费下载接口全部被挡**——vkeys `code=110000`、ygking 空、nki、tang `no song_play_url`、xcvts `-7`、moeyao 空、official GetVkey `no purl`、酷狗 `getdata status=0`、酷我 VIP。属接口层限制，任何客户端都无法经免费接口取完整直链；应用已自动「酷狗→网易→酷我」跨源兜底，但兜底源同为免费生态同样受限。**浏览器手动"能成"的 URL 多为其它非 VIP 歌曲、或 QQ 官方网页的登录态资源（应用无法用 API 等价复现）**。
2. **限流导致普通歌也时好时坏（已修复）**：解析池竞速阶段会**并发**打 vkeys 的多个 quality（q14/q10/q9/q11）+ 多源并发请求，免费 API 秒级配额被瞬间打满 → 空数据/503 → 失败后又把源计入 health 冷却（连续失败≥3 冷却 120s）→ 表现为"应用内容易失效、且一段失效后更难恢复"。
3. **stale mid**：收藏/最近播放中的历史 mid（如 `003e7GKq43tG7b`）可能已不在 vkeys 当前识别集合（实测重新搜索得到 `000IgbHA3wMDAR`）——搜索来源不同导致同名不同 mid，历史条目复用旧 mid 时解析失败。

### 19.2 本次修复（qq_resolver.py / 175-track-index-online.js）
- `qq_resolver.py`：新增 `_LOCK_VKEYS/_LOCK_YGKING` 同源 RLock 串行（同一时刻每源仅一个请求）；`_p_vkeys/_p_ygking` 失败重试 1 次（间隔 0.35s）抵抗瞬时限流。
- `175-track-index-online.js`：ygking `code=0 且 data 空` 时不再立即跳过全部音质，改为 0.5s 后重试一次（`retriedYgk`）再放弃。
- 验证：Bad Apple 修复后仍 all_providers_failed（确认是付费墙个案，非应用缺陷）；限流类随机失败已通过串行+重试缓解。

### 19.3 排查手法（下次可复用）
- `python -c "import qq_resolver as q; r=q.resolve('<mid>', dur=<s>, quality='flac', skip_cache=True); [print(t['provider'], t.get('ok') or t.get('err'), str(t.get('ms'))+'ms') for t in r.get('tried',[])]"` 逐源看失败原因。
- 浏览器手动对比时注意：手动访问 URL 需与应用同 mid 同参数，否则无对照意义；解码 `vkeys code=110000` = 该 mid 免费接口不可取（VIP/下架）。

---

## 20. 自建音乐服务（酷狗 / QQ / 网易云）（2026-09-05）

### 20.1 定位与原则
- 以 Node 副进程跑各自音乐 API server（后端镜像），由 `server.py`（`/api/selfhost/*`）统一托管与代理。
- **登录态优先、未登录回退**：扫码登录后（token/cookie 存副进程进程内存 + 前端 localStorage），QQ 播放/三家日推优先走高音质自建接口；**任何否定分支（未启用/未登录/离线/失败）一律回退现有免费源池，不动旧逻辑**。
- 默认关闭（`localStorage('selfhost_prefs').enabled.*` 默认 false），开启后才参与取链，安全默认。

### 20.2 平台与端口
| 平台 | vendor 目录 | 端口 | 启动 | 未登录时播放 |
|---|---|---|---|---|
| 酷狗 | `_eval/KuGouMusicApi`（MakcRe 概念版 lite） | 3100 | `node app.js` | 无（需 token） |
| QQ | `_eval/qq-music-api-node`（sansenjian） | 3200 | `npx tsx src/app.ts` | 无（`getMusicPlay` 强制登录态） |
| 网易云 | `_eval/NeteaseCloudMusicApi`（`nooblong/NeteaseCloudMusicApiBackup` fork，官方仓库已被举报下架） | 3201 | `node app.js` | 无（日推 `/recommend/songs` 通常需登录） |

> 网易云官方主仓库 2023 前后被举报下架；本项目用活跃 fork `nooblong/NeteaseCloudMusicApiBackup`（其 GitHub 原始 URL 全小写会 404，正确为 `NeteaseCloudMusicApiBackup`）。

### 20.3 后端 `server.py` / `selfhost_service.py`
- 新模块 `selfhost_service.py`（纯标准库）：`ensure_running(name)` 惰性拉起副进程（校验 Node、等端口、幂等）；`status_all()`；登录 `get_login_qr(name)` / `poll_login(name,key)`；通用代理 `proxy_request(name,method,path,body)`（qq 自动注入 `cookie=`；kugou 自动注入 `token&userid`；netease 自动注入 `Cookie` 头，并支持回读 Set-Cookie 供扫码用）。
- 路由（`server.py::_handle_selfhost`）：`GET /api/selfhost/status`（顶层，聚合+lazy拉起）；`/api/selfhost/<plat>/qr`、`check`(POST body {key})、`logout`(POST)、`proxy?path=<urlencoded 上游路径+query>`。副进程异常/未 vendor 均安全降级为 JSON 报错，不阻塞主服务。

### 20.4 登录与日推端点
- **酷狗**：`/login/qr/key` 取码（`data.qrcode`=key、`data.qrcode_img`=img）；`/login/qr/check?key=` 轮询，成功判据 `data.status==4` 且带 `token/userid`。
- **QQ**：`/getQQLoginQr`→`{img,ptqrtoken,qrsig}`；`/checkQQLoginQr?ptqrtoken=&qrsig=` 轮询，成功 `data.isOk` + `data.session`（完整 cookie 键值字典，拼回 `cookie` 串）。播放端点 `GET /getMusicPlay?songmid=&quality=&cookie=`，`cookieRequired:true`。
- **网易云**：`/login/qr/create?key=<uuid>` 返回 `data.qrurl`（备份版不含图，`selfhost_service._netease_qr_img()` 用 python `qrcode` 把 qrurl 编码成 PNG dataURI），同时 Set-Cookie 一份会话临时 cookie 存 `_STATE[name].tmp`；`/login/qr/check?key=<uuid>` 带临时 cookie 轮询，成功判据 `code==803` 并取响应的 **Set-Cookie** 作为正式登录态（多段拼成 `k=v; k=v`）。登录态靠 Set-Cookie 传递，未登录时 `status_all.loggedIn=false`。播放/日推/proxy 自动以 Cookie 请求头注入。网易云登录图渲染依赖 python 第三方库 `qrcode`(+Pillow)，已装于用户 site-packages；缺失时退回 `data.image/png`→qrurl 文本。
- 日推端点：网易 `/recommend/songs`、酷狗 `/everyday/recommend`、QQ `/getDailyRecommend`（QQ 另有 `/getPersonalRecommend` 猜你喜欢）。全需对应平台已登录。
- 登录态寿命：QQ 逆向登录态无标准 refresh_token，通常几小时~数周被风控/服务端吊销；**掉线不可静默续期，需重新扫码**。实现上靠 `/api/selfhost/status` 标记 loggedIn=false + 播放回退免费池兜底，避免一次掉线卡死 QQ 播放。

### 20.5 前端接入
- `web/src/app/selfhost-settings.js`：设置页「自建服务」Tab（`index.html` 新增 `data-tab="selfhost"` 按钮 + `.settings-section` 空容器 + `#selfhostQrOverlay` 扫码弹窗）。三平台卡片（存活灯/启用开关/登录按钮/登出）+「每日推荐来源」下拉。扫码弹窗：`/qr` 取码 → 每 2s `/check` 轮询 → 成功写状态并刷新。
- `web/src/app/selfhost-runtime.js`：`selfhostQQPlayUrl(mid,quality)`（**步骤0** 插到 `175-track-index-online.js` QQ 解析最前，`enabled+loggedIn` 才走，失败落回原链，且需 `checkAudioUrlPlayable` 复验）；`dayRecommend()` 归一化三家日推为 {song,singer,id,source}。
- `web/src/app/258-rankings.js`：新增 `openDailyRecommend()`（复用榜单弹窗 `renderSongs` 渲染成普通歌单列表），右上角 `#openDailyBtn` 触发。

### 20.6 改动文件清单
- 新增：`selfhost_service.py`、`web/src/app/selfhost-settings.js`、`web/src/app/selfhost-runtime.js`
- 修改：`server.py`（import + `do_GET/do_POST` 分支 + `_handle_selfhost`）、`web/index.html`（Tab 按钮 + 区块 + QR 弹窗 + `#openDailyBtn`）、`web/src/app/200-settings-panel.js`（import + selfhost 分支）、`web/src/app/175-track-index-online.js`（步骤0 QQ 自建优先）、`web/src/app/258-rankings.js`（日推）

### 20.7 已知边界
- 酷狗/QQ/网易云三家扫码登录均需真实账号方可端到端完整验证（取码/轮询逻辑已通，扫码授权与高音质/日推需你实测一次）。网易云登录图渲染依赖 python `qrcode`(+Pillow)，若换机器需 `pip install --user qrcode[pil]`。
- 自建服务依赖本机 `node`（≥18）；副进程在 server.py 退出后被孤儿但端口保持占用，重启 server 时 `ensure_running` 会探测复用，不会重复拉起。
- `_eval/` 目录仅为验证期目录，正式版可将 `_SERVICES[].dir` 指向 `vendor/<repo>` 稳定路径。
### 21. 2026-09 更新（榜单/自建服务/歌单统一/桌面歌词）

- **QQ 用户资料链路 TLS 风控**：c6.y.qq.com 按 TLS 指纹拒绝 node axios(code:1000)；_eval/qq-music-api-node/src/services/apis/user/getUserPlaylists.ts、getUserLikedSongs.ts 改用 undici etchWithTimeout；controllers/getUserLikedSongs.ts 必须 esolveRequestCookie 传 cookie。
- **QQ 歌单/曲目**：vendor 响应包 {response:...} 需解包（getUserPlaylists→response.data.playlists；getSongListDetail→response.cdlist[0].songlist 无 data 层）。«我喜欢的歌»= getUserLikedSongs 的 info.id → getSongListDetail 拉全量（606首），前端 
ormQQTracks 归一化，selfhostPlaylists('qq') 把喜欢卡片 unshift 进列表。
- **QQ 日推**：个性化日推模块(web_srf_svr 等)对微信联邦账号 500003 不可用 → dayRecommend('qq') 回退「热门歌单聚合」(getSongLists categoryId=10000000&sortId=5 → 逐单 getSongListDetail 跳过下架空单 → 去重 cap 60)。
- **QQ 榜单**：getRanks 只为前 3 首带 cover → server.py _rank_fallback_qq 用 albumMid 拼封面；榜首卡片显示 listen 人气（替代误导性 3 首预览计数）。
- **酷狗收藏/歌单**：playlist/track/all 参数键是 id（非 global_collection_id），响应在 data.songs；歌名/作者从 
ame="作者 - 歌名" + singerinfo 解析；card count 用 count/m_count；«我喜欢的歌»=默认收藏(is_def=1)。
- **网易云 uid**：登录/恢复后 uid 空时 status_all 经 _probe_netease_login 用 /login/status 探测（60s 缓存），失效则 loggedIn=false 引导重登；_fetch_netease_uid 重试 3 次。
- **歌单页整合自建歌单**：130-playlists.js enderPlaylistsView 顶部顺序「当前播放→历史播放→本地音乐→网易云→酷狗→QQ→用户歌单」，平台项仅登录平台显示；enderSelfPlatList/renderSelfPlatSongs 复用 rank-board-grid/result-item/play-all 组件；返回钩子 window.__playlistBackHook（140 返回键优先调用）。
- **榜单滚动联动**：榜宫格与榜内歌曲共用 #rankList → 视图切换时 esetRankScroll() 重置 scrollTop；setRankNav 同时控制 hidden/display；openRankings 不再手动显示 rankNav。
- **自建收藏**：259-selfhost-favorites.js 增加 localStorage 缓存(5min，秒开+后台刷新)、播放全部/加入播放队列/收藏按钮；打开时重建平台 tab 修错乱。
- **播放统计**：ecordPlayStats 每次上报即落盘（此前 <30s 不保存导致近7日/累计 0s）。
- **桌面歌词**：lyrics.html #tEmc.on 背景跟随主题色 --dtk-hl(color-mix)；情感词颜色只出现在扫过的 fill 层（stroke 不再提前上色，随进度渐进出现）。
- **点击歌词跳转**：100-cover-background.js 点击行改为单次 0.35s 平滑滚动 + 交由 timeupdate 驱动高亮，避免双动画反向跳变。
- **UI 收敛**：删除右上角自建服务按钮(openSelfHostBtn)与上传按钮(loadMusicBtn)（上传改走歌单页本地音乐入口）；歌单批量按钮 align-items:center 压缩高度；自定义主题色 checkbox；多选编辑「全选/全不选」；退出歌单自动退出编辑；编辑模式点歌曲卡片仅勾选不切歌。
- **打包分发**：见 docs/打包分发方案.md（PyInstaller + 便携 node + Tauri externalBin 路线 A/B）。
### 22. 2026-09-07 会话：网易云登录态根因三连修复 / 歌单缓存渲染 / 绿色版打包落地

- **网易云扫码「提示登录成功但返回仍显示未登录」根因（三连）**：
  1. `/login/status` 的 vendor 响应包 `data` 层 `{data:{code,profile}}`，原解析只取顶层 → 增加 `_extract_netease_profile()` 兼容两层；
  2. **cookie 含 Set-Cookie 属性段**（`Max-Age=..; Expires=..; Path=..` 原样拼进登录态串），网易云官方接口收到即判定未登录 → 新增 `_sanitize_cookie_str()` 清洗（只留真实 `k=v`），入库点全接：`_poll_netease`/`login_netease_account`/`set_cookie`/`_persist_login`/`_restore_login`（旧数据自动迁移）；
  3. **`_sanitize_cookie_str` 定义在 `_restore_login()` 调用之后** → NameError 被 except 静默吞掉、整个登录态不恢复 → 函数已上移模块顶部（该坑的教训：模块初始化期调用的函数必须定义在其之前）。
- **网易云带登录态的业务请求一律附加唯一 `_t`**：vendor apicache(2min) 按 URL 缓存且不含 Cookie 头，登录前缓存下的 /login/status/歌单响应会被复用 → `_proxy_raw` netease 分支自动 `path_and_query += _t=now_ms()`。
- **自建服务设置页重复控件**：`initSelfhostSection` 并发调用时两个 `getStatus()` 回调都会 append 一组控件 → 加模块级 `_selfhostRenderId` 令牌，过期回调直接 return。
- **播放统计 0s**：`recordPlayStats` 把秒当 ms 存（fmtMs 按 ms 展示 → 恒 0）+ 定时器要求 audio 已就绪才启动（加载顺序导致永不启动）→ 统一毫秒存储 + 无条件启动 tick（audio 就绪后自动接管，dt 钳制 0<dt<30）。
- **标题栏颜色不跟随背景**：`updateBrandColor()` 只在 Tauri 的 `initDesktop()` 内运行，浏览器模式从不启用 → 上移到 240-titlebar.js 顶层 IIFE（两模式都 700ms 同步 --titlebar-fg）。
- **本地音乐播放/封面全部失效**：server.py 静态根固定 `web/`，`/local_music/` 从没被映射（404）→ do_GET 新增 `/local_music/` 两层路径显式映射（带路径穿越防护），音频 206/封面 200。
- **歌单视图打开慢/返回要加载**：`renderPlaylistsView` 渲染前强制 await 两个网络请求 → 改为同步渲染（用缓存/乐观状态）+ `_refreshPlaylistDynamic()` 后台刷新（本地计数、三平台登录态 `selfPlatMetaCache`，seq 防竞态）；`renderSelfPlatSongs` 抽 `_renderSelfPlatSongsList()` 支持缓存即时渲染；`LocalMusicManager.getLocalSongs()` 加 8s 缓存（上传/删除后 invalidate）；本地列表无封面歌曲异步走 `/api/cover` 补封面（`_asyncFillLocalCovers`，会话去重）。
- **绿色版打包（落地）**：明细见 docs/打包分发方案.md「已落地」两节；坑包括 PyInstaller frozen 路径（`_PROJECT_DIR=os.path.dirname(sys.executable)`）、`_find_node()` 三级解析（ARIA_NODE → runtime/node.exe → PATH）、QQ vendor 去 npx（`node node_modules/tsx/dist/cli.mjs src/app.ts`）、zip 中文目录名乱码（改用 ASCII `AriaPortable`）、vendor `.git`/嵌套目录进包（复制时必须 `-Recurse` 且校验 tsx/express 存在）、server.exe 静态根多候选回退 + 启动自检、bat 完整性预检（全 ASCII）。

---

## 21. 歌词视觉大版本批次（2026-09-16 ~ 09-19）

### 21.1 新增视觉模式：霓虹 Neon Sign（`web/src/core/visualizers/NeonVisualizer.js` + `styles/neon.css`）

- **隐喻**：深夜街角灯牌——未唱的字是熄灭灯管（单线轮廓），唱到逐字「通电」（电流闪烁 → 灯色内芯 + 辉光），段落情绪定灯色（`NEON_BY_KIND`）与功率（`--neon-halo` 四档）。
- **单线灯管渲染（关键技巧）**：`-webkit-text-stroke` 是沿字形轮廓的双侧描边（每笔画内外各一线，像空心美术字）——**`paint-order: stroke fill`** 让粗 stroke 垫底、fill（舞台底色）盖掉其内半 → 只剩沿字形外扩的环形单线；fill 用底色让字形本体隐入夜色。不支持 paint-order 的旧内核无害回退双轮廓。
- **店招巨物 SVG `<text>` 化**：SVG 才有 `stroke-linejoin/linecap: round`（真圆角灯管折弯，CSS text-stroke 无 linejoin）；viewBox(100×26) 等比缩放 = 巨物字号自适应免费获得；`fitGiant` 用 `getBBox()` 度量（viewBox 用户单位）宽度自适应 + 与版心矩形相交检测（×0.85 缩 12 级，仍相交整块隐藏——正文可读性优先）；lit 发光用 CSS `drop-shadow` 链（SVG filter 的 feDropShadow 颜色吃不到 CSS 变量）。
- **底层架构与活字同源**（独立副本防耦合）：buildUnits 词元切分 / 字符状态机（每帧只切 class）/ A/B 双牌交叉淡入 / whenSettled 字体就绪门 / fitBody + checkOverflow 自愈 + maybePreRenderNext 隐藏测量层。
- **词间空格修复**（Neon/Letterpress 的 buildUnits 同步）：网易 YRC 三参排布、预览合成词元的词元文本不携带空格 → 以 `line.original` 为基准游标对齐，词元间被吞掉的空白补成空格单元；词元自带前后空白 trim（防双空格）。

### 21.2 新增视觉模式：活字 Letterpress（`LetterpressVisualizer.js` + `styles/letterpress.css`）

- **隐喻**：深夜印刷台——纸页压印，未唱字无墨、唱到逐字压印显墨；30 款版式池按段序轮换；纸色（bright/neutral/dark 三系九变体）随段落 kind 变化。
- **英文歌纸色修复**：`classifyScene` 的 lift 判据原按「去空格字符数/秒>2.5」，英文行字符数是中文 3~5 倍 → 几乎全误判 lift（白亮纸）。改为**语言归一化密度**：CJK 每字 1 单元 + 拉丁连续串（词）1 单元（`lyricSceneGrouper.js`）。
- **英文歌 hero 兜底**：heroOfLine 原只挑最长 CJK 片段 → 英文歌整首无店招巨物；纯拉丁行取最长词前 6 字符（Letterpress/Neon 同步）。

### 21.3 PV 构图池规律化（`shotProfiles.js` + `PVLyricLayout.js`）

- **病灶**：方向按 `ARCHETYPES[sIdx%4]` 轮换、构图按 mood 池序号轮换——两套独立周期，用户感知「没规律」。
- **新制（参考实现 sonnet/tempera 对齐）**：方向是构图自身属性（orientation 由 region 宽高比 ≤1.15 自动派生，vertical 7 / horizontal 55）；选取走 `pickShotProfileV2`：语义分池（kind→moods）→ 竖排长度闸门（全行 ≤45/24 字符才允许竖排页）→ FNV-1a 哈希定起点 → `chooseShotWithoutRepeat` 跳过上一页。同一首歌重播版式序列完全一致。
- **hero 竖柱特权**（上游参考项目 editorial 变体 4）：仅横排页 + 内容哈希 1/3 页（`hashShotSeed('pillar:'+seedText)%3===0`）→ hero 词块竖排大字（`_assignBlockStyles` 第 8 参 `heroPillar`），support 保持横排；CSS `.pv-scale-hero.pv-vertical-block` 字号降档 0.62x 防爆高；拉丁 hero 自动走 pv-latin-sideways 整词侧躺。
- **行间错落**（参考实现 sonnet：确定性交替微偏移非随机）：`pv-poster-line` 挂 `--pv-line-shift`（±10/18/26px 按行序交替），CSS `position:relative + left` 不影响 wrap 布局流。
- **构图一致性与 region 消费**：PVRendering 105-123 行把 shot.region（cx/cy/w/h/align/rotation/fontScale）+ enter + handoff 全部落到 CSS 变量与 rotate 属性。

### 21.4 蒙德里安模板化 v2（`TunnelEngine.js` + `tunnelEngine/mondrianTemplates.js`）

- **v2 满屏色板（用户两轮「不如 上游参考项目 / 还是丑」后的对照重做）**：参考实现 tempera 的画面
  是 2~5 块大面积 **近实心 tone 平板铺满整屏**（alpha 0.94~0.96）+ ink 接缝线 + 4 档明度
  阶梯（`TEMPERA_TONE_STOPS`）——旧版「深色底上飘半透明小块」的架构本身就是杂乱来源。
- **手工预设布局表**（`mondrianTemplates.js`，替代程序化随机切割）：12 幅 × 七族——
  duo（52/48 对分+接缝）/ quad（四象限+双缝+对角同色）/ pillarGap（双暗柱夹中央亮槽，
  歌词安全区）/ stair（底板+对角四阶梯渐深）/ checker（棋盘对角同色）/ corner（角部
  体量）/ band（三带）。每幅都是设计过的固定几何；色板 3 步长轮换保证相邻不同色系。
- **tone 阶梯派生**：`tonesOf()` 把莫兰迪色板压暗为 4 档（shade 0.86/0.72/0.55/0.38），
  tone1 亮档只出现在边缘（白字歌词排版居中，可读性约束）；接缝 ink = shade 0.22。
- **块 alpha 近实心**：`_normMosaicBlock` 收敛改 [0.86, 0.96]，渲染保底线 0.86。
- **切换粒度**：cacheKey 按 groupId（句组，2~4 句一幅）——原按 sectionId 一段 40s 才换。
- 旧版 generateMondrian 随机切割 / families / FAMILY_PLAN 约 220 行已删除
  （v1 的 scatter 散砖、半透明收敛均为过渡方案）。回归 `.workbuddy/test_mondrian_tpl.mjs`
  10 项全过；v1 的「切换不连贯」与「按段落太懒」两个反馈分别由块池 transition 与
  groupId 粒度解决。
- **重入孤儿节点修复（蒙德里安概率性无背景的根因，2026-09）**：`220-shortcuts-viewmode.js`
  切回隧道模式时对**复用实例**无守卫再 `init()`（L864），init 里 `viewContainer.innerHTML=''`
  丢弃整个图层树，但 `_mosaicBlockPool/_mosaicBgEl` 等仍指向旧图层孤儿节点——背景样式
  全刷在不可见 DOM 上（首进正常、退出重进必现）。修：init 重建图层处同步置 null 全部
  绑定 DOM 的蒙德里安运行时状态（池/背景元素/装饰层/`_lastMosaicFamily/_lastBgCacheKey/
  _currentMosaicPattern/_currentMosaicEdges/_lastPatternBlocks`），消费点均有哈希兜底。
  回归：`tests/js/test_mosaic_reinit.js`（源码级断言锁定不变量，node 无 DOM 环境跑不动引擎本体）。

### 21.5 RTL 歌词方向适配（阿拉伯/希伯来等）

- `VisualizerBase.setLyrics` 检测 RTL 语系（正则与 PVRendering 的 pv-is-rtl 一致）→ stage 挂 `vis-rtl` 类；逐字点亮元素按字符串序创建，bidi 重排后视觉自然从右往左点亮——**各视图高亮推进逻辑零改动**。
- `visualizers.css`：vis-rtl 下 neon/lp/dim/polyphony 版心 `direction: rtl + unicode-bidi: plaintext`；`.vis-rtl .neon-giant-text`（SVG bidi 需显式指到 text 元素）；TunnelEngine 自挂 `tunnel-is-rtl`（不在基类继承链）。
- **PV 横排词块修复**：pv.css 原 `.pv-horizontal-block { direction: ltr }` 硬编码锁死了词块内字符方向（「PV 竖排对横排错」的根因）——pv-is-rtl 下覆盖 rtl。
- 遗留：桌面歌词 lyrics.html（独立页）未适配。

### 21.6 视觉字体竞态修复（启动后字体与退出时不一致）

- **因 A**：boot 时 applyFontFamily 先于 IndexedDB 自定义字体注册 → resolveFontFamily 空表把 custom 键解析成 `'custom_xxx', sans-serif` 死值；视觉容器的 inline `--vis-font-family`（优先级高于根节点）也落错值，而 `__reapplyFontSettings`（=applyAllSettings）只刷根节点不刷容器 → 错值无人纠正。
  修：重放钩子补 `mainVisManager.applySettings(mgr.settings)` + previewEngine `setModeVar`；resolveFontFamily 对 `custom*` 前缀键未命中时回退默认链（210-color-multilang.js）。
- **因 B**：210 注入的 `.player-container *` (0-1-1) 直接命中视觉字符、压过 stage 规则 (0-1-0)，且其 `var(--app-font-family)` 无 fallback → 变量缺失时继承链断到浏览器默认衬线（「启动变宋体」）。修：neon/letterpress 的 stage font-family 加 `!important`。
- **因 C**：190 applyModeSettings 的 fallback 字典缺 neon/letterpress（错用 cover 档），已补齐。

### 21.7 其他

- 设置 → 关于重写：九种视觉/构图池/模板化等功能阐述；作者链接呼出系统浏览器（`initAboutLinks` → Tauri `opener.openUrl`，网页版回退 window.open；Tauri 壳内 `<a target="_blank">` 默认不外开）。
- 预览引擎两处顺手修：previewEngine.setMode 类残留名单补 view-letterpress（活字预览暗底残留）；200-settings-panel 外观 modes 数组补 letterpress/neon（滑杆不实时生效）。

### 21.8 全方位体验升级与Bug修复专场（2026-09-22）

1. **搜索框清空按钮与回退恢复**：
   - 清空按钮内置于 `search-input-wrap` 内部右端，input 获得焦点且有内容、或打字输入时即时显示，点击时不失焦（mousedown 阻止默认行为）；
   - 修复搜索后改动关键词再退格删回原词时既无历史也无搜索结果的 bug（`updateSearchView` 检测到当前源已缓存该关键词但结果区为空时，调用 `restoreCachedSearchResults()` 自动还原已加载的搜索结果）。
2. **歌单列表操作按钮重构为 Icon 按钮**：
   - 自建歌单详情（`renderPlaylistDetail`）、当前播放（`renderNowPlayingDetail`）、自建平台歌单（`_renderSelfPlatSongsList`）及榜单详情（`258-rankings.js`）中的「随机排序」、「批量下载」、「合并到...」等文字按钮全部升级为 34×34px 现代矢量 Icon 按钮，文字统一收纳至 tooltip；
   - 严格保留多选按钮与多选激活后的「全选 / 全不选」和「删除选中 / 完成」文字按钮。
3. **vendor 歌单 AI 分析与新建歌单弹窗统一**：
   - `syncPlaylistHeaderCtxBtns` 与 `batchAnalyzePlaylist` 支持 `selfplat-songs` 视图，来自第三方自建平台的歌单直接开启右上角一键 AI 分析；
   - 新建歌单弹窗替换旧的简陋提示框，与「从链接导入歌单」保持 100% 一致的毛玻璃 `search-modal` 独立模态结构。
4. **OOBE 引导页面重构与美化**：
   - 样式与微动效全面升级：高级毛玻璃遮罩、卡片入场弹出、步骤淡入上浮，步骤指示点进化为 iOS 风格的平滑拉伸胶囊；
   - 流程优化为 4 步核心偏好（视觉模式偏好、性能与 AI 情感词、个性主题色、三平台自建服务与扫码登录），完成时自动应用偏好。
5. **PV 模式焦距与设置滑杆**：
   - `PVEngine` 摄像机运镜引入 `cameraZoom` 焦距倍率，设置面板新增「默认焦距 (镜头特写)」滑杆（0.8x~3.0x，步进 0.1x）；调大后摄像机拉近，单屏仅聚焦两三个词的大字特写，拥有强烈的 folia 长镜头冲击力。
6. **飞入模式海报大字基准重构**：
   - 修复原 `flyinAutoScaleFont` 从未定义 `--font-size` 的 documentElement 读取导致永远回退 24px 的 bug；
   - 重构为基于视口宽度的单行海报大字基准（~5.8vw），真实读取 `userScale`，在 2.00x 下可达 120-150px 巨幕字号，并在长句超出可用高度时平滑自适应收缩。
7. **字体设置与双重 tooltip 清理**：
   - 右上角 AI 分析弹窗继承全局字体设置 `var(--app-font-family)`，输出区移除写死的 monospace；
   - 桌面歌词字体下拉框纳入 `215-multilang-fonts.js` 统一管理，支持用户上传的全量自定义字体；
   - 移除自定义下拉框 trigger 上的原生 `title` 赋值，统一使用 `data-tooltip`，彻底根除浏览器原生灰白系统气泡与自研黑底气泡重叠的问题。
8. **情感词发光性能优化与边缘裁切修复**：
   - 精简发光样式为双层紧凑 text-shadow 并加入 GPU 合成层隔离，词云模式特化为单层轻量发光，彻底消除 3D 摄像机补间时 Skia 持续高斯模糊计算造成的严重掉帧；
   - 扩展 `.lyrics-container` 水平 padding 与负 margin 缓冲区，增加 `.line` 内边距，使行首/行尾发光在 mask-image 内完全展开，不再出现刀切截断。
9. **音质选项卡扩展三平台 vendor 对齐**：
   - 设置-播放-音质选项卡增加「酷狗音乐音质」（标准 128 / 高品 320 / 无损 FLAC / 超高解析），接通 `getKugouPlayInfo` 与播放/下载取链逻辑。
10. **i18n 英语国际化系统**：
    - 新增 `web/src/core/i18n.js`，提供中英双语词典映射与 DOM 智能属性更新；设置-界面增加界面语言切换选项，支持实时中英切换并持久化。

### 21.9 实测回归修复（2026-09-22 晚，上游失联专项 + 体验回炉）

- **QQ/网易云搜索播放挂 = 公网上游集体失联，非代码回退**：curl 实测 vkeys.cn（直连+代理）、ygking、byfuns 全部超时——QQ/网易搜索与取链的公网链全灭，酷狗走独立通道正常。本机自建 vendor（8001 `/api/selfhost/status`）三平台 alive+loggedIn。
- **搜索主通道切自建 vendor**（`150-search-engine.js fetchVendorSearchPage`）：QQ `/getSearchByKey`（`response.data.song.list`，封面用 albummid 拼 `y.gtimg.cn T002R300x300M000`）、网易 `/search`（`result.songs`，duration/1000），统一规范化为 `{id, mid, song, singer, album, cover, interval, source}`，4s 超时、单页 100 首、失败静默回退 vkeys（4.5s）。
- **歌词主通道切自建 vendor**（`musicApi.js fetchVendorLyric`）：QQ `/getLyric?songmid=`（注意不是 `/lyric`，后者 Not Found）、网易 `/lyric?id=`（自带 `tlyric` 翻译行），插入 `fetchLyricWithFallback` 主链最前，命中跳过 vkeys 7s×2 重试；返回 `{lrc, trans}` 与 vkeys 形状一致。
- **「vendor 优先、公网兜底」写入 AGENTS.md 请求链路首条**（2026-09-22 用户确立）：三通道现状=搜索/歌词（本轮 vendor 化）+取链（selfhostQQPlayUrl/selfhostNeteasePlayUrl 本在链首）；酷狗保持公网（其 vendor 搜索接口 2026-09-21 实测 502 参数被拒）。
- **播放链超时收缩**：ygking/byfuns 8s→3.5s（挂掉时 5 档 40s 白等）、175 vkeys 10s→4.5s。
- **外观面板"改了没用"根因链**：滑杆→previewEngine.setModeVar（仅预览）；同步主视图靠 onSettingChange→syncPreviewToMain→applyModeSettings 且仅主视图同模式时应用；**--halftone-size 唯一消费者是废弃的 view-poster** → PV 对空气输出。修：pv.css `.pv-view-container::before` 半调网点层消费该变量（overlay 混合）；PVEngine 去掉 `halftoneSize===6 视为未自定义`。
- **PV folia 化减法**：蓝图网格 0.75→0.16、巨型描边字 0.58→0.15（stroke 1.4px）、几何装饰 0.85→0.32；PV 预设风格按钮行删除。
- **桌面歌词字体修复**：下拉短键（kai/hei/mono…）歌词窗口无法解析 → `250-desktop-lyrics.js resolveDtkFontFamily()` 短键→完整字体栈（custom_* 查 window.customFonts，旧完整串透传），250 persist 与 215 onSelectFont 统一走它。
- **桌面歌词字号实时生效**：lyrics.html `applyDtkSettings()` 尾部补双 rAF autoResize，窗口随字号自适应不再溢出。
- **视觉模式按钮分两行**：`.appearance-mode-segment` wrap + 按钮 `flex-basis 20%`（5/行×2 行）。
- **i18n 扩容**：词表 ~150 条 + 前缀规则（动态拼接句式），覆盖 setting-desc/按钮/弹窗标题/title/placeholder；tab 切换后补跑映射。教训：**翻译含子元素节点用 textContent 会吃掉 `<b>` 计数结构**，先判 children.length。

### 21.10 无显卡虚拟机与软件渲染深度优化（2026-09-23）

- **背景离线预烘焙（Pre-baked Blur & Dim Background）**：无显卡虚拟机或 CPU 软件渲染器下，全屏 `filter: blur(60px)` 配合 `bgSway` 旋转每帧需重新进行巨幅高斯卷积，导致 CPU 100% 占满。新增 `generatePrebakedBlurBackground`：在 128x128 离屏 Canvas 上单次轻量下采样 + 模糊 + 压暗生成 DataURL；在 low/minimal/软件渲染下直接以该图片为背景并将 CSS `filter` 设为 `none`；后续旋转只变换 128px 贴图，极简与软件渲染下彻底关闭动画，彻底解放 CPU。
- **虚拟机显卡硬件识别**：`detectHardware` 补全 `vmware` / `virtualbox` / `vbox` / `qemu` / `parallels` / `svga` / `mesa` 等驱动识别，标记 `isSoftwareRenderer` 并向 root 注入 `is-software-renderer` 类名，自动推荐并锁定低配模式。
- **消除实时动画与巨型滤镜盲点**：流体光斑（`pv-fluid-blob` 70px 模糊）在 low/minimal/软件渲染下全面 `display: none`；进度条 `.progress-bar` 的 `transition: width 0.1s linear` 在低配下关闭，消除每 100ms 的插值重绘；封面悬停大阴影与 0.8s 复杂过渡在低配下关闭；`PVBackground` 丝绸波浪在 low/minimal 下消除 `cctx.filter`。
- **物理引擎强制回流消除**：`WaveLyricSystem.remeasureVisible()` 在低配/软件渲染下从每 30 帧（0.5s）放宽至每 180 帧（3s），且脏检查阈值放宽，消除无显卡虚拟机每半秒卡顿一次。
- **验证**：新增 `tests/js/test_prebaked_background.js`，全套单测 90/90 全绿，eslint 0 error。

### 21.11 纯 CPU 渲染极限模式 + i18n 反代/AI 全量覆盖 + Win11 风格 OOBE 重构（2026-09-23）

- **纯 CPU 零 GPU 极速模式（Zero-GPU Mode）**：
  - 针对装了 VMware Tools 仍严重依赖 CPU 模拟光栅化的虚拟机环境，`modals.css` 声明全局规则：`body.perf-low *`, `body.perf-minimal *`, `.is-software-renderer *` 彻底禁用全项目 `backdrop-filter` 和 `text-shadow`，控制栏、设置面板、弹窗等统一采用高不透明度实色保底（`rgba(20, 22, 30, 0.98)`），彻底杜绝 CPU 软件渲染器对半透明层反复做离屏图层拷贝与高斯卷积。
- **i18n 反代与 AI 分析弹窗全量覆盖**：
  - `201-settings-ai.js` 源码全面接入 `t(...)` 直调：首次分析反代隐私确认弹窗（标题、中转说明、官方接口回切提示）中英双语；设置面板 Gemini 反代中转警告、反代访问令牌保存/清除提示双语化；AI 状态面板（未分析/已恢复手动主题/正在分析/分析完成/分析失败/已分析缓存）以及情绪、风格、速度、情感词数量、HTTP 错误码全量双语。`i18n.js` 补齐 20+ 项双语词条。
- **Win11 风格 OOBE 向导重构与扫码弹窗层级修复**：
  - **扫码弹窗层级核心体验修复**：彻底废除 `overlay.style.display = 'none'` 粗暴关闭 OOBE 的做法；将 `#selfhostQrOverlay` 提至最高 `z-index: 2147483647`，直接在 OOBE 页面正中央优雅弹出；OOBE 稳定作为底层向导背景；扫码窗口关闭或登录成功时平滑淡出，OOBE 第 4 步服务卡片自动刷新为最新登录态。
  - **Win11 OOBE 风格与动效**：宽屏黄金比例（800px × 480px），深色 Mica 亚克力材质；经典左右分栏（左侧 Fluent 渐变徽标、主副标题、药丸进度条；右侧 Fluent 卡片与 Win11 微单选框）；翻页采用 Windows 11 标准平滑滑入动效（`slideFadeInRight` / `slideFadeInLeft`）；底部支持“上一步 / 返回”与 Fluent Accent 大胶囊按钮。
- **测试**：新增 `tests/js/test_win11_oobe_i18n.js`，全套单测 92/92 全绿，eslint 0 error。

### 21.12 PV/飞入图形 folia 极简重塑 + OOBE 再次进入入口与核心设置重构（2026-09-23）

- **PV 与飞入模式图形 folia 化重塑**：
  - **PV 底部几何层（PVDecorations.js）**：抛弃 150x34 实心大色块、大圆饼、粗厚斜楔等笨重图元，对齐 folia 瑞士国际主义排版体系：极细十字准星（6px/1px）、取景角标、等宽排版工程微标（`CH.01 // SEC.04`、`TIME.SYNC`、`FOLIA.SYSTEM` 等）、瑞士高精度刻度尺（长短交替细线）、轻量单线细圈；线条全部收敛到 0.8px~1px，透明度克制在 0.15~0.5，留白充足。
  - **飞入模式（Fly-In）背景图形（220-shortcuts-viewmode.js & viewmode.css）**：废弃 6 个 300px 旋转粗线大圆/多边形；转换为电影画幅取景框（`REC [FLY-IN]`）、对焦准星、底部极细音频时间标尺（`TEMPO // FLOW 44.1kHz`）、漂浮对焦十字；线条粗细由 1.8 降为 1.0，透明度调至柔和的 0.18~0.35，停止狂转改为极缓和的呼吸微浮动。
- **OOBE 重新进入入口与必要设置重塑**：
  - 全局暴露 `window.showAriaOobe(force)` 和 `globalThis.Aria.showOobe`；在“设置 → 关于”与“设置 → 界面”新增醒目的“重新体验新手引导 (Win11 风格向导)”按钮，点击自动关闭设置面板并弹出向导。
  - 移除冗余的歌词样式选择，重构为 4 步最必要设置：
    1. 界面语言选择（简体中文 / English，即时切换生效）；
    2. 设备与渲染性能（自动检测 / 极致画质 / 均衡表现 / 流畅优先 + 硬件信息 + AI 情感词微光开关）；
    3. 默认播放音质（无损 FLAC / 320kbps / 128kbps）与初始主题色（6 套调色板）；
    4. 自建音乐服务与扫码登录（网易云/QQ/酷狗，扫码在 OOBE 上层直接弹出，关后自动刷新状态）。



