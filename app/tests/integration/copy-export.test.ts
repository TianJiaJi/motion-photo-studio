import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { assessCopySupport, probeCopySource } from '../../src/main/media/copy-support.ts';
import { planCopyRange } from '../../src/main/media/copy-plan.ts';
import { exportCopyMedia, verifyCopyOutput } from '../../src/main/media/copy-export.ts';
import { ptsToUs, usToSeconds } from '../../src/shared/editor.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { scanPackets, type MediaPacket } from '../../src/main/media/packets.ts';

const engines = () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-fixture' });
async function fixture(path: string, kind: 'closed' | 'offset' | 'vfr' = 'closed') {
  await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-map', '0:v:0', '-map', '1:a:0',
    ...(kind === 'vfr' ? ['-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', `keyint=${kind === 'vfr' ? 30 : 60}:min-keyint=1:scenecut=0:open-gop=0:bframes=3`,
    '-c:a', 'aac', ...(kind === 'offset' ? ['-output_ts_offset', '5'] : []), path]);
}
async function prepare(path: string, startUs = 2200000, endUs = 3200000) {
  const source = await openSource(path); const sourceProbe = await probeCopySource(source, ffprobe());
  const support = assessCopySupport(sourceProbe, true);
  assert.equal(support.supported, true, JSON.stringify(support));
  if (!support.supported) throw new Error('fixture unsupported');
  const plan = await planCopyRange(source, support.video, { startUs, endUs }, { executable: ffprobe() });
  return { source, sourceProbe, support, plan };
}
for (const kind of ['closed', 'offset', 'vfr', 'rotated'] as const) {
  test(`verified copy draft retains video and complete AAC packet interval (${kind})`, async () => {
    const temp = await tempFiles();
    try {
      const input = temp.file('原片.mp4');
      if (kind === 'rotated') {
        const base = temp.file('base.mp4'); await fixture(base);
        await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-display_rotation:v:0', '90', '-i', base, '-c', 'copy', input]);
      } else await fixture(input, kind);
      const before = await sha256(input);
      const prepared = await prepare(input, kind === 'vfr' ? 1100000 : 2200000, kind === 'vfr' ? 1200000 : 3200000);
      const stages: string[] = [];
      const result = await exportCopyMedia({ ...prepared, output: temp.file('verified.mp4'), keepAudio: true,
        engines: engines(), signal: new AbortController().signal, onStage: stage => { stages.push(stage); } });
      assert.deepEqual(stages, ['copy', 'verify-packets', 'verify-source-audio', 'decode']);
      assert.equal(result.report.videoPackets, kind === 'vfr' ? 30 : 60);
      assert.ok(result.report.audio); assert.equal(result.report.audio.playableStartUs, 0);
      assert.ok(result.report.audio.tailBeyondVideoUs >= 0 && result.report.audio.tailBeyondVideoUs < 22000);
      if (kind !== 'vfr') assert.equal(result.report.audio.packets, 98);
      const observed: { first?: MediaPacket } = {};
      await scanPackets({ executable: ffprobe(), input: result.file.path, onPacket: packet => {
        if (packet.streamIndex === 1) { observed.first = packet; return true; }
      } });
      assert.ok(observed.first);
      assert.equal(observed.first.pts! + BigInt(observed.first.skipSamples), 0n);
      assert.equal(result.report.audio.skippedSamples, observed.first.skipSamples);
      // Nonzero MOV/MP4 edit offsets can change the sample grid (this fixture uses 3872, not 3840).
      assert.equal(result.report.audio.skippedSamples, Math.round(-result.report.audio.packetStartUs * 48000 / 1000000));
      assert.equal(result.report.payloadDigest, prepared.plan.payloadDigest);
      assert.equal(await sha256(input), before);
    } finally { await temp.cleanup(); }
  });
}

test('copy draft never overwrites input/existing output and removes cancelled or unverified drafts', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); await fixture(input); const before = await sha256(input);
    const prepared = await prepare(input); const output = temp.file('draft.mp4');
    const common = { ...prepared, keepAudio: true, engines: engines() };
    await writeFile(output, 'keep-me');
    await assert.rejects(exportCopyMedia({ ...common, output, signal: new AbortController().signal }), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), 'keep-me');
    await assert.rejects(exportCopyMedia({ ...common, output: input, signal: new AbortController().signal }), /overwrite/);
    const cancelled = temp.file('cancelled.mp4'); const controller = new AbortController();
    await assert.rejects(exportCopyMedia({ ...common, output: cancelled, signal: controller.signal,
      onStage: stage => { if (stage === 'verify-packets') controller.abort(); } }), /abort|cancel/i);
    await assert.rejects(access(cancelled), { code: 'ENOENT' });
    const invalid = temp.file('invalid.mp4');
    await assert.rejects(exportCopyMedia({ ...common, output: invalid, plan: { ...prepared.plan, payloadDigest: '0'.repeat(64) },
      signal: new AbortController().signal }), /压缩包或归一化帧时序/);
    await assert.rejects(access(invalid), { code: 'ENOENT' });
    assert.equal(await sha256(input), before);
  } finally { await temp.cleanup(); }
});

