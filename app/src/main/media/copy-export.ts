import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRational, ptsToUs, usToSeconds, type Rational } from '../../shared/editor.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { safeInteger } from '../motion/io.ts';
import type { EnginePaths } from './engine.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import { assessCopySupport, probeCopySource, type CopyProbe, type CopySupport } from './copy-support.ts';
import { packetPayloadKey, packetTimingKey, type CopyRangePlan } from './copy-plan.ts';
import { scanPackets, type MediaPacket } from './packets.ts';
import { streamProcessLines } from './lines.ts';

type Supported = Extract<CopySupport, { supported: true }>;
export type CopyStage = 'copy' | 'verify-packets' | 'verify-source-audio' | 'decode';
export type CopyReport = {
  videoPackets: number; videoDurationUs: number; payloadDigest: string; timingDigest: string;
  audio: null | { packets: number; packetStartUs: number; packetEndUs: number; playableStartUs: number;
    playableEndUs: number; skippedSamples: number; discardedSamples: number; tailBeyondVideoUs: number; payloadDigest: string };
  warnings: string[];
};
const maximum = (a: bigint, b: bigint) => a > b ? a : b;
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
function rounded(n: bigint, d: bigint): bigint {
  return n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
}
function ceiling(n: bigint, d: bigint): bigint { return n < 0n ? n / d : (n + d - 1n) / d; }
function samplesToUs(samples: bigint, rate: number): number {
  const us = Number(samples * 1000000n / BigInt(rate));
  if (!Number.isSafeInteger(us)) throw new Error('Audio time exceeds safe precision');
  return us;
}
class Digests {
  count = 0; first: MediaPacket | null = null; last: MediaPacket | null = null;
  readonly base: Rational; readonly origin: bigint;
  private payload = createHash('sha256'); private timing = createHash('sha256');
  constructor(base: Rational, origin: bigint) { this.base = base; this.origin = origin; }
  add(packet: MediaPacket): void {
    if (packet.pts === null || packet.dts === null || packet.duration === null || packet.duration <= 0n || packet.corrupt)
      throw new Error('原画验证失败：压缩包缺少有效时间或已损坏。');
    if (this.last && packet.dts <= this.last.dts!) throw new Error('原画验证失败：解码时间不递增。');
    this.count = safeInteger(this.count + 1, 'packet count');
    this.first ??= { ...packet }; this.last = { ...packet };
    this.payload.update(packetPayloadKey(packet)); this.timing.update(packetTimingKey(packet, this.origin, this.base));
  }
  finish() { return { payload: this.payload.digest('hex'), timing: this.timing.digest('hex') }; }
}
function sampleClock(base: Rational, rate: number): void {
  if (BigInt(base.numerator) * BigInt(rate) !== BigInt(base.denominator))
    throw new Error('当前原画校验需要与采样率一致的音频时间基准；不会静默重采样。');
}
function checkedPlan(source: SourceFile, support: Supported, plan: CopyRangePlan): { startUs: number; endUs: number } {
  if (plan.sourceStamp !== source.stamp || plan.videoIndex !== support.video.index || plan.packetCount < 1
    || !Number.isSafeInteger(plan.packetCount) || !/^[a-f0-9]{64}$/.test(plan.payloadDigest) || !/^[a-f0-9]{64}$/.test(plan.timingDigest))
    throw new Error('原画分析结果已失效，请重新分析。');
  const base = parseRational(support.video.timeBase)!;
  if (base.numerator !== plan.timeBase.numerator || base.denominator !== plan.timeBase.denominator
    || BigInt(plan.startPts) < BigInt(support.video.startPts) || BigInt(plan.endPts) > BigInt(support.video.endPts)
    || BigInt(plan.endPts) <= BigInt(plan.startPts)) throw new Error('Invalid copy boundary plan');
  const startUs = ptsToUs(plan.startPts, '0', base); const endUs = ptsToUs(plan.endPts, '0', base);
  // The tested absolute -to strategy needs a positive endpoint. Do not silently reinterpret negative timestamps.
  if (endUs <= 0) throw new Error('该负时间戳区间尚不在原画校验范围内，请使用精确模式。');
  if (support.audio) sampleClock(parseRational(support.audio.timeBase)!, support.audio.sampleRate);
  return { startUs, endUs };
}

