//! 音频源：把「从哪儿读字节」从解码逻辑里隔离出来。
//!
//! 两条来源，最终都表现为一个 `Read + Seek` 的字节流：
//!   · `File` —— 本地音乐 / 已落盘的在线缓存（`cache/audio/<id>.mp3`）
//!   · `Http` —— 在线流，走本机后端代理 `/api/audio/stream?url=&songId=`
//!
//! ★ 为什么在线流也要让 Rust 读**本机**代理而不是直连上游：
//!   取链、Referer 防盗链、Q Q系 CDN 的 TLS 风控、CORS，全部已经在 Python
//!   后端处理完了（server.py `_handle_audio_stream` 还顺带落盘缓存 + 支持
//!   Range 续传）。Rust 侧直连上游等于把这一整套重新实现一遍，而且会绕过
//!   缓存、把同一首歌下载两次。走 127.0.0.1 是零音源特定逻辑的唯一解。
//!
//! seek 的实现方式：HTTP 源不支持真 seek，只能**断开重连 + Range 头**
//!   重新发起请求。这在本机回环上是毫秒级操作，且后端对已缓存区间直接
//!   本地直读（server.py 的 `.tmp` 直读分支），所以拖拽体验不受影响。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::{AudioError, Result};

/// 音频来源描述。前端只需要给出这个，不关心底下怎么读。
#[derive(Debug, Clone)]
pub enum AudioSourceSpec {
    /// 本地文件路径。也覆盖「本地音乐」与「已完整落盘的在线缓存」。
    File(PathBuf),
    /// 在线流：交给本机后端代理拉取（含 Range 透传）。
    /// `song_id` 同时用作后端缓存键，必须与实际播放链一致，否则会重复下载。
    Http { url: String, song_id: String, base: String },
}

impl AudioSourceSpec {
    pub fn file<P: AsRef<Path>>(p: P) -> Self {
        AudioSourceSpec::File(p.as_ref().to_path_buf())
    }

    /// 构造在线流来源。`base` 形如 `http://127.0.0.1:8001`。
    pub fn http(base: &str, raw_url: &str, song_id: &str) -> Self {
        AudioSourceSpec::Http {
            url: raw_url.to_string(),
            song_id: song_id.to_string(),
            base: base.trim_end_matches('/').to_string(),
        }
    }

    /// 供日志/诊断用的短描述（不含完整外链，避免把防盗链参数写进日志）。
    pub fn label(&self) -> String {
        match self {
            AudioSourceSpec::File(p) => format!("file:{}", p.display()),
            AudioSourceSpec::Http { song_id, .. } => format!("http:song={}", song_id),
        }
    }
}

/// 统一的字节流接口。
/// ★ 必须凑齐 `Read + Seek + Send + Sync` 四个 bound：symphonia 的
///   `MediaSource` 要求 `Send + Sync`（它的探测/解码可能跨线程持有），
///   少一个 Sync 就会在 `impl MediaSource` 那一行报错，而错误信息指向
///   "dyn ByteStream cannot be shared"，很容易误判成自己的实现有问题。
pub trait ByteStream: Read + Seek + Send + Sync {
    /// 总字节数；未知（chunked 无长度）时返回 None。
    fn byte_len(&self) -> Option<u64>;
    /// 是否支持随机访问。不支持时 symphonia 会退化为顺序解码，seek 由上层模拟。
    fn is_seekable(&self) -> bool;
}

/* ---------------- 本地文件 ---------------- */

pub struct FileStream {
    file: File,
    len: u64,
}

impl FileStream {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(|e| {
            AudioError::SourceFailed(format!("open {}: {}", path.display(), e))
        })?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self { file, len })
    }
}

impl Read for FileStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for FileStream {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.file.seek(pos)
    }
}

impl ByteStream for FileStream {
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
    fn is_seekable(&self) -> bool {
        true
    }
}

/* ---------------- 在线流（本机代理） ---------------- */

