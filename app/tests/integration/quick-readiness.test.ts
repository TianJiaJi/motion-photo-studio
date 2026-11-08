import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles, audioEndpointAvailable } from '../helpers.ts';
import { nativeSessionHarness } from '../native-session-harness.ts';
import { recordMediaActivity, assertNoFullMediaScan } from '../media-activity.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { prepareQuickMedia, type PreparedQuickMedia } from '../../src/main/media/quick-import.ts';
import { frameAtOrAfter } from '../../src/main/media/encode-plan.ts';
import { ptsToUs } from '../../src/shared/editor.ts';
const ffmpeg = resolve('resources/bin/ffmpeg.exe'), ffprobe = resolve('resources/bin/ffprobe.exe');
const helper = resolve('resources/bin/motion-preview.exe');
const skip = process.platform !== 'win32';
async function fixture(path: string, delay = 0) {
  await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
    '-itsoffset', String(delay), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '60',
    '-c:a', 'aac', '-ac', '2', '-output_ts_offset', '5', path]);
}
test('quick nonzero video origins agree with original source PTS', { skip, timeout: 120000 }, async () => {
  const temp = await tempFiles(); let prepared: PreparedQuickMedia | undefined;
  try {
    for (const delay of [0]) {
      const path = temp.file(`offset-${delay}.mp4`); await fixture(path, delay);
      const source = await openSource(path); const probe = await probeMedia(path, { executable: ffprobe }); const info = mediaInfo(probe);
      assert.equal(info.startUs, 5_000_000);
      const directory = temp.file(`session-${delay}`); await mkdir(directory);
      const measured = await recordMediaActivity(() => prepareQuickMedia({ source, probe, info, directory, helper, ffmpeg, signal: new AbortController().signal }));
      prepared = measured.result; assertNoFullMediaScan(measured.activity, 'nonzero origin readiness');
      assert.equal(prepared.audio.length, 1);
      // AAC priming may precede the declared delay by one 1024-sample packet.
      const firstRelativeHns = prepared.audio[0]!.firstRelativeHns;
      assert.notEqual(firstRelativeHns, null);
      const firstRelativeUs = Number(BigInt(firstRelativeHns!) / 10n);
      assert.ok(Math.abs(firstRelativeUs - delay * 1e6) <= 25_000, `unexpected leading delay: ${firstRelativeUs}`);
      for (const timeUs of [0, 510_000, 1_500_000, 2_900_000]) {
        const expected = await frameAtOrAfter(source, info, timeUs, ffmpeg);
        assert.ok(expected.found);
        const displayed = await prepared.frames.frameAt(prepared.native, timeUs, 'after');
        assert.ok(Math.abs(displayed.timeUs - ptsToUs(expected.found.pts.toString(), info.startPts, info.timeBase)) <= 8);
      }
      await prepared.native.shutdown(); await prepared.frames.close(); prepared = undefined;
    }
  } finally { await prepared?.native.shutdown(); await prepared?.frames.close(); await temp.cleanup(); }
});
test('large audio-reader origin differences reject quick readiness, drain resources and explicitly fall back', { skip, timeout: 120000 }, async (t) => {
  const h = await nativeSessionHarness();
  try {
    const path = h.temp.file('delayed.mp4'); await fixture(path, 0.4);
    const source = await openSource(path); const probe = await probeMedia(path, { executable: ffprobe }); const info = mediaInfo(probe);
    const directory = h.temp.file('rejected-quick'); await mkdir(directory);
    // Capture an unexpected success so its helper is drained instead of leaking a child
    // process that can hold the test file open after its assertions finish.
    let unexpected: PreparedQuickMedia | undefined;
    const pending = prepareQuickMedia({ source, probe, info, directory, helper, ffmpeg, signal: new AbortController().signal })
      .then(value => { unexpected = value; return value; });
    try {
      await assert.rejects(pending, (error: unknown) => {
        const failure = error as { code?: string; message?: string };
        assert.equal(failure.code, 'QUICK_UNSUPPORTED');
        assert.match(failure.message ?? '', /原生时间原点/); t.diagnostic(failure.message!); return true;
      });
    } finally {
      if (unexpected) { await unexpected.native.shutdown(); await unexpected.frames.close(); }
    }
    assert.deepEqual(await readdir(directory), [], 'failed quick preparation must drain its helper and leave no owned files');
    const asset = await h.manager.open(path);
    const ready = await h.manager.prepareNative(asset.id, false, asset.info.audioTracks[0]!.index);
    assert.equal(ready.mode, 'strict');
    assert.ok(ready.warnings.some(warning => warning.includes('原生时间原点')));
    const displayed = await h.seek(asset.id, 500_000); assert.ok(displayed.pts);
  } finally { await h.cleanup(); }
});
async function pcmFixture(h: Awaited<ReturnType<typeof nativeSessionHarness>>) {
  const path = h.temp.file('pcm-in-mp4.mp4');
  await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', '-ac', '2', path]);
  return path;
}
test('unsupported native PCM audio gives an audio-specific fallback', { skip, timeout: 120000 }, async () => {
  const h = await nativeSessionHarness();
  try {
    const path = await pcmFixture(h);
    const asset = await h.manager.open(path), selected = asset.info.audioTracks[0]!.index;
    const ready = await h.manager.prepareNative(asset.id, false, selected);
    assert.equal(ready.mode, 'strict');
    assert.ok(ready.warnings.some(warning => warning.includes('所选音轨的原生解码或格式转换不可用')));
  } finally { await h.cleanup(); }
});
test('PCM-selected audio remains playable through the actual WASAPI clock', { skip, timeout: 120000 }, async (t) => {
  if (!(await audioEndpointAvailable(helper))) { t.skip('此主机没有音频输出端点，实际 WASAPI 播放须在有音频设备的主机验证'); return; }
  const h = await nativeSessionHarness();
  try {
    const path = await pcmFixture(h);
    const asset = await h.manager.open(path), selected = asset.info.audioTracks[0]!.index;
    const ready = await h.manager.prepareNative(asset.id, false, selected);
    assert.equal(ready.mode, 'strict');
    await h.manager.nativeControl({ assetId: asset.id, epoch: 100, action: 'play', startUs: 0, endUs: 500000, audioTrack: selected });
    await h.manager.nativeControl({ assetId: asset.id, epoch: 101, action: 'pause' });
  } finally { await h.cleanup(); }
});
test('changing selected audio gates readiness again and releases the replaced helper manifest', { skip, timeout: 120000 }, async () => {
  const h = await nativeSessionHarness();
  try {
    const path = h.temp.file('switch.mp4'); await fixture(path);
    const asset = await h.manager.open(path); const selected = asset.info.audioTracks[0]!.index;
    const first = await h.manager.prepareNative(asset.id, false, selected); assert.equal(first.mode, 'quick');
    await h.seek(asset.id, 500_000);
    const omitted = await h.manager.prepareNative(asset.id, false, null); assert.equal(omitted.mode, 'quick');
    await h.seek(asset.id, 1_000_000);
    await assert.rejects(h.manager.nativeControl({ assetId: asset.id, epoch: 100, action: 'play', startUs: 0, endUs: 1_000_000, audioTrack: selected }), { code: 'INVALID_REQUEST' });
    await h.manager.prepareNative(asset.id, false, selected);
    await h.seek(asset.id, 1_500_000);
    const files = await readdir(h.store.root, { recursive: true });
    assert.equal(files.filter(path => path.includes('editing-manifest-')).length, 1, 'old readiness resources must not accumulate');
  } finally { await h.cleanup(); }
});
