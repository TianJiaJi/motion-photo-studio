//! Windows-only Media Foundation adapter. COM objects never cross apartment threads.
use crate::{
    AppResult,
    pixels::{self, Aperture, Layout},
};
use serde::Serialize;
use std::{path::Path, ptr};
use windows::{
    Win32::{
        Foundation::HMODULE,
        Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*},
        Media::MediaFoundation::*,
        System::Com::{
            COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, StructuredStorage::PROPVARIANT,
        },
    },
    core::{GUID, HSTRING, Interface},
};

pub const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
pub const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
const ALL: u32 = MF_SOURCE_READER_ALL_STREAMS.0 as u32;

pub struct Runtime;
impl Runtime {
    pub fn new() -> AppResult<Self> {
        // SAFETY: one balanced COM/MF initialization on this thread; no external pointers.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: callers drop readers/audio objects before the thread-local runtime.
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

pub fn attributes() -> AppResult<IMFAttributes> {
    let mut value = None;
    // SAFETY: initialized out-pointer, owned COM return.
    unsafe {
        MFCreateAttributes(&mut value, 8)?;
    }
    value.ok_or_else(|| "MFCreateAttributes returned null".into())
}

pub struct Reader {
    // Field order: reader releases before its backing stream.
    pub reader: IMFSourceReader,
    _stream: IMFByteStream,
    _device: Option<ID3D11Device>,
    _manager: Option<IMFDXGIDeviceManager>,
}
impl Reader {
    pub fn open(path: &str, attrs: &IMFAttributes, gpu: bool) -> AppResult<Self> {
        let supplied = Path::new(path);
        if path.len() > 32760
            || path.contains('\0')
            || !supplied.is_absolute()
            || path.starts_with("\\\\")
        {
            return Err("only absolute local drive paths are accepted".into());
        }
        if !std::fs::metadata(supplied)?.is_file() {
            return Err("source is not a regular file".into());
        }
        let mut device = None;
        let mut manager = None;
        // SAFETY: checked local path; file byte stream is read-only, never URL/network resolution.
        unsafe {
            if gpu {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                )?;
                let d = device.as_ref().ok_or("D3D11 returned no device")?;
                let multithread: ID3D11Multithread = d.cast()?;
                let _ = multithread.SetMultithreadProtected(true);
                let mut token = 0;
                MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                let m = manager.as_ref().ok_or("MF returned no device manager")?;
                m.ResetDevice(d, token)?;
                attrs.SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, m)?;
            }
            let stream = MFCreateFile(
                MF_ACCESSMODE_READ,
                MF_OPENMODE_FAIL_IF_NOT_EXIST,
                MF_FILEFLAGS_NONE,
                &HSTRING::from(path),
            )?;
            let reader = MFCreateSourceReaderFromByteStream(&stream, attrs)?;
            reader.SetStreamSelection(ALL, false)?;
            Ok(Self {
                reader,
                _stream: stream,
                _device: device,
                _manager: manager,
            })
        }
    }
    pub fn seek(&self, time_us: u64) -> AppResult<()> {
        let hns = i64::try_from(time_us.checked_mul(10).ok_or("seek overflow")?)?;
        self.seek_hns(hns)
    }
    pub fn seek_hns(&self, hns: i64) -> AppResult<()> {
        if hns < 0 {
            return Err("negative seek time".into());
        }
        // SAFETY: source reader belongs to this thread; scalar PROPVARIANT owns no pointers.
        unsafe {
            self.reader.Flush(ALL)?;
            self.reader
                .SetCurrentPosition(&GUID::zeroed(), &PROPVARIANT::from(hns))?;
        }
        Ok(())
    }
    pub fn sample(&self, stream: u32) -> AppResult<Option<(IMFSample, i64)>> {
        for _ in 0..256 {
            let mut sample = None;
            let mut flags = 0;
            let mut timestamp = 0;
            // SAFETY: all out-parameters are initialized stack storage.
            unsafe {
                self.reader.ReadSample(
                    stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )?;
            }
            // A reader may announce negotiated stride/color attributes on its first sample.
            // Consumers validate the current decoded format before using each buffer; the flag
            // alone is not a reason to reject an otherwise unchanged pixel/audio layout.
            if let Some(sample) = sample {
                return Ok(Some((sample, timestamp)));
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return Ok(None);
            }
        }
        Err("source produced no sample within bounded reads".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub d3d_enabled: bool,
    // A D3D manager request is not proof that the decoder itself ran on the GPU.
    pub hardware_decode_verified: bool,
    pub fallback_reason: Option<String>,
    pub has_audio: bool,
    pub matrix709: bool,
    pub full_range: bool,
}
#[derive(Clone)]
pub struct Frame {
    pub timestamp_hns: i64,
    pub duration_hns: i64,
    pub width: u32,
    pub height: u32,
    pub rgba: std::sync::Arc<[u8]>,
}
pub struct Video {
    pub source: Reader,
    pub info: VideoInfo,
    stride: i32,
    layout: Layout,
    cache: crate::cache::FrameCache,
    decoded_position: Option<i64>,
    displayed_position: Option<i64>,
    seek_origin: i64,
    seeks: u64,
    decoded_samples: u64,
}
impl Video {
    pub fn open(
        path: &str,
        maximum_edge: u32,
        matrix_override: Option<bool>,
        range_override: Option<bool>,
    ) -> AppResult<Self> {
        if !(64..=1280).contains(&maximum_edge) {
            return Err("invalid preview size".into());
        }
        match Self::open_with(path, maximum_edge, true, matrix_override, range_override) {
            Ok(video) => Ok(video),
            Err(hardware) => {
                let mut video =
                    Self::open_with(path, maximum_edge, false, matrix_override, range_override)?;
                video.info.fallback_reason = Some(hardware.to_string());
                Ok(video)
            }
        }
    }
    fn open_with(
        path: &str,
        edge: u32,
        gpu: bool,
        matrix_override: Option<bool>,
        range_override: Option<bool>,
    ) -> AppResult<Self> {
        let attrs = attributes()?;
        // SAFETY: attributes and media types are owned objects, dimensions are bounded below.
        unsafe {
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, u32::from(gpu))?;
            let source = Reader::open(path, &attrs, gpu)?;
            let native = source.reader.GetNativeMediaType(VIDEO, 0)?;
            let size = native.GetUINT64(&MF_MT_FRAME_SIZE)?;
            let sw = (size >> 32) as u32;
            let sh = size as u32;
            if sw == 0 || sh == 0 || sw > 8192 || sh > 8192 {
                return Err("unsupported source dimensions".into());
            }
            let aperture = display_aperture(&native, sw, sh)?;
            let scale = f64::min(
                1.0,
                edge as f64 / aperture.width.max(aperture.height) as f64,
            );
            let w = ((aperture.width as f64 * scale) as u32 / 2 * 2).max(2);
            let h = ((aperture.height as f64 * scale) as u32 / 2 * 2).max(2);
            let matrix = native.GetUINT32(&MF_MT_YUV_MATRIX).unwrap_or(0);
            if ![
                0,
                MFVideoTransferMatrix_BT601.0 as u32,
                MFVideoTransferMatrix_BT709.0 as u32,
            ]
            .contains(&matrix)
            {
                return Err("preview requires import color normalization".into());
            }
            let transfer = native.GetUINT32(&MF_MT_TRANSFER_FUNCTION).unwrap_or(0);
            if transfer == MFVideoTransFunc_2084.0 as u32
                || transfer == MFVideoTransFunc_HLG.0 as u32
            {
                return Err("HDR preview requires consent and import normalization".into());
            }
            // The host's import probe preserves container/VUI color tags which some MF
            // compressed media types omit. No renderer-supplied color policy is accepted.
            let matrix709 =
                matrix_override.unwrap_or(matrix == MFVideoTransferMatrix_BT709.0 as u32);
            let full_range = range_override.unwrap_or(
                native.GetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE).unwrap_or(0)
                    == MFNominalRange_0_255.0 as u32,
            );
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            // Native YUV avoids unspecified driver RGB range/matrix defaults. Only the
            // selected sample is read back and scaled/converted under our explicit policy.
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            source.reader.SetStreamSelection(VIDEO, true)?;
            source.reader.SetCurrentMediaType(VIDEO, None, &output)?;
            let actual = source.reader.GetCurrentMediaType(VIDEO)?;
            let size = actual.GetUINT64(&MF_MT_FRAME_SIZE)?;
            let coded_width = (size >> 32) as usize;
            let coded_height = size as u32 as usize;
            if coded_width == 0 || coded_height == 0 || coded_width > 8192 || coded_height > 8192 {
                return Err("invalid decoder dimensions".into());
            }
            let stride = actual
                .GetUINT32(&MF_MT_DEFAULT_STRIDE)
                .unwrap_or(coded_width as u32) as i32;
            Ok(Self {
                info: VideoInfo {
                    width: w,
                    height: h,
                    source_width: aperture.width as u32,
                    source_height: aperture.height as u32,
                    d3d_enabled: gpu,
                    hardware_decode_verified: false,
                    fallback_reason: None,
                    has_audio: source.reader.GetNativeMediaType(AUDIO, 0).is_ok(),
                    matrix709,
                    full_range,
                },
                source,
                stride,
                cache: crate::cache::FrameCache::new(crate::cache::PRIMARY_BYTES),
                decoded_position: None,
                displayed_position: None,
                seek_origin: 0,
                seeks: 0,
                decoded_samples: 0,
                layout: Layout {
                    coded_width,
                    coded_height,
                    stride: stride.max(0) as usize,
                    aperture,
                    matrix709,
                    full_range,
                },
            })
        }
    }
    pub fn invalidate_position(&mut self) {
        self.decoded_position = None;
        self.displayed_position = None;
        self.cache.clear();
    }
    pub fn cache_budget(&mut self, bytes: usize) {
        self.cache = crate::cache::FrameCache::new(bytes);
    }
    pub fn resize(&mut self, edge: u32) -> AppResult<()> {
        if !(64..=1280).contains(&edge) {
            return Err("invalid preview size".into());
        }
        let a = self.layout.aperture;
        let scale = f64::min(1.0, f64::from(edge) / a.width.max(a.height) as f64);
        let width = ((a.width as f64 * scale) as u32 / 2 * 2).max(2);
        let height = ((a.height as f64 * scale) as u32 / 2 * 2).max(2);
        // Cached size variants share the same global budget. Changing display quality must
        // not discard all drag-resolution frames at every mouseup/new gesture.
        self.info.width = width;
        self.info.height = height;
        Ok(())
    }
    pub fn stats(&self) -> serde_json::Value {
        serde_json::json!({"cache": self.cache.stats(), "seeks": self.seeks, "decodedSamples": self.decoded_samples})
    }
    fn sample(&mut self) -> AppResult<Option<(IMFSample, i64)>> {
        let result = self.source.sample(VIDEO)?;
        if let Some((_, timestamp)) = &result {
            self.decoded_position = Some(*timestamp);
            self.decoded_samples = self.decoded_samples.saturating_add(1);
        }
        Ok(result)
    }
    fn remember(&mut self, frame: Frame) -> Frame {
        self.displayed_position = Some(frame.timestamp_hns);
        self.cache.insert(frame.clone());
        frame
    }
    pub fn read(&mut self, cancel: &crate::control::Cancellation) -> AppResult<Option<Frame>> {
        cancel.check()?;
        let previous = self.displayed_position;
        if previous.is_some() && previous != self.decoded_position {
            self.source.seek_hns(self.seek_origin)?;
            self.decoded_position = None;
            self.seeks = self.seeks.saturating_add(1);
        }
        for _ in 0..3000 {
            cancel.check()?;
            let Some((sample, timestamp)) = self.sample()? else {
                return Ok(None);
            };
            if previous.is_none_or(|stamp| timestamp > stamp) {
                let frame = self.materialize(sample, timestamp)?;
                return Ok(Some(self.remember(frame)));
            }
        }
        Err("sequential read exceeded frame budget".into())
    }
    pub fn prefetch_one(&mut self, cancel: &crate::control::Cancellation) -> AppResult<bool> {
        cancel.check()?;
        let (Some(actual), Some(shown)) = (self.decoded_position, self.displayed_position) else {
            return Ok(false);
        };
        if actual < shown || actual - shown > 5_000_000 {
            return Ok(false);
        }
        let Some((sample, timestamp)) = self.sample()? else {
            return Ok(false);
        };
        let frame = self.materialize(sample, timestamp)?;
        self.cache.insert(frame);
        Ok(true)
    }
    fn materialize(&self, sample: IMFSample, timestamp_hns: i64) -> AppResult<Frame> {
        // SAFETY: sample is an owned COM object from this reader; buffer locks are RAII guarded.
        let duration_hns = unsafe { sample.GetSampleDuration()? };
        if duration_hns <= 0 {
            return Err("invalid sample duration".into());
        }
        let current = unsafe { self.source.reader.GetCurrentMediaType(VIDEO)? };
        let layout = unsafe { current.GetUINT64(&MF_MT_FRAME_SIZE)? };
        let subtype = unsafe { current.GetGUID(&MF_MT_SUBTYPE)? };
        let mut decoded = self.layout;
        decoded.coded_width = (layout >> 32) as usize;
        decoded.coded_height = layout as u32 as usize;
        // Initial type can omit macroblock padding (1080 -> 1088). Accept bounded alignment
        // expansion only, not an arbitrary change to the visible source dimensions.
        if subtype != MFVideoFormat_NV12
            || decoded.coded_width < self.layout.coded_width
            || decoded.coded_width > self.layout.coded_width.div_ceil(128) * 128
            || decoded.coded_height < self.layout.coded_height
            || decoded.coded_height > self.layout.coded_height.div_ceil(128) * 128
        {
            return Err("decoded video format/geometry changed; reopen required".into());
        }
        let stride = unsafe {
            current
                .GetUINT32(&MF_MT_DEFAULT_STRIDE)
                .unwrap_or(self.stride as u32)
        } as i32;
        let buffer = unsafe { sample.ConvertToContiguousBuffer()? };
        let rgba = copy_nv12(&buffer, decoded, self.info.width, self.info.height, stride)?;
        Ok(Frame {
            timestamp_hns,
            duration_hns,
            width: self.info.width,
            height: self.info.height,
            rgba: rgba.into(),
        })
    }
    pub fn seek(
        &mut self,
        time_us: u64,
        cancel: &crate::control::Cancellation,
    ) -> AppResult<Frame> {
        self.locate(
            i64::try_from(time_us.checked_mul(10).ok_or("seek overflow")?)?,
            None,
            cancel,
        )
    }
    pub fn locate(
        &mut self,
        target: i64,
        seek_from: Option<i64>,
        cancel: &crate::control::Cancellation,
    ) -> AppResult<Frame> {
        cancel.check()?;
        let start = seek_from.unwrap_or(target);
        if start < 0 || start > target {
            return Err("invalid indexed seek origin".into());
        }
        self.seek_origin = start;
        if let Some(frame) = self.cache.get(target, self.info.width, self.info.height) {
            self.displayed_position = Some(frame.timestamp_hns);
            return Ok(frame);
        }
        let nearby = self
            .decoded_position
            .is_some_and(|stamp| target > stamp && target - stamp <= 5_000_000);
        if !nearby {
            self.source.seek_hns(start)?;
            self.decoded_position = None;
            self.seeks = self.seeks.saturating_add(1);
        }
        let mut last: Option<(IMFSample, i64)> = None;
        for _ in 0..3000 {
            cancel.check()?;
            let Some((sample, timestamp)) = self.sample()? else {
                let (sample, timestamp) = last.ok_or("no video frame")?;
                let frame = self.materialize(sample, timestamp)?;
                return Ok(self.remember(frame));
            };
            // Decode reference frames, but never read back/copy every skipped GPU picture.
            // Only the selected presented frame crosses the native/renderer boundary.
            if timestamp >= target {
                let frame = self.materialize(sample, timestamp)?;
                return Ok(self.remember(frame));
            }
            last = Some((sample, timestamp));
        }
        Err("seek decode exceeded frame budget".into())
    }
}

