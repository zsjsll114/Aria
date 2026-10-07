//! aria-audio 的命令行驱动 —— 脱离 WebView2 直接验证引擎。
//!
//! 存在的理由：Tauri IPC 只在 Aria.exe 里存在，浏览器打开 8001 时根本没有
//! 这套 API。也就是说，**引擎自身的问题（seek 不准、时钟漂移、换设备失败）
//! 在浏览器里永远复现不了**。这个 bin 提供了唯一可信的观测环境。
//!
//! 用法（输出刻意保持纯 ASCII，避免 Windows 控制台编码问题）：
//!
//! ```text
//!   audio-probe devices
//!   audio-probe play  <file> [seconds]
//!   audio-probe http  <backendBase> <rawUrl> <songId> [seconds]
//! ```
//!
//! `play`/`http` 会每秒打印一次引擎时钟（位置 / 时长 / 队列深度 / underrun），
//! 并在结束时报告位置与真实墙钟的偏差——这是判断"时钟准不准"最直接的办法。

use std::time::{Duration, Instant};

use aria_audio::{
    list_output_devices, probe_exclusive_formats, AudioEngine, AudioSourceSpec, EqSettings,
    OutputConfig, OutputMode, SpatialSettings, EQ_BANDS, EQ_BAND_COUNT, IR_ORDER, SPATIAL_LEVELS,
    STAGE_LEVELS,
};
use aria_audio::dsp::SpatialChain;

/// 独占模式探测用的采样率集合：覆盖本项目实际会遇到的全部来源
/// （CD 直转 44.1k、视频/多数流媒体 48k、Hi-Res 96k/192k）。
/// 故意不含 88.2k：本机没有这种源，探它得不到任何决策价值。
const PROBE_RATES: [u32; 4] = [44_100, 48_000, 96_000, 192_000];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("{}", USAGE);
        std::process::exit(2);
    }
    /* ★ 独占开关走独立 flag 而不是命令名：play/http/eq 三种驱动方式
       都要能各自验证独占，复制三份命令名会立刻失去同步。 */
    let exclusive = args.iter().any(|a| a == "--exclusive");
    /* ★ --no-verify：跳过独占启动后的端点健康检查。
       存在的唯一理由是"用耳朵验"——体检会在声音出来之前就把流掐掉，
       那样永远听不到设备到底出不出声（这是把"体检误判"和"设备真不行"
       分开的唯一办法）。 */
    let no_verify = args.iter().any(|a| a == "--no-verify");
    /* --raw：共享原始模式（RAW|MATCH_FORMAT）。独占用不了时的比特完美备选，
       能不能用必须用耳朵确认——数字会骗人，声音不会。 */
    let raw = args.iter().any(|a| a == "--raw");
    let args: Vec<String> = args
        .into_iter()
        .filter(|a| a != "--exclusive" && a != "--no-verify" && a != "--raw")
        .collect();

    match args[1].as_str() {
        "devices" => cmd_devices(),
        "formats" => {
            let idx = args.get(2).and_then(|s| s.parse::<usize>().ok());
            cmd_formats(idx)
        }
        /* diag —— 不播放任何音频，只观察"设备缓冲到底会不会流动"。
           这是排查「独占打开了但没声音 / 时钟不动」唯一直接的手段：
           共享与独占的差异全在缓冲语义上，光看引擎快照分不出来。 */
        "diag" => cmd_diag(exclusive),
        /* tone —— 用耳朵判定独占到底出不出声。diag 只写静音，回答不了这个问题。 */
        "tone" => {
            let secs = args
                .get(2)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(6.0);
            cmd_tone(secs, exclusive, raw)
        }
        "play" => {
            if args.len() < 3 {
                eprintln!("{}", USAGE);
                std::process::exit(2);
            }
            let secs = args
                .get(3)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(8.0);
            run(
                AudioSourceSpec::file(&args[2]),
                secs,
                "file",
                None,
                exclusive,
                no_verify,
                None,
            )
        }
        /* eq <file> <bandIndex 0..9> <gainDb -12..12> [seconds]
           —— 用来**用耳朵**验证 EQ：挑一段熟悉的音乐，把某段推到 +12 再拉到
           -12，能立刻听出对应频段的变化。DSP 单测能证明曲线对，但证明不了
           "它真的接在播放链上了"，这一步必须出声。 */
        "eq" => {
            if args.len() < 5 {
                eprintln!("{}", USAGE);
                std::process::exit(2);
            }
            let band = args[3].parse::<usize>().unwrap_or(0);
            let gain = args[4].parse::<f64>().unwrap_or(12.0);
            let secs = args
                .get(5)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(8.0);
            run(
                AudioSourceSpec::file(&args[2]),
                secs,
                "file",
                Some((band, gain)),
                exclusive,
                no_verify,
                None,
            )
        }
        "http" => {
            if args.len() < 5 {
                eprintln!("{}", USAGE);
                std::process::exit(2);
            }
            let secs = args
                .get(5)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(8.0);
            run(
                AudioSourceSpec::http(&args[2], &args[3], &args[4]),
                secs,
                "http",
                None,
                exclusive,
                no_verify,
                None,
            )
        }
        /* spatial <file> [seconds] [--spatial light|medium|strong] [--ir near|hall|wide]
                     [--stage light|medium] [--exclusive]
           —— 用**耳朵**验证空间音频 / 虚拟声场：同一条链在 Rust 侧到底出不出效果，
           只有真出声才算数（DSP 单测能证明数学对，证明不了"接在播放链上"）。 */
        "spatial" => {
            if args.len() < 3 {
                eprintln!("{}", USAGE);
                std::process::exit(2);
            }
            let secs = args
                .get(3)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(10.0);
            let set = spatial_settings_from(&args);
            println!(
                "spatial: on={} level={} ir={} | stage: on={} level={}",
                set.spatial_on,
                set.spatial_level_name(),
                set.ir_name(),
                set.stage_on,
                set.stage_level_name()
            );
            run(
                AudioSourceSpec::file(&args[2]),
                secs,
                "file",
                None,
                exclusive,
                no_verify,
                Some(set),
            )
        }
        /* spatialbench —— 纯 CPU 量化：空间链处理 N 秒音频实际要多少墙钟时间。
           方案 §6 明确要求「先量化，再决定 IR 长度 / 是否引入 rustfft」——
           这是那个量化入口（不碰设备、不出声、任何机器都能跑）。 */
        "spatialbench" => cmd_spatial_bench(),
        other => {
            eprintln!("unknown command: {}", other);
            eprintln!("{}", USAGE);
            std::process::exit(2);
        }
    }
}