function audioForRange(support: Supported, probe: CopyProbe, plan: CopyRangePlan): Supported {
  if (!support.audio) return support;
  const stream = probe.streams.find(value => value.index === support.audio!.index)!;
  if (!Number.isSafeInteger(stream.start_pts) || !Number.isSafeInteger(stream.duration_ts)) throw new Error('音轨缺少可播放范围。');
  const base = parseRational(support.audio.timeBase)!;
  const start = BigInt(stream.start_pts!); const end = start + BigInt(stream.duration_ts!);
  const audioFactor = BigInt(base.numerator) * BigInt(plan.timeBase.denominator);
  const videoFactor = BigInt(plan.timeBase.numerator) * BigInt(base.denominator);
  if (start * audioFactor < BigInt(plan.endPts) * videoFactor && end * audioFactor > BigInt(plan.startPts) * videoFactor) return support;
  return { ...support, audio: null, audioSignature: null,
    warnings: [...support.warnings, '实际选段与原音轨可播放范围不重叠，输出不添加空音轨。'] };
}

async function verifyAudio(source: SourceFile, sourceProbe: CopyProbe, support: Supported, plan: CopyRangePlan,
  output: Digests, expected: { payload: string; timing: string }, executable: string, signal: AbortSignal): Promise<CopyReport['audio']> {
  const audio = support.audio!; const first = output.first; const last = output.last;
  if (!first || !last) throw new Error('所选区间未输出可验证音轨；可明确取消保留音轨后仅输出视频。');
  const stream = sourceProbe.streams.find(value => value.index === audio.index)!;
  if (!Number.isSafeInteger(stream.start_pts) || !Number.isSafeInteger(stream.duration_ts) || stream.duration_ts! <= 0)
    throw new Error('音轨缺少可播放范围，不能可靠验证原画音频。');
  const originalStart = BigInt(stream.start_pts!); const originalEnd = originalStart + BigInt(stream.duration_ts!);
  const startUs = ptsToUs(plan.startPts, '0', plan.timeBase); const endUs = ptsToUs(plan.endPts, '0', plan.timeBase);
  const offset = rounded(BigInt(startUs) * BigInt(audio.sampleRate), 1000000n);
  // Packets are included while PTS < the CLI's microsecond endpoint, not its nearest audio sample.
  const clipEnd = ceiling(BigInt(endUs) * BigInt(audio.sampleRate), 1000000n);
  const expectedFirst = first.pts! + offset;
  const reference = new Digests(parseRational(audio.timeBase)!, offset);
  let found = false; let audibleStart: bigint | null = null;
  await scanPackets({ executable, input: source.path, hashes: true, signal, onPacket: packet => {
    if (packet.streamIndex !== audio.index) return;
    if (packet.pts === null || packet.dts === null || packet.duration === null || packet.duration <= 0n || packet.corrupt)
      throw new Error('原音频包缺少可靠时间，不能验证。');
    const begin = maximum(packet.pts + BigInt(packet.skipSamples), originalStart);
    const end = minimum(packet.pts + packet.duration - BigInt(packet.discardPadding), originalEnd);
    const intersects = end > maximum(begin, offset) && begin < clipEnd;
    if (intersects && audibleStart === null) audibleStart = maximum(begin, offset);
    if (!found) {
      if (packet.pts < expectedFirst) return;
      if (packet.pts !== expectedFirst) throw new Error('输出音轨无法对应源压缩包。');
      found = true;
    }
    if (reference.count < output.count) {
      if (packet.pts >= clipEnd) throw new Error('输出保留了实际结束点之后多余的音频包。');
      reference.add(packet); return;
    }
    if (intersects) throw new Error('原画音频遗漏了结束区间内应保留的压缩包。');
    if (packet.pts >= clipEnd || begin >= originalEnd) return true;
  } });
  const digest = reference.finish();
  if (!found || reference.count !== output.count || digest.payload !== expected.payload || digest.timing !== expected.timing)
    throw new Error('原画音频包或时间戳与源序列不一致。');
  const playableStart = first.pts! + BigInt(first.skipSamples);
  const playableEnd = last.pts! + last.duration! - BigInt(last.discardPadding);
  const expectedEnd = minimum(reference.last!.pts! + reference.last!.duration! - BigInt(reference.last!.discardPadding), originalEnd) - offset;
  if (audibleStart === null || playableStart !== audibleStart - offset || playableEnd !== expectedEnd || playableEnd <= playableStart)
    throw new Error('原画音频的跳过样本或可播放边界发生非预期变化。');
  const videoDurationUs = ptsToUs(plan.endPts, plan.startPts, plan.timeBase);
  return { packets: output.count, packetStartUs: samplesToUs(first.pts!, audio.sampleRate),
    packetEndUs: samplesToUs(last.pts! + last.duration!, audio.sampleRate),
    playableStartUs: samplesToUs(playableStart, audio.sampleRate), playableEndUs: samplesToUs(playableEnd, audio.sampleRate),
    skippedSamples: first.skipSamples, discardedSamples: last.discardPadding,
    tailBeyondVideoUs: Math.max(0, samplesToUs(playableEnd, audio.sampleRate) - videoDurationUs), payloadDigest: digest.payload };
}

