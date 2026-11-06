import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import type { VideoAsset, Thumbnail, CoverAsset } from '../../shared/media.ts';
import type { EnginePaths } from './engine.ts';
import { MediaResources } from './resources.ts';
import type { MediaMime, ResourceRef } from './resources.ts';
import { openSource, assertSource } from './source.ts';
import type { SourceFile } from './source.ts';
import { probeMedia, type MediaProbe } from './probe.ts';
import { mediaInfo } from './info.ts';
import { LatestTask } from '../jobs/latest-task.ts';
import { TempFiles, unlinkCreatedFile } from '../jobs/temp-files.ts';
import { AppFailure } from '../errors.ts';
import { createClip, type ClipModel } from '../../shared/editor.ts';
import type { ClipReference } from '../../shared/media-ipc.ts';
import { runBatchExport, emptyBatchResult, batchFailure, type BatchClipJob } from './batch-export.ts';
import { parseBatchSnapshot } from './export-requests.ts';
import { parseClipModels } from './clip-requests.ts';
import { initialAudioTrack } from '../../shared/export.ts';
import type { ExportOptions, ExportInspection, ExportDraft, DraftOptions, ExportProgress, SavedMotion, CancelResult, BatchSnapshot, BatchResult } from '../../shared/export.ts';
import { analyzeExport, renderExportDraft, type ExportAnalysis } from './export-pipeline.ts';
import { Publications } from '../jobs/publications.ts';
import { publishMotionPhoto } from '../motion/publish.ts';
import { isManagedPath, isPublicationWorkspace } from '../jobs/managed-paths.ts';
import sharp from 'sharp';
import { NativeTimeline } from './native-timeline.ts';
import { prepareNativeMedia, type PreparedMedia } from './native-import.ts';
import { prepareQuickMedia } from './quick-import.ts';
import type { PreviewAck, PreviewControl, PreviewPixels, PreviewReady, PreviewStatus } from '../../shared/native-preview.ts';

type NativeOptions = { helper: string; forceStrict?: boolean; verify?(): Promise<void>; frame(frame: PreviewPixels): void; status(status: PreviewStatus): void };

type Stored = ResourceRef & { path: string; owned: boolean };
type WorkFiles = {
  adopt(path: string): void;
  publish(path: string, mime: MediaMime, owned: boolean, additionalSource?: SourceFile): Promise<Stored>;
};
type ClipResources = {
  model: ClipModel;
  cover?: { file: Stored; cover: CoverAsset; source?: SourceFile; framePts?: string };
  analysis?: ExportAnalysis;
  draft?: { video: Stored; image: Stored; public: ExportDraft; videoSource: SourceFile; imageSource: SourceFile; selectedCoverId: string | null; customSource?: SourceFile };
};
type Session = {
  asset: VideoAsset; source: SourceFile; probe: MediaProbe; directory: string; refs: Set<string>;
  primary: LatestTask; background: LatestTask; preparation: LatestTask; metadata: LatestTask; cleanupFailed: boolean;
  native?: NativeTimeline; preparing?: Promise<PreviewReady>; preparingAudio?: number | null; preparedAudio?: number | null; preparingStrict?: boolean;
  thumbs: Map<number, { file: Stored; thumbnail: Thumbnail }>;
  clips: Map<string, ClipResources>; retiredClips: Set<string>; lastClipNumber: number;
  saving?: { id: string };
  receipts: Map<string, SavedMotion>;
  batch?: { id: string; controller: AbortController; result: BatchResult; done?: Promise<BatchResult> };
  batchResults: Map<string, BatchResult>;
};
function invalid(message = '无效的媒体请求。'): never { throw new AppFailure('INVALID_REQUEST', message); }
function time(value: number, durationUs: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > durationUs) invalid('时间必须位于当前视频内。');
}

// Paths enter only from the main process's native dialogs. Renderer requests contain asset IDs/time values.
export class MediaSession {
  private current?: Session;
  private readonly imports = new LatestTask();
  private readonly cleanups = new Set<Promise<void>>();
  private closed = false;
  private readonly engines: EnginePaths;
  private readonly temp: TempFiles;
  readonly resources: MediaResources;
  private readonly warn: (message: string) => void;
  private readonly exportProgress: (progress: ExportProgress) => void;
  private readonly publications?: Publications;
  private readonly additionalManagedRoots: readonly string[];
  private readonly nativeOptions?: NativeOptions;
  private nativeReleaseBarrier: Promise<void> = Promise.resolve();
  constructor(engines: EnginePaths, temp: TempFiles, resources: MediaResources, warn: (message: string) => void = () => {},
    exportProgress: (progress: ExportProgress) => void = () => {}, publications?: Publications, additionalManagedRoots: readonly string[] = [], nativeOptions?: NativeOptions) {
    this.engines = engines; this.temp = temp; this.resources = resources; this.warn = warn; this.exportProgress = exportProgress; this.publications = publications;
    this.additionalManagedRoots = additionalManagedRoots; this.nativeOptions = nativeOptions;
  }
  get busy(): boolean { return this.imports.busy || Boolean(this.current?.batch || this.current?.metadata.busy || this.current?.primary.busy || this.current?.background.busy || this.current?.preparation.busy || this.current?.native?.stats.activeControl); }
  assertActive(id: string): void { this.require(id); }
  assertImportAllowed(): void { if (this.current?.batch) throw new AppFailure('JOB_BUSY', '批量导出期间不能更换素材。'); }

