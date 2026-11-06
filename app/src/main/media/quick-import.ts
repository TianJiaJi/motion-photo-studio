// Quick on-demand import: playable with sound after a bounded startup verification only.
// No whole-file frame enumeration, no whole-track audio scan, no proxy transcode on this path.
// Identity of a displayed frame is resolved later, on demand, against source presentation PTS.
import { open, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialAudioTrack } from '../../shared/export.ts';
import type { MediaInfo } from '../../shared/media.ts';
import type { PreviewBoundary } from '../../shared/native-preview.ts';
import { ptsToUs, type Rational } from '../../shared/editor.ts';
import { AppFailure } from '../errors.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { assertSource, type SourceFile } from './source.ts';
import type { MediaProbe } from './probe.ts';
import { streamProcessLines } from './lines.ts';
import { NativePreview, nativeInteger, type NativeFrameInfo, type NativeSampleTime, type NativeVideoInfo } from './native-preview.ts';
import { decodePresentedWindow, parsePresentedFrame, type PresentedFrame } from './encode-plan.ts';
import { LocalFrameResolver, DISPLAY_TIME_BOUND_US } from './local-frame-resolver.ts';
import type { FrameCursor, FrameIdentity, FrameProvider, ProvidedFrame } from './frame-provider.ts';
import type { PreparedAudioTrack } from './native-audio-import.ts';
import type { ImportProgress, PreparedMedia } from './native-import.ts';

const WINDOW_FRAMES = 64;
const AUDIO_WINDOW_FRAMES = 48;
const MiB = 1024 * 1024;

export type PreparedQuickMedia = PreparedMedia & { quick: true };
const unsupported = (message: string) => new AppFailure('QUICK_UNSUPPORTED', message);

export type QuickWindow = { firstNativeHns: bigint; firstPts: bigint; firstTimeUs: number; frames: number };

// Bounded correspondence check between the first presented source PTS values and the first
// native sample timestamps. Same exact rational interval rule as the strict mapNative pass,
// applied to the startup window only; the linear anchor is established here, re-verified by
// the on-demand resolver at every exact-identity operation.
export async function verifyQuickWindow(options: {
  source: SourceFile; info: MediaInfo; native: NativePreview; ffmpeg: string; signal: AbortSignal;
}): Promise<QuickWindow> {
  const { source, info, native, signal } = options;
  const sourceFrames = await decodePresentedWindow({ source, info, executable: options.ffmpeg, signal, count: WINDOW_FRAMES });
  if (sourceFrames.length < 2) throw unsupported('源视频的可核对帧不足，需精确整片准备。');
  await native.request({ command: 'resetScan' }, { signal });
  const { value } = await native.request<{ frames: NativeSampleTime[]; ended: boolean }>({ command: 'scanFrames', count: WINDOW_FRAMES }, { signal });
  if (!value || !Array.isArray(value.frames) || value.frames.length > WINDOW_FRAMES || typeof value.ended !== 'boolean')
    throw unsupported('原生帧窗口响应不合法，需精确整片准备。');
  if (value.frames.length !== sourceFrames.length) throw unsupported('原生可见帧数与原片首批帧数不一致，需精确整片准备。');
  const firstPts = sourceFrames[0]!.pts;
  const firstNativeHns = nativeInteger(value.frames[0]!.timestampHns);
  if (firstNativeHns < 0n) throw unsupported('原生首帧时间为负，需要兼容准备。');
  const num = BigInt(info.timeBase.numerator); const den = BigInt(info.timeBase.denominator);
  let previousPts = firstPts; let previousStamp = firstNativeHns;
  for (let index = 1; index < sourceFrames.length; index++) {
    const pts = sourceFrames[index]!.pts;
    const stamp = nativeInteger(value.frames[index]!.timestampHns);
    if (pts <= previousPts || stamp <= previousStamp) throw unsupported('原生/原片帧时序不是严格递增，需精确整片准备。');
    const delta = (pts - firstPts) * num * 10_000_000n - (stamp - firstNativeHns) * den;
    if (delta < -2n * den || delta > 2n * den) throw unsupported('原生时序与原片帧间隔不一致，需精确整片准备。');
    previousPts = pts; previousStamp = stamp;
  }
  return { firstNativeHns, firstPts, firstTimeUs: ptsToUs(firstPts.toString(), info.startPts, info.timeBase), frames: sourceFrames.length };
}

