import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ptsToUs, usToSeconds } from '../../shared/editor.ts';
import type { ProcessingEdits } from '../../shared/processing.ts';
import type { AudioSelection } from '../../shared/export.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import type { EnginePaths } from './engine.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import { probeMedia } from './probe.ts';
import { mediaInfo } from './info.ts';
import { planEncodeRange, type EncodeRangePlan } from './encode-plan.ts';
import { MOTION_VIDEO_TRANSFER, videoProcessing } from './video-processing.ts';
import { streamProcessLines } from './lines.ts';
import { encodeAudioDraft, validateEncodedAudio } from './encode-audio.ts';

export type EncodeAudio = AudioSelection;
export type EncodeStage = 'plan' | 'audio' | 'video' | 'verify' | 'decode';
export type EncodeReport = {
  mode: 'encode'; plan: EncodeRangePlan; width: number; height: number; videoDurationUs: number;
  audio: null | { channels: number; sampleRate: number; durationUs: number; codec?: string };
  coverTimestampUs: number; warnings: string[];
};
// Only application-owned private drafts. Audio is explicitly selected/omitted, never inferred from a missing map.
export async function exportEncodedMedia(options: {
  source: SourceFile; clip: { startUs: number; endUs: number }; edits: ProcessingEdits; hdrConsent: boolean;
  audio: EncodeAudio; matchSourceParameters?: boolean; coverSourcePts?: string; output: string; engines: EnginePaths; signal: AbortSignal;
  onStage?: (stage: EncodeStage) => void | Promise<void>;
  onProgress?: (stage: 'audio' | 'video', timeUs: number) => void | Promise<void>;
}): Promise<{ file: SourceFile; report: EncodeReport }> {
  const { source, engines, signal } = options; const output = resolve(options.output);
  if ((process.platform === 'win32' ? output.toLowerCase() === source.path.toLowerCase() : output === source.path)) throw new Error('Cannot overwrite source');
  signal.throwIfAborted(); await assertSource(source);
  const probe = await probeMedia(source.path, { executable: engines.ffprobe, signal }); const info = mediaInfo(probe);
  if (probe.streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic).length !== 1) throw new Error('多个主视频轨尚需明确选择，不能静默丢弃。');
  const video = probe.streams.find(s => s.index === info.videoIndex)!;
  const processing = videoProcessing(info, video, options.edits, options.hdrConsent, MOTION_VIDEO_TRANSFER);
  if (!['omit', 'track'].includes(options.audio.kind)) throw new Error('Explicit audio policy required');
  const audio = options.audio.kind === 'track' ? probe.streams.find(s => s.index === (options.audio as { index: number }).index && s.codec_type === 'audio') : undefined;
  if (options.audio.kind === 'track' && (!audio || !Number.isSafeInteger(audio.channels) || audio.channels! < 1)) throw new Error('所选音轨或声道信息无效。');
  if (!options.matchSourceParameters && audio && audio.channels! > 2 && !(options.audio.kind === 'track' && options.audio.downmixStereo)) throw new Error('多声道转为立体声需要明确同意，不会静默降混。');
  const channels = audio ? options.matchSourceParameters ? audio.channels! : Math.min(2, audio.channels!) : 0;
  const sampleRate = audio && options.matchSourceParameters ? Number(audio.sample_rate) : 48000;
  const warnings = [...processing.warnings, '普通模式会重新编码视频；不保留字幕、附件、章节或原有附加元数据。',
    '视频实际转换为与 JPEG 封面一致的 sRGB 传递函数，保留 BT.709 色域/矩阵及有限范围；目标设备播放效果仍需核对。'];
  if (options.matchSourceParameters) warnings.push('原画质预设：跟随原片显示尺寸与帧时序，采用高保真编码；不是数学上的严格无损。');
  // Source matching preserves rate/channel count, not the source codec. PCM in MP4 can
  // decode in the preview yet be silent in a phone's motion-photo player.
  if (audio) warnings.push(`按明确选择保留音轨 ${audio.index}，编码为 ${channels} 声道 AAC-LC / ${sampleRate} Hz；${options.matchSourceParameters ? '为提高相册兼容性，音频统一采用 AAC-LC；采样率/声道跟随原片，但重新编码非严格无损。' : '按源时间戳处理静音缺口。'}其余音轨不保留。`);
  else if (info.hasAudio) warnings.push('已明确选择不保留音轨。');
  if (!options.matchSourceParameters && audio && audio.channels! > 2) warnings.push('已明确同意将多声道降混为立体声。');
  await options.onStage?.('plan');
  const plan = await planEncodeRange(source, probe, options.clip, { executable: engines.ffmpeg, signal });
  const start = BigInt(plan.startPts); const end = BigInt(plan.endPts); const last = BigInt(plan.lastPts);
  if ([start, end].some(value => value < -9007199254740991n || value > 9007199254740991n)) throw new Error('源时间戳超出原生滤镜的精确整数范围。');
  const durationUs = ptsToUs(plan.endPts, plan.startPts, plan.timeBase);
  if (durationUs < 1) throw new Error('选段小于微秒导出精度。');
  const startUs = ptsToUs(plan.startPts, '0', plan.timeBase); const endUs = ptsToUs(plan.endPts, '0', plan.timeBase);
  const base = plan.timeBase; const fps = processing.settings.fps;
  const outputBase = fps === null ? base : { numerator: 1, denominator: 1000000 };
  const filters = [`settb=${base.numerator}/${base.denominator}`, `trim=start_pts=${start}:end_pts=${end}`, `setpts=PTS-(${start})`,
    ...processing.filters, 'metadata=mode=delete:key=motion.cover'];
  let marked = false; let coverTag: string | undefined;
  if (options.coverSourcePts !== undefined) {
    if (!/^-?\d{1,20}$/.test(options.coverSourcePts)) throw new Error('Invalid cover frame PTS');
    const point = BigInt(options.coverSourcePts); const relative = point - start;
    if (point >= start && point < end && relative < (1n << 50n)) {
      filters.push(`metadata=mode=add:key=motion.cover:value=${point}:enable='between(t,(${relative}-0.25)*${base.numerator}/${base.denominator},(${relative}+0.25)*${base.numerator}/${base.denominator})'`);
      marked = true; coverTag = String(point);
    }
  }
  if (fps !== null) filters.push(`fps=fps=${fps}:start_time=0:round=near:eof_action=pass`, 'settb=1/1000000', `trim=end_pts=${durationUs}`);
  if (marked) filters.push("metadata=mode=print:key=motion.cover:file='pipe\\:1':direct=1");
  // No B frames in this encoding path: DTS=PTS lets the final packet duration represent the exact selected end.
  // Other VFR intervals are represented by adjacent timestamps, not an average-FPS approximation.
  const packetDuration = fps === null ? `if(eq(PTS,${last - start}),${end - last},DURATION)` : `max(1,min(DURATION,${durationUs}-PTS))`;
  const audioPath = `${output}.audio.mp4`; let audioCreated = false; let succeeded = false;
  let coverTimestampUs = -1; let pendingFrame: string | undefined;
  await writeFile(output, '', { flag: 'wx' });
  try {
    const progress = async (stage: 'audio' | 'video', line: string) => {
      const time = /^out_time_us=(-?\d+)$/.exec(line);
      if (time && Number.isSafeInteger(Number(time[1]))) await options.onProgress?.(stage, Math.max(0, Number(time[1])));
    };
    if (audio) {
      await options.onStage?.('audio');
      if (options.audio.kind !== 'track') throw new Error('Explicit audio selection required');
      await encodeAudioDraft({ source, selection: options.audio, startUs, endUs, durationUs, output: audioPath, engines, signal,
        matchSourceParameters: options.matchSourceParameters, onProgress: timeUs => options.onProgress?.('audio', timeUs) });
      audioCreated = true;
    }
    await assertSource(source); await options.onStage?.('video');
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostats', '-nostdin', '-y', '-xerror',
      '-protocol_whitelist', 'file,pipe', '-err_detect', 'explode', '-copyts', '-seek_timestamp', '1',
      '-ss', usToSeconds(Math.max(info.startUs, startUs - 1000000)), '-noaccurate_seek', '-i', source.path,
      ...(audio ? ['-protocol_whitelist', 'file,pipe', '-i', audioPath] : []),
      '-map', `0:${info.videoIndex}`, ...(audio ? ['-map', '1:a:0', '-c:a', 'copy'] : ['-an']), '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(processing.settings.crf), '-profile:v', processing.settings.crf === 0 ? 'high444' : 'high',
      '-bf', '0', '-pix_fmt', 'yuv420p', '-enc_time_base:v', 'filter', '-fps_mode:v', 'passthrough', '-bsf:v', `setts=duration='${packetDuration}'`,
      '-color_primaries', 'bt709', '-color_trc', MOTION_VIDEO_TRANSFER, '-colorspace', 'bt709', '-color_range', 'tv', '-chroma_sample_location', 'left',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-avoid_negative_ts', 'disabled', '-use_editlist', '1', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-f', 'mp4', output], async line => {
      await progress('video', line);
      const frame = /^frame:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/.exec(line);
      if (frame) pendingFrame = frame[1];
      if (marked && line === `motion.cover=${coverTag}` && pendingFrame !== undefined && coverTimestampUs === -1)
        coverTimestampUs = ptsToUs(pendingFrame, '0', outputBase);
    }, { signal, timeoutMs: 0 });
    await options.onStage?.('verify'); const file = await openSource(output);
    const finalProbe = await probeMedia(output, { executable: engines.ffprobe, signal }); const finalInfo = mediaInfo(finalProbe);
    const v = finalProbe.streams.find(s => s.index === finalInfo.videoIndex)!; const a = finalProbe.streams.find(s => s.codec_type === 'audio');
    if (finalProbe.streams.length !== (audio ? 2 : 1) || v.codec_name !== 'h264' || v.pix_fmt !== 'yuv420p'
      || finalInfo.encodedWidth !== processing.geometry.width || finalInfo.encodedHeight !== processing.geometry.height
      || finalInfo.rotation !== 0 || finalInfo.sampleAspectRatio.numerator !== finalInfo.sampleAspectRatio.denominator
      || BigInt(finalInfo.startPts) !== 0n || Math.abs(finalInfo.durationUs - durationUs) > 1
      || v.color_primaries !== 'bt709' || v.color_transfer !== MOTION_VIDEO_TRANSFER || v.color_space !== 'bt709' || v.color_range !== 'tv')
      throw new Error(`普通输出的视频尺寸、色彩或时间范围未通过验证（期望 ${durationUs} µs，实际 ${finalInfo.durationUs} µs）。`);
    let audioReport: EncodeReport['audio'] = null;
    if (audio) audioReport = { ...validateEncodedAudio(a, channels, durationUs, sampleRate), codec: 'aac' };
    if (coverTimestampUs < -1 || coverTimestampUs >= finalInfo.durationUs) throw new Error('封面帧关联时间无效。');
    if (options.coverSourcePts !== undefined && coverTimestampUs === -1) warnings.push('所选封面帧未保留在输出帧序列中，时间戳记为未知，不冒充输出首帧。');
    await options.onStage?.('decode');
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-err_detect', 'explode', '-i', output, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], () => {}, { signal, timeoutMs: 0 });
    await assertSource(source); await assertSource(file); signal.throwIfAborted(); succeeded = true;
    return { file, report: { mode: 'encode', plan, width: finalInfo.encodedWidth, height: finalInfo.encodedHeight,
      videoDurationUs: finalInfo.durationUs, audio: audioReport, coverTimestampUs, warnings } };
  } catch (error) { if (!signal.aborted) await assertSource(source); throw error; }
  finally {
    // If scratch cleanup fails, do not leave a draft that could be mistaken for a successful export.
    try { if (audioCreated) await unlinkCreatedFile(audioPath); }
    catch (error) { succeeded = false; throw error; }
    finally { if (!succeeded) await unlinkCreatedFile(output); }
  }
}
