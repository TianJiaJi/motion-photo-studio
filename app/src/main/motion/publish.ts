import { link, statfs, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { AppFailure } from '../errors.ts';
import { Publications, type PublicationWorkspace } from '../jobs/publications.ts';
import { isManagedPath, isPublicationWorkspace } from '../jobs/managed-paths.ts';
import { assertSource, openSource, type SourceFile } from '../media/source.ts';
import { DEFAULT_PROFILE_ID } from './profiles.ts';
import { muxMotion } from './mux.ts';
import { validateMotion } from './validate.ts';
import { canonicalJpegHash } from './hash-jpeg.ts';
import { sha256 } from './io.ts';
import type { SavedMotion } from '../../shared/export.ts';
export type { SavedMotion } from '../../shared/export.ts';
export type PublicationIO = { freeBytes(parent: string): Promise<bigint | null>; commit(stage: string, output: string): Promise<void> };
const nativeIO: PublicationIO = {
  freeBytes: async parent => { try { const fs = await statfs(parent, { bigint: true }); return fs.bavail >= 0n && fs.bsize > 0n ? fs.bavail * fs.bsize : null; } catch { return null; } },
  commit: link,
};
function safeFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = code === 'EEXIST' ? '目标文件已存在，请另选文件名；没有覆盖任何文件。'
    : code === 'ENOSPC' || code === 'EDQUOT' ? '目标磁盘空间不足，未保存新的实况照片。'
    : ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '') ? '目标文件系统不支持安全的无覆盖发布，请选择其他位置。'
    : ['EACCES', 'EPERM', 'EBUSY', 'EROFS', 'ENOENT'].includes(code ?? '') ? '输出目录不可访问、不可写或文件被占用，未覆盖已有文件。'
    : '实况文件的写入或回读校验失败，未发布成品。';
  const publicCode = code === 'EEXIST' ? 'OUTPUT_EXISTS' : code === 'ENOSPC' || code === 'EDQUOT' ? 'DISK_SPACE'
    : ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '') ? 'OUTPUT_UNSUPPORTED'
    : ['EACCES', 'EPERM', 'EBUSY', 'EROFS', 'ENOENT'].includes(code ?? '') ? 'OUTPUT_ACCESS' : 'OUTPUT_VERIFY';
  return new AppFailure(publicCode, message, { cause: error });
}

