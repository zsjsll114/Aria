# Aria 功能待办（面向用户体验的新增功能设想）

> 口径：**成本** S ≈ 半天内；M ≈ 1~2 天；L ≈ 需要设计、跨多个分片。
> **推荐度** ★ 越多越值得先做。
> 本文只收「用户能明显感觉到」的功能，不含结构债/重构（那些在 `AGENTS.md` 约束速查与
> `docs/模块化重构方案.md`）。
>
> 文中「已有基础」的文件路径与「某功能不存在」的判断，均经 2026-09-25 实际 grep 核实
> （已排除 `web/src/vendor/`）。当时核实为**不存在**的能力：睡眠定时器、gapless、
> 专注模式、歌词屏保、歌词内搜索、单句/A-B 循环——**其中除 gapless 与歌词屏保外，
> 到 2026-09-26 都已落地**（见各条 ✅ 与代码路径）。
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

### 2. 歌词内搜索（当前歌 + 收藏 + 歌单）· ✅ 已完成（2026-09-26）
- **落地**：`app/288-lyric-search.js`（取词/排期/渲染/跳转）+ `services/lyricIndex.js`
  （IndexedDB 独立库，匹配/排序/增量算法，纯函数）+ `styles/lyric-search.css`；
  行为测试 `tests/js/test_lyric_index.js`。范围实际为「当前歌 + 收藏 + 自建歌单 + 最近播放」，
  索引确实没进 `user_config.json`（下面那条注意已按建议实现）。
- **2026-09-27 统计条改样式**（用户圈的图一）：`.ls-sum` 原来是「`position: sticky` + 自带一层
  深色渐变底 + `blur(6px)`」，三样叠起来是一条**浮在列表上的半透明带**——列表滚到它下面那一行时
  两边文字各透出一半，谁都读不了，而且那块灰底和毛玻璃面板不是一个材质。
  现在随流、透明、只留一根分隔线（实测 `background: rgba(0,0,0,0)`、`position: static`、
  与首行重叠 -2px），降级段里那条针对它的规则一起删了。
- **用户感知**：「那句『我在调节器里听见你的心跳』是哪首歌」——一句歌词直接定位并跳过去。
  这是所有音乐软件里最常被想起又最常被忽略的功能。
- **已有基础**：歌词已在内存里（`state.lyrics`、`app/20-lyrics-render.js`），收藏与歌单
  数据结构统一（`app/125-favorites.js`、`app/130-playlists.js`）；跳转能力现成
  （`app/100-cover-background.js` 的行点击跳转）。
- **注意**：歌词全文索引需要落盘（`user_config.json` 已经 161KB，别塞进去），
  建议 IndexedDB，复用 `services/fontService.js` 那套 DB 打开方式。

### 3. 单句 / A-B 循环（学唱歌）· ✅ 已完成（2026-09-26）
- **落地形态**：「更多 → 单句循环 / A-B 循环」两项 + `L` 键（单句循环）；底栏
  `#abLoopStatus` 实时显示当前态（`A-B 24.3s→31.8s` 一类），A-B 走「先按 A 再按 B」的
  边界标记。代码 `core/abLoop.js`（纯逻辑：行区间、尾部偏置、seek 取消判定）+
  `app/294-ab-loop.js`（接线，只挂 `timeupdate`/`seeked`，未改 57/70 的逐帧循环）。
- **两个必须知道的决定**：① 单句区间取**真实逐字**行界（`realWordsOf`，约束 17），
  合成节拍的行只按行级时间戳，尾音拖腔给 `TAIL_SKEW_MS = 1500` 的余量，否则每句都被截尾；
  ② 用户**手动拖动进度**即退出循环——锁着区间会让「想听下一句」变成「必须先找开关」。
- **已验证**：`tests/js/test_ab_loop.js`（11 例，含 `lineRangeMs(L, null)` 不得当成第 0 首，
  因为 `Number(null) === 0`）+ `tests/test_ab_loop_ui.py`（13 例真音频 E2E：循环回卷、
  seek 取消、切歌清态）。变异测过——把 seek 取消摘掉后 E2E 立刻红。
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

