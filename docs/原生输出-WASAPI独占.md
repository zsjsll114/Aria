# 原生输出线：WASAPI 独占（实现记录）

> 目标：让「比特完美」成为可能——声音绕过 Windows 共享混音器，直接以独占流
> 送给声卡。WebView2 做不到（详见 `src-tauri/audio/src/lib.rs` 文件头），
> 所以整条播放引擎搬到了 Rust（crate `aria-audio`）。

## 一、分层与文件地图

```
src-tauri/audio/                    独立 crate（不依赖 Tauri，可用 audio-probe 单跑）
  src/lib.rs        时钟契约 / 进度
  src/source.rs     字节从哪来：本地文件 / 本机后端流代理
  src/decoder.rs    symphonia 解码 → 交错 f32 立体声
  src/ring.rs       解码 ↔ 输出 的非阻塞帧队列
  src/output.rs     WASAPI 共享 / 独占（格式协商、时序、消费体检都在这里）
  src/engine.rs     命令机 + 时钟（frames_written − device_padding）+ 代际（gen）
  src/dsp/eq.rs     10 段 biquad + preamp
  src/bin/audio_probe.rs   脱离 WebView2 的验证入口（play / eq / http / formats / diag）

src-tauri/src/native_audio.rs       IPC 契约（DTO + src 翻译，一行 DSP 都不写）
src-tauri/src/lib.rs                manage(NativeAudioState) + generate_handler 注册
src-tauri/build.rs                  AppManifest::commands([...]) ← 必须与 handler 同步
src-tauri/tauri.conf.json           allow-native-audio-* 权限（两个 capability 都要加）

web/src/core/nativeBridge.js        带超时 + 可用性探测的 invoke 收口
web/src/core/nativeDeck.js          把引擎伪装成 <audio> 元素（鸭子类型）
web/src/app/298-native-output.js    开关、体检、顶替/还原、设备改道
web/src/core/dualDeck.js            replaceActiveDeck()：常驻监听成对搬运
web/src/app/20-lyrics-render.js     setActiveAudio()：app 层语义入口
web/src/app/296-audio-output.js     「输出设备」下拉的双后端改道
web/src/app/96-automix.js           isEnabled 闸门：原生接管期间让位
```

## 二、三个必须遵守的契约

### 1. 时钟：20Hz 取、每帧插值、不要逐帧 invoke

引擎**不推送**，是前端以 50ms 来取 `native_audio_snapshot`；`nativeDeck` 缓存
`positionSec` 与该次取到的墙钟时刻，rAF 里读 `currentTime` 时做线性外推，
每次新快照到达就重锚定。逐帧 invoke 会把主线程压满，逐字高亮立刻开始抖。

### 2. 顶替的是「活跃 deck」，不是「audio 变量」

30 个分片读 `20-lyrics-render` 的 `audio` live binding，但**常驻监听**
（play/pause/ended/timeupdate…）是挂在元素**实例**上的。只改绑定不改监听，
表现是「界面正常、按钮全没反应」。所以统一走
`setActiveAudio()` → `dualDeck.replaceActiveDeck()` 成对搬运 + 通知 `onRoleSwap`。

### 3. 打开独占开关前必须做「端到端体检」

只看 `IsFormatSupported` 会给出**乐观的错答案**（见 §3）。放行开关前要问
`native_audio_check_exclusive`：真开一次设备、启动、确认端点开始消费缓冲。
体检预算 `clamp(缓冲时长 × 4, 400, 3000) ms`（**下限 400ms 是踩过坑定的**，
见 §3.1），所以走 async 命令 + `spawn_blocking`，不能堵消息循环。

### 4. 关掉开关要**交还设备**，不是「改回共享就算了」

引擎一旦打开过输出就一直持有端点，而 WASAPI 独占要求端点空闲 ——
不交还的话用户第二次打开开关必然撞 `AUDCLNT_E_DEVICE_IN_USE`
（表现是「同一个开关第二次就点不亮了」）。所以 `native_audio_release_output`
会停掉输出线程 + 丢掉队列 + 清掉当前曲目（`Cmd::ReleaseOutput`）。
顺带的好处：用户不用原生输出时，设备真正空出来给别的程序。