// Public final path enters only from a native save dialog. Renderer supplies neither it nor profile/XMP bytes.
// The final link is the linearization point: cancellation after it means SAVED, never "cancelled".
export async function publishMotionPhoto(options: {
  cover: SourceFile; video: SourceFile; sources?: SourceFile[]; output: string; timestampUs: number; videoDurationUs: number; forbiddenRoots?: string[];
  journal: Publications; signal: AbortSignal; io?: PublicationIO;
  onStage?: (stage: string, writtenBytes?: number, totalBytes?: number) => void | Promise<void>;
  onCommitted?: (result: SavedMotion) => void;
}): Promise<SavedMotion> {
  const { cover, video, journal, signal } = options; const io = options.io ?? nativeIO;
  const path = resolve(options.output);
  if (!['.jpg', '.jpeg'].includes(extname(path).toLowerCase())) throw new AppFailure('INVALID_REQUEST', '实况照片须保存为 JPG/JPEG 文件。');
  if (!Number.isSafeInteger(options.videoDurationUs) || options.videoDurationUs <= 0
    || !Number.isSafeInteger(options.timestampUs) || options.timestampUs < -1 || options.timestampUs >= options.videoDurationUs) throw new AppFailure('INVALID_REQUEST', '封面关联时间无效。');
  let parent: string;
  try { parent = await realpath(dirname(path)); } catch (error) { throw safeFailure(error); }
  const output = join(parent, basename(path));
  if (isPublicationWorkspace(parent) || await isManagedPath(output, [journal.root, ...(options.forbiddenRoots ?? [])]))
    throw new AppFailure('OUTPUT_ACCESS', '不能把成品保存到应用临时工作区，请选择其他目录。');
  const inputs = [cover, video, ...(options.sources ?? [])];
  if (inputs.some(input => process.platform === 'win32' ? input.path.toLowerCase() === output.toLowerCase() : input.path === output))
    throw new AppFailure('OUTPUT_EXISTS', '不能覆盖源文件或应用草稿，请另选文件名。');
  signal.throwIfAborted(); for (const input of inputs) await assertSource(input);
  try {
    await lstat(output);
    throw new AppFailure('OUTPUT_EXISTS', '目标文件已存在，请另选文件名；没有覆盖任何文件。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw safeFailure(error); }
  // This precheck only avoids wasted copying; the final link still enforces no-clobber against races.
  const warnings: string[] = [];
  const estimate = BigInt(cover.size) + BigInt(video.size) + 131072n;
  const free = await io.freeBytes(parent);
  if (free !== null && free < estimate) throw new AppFailure('DISK_SPACE', '目标磁盘可用空间不足以写入成品和元数据。');
  if (free === null) warnings.push('无法预先读取目标盘可用空间，写入仍可能因实际空间不足而失败。');
  let workspace: PublicationWorkspace | undefined; let saved: SavedMotion | undefined; let failure: unknown;
  try {
    workspace = await journal.begin(parent); signal.throwIfAborted();
    await options.onStage?.('mux');
    let lastProgress = 0;
    await muxMotion({ cover: cover.path, video: video.path, output: workspace.stage, profileId: DEFAULT_PROFILE_ID,
      timestampUs: options.timestampUs, signal, onProgress: async (written, total) => {
        if (written === total || Date.now() - lastProgress > 100) { lastProgress = Date.now(); await options.onStage?.('mux', written, total); }
      } });
    await options.onStage?.('read-back');
    const staged = await openSource(workspace.stage); const report = await validateMotion(workspace.stage, true, signal);
    if (report.metadata.timestampUs !== options.timestampUs || report.metadata.videoLength !== video.size
      || report.size !== staged.size || report.videoEnd !== staged.size || report.metadata.legacy
      || report.exif.length !== 1 || report.exif[0]!.orientation !== 1 || report.exif[0]!.xiaomiFlag !== 1)
      throw new Error('Final container metadata mismatch');
    await options.onStage?.('verify-jpeg');
    if (await canonicalJpegHash(cover.path, signal) !== await canonicalJpegHash(workspace.stage, signal)) throw new Error('Final JPEG bytes differ');
    await options.onStage?.('verify-video-bytes');
    if (await sha256(video.path, 0, video.size, signal) !== await sha256(workspace.stage, report.videoStart, report.videoEnd, signal))
      throw new Error('Final embedded video differs');
    await options.onStage?.('publish');
    for (const input of inputs) await assertSource(input);
    await assertSource(staged); signal.throwIfAborted();
    // A fully validated same-volume file becomes visible atomically. EEXIST never overwrites a file/link.
    await io.commit(workspace.stage, output);
    saved = { name: basename(output), size: report.size, profile: DEFAULT_PROFILE_ID,
      width: report.width, height: report.height, timestampUs: options.timestampUs, durationUs: options.videoDurationUs, warnings };
    try { options.onCommitted?.(saved); } catch { warnings.push('成品已保存，但完成状态通知异常；请检查所选文件。'); }
  } catch (error) {
    failure = error;
    if (!signal.aborted) {
      try { for (const input of inputs) await assertSource(input); }
      catch (changed) { failure = changed; }
    }
  }
  if (workspace) {
    try { await journal.cleanup(workspace.id); }
    catch (error) {
      if (saved) warnings.push('成品已保存；临时工作区被占用，将在下次启动重试清理。');
      else failure = new AppFailure('TEMP_CLEANUP', `${safeFailure(failure).message} 临时工作区清理未完成，下次启动将重试。`, { cause: error });
    }
  }
  if (saved) return saved;
  if (failure instanceof AppFailure && failure.code === 'TEMP_CLEANUP') throw failure;
  if (signal.aborted) throw new AppFailure('CANCELLED', '保存已取消，未发布新的实况照片。');
  throw safeFailure(failure);
}
