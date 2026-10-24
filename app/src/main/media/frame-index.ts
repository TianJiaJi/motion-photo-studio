import { open, type FileHandle } from 'node:fs/promises';
import { ptsToUs } from '../../shared/editor.ts';
import type { MediaInfo } from '../../shared/media.ts';
import { AppFailure } from '../errors.ts';
import { streamProcessLines } from './lines.ts';
import { assertSource, type SourceFile } from './source.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { NativePreview, nativeInteger, type NativeSampleTime, type NativeFrameInfo } from './native-preview.ts';

export const INDEX_RECORD_BYTES = 48;
const PAGE_ROWS = 128;
const PAGE_LIMIT = 8;
export type IndexedFrame = { index: number; pts: string; timeUs: number; nativeHns: string; durationPts: string; nativeDurationHns: string; keyFrame: boolean };
function invalid(message: string): never { throw new AppFailure('FRAME_INDEX', message); }
function safePts(text: string): bigint {
  if (!/^-?\d{1,19}$/.test(text)) invalid('源帧缺少有效整数 PTS，不能建立精确索引。');
  const value = BigInt(text);
  if (value < -(1n << 63n) || value >= (1n << 63n)) invalid('源帧 PTS 超出范围。');
  return value;
}
async function writeAll(file: FileHandle, data: Buffer, position: number) {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Index write made no progress');
    offset += bytesWritten;
  }
}
async function readAll(file: FileHandle, size: number, position: number) {
  const buffer = Buffer.alloc(size); let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) invalid('帧索引已截断。');
    offset += bytesRead;
  }
  return buffer;
}

