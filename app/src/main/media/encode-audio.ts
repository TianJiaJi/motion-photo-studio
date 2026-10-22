import { writeFile } from 'node:fs/promises';
import { usToSeconds } from '../../shared/editor.ts';
import type { AudioSelection } from '../../shared/export.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import type { EnginePaths } from './engine.ts';
import { probeMedia, type Stream } from './probe.ts';
import { streamProcessLines } from './lines.ts';

export function validateEncodedAudio(stream: Stream | undefined, channels: number, durationUs: number, sampleRate = 48000): { channels: number; sampleRate: number; durationUs: number } {
  if (!stream || stream.codec_name !== 'aac' || stream.profile !== 'LC' || stream.channels !== channels || stream.sample_rate !== String(sampleRate)
    || stream.start_pts !== 0 || !Number.isSafeInteger(stream.duration_ts) || stream.time_base !== `1/${sampleRate}`)
    throw new Error('重新编码的音轨配置或起点未通过验证。');
  const actual = Number(BigInt(stream.duration_ts!) * 1000000n / BigInt(sampleRate));
  if (Math.abs(actual - durationUs) > 1000) throw new Error('重新编码的音轨结束点未通过验证。');
  return { channels, sampleRate, durationUs: actual };
}
export async function encodeAudioDraft(options: {
  source: SourceFile; selection: Extract<AudioSelection, { kind: 'track' }>; startUs: number; endUs: number; durationUs: number;
  output: string; engines: EnginePaths; signal: AbortSignal; matchSourceParameters?: boolean; onProgress?: (timeUs: number) => void | Promise<void>;
}): Promise<{ file: SourceFile; report: { channels: number; sampleRate: number; durationUs: number } }> {
  const { source, selection, signal, engines } = options;
  await assertSource(source); signal.throwIfAborted();
  const probe = await probeMedia(source.path, { executable: engines.ffprobe, signal });
  const audio = probe.streams.find(stream => stream.index === selection.index && stream.codec_type === 'audio');
  if (!audio || !Number.isSafeInteger(audio.channels) || audio.channels! < 1) throw new Error('所选音轨或声道信息无效。');
  if (!options.matchSourceParameters && audio.channels! > 2 && !selection.downmixStereo) throw new Error('多声道转为立体声需要明确同意，不会静默降混。');
  const channels = options.matchSourceParameters ? audio.channels! : Math.min(2, audio.channels!);
  const sampleRate = options.matchSourceParameters ? Number(audio.sample_rate) : 48000;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new Error('原音频采样率无效，不能自动猜测。');
  for (const value of [options.startUs, options.endUs, options.durationUs]) if (!Number.isSafeInteger(value)) throw new Error('Invalid audio interval');
  if (options.endUs <= options.startUs || Math.abs(options.durationUs - (options.endUs - options.startUs)) > 1) throw new Error('Invalid audio duration');
  await writeFile(options.output, '', { flag: 'wx' }); let succeeded = false;
  try {
    // Decode from the real beginning; a seek inside an audio gap can skip valid later samples.
    const af = [`atrim=start=${usToSeconds(options.startUs)}:end=${usToSeconds(options.endUs)}`,
      `asetpts=PTS-(${options.startUs}/1000000)/TB`, `aresample=${sampleRate}:async=1:min_hard_comp=0.001:first_pts=0`, 'apad', `atrim=end=${usToSeconds(options.durationUs)}`];
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostats', '-nostdin', '-y', '-xerror',
      '-protocol_whitelist', 'file,pipe', '-err_detect', 'explode', '-copyts', '-i', source.path,
      '-map', `0:${audio.index}`, '-vn', '-af', af.join(','), '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', String(sampleRate), '-ac', String(channels), '-b:a', '192k',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'disabled', '-use_editlist', '1', '-progress', 'pipe:1', '-f', 'mp4', options.output],
    async line => { const match = /^out_time_us=(-?\d+)$/.exec(line); if (match && Number.isSafeInteger(Number(match[1]))) await options.onProgress?.(Math.max(0, Number(match[1]))); }, { signal, timeoutMs: 0 });
    const file = await openSource(options.output); const metadata = await probeMedia(file.path, { executable: engines.ffprobe, signal });
    if (metadata.streams.length !== 1 || metadata.streams[0]?.codec_type !== 'audio') throw new Error('Unexpected encoded audio streams');
    const report = validateEncodedAudio(metadata.streams[0], channels, options.durationUs, sampleRate);
    await assertSource(source); await assertSource(file); signal.throwIfAborted(); succeeded = true; return { file, report };
  } catch (error) { if (!signal.aborted) await assertSource(source); throw error; }
  finally { if (!succeeded) await unlinkCreatedFile(options.output); }
}
