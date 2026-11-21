# 第三方许可与来源声明（THIRD_PARTY_NOTICES）

本项目的整体许可为 **AGPL-3.0-only**（见 `LICENSE`）。本文列出**被引入的第三方代码**

及其许可证与版权人。新增任何第三方代码时，必须在此登记并在文件头保留署名。


## 1. chthollyphile/folia-major

- 上游地址：<https://github.com/chthollyphile/folia-major>
- 许可证：**GNU Affero General Public License v3.0（AGPL-3.0）**
- 版权人：chthollyphile and contributors（见上游 `CONTRIBUTORS.md`）
- 引入方式：**逐行保真机械移植**（仅删除 TypeScript 类型标注，不改逻辑/数值/分支），
  以及少量"对齐上游实现/借鉴上游美学"的重写（`shapeField.js`、`PVDecorations.js`、
  `mondrianTemplates.js`）。
- 涉及文件：**96 个**（每个文件首行均有署名行）。按目录分布：

  - `web/src/core/visualizers/sonnet/` —— 46 个
  - `web/src/core/visualizers/tempera/` —— 24 个
  - `web/src/core/visualizers/tempera/compositions/` —— 15 个
  - `web/src/core/visualizers/` —— 3 个
  - `web/src/utils/lyrics/` —— 3 个
  - `web/src/utils/` —— 2 个
  - `web/src/core/pvEngine/` —— 1 个
  - `web/src/core/` —— 1 个
  - `web/src/core/tunnelEngine/` —— 1 个

完整清单：