/// 通过本机后端读取在线音频。
///
/// ★ 这里刻意**没有**做流式边读边播：`ureq` 是阻塞式 HTTP 客户端，而
///   symphonia 的探测需要先读到足够字节。第一版直接一次性把整首读进内存
///   （3~10MB，可接受），换来的是「seek 零延迟 + 时长精确 + 不依赖连接存活」。
///   后续如果要做「秒开长音频」，再换成流式 reader —— 那属于优化，不是正确性。
///   注意：后端 `/api/audio/stream` 无论带不带 Range 都向上游拉全曲并落盘，
///   所以这里读完整首同时也**把缓存预热了**，第二次播放直接命中本地文件。
pub struct HttpStream {
    data: Vec<u8>,
    pos: u64,
    len: u64,
}

impl HttpStream {
    pub fn open(base: &str, raw_url: &str, song_id: &str) -> Result<Self> {
        let target = format!(
            "{}/api/audio/stream?url={}&songId={}",
            base.trim_end_matches('/'),
            urlencode(raw_url),
            urlencode(song_id)
        );
        let resp = ureq::get(&target)
            .timeout(std::time::Duration::from_secs(60))
            .call()
            .map_err(|e| AudioError::SourceFailed(format!("stream request failed: {}", e)))?;
        let mut data = Vec::new();
        resp.into_reader()
            .read_to_end(&mut data)
            .map_err(|e| AudioError::SourceFailed(format!("stream read failed: {}", e)))?;
        if data.is_empty() {
            return Err(AudioError::SourceFailed("stream returned empty body".into()));
        }
        let len = data.len() as u64;
        Ok(Self {
            data,
            pos: 0,
            len,
        })
    }
}

impl Read for HttpStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let start = self.pos as usize;
        if start >= self.data.len() {
            return Ok(0);
        }
        let end = (start + buf.len()).min(self.data.len());
        let n = end - start;
        buf[..n].copy_from_slice(&self.data[start..end]);
        self.pos = end as u64;
        Ok(n)
    }
}

impl Seek for HttpStream {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        /* 数据已在内存，seek 是纯粹的游标移动——这是上面「一次性读完整首」
           换来的好处：symphonia 的所有 seek 请求都变成零成本。 */
        let np = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        self.pos = np.clamp(0, self.len as i64) as u64;
        Ok(self.pos)
    }
}

impl ByteStream for HttpStream {
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
    fn is_seekable(&self) -> bool {
        true
    }
}

/* ---------------- 打开 ---------------- */

pub fn open(spec: &AudioSourceSpec) -> Result<Box<dyn ByteStream>> {
    match spec {
        AudioSourceSpec::File(p) => Ok(Box::new(FileStream::open(p)?)),
        AudioSourceSpec::Http {
            base,
            url,
            song_id,
        } => Ok(Box::new(HttpStream::open(base, url, song_id)?)),
    }
}

/// 最小百分号编码（只编码非 unreserved 字符）。
/// 不引第三方 url 库：这里只需要保证 `?` `&` `=` `#` ` ` 等不会破坏查询串。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_escapes_query_breakers() {
        assert_eq!(urlencode("a b&c=d?e#f"), "a%20b%26c%3Dd%3Fe%23f");
        assert_eq!(urlencode("http://x/y.mp3"), "http%3A%2F%2Fx%2Fy.mp3");
        /* unreserved 字符必须原样保留，否则后端拿到的 url 与原链不等价 */
        assert_eq!(urlencode("aZ0-_.~"), "aZ0-_.~");
    }

    #[test]
    fn http_stream_seeks_within_memory() {
        let mut s = HttpStream {
            data: (0u8..=99).collect(),
            pos: 0,
            len: 100,
        };
        let mut head = [0u8; 4];
        s.read_exact(&mut head).unwrap();
        assert_eq!(head, [0, 1, 2, 3]);
        s.seek(SeekFrom::Start(50)).unwrap();
        let mut one = [0u8; 1];
        s.read_exact(&mut one).unwrap();
        assert_eq!(one[0], 50);
        /* End 负偏移与越界钳制 */
        assert_eq!(s.seek(SeekFrom::End(-10)).unwrap(), 90);
        assert_eq!(s.seek(SeekFrom::Start(9999)).unwrap(), 100);
        let mut tail = [0u8; 4];
        assert_eq!(s.read(&mut tail).unwrap(), 0);
    }
}