### 5. 下一首预告 + 一键否决 · ✅ 已完成（2026-09-26）
- **落地形态**：切歌前约 5 秒在底栏上方浮出「下一首：XXX · 点击换一首」，点它从**确定的候选
  列表**里换一首（不是随机），不点自动消失、照常播。代码 `core/nextUp.js`（纯判定）+
  `app/289-next-up.js`（读状态 → 判定 → 渲染 → 撤销），偏好藏 `appSettings.interface.nextUp`。
- **撤销可靠性**：`timeupdate` 每帧用「代际 + 队列索引 + `audio.src`」三要素签名比对，任一变化
  即隐藏；play/pause/seeking/seeked/ended/loadstart/durationchange/emptied 各再触发一次。
  随机模式压根不报名（报了就是谎）。行为测试 `tests/js/test_next_up.js`。

### 6. 动效强度滑杆（替代只有四档）· ✅ 已完成（2026-09-27）
- **落地形态**：设置 → 性能 →「视觉开销」组第一行是一根 0~100 的 `#vfxIntensity` 滑杆，
  旁边实时说明**逐项报出这一档给了什么**（背景模糊几 px / 毛玻璃几 px / 歌词模糊 /
  渲染分辨率% / 五个特效开关的开通）。四档按钮保留，但滑杆默认是「跟随等级」态：
  指针停在当前档位的等效位置、数值栏写 `跟随 67`，不覆盖任何键。
- **代码**：`core/vfxIntensity.js`（纯映射：四档 vfx 当插值端点，无 DOM 无 localStorage）+
  `app/295-vfx-intensity.js`（接线）+ `config/defaults.js` 的 `interface.vfxIntensity`（约束 11
  的安全落位）+ `180-boot-config.js` 的 `getVfxOverrides()` 叠加点。
- **★ 叠加顺序是这件功能的全部难点**：生效值 = 档位 vfx ⊕ 滑杆 ⊕ 手动单项微调，
  **手动在最上层**。反过来（滑杆覆盖手调）等于用户拖一次滑杆就无声丢掉他调过的开关——
  那是数据丢失不是重置。配套两个坑：
  ① `setVfxOverride` 的基底必须读**原样手调表** `getManualVfxOverrides()`，不能读合并视图，
    否则每点一次单项开关就把滑杆当时的 10 个推导值冻结进表里，滑杆从此失效（E2E 实测复现过）；
  ② 两个「恢复推荐/出厂配置」按钮必须同时清 `interface.vfxIntensity`（走
    `Aria.__resetVfxIntensity`），不然按钮撒了谎。
- **为什么不写进 `perf_vfx_overrides_v1`**：滑杆值与手调各自存、读取时叠加，
  才能保住 ① 的语义；代价是「拉满但某个开关仍关着」需要解释，已写进行说明里。
- **为什么独立成分片**：i18n 门禁把「文件里出现 `translatePhrase()`」判成整份自译、
  要求全部中文登记；220 是热文件且有 6 条历史漏登，所以滑杆自成一页，220 只留两个钩子调用点。
- **已验证**：`tests/js/test_vfx_intensity.js` 11 例（端点还原档位原值、单调不越界、
  **未设定 ≠ 0**（`Number(null) === 0` 那个坑）、开关权重过半才点亮、0.05 网格吸附）+
  `tests/test_vfx_intensity_ui.py` 23 例浏览器接线（拖到 0/100 后 `getPerfVfx()` 真等于
  minimal/high、说明行文案、手动优先、跨刷新持久化、跟随按钮与两个重置按钮）。
  变异测过：摘掉叠加 → 4 条红；`setVfxOverride` 用合并视图当基底 → `manual-table-stays-minimal` 红；
  摘掉重置钩子 → `factory-reset-clears-intensity` 红。
- **顺手修掉的门禁假阳性**：`module-reachability` 的 import 正则用 `[\s\S]*?` 会把
  **副作用 import 整条吃掉**（`import 'x.js';` 后面紧跟一条 `from` import 时懒匹配越界），
  于是 `utils/numberStepper.js` 被误报成影子模块、不可达数 4→5。已抽成
  `scripts/audits/lib/import-scan.mjs` 并补 `tests/js/test_module_reachability.js` 6 例钉住。

---

## 二、观感与个性化

### 7. 专注模式（只留歌词）· ✅ 已完成（2026-09-26）
- **落地形态**：一个键把顶栏图标组、底栏控制条、播放信息列全部淡出，只剩歌词和背景；
  鼠标/按键静止 N 秒（默认 4，1~60 可调）自动进入，动一下回来。代码
  `app/282-zen-mode.js` + `styles/zen.css`，隐藏范围是 token 化的
  `<html data-zen-scope="top bottom info …">`，逐 token 一条 CSS 规则。