// Private fixed-size records; at most eight 6KiB pages resident. No whole-video JS frame array.
export class FrameIndex {
  private pages = new Map<number, Buffer>();
  private file?: FileHandle;
  private opening?: Promise<FileHandle>;
  private mapped = false;
  readonly path: string;
  readonly count: number;
  readonly info: MediaInfo;
  readonly containerCandidate: boolean;
  constructor(path: string, count: number, info: MediaInfo, containerCandidate = false) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 20_000_000) invalid('帧索引数量无效。');
    this.path = path; this.count = count; this.info = info; this.containerCandidate = containerCandidate;
  }
  get byteSize() { return this.count * INDEX_RECORD_BYTES; }
  get mappingReady() { return this.mapped; }
  private async handle() {
    if (this.file) return this.file;
    this.opening ??= (async () => {
      const file = await open(this.path, 'r');
      try { if ((await file.stat()).size !== this.byteSize) invalid('帧索引大小不匹配。'); }
      catch (error) { await file.close(); throw error; }
      this.file = file; return file;
    })();
    try { return await this.opening; } finally { this.opening = undefined; }
  }
  async get(index: number): Promise<IndexedFrame> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count) invalid('帧索引越界。');
    const page = Math.floor(index / PAGE_ROWS);
    let bytes = this.pages.get(page);
    if (!bytes) {
      bytes = await readAll(await this.handle(), Math.min(PAGE_ROWS, this.count - page * PAGE_ROWS) * INDEX_RECORD_BYTES, page * PAGE_ROWS * INDEX_RECORD_BYTES);
    }
    this.pages.delete(page); this.pages.set(page, bytes);
    while (this.pages.size > PAGE_LIMIT) this.pages.delete(this.pages.keys().next().value!);
    const at = index % PAGE_ROWS * INDEX_RECORD_BYTES;
    const flags = bytes.readUInt32LE(at + 40);
    if (flags > 1 || bytes.readUInt32LE(at + 44) !== 0 || bytes.readBigInt64LE(at + 24) <= 0n) invalid('帧索引记录已损坏。');
    const timeUs = Number(bytes.readBigInt64LE(at + 8));
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) invalid('索引时间无效。');
    return { index, pts: bytes.readBigInt64LE(at).toString(), timeUs, nativeHns: bytes.readBigInt64LE(at + 16).toString(),
      durationPts: bytes.readBigInt64LE(at + 24).toString(), nativeDurationHns: bytes.readBigInt64LE(at + 32).toString(), keyFrame: flags === 1 };
  }
  async at(timeUs: number, direction: 'after' | 'before' = 'after'): Promise<IndexedFrame> {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs > this.info.durationUs) invalid('定位时间超出素材范围。');
    let low = 0, high = this.count;
    while (low < high) { const mid = Math.floor((low + high) / 2); if ((await this.get(mid)).timeUs < timeUs) low = mid + 1; else high = mid; }
    if (direction === 'before' && low === 0 || direction === 'after' && low === this.count) throw new AppFailure('FRAME_BOUNDARY', '裁剪边界内没有对应的源帧。');
    return this.get(direction === 'before' ? low - 1 : low);
  }
  private async seekParameters(index: number) {
    const target = await this.get(index); let key = target;
    while (key.index > 0 && !key.keyFrame) key = await this.get(key.index - 1);
    const first = await this.get(0);
    // MF sample timestamps can extend beyond container duration (B-frame/edit-list offsets).
    // A verified preceding keyframe's relative time is a safe seek origin, not the target stamp.
    const seekHns = BigInt(key.nativeHns) - BigInt(first.nativeHns);
    if (seekHns < 0n) invalid('关键帧定位起点无效。');
    return { command: 'locate', timeHns: target.nativeHns, seekHns: seekHns.toString() };
  }
  async locate(native: NativePreview, index: number, signal?: AbortSignal, playback = false) {
    if (!this.mapped) invalid('原生时间映射尚未就绪。');
    return native.request<NativeFrameInfo>({ ...await this.seekParameters(index), playback }, { signal });
  }
  async thumbnail(native: NativePreview, index: number, signal?: AbortSignal) {
    if (!this.mapped) invalid('原生时间映射尚未就绪。');
    return native.request<NativeFrameInfo>({ ...await this.seekParameters(index), command: 'thumbnail' }, { signal });
  }
  async fromNative(timeHns: string): Promise<IndexedFrame> {
    if (!this.mapped) invalid('原生时间映射尚未就绪。');
    const target = nativeInteger(timeHns);
    let low = 0, high = this.count;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (BigInt((await this.get(mid)).nativeHns) < target) low = mid + 1; else high = mid; }
    for (const index of [low, low - 1]) if (index >= 0 && index < this.count) {
      const row = await this.get(index); const delta = BigInt(row.nativeHns) - target;
      if (delta >= -2n && delta <= 2n) return row;
    }
    return invalid('原生帧不在已核对的源帧映射中。');
  }
  async close() {
    if (this.opening) { try { await this.opening; } catch { /* Failed open already closed its handle. */ } }
    this.pages.clear(); const file = this.file; this.file = undefined; if (file) await file.close();
  }
  async mapNative(native: NativePreview, signal: AbortSignal, onProgress?: (frames: number) => void): Promise<void> {
    await this.close(); this.mapped = false;
    await native.request({ command: 'resetScan' }, { signal });
    const file = await open(this.path, 'r+');
    let offset = 0; let firstSource: bigint | undefined; let firstNative: bigint | undefined; let previous: bigint | undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value } = await native.request<{ frames: NativeSampleTime[]; ended: boolean }>({ command: 'scanFrames', count: PAGE_ROWS }, { signal });
        if (!value || !Array.isArray(value.frames) || value.frames.length > PAGE_ROWS || typeof value.ended !== 'boolean'
          || !value.frames.length && !value.ended || offset + value.frames.length > this.count) invalid('原生帧数量与源文件不一致，需要兼容导入。');
        const block = await readAll(file, value.frames.length * INDEX_RECORD_BYTES, offset * INDEX_RECORD_BYTES);
        for (const [index, sample] of value.frames.entries()) {
          const pts = block.readBigInt64LE(index * INDEX_RECORD_BYTES);
          const stamp = nativeInteger(sample.timestampHns); const duration = nativeInteger(sample.durationHns);
          if (stamp < 0n || duration <= 0n || previous !== undefined && stamp <= previous) invalid('原生帧时序不是严格递增，不能精确映射。');
          firstSource ??= pts; firstNative ??= stamp;
          const sourceTicks = (pts - firstSource) * BigInt(this.info.timeBase.numerator) * 10_000_000n;
          const nativeTicks = (stamp - firstNative) * BigInt(this.info.timeBase.denominator);
          const delta = sourceTicks - nativeTicks;
          // Compare exact rational intervals for EVERY sample, not average FPS or one guessed offset.
          if (delta < -2n * BigInt(this.info.timeBase.denominator) || delta > 2n * BigInt(this.info.timeBase.denominator)) invalid('原生时序与原片帧间隔不一致，需要兼容导入。');
          if (this.containerCandidate) {
            const durationDelta = block.readBigInt64LE(index * INDEX_RECORD_BYTES + 24) * BigInt(this.info.timeBase.numerator) * 10_000_000n
              - duration * BigInt(this.info.timeBase.denominator);
            if (durationDelta < -2n * BigInt(this.info.timeBase.denominator) || durationDelta > 2n * BigInt(this.info.timeBase.denominator)) invalid('容器样本时长与实际解码帧不一致，改用原始逐帧索引。');
          }
          block.writeBigInt64LE(stamp, index * INDEX_RECORD_BYTES + 16);
          block.writeBigInt64LE(duration, index * INDEX_RECORD_BYTES + 32); previous = stamp;
        }
        await writeAll(file, block, offset * INDEX_RECORD_BYTES);
        offset += value.frames.length; onProgress?.(offset);
        if (value.ended) break;
      }
      if (offset !== this.count) invalid('原生解码缺帧，不能建立源 PTS 映射。');
      await file.sync();
    } finally { await file.close(); this.pages.clear(); }
    // Verify seeking back into the recorded decoder timeline, including first/last samples.
    for (const index of [...new Set([0, Math.floor(this.count / 2), this.count - 1])]) {
      signal.throwIfAborted();
      const row = await this.get(index);
      const { value, pixels } = await native.request<NativeFrameInfo>(await this.seekParameters(index), { signal });
      if (nativeInteger(value.timestampHns) !== BigInt(row.nativeHns) || !pixels.length) invalid('原生定位回读未返回指定帧，不会标记映射就绪。');
    }
    this.mapped = true;
  }
}

