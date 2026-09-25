# Aria 功能待办（面向用户体验的新增功能设想）

> 口径：**成本** S ≈ 半天内；M ≈ 1~2 天；L ≈ 需要设计、跨多个分片。
> **推荐度** ★ 越多越值得先做。
> 本文只收「用户能明显感觉到」的功能，不含结构债/重构（那些在 `AGENTS.md` 约束速查与
> `docs/模块化重构方案.md`）。
>
> 文中「已有基础」的文件路径与「某功能不存在」的判断，均经 2026-09-25 实际 grep 核实
> （已排除 `web/src/vendor/`）。核实为**不存在**的能力：睡眠定时器、gapless、
> 专注模式、歌词屏保、歌词内搜索、单句/A-B 循环。
> 注意：本仓库文档存在过期先例（曾发现 README 引用不存在的 .bat、CODE_WIKI 描述已删除的
> 模块），所以真要动手前请再确认一次现状。

---

## 一、低成本高感知（建议优先做完这一组）

### 1. 睡眠定时器 + 渐弱收尾 · ✅ 已完成（2026-09-25）
- **落地形态**：顶栏月亮按钮 → 弹层（15/30/60/90 + 自定义 1~600 分钟）；按钮 tooltip 与
  状态行实时显示 `mm:ss`；最后 60 秒线性音量斜坡；到点**只暂停不清队列**；重启不续跑
  但记住上次档位。
- **代码**：`core/sleepTimer.js`（纯逻辑，墙钟 + 斜坡）、`app/280-sleep-timer.js`（UI）、
  `styles/sleep-timer.css`；接线在 `app/index.js`、`index.html`、`config/defaults.js`、
  `app/180-boot-config.js`（`loadSettings` 深度合并，漏了会静默失效）、
  `app/135-crossfade.js`（`applyVolumeOnSongChange` 开头加淡出接管守卫）。
- **为什么没用现成的 `fadeOutVolume`**：它在 `appSettings.playback.fadeInOut=false`（默认值）
  时直接跳 0；且句柄与 crossfade 共享，切歌时 `fadeInVolume` 会把淡到一半的音量顶回满值。
  所以核心模块自己做「墙钟→增益线性」，rAF 逐帧 + 1s 看门狗补帧，同一纯函数不漂移。
- **已验证**：浏览器实测 15 分钟档启动 → `14:58` → `14:56` → 取消回 `Not set`；
  tooltip 同步；全库 15 个测试文件 0 失败；lint 0 error。
- **已知取舍**（未改，需要时再定）：定时期间手动暂停歌曲**不冻结**计时；
  顶栏按钮在 PV/隧道/词云等视图下随 `.top-action-buttons` 一起隐藏（与桌面歌词按钮同命）。

### 2. 歌词内搜索（当前歌 + 收藏 + 歌单）· 成本 S · ★★★★★
- **用户感知**：「那句『我在调节器里听见你的心跳』是哪首歌」——一句歌词直接定位并跳过去。
  这是所有音乐软件里最常被想起又最常被忽略的功能。
- **已有基础**：歌词已在内存里（`state.lyrics`、`app/20-lyrics-render.js`），收藏与歌单
  数据结构统一（`app/125-favorites.js`、`app/130-playlists.js`）；跳转能力现成
  （`app/100-cover-background.js` 的行点击跳转）。
- **注意**：歌词全文索引需要落盘（`user_config.json` 已经 161KB，别塞进去），
  建议 IndexedDB，复用 `services/fontService.js` 那套 DB 打开方式。

### 3. 单句 / A-B 循环（学唱歌）· 成本 S-M · ★★★★
- **用户感知**：一句反复唱到准为止。跟唱场景里这是"有没有"级别的差异。
- **已有基础**：逐字时间戳（`wordElementsByLine` / `wordHighlightElementsByLine`）、
  行点击跳转、`state.lyricOffset`。
- **注意**：`isLyricsLoopRunning` 是 rAF 循环的内部标志，**不是** A-B 重复，别误用。