const USAGE: &str = "\
aria-audio probe

  audio-probe devices
  audio-probe formats [deviceIndex]
  audio-probe diag  [--exclusive]
  audio-probe tone  [seconds] [--exclusive] [--raw]
  audio-probe play <file> [seconds] [--exclusive] [--no-verify]
  audio-probe eq   <file> <band 0..9> <gainDb -12..12> [seconds] [--exclusive]
  audio-probe http <backendBase> <rawUrl> <songId> [seconds] [--exclusive]
  audio-probe spatial <file> [seconds] [--spatial light|medium|strong]
                      [--ir near|hall|wide] [--stage light|medium] [--exclusive]
  audio-probe spatialbench

  --exclusive 让引擎走 WASAPI 独占（真比特完美输出，期间其他应用静音）。
  --no-verify 跳过独占启动后的端点健康检查 —— 体检不通过时用它把设备真开起来，
              亲耳确认到底出不出声（体检误判 vs 设备真不行的唯一判据）。
  --raw 共享原始模式（RAW|MATCH_FORMAT）：引擎不做混音/音量/音效处理，
        独占用不了时最接近比特完美的替代路径。注意它只能跑在端点原生采样率上。
  独占能否打开、协商到什么格式，用 formats 先看清楚。
  diag 不出声，只观察设备缓冲是否流动 —— 排查「打开了却没声音」的唯一手段。
  tone 放 1kHz 正弦并同时打印 padding 与 IAudioClock —— 用耳朵 + 两条独立
       读数把「设备真不行」和「padding 读数不可信」分开。
  spatial 用耳朵验证空间音频 / 虚拟声场（Rust 链）—— 数学对不等于接对了。
  spatialbench 纯 CPU 量化空间链开销（不碰设备），决定 IR 长度是否要上 FFT。
";

/// 缓冲区行为诊断。**不出声**（写的全是静音）。
///
/// 为什么需要它：共享与独占在"缓冲何时被消耗"上的语义不同，而这个差异
/// 只体现在 `GetCurrentPadding` 的取值上——引擎快照里只能看到"位置不动"，
/// 分不清是设备没跑、还是我们没往里写、还是写进去不被消耗。
/// 一条待验证的输出配置。
struct Combo {
    mode: OutputMode,
    rate: u32,
    period: Option<i64>,
    mult: i64,
    fmt: Option<Format>,
    events: bool,
    offload: bool,
    raw: bool,
    label: &'static str,
}