type AudioWindow = { frames: PresentedFrame[]; timeBase: Rational; sampleRate: number };
async function decodeAudioWindow(options: {
  source: SourceFile; streamIndex: number; executable: string; signal: AbortSignal;
}): Promise<AudioWindow> {
  const { source, signal } = options;
  await assertSource(source); signal.throwIfAborted();
  const frames: PresentedFrame[] = []; let timeBase: Rational | null = null; let sampleRate = 0;
  await streamProcessLines(options.executable, ['-hide_banner', '-v', 'error', '-nostdin', '-copyts', '-protocol_whitelist', 'file,pipe',
    '-i', source.path, '-map', `0:${options.streamIndex}`, '-vn', '-frames:a', String(AUDIO_WINDOW_FRAMES),
    '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-f', 'framehash', '-hash', 'sha256', '-'], line => {
    signal.throwIfAborted();
    const clock = /^#tb 0:\s*(\d+\/\d+)$/.exec(line);
    if (clock) {
      const parts = clock[1]!.split('/').map(Number);
      const numerator = parts[0] ?? 0; const denominator = parts[1] ?? 0;
      if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) throw new Error('Invalid audio clock');
      timeBase = { numerator, denominator };
    }
    const rate = /^#sample_rate 0:\s*(\d+)$/.exec(line);
    if (rate) sampleRate = Number(rate[1]);
    const frame = parsePresentedFrame(line, 0); if (!frame) return;
    if (frames.length && frame.pts <= frames.at(-1)!.pts) throw new Error('音频样本时间不递增');
    frames.push(frame);
  }, { signal, timeoutMs: 15000 });
  if (!timeBase || !sampleRate || !frames.length) throw unsupported('音轨无法有界解码核对，需精确整片准备。');
  return { frames, timeBase: timeBase!, sampleRate };
}

function audioWindowHns(window: AudioWindow): { firstHns: bigint; continuous: boolean } {
  const { numerator, denominator } = window.timeBase;
  const scale = BigInt(numerator) * 10_000_000n;
  let expected: bigint | null = null; let continuous = true;
  for (const frame of window.frames) {
    const at = frame.pts * scale / BigInt(denominator);
    if (expected !== null) {
      const tolerance = 10_000_000n / BigInt(window.sampleRate) + 2n;
      if (at - expected > tolerance || at - expected < -tolerance) continuous = false;
    }
    const duration = frame.duration === null ? 0n : frame.duration * scale / BigInt(denominator);
    expected = at + duration;
  }
  return { firstHns: window.frames[0]!.pts * scale / BigInt(denominator), continuous };
}

