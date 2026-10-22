import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, writeFile, readFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { extractFrame } from '../../src/main/media/frame.ts';
import { inspectJpeg } from '../../src/main/motion/jpeg.ts';
import { sha256 } from '../../src/main/motion/io.ts';

const ff = (args: string[]) => runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
for (const variableRate of [false, true]) {
  test(`native frame selection and previous-frame stepping (${variableRate ? 'VFR' : 'CFR'})`, { timeout: 120000 }, async () => {
    const temp = await tempFiles();
    try {
      const input = temp.file('source.mp4');
      await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
        ...(variableRate ? ['-vf', 'select=not(mod(n\\,3))+not(mod(n\\,5))', '-fps_mode', 'vfr'] : []),
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
      const info = mediaInfo(await probeMedia(input, { executable: ffprobe() }));
      const sourceHash = await sha256(input);
      const common = { executable: ffmpeg(), input, info };
      const first = await extractFrame({ ...common, output: temp.file('first.jpg'), timeUs: 510000 });
      assert.ok(first.actualTimeUs >= 510000 && first.actualTimeUs < 700000);
      const next = await extractFrame({ ...common, output: temp.file('next.jpg'), timeUs: first.actualTimeUs, afterPts: first.pts });
      assert.ok(BigInt(next.pts) > BigInt(first.pts));
      const microsecondSeek = await extractFrame({ ...common, output: temp.file('microsecond.jpg'), timeUs: first.actualTimeUs + 1 });
      assert.equal(microsecondSeek.pts, next.pts, 'Seeking past a frame must not round back onto it');
      const previous = await extractFrame({ ...common, output: temp.file('previous.jpg'), timeUs: next.actualTimeUs, beforePts: next.pts });
      assert.equal(previous.pts, first.pts);
      assert.equal(await sha256(first.path), await sha256(previous.path));
      const last = await extractFrame({ ...common, output: temp.file('last.jpg'), timeUs: info.durationUs });
      assert.ok(last.actualTimeUs < info.durationUs && last.actualTimeUs > info.durationUs - 200000);
      const tail = await extractFrame({ ...common, output: temp.file('tail.jpg'), timeUs: info.durationUs - 1 });
      assert.equal(tail.pts, last.pts, 'The final frame duration must resolve to the last available frame');
      await assert.rejects(extractFrame({ ...common, output: temp.file('beyond.jpg'), timeUs: last.actualTimeUs, afterPts: last.pts }), /No following/);
      await assert.rejects(readFile(temp.file('beyond.jpg')), { code: 'ENOENT' });
      const start = await extractFrame({ ...common, output: temp.file('start.jpg'), timeUs: 0 });
      await assert.rejects(extractFrame({ ...common, output: temp.file('before.jpg'), timeUs: start.actualTimeUs, beforePts: start.pts }), /No preceding/);
      await assert.rejects(readFile(temp.file('before.jpg')), { code: 'ENOENT' });
      assert.equal(await sha256(input), sourceHash);
      const existing = temp.file('keep.jpg'); await writeFile(existing, 'do not overwrite');
      await assert.rejects(extractFrame({ ...common, output: existing, timeUs: 0 }), /EEXIST/);
      assert.equal(await readFile(existing, 'utf8'), 'do not overwrite');
    } finally { await temp.cleanup(); }
  });
}

test('rotated video frame is normalized into display-space dimensions', { timeout: 60000 }, async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('source.mp4'); const rotated = temp.file('rotated.mp4'); const output = temp.file('cover.jpg');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    // Current FFmpeg writes the display matrix via this input override, not legacy rotate metadata.
    await ff(['-display_rotation:v:0', '90', '-i', input, '-c', 'copy', rotated]);
    const info = mediaInfo(await probeMedia(rotated, { executable: ffprobe() }));
    assert.equal(info.displayWidth, 240); assert.equal(info.displayHeight, 320);
    await extractFrame({ executable: ffmpeg(), input: rotated, output, info, timeUs: 0 });
    const file = await open(output, 'r');
    try {
      const image = await inspectJpeg(file, (await file.stat()).size);
      assert.equal(image.width, 240); assert.equal(image.height, 320);
    } finally { await file.close(); }
  } finally { await temp.cleanup(); }
});
