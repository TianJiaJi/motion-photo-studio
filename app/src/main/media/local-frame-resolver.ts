// On-demand exact source identity for frames shown by the quick preview path.
// Resolution uses the SAME presentation-PTS machinery as export planning (frameAtOrAfter),
// bounded to a small neighborhood: no whole-file frame enumeration, no guessed frame rates.
import { ptsToUs } from '../../shared/editor.ts';
import type { MediaInfo } from '../../shared/media.ts';
import { AppFailure } from '../errors.ts';
import { assertSource, type SourceFile } from './source.ts';
import { frameAtOrAfter, type PresentedFrame, type FrameNeighbor } from './encode-plan.ts';
import type { FrameIdentity } from './frame-provider.ts';

// The quick preview derives display time from native stamps anchored at the verified import
// window. mapNative's interval rule bounds the stamp/source deviation to 2hns; anchor and
// microsecond truncations add ~2us. Anything closer than this is not uniquely attributable.
export const DISPLAY_TIME_BOUND_US = 8;

export type ResolvedFrame = { identity: FrameIdentity; timeUs: number; durationUs: number };
const MAX_CACHED = 512;

function frameTimeUs(frame: PresentedFrame, info: MediaInfo): number {
  return ptsToUs(frame.pts.toString(), info.startPts, info.timeBase);
}
function frameDurationUs(frame: PresentedFrame, info: MediaInfo): number {
  return frame.duration === null ? 0
    : Number(frame.duration * BigInt(info.timeBase.numerator) * 1_000_000n / BigInt(info.timeBase.denominator));
}

export class LocalFrameResolver {
  private readonly cache = new Map<string, ResolvedFrame>();
  private readonly queries = new Map<number, FrameNeighbor>();
  private readonly resolvedAt = new Map<number, ResolvedFrame>();
  private closed = false;
  private readonly neighborCache = new Map<string, { previous: ResolvedFrame | null; next: ResolvedFrame | null }>();
  private readonly options: { source: SourceFile; info: MediaInfo; executable: string };
  constructor(options: { source: SourceFile; info: MediaInfo; executable: string }) { this.options = options; }

  private async check(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new AppFailure('CANCELLED', '局部帧解析器已关闭。');
    try { await assertSource(this.options.source); }
    catch (error) { this.clear(); throw error; }
    signal?.throwIfAborted();
  }
  private clear() { this.cache.clear(); this.queries.clear(); this.resolvedAt.clear(); this.neighborCache.clear(); }
  close() { this.closed = true; this.clear(); }
  private async query(timeUs: number, signal?: AbortSignal): Promise<FrameNeighbor> {
    await this.check(signal);
    const cached = this.queries.get(timeUs);
    if (cached) { this.queries.delete(timeUs); this.queries.set(timeUs, cached); return cached; }
    const { source, info, executable } = this.options;
    const result = await frameAtOrAfter(source, info, timeUs, executable, signal, undefined,
      { maxFrames: 4096, maxBackUs: 32_000_000, timeoutMs: 15000 }).catch(async error => {
        await this.check(signal);
        if (error instanceof Error && error.message === 'Streaming media inspection timed out')
          throw new AppFailure('LOCAL_FRAME_LIMIT', '局部精确帧解析超时，请使用兼容准备。');
        throw error;
      });
    await this.check(signal);
    this.queries.set(timeUs, result);
    while (this.queries.size > MAX_CACHED) this.queries.delete(this.queries.keys().next().value!);
    return result;
  }

  // The identity of the frame actually displayed at derived time `timeUs`, or a loud failure.
  // Never returns a merely adjacent frame: candidates must be uniquely closest to the display
  // time within DISPLAY_TIME_BOUND_US, otherwise the mapping is explicitly rejected.
  async resolveAt(timeUs: number, signal?: AbortSignal): Promise<ResolvedFrame> {
    const { info } = this.options;
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs > info.durationUs) throw new AppFailure('FRAME_INDEX', '定位时间超出素材范围。');
    await this.check(signal);
    const cached = this.resolvedAt.get(timeUs);
    if (cached) { this.resolvedAt.delete(timeUs); this.resolvedAt.set(timeUs, cached); return cached; }
    const { found, last } = await this.query(timeUs + 1, signal);
    const candidates = [found, last].filter((frame): frame is PresentedFrame => frame !== null);
    if (!candidates.length) throw new AppFailure('FRAME_INDEX', '无法核对当前显示帧的源帧身份。');
    const scored = candidates.map(frame => ({ frame, distance: Math.abs(frameTimeUs(frame, info) - timeUs) }))
      .sort((a, b) => a.distance - b.distance);
    const best = scored[0]!;
    if (best.distance > DISPLAY_TIME_BOUND_US) throw new AppFailure('FRAME_INDEX',
      `当前显示帧与源帧时序相差 ${best.distance}us，超过核对阈值，不能确认封面帧身份。`);
    const resolved = this.remember(best.frame);
    const neighbors = await this.neighborsOf(resolved, signal);
    if ([neighbors.previous, neighbors.next].some(frame => frame && Math.abs(frame.timeUs - timeUs) <= DISPLAY_TIME_BOUND_US))
      throw new AppFailure('FRAME_INDEX', '当前时间附近的源帧不唯一，不能确认封面帧身份。');
    this.resolvedAt.set(timeUs, resolved);
    while (this.resolvedAt.size > MAX_CACHED) this.resolvedAt.delete(this.resolvedAt.keys().next().value!);
    return resolved;
  }

  // Exact presented neighbors of an already-resolved frame (its time is source-PTS truth).
  async neighborsOf(resolved: ResolvedFrame, signal?: AbortSignal): Promise<{ previous: ResolvedFrame | null; next: ResolvedFrame | null }> {
    await this.check(signal);
    const cached = this.neighborCache.get(resolved.identity.pts);
    if (cached) { this.neighborCache.delete(resolved.identity.pts); this.neighborCache.set(resolved.identity.pts, cached); return cached; }
    const at = await this.query(resolved.timeUs, signal);
    signal?.throwIfAborted();
    if (!at.found || at.found.pts.toString() !== resolved.identity.pts) throw new AppFailure('FRAME_INDEX', '当前帧的源帧身份已无法复核。');
    const forward = await this.query(resolved.timeUs + 1, signal);
    await this.check(signal);
    if (!forward.last || forward.last.pts.toString() !== resolved.identity.pts) throw new AppFailure('FRAME_INDEX', '当前帧的后继帧无法核对。');
    return this.rememberNeighbors(resolved.identity.pts, {
      previous: at.last ? this.remember(at.last) : null,
      next: forward.found ? this.remember(forward.found) : null,
    });
  }

  private rememberNeighbors(pts: string, value: { previous: ResolvedFrame | null; next: ResolvedFrame | null }) {
    this.neighborCache.set(pts, value);
    while (this.neighborCache.size > MAX_CACHED) this.neighborCache.delete(this.neighborCache.keys().next().value!);
    return value;
  }

  private remember(frame: PresentedFrame): ResolvedFrame {
    const { info } = this.options;
    const pts = frame.pts.toString();
    const cached = this.cache.get(pts);
    if (cached) { this.cache.delete(pts); this.cache.set(pts, cached); return cached; }
    const resolved: ResolvedFrame = {
      identity: { pts, sourceFrame: null },
      timeUs: frameTimeUs(frame, info),
      durationUs: frameDurationUs(frame, info),
    };
    this.cache.set(pts, resolved);
    while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return resolved;
  }
}
