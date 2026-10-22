import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import type { ExportOptions } from '../../src/shared/export.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const engines = () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' });
const signal = () => new AbortController().signal;
async function fixture(path: string) {
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=6', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:bframes=3', '-c:a', 'aac', path]);
}
for (const mode of ['encode', 'copy'] as const) test(`private draft pipeline joins verified ${mode} video and an sRGB frame cover without publishing a Motion Photo`, async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); const directory = temp.file('private'); await mkdir(directory); await fixture(input);
    const source = await openSource(input); const hash = await sha256(input);
    const request: ExportOptions = { clip: { startUs: 2200000, endUs: 3200000 }, processing: mode === 'copy' ? { mode } :
      { mode, crop: { x: .25, y: 0, width: .5, height: 1 }, settings: { fps: null, resolution: 'original', crf: 23 } },
      audio: { kind: 'track', index: 1, downmixStereo: false }, hdrConsent: false };
    const analysis = await analyzeExport(source, request, engines(), signal());
    assert.equal(analysis.public.supported, true); assert.equal(analysis.public.mode, mode);
    assert.deepEqual(analysis.public.actual, mode === 'copy' ? { startUs: 2000000, endUs: 4000000 } : request.clip);
    assert.equal(JSON.stringify(analysis.public).includes(source.path), false);
    const result = await renderExportDraft({ source, analysis, directory, image: { fit: 'cover', background: '#000000' }, engines: engines(), signal: signal() });
    assert.equal(result.report.proof.kind, mode); assert.equal(result.report.coverTimestampUs, 0);
    assert.deepEqual([result.report.width, result.report.height], mode === 'copy' ? [160, 120] : [80, 120]);
    if (result.report.proof.kind === 'copy') { assert.equal(result.report.proof.videoPackets, 60); assert.match(result.report.proof.videoPayloadSha256, /^[a-f0-9]{64}$/); }
    const jpeg = await sharp(result.cover.path).metadata(); assert.equal(jpeg.format, 'jpeg'); assert.ok(jpeg.icc); assert.equal(jpeg.xmp, undefined);
    assert.equal((await readdir(directory)).length, 2, 'only private video and JPEG remain, no PNG/audio scratch');
    assert.equal(await sha256(input), hash);
  } finally { await temp.cleanup(); }
});
test('an unrelated uploaded image remains unknown-time and never substitutes the first video frame', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); const image = temp.file('blue.png'); const directory = temp.file('private'); await mkdir(directory); await fixture(input);
    await sharp({ create: { width: 80, height: 40, channels: 3, background: '#0000ff' } }).png().toFile(image);
    const source = await openSource(input); const cover = await openSource(image); const hash = await sha256(image);
    const analysis = await analyzeExport(source, { clip: { startUs: 2200000, endUs: 3200000 }, processing: { mode: 'copy' }, audio: { kind: 'omit' }, hdrConsent: false }, engines(), signal());
    const result = await renderExportDraft({ source, analysis, cover: { kind: 'custom', source: cover }, directory,
      image: { fit: 'contain', background: '#000000' }, engines: engines(), signal: signal() });
    assert.equal(result.report.coverTimestampUs, -1);
    const pixel = await sharp(result.cover.path).extract({ left: 80, top: 60, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[2]! > 245 && pixel[0]! < 10); assert.equal(await sha256(image), hash);
  } finally { await temp.cleanup(); }
});
test('cancelling after video verification removes every unpublishable draft and mismatched source plans are refused', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); const directory = temp.file('private'); await mkdir(directory); await fixture(input);
    const source = await openSource(input);
    const analysis = await analyzeExport(source, { clip: { startUs: 2200000, endUs: 3200000 }, processing: { mode: 'copy' }, audio: { kind: 'omit' }, hdrConsent: false }, engines(), signal());
    const controller = new AbortController();
    await assert.rejects(renderExportDraft({ source, analysis, directory, image: { fit: 'cover', background: '#000000' }, engines: engines(), signal: controller.signal,
      onStage: stage => { if (stage === 'cover') controller.abort(); } }));
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(renderExportDraft({ source, analysis: { ...analysis, sourceStamp: 'forged' }, directory,
      image: { fit: 'cover', background: '#000000' }, engines: engines(), signal: signal() }), { code: 'INVALID_REQUEST' });
    assert.deepEqual(await readdir(directory), []);
  } finally { await temp.cleanup(); }
});