  private require(id: string, allowCleanupFailure = false, allowBatch = false): Session {
    if (this.closed) throw new AppFailure('CANCELLED', '应用正在退出。');
    if (this.imports.busy) throw new AppFailure('JOB_BUSY', '正在导入新素材，请稍候。');
    if (!this.current || this.current.asset.id !== id) throw new AppFailure('MEDIA_NOT_FOUND', '素材已关闭或已被替换。');
    if (this.current.batch && !allowBatch) throw new AppFailure('JOB_BUSY', '批量导出期间片段和参数已冻结，请先完成或取消。');
    if (this.current.cleanupFailed && !allowCleanupFailure) throw new AppFailure('TEMP_CLEANUP', '预览缓存无法清理，请关闭素材并重试。');
    return this.current;
  }
  private clip(s: Session, ref?: ClipReference): ClipResources {
    if (s.metadata.busy) throw new AppFailure('JOB_BUSY', '片段设置正在同步，请稍候。');
    if (s.saving) throw new AppFailure('JOB_BUSY', '正在保存，请等待完成或取消。');
    const id = ref?.clipId ?? s.asset.id, revision = ref?.revision ?? 0;
    const clip = s.clips.get(id);
    if (!clip || clip.model.revision !== revision) invalid('片段已删除或版本过期，请重试当前片段。');
    return clip;
  }
  private async releaseDraft(s: Session, c: ClipResources): Promise<void> {
    const draft = c.draft; c.draft = undefined;
    if (draft) { await this.retire(s, draft.video); await this.retire(s, draft.image); }
  }
  async syncClips(id: string, input: ClipModel[]): Promise<void> {
    const s = this.require(id);
    if (s.saving) throw new AppFailure('JOB_BUSY', '保存期间不能修改片段。');
    const models = parseClipModels(input, s.asset.info.durationUs);
    await this.work(s, s.metadata, async signal => {
      await s.primary.cancel(); signal.throwIfAborted();
      let lastNumber = s.lastClipNumber;
      for (const model of models) {
        const old = s.clips.get(model.id);
        if (old) {
          if (model.number !== old.model.number || model.revision < old.model.revision
            || model.revision === old.model.revision && JSON.stringify(model) !== JSON.stringify(old.model)) invalid('片段版本已过期。');
        } else {
          if (s.retiredClips.has(model.id) || model.number <= lastNumber) invalid('新增片段身份无效。');
          lastNumber = model.number;
        }
      }
      if (s.retiredClips.size + models.length > 1000) throw new AppFailure('PREVIEW_BUDGET', '本次会话创建片段过多，请重新导入素材。');
      const keep = new Set(models.map(c => c.id));
      for (const [clipId, c] of s.clips) if (!keep.has(clipId)) {
        s.clips.delete(clipId); s.retiredClips.add(clipId);
        await this.releaseDraft(s, c);
        if (c.cover) await this.retire(s, c.cover.file);
      }
      for (const model of models) {
        const c = s.clips.get(model.id);
        if (!c) s.clips.set(model.id, { model });
        else if (c.model.revision !== model.revision) {
          c.model = model; c.analysis = undefined;
          await this.releaseDraft(s, c);
        }
      }
      s.lastClipNumber = lastNumber;
    });
  }
  async clearCover(id: string, ref?: ClipReference): Promise<void> {
    const s = this.require(id), c = this.clip(s, ref);
    await this.work(s, s.primary, async () => {
      this.clip(s, ref);
      const old = c.cover; c.cover = undefined; c.analysis = undefined;
      await this.releaseDraft(s, c);
      if (old) await this.retire(s, old.file);
    });
  }