struct Unlock(IMFMediaBuffer);
impl Drop for Unlock {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Unlock();
        }
    }
}
struct Unlock2D(IMF2DBuffer2);
impl Drop for Unlock2D {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Unlock2D();
        }
    }
}

fn copy_nv12(
    buffer: &IMFMediaBuffer,
    mut layout: Layout,
    width: u32,
    height: u32,
    default_stride: i32,
) -> AppResult<Vec<u8>> {
    let mut scan = ptr::null_mut();
    let mut base = ptr::null_mut();
    let mut len = 0;
    let mut pitch = default_stride;
    let _unlock2d;
    let _unlock;
    // SAFETY: the lock owns this live allocation. Check scan/length/stride before forming
    // a slice; safe conversion separately checks both planes and the visible aperture.
    unsafe {
        if let Ok(two) = buffer.cast::<IMF2DBuffer2>() {
            two.Lock2DSize(
                MF2DBuffer_LockFlags_Read,
                &mut scan,
                &mut pitch,
                &mut base,
                &mut len,
            )?;
            _unlock2d = Some(Unlock2D(two));
            _unlock = None;
        } else {
            buffer.Lock(&mut base, None, Some(&mut len))?;
            _unlock = Some(Unlock(buffer.clone()));
            _unlock2d = None;
            scan = base;
        }
        if base.is_null() || scan.is_null() || pitch <= 0 || len > 256 * 1024 * 1024 {
            return Err("invalid NV12 allocation".into());
        }
        let offset = (scan as usize)
            .checked_sub(base as usize)
            .ok_or("invalid NV12 origin")?;
        if offset > len as usize {
            return Err("NV12 origin outside allocation".into());
        }
        layout.stride = pitch as usize;
        let bytes = std::slice::from_raw_parts(scan, len as usize - offset);
        pixels::nv12_rgba(bytes, layout, width as usize, height as usize)
    }
}

