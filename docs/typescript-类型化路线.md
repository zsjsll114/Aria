# TypeScript 类型化路线（不做 .ts 迁移）

> 2026-10-09 起执行。本文件是路线图，不是待办清单——每一阶段完成后更新「现状」与基线。

## 结论先行

**本项目不迁移 `.ts`、不引入构建步骤。** TypeScript 只作为「类型检查器」消费已写好的
JSDoc 注释，`noEmit`，不产出任何文件。

理由：本仓库的哲学是**源码即运行时**——`web/` 下的 `.js` 被浏览器直接加载，没有打包步骤；
`python server.py` 直接静态服务，Tauri 壳加载的也是同一份源码。迁移 `.ts` 会强制引入一条
构建链（编译、产物、sourcemap、增量缓存），破坏这条哲学与全部部署路径（源码运行、桌面壳、
便携包 `build_portable.bat`）。收益（类型）完全可以在**不迁移**的前提下拿到。

## 现状（2026-10-11，P0–P6 已落地）

- `tsconfig.json`（`checkJs`+`noEmit`）+ `scripts/audits/tsc-ratchet.mjs`（棘轮）让 tsc 跑起来，
  并把它钉进 CI。
- 检查范围（include）：`web/src/types/**/*.d.ts` + `infrastructure/`、`core/`、`services/`、
  `parsers/`、`config/`、`utils/`、`ui/` 各目录顶层的 `*.js`。
- `exclude`：**vendor（第三方浏览器构建）**、**Pixi 视觉引擎**（`core/visualizers/`、
  `core/pvEngine/`、`core/tunnelEngine/`、`previewEngine.js`、`proceduralLayout.js`）、
  以及**影子模块**（`core/audioPlayer.js`，`module-reachability` 已确认「存在但未被接线」）。
  这三类的不一致由各自的门禁跟踪，不属于本棘轮。
  ⚠ `exclude` 只作用于 `include` 的 glob 展开，**对「被 import 的文件」无效**：被源码 import
  的第三方（如 `services/vendor/han-convert/*.mjs`，经 `lyricMatcher.js` 拉入）照样会被检查。
  这类要靠**同目录同名手写 `.d.mts`** 挡（见下「P5」末节）。
- 全局键（`window.xxx` / `globalThis.xxx` / 裸标识符）由 `web/src/types/globals.d.ts` 声明，
  它是**生成物**（源 = `eslint.config.mjs` 的 `PROJECT_GLOBAL_KEYS`，与 no-undef 同一份清单），
  由 `scripts/audits/globals-dts.mjs` 生成，CI 有同步门禁。配套 `types/legacy-prefixed.d.ts`
  是**手写**的（WebKit 前缀 API 与 `module`，lib.dom 不含）。两者都是纯 `.d.ts`，
  **不被任何页面加载，对运行时零影响**。
- **当前基线 = 0**：纳入范围内的全部类型干净（含 `services/`、`parsers/`、`config/`、`utils/`、
  `ui/`、`components/`）。P4 严格度分档与 P5 四档均已落地，且**不再有第三方噪音挂在基线上**
  （原 24 条 vendor 噪音已由 B 方案清除，见下）。

### 清理过程（137 → 0）

| 步骤 | 结果 |
|---|---|
| core 顶层直接纳入（不排除任何东西） | 1090 错误，绝大多数是 vendor/Pixi 的第三方噪音 |
| 加 `globals.d.ts`（全局键声明） | 1090 → 1019 |
| `exclude` vendor + Pixi 视觉引擎 | 1019 → **137**（存量 JSDoc 债） |
| 逐文件修 JSDoc（P2） | 137 → **0** |

P2 修的债主要是三类：`@param {object}` 之后访问属性（补 `@typedef` 具体形状）、
`Element`/`Node`/`unknown` 的类型过宽（收窄或加断言）、以及 non-strict 下无法缩窄的
判别联合（改成「可选属性 + boolean」形式）。全程**只改类型注释，不改执行逻辑**，
每批都跑 `tests/js/*` 全量回归。

