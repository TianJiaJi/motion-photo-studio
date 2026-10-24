//! Diagnostic-only H.264 sample-fed MFT prototype. Not part of the production protocol.
//! The parent supplies bounded container metadata; no Source Reader or media-tool process is used.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    mem::ManuallyDrop,
    path::Path,
    time::Instant,
};
use windows::{
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
    },
    core::GUID,
};
#[path = "../src/pixels.rs"]
mod pixels;
type AppResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
const MAX_PACKET: usize = 32 * 1024 * 1024;
// Windows SDK 10.0.26100.0, wmcodecdsp.h: CLSID_CMSH264DecoderMFT (not AAC's CLSID).
const H264_DECODER: GUID = GUID::from_u128(0x62ce7e72_4c71_4d20_b15d_452831a87d9d);
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum TimingMode {
    #[default]
    Complete,
    NoDuration,
    NoDts,
    PtsOnly,
    BoundaryDuration,
    FirstDiscontinuity,
    PositiveEpoch,
}
// Same 100ns clock-error bound as the production frame-index.ts mapping contract.
// Source PTS identity remains exact; there is no nearest-candidate selection or fitted offset.
const MAX_NATIVE_TIME_ERROR_HNS: i128 = 2;
#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum IdentityPolicy {
    #[default]
    ExactHns,
    SourceRational,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    source: String,
    source_bytes: String,
    track_id: u32,
    timescale: u32,
    width: u32,
    height: u32,
    maximum_edge: u32,
    matrix709: bool,
    full_range: bool,
    nal_length_size: u8,
    parameter_sets: Vec<Vec<u8>>,
    packets: Vec<Packet>,
    wanted_frames: usize,
    #[serde(default)]
    timing_mode: TimingMode,
    #[serde(default)]
    identity_policy: IdentityPolicy,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    offset: String,
    size: u32,
    pts: String,
    dts: String,
    duration: u32,
    sync: bool,
}
struct Runtime;
impl Runtime {
    fn new() -> AppResult<Self> {
        // SAFETY: balanced COM/MF startup on this thread only.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(e.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
struct Lock {
    buffer: IMFMediaBuffer,
    pointer: *mut u8,
    length: usize,
}
impl Lock {
    fn new(buffer: IMFMediaBuffer) -> AppResult<Self> {
        let mut pointer = std::ptr::null_mut();
        let mut length = 0;
        // SAFETY: owned COM buffer, initialized out pointers; Drop always unlocks.
        unsafe {
            buffer.Lock(&mut pointer, None, Some(&mut length))?;
        }
        let lock = Self {
            buffer,
            pointer,
            length: length as usize,
        };
        if pointer.is_null() || lock.length > 128 * 1024 * 1024 {
            return Err("invalid decoded buffer".into());
        }
        Ok(lock)
    }
    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.pointer, self.length) }
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            let _ = self.buffer.Unlock();
        }
    }
}
fn hns(text: &str, timescale: u32) -> AppResult<i64> {
    if text.len() > 20 || timescale == 0 {
        return Err("invalid sample timestamp".into());
    }
    let ticks: i64 = text.parse()?;
    Ok(i64::try_from(
        i128::from(ticks) * 10_000_000 / i128::from(timescale),
    )?)
}
fn time_origin(mode: TimingMode) -> i64 {
    if matches!(mode, TimingMode::PositiveEpoch) {
        10_000_000
    } else {
        0
    }
}
fn sample_time(text: &str, scale: u32, mode: TimingMode) -> AppResult<i64> {
    // Explicit decoder-only coordinate transform, selected BEFORE decoding.
    // Never infer a correction from output or reconstruct source PTS from rounded HNS.
    let value = hns(text, scale)?
        .checked_add(time_origin(mode))
        .ok_or("decoder time origin overflow")?;
    if matches!(mode, TimingMode::PositiveEpoch) && value <= 0 {
        return Err(
            "positive-origin prototype requires source time later than minus one second".into(),
        );
    }
    Ok(value)
}
fn source_time_error(pts: &str, stamp: i64, scale: u32, origin: i64) -> AppResult<i128> {
    if scale == 0 {
        return Err("zero timescale".into());
    }
    let pts: i64 = pts.parse()?;
    Ok((i128::from(stamp) - i128::from(origin)) * i128::from(scale) - i128::from(pts) * 10_000_000)
}
fn identity_candidates(packets: &[Packet], stamp: i64, config: &Manifest) -> AppResult<Vec<usize>> {
    let mut matches = Vec::new();
    for (i, p) in packets.iter().enumerate() {
        let valid = match config.identity_policy {
            IdentityPolicy::ExactHns => {
                sample_time(&p.pts, config.timescale, config.timing_mode)? == stamp
            }
            IdentityPolicy::SourceRational => {
                source_time_error(
                    &p.pts,
                    stamp,
                    config.timescale,
                    time_origin(config.timing_mode),
                )?
                .abs()
                    <= MAX_NATIVE_TIME_ERROR_HNS * i128::from(config.timescale)
            }
        };
        if valid {
            matches.push(i);
        }
    }
    Ok(matches)
}
fn annex_b(input: &[u8], length_size: u8, prefix: &[u8]) -> AppResult<Vec<u8>> {
    if ![1, 2, 4].contains(&length_size) || input.len() > MAX_PACKET || prefix.len() > 65536 {
        return Err("invalid AVC framing budget".into());
    }
    let mut output = prefix.to_vec();
    let mut at = 0;
    let mut units = 0;
    while at < input.len() {
        let width = usize::from(length_size);
        if input.len() - at < width {
            return Err("truncated AVC length".into());
        }
        let mut length = 0usize;
        for byte in &input[at..at + width] {
            length = (length << 8) | usize::from(*byte);
        }
        at += width;
        units += 1;
        if length == 0
            || length > input.len() - at
            || units > 65536
            || output
                .len()
                .checked_add(length + 4)
                .is_none_or(|n| n > MAX_PACKET + 65536)
        {
            return Err("invalid AVC unit extent".into());
        }
        output.extend_from_slice(&[0, 0, 0, 1]);
        output.extend_from_slice(&input[at..at + length]);
        at += length;
    }
    if units == 0 {
        return Err("empty AVC sample".into());
    }
    Ok(output)
}
fn boundary_duration(packet: &Packet, scale: u32) -> AppResult<i64> {
    let start: i64 = packet.pts.parse()?;
    let end = start
        .checked_add(i64::from(packet.duration))
        .ok_or("duration endpoint overflow")?;
    let duration = hns(&end.to_string(), scale)?
        .checked_sub(hns(&packet.pts, scale)?)
        .ok_or("duration difference overflow")?;
    if duration <= 0 {
        return Err("unrepresentable sample duration".into());
    }
    Ok(duration)
}
fn sample_duration(packet: &Packet, scale: u32, timing: TimingMode) -> AppResult<Option<i64>> {
    if matches!(timing, TimingMode::NoDuration | TimingMode::PtsOnly) {
        return Ok(None);
    }
    let duration = if matches!(timing, TimingMode::BoundaryDuration) {
        boundary_duration(packet, scale)?
    } else {
        hns(&packet.duration.to_string(), scale)?
    };
    if duration <= 0 {
        return Err("unrepresentable sample duration".into());
    }
    Ok(Some(duration))
}
fn input_sample(
    bytes: &[u8],
    packet: &Packet,
    scale: u32,
    timing: TimingMode,
    first: bool,
) -> AppResult<IMFSample> {
    // SAFETY: bounded buffer allocation; write is bounded by its checked allocation size.
    unsafe {
        let sample = MFCreateSample()?;
        let buffer = MFCreateMemoryBuffer(u32::try_from(bytes.len())?)?;
        let mut pointer = std::ptr::null_mut();
        buffer.Lock(&mut pointer, None, None)?;
        if pointer.is_null() {
            let _ = buffer.Unlock();
            return Err("null input buffer".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(u32::try_from(bytes.len())?)?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(sample_time(&packet.pts, scale, timing)?)?;
        if first && matches!(timing, TimingMode::FirstDiscontinuity) {
            sample.SetUINT32(&MFSampleExtension_Discontinuity, 1)?;
        }
        if let Some(duration) = sample_duration(packet, scale, timing)? {
            sample.SetSampleDuration(duration)?;
        }
        if !matches!(timing, TimingMode::NoDts | TimingMode::PtsOnly) {
            sample.SetUINT64(
                &MFSampleExtension_DecodeTimestamp,
                sample_time(&packet.dts, scale, timing)? as u64,
            )?;
        }
        sample.SetUINT32(&MFSampleExtension_CleanPoint, u32::from(packet.sync))?;
        Ok(sample)
    }
}
fn negotiate(decoder: &IMFTransform) -> AppResult<IMFMediaType> {
    // SAFETY: synchronous transform belongs to this apartment, stream zero only.
    unsafe {
        for i in 0..64 {
            let media = decoder.GetOutputAvailableType(0, i)?;
            if media.GetGUID(&MF_MT_SUBTYPE)? == MFVideoFormat_NV12 {
                decoder.SetOutputType(0, &media, 0)?;
                return Ok(media);
            }
        }
    }
    Err("no bounded NV12 output negotiation".into())
}
fn output_once(decoder: &IMFTransform) -> AppResult<Option<IMFSample>> {
    // SAFETY: initialized output structs; both sample and event references are taken/dropped on EVERY result.
    unsafe {
        let info = decoder.GetOutputStreamInfo(0)?;
        let provided = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let sample = if provided {
            None
        } else {
            if info.cbSize == 0
                || info.cbSize > 128 * 1024 * 1024
                || info.cbAlignment > 65536
                || (info.cbAlignment != 0 && !info.cbAlignment.is_power_of_two())
            {
                return Err("invalid output allocation".into());
            }
            let sample = MFCreateSample()?;
            let buffer =
                MFCreateAlignedMemoryBuffer(info.cbSize, info.cbAlignment.saturating_sub(1))?;
            sample.AddBuffer(&buffer)?;
            Some(sample)
        };
        let mut rows = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0;
        let result = decoder.ProcessOutput(0, &mut rows, &mut status);
        let sample = ManuallyDrop::take(&mut rows[0].pSample);
        drop(ManuallyDrop::take(&mut rows[0].pEvents));
        match result {
            Ok(()) => Ok(Some(sample.ok_or("decoder returned no sample")?)),
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}
fn rgba(
    sample: &IMFSample,
    decoder: &IMFTransform,
    config: &Manifest,
) -> AppResult<(Vec<u8>, usize, usize)> {
    // SAFETY: current type comes from the selected transform, locked bytes stay alive through conversion.
    unsafe {
        let media = decoder.GetOutputCurrentType(0)?;
        let size = media.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let width = (size >> 32) as usize;
        let height = size as u32 as usize;
        if media.GetGUID(&MF_MT_SUBTYPE)? != MFVideoFormat_NV12
            || width < config.width as usize
            || height < config.height as usize
            || width > config.width.div_ceil(128) as usize * 128
            || height > config.height.div_ceil(128) as usize * 128
        {
            return Err("unexpected decoded geometry".into());
        }
        let stride = media
            .GetUINT32(&MF_MT_DEFAULT_STRIDE)
            .unwrap_or(width as u32) as usize;
        let scale = f64::min(
            1.0,
            f64::from(config.maximum_edge) / f64::from(config.width.max(config.height)),
        );
        let out_width = ((f64::from(config.width) * scale) as usize / 2 * 2).max(2);
        let out_height = ((f64::from(config.height) * scale) as usize / 2 * 2).max(2);
        let lock = Lock::new(sample.ConvertToContiguousBuffer()?)?;
        let layout = pixels::Layout {
            coded_width: width,
            coded_height: height,
            stride,
            aperture: pixels::Aperture {
                x: 0,
                y: 0,
                width: config.width as usize,
                height: config.height as usize,
            },
            matrix709: config.matrix709,
            full_range: config.full_range,
        };
        Ok((
            pixels::nv12_rgba(lock.bytes(), layout, out_width, out_height)?,
            out_width,
            out_height,
        ))
    }
}
struct Outputs {
    frames: Vec<serde_json::Value>,
    supplied: usize,
    last_timestamp: Option<i64>,
    last_source_pts: Option<i64>,
    first_identity: Option<(i64, i64)>,
    first_output_ms: Option<f64>,
    first_rgba: Option<(Vec<u8>, usize, usize)>,
    changes: usize,
}
fn receive(
    decoder: &IMFTransform,
    config: &Manifest,
    outputs: &mut Outputs,
    start: Instant,
) -> AppResult<usize> {
    let before = outputs.frames.len();
    if before >= config.wanted_frames {
        return Ok(0);
    }
    for _ in 0..64 {
        match output_once(decoder) {
            Ok(None) => return Ok(outputs.frames.len() - before),
            Ok(Some(sample)) => {
                let timestamp = unsafe { sample.GetSampleTime()? };
                let matches =
                    identity_candidates(&config.packets[..outputs.supplied], timestamp, config)?;
                if matches.len() != 1 {
                    // Diagnostics only: nearest candidates do NOT authorize a fuzzy match.
                    let mut nearest: Vec<_> = config
                        .packets
                        .iter()
                        .take(outputs.supplied)
                        .enumerate()
                        .filter_map(|(i, p)| {
                            sample_time(&p.pts, config.timescale, config.timing_mode)
                                .ok()
                                .map(|value| {
                                    ((i128::from(timestamp) - i128::from(value)).abs(), i, value)
                                })
                        })
                        .collect();
                    nearest.sort_by_key(|row| row.0);
                    nearest.truncate(3);
                    let candidates: Vec<_> = nearest.iter().map(|(_,i,value)| {
                        let packet=&config.packets[*i];
                        json!({"packetIndex":i,"sourcePts":packet.pts,"inputTimestampHns":value.to_string(),
                            "deltaHns":(i128::from(timestamp)-i128::from(*value)).to_string(),"sourceDuration":packet.duration,
                            "inputDurationHns":sample_duration(packet,config.timescale,config.timing_mode).ok().flatten().map(|v|v.to_string()),
                            "inputDecodeTimestampHns":if matches!(config.timing_mode,TimingMode::NoDts|TimingMode::PtsOnly) {None} else {sample_time(&packet.dts,config.timescale,config.timing_mode).ok().map(|v|v.to_string())}})
                    }).collect();
                    let diagnostic = json!({"actualTimestampHns":timestamp.to_string(),
                        "actualDurationHns":unsafe {sample.GetSampleDuration()}.ok().map(|v|v.to_string()),
                        "timescale":config.timescale,"timingMode":config.timing_mode,"identityPolicy":config.identity_policy,"decoderTimeOriginHns":time_origin(config.timing_mode).to_string(),"supplied":outputs.supplied,"matches":matches.len(),
                        "previousOutputs":outputs.frames,"nearest":candidates});
                    return Err(format!("output timestamp does not identify exactly one supplied sample: {diagnostic}").into());
                }
                let source_pts: i64 = config.packets[matches[0]].pts.parse()?;
                if outputs.last_timestamp.is_some_and(|last| timestamp <= last)
                    || outputs
                        .last_source_pts
                        .is_some_and(|last| source_pts <= last)
                {
                    return Err("duplicate or unordered decoder/source output".into());
                }
                if let Some((first_pts, first_stamp)) = outputs.first_identity {
                    let interval_error = (i128::from(source_pts) - i128::from(first_pts))
                        * 10_000_000
                        - (i128::from(timestamp) - i128::from(first_stamp))
                            * i128::from(config.timescale);
                    if interval_error.abs()
                        > MAX_NATIVE_TIME_ERROR_HNS * i128::from(config.timescale)
                    {
                        return Err(
                            "source/native rational intervals exceed existing clock bound".into(),
                        );
                    }
                } else {
                    outputs.first_identity = Some((source_pts, timestamp));
                }
                outputs.last_timestamp = Some(timestamp);
                outputs.last_source_pts = Some(source_pts);
                outputs
                    .first_output_ms
                    .get_or_insert(start.elapsed().as_secs_f64() * 1000.0);
                if outputs.first_rgba.is_none() {
                    outputs.first_rgba = Some(rgba(&sample, decoder, config)?);
                }
                outputs.frames.push(json!({"timestampHns":timestamp.to_string(),"packetIndex":matches[0],"sourcePts":config.packets[matches[0]].pts,
                    "clockErrorNumerator":source_time_error(&config.packets[matches[0]].pts,timestamp,config.timescale,time_origin(config.timing_mode))?.to_string(),"clockErrorDenominator":config.timescale}));
                if outputs.frames.len() >= config.wanted_frames {
                    return Ok(outputs.frames.len() - before);
                }
            }
            Err(e) => {
                if e.downcast_ref::<windows::core::Error>()
                    .is_some_and(|e| e.code() == MF_E_TRANSFORM_STREAM_CHANGE)
                {
                    outputs.changes += 1;
                    if outputs.changes > 4 {
                        return Err("excessive stream changes".into());
                    }
                    negotiate(decoder)?;
                } else {
                    return Err(e);
                }
            }
        }
    }
    Err("output iteration budget exceeded".into())
}
fn run() -> AppResult<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: direct-sample-decode <manifest> <new-first-frame.rgba>".into());
    }
    let mut encoded = Vec::new();
    File::open(&args[1])?
        .take(512 * 1024 + 1)
        .read_to_end(&mut encoded)?;
    if encoded.len() > 512 * 1024 {
        return Err("manifest too large".into());
    }
    let config: Manifest = serde_json::from_slice(&encoded)?;
    if config.version != 1
        || config.track_id == 0
        || config.timescale == 0
        || !(2..=8192).contains(&config.width)
        || !(2..=8192).contains(&config.height)
        || !config.width.is_multiple_of(2)
        || !config.height.is_multiple_of(2)
        || !(64..=1280).contains(&config.maximum_edge)
        || !(1..=12).contains(&config.wanted_frames)
        || config.packets.is_empty()
        || config.packets.len() > 128
        || !config.packets[0].sync
        || config.parameter_sets.is_empty()
        || config.parameter_sets.len() > 64
        || ![1, 2, 4].contains(&config.nal_length_size)
        || !Path::new(&config.source).is_absolute()
        || config.source.starts_with("\\\\")
        || !Path::new(&args[2]).is_absolute()
    {
        return Err("invalid prototype configuration".into());
    }
    let mut prefix = Vec::new();
    for unit in &config.parameter_sets {
        if unit.is_empty() || unit.len() > 65535 || prefix.len() + unit.len() + 4 > 65536 {
            return Err("invalid parameter set budget".into());
        }
        prefix.extend_from_slice(&[0, 0, 0, 1]);
        prefix.extend_from_slice(unit);
    }
    let start = Instant::now();
    let _runtime = Runtime::new()?;
    let mut source = File::open(&config.source)?;
    let original = source.metadata()?;
    if !original.is_file() || original.len() != config.source_bytes.parse::<u64>()? {
        return Err("source size/type changed".into());
    }
    let decoder: IMFTransform =
        unsafe { CoCreateInstance(&H264_DECODER, None, CLSCTX_INPROC_SERVER)? };
    // SAFETY: configured synchronous in-process Microsoft H.264 MFT; Annex-B framing, no codec implementation.
    unsafe {
        let input = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        input.SetUINT64(
            &MF_MT_FRAME_SIZE,
            (u64::from(config.width) << 32) | u64::from(config.height),
        )?;
        input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        input.SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &prefix)?;
        decoder.SetInputType(0, &input, 0)?;
        negotiate(&decoder)?;
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
    }
    let initialize_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut outputs = Outputs {
        frames: Vec::new(),
        supplied: 0,
        last_timestamp: None,
        last_source_pts: None,
        first_identity: None,
        first_output_ms: None,
        first_rgba: None,
        changes: 0,
    };
    let mut accepted = 0;
    let mut read_bytes = 0usize;
    'packets: for packet in &config.packets {
        let offset: u64 = packet.offset.parse()?;
        let length = packet.size as usize;
        if length == 0
            || length > MAX_PACKET
            || offset
                .checked_add(u64::from(packet.size))
                .is_none_or(|end| end > original.len())
            || packet.duration == 0
        {
            return Err("packet outside source/budget".into());
        }
        read_bytes = read_bytes
            .checked_add(length)
            .ok_or("read byte counter overflow")?;
        if read_bytes > 64 * 1024 * 1024 {
            return Err("packet prefix exceeds read budget".into());
        }
        source.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; length];
        source.read_exact(&mut bytes)?;
        let framed = annex_b(
            &bytes,
            config.nal_length_size,
            if accepted == 0 { &prefix } else { &[] },
        )?;
        let sample = input_sample(
            &framed,
            packet,
            config.timescale,
            config.timing_mode,
            accepted == 0,
        )?;
        let mut sent = false;
        for _ in 0..16 {
            match unsafe { decoder.ProcessInput(0, &sample, 0) } {
                Ok(()) => {
                    sent = true;
                    accepted += 1;
                    outputs.supplied = accepted;
                    break;
                }
                Err(e) if e.code() == MF_E_NOTACCEPTING => {
                    if receive(&decoder, &config, &mut outputs, start)? == 0 {
                        return Err("input/output made no progress".into());
                    }
                    if outputs.frames.len() >= config.wanted_frames {
                        break 'packets;
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
        if !sent {
            return Err("input backpressure budget exceeded".into());
        }
        receive(&decoder, &config, &mut outputs, start)?;
        if outputs.frames.len() >= config.wanted_frames {
            break;
        }
    }
    if outputs.frames.len() < config.wanted_frames {
        unsafe {
            decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            decoder.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
        }
        receive(&decoder, &config, &mut outputs, start)?;
    }
    if outputs.frames.len() < config.wanted_frames {
        return Err("bounded packet prefix did not produce requested outputs".into());
    }
    let after = source.metadata()?;
    if original.len() != after.len() || original.modified()? != after.modified()? {
        return Err("source changed during decoding".into());
    }
    unsafe {
        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
    }
    let (pixels, width, height) = outputs.first_rgba.take().ok_or("no decoded image")?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[2])?;
    output.write_all(&pixels)?;
    output.sync_all()?;
    println!(
        "{}",
        json!({"scope":"diagnostic synchronous H264 MFT only; not production playback", "trackId":config.track_id,"initializeMs":initialize_ms,
        "firstOutputMs":outputs.first_output_ms,"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"inputPackets":accepted,"sourceBytesRead":read_bytes,"timingMode":config.timing_mode,"identityPolicy":config.identity_policy,"maximumClockErrorHns":MAX_NATIVE_TIME_ERROR_HNS,"decoderTimeOriginHns":time_origin(config.timing_mode).to_string(),
        "frames":outputs.frames,"streamChanges":outputs.changes,"width":width,"height":height,"hardwareDecodeVerified":false})
    );
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("direct-sample-decode: {e}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn length_prefixes_are_framing_only_and_bounds_checked() {
        let Ok(bytes) = annex_b(&[0, 2, 0x65, 0x88, 0, 1, 0x06], 2, &[0, 0, 0, 1, 0x67]) else {
            panic!("valid framing rejected")
        };
        assert_eq!(
            bytes,
            [0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x65, 0x88, 0, 0, 0, 1, 0x06]
        );
        for input in [&[0u8][..], &[0, 0][..], &[0, 2, 1][..]] {
            assert!(annex_b(input, 2, &[]).is_err());
        }
        assert!(annex_b(&[1, 1], 3, &[]).is_err());
    }
    #[test]
    fn rational_identity_rejects_ambiguity_instead_of_picking_the_nearest() {
        let packet = |pts: &str| Packet {
            offset: "0".into(),
            size: 1,
            pts: pts.into(),
            dts: pts.into(),
            duration: 1,
            sync: true,
        };
        let config = Manifest {
            version: 1,
            source: String::new(),
            source_bytes: "0".into(),
            track_id: 1,
            timescale: 1_000_000_000,
            width: 2,
            height: 2,
            maximum_edge: 64,
            matrix709: false,
            full_range: false,
            nal_length_size: 4,
            parameter_sets: vec![],
            packets: vec![packet("0"), packet("1")],
            wanted_frames: 1,
            timing_mode: TimingMode::Complete,
            identity_policy: IdentityPolicy::SourceRational,
        };
        let Ok(candidates) = identity_candidates(&config.packets, 0, &config) else {
            panic!("candidate check failed")
        };
        // Even an exact zero match must fail uniqueness when a second source lies inside the clock bound.
        assert_eq!(candidates, vec![0, 1]);
        assert_ne!(candidates.len(), 1);
        assert!(identity_candidates(&config.packets, 3, &config).is_ok_and(|rows| rows.is_empty()));
    }
    #[test]
    fn rational_clock_bound_does_not_round_source_pts_or_extend_to_neighboring_frames() {
        assert_eq!(source_time_error("0", -1, 60000, 0).ok(), Some(-60000));
        assert_eq!(
            source_time_error("1000", 166666, 60000, 0).ok(),
            Some(-40000)
        );
        assert!(
            source_time_error("1000", 166669, 60000, 0).is_ok_and(|error| error.abs() > 2 * 60000)
        );
        assert!(source_time_error("1000", 0, 60000, 0).is_ok_and(|error| error.abs() > 2 * 60000));
        assert_eq!(
            source_time_error("9007199254740995", 90071992547409, 1_000_000_000, 0).ok(),
            Some(-950_000_000)
        );
        assert!(source_time_error("0", 0, 0, 0).is_err());
    }
    #[test]
    fn decoder_time_origin_is_declared_invertible_and_overflow_checked() {
        for text in ["0", "1000", "-1000"] {
            let Ok(value) = sample_time(text, 60000, TimingMode::PositiveEpoch) else {
                panic!("valid decoder time rejected")
            };
            assert_eq!(
                Some(value - time_origin(TimingMode::PositiveEpoch)),
                hns(text, 60000).ok()
            );
        }
        assert_eq!(
            sample_time("0", 60000, TimingMode::PositiveEpoch).ok(),
            Some(10_000_000)
        );
        assert_eq!(sample_time("0", 60000, TimingMode::Complete).ok(), Some(0));
        assert!(sample_time(&i64::MAX.to_string(), 10_000_000, TimingMode::PositiveEpoch).is_err());
        assert!(sample_time("-60000", 60000, TimingMode::PositiveEpoch).is_err());
        // A clock origin does not manufacture distinguishable identities below HNS resolution.
        assert_eq!(
            sample_time("1", 1_000_000_000, TimingMode::PositiveEpoch).ok(),
            sample_time("2", 1_000_000_000, TimingMode::PositiveEpoch).ok()
        );
    }
    #[test]
    fn duration_boundaries_conserve_fractional_frame_intervals() {
        let mut sum = 0;
        for i in 0..60 {
            let packet = Packet {
                offset: "0".into(),
                size: 1,
                pts: (i * 1000).to_string(),
                dts: (i * 1000).to_string(),
                duration: 1000,
                sync: true,
            };
            let Ok(duration) = boundary_duration(&packet, 60000) else {
                panic!("valid duration rejected")
            };
            assert!([166666, 166667].contains(&duration));
            sum += duration;
        }
        assert_eq!(sum, 10_000_000);
        let packet = Packet {
            offset: "0".into(),
            size: 1,
            pts: i64::MAX.to_string(),
            dts: "0".into(),
            duration: 1,
            sync: true,
        };
        assert!(boundary_duration(&packet, 60000).is_err());
    }
    #[test]
    fn timestamps_keep_integer_arithmetic_and_reject_overflow() {
        assert_eq!(
            hns("9007199254740995", 1_000_000_000).ok(),
            Some(90071992547409)
        );
        assert_eq!(hns("-3", 90_000).ok(), Some(-333));
        assert!(hns("1", 0).is_err());
        assert!(hns("9223372036854775807", 1).is_err());
    }
}