- **设计上最重要的两点**：① 与视图模式**正交**——专注态是 `#ariaRoot` 上的 `is-zen`，
  不新增 `view-*`、不改 220 的 `switchView`，所以「PV 模式 + 专注」这种组合天然成立；
  ② 静止判定用「活动事件 + 单发 setTimeout」而非常驻 interval，退出后立即重新武装。
- **偏好与键位落位**：`appSettings.interface.zen`（约束 11 的规避法：只有 `interface` 全量展开）；
  开关键存 `appSettings.shortcuts.zen`，但**不在** `DEFAULT_SHORTCUTS` 里声明——默认值 `'z'` 是
  分片内常量兜底，重绑时按 220 同款策略「撞键就拒绝写入、不改任何已有绑定」。
  所以 220 那张可配置快捷键表里**看不到** zen，设置面板里改键走 282 自己的 chip。
- **2026-09-27 修掉的「功能看起来不存在」**（用户实测：开了也不会隐藏任何控件）。两个原因叠在
  一起，少修一个都还是坏的：
  ① 开关显示的是 `enabled` **偏好**而不是**当前是否专注**，而 `enabled` 默认 true（为了让 Z 键
    开箱可用）→ 一开机开关就是亮的，用户点它 = 关掉 = 屏幕什么都不变；
  ② 就算改成「点亮就进入」也没用：**设置面板本身**在 `MODAL_SELECTOR`（有弹窗开着就不进入）里，
    于是 `enterZen` 当场拒绝，而关掉面板后又没有任何东西再触发（自动进入默认是关的）。
  现在：开关 = 「进入 / 退出专注」（显示 `_zen`，任何入口都回写显示），被弹窗挡住时记下待进入
  意图、用 MutationObserver 等面板关掉再进。回归 `tests/test_zen_mode_ui.py` 13 例
  （含「设置面板开着时点开关 → 关掉面板后自动进入」这条主链路；变异验证：摘掉进入逻辑 → 3 条红）。

### 8. 视觉模式自动导演 · 成本 M · ★★★★
- **用户感知**：不再需要手动切模式——按段落情绪或每 N 首自动换视觉模式（副歌进 PV、
  间奏进隧道、慢歌进活字），有惊喜感且完全不用学习。
- **已有基础**：这块地基非常厚——AI 情绪分析（`core/aiAnalyzer.js`）、段落情绪分池
  （`core/lyricSceneGrouper.js`、`core/pvEngine/shotProfiles.js`）、60 版式轮换、
  `core/themeEngine.js`。缺的只是一个"导演"策略层 + 一个开关。
- **风险**：切换时机与淡入淡出要克制，否则像电视购物。建议默认只在"用户 30 秒无操作"时切。

### 9. 视觉配方：保存 / 命名 / 分享码 · ✅ 已完成（2026-09-26）
- **落地形态**：右上角入口按钮 + 自建毛玻璃面板（列表 / 重命名 / 覆盖 / 删除 / 应用 /
  分享码 / 导入分享码）。编解码 + 白名单 + 校验在 `core/vfxRecipe.js`（纯逻辑，
  `tests/js/test_vfx_recipe.js` 覆盖），UI 在 `app/290-vfx-recipe.js`。
  2026-09-26 按用户要求精简过一轮：顶部两按钮与「配方包含哪些设置」说明区移除，
  「当前外观」分享码常显，创建配方只剩「导入分享码」一条路，已有配方用「覆盖」更新。
- **两个踩过的点**（写在分片头，动这块前必读）：① 应用配方**不能**调 `applyAllSettings`——
  它会顺带把音量拉回 `initialVolume`、把播放模式/倍速拉回默认，用户点一下音量跳了是事故；
  ② 换视觉模式没有导出函数（220 的 `switchView` 关在 IIFE 里），走的是「点 `.view-mode-card`」
  这条与人手点完全相同的路，连带引擎装配、localStorage 记忆、设置分段一起带上。

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

