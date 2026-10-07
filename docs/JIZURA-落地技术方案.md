# JIZURA「字面」引擎接入 Aria —— 落地技术方案

> 目标：把 [JIZURA](https://github.com/852wa/JIZURA)（MIT © 2026 hakoniwa）的「输入歌词+音乐 → 自动生成日系文字 PV」引擎**整体搬进 Aria**，成为**第 10 种歌词视觉模式**，并**尽量还原**其画面。
> 口径：**可以全搬**（用户已确认），不做"借鉴重写"。本方案只描述施工，不含实现。
> 依据：`scratch/jizura/`（v0.10.1，165 文件 / 31MB，**零构建**：`build.py` 把 `src/*.js` 按文件名排序拼接成单文件 `index.html`）+ Aria 现有 10 个模式的接线面（逐条核对过行号）。

---

## 〇、决策记录与方案变更（2026-10-06 用户拍板 + 实测修正）

| # | 决定 | 对方案的影响 |
|---|---|---|
| 1 | 模式名 **「字面 · Jizura」** | §8-16、§10 文案面按此登记 |
| 2 | 字体：**上游 12 族日文字体做成"可选包"** + 默认用 Aria 现有字体 | §6.4 升级为两段式：默认走 Aria 字体（零 OFL 负担）；可选包走 Aria 字体管理导入，随包附各自 OFL 声明并登记 NOTICES |
| 3 | **要导出**，且要与既有「歌词海报（整句）」打通 | P4 保留 MP4/PNG/AE JSON；**新增 P3.5：海报打通**——`304-lyric-poster.js` 的 `stageForMode` 需要 jizura 分支（把当前行补到"整行已唱完"再抓帧），`captureIsRenderable` 已认"可见画布"故无需改 |
| 4 | **适配背景 MV** | 见下方"MV 适配"；复用 `mv.css:280-293` 的舞台透明化惯例 |
| 5 | 拉丁语言支持？ | **支持**，见下方"拉丁语言" |

### 方案变更 ①（重要）：引擎放 `web/src/vendor/jizura/`，**不是** `core/`

实测量化：上游 `11p_*.js` 里有 **800 个中日文 `name:` 字段**。放进 `core/` 会让 `i18n-coverage` 棘轮**当场新增 800 条未登记项**（外加 eslint 的 `no-unused-vars`/`no-empty` 等存量告警）。而这三处门禁**天然跳过 `vendor/`**：

| 门禁 | 位置 | 结论 |
|---|---|---|
| ESLint | `eslint.config.mjs:112` `'web/src/vendor/**'` | 已忽略 ✅ |
| module-reachability | `scripts/audits/module-reachability.mjs:13` `if (e.name !== 'vendor')` | 已跳过 ✅ |
| i18n-coverage | `SKIP_DIRS = new Set(['vendor', …])` | 已跳过 ✅ |

所以布局为：**引擎 → `web/src/vendor/jizura/engine/`**（第三方移植源码，语义正确、零门禁改造）；**适配层与视觉模式 → `web/src/core/visualizers/jizura/`**（我们的代码，受全部门禁约束）。

### 方案变更 ②：不搬 `12_ui.js` → 实际搬 **39 个文件 + bootstrap**

`12_ui.js`（1,944 行）是编辑器外壳（时间轴/面板/导出对话框/新手导览/i18n 宿主）。引擎侧不需要它，Aria 的 UI 取代它。其余 39 个文件全搬，产出 `engine/` 共 **40 个文件 / 2.06MB / 35,023 行**。

### 方案变更 ③：引擎需要新增的 API 从 1 个变 2 个

1. `Renderer.dispose()`（切模式释放 55–65MB 画布，§6.6）；
2. **透明/MV 通道**：把渲染器的 `opt.transparent` + `alphaGuard`（`09_render.js:387-422`）暴露成一个显式的"背景透明"开关，供背景 MV 适配调用（见下）。

### MV 适配（第 4 项决定）

Aria 的 MV 背景是 `#mvBgVideo` / `#mvBgCanvas`（`.mv-background`），靠 `body.mv-bg-on` 与 `.mv-background.visible` 控制；既有的适配惯例写在 `mv.css:280-293`——**只在 `body.mv-bg-on` 时**把各模式的"底"透明化，不开 MV 时其他模式一个像素都不变（`body.mv-bg-on .player-container:not(.preview-player).view-pv/.view-tempera { background: transparent !important }`）。

我们的做法（两处，都要）：
1. **容器层**：`body.mv-bg-on .visualizer-stage-jizura { background: transparent !important }`（写进新 `styles/jizura.css`，与 `mv.css` 同风格）；
2. **引擎层**：MV 开着时给渲染器传"背景透明"→ 不铺 style 自带的底（否则底色会把 MV 盖住）。走的就是引擎已有的透明机制（`alphaGuard`），**不需要改绘制逻辑**。

另注意：`101-mv-background.js` 在 `isExtremePerfMode()`（`perf-minimal` / `is-software-renderer`，`:212-213`）下本就关闭 MV —— 这时我们的模式也不必走透明路径，行为自然一致。

### 拉丁语言（第 5 项决定）

**支持，而且是上游显式设计的**：

| 证据 | 说明 |
|---|---|
| `02b_lang.js:12` `J.LANGS = ['auto','ja','zh-Hant','zh-Hans','ko','en']` | `en` 是一等公民 |
| `02b_lang.js:27,38` | 拉丁计数字母含**重音拉丁**（`0xC0–0x24F`）与全角；纯拉丁（≥6 字母且占比 ≥90%）判为 `en` |
| `02b_lang.js:106` | `en` 走"风格自带字面"（各日文字族本身含拉丁字形），不换字体面 |
| `08_planner.js:151` `J.isLatinText`（占比 ≥0.6） | 拉丁按**词**处理而非逐字 |
| `08_planner.js:142` `J.joinWords` | 拉丁/韩文**保留空格**、连字符行尾不空格——断行按词边界 |
| `02b_lang.js:117-124` `EN_U/EN_L/DIG/SYM` + `POOLS` | 乱码/雨/招牌等装饰字符池**按歌词语言取**（issue #16），英文歌词不会被塞片假名 |

**需要你知道的边界**：排版体系是 **CJK 优先**（竖排、逐字拆件、全角宽度假定），所以英文会呈现"**日系 PV 风格的英文**"——视觉成立但断行/字距与原生英文排版不同；`detectLang` 对**混排**（如日英夹杂的一行）会按加权判主语言，可能整首走一个语言面。结论：**能显示拉丁，且不是"能显示而已"**，但不要期待它与英文原生排版一致。

---

## 一、目标与范围

| 做 | 不做（明确排除） |
|---|---|
| 搬 `src/` 引擎（40 文件 / 36,929 行）：解析、规划、渲染、860 部件、27 风格 | **不搬** `12_ui.js` 的编辑器外壳（时间轴/面板/新手导览/导出对话框，≈1,500 行） |
| 让它跟着 Aria 播放器走：播放/暂停/切歌/seek/倍速 | **不搬** After Effects 面板与 CEP 扩展（`ae/`、`cep/`、`build_ae.py`、`build_cep.py`、`JIZURA_AE*.jsx`、`JIZURA_CEP*.zip`） |
| 用 Aria 的**真实歌词时间戳**驱动（这是比上游更准的地方） | **不搬** Google Fonts 的 12 个日文字族（改用 Aria 本地字体体系，理由见 §6.4） |
| 模式参数进入 Aria 设置面板「外观 → 该模式」 | 第一版**不做导出**（MP4/PNG/AE JSON）——留作 P3，接口已备好（§11） |

**还原度承诺**：渲染层是**逐行搬运**（只做模块化包裹，不改绘制逻辑），所以画面应与上游一致；两处**有意的偏差**必须知情：
1. **字体**：上游走 Google Fonts，我们用本地字体 → 字面观感会有差异（§6.4 给了补救选项）；
2. **逐字进度**：上游只有"cut 级 pIn/pOut + 字形序号错位"，我们用 Aria 的逐字时间戳（§7）→ 逐字节奏**会比上游更准**，但个别部件的错峰手感会略有不同。

---

## 二、上游与合规（必须先落）

| 项 | 内容 |
|---|---|
| 上游 | `852wa/JIZURA`，MIT，**Copyright (c) 2026 hakoniwa**（署名用 LICENSE 里的名字，不是仓库所有者） |
| 唯一第三方依赖 | `vendor/mp4-muxer.min.js`（mp4-muxer 5.2.2，MIT © 2023 Vanilagy）——**只有导出用**；P0–P2 不涉及 |
| 字体 | 运行时从 Google Fonts 拉 12 族（SIL OFL 1.1）→ **我们不打包字体**，故不产生 OFL 义务；若将来提供"JIZURA 字体包"，需附各自 OFL 声明 |
| 我们的许可 | Aria 现为 **AGPL-3.0-only**；MIT → AGPL 的并入是**允许的**，但必须保留上游版权与许可声明 |

**必做清单**：
1. `THIRD_PARTY_NOTICES.md` 新增「3. JIZURA」一节：地址 / MIT © 2026 hakoniwa / 引入方式（整体搬运 + 模块化包裹）/ 目标文件清单 / 若搬导出则追加 mp4-muxer 条目；
2. 每个搬运后的引擎文件**首行署名**：`/* Ported from 852wa/JIZURA (MIT, Copyright (c) 2026 hakoniwa) — See THIRD_PARTY_NOTICES.md */`
3. `scratch/jizura/` 已在 NOTICES 的"不得进入发布物"名单里（与 folia/jpv 并列）；
4. `AGENTS.md` 约束 12 的三条硬规则对本次同样适用（本条即是在执行它）。

---

## 三、总体架构与落地形态

```
Aria 播放器
  ├─ 220-shortcuts-viewmode.js  switchView('jizura')        ← 模式入口
  ├─ VisualizerManager._registerBuiltins()  register('jizura', JizuraVisualizer)
  └─ JizuraVisualizer（继承 VisualizerBase）
        ├─ 拿歌词：setLyrics(lines) → lines 带 start/end + words[].start/end（Aria 的真实时间）
        ├─ 拿时间：onUpdate(timeMs, timeSec) 每帧
        └─ adapter（Aria 侧新写）
              ├─ lyricsToPlan()   lines → JIZURA plan（复用其 parseLyrics 的标记语法 + 我们的时间戳）
              ├─ audioEnvelope()  复用 Aria 已有 BPM/能量/onset（替换 J.analyzeAudio）
              ├─ fonts()          Aria 字体栈 → JIZURA 的 font role + advance 度量
              └─ perf()           Aria perf 档 → JIZURA 的 fast/allowFilter/scale
        └─ engine/（搬运区，零逻辑改动）
              jizuraRoot(J) + 40 个模块 + packs（860 部件）
              renderer.frame(ctx, plan, t, opt)   ← 唯一渲染入口
```

### 形态决策：**走 `VisualizerManager` + 继承 `VisualizerBase`**（不是照抄 tempera 的独立单例）

理由（对比过两条路）：

| | 继承 `VisualizerBase`（**选它**） | 独立单例（照 `temperaMode.js`） |
|---|---|---|
| 容器 | 基类自动建 `.visualizer-stage-jizura`（`VisualizerBase.js:33-41`） | 自己 `createElement` + append（`220:961-968`） |
| 生命周期 | `start/stop/destroy` 现成（`:143/:150/:209`） | 自己写三段式（`ensure/suspend/destroy`） |
| 歌词下发 | `setLyrics(lines, aiData)` 现成（`:67-83`） | 自己在 `switchView` 分支里传 |
| 每帧时间 | `onUpdate(timeMs, timeSec, activeIdx)` 现成（`:138`） | 自己在 `70-audio-engine.js` 四处调用点加一行 |
| 后台节流 | **自动**被 `287-bg-throttle.js:100-111` 的 `visualizerManager` target 覆盖 | 必须自己注册 |
| 设置分发 | **自动**走 `190-settings-fontsize.js:333` 的 `mainVisManager` 分支 | 必须加 `if (mode==='jizura')` 分支 |
| 性能档 | `applyPerformanceProfile` 自动下发（`VisualizerManager:105-118`） | 自己读 `getPerfVfx()` |

引擎画布：在 `onInit()` 里于 stage 容器内 `createElement('canvas')`（尺寸 = `J.outputSize(project)` 等比缩放到容器，见 §6.6）。

---

## 四、引擎搬运工艺（关键：**包裹式 IIFE → ESM，零逻辑改动**）

上游是「40 个 IIFE 按文件名排序拼接成一个作用域」，靠**闭包共享 `const J`**（`src/01_util.js:5`），**不是**读写 `window.J`。因此最省事、最可控的搬法是**保留原文本，只做首尾包裹**：

| 源文件 | 包裹方式 | 说明 |
|---|---|---|
| `01_util.js` | `export function createJizuraRoot() { <原文> }` —— **只把那 1 行改成 `const J = {};`**（原为 `const J = (window.J = window.J \|\| {});`，我们不再挂 `window`），末尾加 `return J;` | 它是 `J` 的**创建者**，必须是第 1 个执行的模块；⚠ 该行**不能删**（删了就 `return J` 时 ReferenceError——这正是本方案最容易写错的一行） |
| 其余 39 个 | `export default function install(J) { <原文一字不改> }` | 它们读的就是**参数 J**（原文本 `(() => { const E = J.E; … })();` 原样成立：内层 IIFE 闭包到外层函数参数） |

**已实测确认**（2026-10-06）：`src/01_util.js:5` 确实是 `const J = (window.J = window.J || {})` 的顶层形式；`src/11p_enter.js` 等 pack 确实是 `(() => { 'use strict'; const E = J.E; … })();` 且以 `for (const k of Object.keys(DEFS)) J.register('enter', k, DEFS[k], P); })();` 收尾——**包裹式搬运成立**。

`engine/bootstrap.js` 按 §5 的顺序调用，产出**一个** `J`（引擎单例）：

```js
import { createJizuraRoot } from './01_util.js';
import install02fonts from './02_fonts.js';
/* … 40 行 import，顺序 = 上游 build.py 的排序 … */
export function createJizuraEngine() {
  const J = createJizuraRoot();
  install02fonts(J); install02bLang(J); /* … */
  return J;   // 拿到 J 即可 J.plan / new J.Renderer() / J.omakase …
}
```

**为什么不用"重写成正常 ESM"**：36,929 行里 packs 占 30,104 行，逐文件改写会引入无穷多的低价值 diff，且极易改坏绘制细节——那与"尽量还原"直接冲突。包裹式搬运的 diff 是「每文件 +2 行」，逻辑 diff 为零，**可逐文件与上游对拍**。

**搬运脚本**（一次性，写在 `scripts/` 下并保留）：读 `scratch/jizura/src/*.js` → 按上表加包裹与署名行 → 写到 `web/src/core/visualizers/jizura/engine/`。附带**校验**：包裹后的文件去掉包裹行应与上游文件逐字节相等（这条校验本身就是"没有偷偷改逻辑"的证明）。

---

## 五、加载顺序与三个一次性副作用（ESM 化最容易踩的地方）

执行顺序 = 上游 `build.py:11` 的文件名排序，**不能变**：

```
01_util → 02_fonts → 02b_lang → 03_text → 04_styles → 05_anim → 05b_registry
→ 06_layouts → 07_decor → 08_planner → 08b_omakase → 09_render → 10_audio → 11_export
→ 11p_bgcamB → 11p_decor → 11p_decorB → 11p_enter → 11p_enterB → 11p_exit → 11p_exitB
→ 11p_fxB → 11p_horror1/2/3 → 11p_kinetic1/2/3 → 11p_layoutsA/B/C/D
→ 11p_looks → 11p_styles → 11p_treattrans → 11p_typo1/2/3 → 11q_sets → 12_ui(不搬)
```

其中**三处"加载期一次性副作用"必须在包裹里显式化**（否则部件集/随机候选/AE 映射会静默错乱）：

| 副作用 | 上游位置 | 问题 | 处置 |
|---|---|---|---|
| `J.CORE_ORDER = {...ORDER.slice()}` | `08_planner.js:42` | 是**加载期快照**，必须在所有 pack 注册**之前** | 保持它在 packs 之前执行（顺序表已经满足），并在方案里标注"改顺序即破坏" |
| `11q_sets.js:38-43` 遍历所有 group/order 打 `extra/wa/set` 标记 | `11q_sets.js` | 必须在**所有** pack（含 `11p_styles.js` 的 `STYLE_ORDER.push`）之后，且**只能跑一次** | 保留在最后一个 pack 之后；重复实例化时**不能重复执行**（见下） |
| `08b_omakase.js:31-41` 给核心 def 追加 `tags` | `08b_omakase.js` | 同上 | 同上 |

**因此：引擎实例必须**是**进程内单例**（模块级 lazily 建一次并缓存）。重复创建会把 `tags/extra/wa/set` 追加两次，行为漂移。

---

## 六、与 Aria 的适配层（Aria 侧新写，不进 engine/）

### 6.1 歌词与时间（主线）
- 输入：`setLyrics(lines)` 拿到的 `lines[]`，字段 `start/end/time/duration/original|text/translation/romaji/words[]/wordTiming`（`VisualizerBase.js:100-111` 已消费同名字段）。
- 做法：**保留 JIZURA 的 `parseLyrics` 标记语法**（`/` 切块、`*强调*`、行尾 `!`、`歌词|注`、`[間奏]`、`[mm:ss.xx]`），把**行级时间换成 Aria 的真实时间**（`lines[i].start/end`）→ 通过 `timing.lineTimes` 通道传入（`08_planner.js:206` 的 `computeTiming` 已支持"手工时间优先"），并对无时间行保留其估算/插值逻辑。
- 好处：既还原上游排版决策，又不丢我们的时间精度。

### 6.2 音频分析（可整体替换）
- 上游 `J.analyzeAudio(file)`（`10_audio.js:7-72`）需要 `File/Blob` + `decodeAudioData`，输出 `{duration, buffer, beats[], energy, energyRate:50, peaks}`。
- planner **只消费 `beats[]` + `energy/energyRate`**（`08_planner.js:295,305-312,605-606`）；`bpm/peaks` 仅 UI 用。
- 适配：用 Aria 已有的 BPM/能量/逐 onset 能力生成同一结构（**并把卡点从"整张匀速网格 ±0.13s"升级为"逐 onset 可选"**——上游被吐槽的"卡点不准、镜头切换过快"正源于此）。`10_audio.js` 仍搬（作为解码兜底 / 离线导出用），但实时路径不走它。

### 6.3 逐字进度（唯一需要**新增引擎能力**的地方，详见 §7）

### 6.4 字体
- 上游：`J.FONTS`（`02_fonts.js:11`）+ 懒加载 Google Fonts（`:84-95`，5s 超时）+ `J.metrics.adv` 用 `measureText`（`:144`，`_mc` 离屏 canvas）。
- 适配：把 `J.FONTS` 的 **font role**（display/serif/body/mono）映射到 Aria 的字体栈解析结果（`utils/fontStacks.js` 的 `resolveThemeFontStack` + `210-color-multilang.js` 的模式字体），删掉 Google Fonts 注入，改 `document.fonts.load` 等 Aria 已注册的字体。
- **必须处理**：`02_fonts.js:110-132` 要求"先 `document.fonts.load` 再测量"，否则 `J.metrics.adv` 退化成 `1em/0.3em`（`:145`）→ **同一 seed 出不同构图**。方案：`replan()` 前 `await J.ensureFonts(plan)`，并在字体就绪前不渲染（显示占位）。
- 还原度补救（可选）：把上游那 12 族日文字体做成"可选字体包"，走 Aria 的字体管理导入（OFL 声明随之进 NOTICES）。

### 6.5 主题色
- 只读 `--aria-accent`（写入口唯一在 `190-settings-fontsize.js:339 applyThemeColor`；canvas 模式读法照 `PVEngine` 的行内 `style.getPropertyValue('--aria-accent')`）。
- JIZURA 的 `style.schemes[]`（`04_styles.js:10-151`）是它自己的配色体系，与 Aria 主题色**并存**：方案是"风格配色优先，`accent` 槽回落到 Aria 主题色"（可做成一个开关「跟随主题色」）。

### 6.6 尺寸与性能
- 设计尺寸：`J.designSize(project)` / `J.outputSize(project)`（`08_planner.js:1033,1042`）；实时渲染按容器等比缩放（`Renderer.frame` 的 `opt.scale`），导出才用全尺寸。
- 性能档映射：`getPerfVfx()` + `body.perf-*` + `html#ariaRoot.is-software-renderer` →
  `fast=true` 关 `ctx.filter` 与 ghost 通道（`09_render.js:68 allowFilter`）、降 `scale`、关 bloom/scanline/grain（`post()` `:490-517`）；
  **软件渲染（`is-software-renderer`）直接不启用该模式**（或强制最简：无 ghost/无 blur/无 grain）。
- 内存：1080p 下常驻画布可达 **55–65MB**（`scratch/camLayer/morphCv/transA-C/guardP-M` + paper，见 `09_render.js:19-31,145,201-206,231,250-259,389-390`）→ 切走模式时**必须 `destroy()` 释放**（`Renderer` 需加一个 `dispose()`，只清引用并置 `canvas.width=0`；这是对引擎的**唯一必要新增 API**，与 §7 并列）。
- 后台节流：走 `VisualizerManager` 自动覆盖；若改为独立单例则必须按 `287-bg-throttle.js:52-59` 注册。

### 6.7 帧探针
在逐帧回调里 `registerLoop('jizura','字面 · Jizura')` + `frame('jizura', ts)`（`core/frameProbe.js:74,87`），诊断页自动出现该模式帧时——便于将来查"低配掉帧"。

---

## 七、逐字时间对接（唯一需要新增引擎能力）

**现状（上游）**：只有 cut 级 `pIn/pOut`（`06_layouts.js:16-22`）+ 字形序号错位（`05_anim.js:86-91`、`11p_enter.js:18 stg(p,k,spread)`）；`cut.words` 只有文本边界（`08_planner.js:542`），**引擎里没有任何字符时间戳**。

**要做的三处**（都在搬运区内，是本方案唯一的逻辑改动，需单独 review）：

1. `03_text.js` 的 `J.layoutText`（横排 `:70` / 竖排 `:89`）给每个 glyph 增加 `ts/te`（来自 Aria 的 `words[]`/字素时间）；
2. `03_text.js:213-270` 的逐字循环里按 `u = clamp((env.ltb - g.ts)/(g.te - g.ts))` 生成隐式 charFn 进度；
   **必须用 `env.ltb`**（含 ghost pass 滞后，`09_render.js:164`），否则色差层与主层不同步；
3. 若走 `it.charFns` 注入路线，注意 `J.combineChar`（`05_anim.js:376-397`）**会丢** `clipX/clipY/skew/blur/outline`——`11p_enter.js:32-40` 已自带 `mergeChar` 绕开此坑，**新代码必须沿用同一绕法**。

**降级策略**：无真实逐字（`realWordsOf(line)===null`）时回落到上游行为（序号错位），保证任何歌都有画面。

---

## 八、Aria 接线清单（照抄这张表，漏一处就运行时静默失效）

| # | 文件 | 位置 | 加什么 | 忘了会怎样 |
|---|---|---|---|---|
| 1 | `core/visualizers/VisualizerManager.js` | `:23-27` | `this.register('jizura', JizuraVisualizer)` | `has()===false` → 实例被直接 `destroy()`，画面空白 |
| 2 | `app/220-shortcuts-viewmode.js` | `:910` | remove 名单加 `'view-jizura'` | 从其它模式切入残留旧类 |
| 3 | `app/190-settings-fontsize.js` | `:217-228` 兜底表 | `jizura: {...}` | fallback 到 cover 档（`:230`）→ 字号/字体串档 |
| 4 | `config/defaults.js` | `:181-253 modeSettings` | `jizura: {...}` 默认值 | 面板滑杆初值丢失、`getMS` 全落 fallback |
| 5 | `index.html` | `:573` 卡片区 | `.view-mode-card[data-mode="jizura"]`（含 `switchAppearanceMode('jizura')`） | 弹窗里没有入口 |
| 5b | `index.html` | `:574` 封面卡 onclick | `'view-jizura'` 加进 remove 串（该串已漏 `view-tempera`，顺手补） | 回封面时残留 |
| 6 | `index.html` | `:1145-1153` | `<button class="appearance-mode-btn" data-mode="jizura">字面 · Jizura</button>` | 外观面板无此模式 |
| 7 | `index.html` | `:1156+` sections | `<div class="appearance-section" data-mode-section="jizura">…</div>` | 参数面板空白/串档 |
| 8 | `core/previewEngine.js` | `:135-248 modeVars` | `jizura: defaultVisModeVar('jizura')`（+专有键） | 设置页预览不随参数变 |
| 9 | `core/vfxRecipe.js` | `:139-142 VIEW_MODES` | `'jizura'` | 视觉配方/分享码不认该模式 |
| 10 | `app/200-settings-panel.js` | `:466 modes` | `'jizura'` | "是否改的是当前模式"判错 |
| 11 | `app/285-bilingual-cycle.js` | `:30 KNOWN_MODES` | `'jizura'` | 双语热键把它当 cover |
| 12 | `core/lyricPoster.js` | `:70-72 FULL_BLEED_MODES` | `'jizura'`（满幅） | 海报模式判定不符 |
| 13 | 新 `styles/jizura.css` | — | `.view-jizura .player-controls-wrapper{display:none}` + `.lyrics-area-wrapper` 成对隐藏 | `tests/js/test_view_mode_stage.js` V2/V3/V4 直接红；MV 时播放列穿帮 |
| 13b | `scripts/audits/motion-audit.mjs` | `:17-20 EXPRESSIVE` | 加 `jizura.css` | 表现层曲线顶破壳层棘轮 |
| 14 | `app/287-bg-throttle.js` | 走 visManager 则**免** | （若改独立单例：按 `:52-59` 注册 target） | 后台满帧跑 |
| 15 | 引擎逐帧回调 | — | `registerLoop('jizura',…)` + `frame(…)` | 诊断页看不到帧时（不致命） |
| 16 | `core/i18n.js` | `:376` 区 | `'字面 · Jizura': 'Jizura'` | i18n-coverage 棘轮红（约束 7） |
| 17 | 文案面 | `index.html:2191`、`README.md:9,13,23,36-40`、`README.en.md:13,62-64`、`CODE_WIKI.md:942`、`docs/screenshots/README.md:3`、`docs/设置重构方案.md:38` | 「9 种」→「10 种」+ 模式表加行 | 自相矛盾 |
| 18 | `tests/js/test_view_mode_stage.js` | `:29 STAGE_MODES`、`:63 EXPECTED` | 补 `'jizura'`（含 mv.css 透明化） | V1/V2 红 |
| 19 | `.github/workflows/ci.yml` | — | 新增 Python E2E 需手抄（JS 走 glob 自动） | test-registry 红 |

**实现顺序**：① 引擎包裹搬运（§4）→ ② `JizuraVisualizer` + #1/#2 → ③ 适配层（歌词/时间/音频/字体）→ ④ #4/#8/#3/#5/#6/#7 面板面 → ⑤ #9–#12 清单面 → ⑥ #13/#13b/#18 门禁 → ⑦ #16/#17 文案。

---

## 九、设置面板参数（挂在「外观 → 字面 · Jizura」）

按 `data-var` 声明（约束 22），模式内写入 `modeSettings.jizura`。建议第一版暴露这些（都对应上游真实参数）：

| 参数 | 上游位置 | 控件 |
|---|---|---|
| 风格（27 套） | `04_styles.js:10-151` + `11p_styles.js` | 下拉 |
| おまかせ mood（7 种） | `08b_omakase.js:10` | 下拉 + 「随机」 |
| 部件集开关（typo/kinetic/horror + 和风/追加） | `11q_sets.js:32-53` | 多选/开关组 |
| 镜头密度 `density` | `08_planner.js:353-356` | 滑杆 |
| 渲染质量 `fx`（chroma/shake/grain/scan/bloom…） | `08_planner.js:32` | 开关组 |
| 语言（自动/日/繁/简/英/韩） | `02b_lang.js:12` | 下拉 |
| 字体（role→Aria 字体） | `02_fonts.js:11` | 4 个字体下拉（display/serif/body/mono） |
| 跟随主题色 | 本方案新增 | 开关 |
| 逐字精度（真实逐字 / 序号错位） | §7 | 开关（默认真实） |

---

## 十、命名与文案

- 建议名（**需你拍板**）：**「字面 · Jizura」**（贴合上游自称「JIZURA 字面」）／备选「排印 · Typo」「构成 · Compose」。
- 命名定下后，§8-17 的文案面 + i18n 词表一并改。

---

## 十一、分期计划与验收标准

| 阶段 | 内容 | 验收（可测） | 估工 |
|---|---|---|---|
| **P0 脚手架** | 包裹搬运脚本 + `engine/` 40 文件 + `bootstrap`（单例）+ `JizuraVisualizer` 空壳接 #1/#2 | 控制台 `switchView('jizura')` 出现画布；lint/单测/门禁全绿 | 1–2 天 |
| **P1 引擎跑起来** | 适配层（歌词→plan、时间、字体、性能）+ 渲染循环 + 真实歌词驱动 | 播放时画面跟着歌走；暂停/seek/切歌/切模式正确；无控制台错误 | 2–3 天 |
| **P2 全量部件** | packs 30,104 行全部搬运 + 三处加载期副作用校正 + 27 风格/860 部件抽签 | 随机换风格/seed 出不同画面；`omakase` 生效；无「抽到未实现部件」 | 1–2 天（机械） |
| **P3 逐字与打磨** | §7 逐字时间对接 + `Renderer.dispose()` + 性能降级 + 帧探针 | Aria 逐字进度驱动生效；低配档自动降质；切走无内存泄漏（任务管理器可见回落） | 2–3 天 |
| **P4 可选** | 设置面板参数完善、导出（MP4/PNG/AE JSON，需 vendor mp4-muxer 并登记）、可选日文字体包 | 面板改参数即时生效；导出成片可播 | 3–5 天 |

**总量**：P0–P3 ≈ **6–10 个工作日**（其中 30k 行部件是脚本化机械搬运）；P4 另计。

---

## 十二、测试与门禁

| 层 | 内容 |
|---|---|
| 纯逻辑单测（node） | ① `lyricsToPlan()` 适配器：给定 lines（含 words 时间）产出 plan 的 cuts 时间与上游 `computeTiming` 一致；② 无逐字时回落路径；③ 搬运校验：包裹文件"去包裹后与上游逐字节相等"（**这条是"没偷改逻辑"的证明**，也是回归防线）；④ plan 结构快照测试（W/H/fps/cuts 数量、cut 字段齐整） |
| E2E（playwright，`tests/*.py`） | 新模式可进入/退出；画布有非空像素（抽样非透明）；播放 3 秒后画面变化（帧间差异 > 阈值）；切模式无残留 DOM/无控制台错误；低配（强制 `perf-minimal`）不崩 |
| 门禁 | `module-reachability`（引擎从 `JizuraVisualizer` 静态可达）、`motion-audit`（EXPRESSIVE 加 `jizura.css`）、`i18n-coverage`、`test-registry`、`state-split-scan`（**不新增裸全局**）、`accessor-safety-scan` |
| 文案一致性 | README/en/CODE_WIKI/关于页的「9 种」全部改「10 种」 |

---

## 十三、风险与回退

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **全局 `J` + 加载期快照**（`01_util.js:5`、`08_planner.js:42`、`11q_sets.js:38-43`、`08b_omakase.js:31-41`） | 部件集/随机候选/AE 映射静默错乱 | 单例 + 严格顺序 + 三处副作用显式化；P0 即用"抽签结果快照测试"钉住 |
| 2 | **进程级可变单例**（`J.lang:02b_lang.js:104`、`J.TYPESET:03_text.js:13`、`J.glyphs/J.metrics:02_fonts.js:136,182`） | 快切语言/排版时互相污染 | 每帧前显式设定（上游 `frame()` 已这么做，`09_render.js:69-70`）；禁止并发两种语言 |
| 3 | **字体度量不确定性**（`02_fonts.js:110-145`） | 同 seed 不同构图、排版错位 | `await ensureFonts` 门控 + 字体就绪前不渲染；度量结果缓存 |
| 4 | **`ctx` 状态假设**（`ctx.filter`、非标准混合模式、透明模式**猴补 `ctx.fillRect/drawImage`**，`09_render.js:400-411`）+ **55–65MB 常驻画布** | 错绘/内存压力 | 不包装宿主 ctx、不上 OffscreenCanvas/Worker；切模式 `dispose()`；低配强制 `fast` |
| 5 | **逐字时间模型缺口**（§7，唯一新增能力） | 逐字节奏不像 Aria 的其它模式 | 三处改动 + `env.ltb` 同步 ghost + `mergeChar` 绕法；无真实逐字时回落到上游行为 |
| 6 | 搬运面巨大（37k 行） | 审查困难 | 包裹式搬运 + 逐字节校验 + 上游副本留在 `scratch/` 供对拍 |

**回退**：新模式完全独立（新文件 + 19 处加法），**不进任何既有模式的分支**；若中途放弃，删 `core/visualizers/jizura/` 并回滚 19 处即可，对现有 10 个模式零影响。建议 P0 阶段就单独 commit，便于回滚。

---

## 十四、需要你先定三件事

1. **模式名**：「字面 · Jizura」／「排印 · Typo」／其它？
2. **字体策略**：先用 Aria 现有字体（快、无 OFL 负担、观感有差异）／ 还是同时做"上游 12 族日文字体可选包"（更还原，但要处理 OFL 与体积）？
3. **导出**：只做"播放时的视觉模式"（P0–P3），还是也搬导出（P4，MP4/PNG/AE JSON，需 vendor mp4-muxer 并登记许可）？

定了这三件我就按 §11 从 P0 开工（P0 结束会给你一个可 `switchView` 看画面的最小可用版本）。
