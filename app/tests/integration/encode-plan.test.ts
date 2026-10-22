import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { openSource } from '../../src/main/media/source.ts';
import { planEncodeRange } from '../../src/main/media/encode-plan.ts';
import { sha256 } from '../../src/main/motion/io.ts';

for (const kind of ['cfr', 'offset', 'vfr'] as const) {
  test(`precise boundaries use decoded frames rather than FPS estimates (${kind})`, async () => {
    const temp = await tempFiles();
    try {
      const input = temp.file('source.mp4');
      await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
        ...(kind === 'vfr' ? ['-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr'] : []),
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0',
        ...(kind === 'offset' ? ['-output_ts_offset', '5'] : []), input]);
      const source = await openSource(input); const before = await sha256(input); const probe = await probeMedia(input); const info = mediaInfo(probe);
      const requested = { startUs: 1010000, endUs: 1990000 };
      const result = await planEncodeRange(source, probe, requested, { executable: ffmpeg() });
      // Independent complete frame table is allowed ONLY for this fixed six-second fixture.
      const report = await runProcess(ffprobe(), ['-v', 'error', '-select_streams', String(info.videoIndex), '-show_frames',
        '-show_entries', 'frame=best_effort_timestamp', '-of', 'json', input]);
      const frames = (JSON.parse(report.stdout) as { frames: { best_effort_timestamp: number }[] }).frames;
      const firstAt = (us: number) => frames.find(frame => (BigInt(frame.best_effort_timestamp) - BigInt(info.startPts))
        * BigInt(info.timeBase.numerator) * 1000000n >= BigInt(us) * BigInt(info.timeBase.denominator))!;
      assert.equal(result.startPts, String(firstAt(requested.startUs).best_effort_timestamp));
      assert.equal(result.endPts, String(firstAt(requested.endUs).best_effort_timestamp));
      assert.equal(result.endKind, 'frame');
      if (kind !== 'vfr') assert.deepEqual(result.actual, { startUs: 1033333, endUs: 2000000 });
      else assert.equal(result.actual.startUs, 1100000);
      const tail = await planEncodeRange(source, probe, { startUs: 5200000, endUs: info.durationUs }, { executable: ffmpeg() });
      assert.equal(tail.endKind, 'eof'); assert.equal(tail.actual.endUs, info.durationUs);
      await assert.rejects(planEncodeRange(source, probe, { startUs: 1010000, endUs: 1020000 }, { executable: ffmpeg() }), /不足一个/);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(planEncodeRange(source, probe, requested, { executable: ffmpeg(), signal: controller.signal }));
      assert.equal(await sha256(input), before);
    } finally { await temp.cleanup(); }
  });
}
