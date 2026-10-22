import { writeFile, stat } from 'node:fs/promises';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import type { MediaInfo } from '../../shared/media.ts';
import { parseRational, ptsToUs, usToSeconds } from '../../shared/editor.ts';
import type { Rational } from '../../shared/editor.ts';
import { runProcess } from './runner.ts';

export type ExtractedFrame = { path: string; pts: string; timeBase: Rational; actualTimeUs: number };
export function normalizedFrameFilters(info: MediaInfo, thumbnail = false): string[] {
  const filters: string[] = [];
  if (info.hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  filters.push(`scale=${info.displayWidth}:${info.displayHeight}`, 'setsar=1');
  if (thumbnail) {
    const ratio = Math.min(1, 180 / Math.max(info.displayWidth, info.displayHeight));
    filters.push(`scale=${Math.max(2, Math.floor(info.displayWidth * ratio / 2) * 2)}:${Math.max(2, Math.floor(info.displayHeight * ratio / 2) * 2)}`, 'setsar=1');
  }
  return filters;
}

function framePositions(stderr: string, info: MediaInfo) {
  const baseMatch = /config in time_base:\s*(\d+\/\d+)/.exec(stderr);
  const timeBase = parseRational(baseMatch?.[1]);
  const pts = [...stderr.matchAll(/\[Parsed_showinfo_\d+ @ [a-fA-F0-9x]+\]\s+n:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/g)].map(match => match[1]!);
  if (!pts.length) return [];
  if (!timeBase) throw new Error('Cannot verify decoded frame time base');
  if (BigInt(timeBase.numerator) * BigInt(info.timeBase.denominator)
    !== BigInt(info.timeBase.numerator) * BigInt(timeBase.denominator)) throw new Error('Unexpected decoded frame time base');
  return pts.map(value => ({ pts: value, timeBase, actualTimeUs: ptsToUs(value, info.startPts, timeBase) }));
}

// Only creates a fresh, caller-owned temporary output. Existing paths are never overwritten.
// Forward seek returns the first presented frame >= request, not HTML video's approximate seek.
// Backward stepping uses a streaming trim and update-one-JPEG, not a memory-heavy reverse filter.
export async function extractFrame(options: {
  executable: string; input: string; output: string; info: MediaInfo; timeUs: number;
  beforePts?: string; afterPts?: string; thumbnail?: boolean; signal?: AbortSignal;
}): Promise<ExtractedFrame> {
  const { info, signal } = options;
  if (!Number.isSafeInteger(options.timeUs) || options.timeUs < 0 || options.timeUs > info.durationUs) throw new Error('Invalid frame request time');
  if ([options.beforePts, options.afterPts].some(value => value !== undefined && !/^-?\d+$/.test(value))
    || options.beforePts !== undefined && options.afterPts !== undefined) throw new Error('Invalid frame cursor');
  const ptsAt = (timeUs: number) => BigInt(info.startPts)
    + (BigInt(timeUs) * BigInt(info.timeBase.denominator) + BigInt(info.timeBase.numerator) * 1000000n - 1n)
      / (BigInt(info.timeBase.numerator) * 1000000n);
  const requestedPts = ptsAt(options.timeUs);
  signal?.throwIfAborted();
  await writeFile(options.output, '', { flag: 'wx' });
  let succeeded = false;
  try {
    const run = async (seekUs: number, endPts?: string) => {
      // Keep demuxer keyframe seeking, but do accurate trimming ourselves in the original PTS domain.
      // FFmpeg's automatic accurate_seek + copyts can double-apply a nonzero source start time.
      const filters = [endPts === undefined
        ? `trim=start_pts=${options.afterPts === undefined ? requestedPts : BigInt(options.afterPts) + 1n}`
        : `trim=start_pts=${ptsAt(seekUs)}:end_pts=${endPts}`, 'showinfo', ...normalizedFrameFilters(info, options.thumbnail)];
      const result = await runProcess(options.executable, ['-hide_banner', '-v', 'info', '-nostats', '-nostdin', '-y',
        '-protocol_whitelist', 'file,pipe', '-seek_timestamp', '1', '-ss', usToSeconds(info.startUs + seekUs), '-noaccurate_seek', '-copyts',
        '-i', options.input, '-map', `0:${info.videoIndex}`, '-an', '-vf', filters.join(','),
        ...(endPts === undefined ? ['-frames:v', '1'] : []), '-fps_mode', 'passthrough',
        '-pix_fmt', 'yuvj420p', '-color_range', 'pc', '-q:v', '2', '-update', '1', options.output],
      { signal, timeoutMs: 120000 });
      return framePositions(result.stderr, info);
    };
    let frames: ReturnType<typeof framePositions> = [];
    if (options.beforePts === undefined && options.timeUs < info.durationUs) frames = await run(options.timeUs);
    if (frames.length && (await stat(options.output)).size > 0) {
      signal?.throwIfAborted();
      succeeded = true;
      return { path: options.output, ...frames[0]! };
    }
    if (options.afterPts !== undefined) throw new Error('No following video frame');
    // No later frame (e.g. seeking into final frame's duration), or an explicit previous-frame request.
    const endPts = options.beforePts ?? String(requestedPts);
    let windowUs = 1000000;
    for (;;) {
      const startUs = Math.max(0, options.timeUs - windowUs);
      frames = await run(startUs, endPts);
      if (frames.length && (await stat(options.output)).size > 0) {
        signal?.throwIfAborted();
        succeeded = true;
        return { path: options.output, ...frames.at(-1)! };
      }
      if (startUs === 0) throw new Error('No preceding video frame');
      windowUs = Math.min(options.timeUs, windowUs * 2);
      signal?.throwIfAborted();
    }
  } finally { if (!succeeded) await unlinkCreatedFile(options.output); }
}
