import { open, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaInfo } from '../../shared/media.ts';
import { AppFailure } from '../errors.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { buildFrameIndex, INDEX_RECORD_BYTES, type FrameIndex } from './frame-index.ts';
import { buildContainerFrameIndex } from './container-frame-index.ts';
import { NativePreview, type NativeVideoInfo } from './native-preview.ts';
import { assertSource, type SourceFile } from './source.ts';
import { streamProcessLines } from './lines.ts';
import { probeMedia } from './probe.ts';
import { sdrColorProcessing } from './video-processing.ts';
import { prepareNativeAudio, type PreparedAudioTrack } from './native-audio-import.ts';

const MiB = 1024 * 1024;
export type PreparedNativeMedia = {
  index: FrameIndex; resource: string; native: NativePreview; nativeInfo: NativeVideoInfo;
  ownedPaths: string[]; manifest: string; compatibility: boolean; warnings: string[]; bytes: number;
  audio: PreparedAudioTrack[];
};
export type ImportProgress = { stage: 'source-index' | 'native-index' | 'compatibility' | 'audio'; frames?: number; bytes?: number };
async function budget(directory: string, maximum: number, used = 0, reserve = 256 * MiB) {
  if (used > maximum) throw new AppFailure('PREVIEW_BUDGET', '编辑资源超过磁盘预算；未静默扩大缓存配额。');
  const disk = await statfs(directory, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(reserve)) throw new AppFailure('PREVIEW_DISK_FULL', '磁盘可用空间不足，已停止准备编辑资源。');
}