### 4. 双语排版预设，一键循环 · ✅ 已完成（2026-09-25）
- **落地形态**：底栏 `#bilingualCycleBtn`（复用 `.bottom-btn`）+ `T` 键循环 / `Shift+T` 反向，
  四态 `只看原文 → 原文+译文 → 原文+音译 → 三行`；按钮线条数与文字随态变化，
  非「只看原文」时染 `var(--theme-color)`。代码 `app/285-bilingual-cycle.js`（自建自挂，
  样式由分片注入 `<style id="bilingual-cycle-style">`，全锚 `html#ariaRoot`）。
- **实测**：底栏挂载 ✓、tooltip/文本随态 ✓、`localStorage.lyrics_player_settings` 落盘 ✓、
  当前歌无译文无音译时**原地不动并给提示**（`#searchHint` + toast 双通道）✓。
- **两个必须知道的既有事实**（不是本次引入，但决定这按钮的“有没有用”）：
  ① 态是否可进取决于**这首歌有没有** trans/romaji，无则跳过并提示，不会假切；
  ② **PV / 隧道 / dimension 三种视觉模式完全不读** `showTranslation`/`showRomaji`
  （全仓 grep 只有 previewEngine、Neon、Letterpress 读），所以在这三个模式里按了无视觉变化；
  要跟随得改引擎排版路径，超出本项范围。
- **未接的可选接线**（需要时再做）：飞入模式底部翻译区不读这两个键（`56-playback-misc.js:29-30`）；
  `T` 还没进可配置快捷键表（`config/defaults.js` 的 `DEFAULT_SHORTCUTS` + 设置面板一行）。

### 5. 下一首预告 + 一键否决 · 成本 S · ★★★★
- **用户感知**：交叉淡化已经会自动切歌，但用户不知道接下来放什么，也不方便临时改主意。
  切歌前 5 秒浮出"下一首：XXX · 点击换一首"，不点就照常播。
- **已有基础**：`app/135-crossfade.js`（切歌时机）、`app/245-playlist-manager.js`
  （队列与当前索引 `state.currentTrackIndex`）、`app/95-track-loading.js`（预加载下一首）。

### 6. 动效强度滑杆（替代只有四档）· 成本 S-M · ★★★★
- **用户感知**：低配设备用户看到"高/中/低/极简"四档时不知道该选哪个，也不知道选了会损失什么。
  给一根 0~100 的"动效强度"滑杆 + 实时说明（"0 = 只保留逐字高亮，不做背景模糊与粒子"），
  比四档更容易理解，也让他们能自己找到能跑的档位。
- **已有基础**：`config/performance.js` 四档就是天然的插值端点；
  `appSettings` 里 vfx 覆盖已有 `setVfxOverride` / `getVfxOverrides`；
  `markSoftwareRenderer()` 与档位解耦（见 AGENTS.md 约束 12）。

---

## 二、观感与个性化

### 7. 专注模式（只留歌词）· 成本 S-M · ★★★★
- **用户感知**：一个键（或鼠标静止 3 秒）把控制条、侧栏、标题栏全部淡出，只剩歌词和背景，
  动一下鼠标回来。听歌场景里这是"氛围感"的最大单次提升。
- **已有基础**：视图模式切换体系（`app/220-shortcuts-viewmode.js` 的 `view-*` 类名机制）
  天然适合再加一个 `is-zen` 类；CSS 集中在 `styles/viewmode.css`。

### 8. 视觉模式自动导演 · 成本 M · ★★★★
- **用户感知**：不再需要手动切模式——按段落情绪或每 N 首自动换视觉模式（副歌进 PV、
  间奏进隧道、慢歌进活字），有惊喜感且完全不用学习。
- **已有基础**：这块地基非常厚——AI 情绪分析（`core/aiAnalyzer.js`）、段落情绪分池
  （`core/lyricSceneGrouper.js`、`core/pvEngine/shotProfiles.js`）、60 版式轮换、
  `core/themeEngine.js`。缺的只是一个"导演"策略层 + 一个开关。
- **风险**：切换时机与淡入淡出要克制，否则像电视购物。建议默认只在"用户 30 秒无操作"时切。

### 9. 视觉配方：保存 / 命名 / 分享码 · 成本 S-M · ★★★★
- **用户感知**：把当前所有视觉参数（模式、字号、模糊、摇摆、高亮色、版式偏好）存成一个
  命名预设，或复制成一段分享码发给朋友。