fn cmd_diag(exclusive: bool) {
    use aria_audio::output::{OutputConfig, OutputMode};

    let combos: Vec<Combo> = if !exclusive {
        /* 共享模式做**对照组**：它已知为真，用来先验"工具本身有没有偏差"。
           诊断工具必须先用已知好的样本证明自己可信，再用它去判未知。 */
        vec![Combo {
            mode: OutputMode::Shared,
            rate: 48_000,
            period: None,
            mult: 2,
            fmt: None,
            events: false,
            offload: false,
            raw: false,
            label: "shared 48k",
        }]
    } else {
        vec![
            /* ★★ 采样率必须进组合表（这是一处真实遗漏）：初版把独占采样率硬编码成
               44100，于是从未验证过 48k。很多 codec 的 DMA 只在自己原生的 48k 上跑，
               44.1k 要靠驱动的 SRC——而 SRC 恰恰是独占路径上最常坏掉的一环。
               "驱动说支持 44.1k" 只证明它收得下这个格式，不证明它拉得动。 */
            Combo { mode: OutputMode::Exclusive, rate: 48_000, period: None, mult: 2, fmt: None, events: false, offload: false, raw: false, label: "exclusive 48k / auto period x2 / auto format" },
            Combo { mode: OutputMode::Exclusive, rate: 96_000, period: None, mult: 2, fmt: None, events: false, offload: false, raw: false, label: "exclusive 96k / auto" },
            Combo { mode: OutputMode::Exclusive, rate: 192_000, period: None, mult: 2, fmt: None, events: false, offload: false, raw: false, label: "exclusive 192k / auto" },
            Combo { mode: OutputMode::Exclusive, rate: 44_100, period: None, mult: 2, fmt: None, events: false, offload: false, raw: false, label: "exclusive 44.1k / auto" },
            Combo { mode: OutputMode::Exclusive, rate: 48_000, period: None, mult: 2, fmt: Some(Format::S16), events: false, offload: false, raw: false, label: "exclusive 48k / FORCE s16" },
            /* ★ 硬件卸载：本机端点的 KS pin 是 offloadedrearlineoutwave，
               有些 OEM 驱动只在客户端声明 bIsOffload 时才编程 DSP 的缓冲描述符。 */
            Combo { mode: OutputMode::Exclusive, rate: 48_000, period: None, mult: 2, fmt: None, events: false, offload: true, raw: false, label: "exclusive 48k / bIsOffload=TRUE" },
            Combo { mode: OutputMode::Exclusive, rate: 44_100, period: None, mult: 2, fmt: None, events: false, offload: true, raw: false, label: "exclusive 44.1k / bIsOffload=TRUE" },
            /* ★ 共享原始模式：RAW|MATCH_FORMAT = 引擎不做混音/音量/音效处理。
               独占用不了时这是最接近比特完美的替代路径。 */
            Combo { mode: OutputMode::Shared, rate: 48_000, period: None, mult: 2, fmt: None, events: false, offload: false, raw: true, label: "shared 48k / RAW|MATCH_FORMAT" },
            Combo { mode: OutputMode::Shared, rate: 44_100, period: None, mult: 2, fmt: None, events: false, offload: false, raw: true, label: "shared 44.1k / RAW|MATCH_FORMAT" },
        ]
    };

    for c in combos {
        run_diag_once(
            OutputConfig {
                mode: c.mode,
                sample_rate: c.rate,
                channels: 2,
                exclusive_period_hns: c.period,
                exclusive_buffer_periods: c.mult,
                exclusive_format: c.fmt.map(Format::to_output),
                exclusive_use_events: c.events,
                client_offload: c.offload,
                client_raw: c.raw,
                ..Default::default()
            },
            c.label,
        );
    }
}

/// 诊断用的格式简称（避免在 bin 里 import 一长串类型名）
/* F32 当前无组合在用（本机驱动拒 f32 独占，试它只会白跑一轮），
   但它是枚举的完整取值之一、也是将来换机器时第一个该试的——保留并显式允许 dead_code。 */
#[allow(dead_code)]
#[derive(Clone, Copy)]
enum Format {
    F32,
    S24,
    S16,
}

impl Format {
    fn to_output(self) -> aria_audio::OutputSampleFormat {
        match self {
            Format::F32 => aria_audio::OutputSampleFormat::F32,
            Format::S24 => aria_audio::OutputSampleFormat::S24In32,
            Format::S16 => aria_audio::OutputSampleFormat::S16,
        }
    }
}