type NativeAudioWindow = { streamIndex: number; firstHns: bigint; sampleRate: number; continuous: boolean };
async function nativeAudioWindow(native: NativePreview, path: string, streamIndex: number, signal: AbortSignal): Promise<NativeAudioWindow> {
  const { value: opened } = await native.request<{ sampleRate: number }>({ command: 'audioScanOpen', path, streamIndex }, { signal });
  if (!opened || !Number.isSafeInteger(opened.sampleRate) || opened.sampleRate < 8000 || opened.sampleRate > 192000)
    throw unsupported('原生音轨采样率不合法，需精确整片准备。');
  try {
    const { value } = await native.request<{ frames: { timestampHns: string; samples: number }[]; ended: boolean }>({ command: 'audioScan', count: AUDIO_WINDOW_FRAMES }, { signal });
    if (!value || !Array.isArray(value.frames) || !value.frames.length || value.frames.length > AUDIO_WINDOW_FRAMES)
      throw unsupported('原生音轨窗口没有可核对样本，需精确整片准备。');
    const firstHns = nativeInteger(value.frames[0]!.timestampHns);
    let expected = firstHns; let continuous = true;
    for (const frame of value.frames) {
      const at = nativeInteger(frame.timestampHns);
      if (at - expected > 10_000_000n / BigInt(opened.sampleRate) + 2n || at - expected < -(10_000_000n / BigInt(opened.sampleRate) + 2n)) continuous = false;
      if (!Number.isSafeInteger(frame.samples) || frame.samples <= 0) throw unsupported('原生音轨样本数不合法，需精确整片准备。');
      expected = at + BigInt(frame.samples) * 10_000_000n / BigInt(opened.sampleRate);
    }
    return { streamIndex, firstHns, sampleRate: opened.sampleRate, continuous };
  } finally {
    if (native.alive) await native.request({ command: 'audioScanClose' }, { signal }).catch(() => undefined);
  }
}

// On-demand audio preflight: first actual decoded samples on BOTH sides (source FFmpeg decode
// and native decode), matched per track. No total sample counts: alignment is calibrated from
// the measured first samples, exactly like the strict path's offset formula, bounded to a window.
export async function preflightQuickAudio(options: {
  source: SourceFile; info: MediaInfo; probe: MediaProbe; native: NativePreview; ffmpeg: string; signal: AbortSignal; windowOriginHns: bigint; audioTrack?: number | null;
}): Promise<{ tracks: PreparedAudioTrack[]; warnings: string[] }> {
  const { source, info, probe, native, signal } = options;
  const warnings: string[] = [];
  const selected = options.audioTrack === undefined ? initialAudioTrack(info.audioTracks) : options.audioTrack;
  if (selected === null) return { tracks: [], warnings };
  const track = info.audioTracks.find(track => track.index === selected);
  if (!track) throw new AppFailure('INVALID_REQUEST', '所选音轨不存在。');
  const videoOriginHns = BigInt(info.startPts) * BigInt(info.timeBase.numerator) * 10_000_000n / BigInt(info.timeBase.denominator);
  const stream = probe.streams.find(stream => stream.index === track.index && stream.codec_type === 'audio');
  if (!stream) throw unsupported('音轨在预检期间消失，需精确整片准备。');
  const { value: enumeration } = await native.request<{ streams: { streamIndex: number; sampleRate: number; channels: number }[] }>(
    { command: 'audioStreams', path: source.path }, { signal });
  if (!enumeration || !Array.isArray(enumeration.streams)) throw unsupported('原生音轨枚举响应不合法，需精确整片准备。');
  // Metadata enumeration is cheap; decode ONLY the selected track. Do not infer identity
  // from stream order or nearest timestamps. Ambiguous equal-format tracks need isolation.
  const rate = Number(stream.sample_rate);
  const sourceMatches = probe.streams.filter(item => item.codec_type === 'audio' && Number(item.sample_rate) === rate && item.channels === track.channels);
  const candidates = enumeration.streams.filter(item => item.sampleRate === rate && item.channels === track.channels);
  if (sourceMatches.length !== 1 || candidates.length !== 1)
    throw unsupported('所选音轨的原生身份无法唯一核对，需逐轨隔离的精确准备。');
  const candidate = candidates[0]!;
  if (!Number.isSafeInteger(candidate.streamIndex) || candidate.streamIndex < 0 || candidate.streamIndex >= 64)
    throw unsupported('原生音轨编号不合法，需精确整片准备。');
  const window = await decodeAudioWindow({ source, streamIndex: track.index, executable: options.ffmpeg, signal });
  if (window.sampleRate !== rate) throw unsupported('音轨采样率与容器声明不一致，需精确整片准备。');
  const measured = audioWindowHns(window);
  const nativeWindow = await nativeAudioWindow(native, source.path, candidate.streamIndex, signal);
  const pairs = [{ source: { track, firstHns: measured.firstHns, rate, continuous: measured.continuous }, native: nativeWindow }];
  const tracks: PreparedAudioTrack[] = [];
  for (const { source: entry, native: nativeStream } of pairs) {
    const firstRelative = entry.firstHns - videoOriginHns;
    const silent = firstRelative >= BigInt(info.durationUs) * 10n;
    const offsetHns = nativeStream.firstHns - firstRelative;
    // Conservatively limit independent audio/video reader-origin differences. A large
    // difference can be a legitimate edit-list delay, not necessarily drift; the bounded
    // timestamp-only preflight cannot prove sample correspondence in that case. Use the
    // existing isolated PCM path rather than accepting an unverified offset.
    const windowOrigin = options.windowOriginHns;
    const delta = offsetHns - windowOrigin;
    const absolute = delta < 0n ? -delta : delta;
    if (absolute > 1_000_000n) throw unsupported(`音轨与画面的原生时间原点相差 ${(Number(absolute) / 10_000).toFixed(1)}ms，超出快速校准范围，需精确整片准备。`);
    if (absolute > 20_000n) warnings.push(`音轨 ${entry.track.index} 的解码时间原点与画面相差 ${(Number(absolute) / 10_000).toFixed(1)}ms，已按实测首样本对齐。`);
    if (!entry.continuous || !nativeStream.continuous) throw unsupported('音轨样本时间在预检窗口内不连续，需精确整片准备。');
    tracks.push({
      sourceIndex: entry.track.index, kind: silent ? 'silent' : 'source', path: silent ? null : source.path,
      streamIndex: silent ? 0 : nativeStream.streamIndex, offsetHns: silent ? '0' : offsetHns.toString(),
      sampleRate: entry.rate, samples: '0', firstRelativeHns: firstRelative.toString(),
    });
    if (silent) warnings.push(`音轨 ${entry.track.index} 在视频范围内没有音频样本。`);
  }
  return { tracks, warnings };
}

