import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { openSource } from '../../src/main/media/source.ts';
import { planEncodeRange } from '../../src/main/media/encode-plan.ts';
import { exportEncodedMedia } from '../../src/main/media/encode-export.ts';
import { MOTION_VIDEO_TRANSFER, videoProcessing } from '../../src/main/media/video-processing.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const engines = () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' });
const clip = { startUs: 1010000, endUs: 1990000 };
const edits = { crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, settings: { fps: null, resolution: 'original' as const, crf: 0 } };
const sdr = 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
async function fixture(path: string, kind = 'cfr', fps = 30) {
  await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=${fps}:duration=4`,
    '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=4', '-vf', (kind === 'vfr' ? "select='not(mod(n,3))+not(mod(n,5))'," : '') + sdr,
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...(kind === 'offset' ? ['-output_ts_offset', '5'] : []), path]);
}
for (const kind of ['cfr', 'offset', 'vfr', 'rotated']) test(`normal A/V encoding preserves precise endpoints and maps a real cover frame (${kind})`, async () => {
  const temp = await tempFiles();
  try {
    let input = temp.file('source.mp4'); await fixture(input, kind);
    if (kind === 'rotated') {
      const rotated = temp.file('rotated.mp4');
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-display_rotation:v:0', '90', '-i', input, '-c', 'copy', rotated]); input = rotated;
    }
    const source = await openSource(input); const before = await sha256(input); const probe = await probeMedia(input); const info = mediaInfo(probe);
    const plan = await planEncodeRange(source, probe, clip, { executable: ffmpeg() });
    const output = temp.file('encoded.mp4');
    const result = await exportEncodedMedia({ source, clip, edits, hdrConsent: false, audio: { kind: 'track', index: 1, downmixStereo: false },
      coverSourcePts: plan.startPts, output, engines: engines(), signal: new AbortController().signal });
    assert.equal(result.report.coverTimestampUs, 0); assert.equal(result.report.audio?.channels, 1);
    assert.deepEqual([result.report.width, result.report.height], kind === 'rotated' ? [60, 160] : [80, 120]);
    assert.equal(result.report.videoDurationUs, kind === 'vfr' ? 900000 : 966666);
    // CRF 0 permits an exact first-frame raster comparison. Select the independently planned source PTS,
    // without the production seek/trim chain, and apply only the spatial/color processing being tested.
    const processing = videoProcessing(info, probe.streams.find(s => s.index === info.videoIndex)!, edits, false, MOTION_VIDEO_TRANSFER);
    const expected = await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-copyts', '-i', input, '-map', `0:${info.videoIndex}`, '-an',
      '-vf', `select='eq(pts,${plan.startPts})',${processing.filters.join(',')}`, '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'rawvideo', '-f', 'hash', '-hash', 'sha256', '-']);
    const actual = await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-i', output, '-map', '0:v', '-an', '-frames:v', '1', '-c:v', 'rawvideo', '-f', 'hash', '-hash', 'sha256', '-']);
    assert.equal(actual.stdout.trim(), expected.stdout.trim());
    assert.equal(await sha256(input), before); await assert.rejects(access(`${output}.audio.mp4`), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});

test('FPS conversion carries frame provenance only when that source frame actually survives', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('sixty.mp4'); await fixture(input, 'cfr', 60); const source = await openSource(input);
    const info = mediaInfo(await probeMedia(input)); const tick = BigInt(info.timeBase.denominator) / (60n * BigInt(info.timeBase.numerator));
    for (const [frame, expected] of [[1, -1], [2, 33333], [90, -1]]) {
      const result = await exportEncodedMedia({ source, clip: { startUs: 0, endUs: 1000000 },
        edits: { ...edits, settings: { fps: 30, resolution: 'original', crf: 23 } }, hdrConsent: false, audio: { kind: 'omit' },
        coverSourcePts: String(tick * BigInt(frame!)), output: temp.file(`frame-${frame}.mp4`), engines: engines(), signal: new AbortController().signal });
      assert.equal(result.report.coverTimestampUs, expected); assert.equal(result.report.videoDurationUs, 1000000); assert.equal(result.report.audio, null);
    }
  } finally { await temp.cleanup(); }
});

test('normal encoding converts synthetic PQ/HLG only with consent and leaves normalized SDR metadata', async () => {
  const temp = await tempFiles();
  try {
    for (const transfer of ['smpte2084', 'arib-std-b67']) {
      const input = temp.file(`${transfer}.mp4`);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
        '-vf', `setparams=range=limited:color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`, '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
        '-x265-params', 'log-level=error:pools=1:frame-threads=1', input]);
      const options = { source: await openSource(input), clip, edits, audio: { kind: 'omit' as const }, output: temp.file(`${transfer}-out.mp4`), engines: engines(), signal: new AbortController().signal };
      await assert.rejects(exportEncodedMedia({ ...options, hdrConsent: false }), { code: 'HDR_CONFIRM_REQUIRED' });
      await assert.rejects(access(options.output), { code: 'ENOENT' });
      const result = await exportEncodedMedia({ ...options, hdrConsent: true });
      assert.match(result.report.warnings.join(' '), /HDR→SDR/);
      const normalized = await probeMedia(result.file.path);
      assert.equal(mediaInfo(normalized).hdr, false);
      assert.deepEqual([normalized.streams[0]?.color_primaries, normalized.streams[0]?.color_transfer, normalized.streams[0]?.color_space, normalized.streams[0]?.color_range],
        ['bt709', 'iec61966-2-1', 'bt709', 'tv']);
    }
  } finally { await temp.cleanup(); }
});

test('normal encoding protects existing files and cleans video/audio drafts on cancellation', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); await fixture(input); const source = await openSource(input); const output = temp.file('existing.mp4');
    const options = { source, clip, edits, hdrConsent: false, audio: { kind: 'track' as const, index: 1, downmixStereo: false }, output, engines: engines(), signal: new AbortController().signal };
    await writeFile(output, 'sentinel'); await assert.rejects(exportEncodedMedia(options), { code: 'EEXIST' }); assert.equal(await readFile(output, 'utf8'), 'sentinel');
    await assert.rejects(exportEncodedMedia({ ...options, output: input }), /overwrite/);
    const controller = new AbortController(); const draft = temp.file('cancelled.mp4');
    await assert.rejects(exportEncodedMedia({ ...options, output: draft, signal: controller.signal,
      onStage: stage => { if (stage === 'video') controller.abort(); } }));
    await assert.rejects(access(draft), { code: 'ENOENT' }); await assert.rejects(access(`${draft}.audio.mp4`), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});

async function rms(path: string, start: number, end: number): Promise<number> {
  const result = await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-vn', '-af',
    `atrim=start=${start}:end=${end},astats=metadata=1:reset=0,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file='pipe\\:1':direct=1`, '-f', 'null', '-']);
  const values = [...result.stdout.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)];
  assert.ok(values.length); const value = values.at(-1)![1]!; return value === '-inf' ? -Infinity : Number(value);
}
test('normal audio decoding preserves real sound after a gap instead of consuming it as seek padding', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('gap.mp4');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=6', '-vf', sdr,
      '-af', "aselect='not(between(t,1,3))'", '-c:v', 'libx264', '-c:a', 'aac', input]);
    const result = await exportEncodedMedia({ source: await openSource(input), clip: { startUs: 2010000, endUs: 3990000 }, edits,
      hdrConsent: false, audio: { kind: 'track', index: 1, downmixStereo: false }, output: temp.file('out.mp4'), engines: engines(), signal: new AbortController().signal });
    assert.ok(await rms(result.file.path, 0.2, 0.6) < -60, 'original gap stays silent');
    assert.ok(await rms(result.file.path, 1.2, 1.7) > -40, 'later original tone must remain audible');
  } finally { await temp.cleanup(); }
});
test('surround audio is never silently downmixed in normal mode', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('surround.mp4');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1:d=3', '-vf', sdr, '-c:v', 'libx264', '-c:a', 'aac', input]);
    const options = { source: await openSource(input), clip, edits, hdrConsent: false, output: temp.file('downmix.mp4'), engines: engines(), signal: new AbortController().signal };
    await assert.rejects(exportEncodedMedia({ ...options, audio: { kind: 'track', index: 1, downmixStereo: false } }), /明确同意/);
    await assert.rejects(access(options.output), { code: 'ENOENT' });
    const result = await exportEncodedMedia({ ...options, audio: { kind: 'track', index: 1, downmixStereo: true } });
    assert.equal(result.report.audio?.channels, 2); assert.match(result.report.warnings.join(' '), /降混/);
  } finally { await temp.cleanup(); }
});
test('SAR normalization and VFR EOF also work with a partial final resampled frame', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('sar-vfr.mp4');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=4',
      '-vf', `select='not(mod(n,3))+not(mod(n,5))',setsar=4/3,${sdr}`, '-fps_mode', 'vfr', '-c:v', 'libx264', input]);
    const source = await openSource(input); const info = mediaInfo(await probeMedia(input));
    for (const fps of [null, 24]) {
      const result = await exportEncodedMedia({ source, clip: { startUs: 2210000, endUs: info.durationUs },
        edits: { crop: { x: 0, y: 0, width: 1, height: 1 }, settings: { fps, resolution: 'original', crf: 23 } },
        hdrConsent: false, audio: { kind: 'omit' }, output: temp.file(`eof-${fps}.mp4`), engines: engines(), signal: new AbortController().signal });
      assert.deepEqual([result.report.width, result.report.height], [212, 120]); assert.equal(result.report.plan.endKind, 'eof');
      assert.equal(result.report.plan.actual.startUs, 2300000);
      // The source's MP4 edit list can round its EOF to the movie clock. Preserve the probed
      // source endpoint, not a synthetic 1/30-second tail inferred from the generator command.
      assert.equal(result.report.videoDurationUs, info.durationUs - 2300000);
    }
  } finally { await temp.cleanup(); }
});