### 13. 长按 2× 临时加速 · ✅ 已完成（2026-09-26）
- **落地形态**：长按**空格键位置的播放按钮**或 `x` 键临时提速，松手回原速；反馈复用现有
  提示条（`setHint` + `showSettingsHint`），并在 `html#ariaRoot` 挂 `is-tempo-boost` 供样式消费，
  **没有新造浮层**。代码 `core/tempoBoost.js`（状态机 + 所有「恢复原速」的路径）+
  `app/286-tempo-boost.js`（只做接线，注入 85 的 `applyPlaybackRate` / `applyPreservesPitch`）。
- **两个决定**：① 长按结束后**吃掉那一次 click**，否则「长按完顺手把歌暂停了」；
  ② 默认键选 `x` 是因为 Space/方向/F2/F3/f/l/m 已绑，Shift 属歌单多选、Ctrl 属逐段跳转、
  T 属双语循环（键位冲突检测本身在 220 的快捷键体系里，不在下面的测试里）。
- **已验证**：`tests/js/test_tempo_boost.js` 16 例钉的是「恢复原速的**每一条**路径」——
  `window blur`、`visibilitychange`、`audio pause`、切歌三事件、`pagehide`，以及事件一个都没
  发出来时靠 `document.hasFocus()` 现值的看门狗兜底；外加「与手动倍速是**乘法**叠加」
  「封顶在 maxRate」「切歌后手还按着也不会被后续 keyup 反吊回加速态」。
- **分层**：`core` 不 import `app/*`，倍速能力由分片注入给 core——这是项目分层约定，不是绕弯。

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
- **2026-09-26 补的角标状态机**（用户反馈「取链时显示的是取链失败，而不是正在获取」）：
  `describeBadge()` 从不完整的 trace 变成四态——`正在获取…`（begin 了但还没命中）/
  `重试中 n/m…`（`markResolveRetry`）/ `取链失败` / 命中详情；且 `loadOnlineSong` 的两条
  early-return 必须调 `clearResolveTrace()`，否则角标会一直挂着**上一首**的终态。
  同轮把「走哪个平台」的判定收进 `services/playSource.js` 的一张别名表 +
  `resolveSourceOf(songInfo, fallbackSource)`，修掉「用全局 `currentSource` 决定分支」
  导致的「未知歌曲 / 加载慢 / 记两遍历史」（AGENTS.md 约束 19）。
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

### 17. 手机遥控器视图 · ✅ 已完成（2026-09-26）
- **落地形态**：`web/remote.html` 是专为手掌做的遥控页（大封面、大进度、上下曲、音量、队列），
  主界面**看不出有这个功能**——刻意如此，入口只在手机页。服务端侧 `app/291-phone-remote.js`
  推状态 / 取指令，总线是 `remote_bus.py`（纯标准库），`server.py` 把 `/api/remote/*` 转给它。
- **★ 为什么是 HTTP 总线而不是照抄桌面歌词的 localStorage 通道**：桌面歌词窗口与主窗同源，
  `localStorage + storage` 事件天然可达；手机是另一台设备上的另一个浏览器
  （origin `http://<局域网IP>:8001`），与 `http://localhost:8001` **不共享任何 web storage**——
  跨设备用 storage 物理上不成立。总线契约（谁写谁读、只在变化时推、接收端本地外推进度、字段命名）
  仍与 `250-desktop-lyrics.js` 保持一致。
- **已验证**：`tests/test_phone_remote.py` 33 例，**故意用两个不同 origin**（主窗 localhost、
  手机页 127.0.0.1）——哪天有人把同步改回 storage 方案会立刻红。覆盖状态同步、逐条控制生效、
  断线可见（「主窗未响应」/「已断开」+ 控件置灰，不静默失效）、队列渲染走 `esc()`。
- **注意**：`/proxy` 的 Origin 白名单需要显式加入局域网地址（AGENTS.md 关键约定），
  否则手机上 AI 与部分接口会 403。

### 18. 窗口不可见时自动轻量 · ✅ 已完成（2026-09-26，有已知缺口）
- **落地形态**：`core/backgroundThrottle.js`（分级判定 + 协调：`TIER_HIDDEN` / `TIER_IDLE`，
  信号源是 `visibilitychange` + `window blur/focus` + `document.hasFocus()`）+
  `app/287-bg-throttle.js`（把每条绘制循环翻译成 `get/isBusy/pause/resume` 注册进去）。
  **一行业务逻辑都没写进引擎文件**，共享 rAF 闸（#22）属侵入式重构，本轮刻意不撞车。
