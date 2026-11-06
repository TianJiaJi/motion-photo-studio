// Shared harness proving whether a media path performed whole-file scans.
// The fast-import path must be assertable: no full FFmpeg frame enumeration,
// no full native video scan, and no full native audio scan before ready.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { NativePreview } from '../src/main/media/native-preview.ts';

export type SpawnRow = { executable: string; args: string[] };
export type NativeRow = { command: string; request: Record<string, unknown> };
export type MediaActivity = { spawns: SpawnRow[]; native: NativeRow[] };

// A single native audio/video scan command is bounded work only when its requested
// count stays small; the strict import path accumulates unbounded scans instead.
const BOUNDED_SCAN_COUNT = 4096;

export async function recordMediaActivity<T>(run: (activity: MediaActivity) => Promise<T>):
  Promise<{ result: T; activity: MediaActivity }> {
  const activity: MediaActivity = { spawns: [], native: [] };
  const originalSpawn = childProcess.spawn;
  const originalRequest = NativePreview.prototype.request;
  childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    activity.spawns.push({ executable: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] });
    return Reflect.apply(originalSpawn, childProcess, args);
  }) as typeof originalSpawn;
  NativePreview.prototype.request = function (this: NativePreview, command: Record<string, unknown>, options?: Parameters<typeof originalRequest>[1]) {
    activity.native.push({ command: String(command.command), request: command });
    return Reflect.apply(originalRequest, this, [command, options]);
  } as NativePreview['request'];
  syncBuiltinESMExports();
  try {
    return { result: await run(activity), activity };
  } finally {
    childProcess.spawn = originalSpawn;
    NativePreview.prototype.request = originalRequest;
    syncBuiltinESMExports();
  }
}

function executableName(path: string): string {
  return path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

// Human-readable markers of work that scales with the WHOLE file, not the edited neighborhood.
// Bounded windows (one small scanFrames/audioScan batch) are legal; unbounded enumeration is not.
export function fullMediaScanMarkers(activity: MediaActivity): string[] {
  const markers: string[] = [];
  for (const row of activity.spawns) {
    const name = executableName(row.executable);
    if (name.startsWith('ffprobe') && (row.args.includes('-show_frames') || row.args.some(arg => arg.startsWith('frame='))))
      markers.push(`ffprobe 全片帧枚举: ${row.args.join(' ')}`);
    if (name.startsWith('ffmpeg') && row.args.some(arg => arg.startsWith('libx264') || arg.startsWith('libx265')))
      markers.push(`ffmpeg 整片转码: ${row.args.join(' ')}`);
  }
  let videoSamples = 0; let audioBlocks = 0;
  for (const row of activity.native) {
    const count = typeof row.request.count === 'number' ? row.request.count : 0;
    if (row.command === 'scanFrames') videoSamples += count;
    if (row.command === 'audioScan') audioBlocks += count;
  }
  if (videoSamples > BOUNDED_SCAN_COUNT) markers.push(`原生视频样本扫描 ${videoSamples} 帧（超过有界窗口 ${BOUNDED_SCAN_COUNT}）`);
  if (audioBlocks > BOUNDED_SCAN_COUNT) markers.push(`原生音频样本扫描 ${audioBlocks} 块（超过有界窗口 ${BOUNDED_SCAN_COUNT}）`);
  return markers;
}

export function assertNoFullMediaScan(activity: MediaActivity, context: string): void {
  const markers = fullMediaScanMarkers(activity);
  if (markers.length) throw new Error(`${context} 不应执行全片扫描:\n${markers.join('\n')}`);
}
