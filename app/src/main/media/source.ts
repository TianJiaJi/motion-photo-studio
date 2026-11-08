import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fromBigInt } from '../motion/io.ts';
import { AppFailure } from '../errors.ts';

// Source/output identity must survive 8.3 short names (e.g. RUNNER~1 temp directories),
// drive-letter case and other harmless spelling differences. Compare resolved file targets.
function canonicalTarget(path: string): string {
  const absolute = resolve(path);
  // Only the native realpath resolves 8.3 short names (RUNNER~1) and true case.
  try { return realpathSync.native(absolute); }
  catch {
    try { return resolve(realpathSync.native(dirname(absolute)), basename(absolute)); }
    catch { return absolute; }
  }
}
export function sameFileTarget(a: string, b: string): boolean {
  const left = canonicalTarget(a), right = canonicalTarget(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function fileFingerprint(path: string): Promise<{ size: number; stamp: string }> {
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error('Not a regular media file');
  return { size: fromBigInt(info.size, 'media size'), stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
}
export type SourceFile = { path: string; size: number; stamp: string };
export async function openSource(path: string): Promise<SourceFile> {
  const canonical = await realpath(path);
  return { path: canonical, ...await fileFingerprint(canonical) };
}
export async function assertSource(source: SourceFile): Promise<void> {
  try { if ((await fileFingerprint(source.path)).stamp === source.stamp) return; }
  catch { /* Removal, replacement and permission changes all invalidate this session's source. */ }
  throw new AppFailure('SOURCE_CHANGED', '源文件已修改、移动或不可读取，请重新导入。');
}