/// 打开一次、填静音、启动，然后**持续写入**并观察缓冲是否被消耗。
///
/// ★ 为什么要持续写而不是只填一次：只填一次的话，若端点没跑起来，
///   观察结果与"被驱动吞掉"无法区分；持续写入则严格模拟真实输出线程，
///   只要 padding 有过下降就证明链路是通的。
///
/// ★★ 为什么这里**故意不走 `start()`**（而调用 `start_unverified()`）：
///   `start()` 自带健康检查，端点没在预算内流动就会 `stop_stream()` 并返回 Err。
///   上一版 diag 因此**在 start 那一步就直接返回了，后面 6×50ms 的采样一次都没跑到**
///   —— "端点不流动"这个结论是体检窗口给的，不是观测给的。
///   诊断工具必须自己观测，不能把结论外包给被测对象。
fn run_diag_once(cfg: aria_audio::output::OutputConfig, label: &str) {
    use aria_audio::output::WasapiOutput;
    use std::time::Instant;

    println!("--- {} ---", label);
    let mut out = match WasapiOutput::open(&cfg) {
        Ok(o) => o,
        Err(e) => {
            println!("  open FAILED: {}", e);
            return;
        }
    };
    let buffer_frames = out.available_space_frames().unwrap_or(0) as usize;
    if buffer_frames == 0 {
        println!("  no buffer space before start");
        return;
    }
    if let Err(e) = out.start_unverified() {
        println!("  start FAILED: {}", e);
        return;
    }

    /* 观测窗口刻意给到 2 秒、20ms 一次：
       端点从空闲唤醒（DMA 起转 / 独占接管 / USB 时钟重锁）可以轻松超过 100ms，
       窗口太短会把"起转慢"读成"根本不转"。 */
    let t0 = Instant::now();
    let mut lows: Vec<u32> = Vec::new();
    let mut read_failures = 0usize;
    while t0.elapsed().as_millis() < 2000 {
        std::thread::sleep(Duration::from_millis(20));
        /* ★ 先采样再补写，顺序不能反。反过来的话每次读到的都是「刚写满」的
           padding，而这个数**恒等于缓冲大小**，于是无论端点有没有在消费都会
           打印 STALLED —— 共享模式（实测播放完全正常）也会被判成卡死，
           这种「诊断工具自己有偏差」的结论比没有结论更危险。 */
        match out.try_padding_frames() {
            Ok(p) => lows.push(p),
            Err(_) => read_failures += 1,
        }
        let space = out.available_space_frames().unwrap_or(0);
        if space > 0 {
            let _ = out.write_silence(space as usize);
        }
    }
    let _ = out.stop();
    let observed = lows.len();
    let lo = lows.iter().copied().min();
    let hi = lows.iter().copied().max();
    let moved = lows.iter().any(|p| *p < buffer_frames as u32);
    println!(
        "  {} / {} | buffer={} frames | read_ok={} read_failed={}",
        out.mode().label(),
        out.sample_format().label(),
        buffer_frames,
        observed,
        read_failures
    );
    println!(
        "  min={:?} max={:?} (buffer={}) | trace(first 12): {:?}",
        lo,
        hi,
        buffer_frames,
        &lows[..lows.len().min(12)]
    );
    /* 三种结局必须分开报：把它们混成一句"不流动"会直接导错方向 */
    let verdict = if observed == 0 {
        "NO-READS (padding 完全读不到 → 不是端点问题，是我们的读取路径问题)"
    } else if moved {
        "FLOWING"
    } else if lo == Some(buffer_frames as u32) {
        "STALLED (端点收下数据但 padding 恒等于整块缓冲)"
    } else {
        "PARTIAL (padding 有变化但从未低于缓冲大小 → 起转很慢或只被吃了一部分)"
    };
    println!("  => {} ({:.0} ms)", verdict, t0.elapsed().as_millis());
}