- **实测过的外部可停性**（这条是本项目第一次逐条量「能不能从外面停下来」）：
  ✓ 主歌词 rAF（70 导出 `startLyricsLoop/stopLyricsLoop`）、✓ `PVEngine` 摄像机 rAF、
  ✓ `VisualizerManager.activeInstance`（`VisualizerBase` 统一 start/stop）、✓ `previewEngine`。
- **三个已知缺口，动手前必读**：
  ① **桌面歌词开着时主歌词循环不降档**（`skipWhen: desktopLyricsOn`）——`activeLineIndex`/
    `currentTime` 由它推进，停它等于把另一个**可见**窗口冻住；
  ② 两条循环**目前停不了**：`57-wordcloud-camera` 的常驻弹簧 rAF、`60-mobile-dual-page` 的
    逐字进度 rAF，开关都是模块内 `let` / 未导出的 `_mlpRafId`，外面读不到，要等分片补导出；
  ③ `PVBackground` 丝绸 canvas **没有公开停口**，只能掐它自持的 `animId/_silkTimer` 再用私有
    `_startSilkLoop` 重开——已按「缺任一即不动」写，将来它加公开 API 只需替换那两个函数。
- **还缺测试**：`core/backgroundThrottle.js` 目前没有单测（全仓 grep `backgroundThrottle` 在
  `tests/` 命中 0）。分级判定与「恢复时不要复活本来就没跑的循环」这两条最值得钉住。

### 19. 歌词屏保 / 氛围模式 · 成本 M · ★★
- **用户感知**：没有播放时，屏幕上缓慢浮现常听歌曲的歌词金句，把播放器变成房间的一部分。
- **已有基础**：最近播放与统计已落盘（`recordPlayStats` / `getRecentHistory`）、
  九套渲染模式全部可复用，只需要一个"无操作 → 随机取句 → 用轻模式渲染"的调度层。

---

## 五、需要你先决策的（不是纯加法）

### 20. 逐字兜底：没有时间戳也做逐字 · ✅ 已完成（2026-09-26，两级方案）
- **落地形态**（两层，都不在各加载点分别接）：
  ① **摊平**：`parsers/wordTiming.js` 按行时长把只有行级时间戳的歌词合成 `words`，接线点
    唯一——`app/20-lyrics-render.js` 的 `renderLyrics` 入口，23 个调用点一次覆盖，
    `globalThis.lyrics` 一起补齐（桌面歌词/PV/词云/手机远端全部受益）；
  ② **频谱对齐**：`core/wordAligner.js`（纯函数）用音频包络把每个字起点拉到真实发声处，
    `services/wordAlign.js` 负责 WebAudio 解码 + 缓存 + 回填，结果按「歌曲 × 歌词签名」缓存
    （AGENTS.md 约束 18）。退化路径是设计的一部分：`alignLine` 信息不足时返回 `evenSplit`，
    所以任何情况下都不会比①更差——这条有专门测试钉住。
- **与最初建议的差异**：原写「默认关」，2026-09-26 用户改口径为**默认开**，并做成两个开关
  （`config/wordPerChar.js`）：开关 1「行级歌词按逐字显示」默认开、只对 歌词/默认/词云
  三档生效；开关 2「自动替换为更匹配的逐字歌词」默认关，一开就**压过**开关 1（互锁写在
  `200-settings-panel.js`，判定层 `perCharSynthesisWanted` 也照样成立），门槛是
  `WORD_UPGRADE_MIN_RATE = 0.9` 的**达标行数**而不是均值——均值会被一行错歌词拖过去，
  把一份对不上的词贴上去（`tests/js/test_word_per_char.js` 里有专门一条钉这个选择）。
- **★ 代价必须知道**（AGENTS.md 约束 17）：`line.words.length` 从此**不再能证明真实性**。
  合成行带 `wordTiming:'synthesized'`，任何拿 `words` 判**真值**的代码必须走
  `realWordsOf(line)` / `hasRealWordTiming(lines)`。已收口三处：下载 `.krc`、AI 喂词的
  时长权重、导出前 `stripSyntheticWords`。对齐成功的行反过来要**清掉**合成标记，否则
  ①② 的成果下载和喂 AI 都拿不到。
