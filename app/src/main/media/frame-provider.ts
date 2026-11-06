import type { MediaInfo } from '../../shared/media.ts';
import type { PreviewBoundary } from '../../shared/native-preview.ts';
import { AppFailure } from '../errors.ts';
import { FrameIndex, type IndexedFrame } from './frame-index.ts';
import { NativePreview, type NativeFrameInfo } from './native-preview.ts';

// A frame identity is verified source truth or it is null. Never synthesize a PTS/ordinal.
export type FrameIdentity = { pts: string; sourceFrame: number | null };
export type FrameCursor = { timeUs: number; identity: FrameIdentity | null; nativeHns?: string };
export type ProvidedFrame = {
  nativeHns?: string;
  // Stable per-source key used for "displayed frame changed" comparisons (ordinal or native stamp).
  key: string;
  timeUs: number;
  durationUs: number;
  identity: FrameIdentity | null;
  width: number;
  height: number;
  pixels: Uint8Array;
};
export type FrameNeighborPair = { current: ProvidedFrame; previous: ProvidedFrame | null; next: ProvidedFrame | null };

export interface FrameProvider {
  readonly info: MediaInfo;
  // null when the whole-file frame count is unknown (quick on-demand mode).
  readonly frameCount: number | null;
  readonly mode: 'strict' | 'quick';
  frameAt(native: NativePreview, timeUs: number, boundary: PreviewBoundary, playback?: boolean): Promise<ProvidedFrame>;
  step(native: NativePreview, current: FrameCursor, direction: -1 | 1, signal?: AbortSignal): Promise<ProvidedFrame>;
  thumbnail(native: NativePreview, timeUs: number): Promise<ProvidedFrame>;
  resolveIdentity(native: NativePreview, frame: FrameCursor, signal?: AbortSignal): Promise<FrameIdentity>;
  close(): Promise<void>;
}

export function rowDurationUs(row: Pick<IndexedFrame, 'durationPts'>, info: MediaInfo): number {
  return Number(BigInt(row.durationPts) * BigInt(info.timeBase.numerator) * 1_000_000n / BigInt(info.timeBase.denominator));
}

function missingPixels(): never { throw new AppFailure('FRAME_INDEX', '原生预览没有返回画面数据。'); }

function provided(row: IndexedFrame, info: MediaInfo, result: { value: NativeFrameInfo; pixels: Buffer }): ProvidedFrame {
  if (!result.pixels.length) missingPixels();
  return {
    key: String(row.index), timeUs: row.timeUs, durationUs: rowDurationUs(row, info),
    identity: { pts: row.pts, sourceFrame: row.index },
    width: result.value.width, height: result.value.height, pixels: result.pixels,
  };
}

// Strict mode: a fully verified whole-file frame index. Every frame request proves the
// returned native timestamp maps back to the exact requested source frame.
export class StrictFrameProvider implements FrameProvider {
  readonly mode = 'strict' as const;
  private readonly index: FrameIndex;
  constructor(index: FrameIndex) { this.index = index; }
  get info(): MediaInfo { return this.index.info; }
  get frameCount(): number | null { return this.index.count; }
  async frameAt(native: NativePreview, timeUs: number, boundary: PreviewBoundary, playback = false): Promise<ProvidedFrame> {
    const row = await this.index.at(timeUs, boundary);
    return this.row(native, row, playback);
  }
  private async row(native: NativePreview, row: IndexedFrame, playback = false): Promise<ProvidedFrame> {
    const result = await this.index.locate(native, row.index, undefined, playback);
    const actual = await this.index.fromNative(result.value.timestampHns);
    if (actual.index !== row.index) throw new AppFailure('FRAME_INDEX', '原生预览返回了错误的源帧。');
    return provided(row, this.index.info, result);
  }
  async step(native: NativePreview, current: { identity: FrameIdentity | null }, direction: -1 | 1): Promise<ProvidedFrame> {
    const sourceFrame = current.identity?.sourceFrame;
    if (sourceFrame === null || sourceFrame === undefined) throw new AppFailure('FRAME_INDEX', '当前帧的源帧序号尚未核对。');
    const number = sourceFrame + direction;
    if (number < 0) throw new AppFailure('FRAME_BOUNDARY', '已到第一帧。');
    if (number >= this.index.count) throw new AppFailure('FRAME_BOUNDARY', '已到最后一帧。');
    return this.row(native, await this.index.get(number));
  }
  async thumbnail(native: NativePreview, timeUs: number): Promise<ProvidedFrame> {
    const row = await this.index.at(Math.min(this.index.info.durationUs, timeUs + 1), 'before');
    const result = await this.index.thumbnail(native, row.index);
    const actual = await this.index.fromNative(result.value.timestampHns);
    if (actual.index !== row.index) throw new AppFailure('FRAME_INDEX', '缩略图与源帧索引不一致。');
    return provided(row, this.index.info, result);
  }
  async resolveIdentity(_native: NativePreview, frame: { identity: FrameIdentity | null }): Promise<FrameIdentity> {
    if (!frame.identity) throw new AppFailure('FRAME_INDEX', '严格模式必须携带已核对的源帧身份。');
    return frame.identity;
  }
  async close(): Promise<void> { await this.index.close(); }
}
