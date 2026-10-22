import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ptsToUs, usToSeconds } from '../../shared/editor.ts';
import { SOURCE_MATCH_EDITS, type EffectiveProcessing } from '../../shared/processing.ts';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import type { EnginePaths } from './engine.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import { probeMedia } from './probe.ts';
import { mediaInfo } from './info.ts';
import { sdrColorProcessing, videoProcessing } from './video-processing.ts';
import { streamProcessLines } from './lines.ts';

// Re-decode the chosen native source frame, never reuse a lossy preview/proxy as the final cover source.
// This is an sRGB PNG intermediate for the JPEG compositor, NOT a Motion Photo or a lossless JPEG claim.
export async function prepareFrameCover(options: {
  source: SourceFile; pts: string; processing: EffectiveProcessing; hdrConsent: boolean;
  output: string; engines: EnginePaths; signal: AbortSignal;
}): Promise<{ file: SourceFile; width: number; height: number; sourcePts: string; colorSpace: 'srgb'; warnings: string[] }> {
  const { source, engines, signal } = options; const output = resolve(options.output);
  if ((process.platform === 'win32' ? output.toLowerCase() === source.path.toLowerCase() : output === source.path)) throw new Error('Cannot overwrite source');
  if (!/^-?\d{1,20}$/.test(options.pts)) throw new Error('Invalid cover PTS');
  const pts = BigInt(options.pts);
  if (pts < -(1n << 63n) || pts >= (1n << 63n) - 1n) throw new Error('Cover PTS outside native range');
  signal.throwIfAborted(); await assertSource(source);
  const probe = await probeMedia(source.path, { executable: engines.ffprobe, signal }); const info = mediaInfo(probe);
  const video = probe.streams.find(s => s.index === info.videoIndex)!;
  const relativeUs = ptsToUs(String(pts), info.startPts, info.timeBase);
  if (pts < BigInt(info.startPts) || relativeUs >= info.durationUs) throw new Error('封面帧必须位于当前源视频内。');
  let width: number; let height: number; let spatial: string[]; let warnings: string[];
  if (options.processing.mode === 'encode' || options.processing.mode === 'source') {
    const processing = videoProcessing(info, video, options.processing.mode === 'source' ? SOURCE_MATCH_EDITS : options.processing, options.hdrConsent);
    width = processing.geometry.width; height = processing.geometry.height; spatial = processing.filters; warnings = processing.warnings;
  } else if (options.processing.mode === 'copy') {
    const color = sdrColorProcessing(info, video, options.hdrConsent);
    width = info.displayWidth; height = info.displayHeight; warnings = color.warnings;
    // Only the still is normalized. No crop/FPS/CRF/resolution settings can reach the copied video.
    spatial = [...color.filters, `scale=${width}:${height}:flags=lanczos`, 'setsar=1', 'sidedata=mode=delete'];
  } else throw new Error('Invalid cover processing mode');
  const filters = [`settb=${info.timeBase.numerator}/${info.timeBase.denominator}`, `trim=start_pts=${pts}:end_pts=${pts + 1n}`, ...spatial,
    'zscale=pin=bt709:tin=bt709:min=bt709:rin=tv:p=bt709:t=iec61966-2-1:m=gbr:r=pc:dither=none:agamma=0',
    'format=gbrp', 'format=rgb24', 'sidedata=mode=delete', 'setsar=1'];
  const absoluteUs = ptsToUs(String(pts), '0', info.timeBase);
  await writeFile(output, '', { flag: 'wx' }); let succeeded = false;
  try {
    await streamProcessLines(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-xerror',
      '-protocol_whitelist', 'file,pipe', '-err_detect', 'explode', '-copyts', '-seek_timestamp', '1',
      '-ss', usToSeconds(Math.max(info.startUs, absoluteUs - 1000000)), '-noaccurate_seek', '-i', source.path,
      '-map', `0:${info.videoIndex}`, '-an', '-vf', filters.join(','), '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'png',
      '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'rgb', '-color_range', 'pc',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-update', '1', '-f', 'image2', output], () => {}, { signal, timeoutMs: 0 });
    const file = await openSource(output);
    if (!file.size) throw new Error('所选 PTS 没有真实源帧，不会替换为邻近画面。');
    const result = await probeMedia(output, { executable: engines.ffprobe, signal }); const image = result.streams.find(s => s.codec_type === 'video');
    if (result.streams.length !== 1 || image?.codec_name !== 'png' || image.width !== width || image.height !== height || image.pix_fmt !== 'rgb24'
      || image.side_data_list?.some(item => item.rotation && item.rotation % 360 !== 0)
      || image.color_transfer && !['unknown', 'iec61966-2-1'].includes(image.color_transfer)) throw new Error('sRGB 封面中间图未通过验证。');
    await assertSource(source); await assertSource(file); signal.throwIfAborted(); succeeded = true;
    return { file, width, height, sourcePts: String(pts), colorSpace: 'srgb', warnings };
  } catch (error) { if (!signal.aborted) await assertSource(source); throw error; }
  finally { if (!succeeded) await unlinkCreatedFile(output); }
}