/// 用**耳朵**判定独占到底出不出声 —— 唯一能穿透"读数可能撒谎"的检验。
///
/// ★ 为什么需要它（以及为什么 diag 不够）：
///   diag 全程写静音，所以它只能回答"缓冲流动不流动"，回答不了"有没有声音"。
///   而"缓冲不流动"有两种截然不同的原因：
///     ① 设备/驱动真的不在消费；② `GetCurrentPadding` 这个读数本身不可信。
///   本命令把两者分开：预填充**用音调而不是静音**，并**同时**打印
///   padding（驱动记账）与 IAudioClock（端点时钟）两个独立读数。
///   → 听到声音 + clock 在走 = 设备好的，是 padding 读数不可信；
///   → 什么都听不到 + 两个读数都冻住 = 设备真的不复位。
fn cmd_tone(seconds: f64, exclusive: bool, raw: bool) {
    use aria_audio::output::{OutputConfig, OutputMode, WasapiOutput};

    println!(
        "--- tone 1kHz {} ---",
        if exclusive {
            "EXCLUSIVE"
        } else if raw {
            "shared RAW|MATCH_FORMAT"
        } else {
            "shared"
        }
    );
    /* RAW|MATCH_FORMAT 要求流格式**等于端点原生格式**（否则
       AUDCLNT_E_UNSUPPORTED_FORMAT）。本机端点是 48k，所以 raw 走 48k。
       这本身就是 RAW 的固有代价：它只能在端点原生采样率上比特完美。 */
    let rate: u32 = if raw { 48_000 } else { 44_100 };
    let cfg = OutputConfig {
        mode: if exclusive {
            OutputMode::Exclusive
        } else {
            OutputMode::Shared
        },
        sample_rate: rate,
        channels: 2,
        client_raw: raw,
        ..Default::default()
    };
    let mut out = match WasapiOutput::open(&cfg) {
        Ok(o) => o,
        Err(e) => {
            println!("  open FAILED: {}", e);
            return;
        }
    };
    let buffer = out.available_space_frames().unwrap_or(0) as usize;
    if buffer == 0 {
        println!("  no buffer space");
        return;
    }
    println!(
        "  mode={} format={} buffer={} frames max_chunk={} clock_freq={}",
        out.mode().label(),
        out.sample_format().label(),
        buffer,
        out.max_chunk_frames(),
        match out.audio_clock_frequency() {
            Ok(f) => f.to_string(),
            Err(e) => format!("ERR {}", e),
        }
    );

    /* ★ 预填充用**音调**：如果设备能消费，用户在 Start 后的第一个缓冲时长内
       就该听到声音。用静音预填充的话，"设备好的但没数据可放"和"设备坏了"
       在听感上完全一样。 */
    let mut phase = 0.0f64;
    let mut buf: Vec<f32> = Vec::new();
    tone_into(&mut phase, buffer, rate, 2, &mut buf);
    match out.write_f32(buffer, &buf) {
        Ok(()) => println!("  prefilled {} frames with tone", buffer),
        Err(e) => println!("  prefill FAILED: {}", e),
    }
    if let Err(e) = out.start_unverified() {
        println!("  start FAILED: {}", e);
        return;
    }

    let t0 = Instant::now();
    let mut last_report = 0.0f64;
    let mut wrote_ok = 0usize;
    let mut wrote_err = 0usize;
    let mut first_err: Option<String> = None;
    /* 每 20ms 推一次，节奏不跟 padding 走：即便读数是假的，只要设备在消费，
       写进去的音调就会被播出，用户就能听见。这是"绕过读数、直接验硬件"的关键。 */
    let chunk = (buffer / 4).max(64);
    while t0.elapsed().as_secs_f64() < seconds {
        std::thread::sleep(Duration::from_millis(20));
        tone_into(&mut phase, chunk, rate, 2, &mut buf);
        match out.write_f32(chunk, &buf) {
            Ok(()) => wrote_ok += 1,
            Err(e) => {
                wrote_err += 1;
                if first_err.is_none() {
                    first_err = Some(e.to_string());
                }
            }
        }
        let wall = t0.elapsed().as_secs_f64();
        if wall - last_report >= 1.0 {
            last_report = wall;
            let pad = out.try_padding_frames();
            let clk = out.audio_clock_position();
            println!(
                "  t={:>4.1}s  padding={:<28} clock={:<28} writes ok/err={}/{}",
                wall,
                match pad {
                    Ok(p) => format!("{} / {}", p, buffer),
                    Err(e) => format!("ERR {}", e),
                },
                match clk {
                    Ok(p) => p.to_string(),
                    Err(e) => format!("ERR {}", e),
                },
                wrote_ok,
                wrote_err
            );
        }
    }
    let _ = out.stop();
    if let Some(e) = first_err {
        println!("  first write error: {}", e);
    }
    println!(
        "  done. 听到 1kHz 蜂鸣 = 设备能出声；只听到静音 = 设备真的没在放。"
    );
}

/// 往 `out` 里填 `frames` 帧 1kHz 正弦（交错、`channels` 声道）。
/// 相位跨调用连续，避免每块拼接处爆音（拼接爆音会被误当成"设备工作正常"）。
fn tone_into(phase: &mut f64, frames: usize, rate: u32, channels: usize, out: &mut Vec<f32>) {
    out.clear();
    out.reserve(frames * channels);
    let step = std::f64::consts::TAU * 1000.0 / rate.max(1) as f64;
    /* 0.12 ≈ -18 dBFS：听得清楚，又不至于突然吓人一跳 */
    for _ in 0..frames {
        let v = (*phase).sin() as f32 * 0.12;
        for _ in 0..channels {
            out.push(v);
        }
        *phase += step;
        if *phase > std::f64::consts::TAU {
            *phase -= std::f64::consts::TAU;
        }
    }
}

