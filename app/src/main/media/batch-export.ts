// One frozen source, serial analyze/render/publish, one private heavy draft at a time.
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClipSelection, CropRect, ExportSettings } from '../../shared/editor.ts';
import { MAX_CLIPS } from '../../shared/editor.ts';
import type { AudioSelection, BatchResult, SavedMotion } from '../../shared/export.ts';
import { AppFailure } from '../errors.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { isManagedPath, isPublicationWorkspace } from '../jobs/managed-paths.ts';
import type { Publications } from '../jobs/publications.ts';
import type { EnginePaths } from './engine.ts';
import { assertSource, type SourceFile } from './source.ts';
import { analyzeExport, renderExportDraft, type DraftCover } from './export-pipeline.ts';
import { publishMotionPhoto } from '../motion/publish.ts';

export type BatchClipJob = {
  clipId: string; index: number; number: number; selection: ClipSelection; crop: CropRect;
  cover: { kind: 'auto' } | { kind: 'frame'; pts: string } | { kind: 'custom'; source: SourceFile };
  coverFit: 'cover' | 'contain'; background: string;
};
export type BatchProgressEvent = {
  stage: string; timeUs?: number; analysisId: string; writtenBytes?: number; totalBytes?: number; job: BatchClipJob;
};
export type BatchExportOptions = {
  source: SourceFile; engines: EnginePaths; workDirectory: string; outputDirectory: string; baseName: string; batchId: string;
  jobs: BatchClipJob[]; mode: 'copy' | 'source' | 'encode'; settings: ExportSettings;
  audio: AudioSelection; hdrConsent: boolean; journal: Publications; forbiddenRoots: string[]; signal: AbortSignal;
  result?: BatchResult;
  onProgress?: (progress: BatchProgressEvent) => void | Promise<void>;
  onCommitted?: (saved: SavedMotion, job: BatchClipJob) => void;
};
// Internal dependency seam for deterministic IO/cancel fault tests, never supplied by IPC.
export type BatchOperations = {
  analyze: typeof analyzeExport; render: typeof renderExportDraft; publish: typeof publishMotionPhoto; cleanup: typeof unlinkCreatedFile;
};
const operations: BatchOperations = { analyze: analyzeExport, render: renderExportDraft, publish: publishMotionPhoto, cleanup: unlinkCreatedFile };
const GLOBAL_CODES = new Set(['SOURCE_CHANGED', 'TEMP_CLEANUP', 'DISK_SPACE', 'OUTPUT_ACCESS', 'OUTPUT_UNSUPPORTED', 'PREVIEW_DISK_FULL', 'PREVIEW_BUDGET', 'NATIVE_EXIT']);
const MAX_NAME_ATTEMPTS = 1000;
export function safeFileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/, '').trim();
  return [...stem].slice(0, 80).join('') || '实况';
}
export function batchFileStem(baseName: string, number: number): string {
  return `${safeFileStem(baseName)}_片段${String(number).padStart(2, '0')}`;
}
export function emptyBatchResult(batchId: string, jobs: readonly BatchClipJob[]): BatchResult {
  return { batchId, canceled: false, stopped: false, stopReason: null, saved: [], results: jobs.map(job => ({
    clipId: job.clipId, index: job.index, number: job.number, total: jobs.length, name: null, status: 'skipped', saved: null, error: null,
  })) };
}
export function batchFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure && !['MEDIA_FAILED', 'OUTPUT_VERIFY'].includes(error.code)) return error;
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++) {
    const code = (cause as NodeJS.ErrnoException).code;
    const message = cause instanceof Error ? cause.message : '';
    if (code === 'ENOSPC' || code === 'EDQUOT' || /No space left|not enough space|disk full/i.test(message))
      return new AppFailure('DISK_SPACE', '磁盘空间不足，已停止批次。', { cause: error });
    if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'EIO'].includes(code ?? '')
      || /Permission denied|Read-only file system/i.test(message))
      return new AppFailure('OUTPUT_ACCESS', '批次目录不可访问或不可写，已停止。', { cause: error });
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return error instanceof AppFailure ? error : new AppFailure('MEDIA_FAILED', '此片段处理失败；未发布成品。', { cause: error });
}
export async function runBatchExport(options: BatchExportOptions, overrides: Partial<BatchOperations> = {}): Promise<BatchResult> {
  const op = { ...operations, ...overrides };
  const { source, engines, journal, signal, jobs } = options;
  if (!jobs.length || jobs.length > MAX_CLIPS) throw new AppFailure('INVALID_REQUEST', '批次片段数量无效。');
  const result = options.result ?? emptyBatchResult(options.batchId, jobs);
  const stop = (error: unknown) => { const failure = batchFailure(error); if (failure.code === 'TEMP_CLEANUP') result.cleanupFailed = true; result.stopped = true; result.stopReason = failure.message; return failure; };
  let directory: string; let directoryId: { dev: number; ino: number };
  try {
    signal.throwIfAborted(); directory = await realpath(options.outputDirectory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || isPublicationWorkspace(directory)
      || await isManagedPath(directory, [journal.root, options.workDirectory, ...options.forbiddenRoots]))
      throw new AppFailure('OUTPUT_ACCESS', '请选择应用临时目录以外的输出文件夹。');
    directoryId = { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (signal.aborted) result.canceled = true; else stop(error);
    return result;
  }
  const checkDirectory = async () => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryId.dev || current.ino !== directoryId.ino
      || await realpath(options.outputDirectory) !== directory) throw new AppFailure('OUTPUT_ACCESS', '输出文件夹在批次期间被替换，已停止。');
  };
  for (const [position, job] of jobs.entries()) {
    if (signal.aborted) { result.canceled = true; break; }
    const outcome = result.results[position]!;
    const draftPaths: string[] = [];
    let cleanupFailed = false;
    let draftWarnings: string[] = [];
    const committed = (saved: SavedMotion) => {
      if (outcome.saved) return;
      saved.warnings.unshift(...draftWarnings);
      outcome.saved = saved; outcome.name = saved.name; outcome.status = 'saved'; outcome.error = null;
      result.saved.push(saved); options.onCommitted?.(saved, job);
    };
    try {
      await assertSource(source); await checkDirectory(); signal.throwIfAborted();
      const processing = options.mode === 'encode' ? { mode: 'encode' as const, crop: job.crop, settings: options.settings } : { mode: options.mode };
      await options.onProgress?.({ stage: 'plan', analysisId: '', job });
      const analysis = await op.analyze(source, { clip: job.selection, processing, audio: options.audio, hdrConsent: options.hdrConsent }, engines, signal);
      if (!analysis.public.supported) throw new AppFailure('INVALID_REQUEST', analysis.public.reasons.join('；') || '此片段无法按当前参数导出。');
      const cover: DraftCover | undefined = job.cover.kind === 'auto' ? undefined
        : job.cover.kind === 'frame' ? { kind: 'frame', pts: job.cover.pts } : { kind: 'custom', source: job.cover.source };
      const rendered = await op.render({ source, analysis, cover, image: { fit: job.coverFit, background: job.background },
        directory: options.workDirectory, engines, signal,
        onStage: (stage, timeUs) => options.onProgress?.({ stage, timeUs, analysisId: analysis.public.id, job }) });
      draftPaths.push(rendered.video.path, rendered.cover.path);
      draftWarnings = rendered.report.warnings;
      const stem = batchFileStem(options.baseName, job.number);
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
        signal.throwIfAborted(); await checkDirectory();
        const output = join(directory, `${stem}${attempt === 1 ? '' : `-${attempt}`}.jpg`);
        try { await lstat(output); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try {
          const saved = await op.publish({ cover: rendered.cover, video: rendered.video,
            sources: [source, ...(job.cover.kind === 'custom' ? [job.cover.source] : [])], output,
            timestampUs: rendered.report.coverTimestampUs, videoDurationUs: rendered.report.durationUs,
            journal, signal, forbiddenRoots: options.forbiddenRoots, onCommitted: committed,
            onCleanupFailure: () => { cleanupFailed = true; },
            onStage: (stage, writtenBytes, totalBytes) => options.onProgress?.({ stage, writtenBytes, totalBytes, analysisId: analysis.public.id, job }) });
          committed(saved); break;
        } catch (error) {
          if (outcome.saved) break; // commit wins even if cancel/error races its notification
          if (error instanceof AppFailure && error.code === 'OUTPUT_EXISTS') continue;
          throw error;
        }
      }
      if (!outcome.saved) throw new AppFailure('OUTPUT_EXISTS', '同名文件过多；没有覆盖任何已有文件。');
    } catch (error) {
      let cause = error;
      // Source mutations are batch-global even when a decoder first reports a content error.
      if (!(error instanceof AppFailure && error.code === 'TEMP_CLEANUP')) {
        try { await assertSource(source); } catch (changed) { cause = changed; }
      }
      const failure = batchFailure(cause);
      if (!outcome.saved) {
        outcome.status = signal.aborted ? 'cancelled' : 'failed';
        outcome.error = signal.aborted && failure.code !== 'TEMP_CLEANUP' ? { code: 'CANCELLED', message: '此片段已取消，未发布。' }
          : { code: failure.code, message: failure.message };
      }
      if (GLOBAL_CODES.has(failure.code)) stop(failure);
      else if (signal.aborted || failure.code === 'CANCELLED') result.canceled = true;
    } finally {
      for (const path of draftPaths) {
        try { await op.cleanup(path); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) {
        result.cleanupFailed = true;
        const failure = stop(new AppFailure('TEMP_CLEANUP', '临时文件清理未完成，已停止批次；已发布文件保留。'));
        if (outcome.saved) outcome.saved.warnings.push(failure.message);
        else { outcome.status = 'failed'; outcome.error = { code: failure.code, message: failure.message }; }
      }
    }
    if (result.stopped || result.canceled) break;
  }
  return result;
}