// Time-based frame provider for quick mode. Display time derives from native stamps anchored at
// the verified startup window; exact source identity is resolved on demand via the resolver.
export class QuickFrameProvider implements FrameProvider {
  readonly mode = 'quick' as const;
  readonly frameCount = null;
  private readonly options: { info: MediaInfo; firstPts: bigint; firstNativeHns: bigint; firstTimeUs: number; resolver: LocalFrameResolver };
  constructor(options: { info: MediaInfo; firstPts: bigint; firstNativeHns: bigint; firstTimeUs: number; resolver: LocalFrameResolver }) { this.options = options; }
  get info(): MediaInfo { return this.options.info; }
  private targetHns(timeUs: number): bigint {
    const { info, firstPts, firstNativeHns } = this.options;
    const num = BigInt(info.timeBase.numerator), den = BigInt(info.timeBase.denominator);
    // Boundaries live on the source clock's integer tick grid, not the rounded MF clock.
    // ceil(requested source ticks) is the same exclusive boundary for 'before' and
    // inclusive boundary for 'after'. Take the LOWER native bound for that tick;
    // a 1hns MF rounding error must not skip an exactly-on-boundary 60fps sample.
    const tick = BigInt(info.startPts) + (BigInt(timeUs) * den + num * 1_000_000n - 1n) / (num * 1_000_000n);
    const scaled = (tick - firstPts) * num * 10_000_000n;
    const ceil = scaled >= 0n ? (scaled + den - 1n) / den : scaled / den;
    const target = firstNativeHns + ceil - 2n;
    return target > 0n ? target : 0n;
  }
  private displayTime(stampHns: bigint): number {
    const { info, firstPts, firstNativeHns } = this.options;
    const den = BigInt(info.timeBase.denominator), scale = BigInt(info.timeBase.numerator) * 10_000_000n;
    const scaled = (stampHns - firstNativeHns) * den;
    const tick = scaled >= 0n ? (scaled + scale / 2n) / scale : -((-scaled + scale / 2n) / scale);
    const error = tick * scale - scaled;
    if (scale <= 4n * den || error < -2n * den || error > 2n * den)
      throw new AppFailure('FRAME_INDEX', '原生时间戳无法唯一对应源时基，请使用精确兼容准备。');
    // Clock normalization only: this does NOT prove that a source frame exists at
    // the inferred tick. Identity stays null until independent source decoding.
    const value = ptsToUs((firstPts + tick).toString(), info.startPts, info.timeBase);
    return Math.max(0, Math.min(info.durationUs, value));
  }
  private async locate(native: NativePreview, target: bigint, boundary: PreviewBoundary, playback: boolean): Promise<{ value: NativeFrameInfo; pixels: Buffer }> {
    // A demuxer may start after the requested target; retry with earlier origins and only then
    // report a true boundary. The legacy keyframe walk is unnecessary: MF snaps to sync points.
    // MF seek origins are presentation-relative, unlike the returned sample timestamps
    // (which may include an edit-list/B-frame offset). Never use raw stamps as seek origins.
    const relative = target - this.options.firstNativeHns;
    const origins = [relative, relative - 10_000_000n, relative - 50_000_000n, relative - 300_000_000n, 0n];
    let last: unknown;
    for (const [attempt, origin] of origins.entries()) {
      const seekHns = (origin > 0n ? origin : 0n).toString();
      try {
        return await native.request<NativeFrameInfo>({ command: 'locate', timeHns: target.toString(), seekHns, playback, boundary }, undefined);
      } catch (error) {
        last = error;
        const reason = error instanceof AppFailure && error.cause instanceof Error ? error.cause.message : '';
        if (!/video frame/.test(reason)) throw error;
        if (attempt === origins.length - 1) throw new AppFailure('FRAME_BOUNDARY', boundary === 'before' ? '已到第一帧。' : '已到最后一帧。', { cause: error });
      }
    }
    throw last instanceof Error ? last : new Error('locate failed');
  }
  async frameAt(native: NativePreview, timeUs: number, boundary: PreviewBoundary, playback = false): Promise<ProvidedFrame> {
    const result = await this.locate(native, this.targetHns(timeUs), boundary, playback);
    return this.provided(result);
  }
  private provided(result: { value: NativeFrameInfo; pixels: Buffer }): ProvidedFrame {
    if (!result.pixels.length) throw new AppFailure('FRAME_INDEX', '原生预览没有返回画面数据。');
    const stamp = nativeInteger(result.value.timestampHns);
    return {
      key: `native:${stamp}`, nativeHns: stamp.toString(), timeUs: this.displayTime(stamp),
      durationUs: Number(nativeInteger(result.value.durationHns) / 10n), identity: null,
      width: result.value.width, height: result.value.height, pixels: result.pixels,
    };
  }
  private verifyStamp(nativeHns: string | undefined, pts: string): void {
    if (nativeHns === undefined) throw new AppFailure('FRAME_INDEX', '缺少已显示帧的原生时间戳，不能确认源帧。');
    const { info, firstPts, firstNativeHns } = this.options;
    const den = BigInt(info.timeBase.denominator);
    const delta = (BigInt(pts) - firstPts) * BigInt(info.timeBase.numerator) * 10_000_000n
      - (nativeInteger(nativeHns) - firstNativeHns) * den;
    if (delta < -2n * den || delta > 2n * den)
      throw new AppFailure('FRAME_INDEX', '当前原生帧与源整数 PTS 无法唯一对应，请改用兼容准备。');
  }
  async step(native: NativePreview, current: FrameCursor, direction: -1 | 1, signal?: AbortSignal): Promise<ProvidedFrame> {
    const resolved = await this.options.resolver.resolveAt(current.timeUs, signal);
    this.verifyStamp(current.nativeHns, resolved.identity.pts);
    if (Math.abs(resolved.timeUs - current.timeUs) > DISPLAY_TIME_BOUND_US)
      throw new AppFailure('FRAME_INDEX', '显示帧与源帧时间不一致，不能逐帧移动。');
    const { previous, next } = await this.options.resolver.neighborsOf(resolved, signal);
    const target = direction < 0 ? previous : next;
    if (!target) throw new AppFailure('FRAME_BOUNDARY', direction < 0 ? '已到第一帧。' : '已到最后一帧。');
    signal?.throwIfAborted();
    const frame = await this.frameAt(native, target.timeUs, 'after');
    signal?.throwIfAborted();
    this.verifyStamp(frame.nativeHns, target.identity.pts);
    if (Math.abs(frame.timeUs - target.timeUs) > DISPLAY_TIME_BOUND_US)
      throw new AppFailure('FRAME_INDEX', '逐帧移动后的源帧身份无法核对。');
    return { ...frame, timeUs: target.timeUs, durationUs: target.durationUs, identity: target.identity, key: target.identity.pts };
  }
  async thumbnail(native: NativePreview, timeUs: number): Promise<ProvidedFrame> {
    const target = this.targetHns(Math.min(this.info.durationUs, timeUs + 1));
    const origin = target - this.options.firstNativeHns - 2_000_000n;
    const seek = origin > 0n ? origin.toString() : '0';
    const result = await native.request<NativeFrameInfo>({ command: 'thumbnail', timeHns: target.toString(), seekHns: seek });
    return this.provided(result);
  }
  async resolveIdentity(_native: NativePreview, frame: FrameCursor, signal?: AbortSignal): Promise<FrameIdentity> {
    const resolved = await this.options.resolver.resolveAt(frame.timeUs, signal);
    this.verifyStamp(frame.nativeHns, resolved.identity.pts);
    if (frame.identity && frame.identity.pts !== resolved.identity.pts)
      throw new AppFailure('FRAME_INDEX', '已显示帧的源身份与局部核对结果不一致。');
    return resolved.identity;
  }
  async close(): Promise<void> { this.options.resolver.close(); }
}

