import { parseRational, ptsToUs, usToSeconds, validateClip, type ClipSelection, type Rational } from '../../shared/editor.ts';
import type { MediaInfo } from '../../shared/media.ts';
import type { MediaProbe } from './probe.ts';
import { mediaInfo } from './info.ts';
import { assertSource, type SourceFile } from './source.ts';
import { streamProcessLines } from './lines.ts';

export type PresentedFrame = { pts: bigint; duration: bigint | null };
export type EncodeRangePlan = {
  sourceStamp: string; videoIndex: number; timeBase: Rational; sourceStartPts: string;
  requested: ClipSelection; actual: ClipSelection; startPts: string; lastPts: string; endPts: string; endKind: 'frame' | 'eof';
};
function tick(value: string | undefined): bigint | null {
  if (value === undefined || value === 'N/A') return null;
  if (!/^-?\d{1,20}$/.test(value)) throw new Error('Invalid decoded frame timestamp');
  const result = BigInt(value);
  if (result < -(1n << 63n) || result > (1n << 63n) - 1n) throw new Error('Decoded frame timestamp exceeds 64 bits');
  return result;
}
export function parsePresentedFrame(line: string, streamIndex: number): PresentedFrame | null {
  if (!line || line.startsWith('#')) return null;
  const fields = line.split(',').map(value => value.trim());
  if (fields.length !== 6 || fields[0] !== String(streamIndex) || !/^\d+$/.test(fields[4] ?? '') || !/^[a-f0-9]{64}$/.test(fields[5] ?? ''))
    throw new Error('Unexpected decoded frame clock report');
  const dts = tick(fields[1]); const pts = tick(fields[2]); const duration = tick(fields[3]);
  if (pts === null || pts !== dts || duration === null || duration < 0n) throw new Error('Missing or invalid decoded presentation time');
  return { pts, duration };
}
export function requestedFramePts(info: Pick<MediaInfo, 'startPts' | 'timeBase'>, timeUs: number): bigint {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new Error('Invalid frame boundary request');
  const denominator = BigInt(info.timeBase.numerator) * 1000000n;
  return BigInt(info.startPts) + (BigInt(timeUs) * BigInt(info.timeBase.denominator) + denominator - 1n) / denominator;
}

// Seek near each edge independently, not through the complete selected interval. Frames remain streaming.
// The pinned ffprobe read_intervals query was observed to sometimes return 0/2 of 240 frames with exit 0.
// Use the actual FFmpeg decoder and wrapped_avframe timestamp carrier instead. Its framehash digest is
// NOT a pixel/payload identity proof (it hashes an AVFrame wrapper); only the checked clock fields are used.
// A demuxer may seek later than requested: retry farther back until an earlier frame establishes coverage.
export type FrameScanTrace = { timeUs: number; seekUs: number; lines: number; frames: number; stopped: boolean; stdoutBytes: number;
  firstPts: string | null; lastPts: string | null; foundPts: string | null };
