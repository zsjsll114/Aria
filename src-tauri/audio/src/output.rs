//! WASAPI 输出层：共享 + 独占两种模式。
//!
//! ## 共享模式
//! 设备格式由系统音频引擎混音，请求 f32 + 源采样率 + 立体声，靠 `autoconvert`
//! 让系统做采样率转换。选这个组合而不是"统一重采样到 48000"的理由：
//!   · 少一个 DSP 环节就少一处失真与一处 bug（重采样器是最难写对的东西之一）；
//!   · 独占模式要的是源采样率**直通**（44100 进、44100 出，bit-perfect），
//!     引擎内部不强制换算采样率这条规则，两条路径才能共用同一套上游代码。
//!   代价是每次换曲若采样率变化需要重建 client —— 换曲本来就有停顿，可接受。
//!
//! ## 独占模式（2026-10-03 落地）
//! 真·bit-perfect 输出。三个本机实测出来的硬事实，实现必须围着它们转：
//!
//! 1. **本机驱动只收整数格式，f32 全被拒**（六个采样率 × 立体声全试过）。
//!    所以独占路径**必须**带 f32 → 整数转换。只请求 f32 然后"打不开就报错"
//!    等于这个功能在本机永远打不开。
//! 2. **采样率必须直通**。独占不做 autoconvert，44.1k 的源就必须以 44100 开设备；
//!    我们**不**替用户重采样（那正好毁掉 bit-perfect 的意义）。开不了就把
//!    错误原样抛给上层，由上层明确告诉用户「这个采样率设备不收」。
//! 3. **独占要用轮询（polling）而不是事件驱动**。事件驱动在部分设备上不支持，
//!    且 Windows 的 USB 音频驱动在事件驱动独占下会爆音（spike 实测）。
//!    —— 注意共享模式的选择正好相反（事件驱动是低延迟首选），别把两条路混起来。
//!
//! `is_supported_exclusive_with_quirks` 把第二个坑（部分驱动只认裸
//! WAVEFORMATEX 而不认 WAVEFORMATEXTENSIBLE、以及 channel mask 挑剔）
//! 一起处理掉了，不要自己写一遍那个两级查询。

use wasapi::{
    AudioClient, AudioClientProperties, AudioRenderClient, DeviceEnumerator, Direction, Handle,
    SampleType, ShareMode, StreamMode, StreamOption, WaveFormat,
};

use crate::error::{AudioError, Result};

/// 输出模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    /// 共享：与其他应用混音，系统做格式转换。默认。
    Shared,
    /// 独占：比特完美、低延迟，但**独占设备期间其他应用全部静音**
    Exclusive,
}

impl OutputMode {
    pub fn label(&self) -> &'static str {
        match self {
            OutputMode::Shared => "shared",
            OutputMode::Exclusive => "exclusive",
        }
    }
}

/// 设备接受的样本格式（决定 `write_f32` 往设备里塞什么字节）。
///
/// ★ 为什么 S24 要单独列：本机驱动接受「32 位容器 + 24 位有效位」，
///   这和「16 位」是两个不同的格式，音质差别可闻。用 S16 兜底虽然能出声，
///   但把 24 位源降成 16 位是**有损**的，能协商到 S24 就不该退到 S16。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputSampleFormat {
    /// 32 位浮点（共享模式固定用这个；独占下不是所有驱动都收）
    F32,
    /// 32 位容器 / 24 位有效位，整数。低位补 0（左对齐），Windows 的通行约定。
    S24In32,
    /// 16 位整数
    S16,
}

impl OutputSampleFormat {
    pub fn label(&self) -> &'static str {
        match self {
            OutputSampleFormat::F32 => "f32",
            OutputSampleFormat::S24In32 => "s24",
            OutputSampleFormat::S16 => "s16",
        }
    }
    /// 每个样本占用的**存储**位数（决定 block align 与字节数）
    pub fn store_bits(&self) -> usize {
        match self {
            OutputSampleFormat::F32 => 32,
            OutputSampleFormat::S24In32 => 32,
            OutputSampleFormat::S16 => 16,
        }
    }
    /// 有效位（24 位存进 32 位容器时 ≠ 存储位）
    pub fn valid_bits(&self) -> usize {
        match self {
            OutputSampleFormat::F32 => 32,
            OutputSampleFormat::S24In32 => 24,
            OutputSampleFormat::S16 => 16,
        }
    }
    pub fn sample_type(&self) -> SampleType {
        match self {
            OutputSampleFormat::F32 => SampleType::Float,
            OutputSampleFormat::S24In32 | OutputSampleFormat::S16 => SampleType::Int,
        }
    }
    pub fn bytes_per_sample(&self) -> usize {
        self.store_bits() / 8
    }
}

/// 一条「设备确实接受」的独占格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExclusiveFormatInfo {
    pub sample_rate: u32,
    pub channels: usize,
    pub format: OutputSampleFormat,
}