- `web/src/core/pvEngine/PVDecorations.js`
- `web/src/core/shapeField.js`
- `web/src/core/tunnelEngine/mondrianTemplates.js`
- `web/src/core/visualizers/pixiDisplayResources.js`
- `web/src/core/visualizers/pixiTextureBudget.js`
- `web/src/core/visualizers/sonnet/SonnetEngine.js`
- `web/src/core/visualizers/sonnet/sonnetAdditionalShotMg.js`
- `web/src/core/visualizers/sonnet/sonnetAnimatedGraphics.js`
- `web/src/core/visualizers/sonnet/sonnetBackgroundDecor.js`
- `web/src/core/visualizers/sonnet/sonnetBackgroundMgVariants.js`
- `web/src/core/visualizers/sonnet/sonnetCameraTracking.js`
- `web/src/core/visualizers/sonnet/sonnetCredits.js`
- `web/src/core/visualizers/sonnet/sonnetExtendedShotMg.js`
- `web/src/core/visualizers/sonnet/sonnetFixedGeoVariants.js`
- `web/src/core/visualizers/sonnet/sonnetFrameDecor.js`
- `web/src/core/visualizers/sonnet/sonnetFrameOverlay.js`
- `web/src/core/visualizers/sonnet/sonnetGlitchFilter.js`
- `web/src/core/visualizers/sonnet/sonnetGuides.js`
- `web/src/core/visualizers/sonnet/sonnetIcons.js`
- `web/src/core/visualizers/sonnet/sonnetLensFilter.js`
- `web/src/core/visualizers/sonnet/sonnetMotion.js`
- `web/src/core/visualizers/sonnet/sonnetOpenFrameShotMg.js`
- `web/src/core/visualizers/sonnet/sonnetOutroBlur.js`
- `web/src/core/visualizers/sonnet/sonnetPostProcess.js`
- `web/src/core/visualizers/sonnet/sonnetPosterBlocksLayout.js`
- `web/src/core/visualizers/sonnet/sonnetPrintFilters.js`
- `web/src/core/visualizers/sonnet/sonnetProgram.js`
- `web/src/core/visualizers/sonnet/sonnetRandom.js`
- `web/src/core/visualizers/sonnet/sonnetShotFlowLayouts.js`
- `web/src/core/visualizers/sonnet/sonnetShotFrame.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgArchitecture.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgBotanical.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgCelestial.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgCraft.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgFlora.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgFull.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgKinetic.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgLandscape.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgMarine.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgMusic.js`
- `web/src/core/visualizers/sonnet/sonnetShotMgViewport.js`
- `web/src/core/visualizers/sonnet/sonnetSpatialMgGeometry.js`
- `web/src/core/visualizers/sonnet/sonnetStaffNotation.js`
- `web/src/core/visualizers/sonnet/sonnetStaffView.js`
- `web/src/core/visualizers/sonnet/sonnetTextFixedGeo.js`
- `web/src/core/visualizers/sonnet/sonnetTextViewBuilder.js`
- `web/src/core/visualizers/sonnet/sonnetThemedShotMg.js`
- `web/src/core/visualizers/sonnet/sonnetThemedShotMgPrimitives.js`
- `web/src/core/visualizers/sonnet/sonnetTypography.js`
- `web/src/core/visualizers/sonnet/sonnetTypographyLayout.js`
- `web/src/core/visualizers/sonnet/sonnetTypographyRoles.js`
- `web/src/core/visualizers/tempera/compositions/temperaApertureCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaBandCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaCharmCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaCinemaCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaCorridorCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaCutout.js`
- `web/src/core/visualizers/tempera/compositions/temperaFrameCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaMonogatariCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaMonolithCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaMonolithKit.js`
- `web/src/core/visualizers/tempera/compositions/temperaPosterCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaSignalCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaSparseCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaSplitCompositions.js`
- `web/src/core/visualizers/tempera/compositions/temperaTerrainCompositions.js`
- `web/src/core/visualizers/tempera/createTemperaPixiRuntime.js`
- `web/src/core/visualizers/tempera/temperaBlocks.js`
- `web/src/core/visualizers/tempera/temperaCamera.js`
- `web/src/core/visualizers/tempera/temperaCompositions.js`
- `web/src/core/visualizers/tempera/temperaCurves.js`
- `web/src/core/visualizers/tempera/temperaDifferenceFilter.js`
- `web/src/core/visualizers/tempera/temperaEnterStyles.js`
- `web/src/core/visualizers/tempera/temperaHatch.js`
- `web/src/core/visualizers/tempera/temperaImageLayer.js`
- `web/src/core/visualizers/tempera/temperaLayout.js`
- `web/src/core/visualizers/tempera/temperaMeasure.js`
- `web/src/core/visualizers/tempera/temperaMode.js`
- `web/src/core/visualizers/tempera/temperaMotion.js`
- `web/src/core/visualizers/tempera/temperaMotionEasing.js`
- `web/src/core/visualizers/tempera/temperaPalette.js`
- `web/src/core/visualizers/tempera/temperaProgram.js`
- `web/src/core/visualizers/tempera/temperaRandom.js`
- `web/src/core/visualizers/tempera/temperaSceneBuilder.js`
- `web/src/core/visualizers/tempera/temperaSceneFilters.js`
- `web/src/core/visualizers/tempera/temperaShapes.js`
- `web/src/core/visualizers/tempera/temperaShotProfiles.js`
- `web/src/core/visualizers/tempera/temperaTextView.js`
- `web/src/core/visualizers/tempera/temperaTransitions.js`
- `web/src/core/visualizers/tempera/temperaTypes.js`
- `web/src/core/visualizers/wordColoring.js`
- `web/src/utils/colorMix.js`
- `web/src/utils/fontStacks.js`
- `web/src/utils/lyrics/graphemeTiming.js`
- `web/src/utils/lyrics/renderHints.js`
- `web/src/utils/lyrics/wordSegmentation.js`

## 2. JPV Lyrics Motion Kit

- 上游地址：<https://github.com/donbeeshyvt-jpg/jpv-lyrics-motion-kit>
- 许可证：**GNU Affero General Public License v3.0-only（AGPL-3.0-only）**
  （已核对上游 `LICENSE` 文件与其 `README.md` 的「來源與改作」章节）
- 版权人：donbeeshyvt-jpg
- 上游形态：日系风格文字 PV 动效模板 kit（Remotion 兼容），13 种文字动效 + cover 特效
- 引入方式：**改作（衍生）** —— 具体包括：
  - 确定性随机 `hash01`（`frac(sin(seed)*10000)`）与文字宽度估算 `estimateTextWidth`
    —— 用于 `tunnelEngine/TunnelDirector.js`
  - 逐字入场主题（13 主题）的机制与命名 —— 用于 `tunnelEngine/TunnelAnimations.js`
  - `FumeBackground` 形状场（spark/ring/dia/cross/dot 混排）—— 用于 `pvEngine/PVBackground.js`
  - `Cadenza` 字素三态生命周期（waiting → 光束扫描 → passed 微光）—— 用于 `pvEngine/PVRendering.js`
- 涉及文件：**4 个**：

- `web/src/core/tunnelEngine/TunnelAnimations.js`
- `web/src/core/tunnelEngine/TunnelDirector.js`
- `web/src/core/pvEngine/PVBackground.js`
- `web/src/core/pvEngine/PVRendering.js`

