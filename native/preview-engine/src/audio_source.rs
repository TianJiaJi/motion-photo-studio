//! Bounded selected-track MF PCM reader, shared by import verification and WASAPI playback.
use crate::{
    AppResult,
    media::{self, Reader},
};
use windows::Win32::Media::MediaFoundation::*;
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub stream_index: u32,
    pub sample_rate: u32,
    pub channels: u32,
}
pub fn streams(path: &str) -> AppResult<Vec<AudioStream>> {
    let source = Reader::open(path, &media::attributes()?, false)?;
    let mut found = Vec::new();
    // SAFETY: COM initialized by caller; native indices are bounded and all interfaces owned.
    unsafe {
        for index in 0..64 {
            let native = match source.reader.GetNativeMediaType(index, 0) {
                Ok(native) => native,
                Err(error) if error.code() == MF_E_INVALIDSTREAMNUMBER => return Ok(found),
                Err(error) => return Err(error.into()),
            };
            if native.GetGUID(&MF_MT_MAJOR_TYPE)? == MFMediaType_Audio {
                found.push(AudioStream {
                    stream_index: index,
                    sample_rate: native.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?,
                    channels: native.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)?,
                });
            }
        }
    }
    Err("source exceeds native stream enumeration budget".into())
}
pub struct AudioSource {
    pub source: Reader,
    pub rate: u32,
    stream: u32,
}
impl AudioSource {
    pub fn open(path: &str, stream: u32) -> AppResult<Self> {
        let attrs = media::attributes()?;
        let source = Reader::open(path, &attrs, false)?;
        // SAFETY: caller owns a COM-initialized thread; all media types/interfaces are owned.
        unsafe {
            let native = source.reader.GetNativeMediaType(stream, 0)?;
            if native.GetGUID(&MF_MT_MAJOR_TYPE)? != MFMediaType_Audio {
                return Err("selected stream is not audio".into());
            }
            let rate = native.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?;
            if !(8000..=192000).contains(&rate) {
                return Err("unsupported audio sample rate".into());
            }
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
            output.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            output.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
            output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32)?;
            output.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 8)?;
            output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * 8)?;
            source.reader.SetStreamSelection(stream, true)?;
            source.reader.SetCurrentMediaType(stream, None, &output)?;
            Ok(Self {
                source,
                rate,
                stream,
            })
        }
    }
    pub fn sample(&self) -> AppResult<Option<(IMFSample, i64, u32)>> {
        let Some((sample, timestamp)) = self.source.sample(self.stream)? else {
            return Ok(None);
        };
        // SAFETY: sample belongs to this reader/thread. No buffer is dereferenced here.
        unsafe {
            let actual = self.source.reader.GetCurrentMediaType(self.stream)?;
            if actual.GetGUID(&MF_MT_SUBTYPE)? != MFAudioFormat_Float
                || actual.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)? != 2
                || actual.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)? != self.rate
                || actual.GetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT)? != 8
            {
                return Err("decoded audio format changed".into());
            }
            let bytes = sample.GetTotalLength()?;
            if bytes == 0 || !bytes.is_multiple_of(8) || bytes > self.rate * 8 * 2 {
                return Err("audio input exceeds two-second buffer budget".into());
            }
            Ok(Some((sample, timestamp, bytes / 8)))
        }
    }
}
