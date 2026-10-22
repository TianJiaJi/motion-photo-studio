import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { publishMotionPhoto } from '../../src/main/motion/publish.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { sha256, extractRange } from '../../src/main/motion/io.ts';

for (const mode of ['copy', 'encode'] as const) test(`actual ${mode} draft publishes a single Motion JPG with identical MP4 and decodable JPEG/video`, async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); const image = temp.file('blue.png'); const privateDir = temp.file('private'); const outputDir = temp.file('output');
    await mkdir(privateDir); await mkdir(outputDir);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=3', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0', '-c:a', 'aac', input]);
    await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 0, g: 0, b: 255, alpha: .5 } } }).png().toFile(image);
    const source = await openSource(input); const custom = await openSource(image); const before = await sha256(input); const imageBefore = await sha256(image);
    const signal = new AbortController().signal; const engines = { ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' };
    const analysis = await analyzeExport(source, { clip: { startUs: 600000, endUs: 1700000 },
      processing: mode === 'copy' ? { mode } : { mode, crop: { x: .25, y: 0, width: .5, height: 1 }, settings: { fps: 24, resolution: 'original', crf: 23 } },
      audio: { kind: 'track', index: 1, downmixStereo: false }, hdrConsent: false }, engines, signal);
    const draft = await renderExportDraft({ source, analysis, cover: mode === 'encode' ? { kind: 'custom', source: custom } : undefined,
      directory: privateDir, image: { fit: 'contain', background: '#ffffff' }, engines, signal });
    const journal = new Publications(temp.file('journal')); await journal.initialize(); const output = `${outputDir}/motion.jpg`;
    const saved = await publishMotionPhoto({ cover: draft.cover, video: draft.video, sources: [source, custom], output,
      timestampUs: draft.report.coverTimestampUs, videoDurationUs: draft.report.durationUs, journal, signal });
    const report = await validateMotion(output, true);
    assert.equal(saved.size, report.size); assert.equal(report.metadata.timestampUs, mode === 'copy' ? 0 : -1);
    assert.equal(report.metadata.videoLength, draft.video.size); assert.equal(report.exif[0]?.xiaomiFlag, 1);
    const extracted = temp.file('extracted.mp4'); await extractRange(output, extracted, report.videoStart, report.videoEnd);
    assert.equal(await sha256(extracted), await sha256(draft.video.path));
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', extracted, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    const jpeg = sharp(output, { limitInputPixels: false }); const metadata = await jpeg.metadata();
    assert.ok(metadata.icc); assert.deepEqual([metadata.width, metadata.height], [draft.report.width, draft.report.height]); await jpeg.stats();
    assert.deepEqual(await readdir(outputDir), ['motion.jpg']); assert.deepEqual(await readdir(journal.root), []);
    assert.equal(await sha256(input), before); assert.equal(await sha256(image), imageBefore);
  } finally { await temp.cleanup(); }
});
