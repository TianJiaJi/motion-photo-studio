import { writeFile } from 'node:fs/promises';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import type { EnginePaths } from './engine.ts';
import type { MediaInfo } from '../../shared/media.ts';
import { usToSeconds } from '../../shared/editor.ts';
import { extractFrame, normalizedFrameFilters } from './frame.ts';
import { runProcess } from './runner.ts';
import { probeMedia } from './probe.ts';
import { mediaInfo } from './info.ts';

// This bounds preview work only. It never constrains source or export duration.
export const PREVIEW_WINDOW_US = 12000000;
export async function createPreview(options: {
  engines: EnginePaths; input: string; output: string; info: MediaInfo; timeUs: number; signal: AbortSignal;
}): Promise<{ startUs: number; endUs: number; mediaStartUs: number }> {
  const { info, signal, engines } = options;
  const startImage = `${options.output}.start.jpg`;
  await writeFile(options.output, '', { flag: 'wx' });
  let succeeded = false;
  let anchorCreated = false;
  try {
    const anchor = await extractFrame({ executable: engines.ffmpeg, input: options.input, output: startImage,
      info, timeUs: Math.max(0, options.timeUs - 2000000), thumbnail: true, signal });
    anchorCreated = true;
    const startUs = anchor.actualTimeUs;
    const durationUs = Math.min(PREVIEW_WINDOW_US, info.durationUs - startUs);
    if (durationUs <= 0) throw new Error('No playable preview interval');
    const ratio = Math.min(1, 1280 / Math.max(info.displayWidth, info.displayHeight));
    const width = Math.max(2, Math.floor(info.displayWidth * ratio / 2) * 2);
    const height = Math.max(2, Math.floor(info.displayHeight * ratio / 2) * 2);
    const filters = [...normalizedFrameFilters(info), `scale=${width}:${height}`, 'setsar=1'];
    await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file,pipe', '-seek_timestamp', '1', '-ss', usToSeconds(info.startUs + startUs),
      '-i', options.input, '-t', usToSeconds(durationUs), '-map', `0:${info.videoIndex}`, '-map', '0:a:0?',
      '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-r', '30', '-fps_mode', 'cfr', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', options.output], { signal });
    const outputProbe = await probeMedia(options.output, { executable: engines.ffprobe, signal });
    const output = mediaInfo(outputProbe);
    const video = outputProbe.streams.find(stream => stream.codec_type === 'video');
    if (output.codec !== 'h264' || output.hdr || output.rotation !== 0 || output.durationUs > durationUs + 150000
      || output.displayWidth > 1280 || output.displayHeight > 1280
      || info.hdr && (video?.color_transfer !== 'bt709' || video?.color_primaries !== 'bt709')) {
      throw new Error('Unexpected preview output or incomplete SDR color signaling');
    }
    signal.throwIfAborted();
    succeeded = true;
    return { startUs, endUs: Math.min(info.durationUs, startUs + output.durationUs), mediaStartUs: output.startUs };
  } finally {
    try { if (anchorCreated) await unlinkCreatedFile(startImage); }
    finally { if (!succeeded) await unlinkCreatedFile(options.output); }
  }
}
