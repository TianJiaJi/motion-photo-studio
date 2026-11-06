import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { openSource } from '../../src/main/media/source.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { AppFailure } from '../../src/main/errors.ts';
import { runBatchExport, batchFileStem, batchFailure, type BatchOperations, type BatchExportOptions } from '../../src/main/media/batch-export.ts';
import type { SavedMotion } from '../../src/shared/export.ts';

async function fixture() {
  const temp = await tempFiles(); const sourcePath = temp.file('source'); await writeFile(sourcePath, 'source');
  const source = await openSource(sourcePath); const workDirectory = temp.file('work'), outputDirectory = temp.file('output');
  await mkdir(workDirectory); await mkdir(outputDirectory);
  const journal = new Publications(temp.file('journal')); await journal.initialize();
  const controller = new AbortController(); const analyzed: string[] = []; let serial = 0;
  const options: BatchExportOptions = { source, engines: { ffmpeg: '', ffprobe: '', build: 'mock' }, workDirectory, outputDirectory,
    baseName: 'movie.mp4', batchId: 'batch', mode: 'source', settings: { fps: null, resolution: 'original', crf: 16 },
    audio: { kind: 'omit' }, hdrConsent: false, journal, forbiddenRoots: [workDirectory], signal: controller.signal,
    jobs: [1, 2, 3].map(number => ({ clipId: String(number), index: number, number, selection: { startUs: number * 1000, endUs: number * 1000 + 1000 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, cover: { kind: 'auto' }, coverFit: 'cover', background: '#000000' })) };
  const saved = (output: string): SavedMotion => ({ name: basename(output), size: 1, profile: 'test', width: 2, height: 2, timestampUs: 0, durationUs: 1000, warnings: [] });
  const operations: Partial<BatchOperations> = {
    analyze: async (_source, request) => {
      assert.equal(request.processing.mode, 'source', 'source-following must not silently become packet copy');
      assert.deepEqual(await readdir(workDirectory), [], 'previous heavy draft must be released before next analysis');
      analyzed.push(String(request.clip.startUs));
      return { sourceStamp: source.stamp, options: request, plan: null,
        public: { id: String(request.clip.startUs), mode: 'source', supported: true, requested: request.clip, actual: request.clip, width: 2, height: 2, reasons: [], warnings: [] } };
    },
    render: async () => {
      const n = ++serial; const video = join(workDirectory, `${n}.mp4`), cover = join(workDirectory, `${n}.jpg`);
      await writeFile(video, 'video'); await writeFile(cover, 'cover');
      return { video: await openSource(video), cover: await openSource(cover), report: {
        durationUs: 1000, width: 2, height: 2, coverTimestampUs: 0, warnings: [], proof: { kind: 'encode', sourceMatched: true } } };
    },
    publish: async value => { await writeFile(value.output, 'saved', { flag: 'wx' }); const receipt = saved(value.output); value.onCommitted?.(receipt); return receipt; },
  };
  return { temp, options, operations, controller, analyzed, saved };
}
test('batch continues ordinary content errors and retains a single private draft', async () => {
  const h = await fixture();
  try {
    const analyze = h.operations.analyze!;
    const result = await runBatchExport(h.options, { ...h.operations, analyze: async (...args) => {
      if (args[1].clip.startUs === 2000) throw new AppFailure('INVALID_REQUEST', 'bad clip');
      return analyze(...args);
    } });
    assert.deepEqual(result.results.map(item => item.status), ['saved', 'failed', 'saved']);
    assert.equal(result.saved.length, 2); assert.equal(result.stopped, false);
    assert.deepEqual(await readdir(h.options.workDirectory), []);
  } finally { await h.temp.cleanup(); }
});
test('batch naming retries publication collisions without overwriting preexisting or raced files', async () => {
  const h = await fixture();
  try {
    h.options.jobs = h.options.jobs.slice(0, 1);
    const stem = batchFileStem('movie.mp4', 1); await writeFile(join(h.options.outputDirectory, `${stem}.jpg`), 'original');
    let attempts = 0;
    const result = await runBatchExport(h.options, { ...h.operations, publish: async value => {
      if (++attempts === 1) { await writeFile(value.output, 'racer', { flag: 'wx' }); throw new AppFailure('OUTPUT_EXISTS', 'race'); }
      return h.operations.publish!(value);
    } });
    assert.equal(result.saved[0]!.name, `${stem}-3.jpg`);
    assert.equal(await readFile(join(h.options.outputDirectory, `${stem}.jpg`), 'utf8'), 'original');
    assert.equal(await readFile(join(h.options.outputDirectory, `${stem}-2.jpg`), 'utf8'), 'racer');
  } finally { await h.temp.cleanup(); }
});
test('commit wins cancellation: completed file is saved, later clips are skipped, drafts are cleaned', async () => {
  const h = await fixture();
  try {
    const result = await runBatchExport(h.options, { ...h.operations, publish: async value => {
      await h.operations.publish!(value); h.controller.abort(); throw new AppFailure('CANCELLED', 'after commit');
    } });
    assert.equal(result.saved.length, 1); assert.equal(result.canceled, true);
    assert.deepEqual(result.results.map(item => item.status), ['saved', 'skipped', 'skipped']);
    assert.equal(result.results[0]!.error, null); assert.deepEqual(await readdir(h.options.workDirectory), []);
    assert.equal((await readdir(h.options.outputDirectory)).length, 1);
  } finally { await h.temp.cleanup(); }
});
for (const code of ['SOURCE_CHANGED', 'DISK_SPACE', 'OUTPUT_ACCESS', 'TEMP_CLEANUP'] as const)
  test(`batch stops globally on ${code}`, async () => {
    const h = await fixture(); let attempts = 0;
    try {
      const result = await runBatchExport(h.options, { ...h.operations, render: async () => { attempts++; throw new AppFailure(code, 'global failure'); } });
      assert.equal(attempts, 1); assert.equal(result.stopped, true); assert.equal(result.saved.length, 0);
      assert.equal(result.results[1]!.status, 'skipped');
    } finally { await h.temp.cleanup(); }
  });
test('cleanup failure after publication stops the batch but keeps the successful receipt', async () => {
  const h = await fixture();
  try {
    const result = await runBatchExport(h.options, { ...h.operations, publish: async value => {
      const saved = await h.operations.publish!(value); value.onCleanupFailure?.(); return saved;
    } });
    assert.equal(result.stopped, true); assert.equal(result.cleanupFailed, true); assert.equal(result.saved.length, 1);
    assert.equal(result.results[0]!.status, 'saved'); assert.equal(h.analyzed.length, 1);
  } finally { await h.temp.cleanup(); }
});
test('disk/access errors are batch-global even when wrapped by a media error', () => {
  assert.equal(batchFailure(new Error('ffmpeg: No space left on device')).code, 'DISK_SPACE');
  assert.equal(batchFailure(new AppFailure('MEDIA_FAILED', 'encoding failed', { cause: Object.assign(new Error(), { code: 'ENOSPC' }) })).code, 'DISK_SPACE');
  assert.equal(batchFailure(new AppFailure('OUTPUT_VERIFY', 'read-back failed', { cause: Object.assign(new Error(), { code: 'EIO' }) })).code, 'OUTPUT_ACCESS');
});
test('private draft cleanup failure drains other files, stops globally, and preserves the committed output', async () => {
  const h = await fixture(); const attempted: string[] = [];
  try {
    const result = await runBatchExport(h.options, { ...h.operations, cleanup: async path => {
      attempted.push(path); if (path.endsWith('.mp4')) throw new AppFailure('TEMP_CLEANUP', 'locked');
      await unlink(path);
    } });
    assert.equal(attempted.length, 2); assert.equal(result.cleanupFailed, true); assert.equal(result.stopped, true);
    assert.equal(result.saved.length, 1); assert.equal(result.results[0]!.status, 'saved'); assert.equal(h.analyzed.length, 1);
    assert.equal((await readdir(h.options.outputDirectory)).length, 1);
  } finally { await h.temp.cleanup(); }
});
test('cancellation before publication never invents a saved result', async () => {
  const h = await fixture();
  try {
    const result = await runBatchExport(h.options, { ...h.operations, publish: async () => { h.controller.abort(); throw new AppFailure('CANCELLED', 'before commit'); } });
    assert.equal(result.saved.length, 0); assert.equal(result.canceled, true); assert.equal(result.results[0]!.status, 'cancelled');
    assert.deepEqual(await readdir(h.options.workDirectory), []); assert.deepEqual(await readdir(h.options.outputDirectory), []);
  } finally { await h.temp.cleanup(); }
});