test('matching copied audio hashes alone cannot hide a missing final AAC packet', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); await fixture(input); const prepared = await prepare(input);
    const startUs = ptsToUs(prepared.plan.startPts, '0', prepared.plan.timeBase); const output = temp.file('short-audio.mp4');
    await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-copyts', '-seek_timestamp', '1',
      '-ss', usToSeconds(startUs), '-noaccurate_seek', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
      '-frames:v', String(prepared.plan.packetCount), '-shortest', '-output_ts_offset', usToSeconds(-startUs), '-avoid_negative_ts', 'disabled', output]);
    await assert.rejects(verifyCopyOutput({ ...prepared, output: await openSource(output), engines: engines(),
      signal: new AbortController().signal }), /遗漏/);
  } finally { await temp.cleanup(); }
});

test('copy handles the source EOF, explicitly removed audio and an originally silent input', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); await fixture(input); const before = await sha256(input);
    const tail = await prepare(input, 4200000, 6000000);
    assert.equal(tail.plan.endKind, 'eof');
    const result = await exportCopyMedia({ ...tail, output: temp.file('tail.mp4'), keepAudio: true,
      engines: engines(), signal: new AbortController().signal });
    assert.equal(result.report.videoDurationUs, 2000000); assert.equal(result.report.audio?.playableEndUs, 2000000);
    const selected = await prepare(input);
    const removed = await exportCopyMedia({ ...selected, output: temp.file('removed.mp4'), keepAudio: false,
      engines: engines(), signal: new AbortController().signal });
    assert.equal(removed.report.audio, null); assert.match(removed.report.warnings.join(' '), /明确选择不保留/);
    const silentInput = temp.file('silent-input.mp4');
    await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-i', input, '-map', '0:v:0', '-an', '-c', 'copy', silentInput]);
    const silent = await exportCopyMedia({ ...await prepare(silentInput), output: temp.file('silent-copy.mp4'), keepAudio: true,
      engines: engines(), signal: new AbortController().signal });
    assert.equal(silent.report.audio, null);
    assert.equal(await sha256(input), before);
  } finally { await temp.cleanup(); }
});

async function audioTimingFixture(path: string, gap: boolean) {
  await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
    ...(!gap ? ['-itsoffset', '3'] : []), '-f', 'lavfi', '-i', `sine=sample_rate=48000:duration=${gap ? 6 : 3}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:bframes=3',
    ...(gap ? ['-af', "aselect='not(between(t,1,3))'"] : []), '-c:a', 'aac', path]);
}
test('copy retains a delayed audio start and does not invent audio outside the source track range', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('delayed.mp4'); await audioTimingFixture(input, false);
    const selected = await prepare(input);
    const result = await exportCopyMedia({ ...selected, output: temp.file('delayed-copy.mp4'), keepAudio: true,
      engines: engines(), signal: new AbortController().signal });
    assert.ok(result.report.audio); assert.ok(result.report.audio.playableStartUs > 900000 && result.report.audio.playableStartUs < 1100000);
    const original = selected.sourceProbe.streams.find(s => s.codec_type === 'audio')!;
    assert.equal(result.report.audio.playableStartUs, Math.floor(original.start_pts! * 1000000 / 48000) - 2000000);
    const beforeAudio = await prepare(input, 100000, 1200000);
    const silent = await exportCopyMedia({ ...beforeAudio, output: temp.file('before-audio.mp4'), keepAudio: true,
      engines: engines(), signal: new AbortController().signal });
    assert.equal(silent.report.audio, null); assert.match(silent.report.warnings.join(' '), /不重叠/);
  } finally { await temp.cleanup(); }
});

test('discontinuous AAC is rejected rather than confusing timestamp gaps with skippable decoded samples', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('gap.mp4'); await audioTimingFixture(input, true); const selected = await prepare(input);
    let previous: MediaPacket | undefined; let hasGap = false;
    await scanPackets({ executable: ffprobe(), input, onPacket: packet => {
      if (packet.streamIndex !== selected.support.audio!.index) return;
      if (packet.duration! > 1024n || previous && packet.pts !== previous.pts! + previous.duration!) hasGap = true;
      previous = packet;
    } });
    assert.equal(hasGap, true, 'fixture must actually have an audio timestamp discontinuity');
    const output = temp.file('must-not-succeed.mp4');
    await assert.rejects(exportCopyMedia({ ...selected, output, keepAudio: true,
      engines: engines(), signal: new AbortController().signal }), /间断|重叠/);
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});

test('a source replacement during validation is reported and the owned draft is removed', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('input.mp4'); await fixture(input); const selected = await prepare(input);
    const output = temp.file('draft.mp4');
    await assert.rejects(exportCopyMedia({ ...selected, output, keepAudio: true, engines: engines(), signal: new AbortController().signal,
      onStage: async stage => { if (stage === 'verify-packets') await writeFile(input, 'deliberate test replacement'); },
    }), { code: 'SOURCE_CHANGED' });
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.equal(await readFile(input, 'utf8'), 'deliberate test replacement');
  } finally { await temp.cleanup(); }
});