/// 输出设备描述（给设置面板的下拉框）。
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    /// WASAPI 端点 id。持久化这个值，而不是设备名（名字可重名、可改）
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// 打开输出流的参数。
#[derive(Debug, Clone)]
pub struct OutputConfig {
    /// None = 跟随系统默认设备
    pub device_id: Option<String>,
    pub mode: OutputMode,
    /// 引擎推给设备的采样率（= 源采样率，不换算）
    pub sample_rate: u32,
    pub channels: usize,
    /// 设备缓冲时长（100ns 单位，注意是 **i64** —— wasapi 的 StreamMode
    /// 就是这个类型，写成 u32 会在构造字面量时报 mismatched types）。
    /// 太短会 underrun，太长会让歌词高亮滞后。
    /// 200_000 = 20ms：低于人耳可感的延迟，又给了足够的调度余量。
    /// 独占模式下这个值被**忽略**：独占必须自己指定 period，见 `open_exclusive`。
    pub buffer_duration_hns: i64,
    /// 独占模式的设备周期（100ns）。None = 自动（用设备默认周期并对齐到整帧）。
    ///
    /// 为什么要暴露它：本机实测存在「Initialize 成功但端点不流动」的驱动
    /// ——周期与缓冲不呈整数倍时，Windows 收下了请求却不推进播放。
    /// 留一个可指定的入口，才能在真机上把参数试出来（`audio-probe diag`）。
    pub exclusive_period_hns: Option<i64>,
    /// 独占缓冲区 = 周期 × 该倍数。默认 2。
    /// 太小（1）留给调度的余量不足，稍有解码抖动就 underrun；
    /// 太大（≥8）会让歌词高亮明显滞后一个缓冲。
    pub exclusive_buffer_periods: i64,
    /// 独占模式**强制**使用的样本格式。None = 自动协商（f32 → s24 → s16）。
    ///
    /// 存在的理由：本机实测存在"驱动报告支持某格式、Initialize 也成功，
    /// 但端点因此永不流动"的情况。留一个能钉死格式的入口，
    /// 才能把"是格式的问题还是设备本身不支持独占"分开
    /// （`audio-probe diag --exclusive` 会逐个格式试）。
    pub exclusive_format: Option<OutputSampleFormat>,
    /// 独占模式改用**事件驱动**时序。
    ///
    /// 默认 false（轮询）——因为 Windows USB 音频驱动在事件驱动独占下会爆音。
    /// 但本机实测有设备"轮询独占不流动"，所以留一条可切换的路：
    /// 排查时两条都试，能立刻把"时序模式的问题"与"设备根本不支持独占"分开。
    /// 注意 crate 的约束：事件驱动独占要求 buffer == period。
    pub exclusive_use_events: bool,
    /// 独占启动后的**端点健康检查预算**（毫秒）。
    ///
    /// - `None`（默认）= 自动：`clamp(缓冲时长 × 4, 400, 3000)`。
    /// - `Some(0)` = **跳过检查**（仅诊断用：要亲耳确认设备到底出不出声时，
    ///   检查会在你听到声音之前就把流掐掉）。
    /// - `Some(n)` = 用 n 毫秒。
    ///
    /// ★ 为什么默认值从 80ms 提到 400ms 起：初版用 `clamp(buf_ms × 3, 80, 600)`，
    ///   44.1k / 1024 帧下只有 **80ms**。端点从空闲唤醒（DMA 起转、独占接管、
    ///   USB 时钟重锁）完全可以超过 100ms——于是**健康检查会把自己的设备判成坏设备**，
    ///   用户看到"独占不能用"，其实只是没等够。宁可启动慢 0.4s，也不要误判。
    pub exclusive_verify_ms: Option<u64>,
    /// 让 `IAudioClient2::SetClientProperties` 声明**硬件卸载流**（`bIsOffload = true`）。
    ///
    /// 存在的理由：本机默认渲染端点的 KS pin 名是 `offloadedrearlineoutwave`
    /// —— 这是一个"硬件音频卸载"pin（给 Modern Standby 省电用的 DSP 直通路径）。
    /// 有些 OEM 驱动只在客户端**声明自己是卸载流**时才去编程 DSP 的缓冲描述符；
    /// 不声明的话 Initialize 返回 S_OK、缓冲几何也正常，但 DMA 永不启动
    /// ——正是本机见到的现象。留这个开关以便真机二分。
    pub client_offload: bool,
    /// 让共享流走**原始模式**（`AUDCLNT_STREAMOPTIONS_RAW | MATCH_FORMAT`）。
    ///
    /// 这是"独占用不了"时**最接近比特完美的替代路径**：RAW 让音频引擎不再对
    /// 该流做混音/音量/音效处理，MATCH_FORMAT 把流格式对齐到端点格式。
    /// 代价：必须放弃 `autoconvert`，采样率要跟端点一致。
    pub client_raw: bool,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            mode: OutputMode::Shared,
            sample_rate: 48000,
            channels: 2,
            buffer_duration_hns: 200_000,
            exclusive_period_hns: None,
            exclusive_buffer_periods: 2,
            exclusive_format: None,
            exclusive_use_events: false,
            exclusive_verify_ms: None,
            client_offload: false,
            client_raw: false,
        }
    }
}

/// 枚举所有可用的**输出**端点。
pub fn list_output_devices() -> Result<Vec<DeviceInfo>> {
    ensure_com();
    let enumerator = DeviceEnumerator::new()?;
    let default_id = enumerator
        .get_default_device(&Direction::Render)
        .ok()
        .and_then(|d| d.get_id().ok());

    let col = enumerator.get_device_collection(&Direction::Render)?;
    let n = col.get_nbr_devices().unwrap_or(0);
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let Ok(dev) = col.get_device_at_index(i) else {
            continue;
        };
        let id = dev.get_id().unwrap_or_default();
        let name = dev
            .get_friendlyname()
            .unwrap_or_else(|_| "<unknown device>".to_string());
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(DeviceInfo {
            id,
            name,
            is_default,
        });
    }
    Ok(out)
}

/// 独占模式的候选格式顺序。**顺序即优先级**，别随手调换：
/// f32 不转换（零损失）→ s24（本机常见的最优）→ s16（有损兜底）。
const EXCLUSIVE_CANDIDATES: [OutputSampleFormat; 3] = [
    OutputSampleFormat::F32,
    OutputSampleFormat::S24In32,
    OutputSampleFormat::S16,
];

/// 100ns 单位 → 帧数。周期与缓冲的整数倍关系全部按帧判定，所以换算必须
/// 只在一个地方做——两处各写一遍迟早会一处四舍五入一处截断。
fn hns_to_frames(hns: i64, rate: u32) -> usize {
    if hns <= 0 || rate == 0 {
        return 0;
    }
    ((hns as f64 * rate as f64 / 10_000_000.0).round()).max(0.0) as usize
}

