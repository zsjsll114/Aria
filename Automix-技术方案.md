# Automix（类 Apple Music 自动混音）技术方案 — Tier 2：真重叠交叉

> 2026-10-02 · 状态：**待评审，未动工**  
> Tier 1（智能 segue，单元素不换引用）是本方案的子集，分析管线两档共用。  
> 本文所有行号基于当前工作区，评审时如代码已动请复核。

---

## 0. 目标与一句话结论

Apple Music 的 Automix 本质 = **静音裁剪 + 智能 outro/intro 选点 + 等功率交叉淡化**，不是 DJ beatmatching。三件事纯本地信号处理都能做，50~200MB 模型只是把「选点」从启发式升级为学习式，接口层面预留 provider 即可。

**Tier 2 与 Tier 1 的唯一区别**：Tier 2 在交叉窗口内两首歌真正同时出声（双 audio 元素 + 双 GainNode），结束后做「角色顶替」。难点不在交叉本身，在**顶替**——见 §2。

---

## 1. 现状证据（为什么能做 / 坑在哪）

| 事实                                                                                          | 位置                                                                                                                                                       | 影响                                                                   |   |                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | - | ------------------- |
| 音频链路：单 `<audio id="audioPlayer">` → MediaElementSource → 10 段 EQ → compressor → destination | `core/equalizer.js:124`（建图）、`infrastructure/dom.js:15`（元素获取）                                                                                             | Web Audio 图已通，加第二条源支路即可，**不需要**另起 AudioContext                       |   |                     |
| `audio` 是 **const** 绑定：`const audio = document.getElementById('audioPlayer')` 并 export      | `app/20-lyrics-render.js:595`                                                                                                                            | 被 **30 个分片** import（实测 grep 计数见下），顶替方案的第一约束                          |   |                     |
| `globalThis.audio` 裸别名                                                                      | `app/20-lyrics-render.js:598`                                                                                                                            | `250-desktop-lyrics.js`、`DimensionVisualizer.js:682`（\`window.audio  |   | querySelector\`）等裸读 |
| 切歌触发点唯一：`ended` → `nextTrack()`                                                             | `app/70-audio-engine.js:203`                                                                                                                             | 无预加载，automix 需要在 ended 前 ~15s 就知道下一首是谁                               |   |                     |
| 切歌淡入淡出已存在（串行，不重叠）                                                                           | `core/fadeController.js`（正弦缓动 + 后台 setTimeout 兜底，从 135-crossfade.js 抽取）                                                                                  | Tier 2 的音量动画要搬离 rAF（见 §3.3），但它的兜底思路要保留                               |   |                     |
| core 层注入式持 audio                                                                            | `equalizer.js:38`、`fadeController.js:24`、`sleepTimer.js:23`、`stallDetector.js`（initStallDetector）、`tempoBoost.js:363`、`shortcutManager.js:93`（ctx.audio） | 顶替时这 6 处的引用要跟着切                                                      |   |                     |
| 音量标准化按切歌时机生效                                                                                | `app/135-crossfade.js:38`（appSettings.audio.volumeNorm）                                                                                                  | B 的目标增益要乘同一系数                                                        |   |                     |
| 本地离线分析先例                                                                                    | `core/chorusDetector.js:881`（tempAudio + AudioContext 分析）                                                                                                | 分析管线可行性已被项目自身验证                                                      |   |                     |
| 播放事件顶层绑定大量存在                                                                                | `70-audio-engine.js:23/39/70`（play/pause/error 在模块加载时 attach）                                                                                            | **live binding 顶替的真正难点**：顶层 `audio.addEventListener` 捕获的是 boot 时的元素值 |   |                     |

`import { audio }` 的 30 个分片清单：100/110/125/130/135/165/170(×2)/175/180/190/200/201/220/230/245/250/258/280/286/287/288/289/291/294/56/65/70/85/90/95。

---

## 2. 核心设计决策：怎么「顶替」

这是全方案唯一有爆炸半径的决策，三个候选：

### ❌ 方案 X：永不换引用，音频元素复用内容

交叉结束后把主元素 `src = B 的 blob; currentTime = t; play()`。  
**否决**：在线源 streaming URL 的 seek+play 有 100~500ms 重缓冲缝隙，交叉无缝变缝中缝；blob 可以但在线源不能保证全量缓冲。

### ⚠️ 方案 Y：全量改 `getActiveAudio()` 访问器

30 个分片 + 6 个 core 模块逐个改读法。  
**否决**：一次 PR 碰 36 个文件，与「结构重构委托外部、回流审查」的现状冲突；且 `app/` 本来就等着按职责重组，现在大规模改写是给未来的分片重组添乱。

### ✅ 方案 Z（推荐）：live binding 重指 + 监听器搬运表

1. `20-lyrics-render.js:595` 的 `const audio` 改为 **`export let audio`**。ES module 的 live binding 语义保证：swap 时模块内重指，**所有 importer 的运行时读法自动跟随，一行不用改**。
   - `globalThis.audio` 在 swap 时同步重指（覆盖裸读）。
2. 顶层一次性监听（`70-audio-engine.js:23/39/70` 等）改为经 `core/dualDeck.js` 的 `registerAudioListener(type, fn)` 注册：dualDeck 保存注册表，**swap 时成对 remove/add 搬运到新 active 元素**。分片代码只把 `audio.addEventListener(...)` 换成 `registerAudioListener(...)`——纯机械替换，eslint 全绿可验证。
3. 6 个 core 注入点改为每次使用时经 `dualDeck.getActive()` 取（或在 swap 回调里重新注入，prefer 前者，少一条回调链）。

**为什么 Z 赢**：改动集中在 1 个新模块 + 31 处机械替换 + 6 处注入点，且 Phase 1 可以「只落地 Z、不启用交叉」先合入——此时行为与现状完全一致（永远只有 deck A 活跃），全量回归绿了才动交叉逻辑。风险被切成两段。

---

## 3. 模块设计

### 3.1 `core/automix/analyzer.js` — 本地分析（Tier 1/2 共用）

```
analyzeTrack(url | blob) → Promise<{ introPoint, outroPoint, bpm, meanEnergy, fingerprint }>
```

管线：

1. `fetch` arraybuffer（在线源走 server.py 既有代理路径，绕 CORS；拿到即转 **blob URL** 用于播放——顺带解决解析链接时效问题，播放不再依赖原始 URL 存活）；
2. `OfflineAudioContext(1, ceil(sec*22050), 22050).decodeAudioData` → 单声道 22.05kHz（4 分钟 ≈ 10MB float32，解码秒级）；
3. 滑窗 RMS 包络（50ms 步长）；
4. 派生量：
   - `introPoint`：从头第一个 RMS > 全曲均值 15% 的窗口起点（裁前奏空白）；
   - `outroPoint`：从尾部回溯最后一个 RMS > 峰值 30% 的窗口（尾部衰减起点）；
   - `bpm`：包络一阶差分 → 自相关峰（120±60 搜索窗），误差 ±2BPM 足够；
   - `fingerprint`：文件长度 + 抽样字节 hash（在线源用 trackId + 比特率代替）。
5. 缓存 IndexedDB `automix/v1/{trackId}:{fingerprint}`。

**边界情况**：解码失败（损坏/DRM）→ 返回 null，scheduler 对该曲降级为原生 `ended` 行为，永不阻塞播放主链。

### 3.2 `core/automix/scheduler.js` — 预载与起播决策

```
ensureAnalyzed(track)         // 空闲时（requestIdleCallback / 播放中节流）后台分析下一曲
onTimeUpdate(currentTime)     // currentTime ≥ duration - outroPoint - overlap 时 ARM
armNext()                     // 问 95-track-loading 取「决策后的下一首」（见下），预载 blob
shouldCrossfade(A, B)         // 三层策略（见 §3.3.1）：对拍交叉 / 呼吸点交叉 / 降级 segue
                              // 前置否决：单曲循环、AB 循环区间内、分析失败 → 原生 ended