## 路线

| 阶段 | 动作 | 目标 | 状态 |
|---|---|---|---|
| **P0** | `tsconfig.json` + `tsc-ratchet.mjs` + CI | 让 tsc 跑起来并被棘轮钉住 | ✅ |
| **P1** | `globals.d.ts`（生成）+ `exclude` 第三方 + `core/` 顶层纳入 | 消缺全局声明噪音、隔离第三方 | ✅ |
| **P2** | 逐个修 `core/` 的存量 JSDoc 债 | 基线归零 | ✅ 基线 0 |
| **P3** | 扩到 `services/`、`parsers/`、`config/`、`utils/` | 覆盖面扩大 | ✅ 基线仍 0 |
| **P3.5** | `app/` 分片 | 最后一块 | ⏸ 暂缓（见下） |
| **P4** | 逐档收紧严格度（见下「P4 分档实测」） | 从「不新增错误」升级到「更强保障」 | ✅ 7 档全开，存量 2890 条已清零 |
| **P5** | 继续收紧：`noUnused*` 与 `noImplicit*`（见下「P5 分档实测」）+ 清除挂在基线上的第三方噪音 | 基线回到「纯 0」，不背任何 vendor 债 | ✅ 4 档已开，基线 0 |
| **P6** | 继续收紧：`noImplicitOverride` / `noUncheckedSideEffectImports` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`（见下「P6 分档实测」） | 同上，仍保持 0 基线 | ✅ 4 档已开（431 条已清零）；仅剩 `noPropertyAccessFromIndexSignature`(533) 待评估 |

### P4 分档实测（2026-10-09）

在已清零的范围内实测每一档的代价：

| 档 | 实测错误数 | 处置 |
|---|---|---|
| `noImplicitThis` | **0** | ✅ 已开 |
| `strictFunctionTypes` | **0** | ✅ 已开 |
| `strictBindCallApply` | **0** | ✅ 已开 |
| `alwaysStrict` | **0** | ✅ 已开 |
| `useUnknownInCatchVariables` | **51 → 0** | ✅ **已完成**（2026-10-10）：`catch (/** @type {any} */ e)` 注解被 TS 接受，批量应用到 12 个文件的所有 catch 声明 |
| `strictNullChecks` | **581 → 0** | ✅ **已完成**（2026-10-10 同日清零）。主要手段：① 模块级 `let x = null` 句柄补 JSDoc（TS 会把初值 `null` 推断成 `null` 型，缩窄后变 `never`，污染整条使用链）；② `state.js` 标索引类型（单个 `audioCtx: null` 曾放大上百条）；③ 返回 `undefined` 的工厂函数标清返回类型；④ 顺带修掉 1 处真实瑕疵（`tempoBoost.bind` 失败时返回空函数 → 改为 `null`，让调用方的 `if (un)` 不再是恒真） |
| `noImplicitAny` | **2258 → 0** | ✅ **已完成**（2026-10-11）：主体是 TS7006/T7005（隐式 any 参数/变量），逐文件补 JSDoc 注解。高频手法：`{Object}`/`{Array}` 改具体形状或 `any[]`、运行期动态键用 `Record<string, any>` 收口、回调密集对象写 `@typedef` |

### P5 分档实测（2026-10-11）

| 档 | 实测错误数 | 处置 |
|---|---|---|
| `noImplicitReturns` | **0** | ✅ 已开（开箱即零成本，本项目无此类疏漏） |
| `noFallthroughCasesInSwitch` | **0** | ✅ 已开（开箱即零成本） |
| `noUnusedLocals` | **18 → 0** | ✅ **已完成**：死变量/死导入直接删。★ 该档**没有** `_` 前缀豁免，只能删，改不动名 |
| `noUnusedParameters` | **9 → 0** | ✅ **已完成**：因签名兼容而有意不读的入参改 `_` 前缀（解构位写 `key: _key`），JSDoc 注明原因 |
| `noUncheckedIndexedAccess` | **431** | ⏸ 单独立项。量级远超此前任何一档（前 5 个文件占 282），不要混进 P5 |

**P5 的两点额外收获**（不只是删代码）：

① `chorusDetector` 的 `fetchError` 是「只赋值、从来没被读」的变量——两个 `catch` 把异常吞进它
却没有任何出口，实质就是静默 catch。按约束 9 一并改为 `logCatch('chorusDetector', e)`，
顺带恢复了失效留痕。
② `enhancedLrcConverter` 的 `wordTagRegex` 是死码：逐字解析实际走两处行内字面量，删掉即消除
「看着定义了、其实没接线」的误读风险。

**第三方 vendor 的隔离（B 方案）**：`services/vendor/han-convert/*.mjs`（13+11 = 24 条第三方噪音，
经 `lyricMatcher.js` 的 import 被拉进检查）此前一直挂在基线上。解法是**手写同名声明**
`services/vendor/han-convert/index.d.mts`——tsc 解析 `'./index.mjs'` 时先剥扩展名、优先命中
`.d.mts`，那份 minified JS 从此不进 `checkJs`。链路用 `--traceResolution` 验证过；声明内容由
**运行时探针**（`import()` 后逐个 `typeof`/`arity` 打印）确认，不照名字猜。
**这是 `exclude` 对「被 import 的文件」无效时唯一有效的隔离手段**，后续给别的 vendor 挡噪音可复用。
代价：升级该 vendor 时若导出面变化，**必须同步 `.d.mts`**（同名的 `.mjs` 不再被检查，
漏改不会在这里报错，只会在调用点报 TS2305）。

### P6 分档实测（2026-10-11）

| 档 | 实测错误数 | 处置 |
|---|---|---|
| `noImplicitOverride` | **0** | ✅ 已开（无「该写 override 没写」的类继承疏漏） |
| `noUncheckedSideEffectImports` | **0** | ✅ 已开 |
| `exactOptionalPropertyTypes` | **9 → 0** | ✅ **已完成** |
| `noUncheckedIndexedAccess` | **431 → 0** | ✅ **已完成**（2026-10-11）：先补热路径行为测试再逐文件清，见下 |
| `noPropertyAccessFromIndexSignature` | **533** | ⏸ 同族大档，一并待评估（主要落在 `equalizer`193 / `dom`91 / `fadeController`61 / `playSource`36） |

**`exactOptionalPropertyTypes` 的 9 条**全是同一形状：把 `T | undefined` 的局部量塞进
`xxx?: T` 的对象字面量——该档区分「属性缺席」与「属性存在但值为 undefined」。修法按
目标类型归属分两种：

- **目标是库类型**（如 `RequestInit`）：改**条件展开**让键真正缺席
  （`...(ctrl ? { signal: ctrl.signal } : {})`）。fetch 对「缺席」与「undefined」行为一致，故零行为变化。
- **目标是自己写的 `@typedef`/`@param`**：说明**声明本身没写实**（调用点确实会传 undefined），
  给可选属性补 `|undefined`，而不是往调用点塞断言。`vfxRecipe` 的 `RecipeErrorItem.code`、
  `RecipeCodedError.errors`、`mvApi.pickQqVidFromSongs` 的 `info` 三个键都属这一类。

#### `noUncheckedIndexedAccess`：431 → 0（2026-10-11 完成）

**开档前的判断**：431 条的构成是 `TS2532`(232) + `TS18048`(120) = **352 条索引取值**，其余是
它的下游传染（`TS2345` 53 / `TS2322` 18）。头部高度集中：`chorusDetector`(154) / `wordAligner`(39) /
`vfxRecipe`(34) / `yrcParser`(31) / `lyricMerger`(24)。

用探针（临时 `.js` + `--ignoreConfig` 单跑）实测该档的判定边界：

| 写法 | 是否被豁免 |
|---|---|
| `for (i=0; i<arr.length; i++) arr[i]` | **否** —— TS 不认循环边界 |
| `Float32Array` 索引读取 | **否** —— 连定长、零初始化的 TypedArray 也被加上 `undefined` |
| `arr[arr.length - 1]` | 否 |
| `/** @type {number} */ (…)` 断言 | 可以收窄（唯一低风险手段） |
| 元组 + rest `[number, ...number[]]` | 是（但不能套在 Float32Array 上，且语义撒谎：断言「长度 ≥ 1」） |

于是 `chorusDetector` 里 `Math.sqrt(re[b] * re[b] + im[b] * im[b])`、`bands[bandIdx] += mag`
这类**下标由循环边界保证界内**的代码也各吃 2~3 条误报；而 `.js` 里 TS 的 `!` 非空断言是非法语法，
只能塞 JSDoc 断言。即：约 350 处改动落在仓库最热的数值代码上。

**先补测试再动**（否则等于在没有安全网的 DSP 热路径上连改 300+ 处）：新增
`test_chorus_detector.js`(13) / `test_color_mix.js`(10) / `test_lyric_scene_grouper.js`(12) /
`test_local_music_manager.js`(8)，把「有错误但无测试覆盖」的缺口从 24 条补到 0
（JS 测试数 986 → 1038）。写测试本身还捞出三个真东西：`chorusDetector` 的覆盖率封顶带
`length > 1` 守卫（单段时不生效）、`localMusicManager` 的分隔守卫不判首段非空、以及
`settingsNav` 的真实不同步隐患（见下）。

**清账手法**（按性价比排序，后两条是本轮最有价值的经验）：

1. **在源头把「可能 undefined」变成「确定值」**——`yrcParser` 的 `const body = lineMatch[3]`
   类型是 `string | undefined`，一处收口成 `|| ''` 消掉下游 10 条判空；`mvSync` 的
   `const best = ranked[0]` 同理，一处断言消掉 8 条。
2. **把 `number[]` 返回类型改成元组**——`colorUtils` 的 `hexToRgb`/`rgbToHsl`/`hslToRgb`
   改成 `[number, number, number]` 后，所有 `const [r, g, b] = …` 解构点立刻确定（6 条一并消失）。
   元组本来就是这几个函数的正确类型（恒返 3 个元素）。同族坑：数组字面量 `const t = [a, b, c]`
   也必须标元组，否则元素照样带 `undefined`。
3. **`arr[arr.length - 1]` 提升为局部量 + 真判空**（`lastAbs`/`lastMg`/`lastFc`），比断言诚实。
4. **真可能 undefined 的用守卫，不用断言**——`HTMLCollection` 索引（DOM 可能在遍历中变动）、
   `settingsNav` 的 `g.items[ii]`（`ii` 来自 DOM 的 `.settings-tab` 数量，与数据项可能不同步；
   该处上方 `nameHit` 早有 `!it ||` 防御，说明这是**真实存在的不一致**，属真隐患）。
5. **形状统一收在文件头 `@typedef`**（`EnergyPoint`/`Segment`/`ChorusSegment`/`FineEnergyPoint`/
   `EnergySeg`/`YrcMarker`/`WordSpan`），断言写得短，且把隐含形状变成成文契约。
6. **重复表达式抽成两行局部函数**（`labelOf`/`labelOf2`/`atE`/`tAt`/`b64At`），避免反复断言。

**⚠ 本轮踩到的两个坑（后续改这类代码必看）**：

- **`var` 不隔离作用域**。在 `_identifyChorus` 里新加 `var sp` / `var seg`，与细化循环里既有的
  同名 `var` 相遇 → 直接产出 7 条新错（"Subsequent variable declarations must have the same type"
  + 一串级联）。新增局部量必须避开函数内既有的 `var` 名。
- **块注释里不能出现 JSDoc 的结束定界符**。往 `tsconfig.json` 的 `/* … */` 注释里写 JSDoc 断言示例，
  会把注释提前闭合、整份 tsconfig 变成非法 JSON，**tsc 转而忽略配置去扫全仓**——表现为错误数
  从一个量级跳到数千条、且来源全是 `scratch/`、`src-tauri/target/` 等本不该纳入的目录。
  这个失败模式极具误导性，已在 tsconfig 注释里就地记下。

`noPropertyAccessFromIndexSignature` 仍是唯一未开档（533 条）。它与本档同族但性质不同：
修法是 `obj.foo` → `obj['foo']`，主要落在 `equalizer`193 / `dom`91 / `fadeController`61 /
`playSource`36，留待单独评估。

**推进原则（P4–P6 全程遵守，已验证有效）**：一次只开一档，修完把基线回到 0 再开下一档
——而不是一次性全开把 0 基线顶到几百上千条存量债（那等于让棘轮替存量债务背书，
与「保持 0 基线」的强信号冲突）。P4/P5/P6 共 14 档即按此推进，**全程基线未离开过 0**。

事后回看顺序也是对的：`strictNullChecks` 优先（价值最高；581 条里前 2 个文件占 208，
先啃头部性价比最高），`noImplicitAny` 放最后（纯工作量，无需判断）。
`noUncheckedIndexedAccess` 同理——431 条里前 5 个文件占 282，按「头部优先」推进最省力。

`core/visualizers/`（104 文件）与 `core/pvEngine/`、`tunnelEngine/` 体量大、第三方移植成分高，
放在最后单独评估，可能与主线分开维护 include/exclude。

### 为什么 `app/` 暂缓

app 分片经 import 链拉入 **Pixi**（`web/vendor/pixi/pixi.mjs`，第三方打包产物），纳入后
立刻产生 **706 条**第三方噪音 + 111 条视觉引擎噪音（实测总 1826 条）。TS 的 `exclude` 对
「被 import 的文件」无效（只作用于 `include` 的 glob 展开），所以隔离第三方的唯一办法是
**不 include 触发它的分片**。待 Pixi 有可用的类型声明（或视觉引擎单独处理）后再纳入。

## 明确不做的事

- ✗ 迁移 `.ts` 源文件（破坏「源码即运行时」）。
- ✗ 引入打包器 / `ts-loader` / 任何构建步骤。
- ✗ 用 `tsc` 生成 `.d.ts` 产物（`globals.d.ts` 是手写声明源，不是 `.ts` 编译出来的）。
- ✗ 「必须 0 错误才能合并」——用棘轮，允许存量债务，只禁止新增（现在存量已是 0）。
- ✗ 把错误当 warning 忽略（`noEmit` 下 tsc 退出码就是唯一判据，棘轮据此红/绿）。

## 落地方式

```bash
npm run typecheck                                  # 本地：tsc --noEmit
node scripts/audits/tsc-ratchet.mjs                # 看当前错误数 vs 基线
node scripts/audits/tsc-ratchet.mjs --check        # CI 里跑的那条：超出基线即红
node scripts/audits/tsc-ratchet.mjs --update       # 改 include/exclude 后，人工确认再抬高基线

node scripts/audits/globals-dts.mjs --write        # 改了 PROJECT_GLOBAL_KEYS 后重新生成 globals.d.ts
node scripts/audits/globals-dts.mjs --check        # CI 里跑的那条：生成物与清单不同步即红
```

基线文件：`scripts/audits/tsc-baseline.json`（`errors` + `scope` + `exclude` + 更新日期）。

## 与现有约束体系的关系

- 这份路线解决 `AGENTS.md` 约束 18「JSDoc 类型注释是活的」。
- 与配置键门禁（`settings-contract.mjs`）、页面 URL 门禁（`localhost-origin.mjs`）同属
  「把靠人记的规则变成跑 CI 就红」这一族。
·