// Fixed tiny diagnostic images only. Never run this as a whole-video pixel capture path.
import { readFile } from 'node:fs/promises';
import { tempFiles } from '../tests/helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../src/main/media/runner.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { mediaInfo } from '../src/main/media/info.ts';
import { openSource } from '../src/main/media/source.ts';
import { prepareFrameCover } from '../src/main/media/frame-cover.ts';
import { sdrColorProcessing } from '../src/main/media/video-processing.ts';
const temp = await tempFiles();
try {
  for (const level of [32, 64, 102, 160, 224]) {
    const hex = level.toString(16).padStart(2, '0').repeat(3); const input = temp.file(`gray-${level}.mp4`);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16:r=1:d=2`,
      '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-crf', '0', input]);
    const probe = await probeMedia(input); const info = mediaInfo(probe); const video = probe.streams[0]!;
    const canonical = sdrColorProcessing(info, video, false).filters.join(',');
    const prefix = 'pin=bt709:tin=bt709:min=bt709:rin=tv:p=bt709:m=gbr:r=pc';
    const variants: Record<string, { filters: string; format: string }> = {
      source: { filters: 'format=rgb24', format: 'rgb24' },
      canonicalWithoutTransfer: { filters: `${canonical},zscale=${prefix}:t=bt709,format=gbrp,format=rgb24`, format: 'rgb24' },
      srgbApprox: { filters: `${canonical},zscale=${prefix}:t=iec61966-2-1:agamma=1,format=gbrp,format=rgb24`, format: 'rgb24' },
      srgbExact: { filters: `${canonical},zscale=${prefix}:t=iec61966-2-1:agamma=0,format=gbrp,format=rgb24`, format: 'rgb24' },
      linear: { filters: `${canonical},zscale=${prefix}:t=linear:agamma=0,format=gbrpf32le`, format: 'gbrpf32le' },
    };
    const measurements: Record<string, number> = {};
    for (const [name, variant] of Object.entries(variants)) {
      const output = temp.file(`${level}-${name}.bin`);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-i', input, '-an', '-vf', variant.filters,
        '-frames:v', '1', '-pix_fmt', variant.format, '-f', 'rawvideo', output]);
      const bytes = await readFile(output); measurements[name] = name === 'linear' ? bytes.readFloatLE(0) : bytes[0]!;
    }
    const png = await prepareFrameCover({ source: await openSource(input), pts: '0', processing: { mode: 'copy' }, hdrConsent: false,
      output: temp.file(`${level}.png`), engines: { ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'diagnostic' }, signal: new AbortController().signal });
    const decoded = temp.file(`${level}-png.bin`);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-i', png.file.path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', decoded]);
    measurements.png = (await readFile(decoded))[0]!;
    const signal = measurements.source! / 255;
    const sceneLinear = signal < 0.081 ? signal / 4.5 : ((signal + 0.099) / 1.099) ** (1 / 0.45);
    const displayLinear = signal ** 2.4;
    const srgb = (value: number) => Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
    console.log(JSON.stringify({ inputLevel: level, sourceTags: { primaries: video.color_primaries, transfer: video.color_transfer, matrix: video.color_space, range: video.color_range },
      measurements, reference: { sceneLinear, displayLinear, sceneSrgb: srgb(sceneLinear), displaySrgb: srgb(displayLinear) } }));
  }
} finally { await temp.cleanup(); }