export async function verifyCopyOutput(options: {
  source: SourceFile; sourceProbe: CopyProbe; support: Supported; plan: CopyRangePlan; output: SourceFile;
  engines: EnginePaths; signal: AbortSignal; onStage?: (stage: CopyStage) => void | Promise<void>;
}): Promise<CopyReport> {
  const { source, sourceProbe, plan, output, engines, signal } = options;
  checkedPlan(source, options.support, plan);
  const support = audioForRange(options.support, sourceProbe, plan);
  await assertSource(source); signal.throwIfAborted();
  await options.onStage?.('verify-packets');
  const metadata = await probeCopySource(output, engines.ffprobe, signal);
  const out = assessCopySupport(metadata, Boolean(support.audio));
  if (!out.supported || out.videoSignature !== support.videoSignature || out.audioSignature !== support.audioSignature
    || metadata.streams.length !== (support.audio ? 2 : 1)) throw new Error('原画输出的轨道或解码/色彩/方向配置发生变化。');
  const base = parseRational(out.video.timeBase)!;
  if (out.video.startPts !== '0' || BigInt(out.video.endPts) * BigInt(base.numerator) * BigInt(plan.timeBase.denominator)
    !== (BigInt(plan.endPts) - BigInt(plan.startPts)) * BigInt(plan.timeBase.numerator) * BigInt(base.denominator))
    throw new Error('原画输出的视频时间轴或实际时长不符合已确认边界。');
  const video = new Digests(base, 0n);
  const audio = out.audio ? new Digests(parseRational(out.audio.timeBase)!, 0n) : null;
  if (out.audio) sampleClock(parseRational(out.audio.timeBase)!, out.audio.sampleRate);
  let audioFrameSamples = 1024n;
  await scanPackets({ executable: engines.ffprobe, input: output.path, hashes: true, signal, onPacket: packet => {
    if (packet.streamIndex === out.video.index) video.add(packet);
    else if (audio && packet.streamIndex === out.audio!.index) {
      if (audio.count === 0 && packet.duration === 960n) audioFrameSamples = 960n;
      // Timestamp gaps are not decoded silent samples. A large skip_samples could otherwise
      // consume valid AAC frames after a gap while payload/timestamp digests still match.
      if (packet.duration === null || packet.duration > audioFrameSamples || packet.pts !== packet.dts
        || audio.last && (audio.last.duration !== audioFrameSamples || packet.pts !== audio.last.pts! + audio.last.duration!))
        throw new Error('间断或重叠的 AAC 包时序尚不在原画校验范围内，请使用精确模式；不会静默填充或重编码。');
      if (audio.count && (packet.skipSamples !== 0 || audio.last!.discardPadding !== 0))
        throw new Error('音轨含未支持的中途跳过/填充，不能声明原画边界正确。');
      audio.add(packet);
    } else throw new Error('Unexpected output stream');
  } });
  const digest = video.finish();
  if (video.count !== plan.packetCount || digest.payload !== plan.payloadDigest || digest.timing !== plan.timingDigest)
    throw new Error('原画视频的压缩包或归一化帧时序与源选段不一致。');
  let audioReport: CopyReport['audio'] = null;
  if (audio) {
    await options.onStage?.('verify-source-audio');
    audioReport = await verifyAudio(source, sourceProbe, support, plan, audio, audio.finish(), engines.ffprobe, signal);
  }
  await assertSource(source); await assertSource(output);
  await options.onStage?.('decode');
  await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin',
    '-protocol_whitelist', 'file,pipe', '-err_detect', 'explode', '-i', output.path, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'],
  () => {}, { signal, timeoutMs: 0 });
  await assertSource(source); await assertSource(output); signal.throwIfAborted();
  return { videoPackets: video.count, videoDurationUs: ptsToUs(plan.endPts, plan.startPts, plan.timeBase),
    payloadDigest: digest.payload, timingDigest: digest.timing, audio: audioReport, warnings: [...support.warnings] };
}

