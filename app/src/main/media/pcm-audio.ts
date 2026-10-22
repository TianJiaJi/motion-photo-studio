import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { parseRational, type Rational } from '../../shared/editor.ts';
import { readExactly, safeInteger } from '../motion/io.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import { probeCopySource, type CopyProbe, type CopyStream } from './copy-support.ts';
import { scanPackets } from './packets.ts';
import { streamProcessLines } from './lines.ts';
import type { EnginePaths } from './engine.ts';

export type PcmSpan = { sampleRate: number; channels: number; samples: number; packets: number; firstPts: string; endPts: string; digest: string };
function pcmStream(probe: CopyProbe, index: number): CopyStream {
  const a = probe.streams.find(stream => stream.index === index && stream.codec_type === 'audio');
  const rate = Number(a?.sample_rate); const base = parseRational(a?.time_base);
  if (!a || a.codec_name !== 'pcm_s16le' || !Number.isSafeInteger(a.channels) || a.channels! < 1
    || !Number.isSafeInteger(rate) || rate < 1 || !base || BigInt(base.numerator) * BigInt(rate) !== BigInt(base.denominator)
    || !Number.isSafeInteger(a.start_pts) || !Number.isSafeInteger(a.duration_ts) || a.duration_ts! <= 0)
    throw new Error('原 PCM 音轨配置/采样时钟尚未通过验证，不会转 AAC、重采样或降混。');
  return a;
}
function ceil(n: bigint, d: bigint): bigint { return n < 0n ? n / d : (n + d - 1n) / d; }
export function pcmBounds(startPts: string, endPts: string, base: Rational, rate: number): { begin: bigint; end: bigint } {
  const scale = BigInt(base.numerator) * BigInt(rate); const den = BigInt(base.denominator);
  return { begin: ceil(BigInt(startPts) * scale, den), end: ceil(BigInt(endPts) * scale, den) };
}
// Hash only real interleaved S16LE samples, not packet boundaries (which may change without sound loss).
// Any timeline gap/overlap is rejected instead of manufacturing silence or stretching samples.
async function samples(source: SourceFile, probe: CopyProbe, index: number, bounds: { begin: bigint; end: bigint }, engines: EnginePaths, signal: AbortSignal): Promise<PcmSpan> {
  const a = pcmStream(probe, index); const align = a.channels! * 2; const hash = createHash('sha256'); const file = await open(source.path, 'r');
  const streamBegin = BigInt(a.start_pts!); const streamEnd = streamBegin + BigInt(a.duration_ts!);
  let first: bigint | undefined; let previousEnd: bigint | undefined; let total = 0; let count = 0;
  try {
    await scanPackets({ input: source.path, executable: engines.ffprobe, signal, onPacket: async p => {
      if (p.streamIndex !== index) return;
      if (p.pts === null || p.dts !== p.pts || p.duration === null || p.corrupt || p.position === null || p.size < 1 || p.size % align !== 0)
        throw new Error('PCM 样本时序/布局无效，不能声明声音保持原样。');
      if (p.pts >= bounds.end) return true;
      const n = BigInt(p.size / align);
      if (p.duration !== n) throw new Error('PCM 包时长与真实样本数量冲突，不能安全裁剪。');
      let begin = p.pts + BigInt(p.skipSamples); let end = p.pts + n - BigInt(p.discardPadding);
      if (begin < bounds.begin) begin = bounds.begin; if (begin < streamBegin) begin = streamBegin;
      if (end > bounds.end) end = bounds.end; if (end > streamEnd) end = streamEnd;
      if (end <= begin) return;
      if (previousEnd !== undefined && begin !== previousEnd) throw new Error('PCM 含间断或重叠，原样音轨保留暂不支持；不会自动填充/重采样。');
      first ??= begin; previousEnd = end; count++;
      const bytes = safeInteger(Number(end - begin) * align, 'selected PCM bytes'); total = safeInteger(total + Number(end - begin), 'PCM sample count');
      let position = safeInteger(p.position + Number(begin - p.pts) * align, 'PCM byte offset');
      if (position + bytes > source.size) throw new Error('PCM sample escapes source file');
      for (let left = bytes; left > 0;) { signal.throwIfAborted(); const length = Math.min(left, 65536); hash.update(await readExactly(file, position, length)); left -= length; position += length; }
    } });
    await assertSource(source); signal.throwIfAborted();
    if (first === undefined || previousEnd === undefined || total < 1) throw new Error('实际视频区间没有可保留的 PCM 样本。');
    return { sampleRate: Number(a.sample_rate), channels: a.channels!, samples: total, packets: count, firstPts: String(first), endPts: String(previousEnd), digest: hash.digest('hex') };
  } finally { await file.close(); }
}
export async function verifyPcmStage(stage: SourceFile, expected: PcmSpan, engines: EnginePaths, signal: AbortSignal): Promise<PcmSpan> {
  const probe = await probeCopySource(stage, engines.ffprobe, signal); const tracks = probe.streams.filter(stream => stream.codec_type === 'audio');
  if (tracks.length !== 1) throw new Error('Expected one PCM track'); const a = pcmStream(probe, tracks[0]!.index);
  const actual = await samples(stage, probe, a.index, { begin: BigInt(a.start_pts!), end: BigInt(a.start_pts!) + BigInt(a.duration_ts!) }, engines, signal);
  if (actual.sampleRate !== expected.sampleRate || actual.channels !== expected.channels || actual.samples !== expected.samples
    || actual.firstPts !== expected.firstPts || actual.endPts !== expected.endPts || actual.digest !== expected.digest)
    throw new Error('PCM 声音样本、采样率、声道或时序发生变化；不能声明保真。');
  return actual;
}
export async function preservePcmAudio(options: { source: SourceFile; index: number; startPts: string; endPts: string; timeBase: Rational;
  output: string; engines: EnginePaths; signal: AbortSignal }): Promise<{ file: SourceFile; proof: PcmSpan }> {
  const { source, engines, signal } = options; await assertSource(source); signal.throwIfAborted();
  const probe = await probeCopySource(source, engines.ffprobe, signal); const a = pcmStream(probe, options.index);
  const bounds = pcmBounds(options.startPts, options.endPts, options.timeBase, Number(a.sample_rate));
  const reference = await samples(source, probe, a.index, bounds, engines, signal);
  const proof = { ...reference, firstPts: String(BigInt(reference.firstPts) - bounds.begin), endPts: String(BigInt(reference.endPts) - bounds.begin) };
  if ([bounds.begin, bounds.end].some(n => n < -9007199254740991n || n > 9007199254740991n)) throw new Error('PCM sample range exceeds exact native filter precision');
  await writeFile(options.output, '', { flag: 'wx' }); let succeeded = false;
  try {
    // PCM->same PCM is uncompressed sample transport, not perceptual audio encoding. No -ar/-ac,
    // volume, resampling, gap filling or format reduction. Actual samples are independently verified.
    const af = `asettb=1/${a.sample_rate},atrim=start_pts=${bounds.begin}:end_pts=${bounds.end},asetpts=PTS-(${bounds.begin})`;
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-xerror', '-copyts',
      '-protocol_whitelist', 'file,pipe', '-err_detect', 'explode', '-i', source.path, '-map', `0:${a.index}`, '-vn', '-af', af,
      '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'disabled', '-use_editlist', '1', '-f', 'mp4', options.output],
    () => {}, { signal, timeoutMs: 0 });
    const file = await openSource(options.output); await verifyPcmStage(file, proof, engines, signal);
    await assertSource(source); await assertSource(file); signal.throwIfAborted(); succeeded = true; return { file, proof };
  } catch (error) { if (!signal.aborted) await assertSource(source); throw error; }
  finally { if (!succeeded) await unlinkCreatedFile(options.output); }
}
