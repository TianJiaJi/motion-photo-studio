import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExportInspection, ExportOptions, DraftOptions, ExportDraft } from '../../shared/export.ts';
import { ptsToUs, validateClip } from '../../shared/editor.ts';
import { SOURCE_MATCH_EDITS } from '../../shared/processing.ts';
import { AppFailure } from '../errors.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import type { EnginePaths } from './engine.ts';
import { assertSource, type SourceFile } from './source.ts';
import { mediaInfo } from './info.ts';
import { probeMedia } from './probe.ts';
import { assessCopySupport, probeCopySource } from './copy-support.ts';
import { planCopyRange, type CopyRangePlan } from './copy-plan.ts';
import { planEncodeRange, type EncodeRangePlan } from './encode-plan.ts';
import { exportCopyMedia } from './copy-export.ts';
import { exportEncodedMedia } from './encode-export.ts';
import { videoProcessing } from './video-processing.ts';
import { prepareFrameCover } from './frame-cover.ts';
import { createJpegCover } from './image-cover.ts';
import { parseExportOptions, parseDraftOptions } from './export-requests.ts';

export type ExportAnalysis = { public: ExportInspection; sourceStamp: string; options: ExportOptions;
  plan: { kind: 'copy'; value: CopyRangePlan } | { kind: 'encode'; value: EncodeRangePlan } | null };
export type DraftCover = { kind: 'custom'; source: SourceFile } | { kind: 'frame'; pts: string };
export async function analyzeExport(source: SourceFile, request: ExportOptions, engines: EnginePaths, signal: AbortSignal): Promise<ExportAnalysis> {
  const options = parseExportOptions(request); await assertSource(source); signal.throwIfAborted();
  const probe = await probeMedia(source.path, { executable: engines.ffprobe, signal }); const info = mediaInfo(probe);
  validateClip(options.clip, info.durationUs);
  const audioIndex = options.audio.kind === 'track' ? options.audio.index : null;
  if (audioIndex !== null && !probe.streams.some(s => s.index === audioIndex && s.codec_type === 'audio'))
    throw new AppFailure('INVALID_REQUEST', '所选音轨已失效，请重新选择。');
  const result: ExportInspection = { id: randomUUID(), mode: options.processing.mode, supported: false, requested: { ...options.clip },
    actual: null, width: info.displayWidth, height: info.displayHeight, reasons: [], warnings: [] };
  let plan: ExportAnalysis['plan'] = null;
  if (options.processing.mode === 'copy') {
    const support = assessCopySupport(await probeCopySource(source, engines.ffprobe, signal), options.audio.kind === 'track');
    result.warnings = support.warnings;
    if (!support.supported) result.reasons = support.reasons;
    else {
      if (support.audio && options.audio.kind === 'track' && support.audio.index !== options.audio.index) throw new AppFailure('INVALID_REQUEST', '原画模式不会默默更换音轨。');
      const copy = await planCopyRange(source, support.video, options.clip, { executable: engines.ffprobe, signal });
      plan = { kind: 'copy', value: copy }; result.actual = { ...copy.actual }; result.supported = true;
    }
  } else {
    if (probe.streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic).length !== 1) result.reasons.push('多个主视频轨尚需明确选择，不能静默丢弃。');
    const track = options.audio.kind === 'track' ? probe.streams.find(s => s.index === audioIndex)! : undefined;
    if (track && (!track.channels || options.processing.mode !== 'source' && track.channels > 2 && options.audio.kind === 'track' && !options.audio.downmixStereo)) result.reasons.push('多声道转为立体声需要明确同意，或明确选择不保留音轨。');
    if (!result.reasons.length) {
      const edits = options.processing.mode === 'source' ? SOURCE_MATCH_EDITS : options.processing;
      const processing = videoProcessing(info, probe.streams.find(s => s.index === info.videoIndex)!, edits, options.hdrConsent);
      if (options.processing.mode === 'source') result.warnings.push('原画质预设跟随原片尺寸/帧时序，高保真转码不等于数学无损。');
      result.width = processing.geometry.width; result.height = processing.geometry.height; result.warnings.push(...processing.warnings);
      const encoded = await planEncodeRange(source, probe, options.clip, { executable: engines.ffmpeg, signal });
      plan = { kind: 'encode', value: encoded }; result.actual = { ...encoded.actual }; result.supported = true;
    }
  }
  await assertSource(source); signal.throwIfAborted();
  return { public: result, sourceStamp: source.stamp, options, plan };
}