/* ============================ 空间处理（P2） ============================ */

/** 从命令行取 `--flag value` 的值。 */
fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

/// 档位名 → 表内索引（未知回落 0 = 缺省档）。
/// **与 `src/native_audio.rs` 的 `index_of` 同语义**——两处都错才会错，好排查。
fn idx_of(list: &[&str], name: &str) -> u8 {
    list.iter().position(|n| *n == name).unwrap_or(0) as u8
}

/** 解析 `spatial` 子命令的开关（默认：空间音频开在轻档 + 近场 IR，虚拟声场关）。 */
fn spatial_settings_from(args: &[String]) -> SpatialSettings {
    let level = flag_value(args, "--spatial").unwrap_or("light");
    let ir = flag_value(args, "--ir").unwrap_or("near");
    let stage = flag_value(args, "--stage");
    SpatialSettings {
        spatial_on: true,
        spatial_level: idx_of(&SPATIAL_LEVELS, level),
        ir_index: idx_of(&IR_ORDER, ir),
        stage_on: stage.is_some(),
        stage_level: stage.map(|s| idx_of(&STAGE_LEVELS, s)).unwrap_or(0),
    }
}

/// 空间链的纯 CPU 量化（不碰设备、不出声）。
///
/// 为什么必须有：方案 §2.2 与 §6 都把「Rust 侧时域 FIR 成本」列为唯一风险点，
/// 并明确要求**先量化再决定 IR 长度 / 是否引入 `rustfft`**。没有这个数，
/// 「512 taps 到底吃多少 CPU」只能靠猜——那正是本方案极力避免的那类结论。
fn cmd_spatial_bench() {
    const BLOCK: usize = 480;      // 10ms @48k，贴近引擎实际块长
    const SECONDS: f64 = 20.0;
    println!("--- spatial chain CPU cost (HRTF + M/S stage, both on) ---");
    println!(
        "{:<8} {:<7} {:<6} {:>7} {:>12} {:>10} {:>12}",
        "rate", "spatial", "ir", "taps", "ms/20s", "%1core", "MMAC/s"
    );
    let cases: [(u32, &str, &str); 5] = [
        (44_100, "medium", "near"),
        (48_000, "medium", "near"),
        (48_000, "strong", "hall"),
        (96_000, "strong", "hall"),
        (192_000, "strong", "wide"),
    ];
    let mut worst_pct = 0.0f64;
    for (rate, level, ir) in cases {
        let mut chain = SpatialChain::new(rate);
        chain.apply(&SpatialSettings {
            spatial_on: true,
            spatial_level: idx_of(&SPATIAL_LEVELS, level),
            ir_index: idx_of(&IR_ORDER, ir),
            stage_on: true,
            stage_level: idx_of(&STAGE_LEVELS, "medium"),
        });
        let taps = chain.taps();
        let mut buf = vec![0.0f32; BLOCK * 2];
        /* 填噪声而不是静音：全零输入会被某些编译路径"优化"成不真实的最优时间 */
        let mut seed = 12345u32;
        for v in buf.iter_mut() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = ((seed >> 8) as f32 / 8_388_608.0) - 1.0;
        }
        let blocks = ((rate as f64 * SECONDS) / BLOCK as f64) as usize;
        /* 预热：让平滑收敛、缓存热起来，别把首次冷启动算进去 */
        for _ in 0..100 {
            chain.process_interleaved(&mut buf);
        }
        let t0 = Instant::now();
        for _ in 0..blocks {
            chain.process_interleaved(&mut buf);
        }
        let el = t0.elapsed().as_secs_f64();
        let pct = el / SECONDS * 100.0;
        worst_pct = worst_pct.max(pct);
        /* ★ 真实 MAC 数要用**实际 taps**（重采样后随采样率变化），
           不能写死 IR_TAPS——否则 192k 那行会低估 4 倍。 */
        let macs = (blocks as f64 * BLOCK as f64 * 2.0 * taps as f64) / el.max(1e-9) / 1e6;
        println!(
            "{:<8} {:<7} {:<6} {:>7} {:>12.1} {:>9.2}% {:>12.1}",
            format!("{}k", rate / 1000),
            level,
            ir,
            taps,
            el * 1000.0,
            pct,
            macs
        );
    }
    println!(
        "注：%1core = 处理该采样率实时音频的单核占用；taps 是**重采样后**的 FIR 长度。"
    );
    println!(
        "    ★ 成本 ∝ taps×采样率，而 taps 随采样率线性增长 ⇒ 总成本 ∝ 采样率²：\
         48k→192k 是 16×（{:.1}% 已经是本机最坏情形）。",
        worst_pct
    );
    println!(
        "    ★ 本 bin 默认 opt-level=3；发布版 Aria.exe 是 opt-level=\"s\"。实测两者差异 <5%\
         （FIR 内层循环太简单，编译档位几乎不影响），所以本表可直接当发布版数字用。"
    );
}

