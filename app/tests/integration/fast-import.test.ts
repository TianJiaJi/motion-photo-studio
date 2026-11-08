import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles, audioEndpointAvailable } from '../helpers.ts';
import { recordMediaActivity, fullMediaScanMarkers, assertNoFullMediaScan } from '../media-activity.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { ptsToUs } from '../../src/shared/editor.ts';
import { prepareNativeMedia, type PreparedNativeMedia, type ImportProgress } from '../../src/main/media/native-import.ts';
import { prepareQuickMedia, type PreparedQuickMedia } from '../../src/main/media/quick-import.ts';
import { decodePresentedWindow, frameAtOrAfter } from '../../src/main/media/encode-plan.ts';
import { DISPLAY_TIME_BOUND_US } from '../../src/main/media/local-frame-resolver.ts';
import { NativeTimeline } from '../../src/main/media/native-timeline.ts';
import type { PreviewPixels, PreviewStatus } from '../../src/shared/native-preview.ts';
const windows = process.platform === 'win32';
const helper = resolve('resources/bin/motion-preview.exe');
const ffmpeg = () => resolve('resources/bin/ffmpeg.exe');
const ffprobe = () => resolve('resources/bin/ffprobe.exe');

async function generate(path: string) {
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '250', '-bf', '3', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', path], { timeoutMs: 120000 });
}
async function release(prepared: PreparedNativeMedia | PreparedQuickMedia | undefined) {
  await prepared?.native.shutdown(); await prepared?.frames.close();
}

// Baseline characterization of the STRICT preparation path: it must still report its full
// whole-file scans (this is what the quick path eliminates). Stage timings are diagnostics
// for the recorded performance baseline, not pass/fail thresholds.
test('strict import baseline: full scans are observable and stage timings are recorded', { skip: !windows, timeout: 120000 }, async (t) => {
  const temp = await tempFiles();
  let prepared: PreparedNativeMedia | undefined;
  try {
    const file = temp.file('baseline.mp4'); await generate(file);
    const source = await openSource(file); const info = mediaInfo(await probeMedia(file, { executable: ffprobe() }));
    const directory = temp.file('session'); await mkdir(directory);
    const stageAt = new Map<ImportProgress['stage'], number>(); const started = performance.now();
    const { result, activity } = await recordMediaActivity(() => prepareNativeMedia({ source, info, directory, helper,
      ffmpeg: ffmpeg(), ffprobe: ffprobe(), signal: new AbortController().signal, maximumEdge: 640,
      onProgress: value => { if (!stageAt.has(value.stage)) stageAt.set(value.stage, Math.round(performance.now() - started)); } }));
    prepared = result;
    const totalMs = Math.round(performance.now() - started);
    t.diagnostic(`strict total=${totalMs}ms stages=${JSON.stringify([...stageAt])}`);
    const markers = fullMediaScanMarkers(activity);
    t.diagnostic(`strict whole-file scan markers: ${markers.length}`);
    assert.ok(markers.some(marker => marker.includes('ffprobe 全片帧枚举')),
      'strict path must currently enumerate whole-file frames (this is the baseline being removed)');
    assert.ok(totalMs > 0); assert.ok(prepared.index.mappingReady);
  } finally { await release(prepared); await temp.cleanup(); }
});