// Import-only API, not callable from renderer IPC. Caller passes a fresh owned session directory.
// A failed import drains native handles BEFORE deleting only paths created by this invocation.
export async function prepareNativeMedia(options: {
  source: SourceFile; info: MediaInfo; directory: string; helper: string; ffprobe: string; ffmpeg: string;
  signal: AbortSignal; hdrConsent?: boolean; maximumEdge?: number; maxBytes?: number; reserveBytes?: number;
  forceCompatibility?: boolean; onProgress?: (value: ImportProgress) => void;
}): Promise<PreparedNativeMedia> {
  const { source, info, signal, directory } = options;
  const maximum = options.maxBytes ?? 2 * 1024 * MiB;
  const reserve = options.reserveBytes ?? 256 * MiB;
  const edge = options.maximumEdge ?? 960;
  if (!Number.isSafeInteger(maximum) || maximum < MiB || maximum > 8 * 1024 * MiB
    || !Number.isSafeInteger(reserve) || reserve < 0 || !Number.isSafeInteger(edge) || edge < 64 || edge > 1280) throw new Error('Invalid import budget');
  if (info.hdr && !options.hdrConsent) throw new AppFailure('HDR_CONFIRM_REQUIRED', 'HDR 素材需要同意 SDR 预览后才能准备编辑资源。');
  await assertSource(source); signal.throwIfAborted(); await budget(directory, maximum, 0, reserve);
  const paths: string[] = []; const warnings: string[] = [];
  const createOwnedFile = async (path: string, text: string) => {
    const file = await open(path, 'wx'); paths.push(path);
    try { await file.writeFile(text); } finally { await file.close(); }
  };
  const indexPath = join(directory, `frame-index-${randomUUID()}.bin`);
  let index: FrameIndex | undefined; let native: NativePreview | undefined; let success = false;
  try {
    const probe = await probeMedia(source.path, { executable: options.ffprobe, signal });
    const stream = probe.streams.find(stream => stream.index === info.videoIndex);
    if (!stream) throw new AppFailure('SOURCE_CHANGED', '视频轨道不存在。');
    const matrix = stream.color_space;
    const directColor = { matrix709: matrix === 'bt709', fullRange: stream.color_range === 'pc' || Boolean(stream.pix_fmt?.startsWith('yuvj')) };
    if (!matrix || ['unknown', 'unspecified'].includes(matrix)) warnings.push('原片未标记色彩矩阵；直接预览按 BT.601 处理，请人工核对。');
    const colorNeedsPreparation = Boolean(matrix && !['bt709', 'bt470bg', 'smpte170m', 'unknown', 'unspecified'].includes(matrix));
    const ambiguousVideoOrder = probe.streams.filter(stream => stream.codec_type === 'video').length > 1;
    if (ambiguousVideoOrder) warnings.push('多个视频流的 MF/容器编号未核对；导入时明确隔离所选源视频轨。');
    let compatibility = Boolean(options.forceCompatibility || ambiguousVideoOrder || colorNeedsPreparation || info.hdr || info.rotation || info.sampleAspectRatio.numerator !== info.sampleAspectRatio.denominator);
    let retiredIndexBytes = 0;
    const indexProgress = async (frames: number) => {
      await budget(directory, maximum, retiredIndexBytes + frames * INDEX_RECORD_BYTES, reserve);
      options.onProgress?.({ stage: 'source-index', frames });
    };
    const decodedIndex = (output: string) => buildFrameIndex({ source, info, output, executable: options.ffprobe, signal,
      maxBytes: Math.min(maximum - retiredIndexBytes, 256 * MiB), onProgress: indexProgress });
    if (!compatibility) index = await buildContainerFrameIndex({ source, info, trackId: stream.id, output: indexPath, signal,
      maxBytes: Math.min(maximum, 256 * MiB), onProgress: indexProgress });
    index ??= await decodedIndex(indexPath);
    paths.push(indexPath); await budget(directory, maximum, index.byteSize, reserve);
    const useDecodedIndex = async () => {
      if (!index?.containerCandidate) return;
      await index.close(); retiredIndexBytes += index.byteSize; index = undefined;
      const replacement = join(directory, `frame-index-${randomUUID()}.bin`);
      index = await decodedIndex(replacement); paths.push(replacement);
      warnings.push('容器候选未满足原生核验条件，已在准备阶段回退到逐帧索引。');
    };
    native = new NativePreview(options.helper); await native.hello(signal);
    let nativeInfo: NativeVideoInfo | undefined;
    let resource = source.path;
    if (!compatibility) {
      try {
        nativeInfo = await native.open(source.path, edge, signal, directColor);
        if (nativeInfo.sourceWidth !== info.displayWidth || nativeInfo.sourceHeight !== info.displayHeight) throw new AppFailure('FRAME_INDEX', '原生可见尺寸与原片显示尺寸不同。');
        try {
          await index.mapNative(native, signal, frames => options.onProgress?.({ stage: 'native-index', frames }));
        } catch (error) {
          signal.throwIfAborted();
          if (!index.containerCandidate || !(error instanceof AppFailure) || error.code !== 'FRAME_INDEX') throw error;
          await useDecodedIndex();
          await index.mapNative(native, signal, frames => options.onProgress?.({ stage: 'native-index', frames }));
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!index || !(error instanceof AppFailure) || !['NATIVE_MEDIA', 'FRAME_INDEX'].includes(error.code)) throw error;
        compatibility = true; warnings.push(`原生源格式/时间映射需要整片兼容准备：${error.message}`);
        await native.close();
      }
    }
    if (compatibility) {
      signal.throwIfAborted(); await useDecodedIndex();
      const color = sdrColorProcessing(info, stream, options.hdrConsent === true); warnings.push(...color.warnings);
      const ratio = Math.min(1, edge / Math.max(info.displayWidth, info.displayHeight));
      const width = Math.max(2, Math.floor(info.displayWidth * ratio / 2) * 2);
      const height = Math.max(2, Math.floor(info.displayHeight * ratio / 2) * 2);
      resource = join(directory, `editing-${randomUUID()}.mp4`);
      await createOwnedFile(resource, '');
      // No FPS filter: preserve every presentation frame and all variable intervals.
      // Encoded timescale is the source rational's denominator, not a guessed average FPS.
      if (info.timeBase.denominator > 2_147_483_647) throw new AppFailure('FRAME_INDEX', '源时间基超出兼容容器范围。');
      const filter = [...color.filters, `scale=${width}:${height}:flags=bilinear`, 'setsar=1', 'format=yuv420p',
        'sidedata=mode=delete', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', 'setpts=PTS-STARTPTS'].join(',');
      await streamProcessLines(options.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
        '-i', source.path, '-map', `0:${info.videoIndex}`, '-an', '-sn', '-dn', '-vf', filter,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', '15', '-bf', '0', '-sc_threshold', '0',
        '-fps_mode', 'passthrough', '-enc_time_base', `${info.timeBase.numerator}:${info.timeBase.denominator}`,
        '-video_track_timescale', String(info.timeBase.denominator), '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', resource], async line => {
        const match = /^total_size=(\d+)$/.exec(line);
        if (match) { const bytes = Number(match[1]); await budget(directory, maximum, retiredIndexBytes + index!.byteSize + bytes, reserve); options.onProgress?.({ stage: 'compatibility', bytes }); }
      }, { signal, timeoutMs: 0 });
      await budget(directory, maximum, retiredIndexBytes + index.byteSize + (await stat(resource)).size, reserve);
      await assertSource(source); signal.throwIfAborted();
      nativeInfo = await native.open(resource, edge, signal, { matrix709: true, fullRange: false });
      await index.mapNative(native, signal, frames => options.onProgress?.({ stage: 'native-index', frames }));
      warnings.push('预览使用整片低分辨率编辑资源；源 PTS/帧身份保留，最终封面和视频仍从原片重解码。');
    }
    if (!nativeInfo || !index.mappingReady) throw new Error('Incomplete native import');
    const videoBytes = (await Promise.all(paths.map(async path => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
    const audio = await prepareNativeAudio({ source, info, streams: probe.streams, directory, native,
      ffmpeg: options.ffmpeg, ffprobe: options.ffprobe, signal, createOwnedFile, forceCompatibility: options.forceCompatibility,
      checkBudget: additional => budget(directory, maximum, videoBytes + additional, reserve),
      onProgress: frames => options.onProgress?.({ stage: 'audio', frames }) });
    warnings.push(...audio.warnings);
    const manifest = join(directory, `editing-manifest-${randomUUID()}.json`);
    const record = { version: 1, source: { path: source.path, size: source.size, stamp: source.stamp },
      index: { path: index.path, count: index.count, recordBytes: INDEX_RECORD_BYTES, timeBase: info.timeBase, startPts: info.startPts,
        source: index.containerCandidate ? 'container-native-verified' : 'decoded-frames' },
      resource, compatibility, nativeInfo, audio: audio.tracks, warnings };
    await createOwnedFile(manifest, JSON.stringify(record, null, 2));
    const bytes = (await Promise.all(paths.map(async path => (await stat(path)).size))).reduce((sum, size) => sum + size, 0);
    await budget(directory, maximum, bytes, reserve); await assertSource(source); signal.throwIfAborted();
    success = true;
    return { index, resource, native, nativeInfo, ownedPaths: paths, manifest, compatibility, warnings, bytes, audio: audio.tracks };
  } finally {
    if (!success) {
      // If native termination cannot be confirmed, do NOT delete evidence or its open media.
      try { await native?.shutdown(); } finally { await index?.close(); }
      for (const path of [...paths].reverse()) await unlinkCreatedFile(path);
    }
  }
}
