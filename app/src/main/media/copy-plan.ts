import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parseRational, ptsToUs, validateClip, type ClipSelection, type Rational } from '../../shared/editor.ts';
import { safeInteger } from '../motion/io.ts';
import { assertSource, type SourceFile } from './source.ts';
import { packetHasIdr, scanPackets, type MediaPacket } from './packets.ts';

export type CopyVideoTrack = {
  index: number; timeBase: string; startPts: string; endPts: string; nalLengthBytes: number;
};
export type CopyRangePlan = {
  sourceStamp: string; videoIndex: number; timeBase: Rational; requested: ClipSelection; actual: ClipSelection;
  startPts: string; endPts: string; firstDts: string; packetCount: number;
  payloadDigest: string; timingDigest: string; endKind: 'idr' | 'eof';
};
function integer(value: string): bigint {
  if (!/^-?\d{1,20}$/.test(value)) throw new Error('Invalid copy-plan timestamp');
  const n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error('Copy-plan timestamp out of range');
  return n;
}
function fraction(ticks: bigint, base: Rational): string {
  let numerator = ticks * BigInt(base.numerator); let denominator = BigInt(base.denominator);
  let a = numerator < 0n ? -numerator : numerator; let b = denominator;
  while (b) { const next = a % b; a = b; b = next; }
  numerator /= a; denominator /= a;
  return `${numerator}/${denominator}`;
}
export function packetTimingKey(packet: MediaPacket, origin: bigint, timeBase: Rational): string {
  if (packet.pts === null || packet.dts === null || packet.duration === null) throw new Error('Missing packet timing');
  return `${fraction(packet.pts - origin, timeBase)}:${fraction(packet.dts - origin, timeBase)}:${fraction(packet.duration, timeBase)}\n`;
}
export function packetPayloadKey(packet: MediaPacket): string {
  if (!packet.hash) throw new Error('Missing compressed packet hash');
  return `${packet.size}:${packet.hash}\n`;
}

// Native-only: the caller must first establish compatible H.264 AVCC in MP4/MOV.
// Scans incrementally until the first IDR at/after the requested end (or EOF), retaining no packet array.
export async function planCopyRange(source: SourceFile, video: CopyVideoTrack, requested: ClipSelection,
  options: { executable: string; signal?: AbortSignal; onProgress?: (sourceTimeUs: number) => void }): Promise<CopyRangePlan> {
  const base = parseRational(video.timeBase);
  if (!base || ![1, 2, 4].includes(video.nalLengthBytes)) throw new Error('Unsupported copy-plan stream parameters');
  safeInteger(video.index, 'video stream index');
  const origin = integer(video.startPts); const sourceEnd = integer(video.endPts);
  const durationUs = ptsToUs(video.endPts, video.startPts, base);
  const clip = validateClip(requested, durationUs);
  await assertSource(source); options.signal?.throwIfAborted();
  const file = await open(source.path, 'r');
  let start: bigint | undefined; let firstDts: bigint | undefined; let lastDts: bigint | undefined;
  let maximumPts: bigint | undefined; let maximumEnd: bigint | undefined;
  let count = 0; let end = sourceEnd; let endKind: 'idr' | 'eof' = 'eof';
  let payload = createHash('sha256'); let timing = createHash('sha256');
  let progress = 0; let lastNotice = 0;
  const compare = (pts: bigint, us: number) => (pts - origin) * BigInt(base.numerator) * 1000000n - BigInt(us) * BigInt(base.denominator);
  try {
    await scanPackets({ executable: options.executable, input: source.path, hashes: true, signal: options.signal,
      onPacket: async packet => {
        if (packet.streamIndex !== video.index) return;
        if (packet.pts === null || packet.dts === null || packet.duration === null || packet.duration <= 0n || packet.corrupt)
          throw new Error('原画边界无法确认：视频压缩包缺少有效时间戳或已损坏。');
        if (lastDts !== undefined && packet.dts <= lastDts) throw new Error('原画边界无法确认：解码时间戳不是严格递增。');
        lastDts = packet.dts;
        progress = Math.max(progress, Math.min(durationUs, ptsToUs(String(packet.pts), video.startPts, base)));
        if (performance.now() - lastNotice >= 200) { options.onProgress?.(progress); lastNotice = performance.now(); }
        const idr = packet.key && !packet.discard && packet.pts >= origin
          && await packetHasIdr(file, source.size, packet, video.nalLengthBytes, options.signal);
        if (idr && compare(packet.pts, clip.startUs) <= 0) {
          start = packet.pts; firstDts = packet.dts; maximumPts = undefined; maximumEnd = undefined; count = 0;
          payload = createHash('sha256'); timing = createHash('sha256');
        } else if (idr && start !== undefined && compare(packet.pts, clip.endUs) >= 0) {
          end = packet.pts; endKind = 'idr'; return true;
        }
        if (start === undefined) return;
        if (packet.discard || packet.pts < start) throw new Error('原画区间包含依赖前置画面的预滚包，不能安全直出。');
        maximumPts = maximumPts === undefined || packet.pts > maximumPts ? packet.pts : maximumPts;
        const packetEnd = packet.pts + packet.duration;
        maximumEnd = maximumEnd === undefined || packetEnd > maximumEnd ? packetEnd : maximumEnd;
        count = safeInteger(count + 1, 'selected packet count');
        payload.update(packetPayloadKey(packet)); timing.update(packetTimingKey(packet, start, base));
      } });
    options.signal?.throwIfAborted();
    await assertSource(source);
    if (start === undefined || firstDts === undefined || maximumPts === undefined || count === 0)
      throw new Error('未找到请求起点之前可独立解码的 IDR，不能安全原画直出。');
    if (end > sourceEnd || end <= maximumPts || end <= start || (endKind === 'eof' && maximumEnd !== sourceEnd))
      throw new Error('原画片段的呈现边界与媒体时长冲突，请改用精确模式。');
    const actual = { startUs: ptsToUs(String(start), video.startPts, base), endUs: ptsToUs(String(end), video.startPts, base) };
    options.onProgress?.(actual.endUs);
    return { sourceStamp: source.stamp, videoIndex: video.index, timeBase: base, requested: clip, actual,
      startPts: String(start), endPts: String(end), firstDts: String(firstDts), packetCount: count,
      payloadDigest: payload.digest('hex'), timingDigest: timing.digest('hex'), endKind };
  } finally { await file.close(); }
}