> 同一处的另一半：`Cmd::SetOutput` 必须**先写 `pending_output` 再 `restart_output`**。
> 反过来写的话 `restart_output` 读到的还是旧配置，本次改动要等下一首 Load 才生效
> ——「切了输出设备却听不出任何变化」就是这么来的。

## 三、本机实测：独占端点不消费缓冲（重要）

这台机器上，独占模式的失败形态**不是**「格式被拒」。以下是**两轮**实测的合并结论，
第二轮（2026-10-03 下午）把第一轮的可疑之处全部重做了。

### 3.1 第一轮的结论为什么不足信

初版 `verify_streaming()` 的预算写成 `clamp(缓冲时长 × 3, 80, 600)` ms，
44.1k / 1024 帧下只有 **80 ms**。而 `audio-probe diag` 当时调用的是自带体检的
`start()`，于是**在 `start` 那一步就直接返回了，后面 6×50ms 的采样一次都没跑到**。
换句话说：第一轮所有「端点不消费」的判定，依据都是一个 80ms 的窗口，
不是观测出来的。端点从空闲唤醒（DMA 起转 / 独占接管 / USB 时钟重锁）完全可以
超过 100ms —— **体检会把自己的设备判成坏设备**，这比漏判更糟。

修法（已落地）：

- 预算改为 `clamp(缓冲时长 × 4, **400**, 3000)` ms，并抽出纯函数
  `verify_budget_ms()` 加单测（这个数字写错不会报错，只会让体检误判）；
- 拆出 `start_unverified()`：diag **自己观测 2 秒 / 20ms 一次**，不再把结论外包给被测对象；
- `Some(0)` = 显式跳过体检，供「用耳朵验」时把设备真开起来（`--no-verify`）。

### 3.2 第二轮：四条独立证据

| 证据 | 手段 | 结果 |
| --- | --- | --- |
| 缓冲是否被消费 | `GetCurrentPadding`，**2 秒 / 98 次采样** | padding 恒等于整块缓冲，`read_ok=98 read_failed=0` |
| 端点时钟是否在走 | `IAudioClock::GetPosition`（**独立于 padding 的通路**） | `clock_freq=44100`，5 秒只推进 **16 帧**（应为 220500）→ 每秒 3 帧 |
| 预填充的音调有没有被播出去 | 预填充 **1kHz 正弦**而非静音 | 时钟只前进 3 帧 ⇒ 预填充那 1024 帧**一帧都没被消费** |
| 写入是否被拒 | 每个周期强制写一次 | 245 次全部 `AUDCLNT_E_BUFFER_TOO_LARGE`（缓冲从来是满的） |

已排除的变量（全部实测）：

| 变量 | 取值范围 | 结果 |
| --- | --- | --- |
| 采样率 | 44.1k / **48k** / 96k / 192k | 全 STALLED（第一轮漏了 48k，这轮补齐） |
| 样本格式 | 自动(f32→s24) / 强制 s16 / 强制 s24 | 全 STALLED |
| 周期 / 缓冲 | auto×2 / 10ms×4 / period=buffer | 全 STALLED |
| 时序 | 轮询 / 事件驱动 | 轮询 STALLED；事件在 `Initialize` 就失败 |
| **硬件卸载声明** | `SetClientProperties(bIsOffload=true)` | `0x88890022` = **`AUDCLNT_E_ENDPOINT_OFFLOAD_NOT_CAPABLE`** → 该端点**不是**卸载端点，此路排除 |
| padding 读数是否撒谎 | 与 `IAudioClock` 交叉验证 | 两者一致，读数是可信的 |
| 共享模式（对照组） | 同上四条证据 | padding 0↔96 正常流动；`clock` 38.4 万单位/秒正常前进 |