// The quick path contract: bounded startup work only (no whole-file scan), sound-ready audio
// calibration from actual first samples, and display times anchored within the verified window.
test('quick open performs no whole-file scans, prepares sound from bounded samples and keeps display times on the source clock', { skip: !windows, timeout: 120000 }, async (t) => {
  const temp = await tempFiles();
  let prepared: PreparedQuickMedia | undefined;
  try {
    const file = temp.file('quick.mp4'); await generate(file);
    const source = await openSource(file);
    const probe = await probeMedia(file, { executable: ffprobe() });
    const info = mediaInfo(probe);
    assert.equal(info.audioTracks.length, 1);
    const directory = temp.file('session'); await mkdir(directory);
    const started = performance.now();
    const { result, activity } = await recordMediaActivity(() => prepareQuickMedia({ source, info, probe, directory, helper,
      ffmpeg: ffmpeg(), signal: new AbortController().signal, maximumEdge: 640 }));
    prepared = result;
    const readyMs = Math.round(performance.now() - started);
    t.diagnostic(`quick ready=${readyMs}ms`);
    assertNoFullMediaScan(activity, 'quick import');
    const decodes = activity.spawns.filter(row => /ffmpeg(?:\.exe)?$/i.test(row.executable));
    assert.equal(decodes.length, 2, 'only one bounded video and selected-audio decode at startup');
    assert.ok(decodes.every(row => row.args.includes('-frames:v') || row.args.includes('-frames:a')));
    assert.equal(activity.native.filter(row => row.command === 'scanFrames').reduce((sum, row) => sum + Number(row.request.count), 0), 64);
    assert.equal(activity.native.filter(row => row.command === 'audioScan').reduce((sum, row) => sum + Number(row.request.count), 0), 48);
    assert.ok(activity.native.some(row => row.command === 'locate'), 'ready must verify real pixels, not just timestamps');
    assert.equal(prepared.compatibility, false);
    assert.equal(prepared.frames.frameCount, null, 'quick mode must not invent a whole-file frame count');
    // Sound: one source track calibrated from bounded actual first samples on both decoders.
    assert.equal(prepared.audio.length, 1);
    const track = prepared.audio[0]!;
    assert.equal(track.kind, 'source'); assert.equal(track.path, file);
    assert.equal(track.sampleRate, 48000);
    assert.ok(BigInt(track.offsetHns) >= 0n && BigInt(track.offsetHns) <= 50_000_000n, `unexpected audio origin ${track.offsetHns}`);

    // Display time of every boundary seek lands within the verified bound of the exact
    // source presentation time of that boundary's frame (window anchor correctness).
    for (const timeUs of [0, 510000, 1500000, 3333333, 5500000]) {
      const exact = await frameAtOrAfter(source, info, timeUs, ffmpeg());
      assert.ok(exact.found, `no source frame at/after ${timeUs}`);
      const truth = ptsToUs(exact.found!.pts.toString(), info.startPts, info.timeBase);
      const shown = await prepared.frames.frameAt(prepared.native, timeUs, 'after');
      assert.ok(Math.abs(shown.timeUs - truth) <= DISPLAY_TIME_BOUND_US,
        `display ${shown.timeUs} vs source ${truth} at ${timeUs}`);
      assert.equal(shown.identity, null, 'display frames carry no fabricated identity');
    }
    // 'before' boundary semantics: the last frame strictly before a frame time is its predecessor.
    const window = await decodePresentedWindow({ source, info, executable: ffmpeg(), signal: new AbortController().signal, count: 8 });
    const second = ptsToUs(window[1]!.pts.toString(), info.startPts, info.timeBase);
    const before = await prepared.frames.frameAt(prepared.native, second, 'before');
    assert.ok(Math.abs(before.timeUs - ptsToUs(window[0]!.pts.toString(), info.startPts, info.timeBase)) <= DISPLAY_TIME_BOUND_US);
    assert.ok(before.timeUs < second);
    assertNoFullMediaScan(activity, 'quick seeks');
  } finally { await release(prepared); await temp.cleanup(); }
});

// Ready means ready to hear: playback of the selected track starts the WASAPI clock without any
// whole-file preparation, and stepping/covers resolve exact source identity on demand.
test('quick playback runs the selected audio track on the audio clock without whole-file scans', { skip: !windows, timeout: 120000 }, async (t) => {
  if (!(await audioEndpointAvailable(helper))) { t.skip('此主机没有音频输出端点，实际 WASAPI 播放须在有音频设备的主机验证'); return; }
  const temp = await tempFiles();
  let prepared: PreparedQuickMedia | undefined; let timeline: NativeTimeline | undefined;
  try {
    const file = temp.file('play.mp4'); await generate(file);
    const source = await openSource(file);
    const probe = await probeMedia(file, { executable: ffprobe() });
    const info = mediaInfo(probe);
    const directory = temp.file('session'); await mkdir(directory);
    prepared = await prepareQuickMedia({ source, info, probe, directory, helper, ffmpeg: ffmpeg(),
      signal: new AbortController().signal, maximumEdge: 640 });
    const states: PreviewStatus[] = []; const shown: PreviewPixels[] = [];
    timeline = new NativeTimeline('asset', source, prepared, {
      frame(frame) {
        shown.push(frame);
        queueMicrotask(() => { timeline!.acknowledge({ assetId: 'asset', epoch: frame.epoch, frameId: frame.frameId, painted: true }); });
      },
      status(value) { states.push(value); },
    });
    const started = performance.now();
    const { activity } = await recordMediaActivity(async () => {
      await timeline!.control({ assetId: 'asset', epoch: 1, action: 'play', startUs: 0, endUs: 1_500_000, audioTrack: info.audioTracks[0]!.index });
      const { value: before } = await prepared!.native.request<{ primary: { seeks: number } }>({ command: 'stats' });
      await new Promise(resolve => setTimeout(resolve, 400));
      const { value: after } = await prepared!.native.request<{ primary: { seeks: number } }>({ command: 'stats' });
      assert.ok(after.primary.seeks - before.primary.seeks <= 2, 'time-clock playback must advance sequentially, not reseek every tick');
      await timeline!.control({ assetId: 'asset', epoch: 2, action: 'pause' });
      const last = shown.at(-1)!;
      assert.equal(last.pts, null, 'playback frames carry no fabricated identity');
    });
    t.diagnostic(`play ran ${Math.round(performance.now() - started)}ms`);
    assert.ok(shown.filter(frame => frame.epoch === 1).length >= 4, 'playing status alone is not evidence of moving pictures');
    assert.ok(!states.some(state => state.error), JSON.stringify(states));
    assert.ok(states.some(state => state.state === 'playing'), `playback states: ${JSON.stringify(states.map(s => s.state))}`);
    assert.ok(activity.native.some(row => row.command === 'audioStart'), 'sound must start with playback');
    assert.ok(activity.native.some(row => row.command === 'audioStatus'), 'the video clock must read the audio clock');
    assertNoFullMediaScan(activity, 'quick playback');
  } finally { await timeline?.dispose(); await release(prepared); await temp.cleanup(); }
});

