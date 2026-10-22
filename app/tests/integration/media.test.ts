import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { runProcess, ffmpeg } from '../../src/main/media/runner.ts';
import { probeMedia, decodeVideo, checkTimestamp } from '../../src/main/media/probe.ts';
import { muxMotion } from '../../src/main/motion/mux.ts';
import { extractRange, sha256 } from '../../src/main/motion/io.ts';
import { PROFILES } from '../../src/main/motion/profiles.ts';

const ff = (args: string[]) => runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);

test('actual H.264/AAC + JPEG across all profiles and zero/unknown timestamp', { timeout: 120000 }, async () => {
  const temp = await tempFiles();
  try {
    const video = temp.file('源 视频.mp4'); const cover = temp.file('封面.jpg');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video]);
    await ff(['-i', video, '-frames:v', '1', '-q:v', '2', '-update', '1', cover]);
    const sourceHash = await sha256(video);
    for (const profile of PROFILES) {
      for (const timestampUs of [0, -1]) {
        const output = temp.file(`${profile.id}-${timestampUs}.jpg`);
        const report = await muxMotion({ cover, video, output, profileId: profile.id, timestampUs });
        const extracted = temp.file(`${profile.id}-${timestampUs}.mp4`);
        await extractRange(output, extracted, report.videoStart, report.videoEnd);
        assert.equal(await sha256(extracted), sourceHash);
        const media = await probeMedia(extracted);
        assert.equal(media.streams[0]?.codec_name, 'h264');
        assert.equal(media.streams[1]?.codec_name, 'aac');
        checkTimestamp(timestampUs, media);
        await decodeVideo(extracted);
        await ff(['-xerror', '-i', output, '-frames:v', '1', '-f', 'null', '-']);
        assert.equal(report.width, 320); assert.equal(report.height, 240);
      }
    }
    assert.equal(await sha256(video), sourceHash);
  } finally { await temp.cleanup(); }
});

test('silent portrait and unrelated uploaded PNG converted to JPEG', { timeout: 60000 }, async () => {
  const temp = await tempFiles();
  try {
    const video = temp.file('portrait.mp4'); const png = temp.file('custom.png'); const cover = temp.file('custom.jpg');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=240x320:rate=25:duration=1', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    await ff(['-f', 'lavfi', '-i', 'color=c=blue:s=240x320', '-frames:v', '1', '-update', '1', png]);
    await ff(['-i', png, '-frames:v', '1', '-update', '1', cover]);
    const output = temp.file('custom-motion.jpg');
    const report = await muxMotion({ video, cover, output, profileId: 'D-dual-xiaomi', timestampUs: -1 });
    assert.equal(report.metadata.timestampUs, -1);
    assert.equal((await probeMedia(video)).streams.length, 1);
    assert.equal(report.width, 240); assert.equal(report.height, 320);
    await ff(['-xerror', '-i', output, '-frames:v', '1', '-f', 'null', '-']);
  } finally { await temp.cleanup(); }
});

test('process cancellation and missing executable fail loudly', async () => {
  const controller = new AbortController();
  const task = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, /cancelled/);
  await assert.rejects(runProcess('definitely-not-a-media-executable-937652', []), /ENOENT/);
});

test('wrong cover format is rejected, never silently treated as JPEG', async () => {
  const temp = await tempFiles();
  try {
    const cover = temp.file('wrong.jpg'); const video = temp.file('empty.mp4');
    await writeFile(cover, 'not a jpeg'); await writeFile(video, 'not mp4');
    await assert.rejects(muxMotion({ cover, video, output: temp.file('out.jpg'), profileId: 'A-modern', timestampUs: 0 }), /JPEG/);
  } finally { await temp.cleanup(); }
});
