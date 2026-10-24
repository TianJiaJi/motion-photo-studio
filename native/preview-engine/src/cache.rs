//! RGBA LRU, scoped to one reader/source/color. Size variants share one byte/entry budget.
//! Keep drag and settled resolutions across gestures; drop the reader to invalidate its namespace.
use crate::media::Frame;
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};

pub const PRIMARY_BYTES: usize = 208 * 1024 * 1024;
pub const THUMBNAIL_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 512;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes: usize,
    pub entries: usize,
    pub budget: usize,
    pub hits: u64,
    pub misses: u64,
}
type CacheKey = (i64, u32, u32);
pub struct FrameCache {
    frames: BTreeMap<CacheKey, Frame>,
    recent: VecDeque<CacheKey>,
    bytes: usize,
    budget: usize,
    hits: u64,
    misses: u64,
}
impl FrameCache {
    pub fn new(budget: usize) -> Self {
        Self {
            frames: BTreeMap::new(),
            recent: VecDeque::new(),
            bytes: 0,
            budget,
            hits: 0,
            misses: 0,
        }
    }
    pub fn get(&mut self, timestamp: i64, width: u32, height: u32) -> Option<Frame> {
        let key = (timestamp, width, height);
        if let Some(frame) = self.frames.get(&key).cloned() {
            self.hits = self.hits.saturating_add(1);
            self.recent.retain(|&item| item != key);
            self.recent.push_back(key);
            Some(frame)
        } else {
            self.misses = self.misses.saturating_add(1);
            None
        }
    }
    pub fn insert(&mut self, frame: Frame) {
        if frame.rgba.len() > self.budget {
            return;
        }
        let key = (frame.timestamp_hns, frame.width, frame.height);
        if let Some(previous) = self.frames.remove(&key) {
            self.bytes -= previous.rgba.len();
        }
        self.recent.retain(|&item| item != key);
        while self.bytes + frame.rgba.len() > self.budget || self.frames.len() >= MAX_ENTRIES {
            let Some(oldest) = self.recent.pop_front() else {
                break;
            };
            if let Some(old) = self.frames.remove(&oldest) {
                self.bytes -= old.rgba.len();
            }
        }
        self.bytes += frame.rgba.len();
        self.frames.insert(key, frame);
        self.recent.push_back(key);
    }
    pub fn clear(&mut self) {
        self.frames.clear();
        self.recent.clear();
        self.bytes = 0;
    }
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            bytes: self.bytes,
            entries: self.frames.len(),
            budget: self.budget,
            hits: self.hits,
            misses: self.misses,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(stamp: i64, bytes: usize) -> Frame {
        Frame {
            timestamp_hns: stamp,
            duration_hns: 1,
            width: 1,
            height: 1,
            rgba: vec![0; bytes].into(),
        }
    }
    #[test]
    fn accounts_bytes_deduplicates_and_evicts_lru() {
        let mut cache = FrameCache::new(12);
        cache.insert(frame(1, 4));
        cache.insert(frame(2, 4));
        cache.insert(frame(3, 4));
        assert!(cache.get(1, 1, 1).is_some());
        cache.insert(frame(4, 4));
        assert!(cache.get(2, 1, 1).is_none());
        assert_eq!(cache.stats().bytes, 12);
        cache.insert(frame(1, 8));
        assert_eq!(cache.stats().bytes, 12);
        cache.insert(frame(9, 16));
        assert_eq!(cache.stats().bytes, 12);
        cache.clear();
        assert_eq!(cache.stats().bytes, 0);
    }
    #[test]
    fn size_variants_are_distinct_and_share_one_budget() {
        let mut cache = FrameCache::new(20);
        cache.insert(frame(7, 4));
        let mut large = frame(7, 16);
        large.width = 2;
        large.height = 2;
        cache.insert(large);
        assert_eq!(cache.get(7, 1, 1).map(|frame| frame.rgba.len()), Some(4));
        assert_eq!(cache.get(7, 2, 2).map(|frame| frame.rgba.len()), Some(16));
        assert!(cache.get(7, 3, 3).is_none());
        assert_eq!(cache.stats().bytes, 20);
        cache.insert(frame(8, 4));
        assert!(cache.get(7, 1, 1).is_none());
        assert!(cache.get(7, 2, 2).is_some());
        assert_eq!(cache.stats().bytes, 20);
        cache.clear();
        assert_eq!(cache.stats().bytes, 0);
    }
    #[test]
    fn tiny_frames_cannot_grow_metadata_indefinitely() {
        let mut cache = FrameCache::new(1024 * 1024);
        for stamp in 0..2000 {
            cache.insert(frame(stamp, 4));
        }
        assert_eq!(cache.stats().entries, MAX_ENTRIES);
        assert_eq!(cache.stats().bytes, MAX_ENTRIES * 4);
    }
}