/// 独占启动健康检查的预算（毫秒）。抽成纯函数是为了能单测——
/// 这个数字错了不会有任何报错，只会让体检误判设备好坏，属于最难查的一类 bug。
///
/// 口径（下限 400ms 是刻意的，见 `OutputConfig::exclusive_verify_ms`）：
/// - `Some(0)` → 0（跳过检查）
/// - `Some(n)` → n
/// - `None`    → `clamp(缓冲时长 × 4, 400, 3000)`
pub fn verify_budget_ms(buffer_frames: u32, sample_rate: u32, override_ms: Option<u64>) -> u64 {
    match override_ms {
        Some(n) => n,
        None => {
            let buf_ms = buffer_frames as f64 * 1000.0 / sample_rate.max(1) as f64;
            (buf_ms * 4.0).clamp(400.0, 3000.0) as u64
        }
    }
}

/// 把 `IAudioClient2` 的客户端属性下发给**即将 Initialize 的那个** client。
///
/// ★ 必须在 `Initialize` **之前**调用（MSDN 硬要求）。crate 的 `set_properties`
///   取 `&self` 并内部 `cast::<IAudioClient2>()`，所以顺序由调用点保证。
/// ★ 两个开关都关时**完全不碰**这个接口：`SetClientProperties` 在部分老驱动上
///   会直接失败，无必要时不该给播放路径多添一个失败点。
/// ★ 硬件卸载（`bIsOffload`）在这台机器上有真实动机：默认渲染端点的 KS pin 名是
///   `offloadedrearlineoutwave`，说明端点绑在卸载 pin 上。有些 OEM 驱动只在
///   客户端**声明自己是卸载流**时才去编程 DSP 的缓冲描述符。
fn apply_client_properties(client: &AudioClient, cfg: &OutputConfig) -> Result<()> {
    if !cfg.client_offload && !cfg.client_raw {
        return Ok(());
    }
    let mut props = AudioClientProperties::new();
    if cfg.client_offload {
        props = props.set_offload(true);
    }
    if cfg.client_raw {
        props = props
            .set_option(StreamOption::Raw)
            .set_option(StreamOption::MatchFormat);
    }
    client
        .set_properties(props)
        .map_err(|e| AudioError::Wasapi(format!("SetClientProperties failed: {}", e)))?;
    Ok(())
}

/// 独占格式协商：按 f32 → s24 → s16 顺序问设备，第一个答应的就用。
///
/// `is_supported_exclusive_with_quirks` 内部会重试裸 WAVEFORMATEX 与多种
/// channel mask（部分驱动只认其中一种）——别自己写那个两级查询。
/// `tried` 只用于把失败原因带上（"三个都试过了"比"不支持"有用得多）。
fn negotiate_exclusive_format(
    client: &AudioClient,
    cfg: &OutputConfig,
    tried: &mut Vec<&'static str>,
) -> Result<(OutputSampleFormat, WaveFormat)> {
    /* 调用方钉死了格式就只试它：自动协商会在"设备接受但端点不流动"的驱动上
       掩盖问题——排查时必须能单独试一个格式。 */
    let candidates: Vec<OutputSampleFormat> = match cfg.exclusive_format {
        Some(f) => vec![f],
        None => EXCLUSIVE_CANDIDATES.to_vec(),
    };
    for fmt in candidates {
        let wf = WaveFormat::new(
            fmt.store_bits(),
            fmt.valid_bits(),
            &fmt.sample_type(),
            cfg.sample_rate as usize,
            cfg.channels,
            None,
        );
        if let Ok(accepted) = client.is_supported_exclusive_with_quirks(&wf) {
            return Ok((fmt, accepted));
        }
        tried.push(fmt.label());
    }
    Err(AudioError::FormatUnsupported(format!(
        "exclusive: device rejects {} Hz / {} ch in all of [{}] \
         (driver likely does not expose this rate for exclusive use)",
        cfg.sample_rate,
        cfg.channels,
        tried.join(", ")
    )))
}

fn device_of(enumerator: &DeviceEnumerator, device_id: Option<&str>) -> Result<wasapi::Device> {
    match device_id {
        Some(id) if !id.is_empty() => enumerator
            .get_device(id)
            .map_err(|e| AudioError::DeviceUnavailable(format!("device {}: {}", id, e))),
        _ => enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| AudioError::DeviceUnavailable(format!("no default device: {}", e))),
    }
}

/// 探测某个设备在**独占模式**下接受哪些格式。
///
/// 给两处用：① 设置面板在用户勾选"独占"前先看看这台机器到底行不行；
/// ② `audio-probe formats` 命令行——这是脱离 WebView2 验证的唯一途径。
///
/// 只探测**恰好这两个参数**（采样率 × 声道）的组合，不做笛卡尔积：
/// 独占的采样率必须是源采样率，探别的采样率没有任何决策价值。
pub fn probe_exclusive_formats(
    device_id: Option<&str>,
    sample_rates: &[u32],
    channels: usize,
) -> Result<Vec<ExclusiveFormatInfo>> {
    ensure_com();
    let enumerator = DeviceEnumerator::new()?;
    let device = device_of(&enumerator, device_id)?;
    /* 只读探测：`is_supported_exclusive_with_quirks` 拿 &self，channel mask 的
       尝试发生在它内部的局部克隆上 —— 这里刻意不加 mut，加了就是误导。 */
    let client = device.get_iaudioclient()?;
    let mut out = Vec::new();
    for &rate in sample_rates {
        if rate == 0 {
            continue;
        }
        for fmt in EXCLUSIVE_CANDIDATES {
            let wf = WaveFormat::new(
                fmt.store_bits(),
                fmt.valid_bits(),
                &fmt.sample_type(),
                rate as usize,
                channels,
                None,
            );
            if client.is_supported_exclusive_with_quirks(&wf).is_ok() {
                out.push(ExclusiveFormatInfo {
                    sample_rate: rate,
                    channels,
                    format: fmt,
                });
            }
        }
    }
    Ok(out)
}