- **2026-09-27 用户实测三处失效，已修**：
  ① **自动替换从来不触发**——根因在 `lyricMatchRate` 用「按位置逐行比」。同一首《晴天》
    网易云行级版 55 行、酷狗 KRC 版 63 行，开头制作信息条数与顺序都不同，正文整体错一行
    后面**全部**对不上 → 实测只有 0.048 分，永远过不了 0.9 门槛。
    现在改成「先滤掉制作信息行，再做顺序保持的 LCS 配对」，同一对实测 0.962，
    浏览器里真的换上了（`[WordUpgrade] kugou 命中，匹配率 94%`）。
    负例一起钉住：别的歌、只覆盖一段、整份倒序——都仍在门槛下
    （fixture 是真实取样：`tests/fixtures/lyric_pair_qingtian.mjs`）。
  ② **候选源优先序改成「本机自建 vendor 优先」**（用户：不一定是酷狗，QQ 的歌词也很优质），
    `orderWordCandidateSources(candidates, selfhostEnabled)` 纯函数可单测，没自建服务的源不许插队。
  ③ **互锁只做一个方向**：先开自动替换、再开行级逐字，能两个都亮。现在双向互斥
    （`perChar` 的 handler 也会把 `autoUpgrade` 按下去），且判定层口径不变。
  ④ **开关切换要切歌才生效**：`renderLyrics` 会把合成的 words 写回 `globalThis.lyrics`
    （约束 17 的同一份数组），所以「关掉后再渲染一次」数据里仍然全是逐字。
    现在关闭路径先 `stripSyntheticWords()` 再渲染。★ 原来的 E2E 测不到，是因为它每次都
    **重新播种**一份行级歌词——把被污染的数据换掉了；新增的 `toggle_off_clears_words_immediately`
    故意不重播种，用当前这份已被改过的数组测（实测 29 → 0 个 `.word`）。
- **已验证**：`tests/js/test_parsers.js`、`test_word_per_char.js`（18 例，含真实取样回归 3 例）、
  `test_word_aligner.js`（12 例，合成 PCM 用 LCG 保证可复现）、`test_word_align_service.js`、
  `tests/test_word_fallback.py`（15 例）、`tests/test_word_align.py`、`tests/test_word_per_char_ui.py`。
- **为什么不用 stable-whisper/强制对齐**：约束 1 要求后端纯标准库（绿色包，用户机器没有
  Python/Node），而 whisper 要拖 torch + GB 级模型。精度说清楚：**只能定位能量起始、
  认不出音素**，拖腔内部仍按权重摊。

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
- **未完成的接线**（2026-09-26 复扫 `grep -rln probeFrame web/src`）：帧时段的**按引擎分组仍不全**——
  已埋 `70-audio-engine.js`（歌词循环）、`57-wordcloud-camera.js`（弹簧）、`60-mobile-dual-page.js`
  （逐字进度）三处；还缺 `PVEngine.js`、`PVBackground.js`、`DimensionVisualizer.js`、
  `previewEngine.js` 四处。流光隧道**不需要**埋（它的 rAF 已删、改 CSS 动画驱动）。
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

> 2026-09-26 更新：原五条里 #1 睡眠定时器、#2 歌词内搜索、#7 专注模式、#21 诊断页
> 都已落地，剩下的名额按「剩余项里性价比」重排。

1. **共享 rAF 闸 + 后台停帧**（#22）——虚拟机 <10fps 的直接对症药，且是调研结论里唯一
   一条「我们比它差」的性能项。#18 已经把「外面能不能停」量完，缺的是把 5 条循环
   收到一条闸上（含 #18 缺口①②那两条还没导出的）。
2. **renderScale 吸附到 2 次幂面积桶**（#23）——S-M 成本，换的是显存/合成器 tile 的
   台阶式浪费，无显卡设备上收益最直接。
3. **补齐 #18 的测试与两条停不掉的循环**——分级判定目前没有单测，等于给将来留了个
   「改了不生效」的口子。
4. **无缝专辑简化版**（#12：同专辑内关淡入淡出 + 预加载）——不做真 gapless 也有明显收益。
5. **视觉模式插件契约**（#25）——抽 `VisualModeEntry` 之后，#8 自动导演和 #9 配方
   都从 if/else 变成查表，是三条里唯一的「做一次解锁三次」的结构项。