- **已有基础**：EQ 分享码已经把"编解码 + 复制 + 导入"这条路走通
  （`app/90-eq.js` 的 `copyEqShareCode` / `importEqShareCode`），参数也全都集中在
  `appSettings` 里，序列化入口现成。基本是复用一套模式。

### 10. 全局主题跟随当前封面 · 成本 S-M · ★★★
- **用户感知**：换歌时整个界面（控制条描边、歌单卡、进度条、高亮色）平滑过渡到这张封面的
  主色，"每首歌有自己的样子"。
- **已有基础**：`extractDominantColor`、`applyColorToLyrics`、`core/themeEngine.js`、
  `--theme-color` 变量体系（AGENTS.md 约束 6 已要求控件不得写死主题色，说明地基是通的）。

### 11. 可读性一键修正（亮背景桌面下看不清歌词）· ✅ 已完成（2026-09-25）
- **落地形态**：右上角工具栏 `#readabilityBtn`（复用 `.icon-action-btn` + `.on` 态，分片自建自挂，
  不需要改 `index.html` 的 DOM）。开档叠加：渐变底衬 + 描边 + 多层 text-shadow + 透明度地板
  （把 57 逐帧写的内联 `opacity:0.20` 抬到 `0.62`）+ `body::after` 压暗膜；
  按 `dominantColor` 亮度分亮/暗/中性三档。代码 `app/283-readability.js` + `styles/readability.css`，
  **只读** `appSettings.background.*` 与 `getPerfVfx().coverBlur`，不回写任何数值。
- **关键不变量已实测**：「关档零残留」——同一页面 `baseline_off` 与 `after_off` 的 computed style
  逐字段 diff = `{}`。这条最容易被将来某条 `!important` 悄悄破坏，值得进 CI。
- **三个已知边界**：① **桌面歌词窗口 `lyrics.html` 未覆盖**（独立 webview、`<html>` 无 `#ariaRoot`、
  样式全内联），而「亮壁纸」最字面的场景恰在它身上——要接需在 lyrics.html 内联镜像同一组规则并经
  `250-desktop-lyrics.js` 的握手通道同步开关；② 无显卡设备上 `text-shadow` 被既有
  `is-software-renderer * { text-shadow:none !important }` 顶掉，所以那条路改成「实色底衬 + 描边加厚」；
  ③ 阈值 `0.48 / 0.28 / blur<=20 / brightness>=0.55` 与三档 alpha 是估的，需要拿真实过曝壁纸回看。
- **词云/PV 的作用域**：词云下底衬与距离模糊不生效（描边/投影/压暗仍生效）；PV 下底衬与压暗膜全退。

---

## 三、播放与控制

### 12. 无缝专辑模式（gapless）· 成本 M · ★★★
- **用户感知**：现场专辑、古典、概念专辑中间不断。现在每首歌切换都走淡入淡出与
  `applyVolumeOnSongChange`，会人为制造间隔。
- **已有基础**：`app/135-crossfade.js`、`app/85-rate-download.js` 的 `applyPreservesPitch`、
  音频流代理 `getStreamCachedAudioUrl`。
- **风险**：跨域音频的精确时长与 `AudioContext` 解码路径要对齐；建议先做"同专辑内
  关闭淡入淡出 + 预加载下一首"这个简化版，收益就已经很明显。

### 13. 长按 2× 临时加速 · 成本 S · ★★★
- **用户感知**：按住空格（或某个键）临时快进，松手回到原速——听长内容时的肌肉记忆。
- **已有基础**：倍速链路完整（`currentPlaybackRate`、`preservesPitch`、
  `app/85-rate-download.js`、右键菜单里的倍速子菜单 `buildSpeedSubmenu`）。

### 14. 音量与进度的浮层反馈（OSD）· ✅ 已完成（2026-09-25）
- **落地形态**：`core/osd.js`（纯逻辑：语义 API + 同类合并 / 同向累计 / 1.2s 驻留）+
  `app/281-osd.js`（快照→文本+刻度，rAF 合批，双语自组）+ `styles/osd.css`
  （无 `backdrop-filter`，降级段锚 `html#ariaRoot`）。触发点接在
  `core/shortcutManager.js` 的音量±与 `seekBy`。