/// COM 初始化。MTA 允许同一对象被任意线程使用，且**必须在使用 COM 的每个线程**
/// 各调一次（重复调用是幂等的，返回 S_FALSE 不算失败）。整个引擎里所有碰
/// WASAPI 的线程（输出线程、设备枚举）都必须先过这一关，否则报
/// `CO_E_NOTINITIALIZED` 且错误信息完全不指向真正原因。
pub fn ensure_com() {
    let hr = wasapi::initialize_mta();
    if hr.is_err() {
        eprintln!(
            "[aria-audio] COM MTA init failed: HRESULT {:#010x}",
            hr.0 as u32
        );
    }
}

/// 输出线程怎么等数据。
///
/// ★ 两种模式的等待方式**相反**，这是 WASAPI 最反直觉的一处：
///   共享 → 事件驱动（所有设备都支持，且是低延迟首选）；
///   独占 → 轮询（事件驱动在部分设备不支持，USB 音频驱动下还会爆音）。
enum Timing {
    Event(Handle),
    Polling { period_hns: i64 },
}

pub struct WasapiOutput {
    client: AudioClient,
    render: AudioRenderClient,
    timing: Timing,
    /// 一次写入的帧数上限，避免长时间霸占输出线程导致事件堆积
    max_chunk_frames: usize,
    /// f32 → 设备字节的转换缓冲（复用，避免每次写入分配）
    byte_buf: Vec<u8>,
    sample_rate: u32,
    channels: usize,
    mode: OutputMode,
    format: OutputSampleFormat,
    /// 独占启动健康检查预算（ms）。None = 自动；Some(0) = 跳过检查（诊断用）。
    verify_budget_ms: Option<u64>,
    /// 最近一次**成功读出**的 padding。读失败时用它兜底，而不是谎报 0
    /// （0 会被下游解读成"缓冲是空的"，进而把播放位置算到最前面）。
    padding_cache: std::sync::atomic::AtomicU32,
}

/* ★ 为什么必须手写 unsafe impl Send：
   wasapi 0.24 的 AudioClient 包着一个 `windows::Win32::Media::Audio::IAudioClient`，
   而 windows-core 0.62 的 `IUnknown(NonNull<c_void>)` **不再自动实现 Send**
   （docs.rs 上显示的 `impl Send for AudioClient` 是旧版 windows 编译的产物，
   在当前依赖解析结果下不成立——照着文档写就会撞上这个编译错误）。

   安全性论证（MTA 场景下成立）：
   · COM 接口指针本身是引用计数的，跨线程 Release 是合法且线程安全的；
   · windows-rs 撤掉自动 Send 针对的是 **STA**（单线程套间）——那里跨线程
     调用会隐式 marshal 并可能死锁。本模块所有线程都在使用 WASAPI 前调用
     `ensure_com()`（MTA），MTA 下跨套间调用不需要 marshal；
   · 音频对象只被**一个**线程持有和调用（输出线程独占），不存在并发访问，
     这里传递的只是"所有权转移"，不是共享。
   综上，Send 是成立的。 */
unsafe impl Send for WasapiOutput {}

/// 独占**端到端**可用性检查，给设置面板用。
///
/// ★ 为什么不复用 `probe_exclusive_formats`：那个只问驱动"收不收这个格式"，
///   而本机实测恰恰存在"驱动说收、Initialize 也返回 S_OK，端点却永不消费数据"
///   的组合 —— 只看格式协商会给出**错误的乐观结论**，用户勾上独占后是彻底
///   没声音（比报错糟得多）。
///   所以这里真的打开一次、预填充、启动，并让 `WasapiOutput::start` 的健康检查
///   去确认端点开始消费；返回 Err 就说明这台机器现在用不了独占，理由可直接展示。
///
/// 代价：会**短暂独占设备**（几毫秒到几百毫秒，取决于端点是否流动）。
/// 因此只在用户点开"独占"或打开设置面板时调用，不要放进热路径。
pub fn check_exclusive_usable(
    device_id: Option<&str>,
    sample_rate: u32,
    channels: usize,
) -> std::result::Result<ExclusiveFormatInfo, String> {
    let cfg = OutputConfig {
        device_id: device_id.map(|s| s.to_string()),
        mode: OutputMode::Exclusive,
        sample_rate,
        channels,
        ..Default::default()
    };
    let mut out = WasapiOutput::open(&cfg).map_err(|e| e.to_string())?;
    let info = ExclusiveFormatInfo {
        sample_rate: out.sample_rate(),
        channels,
        format: out.sample_format(),
    };
    out.start().map_err(|e| e.to_string())?;
    let _ = out.stop();
    Ok(info)
}

impl WasapiOutput {
    pub fn open(cfg: &OutputConfig) -> Result<Self> {
        ensure_com();
        let enumerator = DeviceEnumerator::new()?;
        let device = device_of(&enumerator, cfg.device_id.as_deref())?;
        /* 共享路径要用它 initialize（需要 mut）；独占路径只拿它做只读的格式协商，
           client 会在 open_exclusive 里对每个候选周期各取一个新的。 */
        let client = device.get_iaudioclient()?;

        match cfg.mode {
            OutputMode::Shared => Self::open_shared(client, cfg),
            OutputMode::Exclusive => Self::open_exclusive(&device, cfg),
        }
    }