fn cmd_devices() {
    match list_output_devices() {
        Ok(list) => {
            println!("output devices: {}", list.len());
            for d in list {
                println!(
                    "  [{}] {}",
                    if d.is_default { "default" } else { "       " },
                    d.name
                );
            }
        }
        Err(e) => {
            println!("FAILED to enumerate devices: {}", e);
            std::process::exit(1);
        }
    }
}

/// 独占能力探测：**这台机器的哪个采样率能独占开**。
/// 这是"用户勾了独占却打不开"唯一能自查的地方——WebView2 里看不到这些信息。
fn cmd_formats(device_index: Option<usize>) {
    let devices = match list_output_devices() {
        Ok(d) => d,
        Err(e) => {
            println!("FAILED to enumerate devices: {}", e);
            std::process::exit(1);
        }
    };
    let picked = match device_index {
        Some(i) => match devices.get(i) {
            Some(d) => d.clone(),
            None => {
                println!("device index {} out of range (0..{})", i, devices.len());
                std::process::exit(2);
            }
        },
        None => devices
            .iter()
            .find(|d| d.is_default)
            .cloned()
            .or_else(|| devices.first().cloned())
            .unwrap_or_else(|| {
                println!("no output device found");
                std::process::exit(1);
            }),
    };
    println!("probing device: {}", picked.name);
    match probe_exclusive_formats(Some(picked.id.as_str()), &PROBE_RATES, 2) {
        Ok(list) if list.is_empty() => {
            println!("  exclusive: NOTHING accepted (device refuses all probe formats)");
        }
        Ok(list) => {
            println!("  exclusive: {} accepted format(s)", list.len());
            for f in list {
                println!(
                    "    {} Hz / {} ch / {}",
                    f.sample_rate,
                    f.channels,
                    f.format.label()
                );
            }
        }
        Err(e) => println!("  exclusive probe FAILED: {}", e),
    }
}