- **实测**：连按 F3 三次 → 只有一层浮层、`Volume 95%`、刻度 95%、`opacity:1` ✓；
  进度报**实际位移**（夹到 0/时长端点时不谎称跳了整步）✓。
- **口径**：只在键盘触发时出（拖滑条不出，避免双重反馈）；接管只读模式下不显示。
- **已知缺口**：项目**没有倍速快捷键**，所以 `showRate()` 目前是「有 API 无入口」；要补需同时改
  `config/defaults.js` 的 `DEFAULT_SHORTCUTS`、`220` 的 `shortcutLabel`、`index.html` 快捷键表。
  另：显示的是 0~100 手柄位而非声压（对数曲线，65 位≈10% 响度），未附 dB。

### 15. 取链透明化：这首歌到底走了哪个源 · ~~成本 S-M~~ · ✅ 已完成（2026-09-25）
- **落地形态**：底栏歌手行右侧角标（如 `QQ音乐 · 无损 FLAC` / `网易云 · 128k · 兜底`，
  走公网或跨源时整枚染成琥珀色）+ 点击展开「取链详情」面板 +
  「更多 → 取链详情」菜单项（角标所在面在部分视觉模式下会整列隐藏，菜单是无条件入口）。
- **代码**：`services/playSource.js`（命中记录与归类，纯数据不碰 DOM）、
  `services/log.js` 的日志环形缓冲（降级轨迹）、`app/275-play-source.js`（渲染）、
  `app/175-track-index-online.js` 19 个 `playUrl =` 赋值点各一行 `recordResolveHit`。
  行为测试 `tests/js/test_play_source.js`（17 例，已进 CI）。
- **过程中修掉的真实缺陷**：`musicApi.qqResolveUrl` 一直把服务端解析池返回的
  `quality/ext/provider/tried[]` 全部丢掉只留 URL——实测日志
  `[QQResolve] OK …(q=flac) <- tang(song_play_url,m4a)` 说明「用户要 flac、实际给了 m4a」
  这类信息本来就有，只是没往上传。现在 `qqResolveInfo` 保留完整负载，面板直接展示
  `tried[]`（每一级 provider + 耗时 + 失败原因），比抓日志行准。
- **踩过的三个坑**（写进 AGENTS.md 约束 14）：① 主信息列 `.player-controls-wrapper` 在
  `view-lyrics` 等模式下整列 `display:none`，角标挂那里等于不显示；② 解析池的 `quality`
  字段实际是 provider 的档位标识（见过 `'song_play_url'`），不能当音质直显；
  ③ 从 URL 猜音质**只能匹配 pathname**——QQ 直链的 `vkey` 是 hex 签名，实测出现以
  `…F320__v2…` 结尾的 key，整串匹配 `/320/` 会让角标把 m4a 谎报成 320k。

### 16. 队列智能：去重、从当前之后插入、来源补齐 · 成本 M · ★★★
- **用户感知**：导入外部歌单不再出现 8 遍同一首；"把这首歌插到下一首之后"一步到位；
  某首歌无版权时自动并明确地告诉你"已用另一源补齐"。
- **已有基础**：`app/145-playlist-import.js`（导入）、`app/175-track-index-online.js`
  （多源取链池）、`makeSongKey`（键规范化已存在）。

---

## 四、场景与设备

### 17. 手机遥控器视图 · 成本 M · ★★★★
- **用户感知**：手机连局域网后不是"缩小版的完整界面"，而是一个专为手掌做的遥控页：
  大封面、大进度、上下曲、音量、队列，横屏时当第二屏歌词显示。
- **已有基础**：`--lan` 启动开关、`app/60-mobile-dual-page.js`、`app/230-touch-gestures.js`
  都已存在，说明移动端与手势这条路已经趟过一半。
- **注意**：`/proxy` 的 Origin 白名单需要显式加入局域网地址（AGENTS.md 关键约定里已写明），
  否则手机上 AI 与部分接口会 403。

### 18. 窗口不可见时自动轻量 · 成本 S-M · ★★★★
- **用户感知**：切到别的窗口/最小化时，视觉引擎自动降到"只维持音频与歌词状态"，
  回到前台再恢复。对 VM 与笔记本发热是立刻能感觉到的差别。
