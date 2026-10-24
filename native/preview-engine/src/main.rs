#![cfg_attr(not(windows), allow(unused))]
#[cfg(not(windows))]
compile_error!("motion-preview supports Windows x64 only");

mod audio;
mod audio_source;
mod cache;
mod control;
mod media;
mod pixels;
mod protocol;
mod transport;

use protocol::Command;
use serde_json::json;
type AppResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn run() -> AppResult<()> {
    let transport = transport::Transport::new()?;
    let _runtime = media::Runtime::new()?;
    let mut video: Option<media::Video> = None;
    let mut thumbnails: Option<media::Video> = None;
    let mut audio: Option<audio::Playback> = None;
    let mut audio_scan: Option<audio_source::AudioSource> = None;
    let mut source_path: Option<String> = None;
    let mut frame_id = 0u64;
    while let Some((request, cancel)) = transport.next() {
        let mut pixels: std::sync::Arc<[u8]> = std::sync::Arc::from([]);
        let check_epoch = !matches!(
            request.command,
            Command::Hello | Command::Stats | Command::Shutdown
        );
        let result: AppResult<serde_json::Value> = (|| {
            if check_epoch {
                cancel.check()?;
            }
            match &request.command {
                Command::Hello => Ok(
                    json!({"engine":"motion-preview", "engineVersion":env!("CARGO_PKG_VERSION"), "platform":"windows-x64", "mediaFoundation":true, "phase":"native-preview", "pid":std::process::id()}),
                ),
                Command::Open {
                    path,
                    maximum_edge,
                    matrix709,
                    full_range,
                } => {
                    audio = None;
                    source_path = None;
                    video = None;
                    thumbnails = None;
                    audio_scan = None;
                    let opened = media::Video::open(path, *maximum_edge, *matrix709, *full_range)?;
                    let info = serde_json::to_value(&opened.info)?;
                    video = Some(opened);
                    source_path = Some(path.clone());
                    Ok(info)
                }
                Command::Seek { time_us } => {
                    audio = None;
                    let frame = video
                        .as_mut()
                        .ok_or("no open video")?
                        .seek(*time_us, &cancel)?;
                    frame_id = frame_id.checked_add(1).ok_or("frame id overflow")?;
                    let result = json!({"frameId":frame_id, "timestampHns":frame.timestamp_hns.to_string(), "durationHns":frame.duration_hns.to_string(), "width":frame.width, "height":frame.height, "format":"rgba8"});
                    pixels = frame.rgba;
                    Ok(result)
                }
                Command::Locate {
                    time_hns,
                    seek_hns,
                    playback,
                } => {
                    if !playback {
                        audio = None;
                    }
                    if time_hns.len() > 19 || !time_hns.bytes().all(|b| b.is_ascii_digit()) {
                        return Err("invalid native time".into());
                    }
                    let seek_from = match seek_hns {
                        Some(text) => {
                            if text.len() > 19 || !text.bytes().all(|b| b.is_ascii_digit()) {
                                return Err("invalid seek origin".into());
                            }
                            Some(text.parse()?)
                        }
                        None => None,
                    };
                    let frame = video.as_mut().ok_or("no open video")?.locate(
                        time_hns.parse()?,
                        seek_from,
                        &cancel,
                    )?;
                    frame_id = frame_id.checked_add(1).ok_or("frame id overflow")?;
                    let result = json!({"frameId":frame_id, "timestampHns":frame.timestamp_hns.to_string(), "durationHns":frame.duration_hns.to_string(), "width":frame.width, "height":frame.height, "format":"rgba8"});
                    pixels = frame.rgba;
                    Ok(result)
                }
                Command::Stats => Ok(
                    json!({"primary":video.as_ref().map(|v|v.stats()), "thumbnail":thumbnails.as_ref().map(|v|v.stats()), "control":transport.control.stats()}),
                ),
                Command::Quality { maximum_edge } => {
                    let current = video.as_mut().ok_or("no open video")?;
                    current.resize(*maximum_edge)?;
                    Ok(serde_json::to_value(&current.info)?)
                }
                Command::Prefetch { count } => {
                    if *count > 2 {
                        return Err("prefetch exceeds queue budget".into());
                    }
                    let current = video.as_mut().ok_or("no open video")?;
                    for _ in 0..*count {
                        if !transport.control.idle() || !current.prefetch_one(&cancel)? {
                            break;
                        }
                    }
                    Ok(current.stats())
                }
                Command::Thumbnail { time_hns, seek_hns } => {
                    for text in [time_hns, seek_hns] {
                        if text.len() > 19 || !text.bytes().all(|b| b.is_ascii_digit()) {
                            return Err("invalid thumbnail time".into());
                        }
                    }
                    if thumbnails.is_none() {
                        let primary = video.as_ref().ok_or("no open video")?;
                        let mut reader = media::Video::open(
                            source_path.as_deref().ok_or("no source")?,
                            240,
                            Some(primary.info.matrix709),
                            Some(primary.info.full_range),
                        )?;
                        reader.cache_budget(cache::THUMBNAIL_BYTES);
                        thumbnails = Some(reader);
                    }
                    let frame = thumbnails.as_mut().ok_or("no thumbnail reader")?.locate(
                        time_hns.parse()?,
                        Some(seek_hns.parse()?),
                        &cancel,
                    )?;
                    frame_id = frame_id.checked_add(1).ok_or("frame id overflow")?;
                    let result = json!({"frameId":frame_id,"timestampHns":frame.timestamp_hns.to_string(),"durationHns":frame.duration_hns.to_string(),"width":frame.width,"height":frame.height,"format":"rgba8"});
                    pixels = frame.rgba;
                    Ok(result)
                }
                Command::ResetScan => {
                    audio = None;
                    let current = video.as_mut().ok_or("no open video")?;
                    current.invalidate_position();
                    current.source.seek(0)?;
                    Ok(json!({"reset":true}))
                }
                Command::ScanFrames { count } => {
                    if *count == 0 || *count > 128 {
                        return Err("invalid frame scan batch".into());
                    }
                    let current = video.as_mut().ok_or("no open video")?;
                    current.invalidate_position();
                    let source = &current.source;
                    let mut frames = Vec::new();
                    let mut ended = false;
                    for _ in 0..*count {
                        cancel.check()?;
                        let Some((sample, time)) = source.sample(media::VIDEO)? else {
                            ended = true;
                            break;
                        };
                        // SAFETY: sample is an owned COM object on the reader's initialized thread.
                        let duration = unsafe { sample.GetSampleDuration()? };
                        frames.push(json!({"timestampHns":time.to_string(), "durationHns":duration.to_string()}));
                    }
                    Ok(json!({"frames":frames,"ended":ended}))
                }
                Command::Read => {
                    let frame = video.as_mut().ok_or("no open video")?.read(&cancel)?;
                    match frame {
                        None => Ok(json!({"ended":true})),
                        Some(frame) => {
                            frame_id = frame_id.checked_add(1).ok_or("frame id overflow")?;
                            let result = json!({"frameId":frame_id, "timestampHns":frame.timestamp_hns.to_string(), "durationHns":frame.duration_hns.to_string(), "width":frame.width, "height":frame.height, "format":"rgba8"});
                            pixels = frame.rgba;
                            Ok(result)
                        }
                    }
                }
                Command::AudioStreams { path } => {
                    Ok(json!({"streams":audio_source::streams(path)?}))
                }
                Command::AudioScanOpen { path, stream_index } => {
                    audio = None;
                    audio_scan = None;
                    let reader = audio_source::AudioSource::open(path, *stream_index)?;
                    let info = json!({"sampleRate":reader.rate,"channels":2});
                    audio_scan = Some(reader);
                    Ok(info)
                }
                Command::AudioScan { count } => {
                    if *count == 0 || *count > 128 {
                        return Err("invalid audio scan batch".into());
                    }
                    let source = audio_scan.as_ref().ok_or("no audio scan open")?;
                    let mut frames = Vec::new();
                    let mut ended = false;
                    for _ in 0..*count {
                        cancel.check()?;
                        let Some((_, stamp, samples)) = source.sample()? else {
                            ended = true;
                            break;
                        };
                        frames.push(json!({"timestampHns":stamp.to_string(),"samples":samples}));
                    }
                    Ok(json!({"frames":frames,"ended":ended}))
                }
                Command::AudioScanClose => {
                    audio_scan = None;
                    Ok(json!({"closed":true}))
                }
                Command::AudioStart {
                    time_us,
                    path,
                    stream_index,
                    offset_hns,
                    end_us,
                } => {
                    audio = None;
                    audio_scan = None;
                    let offset = match offset_hns {
                        Some(text) => {
                            if text.len() > 20
                                || text.trim_start_matches('-').is_empty()
                                || !text
                                    .trim_start_matches('-')
                                    .bytes()
                                    .all(|b| b.is_ascii_digit())
                            {
                                return Err("invalid audio mapping offset".into());
                            }
                            text.parse()?
                        }
                        None => 0,
                    };
                    let playback = audio::Playback::start(audio::Options {
                        path: path
                            .clone()
                            .or_else(|| source_path.clone())
                            .ok_or("no open source")?,
                        time_us: *time_us,
                        end_us: *end_us,
                        stream: stream_index.unwrap_or(media::AUDIO),
                        offset_hns: offset,
                    })?;
                    let status = serde_json::to_value(playback.status())?;
                    audio = Some(playback);
                    Ok(status)
                }
                Command::AudioStatus => Ok(serde_json::to_value(
                    audio.as_ref().ok_or("audio is not running")?.status(),
                )?),
                Command::AudioStop => {
                    if let Some(mut playback) = audio.take() {
                        playback.stop()?;
                        return Ok(serde_json::to_value(playback.status())?);
                    }
                    Ok(json!({"running":false}))
                }
                Command::Close | Command::Shutdown => {
                    audio = None;
                    source_path = None;
                    video = None;
                    thumbnails = None;
                    audio_scan = None;
                    Ok(json!({"closed":true}))
                }
            }
        })();
        let result = result.and_then(|value| {
            if check_epoch {
                cancel.check()?;
            }
            Ok(value)
        });
        if result
            .as_ref()
            .is_err_and(|error| error.to_string() == "cancelled")
            && !matches!(
                request.command,
                Command::Thumbnail { .. } | Command::Prefetch { .. }
            )
        {
            audio = None;
        }
        match result {
            Ok(value) => transport.send(&request, value, &pixels, None)?,
            Err(error) => {
                let message: String = error.to_string().chars().take(1024).collect();
                transport.send(&request, serde_json::Value::Null, &[], Some(&message))?;
            }
        }
        if matches!(request.command, Command::Shutdown) {
            break;
        }
    }
    drop(audio);
    drop(audio_scan);
    drop(video);
    drop(thumbnails);
    transport.check_input()
}
fn main() {
    if let Err(error) = run() {
        eprintln!("motion-preview: {error}");
        std::process::exit(1);
    }
}