    fn open_shared(mut client: AudioClient, cfg: &OutputConfig) -> Result<Self> {
        let format = OutputSampleFormat::F32;
        let wf = WaveFormat::new(
            format.store_bits(),
            format.valid_bits(),
            &format.sample_type(),
            cfg.sample_rate as usize,
            cfg.channels,
            None,
        );
        /* autoconvert=true：允许请求的格式与设备原生格式不同，由系统插入 SRC。
           共享模式下这是标准做法，也是唯一不需要自己写重采样器的路径。
           ★ 原始模式（RAW）下必须反过来：RAW 要求流不被引擎处理，
             再要 autoconvert 就是自相矛盾，Initialize 会直接失败。 */
        let autoconvert = !cfg.client_raw;
        apply_client_properties(&client, cfg)?;
        let mode = StreamMode::EventsShared {
            autoconvert,
            buffer_duration_hns: cfg.buffer_duration_hns,
        };
        client
            .initialize_client(&wf, &Direction::Render, &mode)
            .map_err(|e| {
                AudioError::FormatUnsupported(format!(
                    "shared init failed ({} Hz / {} ch): {}",
                    cfg.sample_rate, cfg.channels, e
                ))
            })?;

        let event = client.set_get_eventhandle()?;
        let render = client.get_audiorenderclient()?;
        let buffer_frames = client.get_buffer_size().unwrap_or(0) as usize;
        /* 一次最多写半个设备缓冲：写太多会让本线程长时间不回来处理事件，
           写太少会增加事件轮次。半缓冲是个稳的中点。 */
        let max_chunk_frames = (buffer_frames / 2).max(64);

        Ok(Self {
            client,
            render,
            timing: Timing::Event(event),
            max_chunk_frames,
            byte_buf: Vec::new(),
            sample_rate: cfg.sample_rate,
            channels: cfg.channels,
            mode: OutputMode::Shared,
            format,
            verify_budget_ms: cfg.exclusive_verify_ms,
            padding_cache: std::sync::atomic::AtomicU32::new(0),
        })
    }