- **已有基础**：`document.hidden` 判断已在卡死检测与部分引擎里使用（AGENTS.md 约束 12
  提到过后台节流保护），但 `PVEngine` / `NeonVisualizer` / `DimensionVisualizer`
  未见门控（2026-09-25 实测：这三个文件里 `hidden` 命中数为 0）。
- **补充**：浏览器对后台标签页的 rAF 本身有节流，但 Tauri 窗口**被遮挡/最小化**不等于
  标签页 hidden，所以这条在桌面壳里是真需求。

### 19. 歌词屏保 / 氛围模式 · 成本 M · ★★
- **用户感知**：没有播放时，屏幕上缓慢浮现常听歌曲的歌词金句，把播放器变成房间的一部分。
- **已有基础**：最近播放与统计已落盘（`recordPlayStats` / `getRecentHistory`）、
  九套渲染模式全部可复用，只需要一个"无操作 → 随机取句 → 用轻模式渲染"的调度层。

---

## 五、需要你先决策的（不是纯加法）

### 20. 逐字兜底：没有时间戳也做逐字 · 成本 L · ★★★★（2026-09-25 用户认可，优先级上调）
- **用户感知**：没有 krc/yrc/qrc 时间戳的歌也能逐字高亮（按字数均分 + 语速自适应，
  或复用音频分析做人声 onset 粗对齐）。
- **为什么单列**：这个项目的核心卖点就是逐字，"没有逐字幕"直接落到卖点上。
  但它是**质量风险**功能——均分错了会被明显察觉，比"没有逐字"更糟。
  建议做成显式开关（默认关），并允许 `lyricOffset` 那样的微调。
- **已有基础**：`core/chorusDetector.js` 已经会下载音频、解码、算能量与 BPM。

### 21. 应用内诊断页 · ✅ 已完成（2026-09-25）
- **落地形态**：「更多 → 应用诊断」→ `#diagnosticsOverlay`（复用 `.lyric-source-*` 壳），
  10 段：结论摘要 / 运行环境 / 显卡与渲染后端 / 档位与 vfx 实际值 / 帧时 / 启动耗时分解 /
  分词库 / 本机服务与 vendor / 取链详情 / 全局状态登记表。带「刷新」与「复制诊断文本」
  （纯文本与屏幕所见一致，且 `redact()` 会把直链里的签名参数值遮成 `?vkey&…=…`，可安全贴 issue）。
- **代码**：`core/frameProbe.js`（帧时采样，每源 `Float64Array` 环形 180 帧，>2000ms 记 `gaps`
  不污染帧时；内置 `global` 心跳常开）+ `app/284-diagnostics.js` + `styles/diagnostics.css`。
  入口 `window.Aria.diagnostics = { show, refresh, getText, frames }`。
- **刻意不用 `auditGlobals()`**：它每发现一个未定义/多写键就打一条日志，开一次面板会把环形缓冲灌满、
  挤掉「本次取链轨迹」——改用只读 `listGlobals()`，理由写进了段落 hint 与文件头。
- **实测**：接线后浏览器验证 10 段齐全、88 行数据、无 `undefined`/`NaN`/`[object Object]`、
  英文模式全段翻译无中文残留、无新增控制台错误。
- **顺手量到的真结论**（headless 恰好走 SwiftShader = 真·软件渲染环境）：
  `TTFB 395ms / DOM 完成 8405ms / 总传输 41.8MB / 脚本 128 个 6.2MB`，
  而**最大的 5 个资源全是自定义字体 ttf（7.1 / 6.6 / 4.8 / 4.7 / 3.8 MB）**
  —— 比 #13 已经处理掉的分词库（21MB→3.7MB）还大，是启动期的头号成本。
- **未完成的接线**：帧时段的**按引擎分组目前是空的**——需要在 8 个既有循环里埋
  `probeFrame()`（`70-audio-engine.js` 歌词循环、`57-wordcloud-camera.js` 弹簧、`PVEngine.js`、
  `PVBackground.js`、`DimensionVisualizer.js`、`previewEngine.js`、`60-mobile-dual-page.js`、
  可选 fade/sleep 瞬态）。流光隧道**不需要**埋（它的 rAF 已删、改 CSS 动画驱动）。
