import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { openSource } from '../../src/main/media/source.ts';
import { packetHasIdr, scanPackets } from '../../src/main/media/packets.ts';
import { packetPayloadKey, packetTimingKey, planCopyRange, type CopyVideoTrack } from '../../src/main/media/copy-plan.ts';
import { parseRational, ptsToUs, usToSeconds } from '../../src/shared/editor.ts';
import { sha256 } from '../../src/main/motion/io.ts';

async function track(path: string): Promise<CopyVideoTrack> {
  const metadata = await probeMedia(path); const video = metadata.streams.find(s => s.codec_type === 'video')!;
  assert.equal(video.codec_name, 'h264');
  assert.ok(Number.isSafeInteger(video.start_pts)); assert.ok(Number.isSafeInteger(video.duration_ts) && video.duration_ts! > 0);
  return { index: video.index, timeBase: video.time_base!, startPts: String(video.start_pts),
    endPts: String(BigInt(video.start_pts!) + BigInt(video.duration_ts!)), nalLengthBytes: 4 };
}
for (const kind of ['closed', 'offset', 'vfr'] as const) {
  test(`streaming GOP plan and independently copied payload/timing identity (${kind})`, async () => {
    const temp = await tempFiles();
    try {
      const input = temp.file(`${kind}.mp4`); const output = temp.file('copied.mp4');
      await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
        ...(kind === 'vfr' ? ['-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr'] : []),
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', `keyint=${kind === 'vfr' ? 30 : 60}:min-keyint=1:scenecut=0:open-gop=0:bframes=3`,
        ...(kind === 'offset' ? ['-output_ts_offset', '5'] : []), input]);
      const before = await sha256(input); const source = await openSource(input); const video = await track(input);
      const clip = kind === 'vfr' ? { startUs: 1100000, endUs: 1200000 } : { startUs: 2200000, endUs: 3200000 };
      const plan = await planCopyRange(source, video, clip, { executable: ffprobe() });
      assert.equal(plan.endKind, 'idr'); assert.deepEqual(plan.requested, clip);
      if (kind !== 'vfr') { assert.deepEqual(plan.actual, { startUs: 2000000, endUs: 4000000 }); assert.equal(plan.packetCount, 60); }
      else { assert.equal(plan.actual.startUs, 0); assert.ok(plan.actual.endUs > clip.endUs); assert.equal(plan.packetCount, 30); }
      // This fixture has no audio: packet-count clipping is independently sufficient to exercise the GOP plan.
      // Production audio strategy is separately investigated; this is not evidence of A/V edge correctness.
      const absoluteStart = ptsToUs(plan.startPts, '0', plan.timeBase);
      await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-copyts', '-seek_timestamp', '1',
        '-ss', usToSeconds(absoluteStart), '-noaccurate_seek', '-i', input, '-map', `0:${video.index}`, '-an', '-c:v', 'copy',
        '-frames:v', String(plan.packetCount), '-output_ts_offset', usToSeconds(-absoluteStart), '-avoid_negative_ts', 'disabled', output]);
      const copied = await track(output); assert.equal(copied.startPts, '0');
      const payload = createHash('sha256'); const timing = createHash('sha256'); let count = 0;
      await scanPackets({ executable: ffprobe(), input: output, hashes: true, onPacket: packet => {
        if (packet.streamIndex !== copied.index) return;
        count++; payload.update(packetPayloadKey(packet)); timing.update(packetTimingKey(packet, 0n, parseRational(copied.timeBase)!));
      } });
      assert.equal(count, plan.packetCount); assert.equal(payload.digest('hex'), plan.payloadDigest);
      assert.equal(timing.digest('hex'), plan.timingDigest);
      await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-i', output, '-f', 'null', '-']);
      assert.equal(await sha256(input), before);
    } finally { await temp.cleanup(); }
  });
}

test('open GOP K packets are not mistaken for IDR boundaries; planning expands to independently decodable coverage', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('open-gop.mp4');
    await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=1:bframes=3', input]);
    const source = await openSource(input); const video = await track(input); const file = await open(input, 'r');
    let idr = 0; let nonIdrKey = 0;
    try {
      await scanPackets({ executable: ffprobe(), input, onPacket: async packet => {
        if (packet.streamIndex !== video.index || !packet.key) return;
        if (await packetHasIdr(file, source.size, packet, 4)) idr++; else nonIdrKey++;
      } });
    } finally { await file.close(); }
    assert.equal(idr, 1); assert.ok(nonIdrKey >= 1, 'fixture must really contain non-IDR key packets');
    const plan = await planCopyRange(source, video, { startUs: 2200000, endUs: 3200000 }, { executable: ffprobe() });
    assert.deepEqual(plan.actual, { startUs: 0, endUs: 6000000 }); assert.equal(plan.endKind, 'eof'); assert.equal(plan.packetCount, 180);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(planCopyRange(source, video, { startUs: 0, endUs: 1000000 }, { executable: ffprobe(), signal: controller.signal }));
  } finally { await temp.cleanup(); }
});