→ 判定为**端点/驱动侧问题**，不是代码问题。四条互相独立的证据一致，
且已排除全部软件可调变量。

### 3.3 端点到底是什么（查注册表 + PnP 得到）

```
扬声器 (Senary Audio)   {55f01aa4-…}  state=1 (ACTIVE, 默认渲染端点)
  HDAUDIO\FUNC_01&VEN_14F1&DEV_1F87&SUBSYS_1D053010   ← VEN_14F1 = Conexant
                                                          SUBSYS 1D05 = 机械革命
  oem22.inf : HdAud2021.Common.NTamd64 : 3.48.75.22     ← OEM 打包的 HDA 驱动
  KS pin 名: offloadedrearlineoutwave                    ← 名带 offloaded，但端点声明"非卸载"
  FX 链注册: A-Volute.Nahimic                             ← Nahimic APO 挂在这个端点上
  Disable_SysFx: (未设置) = 音频增强开启
```

同时运行着：`NahimicService`(Automatic) · `Nahimic_Mirroring` 驱动 · `Nahimic3` ·
`NahimicSvc32/64` · `NahimicAPO4Volume` · `SenaryAudioApp.Svc`，
并且存在一个 `扬声器 (Nahimic mirroring device)` 虚拟端点。

**Nahimic 是 WASAPI 独占的知名杀手。** 端点在 FX 链里注册了 Nahimic 的 APO，
而独占模式本应绕过 APO —— OEM 驱动违反这条约定时，典型症状正是
「格式被接受、`Initialize` 成功、DMA 永不启动、全程零报错」。

> 待验证（**需要管理员权限**，当前会话非提权，无法自测）：
> 1. 关掉该端点的「音频增强」（设置 → 系统 → 声音 → 扬声器 → 音频增强 → 关），
>    或 `Disable_SysFx = 1`；
> 2. `Stop-Service NahimicService; sc stop Nahimic_Mirroring` 并结束 Nahimic 进程；
> 3. 重跑 `audio-probe diag --exclusive`。
> 若转为 FLOWING ⇒ 根因确认是 Nahimic/OEM APO 链。以上均可逆（重启或重启服务）。

### 3.4 「独占用不了」时的替代路径：共享原始模式

实测 **`shared 48k` + `AUDCLNT_STREAMOPTIONS_RAW | MATCH_FORMAT` → FLOWING**。
RAW 让音频引擎不对该流做混音 / 音量 / 音效处理，MATCH_FORMAT 把流格式对齐到端点格式
—— 这是**共享模式下最接近比特完美的路径**。

代价（已实测）：RAW 要求流格式等于端点原生格式，本机端点原生是 **48k**，
请求 44.1k 直接 `0x88890008 AUDCLNT_E_UNSUPPORTED_FORMAT`。
也就是说：**RAW 只在端点原生采样率上比特完美**，44.1k 的源仍然需要重采样。

对应开关：`OutputConfig::client_raw` / `client_offload`，探针侧
`--raw`（`audio-probe tone 5 --raw` / `diag --exclusive` 的最后两条组合）。

### 3.5 诊断工具本身踩过的两个坑（都已修）

1. **采样顺序**：循环里「先写入、后读 padding」时，每次读到的都是刚写满的缓冲，
   那个数恒等于缓冲大小 —— 于是无论端点有没有消费都会判成卡死，
   连共享模式（实测播放完全正常）也会被判成 STALLED。把读 padding 提到写入之前即修好。
2. **「读不到」被伪装成「缓冲满」**：`padding_frames()` 原来在读失败时返回 0，
   而 0 会被解读成「缓冲空着、全放完了」，把播放位置顶到最前面。
   现在读失败退回**上次成功值**（`padding_cache`），健康检查改用
   `try_padding_frames()` 把「读不到」当独立故障报出来。
3. **结论不能外包给被测对象**：diag 曾经调用带体检的 `start()`，
   于是体检说不行它就报不行，自己一次都没观测。现在 diag 用 `start_unverified()`
   自己观测 2 秒。