    fn open_exclusive(device: &wasapi::Device, cfg: &OutputConfig) -> Result<Self> {
        if cfg.sample_rate == 0 {
            return Err(AudioError::FormatUnsupported(
                "exclusive: sample_rate must be known before opening".into(),
            ));
        }
        let rate = cfg.sample_rate;

        /* ① 协商用的临时 client。格式一旦定下来，真正 initialize 的那个
           client 必须**另取一个**——同一 client 不能 initialize 两次
           （AUDCLNT_E_ALREADY_INITIALIZED），而下面的回退路径恰恰要重开。 */
        let probe = device.get_iaudioclient()?;
        let (default_period, min_period) = probe
            .get_device_period()
            .map_err(|e| AudioError::Wasapi(format!("GetDevicePeriod failed: {}", e)))?;
        let (format, wf) = negotiate_exclusive_format(&probe, cfg, &mut Vec::new())?;

        /* ② 首选周期：调用方指定值优先，否则用设备**默认**周期。
           刻意不用 min_period：默认周期是驱动认证过的稳定点，min 只是"能跑"，
           在部分 USB/HDA 驱动上 min 周期配小缓冲会爆音。
           无论哪个，都要对齐到**整帧**：44.1k 下 10ms = 441 帧是整数，
           但 3ms = 132.3 帧不是，Windows 会对帧数取整，于是缓冲与周期
           不再成整数倍——那正是"端点不流动"的元凶。 */
        let base = cfg
            .exclusive_period_hns
            .unwrap_or(if default_period > 0 { default_period } else { min_period });
        let base = if base > 0 { base.max(min_period.max(0)) } else { 100_000 };
        let period_hns = probe
            .calculate_aligned_period_near(base, Some(0), &wf)
            .unwrap_or(base);
        let mult = cfg.exclusive_buffer_periods.max(1);

        /* ③ Initialize。最多三轮，用队列而不是固定数组：
             候选顺序 —— period × N → 整缓冲当一个周期（period == buffer 恒为整数倍）
             → 再退回一次（驱动两轮返回不同缓冲长度时的兜底）。
             ★ 用 `pop` 而不是下标：某条候选可能**根本没进队**（第 0 轮直接
             Initialize 失败就不会补候选项），按下标取会越界 panic。 */
        let mut attempts: Vec<(i64, i64)> = vec![(period_hns, period_hns * mult)];
        let mut last_err: Option<String> = None;
        let mut round = 0usize;

        while let Some((p, b)) = attempts.pop() {
            round += 1;
            if round > 3 {
                break;
            }
            let mut client = device.get_iaudioclient()?;
            apply_client_properties(&client, cfg)?;
            /* 事件驱动独占要求 buffer == period（crate 的 EventsExclusive 只收一个
               period 参数，内部把两者设成同一个值），所以走这条路时忽略倍数。 */
            let mode = if cfg.exclusive_use_events {
                StreamMode::EventsExclusive { period_hns: p }
            } else {
                StreamMode::PollingExclusive {
                    buffer_duration_hns: b,
                    period_hns: p,
                }
            };
            match client.initialize_client(&wf, &Direction::Render, &mode) {
                Ok(()) => {
                    let buffer_frames = client.get_buffer_size().unwrap_or(0) as usize;
                    let period_frames = hns_to_frames(p, rate);
                    /* ★ 这一关是本机实测踩出来的：Initialize 返回 S_OK，
                       但驱动把缓冲取整成了 512 帧（10.67ms），而我们请求的
                       period 是 3ms（144 帧）—— 512/144 不是整数。
                       端点于是"收下了数据却永不消耗"，表现为引擎位置恒为 0、
                       队列永远是满的，且**没有任何报错**。必须在这里拦住。 */
                    if period_frames == 0
                        || buffer_frames == 0
                        || buffer_frames % period_frames != 0
                    {
                        last_err = Some(format!(
                            "driver rounded buffer to {} frames which is not a multiple of period {} frames",
                            buffer_frames, period_frames
                        ));
                        eprintln!(
                            "[aria-audio] exclusive round {} rejected: {} — retrying with period=buffer",
                            round + 1,
                            last_err.as_deref().unwrap_or("")
                        );
                        /* 用实际拿到的缓冲长度反推一个整周期 */
                        let aligned =
                            wasapi::calculate_period_100ns(buffer_frames as i64, rate as i64);
                        attempts.push((aligned, aligned));
                        continue;
                    }
                    /* 事件句柄必须在 initialize 之后、start 之前取 */
                    let timing = if cfg.exclusive_use_events {
                        Timing::Event(client.set_get_eventhandle()?)
                    } else {
                        Timing::Polling { period_hns: p }
                    };
                    let render = client.get_audiorenderclient()?;
                    let max_chunk_frames = (buffer_frames / 2).max(64);
                    eprintln!(
                        "[aria-audio] exclusive opened: {} Hz / {} ch / {} ({} period {} hns = {} frames, buffer {} frames)",
                        rate,
                        cfg.channels,
                        format.label(),
                        if cfg.exclusive_use_events { "events" } else { "polling" },
                        p,
                        period_frames,
                        buffer_frames
                    );
                    return Ok(Self {
                        client,
                        render,
                        timing,
                        max_chunk_frames,
                        byte_buf: Vec::new(),
                        sample_rate: rate,
                        channels: cfg.channels,
                        mode: OutputMode::Exclusive,
                        format,
                        verify_budget_ms: cfg.exclusive_verify_ms,
                        padding_cache: std::sync::atomic::AtomicU32::new(0),
                    });
                }
                Err(e) => {
                    last_err = Some(format!("init failed at period {} / buffer {}: {}", p, b, e));
                }
            }
        }

        Err(AudioError::FormatUnsupported(format!(
            "exclusive: could not open {} Hz / {} ch / {} — {}",
            rate,
            cfg.channels,
            format.label(),
            last_err.unwrap_or_else(|| "unknown".into())
        )))
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn mode(&self) -> OutputMode {
        self.mode
    }

    pub fn sample_format(&self) -> OutputSampleFormat {
        self.format
    }

    pub fn max_chunk_frames(&self) -> usize {
        self.max_chunk_frames
    }

    /// 设备缓冲中**尚未播放**的帧数。时钟补偿用：已写入的帧数减去它，
    /// 才是"此刻真正从扬声器出来的位置"。
    ///
    /// ★ 读失败时**返回上次成功读到的值**，绝不返回 0：
    ///   0 会被下游解读成"缓冲空着、数据全放完了"，把播放位置瞬间顶到最前面
    ///   （歌词会跳到最后一行）。宁可短暂停在上次的位置上。
    pub fn padding_frames(&self) -> u32 {
        use std::sync::atomic::Ordering;
        match self.try_padding_frames() {
            Ok(p) => {
                self.padding_cache.store(p, Ordering::Relaxed);
                p
            }
            Err(_) => self.padding_cache.load(Ordering::Relaxed),
        }
    }

    /// 独立的「已播出帧数」读数（`IAudioClock`）。
    ///
    /// ★ 与 `padding_frames()` 走的是**完全不同的通路**：
    ///   padding 是驱动对缓冲占用量的记账，clock 是端点自己的时钟位置。
    ///   两者同时停住才叫"设备真的没在放"；如果 clock 在走而 padding 不动，
    ///   那说明是 padding 这个读数不可信，不是设备坏了。
    ///   排查"独占不出声"时最需要的就是这条独立证据。
    pub fn audio_clock_position(&self) -> Result<u64> {
        let clock = self.client.get_audioclock()?;
        let (pos, _) = clock.get_position()?;
        Ok(pos)
    }

    /// 时钟单位。`position / frequency` 才是秒——只看 position 的增量无法判断
    /// "走得慢"还是"单位本来就大"，两个数字必须一起读。
    pub fn audio_clock_frequency(&self) -> Result<u64> {
        let clock = self.client.get_audioclock()?;
        Ok(clock.get_frequency()?)
    }

    /// 把"读端点缓冲状态"的失败**显式暴露出来**。
    /// 健康检查必须用这个版本：`padding_frames()` 的兜底语义会让「读不到」
    /// 伪装成「缓冲满」，两者是完全不同的故障，不能混在一个数字里。
    pub fn try_padding_frames(&self) -> Result<u32> {
        let space = self.client.get_available_space_in_frames()?;
        let size = self.client.get_buffer_size().unwrap_or(0);
        Ok(size.saturating_sub(space))
    }

    /// 可写入空间（帧）。0 表示设备缓冲还满着，应当先等 / 先睡。
    pub fn available_space_frames(&self) -> Result<u32> {
        Ok(self.client.get_available_space_in_frames()?)
    }

    /// 预填充设备缓冲 + 启动流。**必须在写数据之前调用**，且内部已按
    /// MSDN「Rendering a Stream」的顺序做了预填充：
    ///
    ///   1. 先把**整个**可用空间填成静音（设备在 Start 的瞬间就会向缓冲取数据，
    ///      空的缓冲会被填上未初始化内存 —— 那是可听见的爆音）；
    ///   2. 再 `Start()`。
    ///
    /// ★ 独占模式额外做一次**端点健康检查**（`verify_streaming`）。
    ///   本机实测存在"格式被接受、Initialize 返回 S_OK、却永不消耗数据"的
    ///   驱动/环境组合。那种情况下引擎位置恒为 0、队列永远是满的，
    ///   **且没有任何报错** —— 与其静默无声，不如明确失败让上层回退。
    pub fn start(&mut self) -> Result<()> {
        self.start_unverified()?;
        if self.mode == OutputMode::Exclusive {
            self.verify_streaming()?;
        }
        Ok(())
    }

    /// 只做「预填充 + 启动」，**不做端点健康检查**。
    ///
    /// 单独暴露出来的唯一理由是诊断：要亲耳确认 `Some(0)`（跳过检查）的设备
    /// 到底出不出声时，`start()` 会在声音出来之前就把流掐掉，那样永远听不到。
    /// 生产路径一律走 `start()`。
    pub fn start_unverified(&mut self) -> Result<()> {
        if let Ok(space) = self.available_space_frames() {
            if space > 0 {
                let _ = self.write_silence(space as usize);
            }
        }
        self.client.start_stream()?;
        Ok(())
    }

    /// 端点是否真的在消费数据。独占专用（共享由系统音频引擎驱动，不存在这个失败模式）。
    ///
    /// 判据：启动后预算时间内，padding 必须下降过一次。
    /// 只看"有没有报错"是不够的——这个失败模式全程 S_OK。
    ///
    /// ★ 预算**必须给够**：端点从空闲唤醒（DMA 起转、独占接管、USB 时钟重锁）
    ///   可以轻松超过 100ms。初版给 80ms，结果是"体检把自己的设备判成坏设备"，
    ///   用户看到"独占不能用"其实只是没等够 —— 误判比漏判更糟。
    fn verify_streaming(&self) -> Result<()> {
        let buffer = self.client.get_buffer_size().unwrap_or(0);
        if buffer == 0 {
            return Ok(());
        }
        let budget_ms = verify_budget_ms(buffer, self.sample_rate, self.verify_budget_ms);
        if budget_ms == 0 {
            return Ok(()); /* Some(0) = 显式跳过（诊断） */
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
        let mut read_ok = false;
        let mut min_seen = u32::MAX;
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(8));
            match self.try_padding_frames() {
                Ok(p) => {
                    read_ok = true;
                    min_seen = min_seen.min(p);
                    if p < buffer {
                        return Ok(());
                    }
                }
                /* 读失败 ≠ 端点不流动。继续等，最后按 read_ok 给不同的结论。 */
                Err(_) => continue,
            }
        }
        /* 端点收下了数据却不消费：不是"暂时没数据"，是这条路根本走不通。
           主动停流，避免把设备锁在一个不流动的独占状态里（那会让其他应用
           在流被释放前无法出声）。 */
        let _ = self.client.stop_stream();
        if !read_ok {
            return Err(AudioError::Busy(format!(
                "exclusive endpoint: could not read padding at all within {} ms \
                 (GetCurrentPadding/GetBufferSize failed) — cannot confirm the stream is running",
                budget_ms
            )));
        }
        Err(AudioError::Busy(format!(
            "exclusive endpoint accepted {} frames but consumed none within {} ms \
             (padding stayed at {}) — this device/driver does not actually stream in exclusive mode",
            buffer,
            budget_ms,
            if min_seen == u32::MAX { buffer } else { min_seen }
        )))
    }

