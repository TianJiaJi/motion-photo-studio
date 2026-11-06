import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { MediaResources } from '../../src/main/media/resources.ts';
import { MediaSession } from '../../src/main/media/session.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { createClip, type ClipModel } from '../../src/shared/editor.ts';
import type { BatchSnapshot, ExportProgress, CancelResult } from '../../src/shared/export.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { probeMedia } from '../../src/main/media/probe.ts';

async function fixture(onProgress?: (progress: ExportProgress) => void) {
  const temp = await tempFiles(); const input = temp.file('source.mp4');
  await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', input]);
  const store = new TempFiles(temp.file('sessions')); await store.initialize();
  const publications = new Publications(temp.file('journal')); await publications.initialize();
  const resources = new MediaResources(), progress: ExportProgress[] = [];
  const manager = new MediaSession({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'test' }, store, resources, undefined, p => { progress.push(p); onProgress?.(p); }, publications);
  const asset = await manager.open(input); const output = temp.file('output'); await mkdir(output);
  function snapshot(clips: ClipModel[]): BatchSnapshot {
    return { assetId: asset.id, batchId: randomUUID(), mode: 'encode', settings: { fps: null, resolution: 'original', crf: 23 },
      audio: { kind: 'track', index: asset.info.audioTracks[0]!.index, downmixStereo: false }, hdrConsent: false,
      clips: clips.map(c => ({ clipId: c.id, revision: c.revision, selection: c.selection, crop: c.crop,
        cover: { kind: 'auto' }, coverFit: c.coverFit, background: c.background })) };
  }
  return { temp, input, manager, asset, output, snapshot, store, publications, progress,
    cleanup: async () => { await manager.shutdown(); await resources.dispose(); await temp.cleanup(); } };
}
test('batch exports three distinct and two overlapping clips as independently validated Motion Photos with audio', { timeout: 180000 }, async () => {
  const h = await fixture();
  try {
    const starts = [0, 1_000_000, 2_000_000, 500_000, 1_500_000];
    const clips = starts.map((startUs, i) => ({ ...createClip(i === 0 ? h.asset.id : randomUUID(), { startUs, endUs: startUs + 1_000_000 }, h.asset.info.durationUs, i + 1), revision: i === 0 ? 1 : 0 }));
    await h.manager.syncClips(h.asset.id, clips);
    await writeFile(join(h.output, 'source_片段01.jpg'), 'existing');
    let dialogs = 0;
    const result = await h.manager.exportAll(h.asset.id, h.snapshot(clips), async () => { dialogs++; return h.output; });
    assert.equal(dialogs, 1); assert.equal(result.saved.length, 5); assert.equal(result.stopped, false);
    assert.ok(result.results.every(item => item.status === 'saved'));
    assert.equal(result.saved[0]!.name, 'source_片段01-2.jpg');
    assert.ok(result.saved.every(saved => saved.warnings.some(warning => warning.includes('JPEG'))), 'draft warnings reach the batch result');
    assert.equal(await readFile(join(h.output, 'source_片段01.jpg'), 'utf8'), 'existing');
    for (const [i, saved] of result.saved.entries()) {
      const path = join(h.output, saved.name); const report = await validateMotion(path, true);
      assert.equal(report.metadata.timestampUs, 0); assert.equal(saved.durationUs, 1_000_000);
      const bytes = await readFile(path); const embedded = h.temp.file(`embedded-${i}.mp4`);
      await writeFile(embedded, bytes.subarray(report.videoStart, report.videoEnd));
      const probe = await probeMedia(embedded, { executable: ffprobe() });
      assert.equal(probe.streams.filter(stream => stream.codec_type === 'audio').length, 1);
      assert.equal(probe.streams.find(stream => stream.codec_type === 'video')?.width, 160);
    }
    assert.ok(h.progress.every(p => p.batch?.batchId === result.batchId && p.batch.total === 5));
    assert.equal(new Set(h.progress.map(p => p.batch?.clipId)).size, 5);
    const files = await readdir(h.store.root, { recursive: true });
    assert.ok(!files.some(path => /draft-.*\.mp4|cover-.*\.jpg/.test(path)));
    assert.deepEqual(await readdir(h.publications.root), []);
    const receipt = await h.manager.cancel(h.asset.id, undefined, result.batchId);
    assert.equal(receipt.batch?.saved.length, 5, 'late cancellation must preserve all completed receipts');
  } finally { await h.cleanup(); }
});
test('current clip uses the same batch pipeline without exporting other clips; stale/reordered subsets remain rejected', { timeout: 120000 }, async () => {
  const h = await fixture();
  try {
    const clips = [0, 1, 2].map(i => ({ ...createClip(i ? randomUUID() : h.asset.id, { startUs: i * 1_000_000, endUs: (i + 1) * 1_000_000 }, h.asset.info.durationUs, i + 1), revision: i ? 0 : 1 }));
    await h.manager.syncClips(h.asset.id, clips);
    const result = await h.manager.exportAll(h.asset.id, h.snapshot([clips[2]!]), async () => h.output);
    assert.equal(result.saved.length, 1); assert.equal(result.saved[0]!.name, 'source_片段03.jpg');
    assert.equal(result.results[0]!.number, 3); await validateMotion(join(h.output, result.saved[0]!.name), true);
    let dialogs = 0;
    const chooser = async () => { dialogs++; return h.output; };
    await assert.rejects(h.manager.exportAll(h.asset.id, h.snapshot([clips[2]!, clips[0]!]), chooser), { code: 'INVALID_REQUEST' });
    const stale = h.snapshot([clips[1]!]); stale.clips[0]!.revision++;
    await assert.rejects(h.manager.exportAll(h.asset.id, stale, chooser), { code: 'INVALID_REQUEST' });
    assert.equal(dialogs, 0); assert.deepEqual(await readdir(h.output), ['source_片段03.jpg']);
  } finally { await h.cleanup(); }
});
for (const stage of ['video', 'mux', 'publish']) {
  test(`real batch cancellation at ${stage} drains work and retains the previous committed file`, { timeout: 120000 }, async () => {
    let cancellation: Promise<CancelResult> | undefined;
    const h = await fixture(p => {
      if (p.batch?.index === 2 && p.stage === stage && !cancellation)
        cancellation = h.manager.cancel(h.asset.id, undefined, p.batch.batchId);
    });
    try {
      const clips = [0, 1].map((i) => ({ ...createClip(i === 0 ? h.asset.id : randomUUID(), { startUs: i * 1_000_000, endUs: (i + 1) * 1_000_000 }, h.asset.info.durationUs, i + 1), revision: i === 0 ? 1 : 0 }));
      await h.manager.syncClips(h.asset.id, clips);
      const result = await h.manager.exportAll(h.asset.id, h.snapshot(clips), async () => h.output);
      assert.ok(cancellation, 'the requested cancellation stage was reached');
      const receipt = await cancellation;
      assert.equal(result.canceled, true); assert.equal(result.saved.length, 1); assert.equal(receipt.batch?.saved.length, 1);
      assert.deepEqual(result.results.map(item => item.status), ['saved', 'cancelled']);
      assert.deepEqual(await readdir(h.output), [result.saved[0]!.name]);
      await validateMotion(join(h.output, result.saved[0]!.name), true);
      assert.deepEqual(await readdir(h.publications.root), []);
      const scratch = await readdir(h.store.root, { recursive: true });
      assert.ok(!scratch.some(path => /\.(mp4|jpg|png|m4a|wav)$/.test(path)), 'cancelled media workers leave no draft behind');
    } finally { await h.cleanup(); }
  });
}
test('source mutation between clips stops the batch without deleting the previously published file', { timeout: 120000 }, async () => {
  let changed = false;
  const h = await fixture(p => {
    if (p.batch?.index === 2 && !changed) { changed = true; writeFileSync(h.input, 'changed source'); }
  });
  try {
    const clips = [0, 1].map(i => ({ ...createClip(i === 0 ? h.asset.id : randomUUID(), { startUs: i * 1_000_000, endUs: (i + 1) * 1_000_000 }, h.asset.info.durationUs, i + 1), revision: i === 0 ? 1 : 0 }));
    await h.manager.syncClips(h.asset.id, clips);
    const result = await h.manager.exportAll(h.asset.id, h.snapshot(clips), async () => h.output);
    assert.equal(result.stopped, true); assert.equal(result.saved.length, 1);
    assert.equal(result.results[1]!.error?.code, 'SOURCE_CHANGED');
    await validateMotion(join(h.output, result.saved[0]!.name), true);
    assert.deepEqual(await readdir(h.output), [result.saved[0]!.name]);
  } finally { await h.cleanup(); }
});
test('batch freezes before the directory dialog; cancellation and dialog dismissal produce no files', { timeout: 120000 }, async () => {
  const h = await fixture();
  try {
    const clips = [createClip(h.asset.id, { startUs: 0, endUs: h.asset.info.durationUs }, h.asset.info.durationUs)];
    let choose!: (value: string | null) => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const snapshot = h.snapshot(clips);
    const run = h.manager.exportAll(h.asset.id, snapshot, () => { entered(); return new Promise(resolve => { choose = resolve; }); });
    await waiting;
    await assert.rejects(h.manager.syncClips(h.asset.id, clips), { code: 'JOB_BUSY' });
    await assert.rejects(h.manager.open(h.temp.file('another.mp4')), { code: 'JOB_BUSY' });
    const canceled = await h.manager.cancel(h.asset.id, undefined, snapshot.batchId);
    assert.equal(canceled.batch?.canceled, true); assert.equal((await run).saved.length, 0);
    choose(h.output); // a late directory response has no authority after cancellation
    const dismissed = await h.manager.exportAll(h.asset.id, h.snapshot(clips), async () => null);
    assert.equal(dismissed.canceled, true); assert.equal(dismissed.saved.length, 0);
    assert.deepEqual(await readdir(h.output), []);
  } finally { await h.cleanup(); }
});
