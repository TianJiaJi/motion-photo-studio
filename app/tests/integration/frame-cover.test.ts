import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { prepareFrameCover } from '../../src/main/media/frame-cover.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { SDR_RENDERING_INTENT } from '../../src/main/media/video-processing.ts';
const engines = () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' });
const sdr = 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

test('frame cover matches the explicit display-referred sRGB curve across coded grayscale samples', async () => {
  const temp = await tempFiles();
  try {
    assert.equal(SDR_RENDERING_INTENT, 'display-referred-ideal-black-gamma-2.4');
    for (const level of [0, 16, 32, 64, 102, 160, 224, 255]) {
      const input = temp.file(`gray-${level}.mp4`); const hex = level.toString(16).padStart(2, '0').repeat(3);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16:r=1:d=2`,
        '-vf', sdr, '-c:v', 'libx264', '-crf', '0', input]);
      const source = await openSource(input); const before = await sha256(input);
      // Read the actual coded Y plane, not the nominal RGB hex or the production color filter.
      // Native decoder-only fixture output is fixed at 16x16; no unbounded media capture is involved.
      const yuvPath = temp.file(`${level}.yuv`);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-i', input, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', yuvPath]);
      const yuv = await readFile(yuvPath); assert.equal(yuv.length, 384);
      assert.equal(yuv[256], 128); assert.equal(yuv[320], 128);
      const signal = Math.max(0, Math.min(1, (yuv[0]! - 16) / 219));
      const linear = signal ** 2.4; // Chosen reference-display policy; NOT the scene-referred Rec.709 inverse OETF.
      const expected = Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
      const result = await prepareFrameCover({ source, pts: '0', processing: { mode: 'copy' }, hdrConsent: false,
        output: temp.file(`${level}.png`), engines: engines(), signal: new AbortController().signal });
      assert.deepEqual([result.width, result.height, result.colorSpace], [16, 16, 'srgb']);
      const raw = temp.file(`${level}.rgb`);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-i', result.file.path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw]);
      const pixels = await readFile(raw); assert.equal(pixels.length, 768);
      for (const value of pixels) assert.ok(Math.abs(value - expected) <= 1, `gray ${level}: expected ${expected}, got ${value}`);
      if (level === 102) assert.ok(Math.abs(pixels[0]! - Math.round(signal * 255)) > 5, 'tag-only conversion must fail');
      assert.equal(await sha256(input), before);
    }
  } finally { await temp.cleanup(); }
});
test('frame stills apply only the effective geometry, preserve odd full-frame display sizes in copy mode and reject nonexistent PTS', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('sar.mp4');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
      '-vf', `setsar=4/3,${sdr}`, '-c:v', 'libx264', input]);
    const options = { source: await openSource(input), pts: '0', hdrConsent: false, engines: engines(), signal: new AbortController().signal };
    const copy = await prepareFrameCover({ ...options, processing: { mode: 'copy' }, output: temp.file('copy.png') });
    assert.deepEqual([copy.width, copy.height], [213, 120]);
    const edited = await prepareFrameCover({ ...options, processing: { mode: 'encode', crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      settings: { fps: 24, resolution: 'original', crf: 23 } }, output: temp.file('edited.png') });
    assert.deepEqual([edited.width, edited.height], [106, 120]);
    const missing = temp.file('missing.png');
    await assert.rejects(prepareFrameCover({ ...options, pts: '1', processing: { mode: 'copy' }, output: missing }), /没有真实源帧/);
    await assert.rejects(access(missing), { code: 'ENOENT' });
    const existing = temp.file('existing.png'); await writeFile(existing, 'sentinel');
    await assert.rejects(prepareFrameCover({ ...options, processing: { mode: 'copy' }, output: existing }), { code: 'EEXIST' });
    assert.equal(await readFile(existing, 'utf8'), 'sentinel');
  } finally { await temp.cleanup(); }
});