- **待你拍板**：① 内置心跳常开会让 VM 上的页面永不进入 rAF-idle，可改成「开面板才 start」；
  ② 公网上游（vkeys/ygking/byfuns）**不做主动存活探测**（失联时是整体超时，会把面板卡住数秒），
  现在只显示实际走了哪一级；要「公网红绿灯」需加 2s `AbortController` 并行探测。

---

## 六、folia-major「商籁」模式调研：可移植项（2026-09-25）

> 调研对象：`github.com/chthollyphile/folia-major`（Electron + React + PixiJS），
> 其视觉模式代码在 `src/components/visualizer/sonnet/`（约 30 文件 / 250KB）。
> 本地已浅克隆到 `scratch/folia-major/`（gitignored）。以下每条都带它的源码位置，
> 结论区分「核实过」与「推测」。
>
> **先说清楚它并不比我们先的地方**（避免照着错的标杆优化）：它**没有**逐字高亮/进度着色
> （每个字 alpha 0.16→1 一次到位），文本版式约 16 种（我们 60 种），**没有**运行期闭环降档
> （全仓无 FPS 采样、无 `prefers-reduced-motion` 分支），内置 Pixi 模式**也不监听
> `document.hidden`**。它的强项是**编排的确定性与图形手感**，不是性能。

### 22. 一条共享 rAF 闸 + 帧脏检查 + 后台停帧 · 成本 M · ★★★★★
- **为什么先做这个**：这是本次调研唯一直接命中「虚拟机 <10fps」的项。我们现在有
  **4 条互相独立的常驻绘制循环**（`core/pvEngine/PVEngine.js:585`、
  `core/pvEngine/PVBackground.js:153-169`、`core/visualizers/DimensionVisualizer.js:147`、
  `core/visualizers/NeonVisualizer.js:468`，另有 `core/previewEngine.js` 一条），且**全仓只有
  `app/70-audio-engine.js` 监听 `visibilitychange`**（2026-09-25 复扫：`grep -rl visibilitychange web/src`
  只命中这一个文件）——暂停或切走后 PV 仍在满帧绘制。
- **它的做法（已核实）**：`src/utils/frameRateLimiter.ts:194-195` 直接 monkey-patch
  `window.requestAnimationFrame`，用一条 native frame 冲刷全部回调（:83-104），
  在 `src/index.tsx:23` 最早安装；配套 guardrails 明文禁止在 RAF/ResizeObserver 回调里
  无条件 setState。帧内只写 transform/alpha，配 `if (!dirty && t === lastT) return` 脏检查。
- **落点**：新建 `web/src/core/frameBus.js`（Map 回调 + 单条 rAF + `1000/fps` 容差），
  四个引擎改用它；renderLoop 头部加脏检查；`document.hidden` 或 `audio.paused` 时停帧。
- **注意**：这条与 #18 是同一件事的两个面，合并做，别分两次改引擎。

### 23. renderScale 吸附到 2 次幂面积桶，并在 resize 里重算 · 成本 S-M · ★★★★
- **它解决的问题**：全局降分辨率会让所有东西一起糊。它的纹理预算不是按字节记账，而是把
  renderScale **吸附到 Pixi 纹理池的 2 次幂桶**（`pixiTextureBudget.ts:52`
  `texturePoolAxis = nextPow2(ceil(css*res-1e-6))`、:86-113 `snapResolutionToTexturePool`），
  超预算时**不降级不丢弃**，只退还「换不来更小桶的那部分像素」；注释给了实测阶跃代价
  （640→700px，面积 +18% → 显存 628→822MiB）。
- **关键细节**：resize 会把已吸附的值推过桶界，所以**必须在 resize 路径重算**，不能只在启动时算
  （`createSonnetPixiRuntime.ts:201-208`）。
- **我们的现状**：`config/performance.js` 只有 4 档固定值；`core/pvEngine/PVBackground.js:129` 与
  `core/tunnelEngine/TunnelDepthStack.js:267` 直接 `Math.min(devicePixelRatio, 2)`
  （两处各自还有一套 `Math.sqrt(MAX_CANVAS_PX/(w*h))` 面积上限，但**不吸附到任何桶**），
  窗口尺寸跨过合成器 tile/内存台阶时毫无反应。
- **落点**：`config/performance.js` 加 `snapRenderScale(w, h, scale)`（Canvas 2D 版按后备缓冲
  字节 `w*h*4` 对 2 次幂面积桶吸附），在上述两个引擎的 resize 里调用。