```

**对 95-track-loading 的唯一侵入**：把「随机/歌单/单曲循环模式下下一首是谁」的纯决策部分抽成 `computeNextTrack()` 导出（`nextTrack()` 内部调用它后再执行副作用）。**单曲循环、AB 循环区间内、用户开启 automix 前的最后一只歌**→ 直接不 ARM。

### 3.3 `core/automix/crossfader.js` — 交叉执行器（状态机）

```
IDLE → ARMED → CROSSING → SWAPPED → IDLE
         │         │
         └─ abort ─┴─ 任何用户干预（手动切歌/上一曲/seek/pause）→ ABORT
```

- **CROSSING**：B 元素（shadow deck）从 `introPoint` 起播；A、B 双 GainNode 等功率交叉：  
  `gainA = cos(π·t/T)`，`gainB = sin(π·t/T)`，t∈[0,T]。
- **音量曲线时钟**：EQ 图可用时用 `GainNode.gain.linearRampToValueAtTime`（AudioContext 时钟，**后台标签页也精确**，天然消灭 fadeController 注释里 rAF 节流的坑）；EQ 初始化失败（CORS 回退）时降级为双元素 `volume` + rAF + setTimeout 兜底（复用 fadeController 的模式）。
- **ABORT 语义**：沿用 agents.md 第 26 条切歌竞态守卫——abort 时 B 静音、A 恢复交叉前增益，generation 计数防迟到回调。**这是本模块唯一允许的复杂度**，必须配 3 条以上单测。
- **SWAPPED**：A 到达 ended（或 gainA 归零后强制 pause）→ `swapRoles()`：20-lyrics-render 的 `audio` 重指 B，搬运监听器表，A 进入 shadow 位并立即开始预载 C。

#### 3.3.1 BPM 差异策略（节奏打架的三层防线）

核心认知：**BPM 差距大 ≠ 不能交叉**。节奏打架的真正条件是「重叠区两首歌同时有明显鼓点」，BPM 差距只是代理指标。策略按 gap 与检测置信度分层：

| 条件                        | 策略                          | 实现要点                                                                                                                                                                                            |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gap ≤ 8 BPM 且双方 bpm 置信度合格 | **对拍交叉**（真 beatmatching）    | B deck `playbackRate = bpmB/bpmA` + `preservesPitch = true`（Chromium MediaElement 原生保音高变速，WebView2/浏览器版均可用），±5% 内人耳无感（DJ 行业常规范围）；超出 ±5% 此路关闭。重叠时长按速率缩放 `T_real = T/rate`（与 tempoBoost 并存的同一条规则） |
| 8 < gap ≤ 30              | **呼吸点交叉**（不对拍）              | analyzer 给 outroPoint/introPoint 的选点加约束：A 出口必须落在能量包络**衰减段**（鼓点已稀疏），B 入口必须落在**打击乐进入之前**——重叠区两边都接近无节拍内容，等功率交叉听不出打架。Apple Music 实际就是这个做法。锦上添花项（可不做）：B 第一拍落在 A 的节拍网格上                               |
| gap > 30 或任一方 bpm 置信度低    | **降级 segue**（Tier 1 淡接，不重叠） | 置信度低场景：纯器乐/古典/长铺垫电子，自相关不收敛；统一按最保守处理。永不阻塞播放主链                                                                                                                                                    |

analyzer 返回结构相应补两字段：`bpmConfidence`（自相关峰的显著度）与 `outroSparsePoint`（衰减段内更靠后的一个备选出口，供呼吸点交叉优先使用）。

### 3.4 `equalizer.js` 改造（最小侵入）

`initEqAudioGraph()`（L66）改为：两个 `createMediaElementSource` → 各自 gain → **mixBus（新增一个 GainNode）** → 既有 filter 链。对外只多暴露 `state.mixBus` 与 `attachShadowSource(el)`。CORS 回退路径不变（回退时 dualDeck 走 volume 交叉）。

### 3.5 设置 UI

`appSettings.playback.automix = { enabled, mode: 'segue'|'overlap', maxOverlap: 4~12s }`，设置面板「音效」tab（200-settings-panel.js）加开关 + 模式选择 + 时长滑条；i18n 双语条目；schema 走 defaults.js 现有 modeSettings 之外的 playback 段（注意：**tempera 那两条 WIP 测试失败提醒了 schema 登记是门禁**，automix 的 settings 键要同步登记进对应测试基线）。

---

## 4. 分阶段落地（每段独立可合、可回归）

| Phase | 内容                                                                                                | 回归标准                                                           |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **0** | analyzer + IndexedDB 缓存 + 单测（合成音频夹具：正弦 + 静音尾构造已知 introPoint/outroPoint）                           | 新增 node 单测全绿；不碰播放链                                             |
| **1** | dualDeck 骨架：`export let audio` 改造 + 监听器搬运表 + 6 个 core 注入点改 getActive()。**不启用交叉**，shadow deck 永不播放 | eslint 0 error、node 测试全绿、Playwright 视觉回归全绿、手动听感无变化             |
| **2** | scheduler 接线 + crossfader 状态机 + equalizer mixBus                                                  | 双 blob 夹具 E2E：交叉后进度条连续、歌词不重播、globalThis.audio 已重指；ABORT 3 场景单测 |

> **Phase 2 实施记录（2026-10-02）**：前置清单全清 + `core/automix/crossfader.js`（状态机/ABORT/双通道）+ `decision.js`（三层策略）+ `scheduler.js`（ARM 判定/预载/swap 完成）+ 135 抽 `applyTrackMetadataAfterSwap` + 95 抽 `computeStepTrack` + 接线分片 `app/96-automix.js`（开关 `appSettings.playback.automix.enabled` **默认关**）。node 15 条新单测全绿。**待办**：①真浏览器 E2E（GainNode `setValueCurveAtTime` 曲线、B canplay 时序、歌词高亮在 swap 瞬间的表现——agents.md #26 代际守卫是否需要接歌词主循环）；②在线源预载（走 175 解析链 + URL 时效）；③Phase 3 设置 UI + i18n。  
> | **3** | 设置 UI + i18n + CODE_WIKI/agents.md 补条目                                                            | i18n 棘轮基线更新；文档与代码同步（本次 CODE_WIKI 追平刚做完，别再欠账）                   |


> **Phase 3 实施记录（2026-10-02）**：设置开关 `setAutomix`（播放行为组，切歌淡入淡出下方）——`defaults.js` 登记 `playback.automix.enabled`（默认 false，180 深合并天然兼容存量配置）、200 `bindToggle`、220 面板打开重同步、i18n 词表 2 条（棘轮基线外新增 0）。开启即生效无需重启（scheduler 每次 timeupdate 重读 isEnabled）。
>
> **E2E 实施记录（2026-10-02）**：`tests/test_automix_e2e.py`（14/14 PASS，已登记 ci.yml）——两段 120 BPM 节拍调制 WAV data: URL 走完整链路：真 OfflineAudioContext 分析 → ARM → CROSSING → 6s 等功率交叉 → swapRoles → live binding 跟随 → 元数据同步 → B 接续分析 → 旧 A 收尾。**抓到真集成 bug**：analyzer 产 `outroPointMs/introPointMs` 而 decision/scheduler 读 `outroPoint/introPoint`，真链路决策永远 'none'（单测注入假结果掩盖了键名错位）——已统一到 `*Ms`。
>
> **v2 在线源支持（2026-10-02）**：scheduler 移除在线否决——ARM 期经注入的 `resolveOnlinePlayUrl` 即时解析（96 接线：175 `getPreloadedOnlineUrl` 预载命中 → `fetchPlayUrlForPreload` 解析链 → `getStreamCachedAudioUrl` 流代理包装），解析失败放弃本轮走原生 ended。swap 后在线曲歌词由 175 新增 `loadLyricsAfterAutomixSwap` 补载（歌词裸键写入收敛在 owner 分片 175，棘轮拦截过 96 直接写 `globalThis.lyrics` 的错误写法）；135 `applyTrackMetadataAfterSwap` 的 `currentSongData.source` 改为 `track.source || 'local'`。A 的后台分析 URL 缺失时回退读活跃元素 src。scheduler 单测 +2（在线解析成功 ARM / 失败放弃），共 9 条。

Phase 1 是关键闸门：**引用顶替先落地且行为零变化**，这是把「大重构」拆成「两次小改动」的唯一机会。

**Phase 2 开工前置清单（Phase 1 遗留，swap 届时才有调用者，缺一不可）：**

- [x] `core/tempoBoost.js`：audio 监听目标改 `resolveAudio()`（getActiveAudio() 优先、env.audio 兜底），4 个 audio 事件走搬运表（dualDeck 未 init 的测试环境回退直挂）；dualDeck 相应新增 `unregisterAudioListener`；
- [x] `core/sleepTimer.js` / `core/fadeController.js`：`_audio` 注入引用订阅 onRoleSwap 重指（只订阅一次，重复 init 不重复挂）；
- [x] `core/equalizer.js`：音频图改「source → deckGain → mixBus → filters」；新增 `ensureDeckSource(el)`（幂等，\_deckSources 缓存）与 `getEqAudioContext()`；cleanup 一并清 deck 通道；
- [x] `core/audioPlayer.js`：`initAudioEvents` 6 处常驻已进搬运表；`waitForAudioReady` 3 处 once 探针保留直挂（探针进搬运表是语义污染 + node 测试环境会 pending）；
- [x] `core/stallDetector.js`：监听已走搬运表，闭包读取已改 `_getAudio()`（getActiveAudio() 优先、注入值兜底）。

---

## 5. 风险清单

1. **live binding 盲区**：任何分片如果对 `audio` 做过解构（`const { duration } = audio` 不存在这种写法，但要 eslint 加一条规则禁止对 audio 导入做解构/别名赋值）或在闭包里长期缓存元素引用，swap 后读旧元素。Phase 1 的自定义 eslint 规则兜底。
2. **歌词高亮主循环**：swap 瞬间 currentTime 从 A(end) 跳 B(intro)，`57-wordcloud-camera` 的 `updateLyricsHighlight` 需要识别代际切换——项目已有切歌竞态守卫模式（agents.md #26），复用。
3. **桌面歌词窗口**：`250-desktop-lyrics` 经 globalThis.audio 裸读，swap 时重指即可，但**要确认它没有按值缓存**。
4. **内存**：预载 blob（压缩态 ~10MB）+ 交叉期两个 MediaElementSource，峰值增量 <30MB，可控。分析用 OfflineAudioContext 缓冲用完即弃。
5. **WebView2 兼容**：双 MediaElementSource 同一 AudioContext 在 Chromium 内核无兼容性问题（每元素一个 source 是标准用法）；浏览器版 Firefox 的 MediaElementSource 与 volume 联动有历史怪癖，但 EQ 回退路径已覆盖。
6. **tempoBoost（倍速）**：交叉期 playbackRate 需同时作用于两 deck；倍速与 automix 并存时 maxOverlap 按速率缩放（T_real = T / rate）。

---

## 6. 模型钩子（预留，本期不实现）

`analyzer.js` 的 `analyzeTrack` 本身就是 provider 接口。将来接入 ONNX Runtime Web（WebGPU EP）跑 50~200MB segmentation 模型（边界检测/副歌定位/调性匹配），只替换 provider 实现 + 懒加载开关；scheduler/crossfader 不感知。选型建议留到真做时再定，现在只保证接口形状（返回结构里留 `confidence` 字段，模型提供置信度，低置信自动降级启发式结果）。

---

## 7. 工作量估计（按 Phase 独立计）

- Phase 0：~1 天（含夹具与单测）
- Phase 1：~1.5 天（31 处替换机械但需要逐个验证 + 自定义 eslint 规则）
- Phase 2：~2 天（状态机 + ABORT 语义是硬骨头）
- Phase 3：~0.5 天

合计 ~5 天，Phase 0/1 可先行合入不阻塞。
