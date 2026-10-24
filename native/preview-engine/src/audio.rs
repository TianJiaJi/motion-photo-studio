//! Selected-track MF float PCM decoding, bounded gap filling and WASAPI shared-mode clock.
use crate::{AppResult, audio_source::AudioSource, media};
use serde::Serialize;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use windows::Win32::{
    Media::Audio::*,
    System::Com::{CLSCTX_ALL, CoCreateInstance},
};

pub struct Options {
    pub path: String,
    pub time_us: u64,
    pub end_us: Option<u64>,
    pub stream: u32,
    pub offset_hns: i64,
}
#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    running: AtomicBool,
    time_hns: AtomicI64,
    submitted: AtomicU64,
    underruns: AtomicU64,
    error: Mutex<Option<String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub running: bool,
    pub time_hns: String,
    pub submitted_frames: u64,
    pub underruns: u64,
    pub error: Option<String>,
}
pub struct Playback {
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Playback {
    pub fn start(options: Options) -> AppResult<Self> {
        let hns = i64::try_from(
            options
                .time_us
                .checked_mul(10)
                .ok_or("audio time overflow")?,
        )?;
        if options.end_us.is_some_and(|end| end <= options.time_us) {
            return Err("invalid audio interval".into());
        }
        let shared = Arc::new(Shared::default());
        shared.time_hns.store(hns, Ordering::Release);
        let state = shared.clone();
        let (ready, receive) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("motion-audio".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    play(&options, &state, &ready)
                }));
                let error = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e.to_string()),
                    Err(_) => Some("audio worker panicked".into()),
                };
                if let Some(error) = error {
                    let _ = ready.try_send(Err(error.clone()));
                    if let Ok(mut stored) = state.error.lock() {
                        *stored = Some(error);
                    }
                }
                state.running.store(false, Ordering::Release);
            })?;
        let mut playback = Self {
            shared,
            worker: Some(worker),
        };
        match receive.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(())) => Ok(playback),
            result => {
                playback.stop()?;
                Err(format!("audio initialization failed: {result:?}").into())
            }
        }
    }
    pub fn status(&self) -> AudioStatus {
        AudioStatus {
            running: self.shared.running.load(Ordering::Acquire),
            time_hns: self.shared.time_hns.load(Ordering::Acquire).to_string(),
            submitted_frames: self.shared.submitted.load(Ordering::Acquire),
            underruns: self.shared.underruns.load(Ordering::Acquire),
            error: self
                .shared
                .error
                .lock()
                .map(|e| e.clone())
                .unwrap_or_else(|_| Some("audio status lock poisoned".into())),
        }
    }
    pub fn stop(&mut self) -> AppResult<()> {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| "audio thread failed during shutdown")?;
        }
        Ok(())
    }
}
impl Drop for Playback {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
struct StopClient(IAudioClient);
impl Drop for StopClient {
    fn drop(&mut self) {
        // SAFETY: client is this thread's owned COM interface; stop/reset precede release.
        unsafe {
            let _ = self.0.Stop();
            let _ = self.0.Reset();
        }
    }
}
fn play(
    options: &Options,
    shared: &Shared,
    ready: &mpsc::SyncSender<Result<(), String>>,
) -> AppResult<()> {
    let _runtime = media::Runtime::new()?;
    let source = AudioSource::open(&options.path, options.stream)?;
    let rate = source.rate;
    let origin = i64::try_from(
        options
            .time_us
            .checked_mul(10)
            .ok_or("audio origin overflow")?,
    )?;
    let native_origin = origin
        .checked_add(options.offset_hns)
        .ok_or("audio mapping overflow")?;
    source.source.seek_hns(native_origin.max(0))?;
    let max_frames = options
        .end_us
        .map(|end| u64::try_from(u128::from(end - options.time_us) * u128::from(rate) / 1_000_000))
        .transpose()?;
    if let Some(end) = options.end_us
        && max_frames == Some(0)
    {
        shared.time_hns.store(
            i64::try_from(end.checked_mul(10).ok_or("audio end overflow")?)?,
            Ordering::Release,
        );
        ready.send(Ok(()))?;
        return Ok(());
    }
    // SAFETY: COM initialized on this worker; interfaces and out-pointers are owned. Every
    // GetBuffer write is bounded by the returned frame count and validated stereo float layout.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let format = WAVEFORMATEX {
            wFormatTag: 3,
            nChannels: 2,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            1_000_000,
            0,
            &format,
            None,
        )?;
        let stop_client = StopClient(client);
        let render: IAudioRenderClient = stop_client.0.GetService()?;
        let clock: IAudioClock = stop_client.0.GetService()?;
        let frequency = clock.GetFrequency()?;
        if frequency == 0 {
            return Err("audio device returned zero clock frequency".into());
        }
        let capacity = stop_client.0.GetBufferSize()?;
        if capacity == 0 || capacity > rate * 2 {
            return Err("invalid audio device buffer size".into());
        }
        let mut pending = Vec::<u8>::new();
        let mut offset = 0usize;
        let mut pending_time = 0i64;
        let mut started = false;
        let mut eof = false;
        let mut submitted = 0u64;
        while !shared.stop.load(Ordering::Acquire) {
            let padding = stop_client.0.GetCurrentPadding()?;
            if padding > capacity {
                return Err("invalid WASAPI padding".into());
            }
            let remaining = max_frames
                .map(|maximum| maximum.saturating_sub(submitted))
                .unwrap_or(u64::MAX);
            let available = (capacity - padding).min(remaining.min(u64::from(u32::MAX)) as u32);
            if available > 0 {
                let mut pcm = Vec::with_capacity(available as usize * 8);
                while pcm.len() < available as usize * 8 && !shared.stop.load(Ordering::Acquire) {
                    if offset >= pending.len() && !eof {
                        match source.sample()? {
                            Some((sample, time, count)) => {
                                pending = media::sample_bytes(&sample)?;
                                if pending.len() != count as usize * 8 {
                                    return Err("misaligned float stereo sample".into());
                                }
                                pending_time = time;
                                offset = 0;
                            }
                            None => eof = true,
                        }
                    }
                    if eof {
                        // A short selected track contributes silence, not a frozen video clock.
                        if max_frames.is_some() {
                            pcm.resize(available as usize * 8, 0);
                        }
                        break;
                    }
                    let samples = submitted
                        .checked_add((pcm.len() / 8) as u64)
                        .ok_or("audio sample count overflow")?;
                    let wanted = native_origin
                        .checked_add(i64::try_from(
                            u128::from(samples) * 10_000_000 / u128::from(rate),
                        )?)
                        .ok_or("audio timeline overflow")?;
                    let have = pending_time
                        .checked_add(i64::try_from(
                            (offset / 8) as u128 * 10_000_000 / u128::from(rate),
                        )?)
                        .ok_or("audio sample time overflow")?;
                    let tolerance = i64::from(10_000_000 / rate) + 1;
                    let drift = i128::from(have) - i128::from(wanted);
                    if drift > i128::from(tolerance) {
                        let gap = (u128::try_from(drift)? * u128::from(rate)).div_ceil(10_000_000);
                        let count = gap.min((available as usize - pcm.len() / 8) as u128) as usize;
                        pcm.resize(pcm.len() + count * 8, 0);
                        continue;
                    }
                    if drift < -i128::from(tolerance) {
                        let skip =
                            (u128::try_from(-drift)? * u128::from(rate)).div_ceil(10_000_000);
                        offset += skip.min(((pending.len() - offset) / 8) as u128) as usize * 8;
                        continue;
                    }
                    let copy = (pending.len() - offset).min(available as usize * 8 - pcm.len());
                    pcm.extend_from_slice(&pending[offset..offset + copy]);
                    offset += copy;
                }
                let count = (pcm.len() / 8) as u32;
                if count > 0 {
                    let dest = render.GetBuffer(count)?;
                    if dest.is_null() {
                        return Err("null WASAPI render buffer".into());
                    }
                    std::ptr::copy_nonoverlapping(pcm.as_ptr(), dest, pcm.len());
                    render.ReleaseBuffer(count, 0)?;
                    submitted = submitted
                        .checked_add(u64::from(count))
                        .ok_or("audio sample count overflow")?;
                    shared.submitted.store(submitted, Ordering::Release);
                }
            }
            if !started && submitted > 0 {
                stop_client.0.Start()?;
                started = true;
                shared.running.store(true, Ordering::Release);
                ready.send(Ok(()))?;
            }
            if started {
                let mut ticks = 0;
                clock.GetPosition(&mut ticks, None)?;
                let elapsed = u128::from(ticks) * 10_000_000 / u128::from(frequency);
                let mut at = origin
                    .checked_add(i64::try_from(elapsed)?)
                    .ok_or("audio clock overflow")?;
                if let Some(end) = options.end_us {
                    at = at.min(i64::try_from(
                        end.checked_mul(10).ok_or("audio end overflow")?,
                    )?);
                }
                shared.time_hns.store(at, Ordering::Release);
                if padding == 0 && !eof && submitted > u64::from(capacity) {
                    shared.underruns.fetch_add(1, Ordering::Relaxed);
                }
            }
            if (max_frames.is_some_and(|maximum| submitted >= maximum)
                || eof && max_frames.is_none())
                && stop_client.0.GetCurrentPadding()? == 0
            {
                break;
            }
            thread::sleep(Duration::from_millis(4));
        }
        Ok(())
    }
}
