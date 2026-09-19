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

- vendor 响应常见外套 `{response:{...}}`（QQ）/ `{data:{...}}`（酷狗/网易）——前端归一化须先解包。
- QQ c6.y.qq.com 对 node axios TLS 指纹风控(code:1000) → 用户资料类接口必须用 undici fetch。
- 自建接口统一经 server.py `_handle_selfhost` → `selfhost_service.proxy_drop_in`；对应 vendor GET 需带 `_t` 毫秒时间戳绕过 apicache。
- 播放链接池/HTTP:8001 服务的静态资源要 `Cache-Control: no-cache`。

## 常用操作

- 启动：`python server.py`（8001）；桌面版：`启动Tauri桌面版.bat` / `强制重启Aria.bat`（Chromium/pywebview 旧壳已删除）。
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