// No external final path: these remain private video/JPEG drafts until M4 container validation/publication.
export async function renderExportDraft(options: {
  source: SourceFile; analysis: ExportAnalysis; cover?: DraftCover; image: DraftOptions;
  directory: string; engines: EnginePaths; signal: AbortSignal;
  onStage?: (stage: string, timeUs?: number) => void | Promise<void>;
}): Promise<{ video: SourceFile; cover: SourceFile; report: Omit<ExportDraft, 'id' | 'assetId' | 'analysisId' | 'videoUrl' | 'coverUrl'> }> {
  const { source, analysis, engines, signal } = options; const image = parseDraftOptions(options.image);
  if (!analysis.public.supported || !analysis.plan || analysis.sourceStamp !== source.stamp) throw new AppFailure('INVALID_REQUEST', '请先完成当前设置的导出分析。');
  await assertSource(source); if (options.cover?.kind === 'custom') await assertSource(options.cover.source); signal.throwIfAborted();
  const owned = new Set<string>(); let succeeded = false;
  const videoPath = join(options.directory, `draft-${randomUUID()}.mp4`); const jpegPath = join(options.directory, `cover-${randomUUID()}.jpg`);
  const selectedPts = options.cover?.kind === 'frame' ? options.cover.pts : options.cover?.kind === 'custom' ? undefined : analysis.plan.value.startPts;
  try {
    let video: SourceFile; let durationUs: number; let timestamp = -1; let proof: ExportDraft['proof']; let warnings: string[];
    if (analysis.plan.kind === 'copy') {
      const result = await exportCopyMedia({ source, plan: analysis.plan.value, output: videoPath, keepAudio: analysis.options.audio.kind === 'track', engines, signal,
        onStage: stage => options.onStage?.(stage) });
      video = result.file; owned.add(video.path); durationUs = result.report.videoDurationUs; warnings = result.report.warnings;
      proof = { kind: 'copy', videoPackets: result.report.videoPackets, videoPayloadSha256: result.report.payloadDigest,
        videoTimingSha256: result.report.timingDigest, audioPackets: result.report.audio?.packets ?? 0, audioTailUs: result.report.audio?.tailBeyondVideoUs ?? 0 };
      if (selectedPts !== undefined && BigInt(selectedPts) >= BigInt(analysis.plan.value.startPts) && BigInt(selectedPts) < BigInt(analysis.plan.value.endPts))
        timestamp = ptsToUs(selectedPts, analysis.plan.value.startPts, analysis.plan.value.timeBase);
    } else {
      if (analysis.options.processing.mode === 'copy') throw new Error('Export mode mismatch');
      const sourceMatched = analysis.options.processing.mode === 'source';
      const result = await exportEncodedMedia({ source, clip: analysis.options.clip, edits: analysis.options.processing.mode === 'source' ? SOURCE_MATCH_EDITS : analysis.options.processing,
        matchSourceParameters: sourceMatched, hdrConsent: analysis.options.hdrConsent, audio: analysis.options.audio, coverSourcePts: selectedPts,
        output: videoPath, engines, signal, onStage: stage => options.onStage?.(stage), onProgress: (stage, timeUs) => options.onStage?.(stage, timeUs) });
      video = result.file; owned.add(video.path); durationUs = result.report.videoDurationUs; timestamp = result.report.coverTimestampUs;
      proof = { kind: 'encode', sourceMatched, audioCodec: result.report.audio?.codec, audioSampleRate: result.report.audio?.sampleRate, audioChannels: result.report.audio?.channels }; warnings = result.report.warnings;
      if (result.report.plan.startPts !== analysis.plan.value.startPts || result.report.plan.endPts !== analysis.plan.value.endPts) throw new Error('分析与导出的实际剪点不一致。');
    }
    await options.onStage?.('cover');
    let still: SourceFile;
    if (options.cover?.kind === 'custom') still = options.cover.source;
    else {
      const intermediate = await prepareFrameCover({ source, pts: selectedPts!, processing: analysis.options.processing,
        hdrConsent: analysis.options.hdrConsent, output: join(options.directory, `frame-${randomUUID()}.png`), engines, signal });
      still = intermediate.file; owned.add(still.path); warnings.push(...intermediate.warnings);
    }
    const jpeg = await createJpegCover({ source: still, output: jpegPath, width: analysis.public.width, height: analysis.public.height,
      fit: image.fit, background: image.background, signal, onStage: stage => options.onStage?.(stage) });
    owned.add(jpeg.file.path); warnings.push(...jpeg.report.warnings, 'JPEG 封面已重新编码；原画直出的不重编码承诺不包含静态封面。');
    if (options.cover?.kind === 'custom') { timestamp = -1; await assertSource(options.cover.source); }
    await assertSource(source); await assertSource(video); await assertSource(jpeg.file); signal.throwIfAborted();
    // Intermediate PNG cleanup must succeed before a draft can be considered ready.
    for (const path of owned) if (path !== video.path && path !== jpeg.file.path) { await unlinkCreatedFile(path); owned.delete(path); }
    succeeded = true;
    return { video, cover: jpeg.file, report: { durationUs, width: analysis.public.width, height: analysis.public.height,
      coverTimestampUs: timestamp, proof, warnings: [...new Set([...analysis.public.warnings, ...warnings])] } };
  } finally {
    if (!succeeded) {
      let failure: unknown;
      for (const path of owned) try { await unlinkCreatedFile(path); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    }
  }
}