// Output must be an application-owned private draft path. M4 publishes only after subsequent JPEG/XMP validation.
// Exclusive reservation precedes -y; reservation failure never triggers deletion of an existing file.
export async function exportCopyMedia(options: {
  source: SourceFile; plan: CopyRangePlan; output: string; keepAudio: boolean; engines: EnginePaths; signal: AbortSignal;
  onStage?: (stage: CopyStage) => void | Promise<void>;
}): Promise<{ file: SourceFile; report: CopyReport }> {
  const { source, plan, engines, signal } = options;
  const output = resolve(options.output); const input = resolve(source.path);
  if ((process.platform === 'win32' ? output.toLowerCase() === input.toLowerCase() : output === input)) throw new Error('Cannot overwrite source');
  signal.throwIfAborted(); await assertSource(source);
  const sourceProbe = await probeCopySource(source, engines.ffprobe, signal);
  const assessed = assessCopySupport(sourceProbe, options.keepAudio);
  if (!assessed.supported) throw new Error(assessed.reasons.join('\n'));
  const bounds = checkedPlan(source, assessed, plan);
  const support = audioForRange(assessed, sourceProbe, plan);
  await writeFile(output, '', { flag: 'wx' }); let succeeded = false;
  try {
    await options.onStage?.('copy');
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file,pipe', '-copyts', '-seek_timestamp', '1', '-ss', usToSeconds(bounds.startUs), '-noaccurate_seek', '-i', input,
      '-map', `0:${support.video.index}`, ...(support.audio ? ['-map', `0:${support.audio.index}`] : ['-an']), '-c', 'copy',
      '-to', usToSeconds(bounds.endUs), '-bsf:v', `noise=amount=0:drop='gte(n,${plan.packetCount})'`,
      '-output_ts_offset', usToSeconds(-bounds.startUs), '-avoid_negative_ts', 'disabled',
      '-map_metadata', '-1', '-map_chapters', '-1', '-use_editlist', '1', '-movflags', '+faststart', '-f', 'mp4', output],
    () => {}, { signal, timeoutMs: 0 });
    const file = await openSource(output);
    const report = await verifyCopyOutput({ ...options, sourceProbe, support, output: file });
    signal.throwIfAborted(); succeeded = true;
    return { file, report };
  } catch (error) {
    if (!signal.aborted) await assertSource(source);
    throw error;
  } finally { if (!succeeded) await unlinkCreatedFile(output); }
}