async function frameAtOrAfter(source: SourceFile, info: MediaInfo, timeUs: number,
  executable: string, signal?: AbortSignal, onScan?: (trace: FrameScanTrace) => void): Promise<{ found: PresentedFrame | null; last: PresentedFrame | null }> {
  const target = requestedFramePts(info, timeUs);
  let backUs = 1000000;
  for (;;) {
    signal?.throwIfAborted();
    const seekUs = Math.max(0, timeUs - backUs);
    const state: { first: PresentedFrame | null; last: PresentedFrame | null; found: PresentedFrame | null; retry: boolean } = {
      first: null, last: null, found: null, retry: false,
    };
    let lines = 0; let frames = 0; let clockSeen = false;
    const result = await streamProcessLines(executable, ['-hide_banner', '-v', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-err_detect', 'explode', '-copyts', '-noautorotate',
      ...(seekUs > 0 ? ['-seek_timestamp', '1', '-ss', usToSeconds(info.startUs + seekUs), '-noaccurate_seek'] : []),
      '-i', source.path, '-map', `0:${info.videoIndex}`, '-an', '-vf', `settb=${info.timeBase.numerator}/${info.timeBase.denominator}`,
      '-c:v', 'wrapped_avframe', '-enc_time_base:v', 'filter', '-fps_mode', 'passthrough',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-f', 'framehash', '-hash', 'sha256', '-'], line => {
      lines++;
      const clock = /^#tb 0:\s*(\d+\/\d+)$/.exec(line);
      if (clock) {
        const base = parseRational(clock[1]);
        if (!base || BigInt(base.numerator) * BigInt(info.timeBase.denominator) !== BigInt(info.timeBase.numerator) * BigInt(base.denominator))
          throw new Error('Unexpected decoded frame time base');
        clockSeen = true;
      }
      const frame = parsePresentedFrame(line, 0); if (!frame) return;
      if (!clockSeen) throw new Error('Missing decoded frame time base');
      frames++;
      if (!state.first && seekUs > 0 && frame.pts >= target) { state.retry = true; return true; }
      if (state.last && frame.pts <= state.last.pts) throw new Error('视频呈现时间不递增，无法确认精确剪点。');
      state.first ??= frame;
      if (frame.pts >= target) { state.found = frame; return true; }
      state.last = frame;
    }, { signal, timeoutMs: 0 });
    onScan?.({ timeUs, seekUs, lines, frames, stopped: result.stopped, stdoutBytes: result.stdoutBytes,
      firstPts: state.first?.pts.toString() ?? null, lastPts: state.last?.pts.toString() ?? null, foundPts: state.found?.pts.toString() ?? null });
    if (result.stderr.trim()) throw new Error(`Frame-boundary decoder reported an error: ${result.stderr}`);
    if (seekUs > 0 && (state.retry || !state.first)) { backUs = Math.min(timeUs, backUs * 2); continue; }
    return { found: state.found, last: state.last };
  }
}

export async function planEncodeRange(source: SourceFile, probe: MediaProbe, requested: ClipSelection,
  options: { executable: string; signal?: AbortSignal; onScan?: (trace: FrameScanTrace) => void }): Promise<EncodeRangePlan> {
  await assertSource(source); options.signal?.throwIfAborted();
  const info = mediaInfo(probe); const clip = validateClip(requested, info.durationUs);
  const video = probe.streams.find(stream => stream.index === info.videoIndex)!;
  const sourceEnd = video.duration_ts !== undefined && Number.isSafeInteger(video.duration_ts) && video.duration_ts > 0
    ? BigInt(info.startPts) + BigInt(video.duration_ts) : requestedFramePts(info, info.durationUs);
  const start = await frameAtOrAfter(source, info, clip.startUs, options.executable, options.signal, options.onScan);
  if (!start.found || start.found.pts >= sourceEnd) throw new Error('所选起点之后没有可导出的画面，请前移开始时间。');
  const finish = await frameAtOrAfter(source, info, clip.endUs, options.executable, options.signal, options.onScan);
  if (!finish.found && (!finish.last || finish.last.duration === null || finish.last.duration <= 0n
    || finish.last.pts + finish.last.duration < sourceEnd)) throw new Error('无法确认视频尾部的实际帧覆盖范围。');
  const endKind = finish.found && finish.found.pts < sourceEnd ? 'frame' : 'eof';
  const end = endKind === 'frame' ? finish.found!.pts : sourceEnd;
  if (end <= start.found.pts) throw new Error('所选区间不足一个可呈现帧，请调整开始或结束时间。');
  if (!finish.last || finish.last.pts < start.found.pts || finish.last.pts >= end) throw new Error('无法确认选段最后一个呈现帧。');
  await assertSource(source); options.signal?.throwIfAborted();
  return { sourceStamp: source.stamp, videoIndex: info.videoIndex, timeBase: { ...info.timeBase }, sourceStartPts: info.startPts,
    requested: clip, actual: { startUs: ptsToUs(String(start.found.pts), info.startPts, info.timeBase),
      endUs: ptsToUs(String(end), info.startPts, info.timeBase) }, startPts: String(start.found.pts), lastPts: String(finish.last.pts), endPts: String(end), endKind };
}