  private allowHDR(s: Session, consent: boolean): void {
    if (typeof consent !== 'boolean') invalid();
    if (s.asset.info.hdr && !consent) throw new AppFailure('HDR_CONFIRM_REQUIRED', '这是 HDR 视频，需明确同意转换为 SDR 才能生成兼容预览或抽帧；源文件不会修改。');
  }
  private removeDirectory(directory: string): Promise<void> {
    const result = this.temp.remove(directory).catch(() => { this.warn('有媒体缓存未能清理，将在下次启动重试；没有删除源文件。'); });
    this.cleanups.add(result);
    void result.then(() => this.cleanups.delete(result));
    return result;
  }
  private async stored(s: Session, path: string, mime: MediaMime, owned: boolean): Promise<Stored> {
    const ref = await this.resources.register(path, mime);
    s.refs.add(ref.id); return { ...ref, path, owned };
  }
  private async retire(s: Session, file: Stored): Promise<void> {
    try { await this.resources.revoke(file.id); }
    catch (error) { s.cleanupFailed = true; throw error; }
    s.refs.delete(file.id);
    if (!file.owned) return;
    try { await unlink(file.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      s.cleanupFailed = true;
      throw new AppFailure('TEMP_CLEANUP', '缓存文件被占用，已暂停新预览以避免持续占用磁盘。请关闭素材后重试。');
    }
  }
  private async work<T>(s: Session, lane: LatestTask, operation: (signal: AbortSignal, files: WorkFiles) => Promise<T>): Promise<T> {
    return lane.run(async signal => {
      await assertSource(s.source); signal.throwIfAborted();
      const pending = new Set<string>();
      const files: WorkFiles = {
        adopt: path => { pending.add(path); },
        publish: async (path, mime, owned, additionalSource) => {
          if (owned && !pending.has(path)) throw new Error('Unowned generated media');
          await assertSource(s.source); signal.throwIfAborted();
          const file = await this.stored(s, path, mime, owned);
          try {
            await assertSource(s.source);
            if (additionalSource) await assertSource(additionalSource);
            signal.throwIfAborted();
          } catch (error) {
            try { await this.resources.revoke(file.id); }
            catch (drainError) { pending.delete(path); s.cleanupFailed = true; throw drainError; }
            s.refs.delete(file.id); throw error;
          }
          pending.delete(path); return file;
        },
      };
      try {
        return await operation(signal, files);
      } catch (error) {
        if (error instanceof AppFailure) {
          if (error.code === 'TEMP_CLEANUP') s.cleanupFailed = true;
          throw error;
        }
        await assertSource(s.source);
        if (error instanceof Error && /No (following|preceding) video frame/.test(error.message)) {
          throw new AppFailure('FRAME_BOUNDARY', error.message.includes('following') ? '已到最后一帧。' : '已到第一帧。');
        }
        throw new AppFailure('MEDIA_FAILED', '本地媒体处理失败。文件可能损坏、编码暂不支持、磁盘空间不足或文件被占用。', { cause: error });
      } finally {
        let failure: unknown;
        for (const path of pending) { try { await unlinkCreatedFile(path); } catch (error) { failure ??= error; } }
        if (failure) {
          s.cleanupFailed = true;
          this.warn('未完成的媒体缓存无法清理，已暂停该素材的新预览，请关闭素材后重试。');
          throw failure;
        }
      }
    });
  }

  async open(path: string): Promise<VideoAsset> {
    this.assertImportAllowed();
    if (this.closed) throw new AppFailure('CANCELLED', '应用正在退出。');
    return this.imports.run(async signal => {
      let candidate: Session | undefined;
      let committed = false;
      try {
        const source = await openSource(path);
        if (isPublicationWorkspace(source.path) || await isManagedPath(source.path, [this.temp.root, ...(this.publications ? [this.publications.root] : []), ...this.additionalManagedRoots]))
          invalid('不能从应用临时工作区导入素材，请使用原始文件。');
        const probe = await probeMedia(source.path, { executable: this.engines.ffprobe, signal });
        const info = mediaInfo(probe);
        await assertSource(source); signal.throwIfAborted();
        const directory = await this.temp.create();
        candidate = { asset: { id: randomUUID(), name: basename(path), size: source.size, info }, source, probe, directory,
          refs: new Set(), primary: new LatestTask(), background: new LatestTask(), preparation: new LatestTask(), metadata: new LatestTask(), cleanupFailed: false,
          thumbs: new Map(), receipts: new Map(), batchResults: new Map(), clips: new Map(), retiredClips: new Set(), lastClipNumber: 1 };
        candidate.clips.set(candidate.asset.id, { model: createClip(candidate.asset.id, { startUs: 0, endUs: info.durationUs }, info.durationUs) });
        const previous = this.current;
        if (previous) await Promise.all([previous.metadata.cancel(), previous.primary.cancel(), previous.background.cancel(), previous.preparation.cancel()]);
        await assertSource(source); signal.throwIfAborted();
        // Metadata commit is independent of old cleanup; the native release barrier gates the next helper.
        this.current = candidate; committed = true;
        if (previous) {
          // Commit the new metadata first, but prohibit a new helper until old termination is confirmed.
          const release = this.nativeReleaseBarrier.then(async () => {
            await previous.native?.dispose(); await this.resources.revokeAll(previous.refs);
          });
          this.nativeReleaseBarrier = release;
          try {
            await release;
            await this.removeDirectory(previous.directory);
          } catch { this.warn('旧原生预览未能确认释放，已保留缓存并阻止启动新预览；请重新启动应用。'); }
        }
        return structuredClone(candidate.asset);
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        throw new AppFailure('MEDIA_FAILED', '无法读取所选视频。请确认文件可访问、包含视频画面且编码/旋转方式受支持。', { cause: error });
      } finally {
        if (candidate && !committed) {
          await this.resources.revokeAll(candidate.refs);
          await this.removeDirectory(candidate.directory);
        }
      }
    });
  }

  async prepareNative(id: string, hdrConsent: boolean, audioTrack?: number | null, forceStrict = false): Promise<PreviewReady> {
    const s = this.require(id); this.allowHDR(s, hdrConsent);
    const selected = audioTrack === undefined ? initialAudioTrack(s.asset.info.audioTracks) : audioTrack;
    if (selected !== null && !s.asset.info.audioTracks.some(track => track.index === selected)) invalid('所选音轨不存在。');
    if (!this.nativeOptions) throw new AppFailure('ENGINE_NOT_READY', '原生预览引擎尚未配置。');
    if (s.native?.usable && (s.native.media.frames.mode === 'strict' || !forceStrict && s.preparedAudio === selected)) return s.native.ready;
    if (s.preparing && s.preparingAudio === selected && s.preparingStrict === forceStrict) return s.preparing;
    if (s.primary.busy) throw new AppFailure('JOB_BUSY', '请先完成当前媒体操作。');
    const hooks = this.nativeOptions;
    const result = s.preparation.run(async signal => {
      await this.nativeReleaseBarrier; signal.throwIfAborted();
      // Changing the selected track is a new readiness gate, not a silent playback downgrade.
      // Drain background readers and stop WASAPI before releasing the old helper/resources.
      await s.background.cancel(); signal.throwIfAborted();
      if (s.native) {
        const previous = s.native; s.native = undefined;
        try {
          await previous.dispose();
          for (const path of previous.media.ownedPaths) await unlinkCreatedFile(path);
        } catch (error) { s.cleanupFailed = true; throw error; }
      }
      await hooks.verify?.(); signal.throwIfAborted();
      let prepared: PreparedMedia;
      try {
        if (hooks.forceStrict || forceStrict) throw new AppFailure('QUICK_UNSUPPORTED', '测试/重试要求精确整片准备。');
        // Quick on-demand open: bounded startup verification only. Ready means playable with
        // sound; exact per-frame identity resolves on demand, never via a hidden whole-file scan.
        prepared = await prepareQuickMedia({ source: s.source, info: s.asset.info, probe: s.probe, directory: s.directory,
          helper: hooks.helper, ffmpeg: this.engines.ffmpeg, signal, audioTrack: selected,
          onProgress: progress => hooks.status({ assetId: id, epoch: 0, state: 'preparing', ...progress }) });
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof AppFailure) || error.code !== 'QUICK_UNSUPPORTED') throw error;
        // Explicit fallback for materials that cannot be handled on demand; show the reason.
        hooks.status({ assetId: id, epoch: 0, state: 'preparing', stage: 'compatibility', reason: error.message });
        prepared = await prepareNativeMedia({ source: s.source, info: s.asset.info, probe: s.probe, directory: s.directory,
          helper: hooks.helper, ffmpeg: this.engines.ffmpeg, ffprobe: this.engines.ffprobe, signal, hdrConsent,
          onProgress: progress => hooks.status({ assetId: id, epoch: 0, state: 'preparing', ...progress, reason: error.message }) });
        prepared.warnings.unshift(`快速预览不适用于此素材，已采用精确整片准备：${error.message}`);
      }
      // Transfer ownership without an asynchronous gap after successful preparation.
      s.native = new NativeTimeline(id, s.source, prepared, hooks); s.preparedAudio = selected;
      hooks.status({ assetId: id, epoch: 0, state: 'ready' });
      return s.native.ready;
    }).catch(error => {
      if (error instanceof AppFailure && ['NATIVE_TIMEOUT', 'TEMP_CLEANUP'].includes(error.code)) s.cleanupFailed = true;
      throw error;
    });
    s.preparing = result; s.preparingAudio = selected; s.preparingStrict = forceStrict;
    const clear = () => { if (s.preparing === result) s.preparing = undefined; };
    void result.then(clear, clear); return result;
  }
  async nativeControl(request: PreviewControl): Promise<void> {
    const s = this.require(request.assetId, false, request.action === 'pause');
    if (!s.native) throw new AppFailure('ENGINE_NOT_READY', '视频还没有完成原生预览准备。');
    if (s.primary.busy && request.action !== 'pause') throw new AppFailure('JOB_BUSY', '请先完成当前媒体操作。');
    await s.native.control(request);
  }
  nativeAcknowledge(request: PreviewAck): void {
    const s = this.current;
    if (this.closed || !s || s.asset.id !== request.assetId || !s.native) throw new AppFailure('CANCELLED', '预览会话已关闭。');
    s.native.acknowledge(request);
  }
  async nativeCover(id: string, frameId: number, epoch?: number, ref?: ClipReference): Promise<CoverAsset> {
    const s = this.require(id), c = this.clip(s, ref);
    if (!s.native) throw new AppFailure('ENGINE_NOT_READY', '原生预览尚未就绪。');
    // Freeze the acknowledged identity on receipt, before pause/repaint or async file work.
    const frame = s.native.capture(frameId, epoch);
    return this.work(s, s.primary, async (signal, files) => {
      this.clip(s, ref);
      // Exact source identity is resolved on demand; an unverifiable frame never becomes a cover.
      const identity = await s.native!.media.frames.resolveIdentity(s.native!.media.native,
        { timeUs: frame.timeUs, nativeHns: frame.nativeHns, identity: frame.pts === null ? null : { pts: frame.pts, sourceFrame: frame.sourceFrame } }, signal);
      const path = join(s.directory, `cover-${randomUUID()}.jpg`);
      const handle = await open(path, 'wx'); files.adopt(path); await handle.close();
      await sharp(frame.pixels, { raw: { width: frame.width, height: frame.height, channels: 4 } }).removeAlpha().jpeg({ quality: 90 }).toFile(path);
      signal.throwIfAborted(); const file = await files.publish(path, 'image/jpeg', true);
      const cover: CoverAsset = { id: file.id, name: '视频帧封面（预览）', url: file.url, width: s.asset.info.displayWidth,
        height: s.asset.info.displayHeight, kind: 'frame', timeUs: frame.timeUs };
      const previous = c.cover; c.cover = { file, cover, framePts: identity.pts };
      if (previous) await this.retire(s, previous.file);
      return cover;
    });
  }

  async thumbnails(id: string, startUs: number, endUs: number, count: number, hdrConsent: boolean): Promise<Thumbnail[]> {
    const s = this.require(id); time(startUs, s.asset.info.durationUs); time(endUs, s.asset.info.durationUs); this.allowHDR(s, hdrConsent);
    if (endUs <= startUs || !Number.isInteger(count) || count < 1 || count > 12) invalid();
    if (!s.native) throw new AppFailure('ENGINE_NOT_READY', '视频还没有完成原生预览准备。');
    const prepared = s.native.media;
    return this.work(s, s.background, async (signal, files) => {
      const output: Thumbnail[] = [];
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        const at = Math.round(startUs + (endUs - startUs) * (index + 0.5) / count);
        let cached = s.thumbs.get(at);
        if (!cached) {
          const path = join(s.directory, `thumb-${randomUUID()}.jpg`);
          {
            for (;;) {
              signal.throwIfAborted();
              try {
                // Individual background cancellation must never kill the shared editing helper.
                const frame = await prepared.frames.thumbnail(prepared.native, at);
                signal.throwIfAborted();
                const handle = await open(path, 'wx'); files.adopt(path); await handle.close();
                await sharp(frame.pixels, { raw: { width: frame.width, height: frame.height, channels: 4 } })
                  .removeAlpha().jpeg({ quality: 80 }).toFile(path);
                break;
              } catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof AppFailure) || !['CANCELLED', 'NATIVE_BUSY'].includes(error.code)) throw error;
                await delay(100, undefined, { signal });
              }
            }
          }
          files.adopt(path); signal.throwIfAborted();
          const file = await files.publish(path, 'image/jpeg', true);
          cached = { file, thumbnail: { timeUs: at, url: file.url } };
        }
        s.thumbs.delete(at); s.thumbs.set(at, cached);
        output.push(cached.thumbnail);
        while (s.thumbs.size > 64) {
          const key = s.thumbs.keys().next().value!; const item = s.thumbs.get(key)!;
          s.thumbs.delete(key); await this.retire(s, item.file);
        }
      }
      return output;
    });
  }

  async uploadCover(id: string, path: string, ref?: ClipReference): Promise<CoverAsset> {
    const s = this.require(id), c = this.clip(s, ref);
    return this.work(s, s.primary, async (signal, files) => {
      this.clip(s, ref);
      const source = await openSource(path);
      if (isPublicationWorkspace(source.path) || await isManagedPath(source.path, [this.temp.root, ...(this.publications ? [this.publications.root] : []), ...this.additionalManagedRoots]))
        invalid('不能从应用临时工作区选择封面，请使用原始图片或“使用当前帧”。');
      const input = await open(source.path, 'r');
      const header = Buffer.alloc(8);
      try { await input.read(header, 0, 8, 0); } finally { await input.close(); }
      const mime: MediaMime | null = header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : header[0] === 255 && header[1] === 216 && header[2] === 255 ? 'image/jpeg' : null;
      if (!mime) invalid('封面只支持实际的 JPG/PNG 图片，不能仅修改文件扩展名。');
      const probe = await probeMedia(source.path, { executable: this.engines.ffprobe, signal });
      const stream = probe.streams.find(item => item.codec_type === 'video');
      if (!stream?.width || !stream.height || !['png', 'mjpeg'].includes(stream.codec_name)) invalid('无法读取封面图片。');
      const rotation = stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? 0;
      const swap = Math.abs(rotation % 180) === 90;
      await assertSource(source); signal.throwIfAborted();
      const file = await files.publish(source.path, mime, false, source);
      const cover: CoverAsset = { id: file.id, name: basename(path), url: file.url,
        width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height, kind: 'custom', timeUs: null };
      const previous = c.cover; c.cover = { file, cover, source };
      if (previous) await this.retire(s, previous.file);
      return cover;
    });
  }

  async analyze(id: string, options: ExportOptions, ref?: ClipReference): Promise<ExportInspection> {
    const s = this.require(id), c = this.clip(s, ref);
    if (ref && (JSON.stringify(options.clip) !== JSON.stringify(c.model.selection)
      || options.processing.mode === 'encode' && JSON.stringify(options.processing.crop) !== JSON.stringify(c.model.crop))) invalid('片段设置已变化，请同步后重试。');
    return this.work(s, s.primary, async signal => {
      this.clip(s, ref);
      c.analysis = undefined;
      const analysis = await analyzeExport(s.source, options, this.engines, signal);
      signal.throwIfAborted(); c.analysis = analysis;
      return structuredClone(analysis.public);
    });
  }

  async renderDraft(id: string, analysisId: string, image: DraftOptions, ref?: ClipReference): Promise<ExportDraft> {
    const s = this.require(id), c = this.clip(s, ref); const analysis = c.analysis;
    if (ref && (image.fit !== c.model.coverFit || image.background !== c.model.background)) invalid('片段封面设置已变化。');
    if (!analysis || analysis.public.id !== analysisId || !analysis.public.supported) invalid('分析已过期，请重新分析当前设置。');
    return this.work(s, s.primary, async (signal, files) => {
      await s.background.cancel(); signal.throwIfAborted();
      this.clip(s, ref);
      if (s.cleanupFailed) throw new AppFailure('TEMP_CLEANUP', '缓存清理未完成，请关闭素材后再生成输出。');
      // Keep at most one heavy single-clip draft for this source, while covers remain independent.
      for (const other of s.clips.values()) await this.releaseDraft(s, other);
      signal.throwIfAborted();
      const selected = c.cover;
      const rendered = await renderExportDraft({ source: s.source, analysis, directory: s.directory, image, engines: this.engines, signal,
        cover: selected?.source ? { kind: 'custom', source: selected.source } : selected?.framePts ? { kind: 'frame', pts: selected.framePts } : undefined,
        onStage: (stage, timeUs) => this.exportProgress({ assetId: id, analysisId, stage, ...(timeUs === undefined ? {} : { timeUs }) }) });
      files.adopt(rendered.video.path); files.adopt(rendered.cover.path);
      const published: Stored[] = [];
      try {
        const video = await files.publish(rendered.video.path, 'video/mp4', true); published.push(video);
        const cover = await files.publish(rendered.cover.path, 'image/jpeg', true, selected?.source); published.push(cover);
        const draft: ExportDraft = { id: randomUUID(), assetId: id, analysisId, videoUrl: video.url, coverUrl: cover.url, ...rendered.report };
        const previous = c.draft; c.draft = { video, image: cover, public: draft, videoSource: rendered.video, imageSource: rendered.cover,
          selectedCoverId: selected?.cover.id ?? null, customSource: selected?.source };
        if (previous) { await this.retire(s, previous.video); await this.retire(s, previous.image); }
        return structuredClone(draft);
      } catch (error) {
        if (c.draft?.video !== published[0]) for (const file of published) await this.retire(s, file);
        throw error;
      }
    });
  }

  assertDraft(id: string, draftId: string, ref?: ClipReference): void {
    const s = this.require(id), c = this.clip(s, ref);
    if (!this.publications) throw new AppFailure('OUTPUT_ACCESS', '安全保存目录尚未就绪。');
    if (s.saving) throw new AppFailure('JOB_BUSY', '正在保存实况照片，请等待完成或取消。');
    if (!c.draft || c.draft.public.id !== draftId || c.analysis?.public.id !== c.draft.public.analysisId
      || (c.cover?.cover.id ?? null) !== c.draft.selectedCoverId) invalid('草稿已过期，请重新生成输出预览。');
  }

  async saveDraft(id: string, draftId: string, saveId: string, output: string, ref?: ClipReference): Promise<SavedMotion> {
    this.assertDraft(id, draftId, ref); const s = this.require(id), c = this.clip(s, ref); const draft = c.draft!;
    if (!this.publications) throw new AppFailure('OUTPUT_ACCESS', '安全保存目录尚未就绪。');
    if (s.receipts.has(saveId)) invalid('该保存请求已完成，请使用新的保存请求。');
    const saving = { id: saveId }; s.saving = saving;
    const remember = (saved: SavedMotion) => {
      s.receipts.set(saveId, saved);
      while (s.receipts.size > 2) s.receipts.delete(s.receipts.keys().next().value!);
    };
    try {
      return await this.work(s, s.primary, async signal => {
        await s.background.cancel(); signal.throwIfAborted();
        if (s.cleanupFailed) throw new AppFailure('TEMP_CLEANUP', '缓存清理未完成，保存未开始，请关闭素材后重试。');
        const saved = await publishMotionPhoto({ cover: draft.imageSource, video: draft.videoSource,
          sources: [s.source, ...(draft.customSource ? [draft.customSource] : [])], output,
          timestampUs: draft.public.coverTimestampUs, videoDurationUs: draft.public.durationUs, journal: this.publications!, signal,
          forbiddenRoots: [this.temp.root, ...this.additionalManagedRoots],
          onCommitted: remember,
          onStage: (stage, writtenBytes, totalBytes) => this.exportProgress({ assetId: id, analysisId: draft.public.analysisId, saveId, stage,
            ...(writtenBytes === undefined ? {} : { writtenBytes, totalBytes }) }) });
        remember(saved); return structuredClone(saved);
      });
    } finally { if (s.saving === saving) s.saving = undefined; }
  }

  async exportAll(id: string, input: BatchSnapshot, chooseDirectory: () => Promise<string | null>): Promise<BatchResult> {
    const s = this.require(id);
    if (!this.publications) throw new AppFailure('OUTPUT_ACCESS', '安全发布目录尚未就绪。');
    const snapshot = parseBatchSnapshot(input, id);
    if (s.batchResults.has(snapshot.batchId)) invalid('此批次已完成，请使用新的批次编号。');
    // One shared export pipeline accepts the current clip or an ordered subset.
    // Every requested identity/revision is still verified before freezing the session.
    const selected = new Set(snapshot.clips.map(item => item.clipId));
    const models = [...s.clips.values()].filter(item => selected.has(item.model.id)).sort((a, b) => a.model.number - b.model.number);
    if (models.length !== snapshot.clips.length) invalid('导出片段列表已变化。');
    const jobs: BatchClipJob[] = snapshot.clips.map((requested, index) => {
      const c = this.clip(s, requested), model = c.model;
      if (models[index] !== c || JSON.stringify(model.selection) !== JSON.stringify(requested.selection)
        || JSON.stringify(model.crop) !== JSON.stringify(requested.crop) || model.coverFit !== requested.coverFit || model.background !== requested.background)
        invalid('批次片段设置已变化，请重新确认。');
      let cover: BatchClipJob['cover'] = { kind: 'auto' };
      if (requested.cover.kind === 'auto') {
        if (c.cover) invalid('自动封面设置尚未同步。');
      } else {
        if (!c.cover || c.cover.cover.id !== requested.cover.coverId || c.cover.cover.kind !== requested.cover.kind) invalid('批次封面已过期。');
        if (c.cover.source) cover = { kind: 'custom', source: { ...c.cover.source } };
        else if (c.cover.framePts) cover = { kind: 'frame', pts: c.cover.framePts };
        else invalid('批次封面没有精确源帧身份。');
      }
      return { clipId: model.id, index: index + 1, number: model.number, selection: { ...model.selection }, crop: { ...model.crop },
        coverFit: model.coverFit, background: model.background, cover };
    });
    const batch: NonNullable<Session['batch']> = { id: snapshot.batchId, controller: new AbortController(), result: emptyBatchResult(snapshot.batchId, jobs) };
    s.batch = batch; // lock BEFORE the trusted directory dialog, including direct IPC callers
    const signal = batch.controller.signal;
    batch.done = (async () => {
      await s.metadata.cancel(); await s.primary.cancel(); await s.background.cancel(); await s.preparation.cancel(); signal.throwIfAborted();
      if (s.cleanupFailed) throw new AppFailure('TEMP_CLEANUP', '此前缓存清理失败，批次未开始。');
      if (s.native?.usable) await s.native.suspend();
      for (const c of s.clips.values()) await this.releaseDraft(s, c);
      signal.throwIfAborted(); await assertSource(s.source); signal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AppFailure('CANCELLED', '批次已取消。'));
        signal.addEventListener('abort', abort, { once: true });
      });
      let directory: string | null;
      try { directory = await Promise.race([chooseDirectory(), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
      if (!directory) { batch.result.canceled = true; return batch.result; }
      return await runBatchExport({ source: s.source, engines: this.engines, workDirectory: s.directory, outputDirectory: directory,
        baseName: s.asset.name, batchId: batch.id, jobs, mode: snapshot.mode, settings: snapshot.settings,
        audio: snapshot.audio, hdrConsent: snapshot.hdrConsent, journal: this.publications!,
        forbiddenRoots: [this.temp.root, ...this.additionalManagedRoots], signal, result: batch.result,
        onProgress: progress => this.exportProgress({ assetId: id, analysisId: progress.analysisId, stage: progress.stage,
          timeUs: progress.timeUs, writtenBytes: progress.writtenBytes, totalBytes: progress.totalBytes,
          batch: { batchId: batch.id, clipId: progress.job.clipId, index: progress.job.index, total: jobs.length,
            clipName: '片段 ' + progress.job.number } }) });
    })().catch(error => {
      const failure = batchFailure(error);
      if (failure.code === 'TEMP_CLEANUP') batch.result.cleanupFailed = true;
      if (signal.aborted && !batch.result.cleanupFailed) batch.result.canceled = true;
      else { batch.result.stopped = true; batch.result.stopReason = failure.message; }
      return batch.result;
    }).finally(() => {
      if (batch.result.cleanupFailed) s.cleanupFailed = true;
      s.batchResults.set(batch.id, structuredClone(batch.result));
      while (s.batchResults.size > 2) s.batchResults.delete(s.batchResults.keys().next().value!);
      if (s.batch === batch) s.batch = undefined;
    });
    return structuredClone(await batch.done);
  }

  async cancelImport(): Promise<void> { await this.imports.cancel(); await this.current?.preparation.cancel(); }
  async cancel(id: string, saveId?: string, batchId?: string): Promise<CancelResult> {
    const s = this.require(id, true, true);
    if (s.batch && (!batchId || s.batch.id === batchId)) {
      const batch = s.batch; batch.controller.abort(); await batch.done;
      return { saved: null, batch: structuredClone(batch.result) };
    }
    if (batchId) {
      const result = s.batchResults.get(batchId); if (!result) invalid('批次不存在或已过期。');
      return { saved: null, batch: structuredClone(result) };
    }
    await Promise.all([s.metadata.cancel(), s.primary.cancel(), s.background.cancel(), s.preparation.cancel()]);
    const saved = saveId ? s.receipts.get(saveId) : undefined;
    if (saved) {
      const result = structuredClone(saved);
      if (s.cleanupFailed) result.warnings.push('成品已保存，但应用缓存清理失败，请关闭素材后重试。');
      return { saved: result };
    }
    if (s.cleanupFailed) throw new AppFailure('TEMP_CLEANUP', '处理已停止，但临时文件未能清理，请关闭素材后重试。');
    return { saved: null };
  }
  async close(id: string): Promise<void> {
    await this.imports.cancel();
    const s = this.current;
    if (!s || s.asset.id !== id) throw new AppFailure('MEDIA_NOT_FOUND', '素材已关闭或已被替换。');
    if (s.batch) { s.batch.controller.abort(); await s.batch.done; }
    this.current = undefined;
    await s.preparation.close();
    const release = this.nativeReleaseBarrier.then(async () => {
      const results = await Promise.allSettled([s.metadata.close(), s.primary.close(), s.background.close(), s.native?.dispose()]);
      await this.resources.revokeAll(s.refs);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    this.nativeReleaseBarrier = release;
    await release;
    await this.removeDirectory(s.directory);
  }
  async shutdown(): Promise<void> {
    this.closed = true; await this.imports.close();
    if (this.current) await this.close(this.current.asset.id);
    await Promise.all(this.cleanups);
  }
}
