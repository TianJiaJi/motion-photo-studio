import { realpath, stat } from 'node:fs/promises';
import { fromBigInt } from '../motion/io.ts';
import { AppFailure } from '../errors.ts';

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
