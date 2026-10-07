//! 解码线程 ↔ 输出线程之间的帧队列。
//!
//! 为什么不用无锁 ring buffer：音频块的粒度是 10~20ms（几百到几千个样本），
//! 一次锁的竞争窗口是微秒级，而真正的成本在解码和写入设备。这里刻意选
//! `Mutex`，换来的是**可读的正确性**——音频正确性 bug 的代价（爆音/断流/
//! 时钟漂移）远高于这点锁开销。
//!
//! 两端都是**非阻塞**的，这是本模块最重要的设计决定：
//!   · 消费者（输出线程）绝不能阻塞。实时线程等在锁上 = 可听见的卡顿；
//!     取不到数据就写静音，并记一次 underrun，让上层能诊断到底是
//!     "缓冲太小"还是"解码太慢"还是"上游断流"。
//!   · 生产者（解码线程）也不阻塞。它除了填数据还要响应 seek/换曲/暂停，
//!     若在满队列上等待，一条 seek 要等最多一个队列周期（秒级）才被看到，
//!     用户会感觉"拖了进度条，声音过一会儿才跳"。
//!     代价是解码线程在队列满时要用 sleep 轮询——几毫秒一次的轻量循环，
//!     换来的是毫秒级的命令响应。

use std::collections::VecDeque;
use std::sync::Mutex;

pub struct SampleRing {
    inner: Mutex<Inner>,
    channels: usize,
    cap_samples: usize,
}

struct Inner {
    buf: VecDeque<f32>,
    closed: bool,
    /// 因队列空而写入静音的帧数（诊断：持续增长说明供给跟不上）
    underrun_frames: u64,
}

impl SampleRing {
    pub fn new(channels: usize, cap_frames: usize) -> Self {
        let channels = channels.max(1);
        Self {
            inner: Mutex::new(Inner {
                buf: VecDeque::with_capacity(cap_frames * channels),
                closed: false,
                underrun_frames: 0,
            }),
            channels,
            cap_samples: cap_frames * channels,
        }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// 队列容量（帧）。
    pub fn capacity_frames(&self) -> usize {
        self.cap_samples / self.channels
    }

    /// 当前可读帧数。
    pub fn available_frames(&self) -> usize {
        let g = self.inner.lock().unwrap();
        g.buf.len() / self.channels
    }

    /// 生产者写入**一部分**（非阻塞），返回写入的**帧数**。
    /// 返回 0 有两种含义：队列满，或已关闭——调用方据 `is_closed()` 区分。
    ///
    /// 样本数不是声道数的整数倍时向下取整，丢掉尾部零头：半帧数据写进去会让
    /// 后续所有帧的声道错位（左右互换），比丢一个样本糟得多。
    pub fn push_some(&self, samples: &[f32]) -> usize {
        let usable = samples.len() - (samples.len() % self.channels);
        if usable == 0 {
            return 0;
        }
        let mut g = self.inner.lock().unwrap();
        if g.closed {
            return 0;
        }
        let free = self.cap_samples.saturating_sub(g.buf.len());
        if free == 0 {
            return 0;
        }
        let take = free.min(usable);
        g.buf.extend(samples[..take].iter().copied());
        take / self.channels
    }

    /// 消费者读取（非阻塞）。不足部分**填 0（静音）**，返回值是真正取到的帧数。
    pub fn pop_into(&self, out: &mut [f32]) -> usize {
        let mut g = self.inner.lock().unwrap();
        let want = out.len().min(self.cap_samples);
        let mut got = 0usize;
        for slot in out.iter_mut().take(want) {
            match g.buf.pop_front() {
                Some(v) => *slot = v,
                None => break,
            }
            got += 1;
        }
        if got < want {
            for slot in out[got..want].iter_mut() {
                *slot = 0.0;
            }
            g.underrun_frames += ((want - got) / self.channels) as u64;
        }
        got / self.channels
    }

    /// 清空（seek / 换曲）：丢弃尚未播出的样本，
    /// 避免旧位置的声音在新位置上漏出来。
    pub fn clear(&self) {
        let mut g = self.inner.lock().unwrap();
        g.buf.clear();
        g.underrun_frames = 0;
    }

    pub fn underrun_frames(&self) -> u64 {
        self.inner.lock().unwrap().underrun_frames
    }

    pub fn is_closed(&self) -> bool {
        self.inner.lock().unwrap().closed
    }

    /// 关闭：让所有轮询中的生产者/消费者尽快退出（引擎停机时必需，
    /// 否则解码线程会一直往一个没人消费的队列里灌数据）。
    pub fn close(&self) {
        let mut g = self.inner.lock().unwrap();
        g.closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_and_pop_roundtrip() {
        let r = SampleRing::new(2, 4); // 4 帧容量
        assert_eq!(r.push_some(&[1.0, 2.0, 3.0, 4.0]), 2);
        assert_eq!(r.available_frames(), 2);
        let mut out = [0.0f32; 4];
        assert_eq!(r.pop_into(&mut out), 2);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn pop_fills_silence_and_counts_underrun() {
        let r = SampleRing::new(2, 4);
        r.push_some(&[5.0, 6.0]);
        let mut out = [9.0f32; 6]; // 要 3 帧，只有 1 帧
        assert_eq!(r.pop_into(&mut out), 1);
        assert_eq!(out, [5.0, 6.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(r.underrun_frames(), 2);
    }

    #[test]
    fn push_some_stops_at_capacity_without_blocking() {
        let r = SampleRing::new(2, 2);
        /* 容量 2 帧，一次给 3 帧：只写 2 帧，剩余丢弃由调用方重试 */
        assert_eq!(r.push_some(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 2);
        assert_eq!(r.push_some(&[7.0, 8.0]), 0);
    }

    #[test]
    fn odd_trailing_sample_is_dropped_not_misaligned() {
        let r = SampleRing::new(2, 4);
        /* 5 个样本 = 2.5 帧 → 只接受 2 帧，绝不写半个帧 */
        assert_eq!(r.push_some(&[1.0, 2.0, 3.0, 4.0, 5.0]), 2);
        let mut out = [0.0f32; 4];
        assert_eq!(r.pop_into(&mut out), 2);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn clear_resets_underrun_and_buffer() {
        let r = SampleRing::new(2, 4);
        r.push_some(&[1.0, 2.0]);
        let mut out = [0.0f32; 4];
        r.pop_into(&mut out);
        assert!(r.underrun_frames() > 0);
        r.clear();
        assert_eq!(r.available_frames(), 0);
        assert_eq!(r.underrun_frames(), 0);
    }

    #[test]
    fn closed_ring_rejects_writes() {
        let r = SampleRing::new(2, 4);
        r.close();
        assert!(r.is_closed());
        assert_eq!(r.push_some(&[1.0, 2.0]), 0);
    }
}