fn display_aperture(media_type: &IMFMediaType, width: u32, height: u32) -> AppResult<Aperture> {
    for key in [MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_GEOMETRIC_APERTURE] {
        let mut blob = [0u8; 16];
        let mut count = 0;
        // SAFETY: MFVideoArea is a 16-byte blob; decode byte fields without unaligned casts.
        if unsafe { media_type.GetBlob(&key, &mut blob, Some(&mut count)) }.is_ok() {
            if count != 16 || blob[0..2] != [0, 0] || blob[4..6] != [0, 0] {
                return Err("unsupported fractional display aperture".into());
            }
            let x = i16::from_le_bytes([blob[2], blob[3]]);
            let y = i16::from_le_bytes([blob[6], blob[7]]);
            let w = i32::from_le_bytes([blob[8], blob[9], blob[10], blob[11]]);
            let h = i32::from_le_bytes([blob[12], blob[13], blob[14], blob[15]]);
            if x < 0
                || y < 0
                || w <= 0
                || h <= 0
                || i64::from(x) + i64::from(w) > i64::from(width)
                || i64::from(y) + i64::from(h) > i64::from(height)
            {
                return Err("invalid display aperture".into());
            }
            return Ok(Aperture {
                x: x as usize,
                y: y as usize,
                width: w as usize,
                height: h as usize,
            });
        }
    }
    Ok(Aperture {
        x: 0,
        y: 0,
        width: width as usize,
        height: height as usize,
    })
}

pub fn sample_bytes(sample: &IMFSample) -> AppResult<Vec<u8>> {
    // SAFETY: read only within the returned buffer length; RAII guard unlocks on every path.
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut data = ptr::null_mut();
        let mut len = 0;
        buffer.Lock(&mut data, None, Some(&mut len))?;
        let _guard = Unlock(buffer);
        if data.is_null() || len > 4 * 1024 * 1024 {
            return Err("invalid audio sample buffer".into());
        }
        Ok(std::slice::from_raw_parts(data, len as usize).to_vec())
    }
}
