import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, readFile, access, link } from 'node:fs/promises';
import { tempFiles, structuralInputs } from '../helpers.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { publishMotionPhoto, type PublicationIO } from '../../src/main/motion/publish.ts';
import { canonicalJpegHash } from '../../src/main/motion/hash-jpeg.ts';
import { openSource } from '../../src/main/media/source.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const io: PublicationIO = { freeBytes: async () => 1000000000n, commit: link };
async function setup() {
  const temp = await tempFiles(); const inputs = await structuralInputs(temp);
  const directory = temp.file('output'); await mkdir(directory); const journal = new Publications(temp.file('journal')); await journal.initialize();
  return { temp, directory, journal, options: { cover: await openSource(inputs.cover), video: await openSource(inputs.video),
    output: `${directory}/final.jpg`, timestampUs: 0, videoDurationUs: 1000000, journal, io, signal: new AbortController().signal } };
}
// Structural fixtures test transaction mechanics only; these do not prove video/image decoding or phone support.
test('publication read-back preserves canonical JPEG and exact MP4 bytes and never overwrites an existing target', async () => {
  const { temp, directory, journal, options } = await setup();
  try {
    const result = await publishMotionPhoto(options); const report = await validateMotion(options.output, true);
    assert.equal(result.profile, 'C-modern-xiaomi'); assert.equal(report.metadata.timestampUs, 0);
    assert.equal(await canonicalJpegHash(options.cover.path), await canonicalJpegHash(options.output));
    assert.equal(await sha256(options.video.path), await sha256(options.output, report.videoStart, report.videoEnd));
    const before = await sha256(options.output); await assert.rejects(publishMotionPhoto(options), { code: 'OUTPUT_EXISTS' });
    assert.equal(await sha256(options.output), before); assert.deepEqual(await readdir(directory), ['final.jpg']); assert.deepEqual(await readdir(journal.root), []);
  } finally { await temp.cleanup(); }
});
test('disk-space, write-lock and unsupported-publication injections fail without leaving a final or scratch', async () => {
  const { temp, directory, journal, options } = await setup();
  try {
    await assert.rejects(publishMotionPhoto({ ...options, io: { ...io, freeBytes: async () => 0n } }), { code: 'DISK_SPACE' });
    for (const [code, expected] of [['ENOSPC', 'DISK_SPACE'], ['EBUSY', 'OUTPUT_ACCESS'], ['ENOTSUP', 'OUTPUT_UNSUPPORTED']]) {
      await assert.rejects(publishMotionPhoto({ ...options, io: { ...io, commit: async () => { throw Object.assign(new Error('injected filesystem failure'), { code }); } } }), { code: expected });
      assert.deepEqual(await readdir(directory), []); assert.deepEqual(await readdir(journal.root), []);
    }
    await assert.rejects(publishMotionPhoto({ ...options, io: { ...io, commit: async (stage, output) => {
      await writeFile(output, 'created by a competing writer', { flag: 'wx' }); await link(stage, output);
    } } }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(options.output, 'utf8'), 'created by a competing writer'); assert.deepEqual(await readdir(journal.root), []);
  } finally { await temp.cleanup(); }
});
test('cancel before commit cleans up; cancel racing after the atomic link reports saved, not cancelled', async () => {
  const { temp, directory, journal, options } = await setup();
  try {
    const before = new AbortController();
    await assert.rejects(publishMotionPhoto({ ...options, signal: before.signal, onStage: stage => { if (stage === 'publish') before.abort(); } }), { code: 'CANCELLED' });
    assert.deepEqual(await readdir(directory), []); assert.deepEqual(await readdir(journal.root), []);
    const after = new AbortController(); let committed = false;
    const result = await publishMotionPhoto({ ...options, signal: after.signal,
      io: { ...io, commit: async (stage, output) => { await link(stage, output); after.abort(); } }, onCommitted: () => { committed = true; } });
    assert.equal(committed, true); assert.equal(result.name, 'final.jpg'); await validateMotion(options.output, true);
    assert.deepEqual(await readdir(directory), ['final.jpg']); assert.deepEqual(await readdir(journal.root), []);
  } finally { await temp.cleanup(); }
});
test('source replacement at the commit barrier and out-of-range cover timestamps cannot publish', async () => {
  const { temp, directory, options } = await setup();
  try {
    await assert.rejects(publishMotionPhoto({ ...options, timestampUs: 1000000 }), { code: 'INVALID_REQUEST' });
    await assert.rejects(publishMotionPhoto({ ...options, forbiddenRoots: [temp.directory] }), { code: 'OUTPUT_ACCESS' });
    await assert.rejects(publishMotionPhoto({ ...options, output: `${options.journal.root}/not-a-cache-result.jpg` }), { code: 'OUTPUT_ACCESS' });
    await assert.rejects(publishMotionPhoto({ ...options, onStage: async stage => { if (stage === 'publish') await writeFile(options.cover.path, 'replaced'); } }), { code: 'SOURCE_CHANGED' });
    assert.deepEqual(await readdir(directory), []); await assert.rejects(access(options.output), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});
test('post-commit scratch lock returns saved with a warning and keeps recovery ownership, never deletes the final', async () => {
  const { temp, directory, journal, options } = await setup();
  try {
    class LockedCleanup extends Publications { override async cleanup() { throw new Error('injected cleanup lock'); } }
    const locked = new LockedCleanup(journal.root); const result = await publishMotionPhoto({ ...options, journal: locked });
    assert.match(result.warnings.join(' '), /成品已保存/); assert.equal((await readdir(locked.root)).length, 1);
    const before = await readFile(options.output); assert.deepEqual(await journal.initialize(), []);
    assert.deepEqual(await readFile(options.output), before); assert.deepEqual(await readdir(directory), ['final.jpg']);
  } finally { await temp.cleanup(); }
});
