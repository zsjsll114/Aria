//! 引擎错误类型。
//!
//! 设计取向：**错误分类要能指导动作**，不是给日志看的花瓶。
//! 调用方（Tauri 命令层 / 前端）需要区分的是：
//!   · DeviceUnavailable —— 设备没了（拔耳机），应回退默认设备重试
//!   · FormatUnsupported —— 该格式设备不收，应降级重采样或退回共享模式
//!   · SourceFailed —— 音频源有问题（404/解码失败），重试无意义，换源
//!   · Busy —— 上一轮还没收尾（独占流未释放），等一拍再试
//! 全部 `Send + Sync` 且可跨 IPC 序列化（前端只拿到字符串）。

use std::fmt;

#[derive(Debug)]
pub enum AudioError {
    /// 没有可用的输出设备（无默认设备 / 设备被禁用 / 拔掉了）
    DeviceUnavailable(String),
    /// 设备拒绝该格式（独占模式最常见的失败）
    FormatUnsupported(String),
    /// 音频源不可用：打不开、找不到、HTTP 失败、解码器不认这个容器
    SourceFailed(String),
    /// 端点忙：上一个流还占着（独占模式必须可靠释放，否则锁死用户设备）
    Busy(String),
    /// COM / WASAPI 原始 HRESULT
    Wasapi(String),
    /// 其他（含内部不变量被破坏）
    Internal(String),
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AudioError::DeviceUnavailable(m) => write!(f, "device-unavailable: {}", m),
            AudioError::FormatUnsupported(m) => write!(f, "format-unsupported: {}", m),
            AudioError::SourceFailed(m) => write!(f, "source-failed: {}", m),
            AudioError::Busy(m) => write!(f, "busy: {}", m),
            AudioError::Wasapi(m) => write!(f, "wasapi: {}", m),
            AudioError::Internal(m) => write!(f, "internal: {}", m),
        }
    }
}

impl std::error::Error for AudioError {}

impl From<wasapi::WasapiError> for AudioError {
    fn from(e: wasapi::WasapiError) -> Self {
        /* ★ 把 HRESULT 转成十进制/十六进制一起留痕：AUDCLNT_E_* 系列的错误码
           是判断"设备被独占/格式不被支持/端点失效"的唯一线索，只写 Debug
           会把排查信息丢掉。 */
        match e {
            wasapi::WasapiError::Windows(w) => {
                let code = w.code().0 as u32;
                let hint = match code {
                    0x8889_0001 => " (AUDCLNT_E_NOT_INITIALIZED)",
                    0x8889_0002 => " (AUDCLNT_E_ALREADY_INITIALIZED)",
                    0x8889_0003 => " (AUDCLNT_E_WRONG_ENDPOINT_TYPE)",
                    0x8889_0004 => " (AUDCLNT_E_DEVICE_INVALIDATED)",
                    0x8889_0005 => " (AUDCLNT_E_NOT_STOPPED)",
                    0x8889_0006 => " (AUDCLNT_E_BUFFER_TOO_LARGE)",
                    0x8889_0007 => " (AUDCLNT_E_OUT_OF_ORDER)",
                    0x8889_0008 => " (AUDCLNT_E_UNSUPPORTED_FORMAT)",
                    0x8889_0009 => " (AUDCLNT_E_INVALID_SIZE)",
                    0x8889_000B => " (AUDCLNT_E_DEVICE_IN_USE)",
                    0x8889_000C => " (AUDCLNT_E_BUFFER_OPERATION_PENDING)",
                    0x8889_0010 => " (AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED)",
                    0x8889_0012 => " (AUDCLNT_E_BUFDURATION_PERIOD_NOT_EQUAL)",
                    0x8889_0013 => " (AUDCLNT_E_EXCLUSIVE_MODE_ONLY)",
                    _ => "",
                };
                AudioError::Wasapi(format!("HRESULT {:#010x}{}", code, hint))
            }
            other => AudioError::Wasapi(format!("{:?}", other)),
        }
    }
}

impl From<symphonia::core::errors::Error> for AudioError {
    fn from(e: symphonia::core::errors::Error) -> Self {
        AudioError::SourceFailed(format!("{:?}", e))
    }
}

impl From<std::io::Error> for AudioError {
    fn from(e: std::io::Error) -> Self {
        AudioError::SourceFailed(format!("io: {}", e))
    }
}

pub type Result<T> = std::result::Result<T, AudioError>;