- **另一条可偷的**：它内置 Pixi 模式**完全不读 devicePixelRatio**，改用可调的
  `textureResolution`（默认 1.5，`src/types.ts:569`）。对无显卡设备，「按 DPR 全分辨率」
  本身就是错的默认值——我们应当默认 <1。

### 24. 描边生长 ✅ 已落地 / 四层描边场 ❌ 已回退（2026-09-25）
- **它的做法**：`sonnetAnimatedGraphics.ts:118-234` 把 moveTo/lineTo/arc 记成命令流并累计弧长，
  每帧**按弧长截断重放** → 手绘笔触生长感。变体是**四层正交**随机
  （HUD 8 × 主几何 100 × fixedGeo 8 × 粒子 6），按**内容/位置哈希**选版且**不重复**
  （`sonnetProgram.ts:193-258` 声明式 Program→Paragraph→Shot 编译器，可 seek）。
- **已落地（描边生长）**：我们的图形全是静态 SVG，不必自己实现命令流——
  `core/shapeField.js` 给每条子路径注入 `pathLength="1"` 把长度归一化，
  CSS 侧 `stroke-dasharray:1` + `stroke-dashoffset:1→0` 就是浏览器原生的弧长参数化，
  零 JS、一次 `getTotalLength()` 都不用。入场按图形序号错峰起笔
  （`--grow-delay ≈ 0.15 + i*0.22s`），读起来像一遍手绘铺陈；换歌重建图层时自动重放。
  基础几何（border/clip-path 画的）没有描边可长，用同一时间轴的 `--grow-delay` 落墨补齐节奏。
- **实测**：`tests/js/test_shape_field.js` 6 例（pathLength 覆盖率、确定性、错峰、粒子未受影响）；
  浏览器侧确认 `stroke-dashoffset` 从 `1px` 动画到 `0px`（delay 1.6s / dur 1.48s 那条），
  且 `tests/test_pv_geo_mosaic.py` 23 项全绿（含 `shape-orbit-anim` 未被新动画顶掉）。
- **★ 一个必须记住的坑**：`.pv-shape` 的 `pv-shape-orbit` 已经占了 `transform`，
  再给同一元素加一个也写 `transform` 的入场动画并带 `both`，**列表里靠后的那个会全程压制前者**，
  漂移就永久锁死了。所以基础几何的落墨只动 `opacity`。
- **VM 安全性**：整层 `.pv-shape-field` 在 `perf-low`/`perf-minimal`/`is-software-renderer` 下
  本就 `display:none !important`（modals.css:1662），生长动画在那类设备上根本不实例化。
- **❌ 四层描边场已回退**（同一轮里做的 `core/sonnetField.js`：HUD(8)×主几何(12)×fixedGeo(8)×粒子(6)、
  换段即换版 + 双缓冲交叉淡入）。用户实测三条判定全部成立，我已核对并认账：
  ① **只有 1px 描边、没有实心块**，整幅读起来像施工图纸，不如原来的图形场；
  ② **生长挂在挂载时的 1.5s CSS 动画上，不跟演唱进度走** —— 这是屏保不是伴奏。
  商籁的弧长截断是**播放头驱动**的（所以可 seek、每个字推进一笔），
  而 `PVEngine.update(currentTimeSec)` 每帧就有播放头，我上一轮完全没接这个信号；
  ③ **短碎段太多**（放射 12 根 / 刻度 22 格 / 弦线 8 条 / 点阵），线条不连续、画面很杂。
  商籁的主几何是**少数几条长而连续的弧线一笔挥成**，我搬的是「结构」不是「观感」。
- **✅ 重做已落地（第三轮）**：新增 `core/pvEngine/PVArcField.js` + `PVRendering.sungProgress()`，
  按上面三条逐条对上：
  ① 只作**点缀层**叠在图形场之上，默认底仍是带实心块 + icon 的 shapeField（质量回来了）；
  ② 揭示量 = **`sungProgress(播放头)`**，不是墙钟——`PVEngine.update()` 每帧喂一个 0..1，
     只往容器写**一个 CSS 变量 `--p`**，`stroke-dashoffset: calc(clamp(0,(a1-p)/(a1-a0),1) * 1px)`
     由浏览器算，JS 不遍历元素、不读布局。所以暂停即停、seek 即跳。
  ③ **只有 3 条弧、每条一次挥笔**（1 个 M + 1 个 A，张角 ≥130°），且**共用一个圆心**、半径递缩——
     实测各给一个圆心时部分揭示读起来是几段互不相干的碎线，同心之后才像「一笔挥到一半」。
     每条弧起笔处一枚实心点，避免这层又变成「全是线」。