export async function prepareQuickMedia(options: {
  source: SourceFile; info: MediaInfo; probe: MediaProbe; directory: string; helper: string; ffmpeg: string;
  signal: AbortSignal; maximumEdge?: number; reserveBytes?: number; audioTrack?: number | null;
  onProgress?: (value: ImportProgress) => void;
}): Promise<PreparedQuickMedia> {
  const { source, info, probe, signal, directory } = options;
  const reserve = options.reserveBytes ?? 256 * MiB;
  const edge = options.maximumEdge ?? 960;
  if (!Number.isSafeInteger(edge) || edge < 64 || edge > 1280) throw new Error('Invalid preview edge');
  await assertSource(source); signal.throwIfAborted();
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(reserve)) throw new AppFailure('PREVIEW_DISK_FULL', '磁盘可用空间不足，已停止准备编辑资源。');
  // Quick mode covers only materials the native reader opens directly; anything needing a
  // compatibility proxy keeps the explicit strict preparation with progress and cancellation.
  if (BigInt(info.timeBase.numerator) * 10_000_000n <= 4n * BigInt(info.timeBase.denominator))
    throw unsupported('源时基小于原生校准的不确定区间，需要精确兼容准备。');
  if (info.hdr) throw unsupported('HDR 素材需要统一 SDR 兼容准备。');
  if (info.rotation) throw unsupported('旋转素材需要兼容准备。');
  if (info.sampleAspectRatio.numerator !== info.sampleAspectRatio.denominator) throw unsupported('非方形像素素材需要兼容准备。');
  const videoStreams = probe.streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (videoStreams.length !== 1) throw unsupported('多个视频流需要明确隔离的兼容准备。');
  const video = videoStreams[0]!;
  const matrix = video.color_space;
  if (matrix && !['bt709', 'bt470bg', 'smpte170m', 'unknown', 'unspecified'].includes(matrix)) throw unsupported('色彩矩阵需要兼容准备。');
  const directColor = { matrix709: matrix === 'bt709', fullRange: video.color_range === 'pc' || Boolean(video.pix_fmt?.startsWith('yuvj')) };
  const warnings: string[] = [];
  if (!matrix || ['unknown', 'unspecified'].includes(matrix)) warnings.push('原片未标记色彩矩阵；直接预览按 BT.601 处理，请人工核对。');

  const paths: string[] = [];
  let native: NativePreview | undefined; let success = false; let checkingAudio = false;
  try {
    options.onProgress?.({ stage: 'native-index', frames: 0 });
    native = new NativePreview(options.helper); await native.hello(signal);
    const nativeInfo = await native.open(source.path, edge, signal, directColor);
    if (nativeInfo.sourceWidth !== info.displayWidth || nativeInfo.sourceHeight !== info.displayHeight)
      throw unsupported('原生可见尺寸与原片显示尺寸不同，需兼容准备。');
    const window = await verifyQuickWindow({ source, info, native, ffmpeg: options.ffmpeg, signal });
    // A timestamp scan alone does not prove usable pixels. Materialize the first frame
    // before publishing readiness (including NV12 readback and color/geometry checks).
    const first = await native.request<NativeFrameInfo>({ command: 'locate', timeHns: window.firstNativeHns.toString(), seekHns: '0', boundary: 'after' }, { signal });
    if (!first.pixels.length || nativeInteger(first.value.timestampHns) !== window.firstNativeHns)
      throw unsupported('原生首帧画面与校准窗口不一致，需兼容准备。');
    options.onProgress?.({ stage: 'audio', frames: 0 });
    checkingAudio = true;
    const audio = await preflightQuickAudio({ source, info, probe, native, ffmpeg: options.ffmpeg, signal, audioTrack: options.audioTrack, windowOriginHns:
      window.firstNativeHns - (window.firstPts - BigInt(info.startPts)) * BigInt(info.timeBase.numerator) * 10_000_000n / BigInt(info.timeBase.denominator) });
    warnings.push(...audio.warnings);
    warnings.push('快速预览：按需定位，画面/声音直接读取原片；精确封面与逐帧会在操作时核对源帧身份。');
    signal.throwIfAborted(); await assertSource(source);
    const manifest = join(directory, `editing-manifest-${randomUUID()}.json`);
    const record = {
      version: 1, mode: 'quick', source: { path: source.path, size: source.size, stamp: source.stamp },
      window: { frames: window.frames, firstPts: window.firstPts.toString(), firstNativeHns: window.firstNativeHns.toString(), firstTimeUs: window.firstTimeUs },
      nativeInfo, audio: audio.tracks, warnings,
    };
    const handle = await open(manifest, 'wx'); paths.push(manifest);
    try { await handle.writeFile(JSON.stringify(record, null, 2)); } finally { await handle.close(); }
    const bytes = (await stat(manifest)).size;
    const resolver = new LocalFrameResolver({ source, info, executable: options.ffmpeg });
    const frames = new QuickFrameProvider({ info, firstPts: window.firstPts, firstNativeHns: window.firstNativeHns, firstTimeUs: window.firstTimeUs, resolver });
    success = true;
    return {
      quick: true, frames, resource: source.path, native: native!, nativeInfo, ownedPaths: paths,
      manifest, compatibility: false, warnings, bytes, audio: audio.tracks,
    };
  } catch (error) {
    signal.throwIfAborted(); await assertSource(source);
    if (error instanceof AppFailure && error.code === 'NATIVE_MEDIA')
      throw unsupported(checkingAudio ? '所选音轨的原生解码或格式转换不可用，需要精确兼容准备；不会以静音绕过。'
        : '原生视频解码器无法直接打开或核对当前素材，需要兼容准备。');
    throw error;
  } finally {
    if (!success) {
      try { await native?.shutdown(); } finally {
        for (const path of [...paths].reverse()) await unlinkCreatedFile(path);
      }
    }
  }
}