test('quick step/cover resolve exact identities without whole-file scans', { skip: !windows, timeout: 120000 }, async () => {
  const temp = await tempFiles();
  let prepared: PreparedQuickMedia | undefined; let timeline: NativeTimeline | undefined;
  try {
    const file = temp.file('step.mp4'); await generate(file);
    const source = await openSource(file);
    const probe = await probeMedia(file, { executable: ffprobe() });
    const info = mediaInfo(probe);
    const directory = temp.file('session'); await mkdir(directory);
    prepared = await prepareQuickMedia({ source, info, probe, directory, helper, ffmpeg: ffmpeg(),
      signal: new AbortController().signal, maximumEdge: 640 });
    const shown: PreviewPixels[] = [];
    timeline = new NativeTimeline('asset', source, prepared, {
      frame(frame) {
        shown.push(frame);
        queueMicrotask(() => { timeline!.acknowledge({ assetId: 'asset', epoch: frame.epoch, frameId: frame.frameId, painted: true }); });
      },
      status() {},
    });
    let stepped: Awaited<ReturnType<typeof timeline.media.frames.step>> | undefined;
    let identity: { pts: string | null } | undefined;
    const { activity } = await recordMediaActivity(async () => {
      // Silent-clock playback (no audio endpoint needed) yields the same identity-less
      // display frames the audio path produces, preserving the original assertions.
      await timeline!.control({ assetId: 'asset', epoch: 1, action: 'play', startUs: 0, endUs: 1_500_000, audioTrack: null });
      const deadline = Date.now() + 5000;
      while (!shown.some(frame => frame.epoch === 1) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      await timeline!.control({ assetId: 'asset', epoch: 2, action: 'pause' });
      const last = shown.at(-1)!;
      assert.ok(last, 'silent playback must paint frames');
      assert.equal(last.pts, null, 'playback frames carry no fabricated identity');
      // Step resolves exact source identity on demand and moves exactly one presented frame.
      stepped = await timeline!.media.frames.step(prepared!.native, { timeUs: last.timeUs, identity: null, nativeHns: last.nativeHns }, 1);
      // Cover identity resolution pins the same displayed frame exactly.
      identity = await timeline!.media.frames.resolveIdentity(prepared!.native, { timeUs: last.timeUs, identity: null, nativeHns: last.nativeHns });
    });
    assert.ok(stepped?.identity, 'step must resolve exact identity');
    assert.ok(identity?.pts, 'cover resolution must return an exact source PTS');
    assert.notEqual(identity!.pts, stepped!.identity!.pts, 'the stepped frame is the successor of the resolved one');
    assertNoFullMediaScan(activity, 'quick step/cover');
  } finally { await timeline?.dispose(); await release(prepared); await temp.cleanup(); }
});

test('quick readiness decodes only the selected audio track, and explicit omission decodes none', { skip: !windows, timeout: 120000 }, async () => {
  const temp = await tempFiles(); let prepared: PreparedQuickMedia | undefined;
  try {
    const file = temp.file('multi.mp4');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', '-ac', '2', file]);
    const source = await openSource(file); const probe = await probeMedia(file, { executable: ffprobe() });
    const info = mediaInfo(probe); const directory = temp.file('session'); await mkdir(directory);
    assert.equal(info.audioTracks.length, 2);
    const selected = info.audioTracks[1]!.index;
    const options = { source, info, probe, directory, helper, ffmpeg: ffmpeg(), signal: new AbortController().signal };
    const result = await recordMediaActivity(() => prepareQuickMedia({ ...options, audioTrack: selected }));
    prepared = result.result;
    assert.deepEqual(prepared.audio.map(track => track.sourceIndex), [selected]);
    assert.equal(prepared.audio[0]!.sampleRate, 44100);
    const audioDecodes = result.activity.spawns.filter(row => row.args.includes('-frames:a'));
    assert.equal(audioDecodes.length, 1);
    assert.ok(audioDecodes[0]!.args.includes(`0:${selected}`));
    assert.equal(result.activity.native.filter(row => row.command === 'audioScanOpen').length, 1);
    assertNoFullMediaScan(result.activity, 'selected audio readiness');
    await release(prepared); prepared = undefined;
    const omitted = await recordMediaActivity(() => prepareQuickMedia({ ...options, audioTrack: null }));
    prepared = omitted.result;
    assert.equal(prepared.audio.length, 0);
    assert.ok(!omitted.activity.native.some(row => row.command.startsWith('audio')));
    assert.ok(!omitted.activity.spawns.some(row => row.args.includes('-frames:a')));
  } finally { await release(prepared); await temp.cleanup(); }
});