> 注：JPV Lyrics Motion Kit 自己的 `THIRD_PARTY_NOTICES.md` 声明其**最初 6 种文字动效参考了
> chthollyphile/folia-major** —— 本项目的两个 AGPL 上游彼此同源，这也解释了为什么隧道/诗镜
> 两处的动效语汇相近。

## 3. 852wa/JIZURA

- 上游地址：<https://github.com/852wa/JIZURA>
- 许可证：**MIT License**
- 版权人：hakoniwa（`Copyright (c) 2026 hakoniwa`）
- 引入方式：通过 `scripts/port-jizura.mjs` 将上游引擎（v0.10.1）按逐文件包裹形式搬运至
  `web/src/vendor/jizura/engine/`（保留原始文本与各自文件头 MIT 署名行）；`bootstrap.js`
  及 `web/src/core/visualizers/jizura/` 为本项目的装配与适配层。
- 涉及文件：**39 个**（均位于 `web/src/vendor/jizura/engine/`）：

  - `01_util.js`, `02_fonts.js`, `02b_lang.js`, `03_text.js`, `04_styles.js`,
    `05_anim.js`, `05b_registry.js`, `06_layouts.js`, `07_decor.js`, `08_planner.js`,
    `08b_omakase.js`, `09_render.js`, `10_audio.js`, `11_export.js`, `11p_bgcamB.js`,
    `11p_decor.js`, `11p_decorB.js`, `11p_enter.js`, `11p_enterB.js`, `11p_exit.js`,
    `11p_exitB.js`, `11p_fxB.js`, `11p_horror1.js`, `11p_horror2.js`, `11p_horror3.js`,
    `11p_kinetic1.js`, `11p_kinetic2.js`, `11p_kinetic3.js`, `11p_layoutsA.js`,
    `11p_layoutsB.js`, `11p_layoutsC.js`, `11p_layoutsD.js`, `11p_looks.js`,
    `11p_styles.js`, `11p_treattrans.js`, `11p_typo1.js`, `11p_typo2.js`,
    `11p_typo3.js`, `11q_sets.js`

## 4. 其余前端与着色器依赖

- **`bloc97/Anime4K` v4.0**（**MIT License**，`Copyright (c) 2019-2021 bloc97`）：
  原始 `.glsl` 文件保存在 `scripts/anime4k/`（7 个着色器），由 `scripts/build_anime4k.mjs`
  编译输出至 `web/src/services/mvUpscaleShaders.js`（用于 MV 实时超分）。
- **`kuromoji.js` + `zlib.js`**（**Apache-2.0 / MIT**）：
  `web/src/vendor/kuromoji/kuromoji.js`（日文歌词按需分词，含 MIT 协议的 `zlib.js`
  解压实现，词典由 `scripts/vendor-kuromoji-dict.bat` 同步）。
- **`segmentit`**（`web/src/vendor/segmentit/segmentit.js`）与 **`han-convert`**
  （`web/src/services/vendor/han-convert/`，`chinese-simple2traditional` 浏览器构建）。

## 待办（需人工确认）

- `web/src/app/160-text-normalize.js` 注释提到"借鉴 JiBA 机制"（iTunes 跨 storefront 查名 +
  ISRC 缓存），**上游项目与许可证未确认**，未列入上表；确认后必须登记，否则应改写为独立实现。
- `scratch/folia-major/`、`scratch/folia-src/`、`scratch/jpv-kit/`、`scratch/jizura/` 是本地比对用的上游副本，
  **不得进入发布物**。

## 变更记录

- 2026-10-06：项目由 MIT 整体改为 AGPL-3.0-only；为 folia-major（90 个文件）与
  JPV Lyrics Motion Kit（4 个文件）补署名。此前仓库仅有零散注释、无版权声明。
- 2026-10-06：JPV 条目一度因"搜不到该项目"被当作误标，后经用户提供地址
  （<https://github.com/donbeeshyvt-jpg/jpv-lyrics-motion-kit>）核实**确为真实 AGPL-3.0 上游**，
  署名已恢复并补全（并新发现 `PVBackground.js`、`PVRendering.js` 两个漏署名文件）。
- 2026-11-21：补齐 folia-major 后续新增与重移植的 6 个 `sonnet/` 文件（总计 90 → 96 个）；
  新增 `852wa/JIZURA`（MIT，39 个引擎模块）及 `bloc97/Anime4K`、`kuromoji.js`、
  `segmentit`、`han-convert` 等第三方组件说明。
