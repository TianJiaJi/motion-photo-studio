import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { MediaResources } from '../../src/main/media/resources.ts';
import { MediaSession } from '../../src/main/media/session.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import type { ExportProgress } from '../../src/shared/export.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';

// All fixtures are fixed three-second media; full file reads below are test backups, not production IO.
test('session saves only its exact current draft, reports commit receipts and rejects managed paths or changed/deleted sources', async () => {
  const temp = await tempFiles(); let manager: MediaSession | undefined;
  try {
    const input = temp.file('source.mp4'); const blue = temp.file('blue.png'); const red = temp.file('red.png'); const outputDir = temp.file('output'); await mkdir(outputDir);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    const backup = await readFile(input);
    for (const [path, color] of [[blue, '#0000ff'], [red, '#ff0000']]) await sharp({ create: { width: 40, height: 40, channels: 3, background: color! } }).png().toFile(path!);
    const store = new TempFiles(temp.file('sessions')); await store.initialize(); const journal = new Publications(temp.file('journal')); await journal.initialize();
    const resources = new MediaResources(); const progress: ExportProgress[] = [];
    manager = new MediaSession({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' }, store, resources, () => {}, p => progress.push(p), journal);
    const asset = await manager.open(input); await manager.uploadCover(asset.id, blue);
    const options = { clip: { startUs: 0, endUs: 2000000 }, processing: { mode: 'encode' as const, crop: { x: 0, y: 0, width: 1, height: 1 },
      settings: { fps: 30, resolution: 'original' as const, crf: 23 } }, audio: { kind: 'omit' as const }, hdrConsent: false };
    const analysis = await manager.analyze(asset.id, options); const image = { fit: 'cover' as const, background: '#000000' };
    const first = await manager.renderDraft(asset.id, analysis.id, image); assert.notEqual(first.id, analysis.id);
    const saveId = randomUUID(); const final = join(outputDir, 'saved.jpg'); const saved = await manager.saveDraft(asset.id, first.id, saveId, final);
    assert.equal((await validateMotion(final, true)).metadata.timestampUs, -1);
    assert.equal((await manager.cancel(asset.id, saveId)).saved?.name, 'saved.jpg');
    // Controlled state fault injection: an unrelated cache cleanup failure cannot erase a committed receipt.
    const state = (manager as unknown as { current: { cleanupFailed: boolean } }).current;
    state.cleanupFailed = true;
    const committed = await manager.cancel(asset.id, saveId);
    assert.equal(committed.saved?.name, 'saved.jpg'); assert.match(committed.saved!.warnings.join(' '), /缓存清理失败/);
    await assert.rejects(manager.cancel(asset.id), { code: 'TEMP_CLEANUP' }); state.cleanupFailed = false;
    const copied = progress.filter(p => p.saveId === saveId && p.stage === 'mux' && p.writtenBytes !== undefined).at(-1)!;
    assert.equal(copied.writtenBytes, saved.size); assert.equal(copied.totalBytes, saved.size);
    await assert.rejects(manager.saveDraft(asset.id, first.id, randomUUID(), join(store.root, 'must-not-save.jpg')), { code: 'OUTPUT_ACCESS' });
    await manager.uploadCover(asset.id, red);
    await assert.rejects(manager.saveDraft(asset.id, first.id, randomUUID(), join(outputDir, 'stale.jpg')), { code: 'INVALID_REQUEST' });
    const second = await manager.renderDraft(asset.id, analysis.id, image); assert.notEqual(second.id, first.id);
    await assert.rejects(manager.saveDraft(asset.id, first.id, randomUUID(), join(outputDir, 'old-token.jpg')), { code: 'INVALID_REQUEST' });
    await writeFile(input, 'changed by the test');
    await assert.rejects(manager.saveDraft(asset.id, second.id, randomUUID(), join(outputDir, 'changed.jpg')), { code: 'SOURCE_CHANGED' });
    assert.equal(await readFile(input, 'utf8'), 'changed by the test'); await manager.close(asset.id);
    await writeFile(input, backup); const reopened = await manager.open(input); const next = await manager.analyze(reopened.id, options);
    const nextDraft = await manager.renderDraft(reopened.id, next.id, image); await unlink(input);
    await assert.rejects(manager.saveDraft(reopened.id, nextDraft.id, randomUUID(), join(outputDir, 'deleted.jpg')), { code: 'SOURCE_CHANGED' });
    await assert.rejects(access(input), { code: 'ENOENT' });
    await manager.close(reopened.id); assert.deepEqual(await readdir(store.root), []); assert.deepEqual(await readdir(journal.root), []);
    assert.deepEqual(await readdir(outputDir), ['saved.jpg']); await validateMotion(final, true); await resources.dispose();
  } finally { await manager?.shutdown(); await temp.cleanup(); }
});
