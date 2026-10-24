use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const VERSION: u32 = 1;
pub const MAX_HEADER: usize = 16 * 1024;
pub const MAX_PIXELS: usize = 1280 * 1280 * 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u32,
    pub id: u64,
    pub generation: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum Command {
    Hello,
    Open {
        path: String,
        #[serde(rename = "maximumEdge")]
        maximum_edge: u32,
        #[serde(rename = "matrix709")]
        matrix709: Option<bool>,
        #[serde(rename = "fullRange")]
        full_range: Option<bool>,
    },
    Seek {
        #[serde(rename = "timeUs")]
        time_us: u64,
    },
    Locate {
        #[serde(rename = "timeHns")]
        time_hns: String,
        #[serde(rename = "seekHns")]
        seek_hns: Option<String>,
        #[serde(default)]
        playback: bool,
    },
    Thumbnail {
        #[serde(rename = "timeHns")]
        time_hns: String,
        #[serde(rename = "seekHns")]
        seek_hns: String,
    },
    Quality {
        #[serde(rename = "maximumEdge")]
        maximum_edge: u32,
    },
    Prefetch {
        count: u32,
    },
    Stats,
    ResetScan,
    ScanFrames {
        count: u32,
    },
    Read,
    AudioStreams {
        path: String,
    },
    AudioScanOpen {
        path: String,
        #[serde(rename = "streamIndex")]
        stream_index: u32,
    },
    AudioScan {
        count: u32,
    },
    AudioScanClose,
    AudioStart {
        #[serde(rename = "timeUs")]
        time_us: u64,
        path: Option<String>,
        #[serde(rename = "streamIndex")]
        stream_index: Option<u32>,
        #[serde(rename = "offsetHns")]
        offset_hns: Option<String>,
        #[serde(rename = "endUs")]
        end_us: Option<u64>,
    },
    AudioStatus,
    AudioStop,
    Close,
    Shutdown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<'a> {
    pub version: u32,
    pub id: u64,
    pub generation: u64,
    pub body_bytes: usize,
    pub result: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}

pub fn read_request(input: &mut impl Read) -> AppResult<Option<Request>> {
    let mut len = [0u8; 4];
    // A clean EOF is different from a truncated length prefix.
    if input.read(&mut len[..1])? == 0 {
        return Ok(None);
    }
    input.read_exact(&mut len[1..])?;
    let size = u32::from_le_bytes(len) as usize;
    if size == 0 || size > MAX_HEADER {
        return Err("invalid request length".into());
    }
    let mut data = vec![0; size];
    input.read_exact(&mut data)?;
    // Serde deny_unknown_fields cannot be combined with a flattened tagged enum.
    // Validate the complete command-specific whitelist before deserializing instead.
    let value: serde_json::Value = serde_json::from_slice(&data)?;
    let fields = value.as_object().ok_or("request must be an object")?;
    let extra: &[&str] = match fields.get("command").and_then(|x| x.as_str()) {
        Some("open") => &["path", "maximumEdge", "matrix709", "fullRange"],
        Some("seek") => &["timeUs"],
        Some("audioStart") => &["timeUs", "path", "streamIndex", "offsetHns", "endUs"],
        Some("audioScanOpen") => &["path", "streamIndex"],
        Some("audioStreams") => &["path"],
        Some("locate") => &["timeHns", "seekHns", "playback"],
        Some("thumbnail") => &["timeHns", "seekHns"],
        Some("quality") => &["maximumEdge"],
        Some("scanFrames" | "prefetch" | "audioScan") => &["count"],
        Some(
            "hello" | "read" | "audioStatus" | "audioStop" | "close" | "shutdown" | "resetScan"
            | "stats" | "audioScanClose",
        ) => &[],
        _ => return Err("unknown command".into()),
    };
    if fields.keys().any(|key| {
        !["version", "id", "generation", "command"].contains(&key.as_str())
            && !extra.contains(&key.as_str())
    }) {
        return Err("unexpected request field".into());
    }
    let request: Request = serde_json::from_value(value)?;
    if request.id > 9_007_199_254_740_991 || request.generation > 9_007_199_254_740_991 {
        return Err("request identity exceeds safe range".into());
    }
    if request.version != VERSION {
        return Err("unsupported protocol version".into());
    }
    Ok(Some(request))
}

pub fn send(
    output: &mut impl Write,
    id: u64,
    generation: u64,
    result: serde_json::Value,
    pixels: &[u8],
    error: Option<&str>,
) -> AppResult<()> {
    if pixels.len() > MAX_PIXELS {
        return Err("oversized frame payload".into());
    }
    let header = serde_json::to_vec(&Envelope {
        version: VERSION,
        id,
        generation,
        body_bytes: pixels.len(),
        result,
        error,
    })?;
    if header.len() > MAX_HEADER {
        return Err("oversized response header".into());
    }
    output.write_all(&(header.len() as u32).to_le_bytes())?;
    output.write_all(&header)?;
    output.write_all(pixels)?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_versioned_commands_and_rejects_unknown_input() {
        for body in [
            r#"{"version":1,"id":1,"generation":1,"command":"hello"}"#,
            r#"{"version":1,"id":2,"generation":1,"command":"seek","timeUs":123}"#,
        ] {
            let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
            bytes.extend_from_slice(body.as_bytes());
            assert!(matches!(read_request(&mut &bytes[..]), Ok(Some(_))));
        }
        for body in [
            r#"{"version":2,"id":1,"generation":1,"command":"hello"}"#,
            r#"{"version":1,"id":1,"generation":1,"command":"exec","shell":"cmd"}"#,
        ] {
            let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
            bytes.extend_from_slice(body.as_bytes());
            assert!(read_request(&mut &bytes[..]).is_err());
        }
    }
    #[test]
    fn rejects_unbounded_or_truncated_messages() {
        assert!(read_request(&mut &u32::MAX.to_le_bytes()[..]).is_err());
        assert!(read_request(&mut &[1u8, 0][..]).is_err());
        assert!(matches!(read_request(&mut &[][..]), Ok(None)));
    }
}