- **实测**：`tests/js/test_pv_arc_field.js` 13 例（含「一次挥笔无碎段」「张角 ≥130°」「同心」
  「起笔点在弧上不在圆心」「sungProgress 单调可回跳」）；
  `tests/test_pv_geo_mosaic.py` 加 6 项浏览器侧集成断言，30/30 全绿——
  关键是 `arc-moves-with-progress`：`--p=0` 时 `['1px','1px','1px']`，`--p=0.3` 时
  `['0.4px','1px','1px']`，即第一条画了 60%、后两条还没起笔。
  低配/无显卡整层 `display:none`（已加进 modals.css 的 `#ariaRoot` 降级段），
  `prefers-reduced-motion` 直接给终态。
- **回退后保留的部分**：icon 的 `pathLength` 描边生长（`shapeField.js` + `pv-shape-ink`）
  用户没有异议，留在默认底上，`shape-icon-ink` 断言盯着。
  `sonnetField.js` 与其测试已删除——留着就是一个新的「不可达影子模块」
  （AGENTS.md 约束 10 记过这个坑：`module-reachability` 当时会从 6 涨到 7）。
- **反例提醒**：folia 宣称确定性，但 `sonnetGuides.ts:82,107-146` 与
  `sonnetAnimatedGraphics.ts:74-75` 漏了 `Math.random()`，破坏了自己的可复现性——
  我们的随机源已经收口在 `mulberry32(seed)` 一处，别在 `buildShapeFieldHTML` 里引入裸 `Math.random`。

### 25. 视觉模式插件契约（mount(container, ctx) → dispose）· 成本 M · ★★
- **它的两层契约**：内置模式 = `VisualizerRegistryEntry`（`definition.ts:166-199`，
  `render/renderSettingsPanel/resetSettings/usesWordSegmentation/foliumTunables`），
  用 `import.meta.glob('./*/entry.tsx', {eager:true})` 发现 + 启动自检，renderer 内部再
  `React.lazy`（否则 183 个模块含 three.js 全进包）；第三方 = `src/mods/folium/contract.ts`
  的**纯 DTO**（`FoliumLine/FoliumTheme`，宿主类型绝不外泄），生命周期只有
  `mount(container, ctx) => dispose?`（:313），ctx 提供 `currentTime.on / subscribe / audio / getSettings`。
- **隔离真相**：同 realm、**无沙箱**（`mods/README.md:27-31` 原文「模组是可信代码，不是沙箱」），
  边界是实验室总开关 + 主进程二次确认 + 内容摘要绑定的信任。
- **为什么只给 ★★**：你是单人项目，第三方插件生态不是目标。真正值得抄的是**「宿主类型不外泄的
  纯 DTO 契约」+「usesWordSegmentation 这种能力声明」**——我们 9 套模式现在靠 if/else 分发，
  抽一个 `VisualModeEntry` 能顺带把 #8 自动导演和 #9 视觉配方变成查表。
- **推测项声明**：它「换歌不重建渲染上下文」（`pixiRuntimeHost.ts:4-9` + `drainSong` :72-96）
  是否对应我们的真实开销，**尚未逐行核对** `PVEngine` 的 start/stop 调用点，别照此立项。

---

## 如果只做 5 个

1. **共享 rAF 闸 + 后台停帧**（#22）——虚拟机 <10fps 的直接对症药，且是调研结论里唯一
   一条「我们比它差」的性能项。
2. **睡眠定时器**（#1）——刚需，几乎白送。
3. **歌词内搜索**（#2）——每天会用很多次，且别人都没有。
4. **专注模式**（#7）——单次改动带来的氛围提升最大。
5. **诊断页**（#21）——让后面所有性能优化有据可依（#15 的日志环形缓冲已经给它打好底）。