export async function buildFrameIndex(options: {
  source: SourceFile; info: MediaInfo; executable: string; output: string; signal: AbortSignal;
  maxBytes?: number; onProgress?: (frames: number) => void | Promise<void>;
}): Promise<FrameIndex> {
  const { source, info, signal } = options;
  await assertSource(source); signal.throwIfAborted();
  const file = await open(options.output, 'wx+');
  let success = false; let count = 0; let written = 0; let used = 0;
  let previous: bigint | undefined; let previousUs = -1;
  const block = Buffer.alloc(PAGE_ROWS * INDEX_RECORD_BYTES);
  try {
    await streamProcessLines(options.executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', String(info.videoIndex), '-show_frames',
      '-show_entries', 'frame=pts,key_frame,duration,pkt_duration', '-of', 'compact=p=0:nk=0', source.path], async line => {
      signal.throwIfAborted();
      const fields = Object.fromEntries(line.split('|').map(field => { const at = field.indexOf('='); return [field.slice(0, at), field.slice(at + 1)]; }));
      if (!Object.hasOwn(fields, 'key_frame')) return;
      const pts = safePts(fields.pts ?? ''); const timeUs = ptsToUs(pts.toString(), info.startPts, info.timeBase);
      if (timeUs < 0 || timeUs >= info.durationUs || previous !== undefined && pts <= previous || timeUs <= previousUs) invalid('源帧时间范围/顺序无法建立唯一索引。');
      if (!['0', '1'].includes(fields.key_frame!)) invalid('源关键帧标记无效。');
      if ((count + 1) * INDEX_RECORD_BYTES > (options.maxBytes ?? 256 * 1024 * 1024) || count >= 20_000_000) invalid('帧索引超过磁盘预算。');
      block.writeBigInt64LE(pts, used); block.writeBigInt64LE(BigInt(timeUs), used + 8);
      const durationText = fields.duration ?? fields.pkt_duration;
      const duration = durationText && durationText !== 'N/A' ? safePts(durationText) : 0n;
      if (duration < 0n) invalid('源帧时长无效。');
      block.writeBigInt64LE(0n, used + 16); block.writeBigInt64LE(duration, used + 24); block.writeBigInt64LE(0n, used + 32);
      block.writeUInt32LE(Number(fields.key_frame), used + 40); block.writeUInt32LE(0, used + 44);
      used += INDEX_RECORD_BYTES; count++; previous = pts; previousUs = timeUs;
      if (used === block.length) { await writeAll(file, block, written); written += used; used = 0; await options.onProgress?.(count); }
    }, { signal, timeoutMs: 0 });
    if (!count) invalid('源文件没有可索引的视频帧。');
    if (used) await writeAll(file, block.subarray(0, used), written);
    // Missing duration is resolved from actual adjacent source PTS (last: declared stream end),
    // never an average frame rate. Keep explicit source durations where the container supplies them.
    const tickScale = BigInt(info.timeBase.numerator) * 1_000_000n;
    const streamTicks = (BigInt(info.durationUs) * BigInt(info.timeBase.denominator) + tickScale - 1n) / tickScale;
    const endPts = BigInt(info.startPts) + streamTicks;
    for (let first = 0; first < count; first += PAGE_ROWS) {
      signal.throwIfAborted();
      const rows = Math.min(PAGE_ROWS, count - first);
      const page = await readAll(file, Math.min(rows + 1, count - first) * INDEX_RECORD_BYTES, first * INDEX_RECORD_BYTES);
      for (let row = 0; row < rows; row++) if (page.readBigInt64LE(row * INDEX_RECORD_BYTES + 24) === 0n) {
        const next = first + row + 1 < count ? page.readBigInt64LE((row + 1) * INDEX_RECORD_BYTES) : endPts;
        const duration = next - page.readBigInt64LE(row * INDEX_RECORD_BYTES);
        if (duration <= 0n || duration >= 1n << 63n) invalid('无法确定源帧时长。');
        page.writeBigInt64LE(duration, row * INDEX_RECORD_BYTES + 24);
      }
      await writeAll(file, page.subarray(0, rows * INDEX_RECORD_BYTES), first * INDEX_RECORD_BYTES);
    }
    await file.sync(); await assertSource(source); signal.throwIfAborted();
    success = true;
    return new FrameIndex(options.output, count, info);
  } finally { try { await file.close(); } finally { if (!success) await unlinkCreatedFile(options.output); } }
}