    pub fn stop(&self) -> Result<()> {
        self.client.stop_stream()?;
        Ok(())
    }

    /// 等设备腾出空间。超时返回 Ok（不是错误）——超时只是意味着这段时间没有
    /// 新空间，上层据此重新检查一遍状态（暂停/停止/命令）即可。
    ///
    /// ★ 独占走轮询：没有事件句柄可等，就睡半个 period。
    ///   睡太久会漏掉写入窗口（underrun = 可听见的爆音），睡太短等于忙等。
    ///   半个 period 是本机唯一稳的点。
    pub fn wait_event(&self, timeout_ms: u32) -> Result<()> {
        match &self.timing {
            Timing::Event(h) => {
                h.wait_for_event(timeout_ms)?;
            }
            Timing::Polling { period_hns } => {
                let half_ms = (*period_hns / 10_000 / 2).max(1);
                let ms = half_ms.min(timeout_ms.max(1) as i64) as u64;
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        }
        Ok(())
    }

    /// 写入 `frames` 帧（输入是**立体声交错 f32**，长度 ≥ frames*channels）。
    ///
    /// ★ 为什么走 `write_to_device`（字节）而不是 buffer API：
    ///   0.24 的 render client 只暴露字节写入，AudioRenderBuffer 没有公开的
    ///   f32 直写。转换成本很低（一次 memcpy 级别的展开），换来的是不依赖
    ///   未公开的内部布局。
    /// ★ 转换按 `self.format` 分派：共享恒为 f32；独占在本机实测恒为整数格式。
    pub fn write_f32(&mut self, frames: usize, samples: &[f32]) -> Result<()> {
        let need = frames * self.channels;
        if samples.len() < need {
            return Err(AudioError::Internal(format!(
                "write_f32: need {} samples for {} frames, got {}",
                need,
                frames,
                samples.len()
            )));
        }
        let src = &samples[..need];
        self.byte_buf.clear();
        match self.format {
            OutputSampleFormat::F32 => {
                self.byte_buf.reserve(need * 4);
                /* Windows 只有小端平台，to_le_bytes 在编译期就退化成直接拷贝 */
                for &s in src {
                    self.byte_buf.extend_from_slice(&s.to_le_bytes());
                }
            }
            OutputSampleFormat::S24In32 => {
                self.byte_buf.reserve(need * 4);
                /* 24 位有效位**左对齐**放进 32 位容器：低 8 位恒 0。
                   这与 KSDATAFORMAT_SUBTYPE_PCM + wValidBitsPerSample=24 的
                   约定一致；把 24 位值直接放进低 3 字节会被驱动当噪声。 */
                for &s in src {
                    let v = f32_to_s24(s) << 8;
                    self.byte_buf.extend_from_slice(&v.to_le_bytes());
                }
            }
            OutputSampleFormat::S16 => {
                self.byte_buf.reserve(need * 2);
                for &s in src {
                    self.byte_buf.extend_from_slice(&f32_to_s16(s).to_le_bytes());
                }
            }
        }
        self.render.write_to_device(frames, &self.byte_buf, None)?;
        Ok(())
    }

    /// 写入静音（预填充设备缓冲用：start_stream 前必须先把缓冲填满，
    /// 否则刚启动的瞬间设备会取到未初始化内存 → 可听见的爆音）。
    /// 长度必须按**当前格式**算，每种格式 0 字节都一样但宽度不同。
    pub fn write_silence(&mut self, frames: usize) -> Result<()> {
        let bytes = frames * self.channels * self.format.bytes_per_sample();
        self.byte_buf.clear();
        self.byte_buf.resize(bytes, 0);
        self.render.write_to_device(frames, &self.byte_buf, None)?;
        Ok(())
    }
}

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        /* 必须显式停流：共享模式下不释放会让其他应用在一小段时间里拿不到设备；
           独占模式下不释放会**锁死用户设备**直到进程退出。 */
        let _ = self.client.stop_stream();
    }
}

