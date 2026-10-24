import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import { readMp4SampleIndex } from '../../src/main/media/mp4-sample-index.ts';
import { muxMotion } from '../../src/main/motion/mux.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../../src/main/motion/io.ts';

const width = 128, height = 16;
// Directly coded Y/Cb/Cr patches: neutral shadows/midtones/white plus three colors.
// No production color filter or RGB-to-YUV converter constructs this oracle.
const limitedPatches = [[16,128,128], [32,128,128], [102,128,128], [160,128,128], [235,128,128],
  [82,104,185], [137,74,78], [55,195,118]] as const;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function expectedRgb(patch: readonly number[], full: boolean, transfer: string): number[] {
  const y = (patch[0]! - (full ? 0 : 16)) / (full ? 255 : 219);
  const cb = (patch[1]! - 128) / (full ? 255 : 224), cr = (patch[2]! - 128) / (full ? 255 : 224);
  // Independent BT.709 inverse matrix followed by the declared reference-display
  // gamma-2.4 and IEC sRGB equation. Existing sRGB input must NOT be darkened twice.
  return [y + 1.5748 * cr, y - 0.1873242729306488 * cb - 0.4681242729306488 * cr, y + 1.8556 * cb].map(value => {
    if (transfer === 'iec61966-2-1') return Math.round(255 * clamp(value));
    const linear = clamp(value) ** 2.4;
    return Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
  });
}
for (const [range, transfer] of [['tv', 'bt709'], ['pc', 'bt709'], ['tv', 'iec61966-2-1']] as const)
  for (const mode of ['encode', 'source'] as const) test(`final Motion Photo color agrees with independent pixels and cover (${range}/${transfer}/${mode})`, async () => {
    const temp = await tempFiles(); let succeeded = false;
    try {
      const full = range === 'pc';
      const patches = limitedPatches.map(patch => patch.map((value, channel) => full
        ? Math.round(channel === 0 ? (value - 16) * 255 / 219 : 128 + (value - 128) * 255 / 224) : value));
      const raw = Buffer.alloc(width * height * 3 / 2);
      for (let p = 0; p < patches.length; p++) {
        const patch = patches[p]!;
        for (let y = 0; y < height; y++) raw.fill(patch[0]!, y * width + p * 16, y * width + (p + 1) * 16);
        for (let y = 0; y < height / 2; y++) for (let plane = 1; plane <= 2; plane++) {
          const at = width * height + (plane - 1) * width * height / 4 + y * width / 2 + p * 8;
          raw.fill(patch[plane]!, at, at + 8);
        }
      }
      const inputRaw = temp.file('patches.yuv'), input = temp.file('source.mp4');
      await writeFile(inputRaw, Buffer.concat([raw, raw, raw, raw]), { flag: 'wx' });
      const ff = (args: string[]) => runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', ...args]);
      await ff(['-f', 'rawvideo', '-pixel_format', 'yuv420p', '-video_size', `${width}x${height}`, '-framerate', '2', '-i', inputRaw,
        // Rawvideo has no color metadata. Declare our constructed matrix/range on
        // the decoded frames before encoder negotiation, avoiding an automatic
        // unspecified/SD -> BT.709 conversion in the fixture generator itself.
        '-vf', `setparams=range=${full ? 'full' : 'limited'}:color_primaries=bt709:color_trc=${transfer}:colorspace=bt709`,
        '-c:v', 'libx264', '-crf', '0', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', transfer, '-colorspace', 'bt709', '-color_range', range, input]);
      const decodedSource = temp.file('decoded-source.yuv');
      await ff(['-i', input, '-frames:v', '1', '-pix_fmt', full ? 'yuvj420p' : 'yuv420p', '-f', 'rawvideo', decodedSource]);
      assert.ok((await readFile(decodedSource)).equals(raw), 'The coded source fixture must be byte-exact');
      const before = await sha256(input), source = await openSource(input), signal = new AbortController().signal;
      const engines = { ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'color-integration' };
      const processing = mode === 'source' ? { mode } : { mode, crop: { x: 0, y: 0, width: 1, height: 1 },
        settings: { fps: null, resolution: 'original' as const, crf: 0 } };
      const analysis = await analyzeExport(source, { clip: { startUs: 0, endUs: 1000000 }, processing,
        audio: { kind: 'omit' }, hdrConsent: false }, engines, signal);
      const directory = temp.file('draft'); await mkdir(directory);
      const draft = await renderExportDraft({ source, analysis, image: { fit: 'cover', background: '#000000' }, directory, engines, signal });
      assert.equal(draft.report.coverTimestampUs, 0);
      const final = temp.file('final.jpg');
      await muxMotion({ cover: draft.cover.path, video: draft.video.path, output: final, profileId: 'C-modern-xiaomi', timestampUs: 0 });
      const inspected = await validateMotion(final, true), video = temp.file('embedded.mp4');
      await extractRange(final, video, inspected.videoStart, inspected.videoEnd);
      assert.equal(await sha256(video), await sha256(draft.video.path));
      const probe = await probeMedia(video), v = probe.streams[0]!;
      assert.equal(probe.streams.length, 1, 'Explicit omit remains silent');
      assert.deepEqual([v.color_primaries, v.color_transfer, v.color_space, v.color_range], ['bt709', 'iec61966-2-1', 'bt709', 'tv']);
      assert.equal(v.duration, '1.000000');
      const index = await readMp4SampleIndex(await openSource(video)), track = index.tracks[0]!;
      assert.equal(track.sampleCount, 2); assert.equal(track.sample(0).pts, 0n); assert.equal(track.sample(1).pts * 2n, BigInt(track.timescale));
      const colors = [];
      for (let at = 78; at < track.sampleDescription.length;) {
        const b = track.sampleDescription, size = b.readUInt32BE(at); assert.ok(size >= 8 && at + size <= b.length);
        if (b.toString('ascii', at + 4, at + 8) === 'colr') colors.push(b.subarray(at + 8, at + size).toString('hex'));
        at += size;
      }
      assert.deepEqual(colors, ['6e636c780001000d000100'], 'MP4 nclx must agree: 1/13/1, limited range');
      const trace = await runProcess(ffmpeg(), ['-hide_banner', '-v', 'info', '-nostdin', '-i', video, '-map', '0:v:0', '-c:v', 'copy',
        '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-']);
      assert.match(trace.stderr, /transfer_characteristics\s+[01]+\s+= 13\b/);
      assert.match(trace.stderr, /video_full_range_flag\s+0\s+= 0\b/);
      assert.match(trace.stderr, /colour_primaries\s+[01]+\s+= 1\b/);
      assert.match(trace.stderr, /matrix_coefficients\s+[01]+\s+= 1\b/);
      // Use swscale (not the production zscale transfer) for matrix/range-only RGB
      // decoding of the FINAL embedded MP4. Changing only the tags fails this oracle.
      const decoded = temp.file('video.rgb');
      await ff(['-i', video, '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', decoded]);
      const pixels = await readFile(decoded);
      const jpeg = sharp(final); assert.ok((await jpeg.metadata()).icc);
      const cover = await jpeg.withIccProfile('srgb').removeAlpha().raw().toBuffer();
      assert.equal(pixels.length, width * height * 3); assert.equal(cover.length, pixels.length);
      for (let p = 0; p < patches.length; p++) {
        const expected = expectedRgb(patches[p]!, full, transfer), at = (8 * width + p * 16 + 8) * 3;
        for (let c = 0; c < 3; c++) {
          // 4 code values covers YUV quantization + source-preset CRF16/JPEG94
          // on uniform patch interiors; the old midtone gamma error exceeds 10.
          assert.ok(Math.abs(pixels[at+c]! - expected[c]!) <= 4, `video patch ${p}/${c}: ${pixels[at+c]} vs ${expected[c]}`);
          assert.ok(Math.abs(cover[at+c]! - expected[c]!) <= 4, `cover patch ${p}/${c}: ${cover[at+c]} vs ${expected[c]}`);
          assert.ok(Math.abs(pixels[at+c]! - cover[at+c]!) <= 4, `video/cover patch ${p}/${c}`);
        }
      }
      assert.equal(await sha256(input), before); succeeded = true;
    } finally {
      if (succeeded) await temp.cleanup();
      else console.error('Color regression failure artifacts preserved:', temp.directory);
    }
  });