fn run(
    spec: AudioSourceSpec,
    seconds: f64,
    kind: &str,
    eq: Option<(usize, f64)>,
    exclusive: bool,
    no_verify: bool,
    spatial: Option<SpatialSettings>,
) {
    println!("=== aria-audio probe ({}) ===", kind);
    let engine = match AudioEngine::new() {
        Ok(e) => e,
        Err(e) => {
            println!("FAILED to create engine: {}", e);
            std::process::exit(1);
        }
    };

    if exclusive {
        /* ★ 必须在 load 之前 SetOutput：引擎在 load 里读 pending_output 决定
           怎么打开设备。load 之后改等于这一首仍然是共享模式。 */
        engine.set_output(OutputConfig {
            mode: OutputMode::Exclusive,
            /* Some(0) = 跳过端点健康检查；None = 默认预算 */
            exclusive_verify_ms: if no_verify { Some(0) } else { None },
            ..Default::default()
        });
        println!(
            "output mode requested: exclusive (wasapi){}",
            if no_verify {
                " [health check SKIPPED — 声音可能出不来，这一步只为用耳朵判定]"
            } else {
                ""
            }
        );
    } else {
        println!("output mode requested: shared");
    }

    if let Some((band, gain)) = eq {
        if band >= EQ_BAND_COUNT {
            println!("band must be 0..{}", EQ_BAND_COUNT - 1);
            std::process::exit(2);
        }
        let mut settings = EqSettings {
            enabled: true,
            ..Default::default()
        };
        settings.gains_db[band] = gain;
        engine.set_eq(settings);
        println!(
            "EQ: band[{}] = {:.0} Hz set to {:+.1} dB (other bands flat)",
            band, EQ_BANDS[band], gain
        );
    } else {
        println!("EQ: off (default)");
    }

    if let Some(set) = spatial {
        engine.set_spatial(set);
        /* 回声验证：确认设置真的穿过了命令通道（而不只是打印了一行日志） */
        let applied = engine.spatial_settings();
        println!(
            "spatial applied back: spatial_on={} level={} ir={} | stage_on={} level={}",
            applied.spatial_on,
            applied.spatial_level_name(),
            applied.ir_name(),
            applied.stage_on,
            applied.stage_level_name()
        );
    } else {
        println!("spatial: off (default)");
    }

    /* 默认只放一半音量：探针的用途是验证链路，不是听歌。
       满音量突然出声对用户是惊吓，而且掩盖不了任何问题。 */
    let vol = std::env::var("ARIA_PROBE_VOL")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(0.5);
    engine.set_volume(vol);
    println!("volume set to {:.2} (override with ARIA_PROBE_VOL)", vol);

    let t_open = Instant::now();
    let info = match engine.load_blocking(spec, true) {
        Ok(i) => i,
        Err(e) => {
            println!("FAILED to load: {}", e);
            std::process::exit(1);
        }
    };
    /* 回声验证：确认 EQ 设置真的穿过了命令通道（而不只是打印了一行日志） */
    let applied = engine.eq_settings();
    println!(
        "EQ applied back: enabled={} band5(1kHz)={:+.1}dB",
        applied.enabled, applied.gains_db[5]
    );
    println!(
        "loaded in {:.0} ms | {} Hz / {} ch | duration={}",
        t_open.elapsed().as_millis(),
        info.sample_rate,
        info.channels,
        info.duration_sec
            .map(|d| format!("{:.2}s", d))
            .unwrap_or_else(|| "unknown".into())
    );
    /* ★ 回读实际生效的模式与样本格式：请求独占被静默降级的话，
       不打印这一行就永远发现不了（"以为在独占"是最糟的失败姿势）。 */
    let opened = engine.snapshot();
    println!(
        "output in use: {} / {} (requested {})",
        opened.output_mode.label(),
        opened.sample_format.label(),
        if exclusive { "exclusive" } else { "shared" }
    );
    if exclusive && opened.output_mode != OutputMode::Exclusive {
        println!("WARNING: requested exclusive but engine reports shared —— 请求被降级了");
    }

    /* 等第一块数据真正到设备再开始计时，避免把加载耗时算进时钟偏差 */
    std::thread::sleep(Duration::from_millis(400));
    let t0 = Instant::now();
    /* ★ 漂移必须用**增量**比：拿绝对位置直接减墙钟，会把"起播那一刻
       位置已经不是 0"当成误差（实测因此凭空多出 375ms，看着像引擎坏了，
       其实只是测量方式错了）。正确口径是：
           引擎位置增量  ==  墙钟增量
       —— 这两者都是"从 t0 起算"，才可比。 */
    let pos_at_t0 = engine.snapshot().position_sec;
    let mut max_drift_ms = 0.0f64;
    let mut last_report = 0.0f64;

    while t0.elapsed().as_secs_f64() < seconds {
        std::thread::sleep(Duration::from_millis(200));
        let s = engine.snapshot();
        let wall = t0.elapsed().as_secs_f64();
        let drift_ms = ((s.position_sec - pos_at_t0) - wall) * 1000.0;
        if s.position_sec > 0.01 {
            max_drift_ms = max_drift_ms.max(drift_ms.abs());
        }
        if wall - last_report >= 1.0 {
            last_report = wall;
            println!(
                "t={:>5.1}s  pos={:>7.2}s  buffered={:>6} frames  underruns={}  drift={:>7.1}ms{}",
                wall,
                s.position_sec,
                s.buffered_frames,
                s.underruns,
                drift_ms,
                if s.ended { "  [ENDED]" } else { "" }
            );
        }
        if let Some(err) = &s.last_error {
            println!("engine error: {}", err);
            break;
        }
        if s.ended {
            break;
        }
    }

    /* 收尾：验证暂停→恢复与 seek 不会炸掉引擎 */
    println!("--- pause/resume check ---");
    engine.pause();
    std::thread::sleep(Duration::from_millis(300));
    let p1 = engine.snapshot().position_sec;
    std::thread::sleep(Duration::from_millis(300));
    let p2 = engine.snapshot().position_sec;
    println!(
        "paused at {:.3}s -> {:.3}s (drift while paused {:.1}ms, should be ~0)",
        p1,
        p2,
        (p2 - p1) * 1000.0
    );
    engine.play();
    std::thread::sleep(Duration::from_millis(300));
    let p3 = engine.snapshot().position_sec;
    println!("resumed -> {:.3}s (advanced {:.1}ms)", p3, (p3 - p2) * 1000.0);

    println!("--- seek check ---");
    engine.seek(30.0);
    std::thread::sleep(Duration::from_millis(500));
    let s = engine.snapshot();
    println!(
        "after seek(30s): pos={:.2}s  decoded={}  err={:?}",
        s.position_sec, s.decoding, s.last_error
    );

    let final_snap = engine.snapshot();
    println!(
        "=== done | max |drift| = {:.1} ms | underruns = {} ===",
        max_drift_ms, final_snap.underruns
    );
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(200));
}