/* ================= 样本格式转换 ================= */

/// f32（[-1, 1]）→ 16 位整数。
/// 用 32767（而不是 32768）缩放：`-1.0 * 32767 = -32767`，永远不会溢出到
/// -32768 那种"翻极性"的边界值；正负对称也让「静音=0」严格成立。
#[inline]
pub fn f32_to_s16(s: f32) -> i16 {
    let v = (s * 32767.0).round();
    v.clamp(-32768.0, 32767.0) as i16
}

/// f32（[-1, 1]）→ 32 位容器里的 24 位整数（**右对齐**的值，高位在外部左移）。
/// 返回的是 i32 数值本身（范围 ±8388607），不是左移后的字节形态 ——
/// 左移由调用方做，免得两条 24 位路径各移一次。
#[inline]
pub fn f32_to_s24(s: f32) -> i32 {
    let v = (s * 8_388_607.0).round();
    v.clamp(-8_388_608.0, 8_388_607.0) as i32
}

/// 共享/独占的一致性自检（诊断用，不改变行为）。
pub fn probe_share_mode(cfg: &OutputConfig) -> Result<ShareMode> {
    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    let client = device.get_iaudioclient()?;
    let _ = cfg;
    Ok(client.get_sharemode().unwrap_or(ShareMode::Shared))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_budget_never_drops_below_400ms_by_default() {
        /* 这台机器上的真实参数：44.1k / 1024 帧 = 23.2ms 缓冲。
           初版 clamp(buf_ms*3, 80, 600) 在这里只给 80ms —— 端点从空闲唤醒
           完全可能超过它，于是体检把好设备判成坏设备。下限必须够。
           23.2 × 4 = 92.9 → 抬到 400。 */
        assert_eq!(verify_budget_ms(1024, 44_100, None), 400);
        /* 大缓冲时按 4 倍走：48k / 4800 帧 = 100ms → 400ms */
        assert_eq!(verify_budget_ms(4800, 48_000, None), 400);
        /* 48000 帧 @48k = 1000ms → 4000 被上限压到 3000 */
        assert_eq!(verify_budget_ms(48_000, 48_000, None), 3000);
        /* 退化的输入不能算出 0（0 被解释成"跳过检查"，会把体检悄悄关掉） */
        assert!(verify_budget_ms(0, 0, None) >= 400);
    }

    #[test]
    fn verify_budget_honours_explicit_override_including_skip() {
        assert_eq!(verify_budget_ms(1024, 44_100, Some(0)), 0, "Some(0) = 跳过检查");
        assert_eq!(verify_budget_ms(1024, 44_100, Some(1500)), 1500);
    }

    #[test]
    fn sample_format_geometry_matches_windows_conventions() {
        /* s24 是"32 位容器 + 24 位有效位"，最容易写错成 store=24 */
        assert_eq!(OutputSampleFormat::S24In32.store_bits(), 32);
        assert_eq!(OutputSampleFormat::S24In32.valid_bits(), 24);
        assert_eq!(OutputSampleFormat::S24In32.bytes_per_sample(), 4);
        assert_eq!(OutputSampleFormat::S16.store_bits(), 16);
        assert_eq!(OutputSampleFormat::S16.valid_bits(), 16);
        assert_eq!(OutputSampleFormat::S16.bytes_per_sample(), 2);
        assert_eq!(OutputSampleFormat::F32.bytes_per_sample(), 4);
    }

    #[test]
    fn f32_to_s16_clamps_and_is_symmetric() {
        assert_eq!(f32_to_s16(0.0), 0);
        assert_eq!(f32_to_s16(1.0), 32767);
        assert_eq!(f32_to_s16(-1.0), -32767);
        /* 超范围必须钳制而不是回绕（C 风格的 `as i16` 会让 1.5 → -32768） */
        assert_eq!(f32_to_s16(1.5), 32767);
        assert_eq!(f32_to_s16(-1.5), -32768);
        /* 量化误差在半步以内 */
        let q = f32_to_s16(0.5);
        assert!((q as f32 / 32767.0 - 0.5).abs() < 1.0 / 32767.0);
    }

    #[test]
    fn f32_to_s24_clamps_and_is_symmetric() {
        assert_eq!(f32_to_s24(0.0), 0);
        assert_eq!(f32_to_s24(1.0), 8_388_607);
        assert_eq!(f32_to_s24(-1.0), -8_388_607);
        assert_eq!(f32_to_s24(9.0), 8_388_607);
        assert_eq!(f32_to_s24(-9.0), -8_388_608);
    }

    #[test]
    fn s24_left_justification_leaves_low_byte_zero() {
        /* 左对齐是 24 位进 32 位容器的关键约定：低 8 位必须是 0，
           否则驱动会把它当成更低位的有效数据，音量/噪声全错。 */
        for s in [0.0f32, 1.0, -1.0, 0.25, -0.7] {
            let stored = f32_to_s24(s) << 8;
            assert_eq!(stored & 0xFF, 0);
        }
    }

    #[test]
    fn output_mode_labels_are_stable() {
        /* 前端按这两个字符串识别当前模式，属于跨语言契约，别改 */
        assert_eq!(OutputMode::Shared.label(), "shared");
        assert_eq!(OutputMode::Exclusive.label(), "exclusive");
    }
}