**共同教训：诊断工具有偏差时，它给出的「正确结论」也会一起失去可信度。**
所以每条新结论都要先用一个已知为真的对照组（共享模式）验工具。

代码的处理方式是检测并如实报告：

- `open_exclusive()` 拒绝「缓冲帧数不是周期整数倍」的组合并换参重试；
- `WasapiOutput::start()` 内置 `verify_streaming()`：预填静音 → `Start` →
  在 `verify_budget_ms()` 预算内等 padding 下降；等不到就 `stop_stream()` 后返回
  `AudioError::Busy(...)`，**不会把设备扣在手里**；
- `check_exclusive_usable()` 供设置面板放行前调用，失败时开关拒绝打开；
- `audio-probe diag --exclusive` 把上面每个组合逐个跑一遍，输出 FLOWING / STALLED；
- `audio-probe tone [sec] [--exclusive] [--raw]`：预填充 1kHz 正弦并同时打印
  padding + `IAudioClock`，**用耳朵 + 两条独立读数**把「设备真不行」和
  「读数不可信」分开。

换句话说：在能正常独占的机器上功能完整；在这台机器上开关会**明确告诉你不能开**，
而不是打开后静默无声。

## 四、开启后的能力差（UI 已如实告知）

| 能力 | 原生独占下 | 原因 |
| --- | --- | --- |
| WASAPI 独占 / 共享 | ✅ | 本功能的主目标 |
| 10 段 EQ | ✅（`state.eqInited` 为真时下发；等价于 HTML 侧「开过均衡器面板」） | 引擎侧 `dsp/eq.rs` |
| 音量 / 淡入淡出 | ✅（`volume` 写入按 ~16ms 合并，避免淡变每帧一次 IPC） | — |
| Automix | ❌ 临时让位 | 引擎只有一条 deck，双 deck 交叉是 Phase 2d |
| 变速 / 保音高 | ❌ 按原速播 | 引擎没有 playbackRate 能力；赋值会留警告，不谎报生效 |
| 卡死检测（stallDetector） | 惰性 | 它监听 `stalled/waiting`，引擎不发这些事件；引擎自己有 underrun 计数 |

## 五、偏好存储

`aria_native_audio_exclusive` / `aria_native_audio_device` 走 **localStorage**，
不进 `user_config.json`：独占能力是本机专属的（换台机器、换个声卡完全不同），
塞进会被导出/导入的配置属于数据污染。与 `aria_audio_output_device`、
`aria_eq_custom` 同一条理由。

设备 id 的命名空间也不同（WebView2 `deviceId` vs WASAPI 端点 id），
所以两个键**分开存**；原生模式下「输出设备」下拉的列表与写入目标都由
`298` 提供（经 `Aria.__nativeOutputBackend`），296 只问一句「现在是谁在出声」。

## 六、门禁与验证

- `cargo test -p aria-audio`：40/40（含格式几何、f32→s16/s24 转换的对称与钳位、
  `release_output` 在未加载曲目时的安全性、`verify_budget_ms` 的下限与覆盖）
- `node --test tests/js/test_*.js`：593 条全绿
  （新增 `test_native_deck.js` 13 条 · `test_native_bridge.js` 9 条 ·
  `test_dual_deck.js` 补 4 条 `replaceActiveDeck`）
- `eslint` / `i18n-coverage --check` / `module-reachability --check` /
  `test-registry --check` / `resolve-instrumentation --check` / `motion-audit --check` 全通过
- 真机验证（`src-tauri/audio` 下）：
  - `cargo run --bin audio-probe -- diag` → 共享 FLOWING（对照组）
  - `… -- diag --exclusive` → 本机 9 条组合全 STALLED / 明确报错，附精确原因
  - `… -- tone 5 --raw` → 共享 RAW 时钟正常前进（可听闻 1kHz）
  - `… -- tone 5 --exclusive` → padding 恒满、`IAudioClock` 5 秒仅走 16 帧
  - `… -- play <无损文件> 5` → 共享模式时钟漂移 < 5ms
