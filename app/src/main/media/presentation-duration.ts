import { setImmediate as yieldTask } from 'node:timers/promises';
import { parseRational } from '../../shared/editor.ts';
import type { Stream } from './probe.ts';
import { openSource, assertSource } from './source.ts';
import { readMp4SampleIndex, selectMp4Track, Mp4IndexError, type Mp4TrackIndex } from './mp4-sample-index.ts';

// mdhd/ffprobe duration can describe the decode clock rather than the last presented
// B-frame's end. Only extend it when sample PTS AND an unambiguous edit list prove
// the complete presentation range. Never revive samples deliberately clipped by edits.
export async function presentationDurationTicks(track: Mp4TrackIndex, movieTimescale: number,
  stream: Stream, signal?: AbortSignal): Promise<number | undefined> {
  const base = parseRational(stream.time_base);
  if (!base || !['avc1', 'hvc1'].includes(track.codec) || track.sampleCount < 1 || track.sampleCount > 100_000
    || BigInt(base.numerator) * BigInt(track.timescale) !== BigInt(base.denominator)
    || !Number.isSafeInteger(stream.start_pts) || !Number.isSafeInteger(stream.duration_ts) || stream.duration_ts! <= 0) return;
  let leading = 0n; let shift = 0n; let editEnd: bigint | undefined; let media = false;
  const movieScale = BigInt(movieTimescale); const trackScale = BigInt(track.timescale);
  for (const edit of track.edits) {
    if (edit.mediaTime === -1n && !media) {
      const ticks = edit.duration * trackScale;
      if (ticks % movieScale) return;
      leading += ticks / movieScale;
    } else if (edit.mediaTime >= 0n && !media && edit.duration > 0n) {
      media = true; shift = leading - edit.mediaTime;
      // Scaled rational endpoint; do not round an edit outwards to admit an extra frame.
      editEnd = leading * movieScale + edit.duration * trackScale;
    } else return;
  }
  if (track.edits.length && !media) return;
  const start = BigInt(stream.start_pts!);
  let first: bigint | undefined; let end = start;
  let sampleDuration: number | undefined;
  for (let i = 0; i < track.sampleCount; i++) {
    if ((i & 4095) === 0) { await yieldTask(); signal?.throwIfAborted(); }
    const sample = track.sample(i); const pts = sample.pts + shift;
    // With reordered VFR, stts durations advance the DECODE clock and do not
    // establish the final presentation hold. Keep the declared range unless
    // a constant sample duration makes this tail-extension proof unambiguous.
    sampleDuration ??= sample.duration;
    if (sample.duration !== sampleDuration) return;
    const sampleEnd = pts + BigInt(sample.duration);
    if (pts < start || sample.duration <= 0 || sampleEnd >= 1n << 63n
      || editEnd !== undefined && sampleEnd * movieScale > editEnd) return;
    if (first === undefined || pts < first) first = pts;
    if (sampleEnd > end) end = sampleEnd;
  }
  const duration = end - start;
  if (first !== start || duration <= BigInt(stream.duration_ts!) || duration > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return Number(duration);
}

export async function reconcilePresentationDurations(path: string,
  probe: { streams: Stream[]; format: { format_name?: string } }, signal?: AbortSignal): Promise<void> {
  if (!(probe.format.format_name ?? '').split(',').some(format => format === 'mov' || format === 'mp4')) return;
  const source = await openSource(path);
  let container;
  try { container = await readMp4SampleIndex(source, { signal }); }
  catch (error) {
    signal?.throwIfAborted(); await assertSource(source);
    if (error instanceof Mp4IndexError) return; // Unsupported/fragmented inputs keep the decoded validation path.
    throw error;
  }
  for (const stream of probe.streams) {
    if (stream.codec_type !== 'video' || stream.disposition?.attached_pic) continue;
    let track;
    try { track = selectMp4Track(container, stream.id, 'vide'); }
    catch (error) { if (error instanceof Mp4IndexError) continue; throw error; }
    const duration = await presentationDurationTicks(track, container.movieTimescale, stream, signal);
    if (duration !== undefined) {
      stream.duration_ts = duration;
      stream.duration = String(duration / track.timescale);
    }
  }
  await assertSource(source); signal?.throwIfAborted();
}
