import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { isTrustedRenderer, resolveAppResource, parseJobId, assertNoArgs, APP_URL } from '../../src/main/security.ts';
import { parseEngineManifest, verifyEngines } from '../../src/main/media/engine.ts';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { DiagnosticQueue } from '../../src/main/jobs/queue.ts';
import { reply } from '../../src/main/errors.ts';

test('renderer origin and resource paths are restricted to local application assets', () => {
  assert.equal(isTrustedRenderer(APP_URL), true);
  for (const url of ['https://example.com/', 'file:///C:/private.txt', 'app://other/index.html', 'app://ui/index.html?remote=1', 'app://ui/assets/evil.html']) {
    assert.equal(isTrustedRenderer(url), false);
  }
  assert.equal(isTrustedRenderer('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/'), true);
  assert.equal(isTrustedRenderer('http://127.0.0.1:5174/', 'http://127.0.0.1:5173/'), false);
  assert.equal(isTrustedRenderer('https://example.com/', 'https://example.com/'), false);
  const root = join(process.cwd(), 'renderer');
  assert.equal(resolveAppResource(root, 'app://ui/assets/main.js'), join(root, 'assets', 'main.js'));
  for (const url of ['file:///C:/private', 'app://evil/main.js', 'app://ui/%2e%2e%2fprivate', 'app://ui/%5cprivate', 'app://ui/%00']) {
    assert.throws(() => resolveAppResource(root, url));
  }
});

test('IPC arguments cannot carry arbitrary paths or shell commands', async () => {
  assertNoArgs([]);
  assert.throws(() => assertNoArgs(['-i', 'secret.mp4']));
  assert.throws(() => parseJobId(['C:\\private']));
  assert.throws(() => parseJobId(['123', 'extra']));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(parseJobId([id]), id);
  const result = await reply(() => { throw new Error('C:\\private\\secret'); });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('engine manifest rejects traversal, duplicates and unbounded sizes', () => {
  const good = { schemaVersion: 1, platform: 'win32', arch: 'x64', build: 'test', releaseStatus: 'internal-development-only',
    provenance: 'fixture', binaries: [{ name: 'ffmpeg.exe', sha256: 'a'.repeat(64), size: 123 }, { name: 'ffprobe.exe', sha256: 'b'.repeat(64), size: 123 }] };
  assert.equal(parseEngineManifest(good).build, 'test');
  assert.throws(() => parseEngineManifest({ ...good, binaries: [good.binaries[0], good.binaries[0]] }));
  assert.throws(() => parseEngineManifest({ ...good, binaries: [{ ...good.binaries[0], name: '../engine.exe' }, good.binaries[1]] }));
  assert.throws(() => parseEngineManifest({ ...good, binaries: [{ ...good.binaries[0], size: 2 ** 54 }, good.binaries[1]] }));
});

test('missing and tampered engines fail closed without a PATH fallback', async () => {
  const temp = await tempFiles();
  try {
    await assert.rejects(verifyEngines(temp.directory), { code: 'ENGINE_MISSING' });
    await mkdir(temp.file('bin'));
    await writeFile(temp.file('engine-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64', build: 'fixture',
      releaseStatus: 'internal-development-only', provenance: 'fixture', binaries: [
        { name: 'ffmpeg.exe', sha256: 'a'.repeat(64), size: 3 }, { name: 'ffprobe.exe', sha256: 'b'.repeat(64), size: 3 },
      ] }));
    await writeFile(join(temp.directory, 'bin/ffmpeg.exe'), 'bad');
    const stages: string[] = [];
    await assert.rejects(verifyEngines(temp.directory, progress => stages.push(progress.stage)), { code: 'ENGINE_INTEGRITY' });
    assert.deepEqual(stages, ['manifest', 'integrity'], 'Tampered binary never reaches launch/version verification');
  } finally { await temp.cleanup(); }
});

test('temporary cleanup only removes marked, owned job directories', async () => {
  const temp = await tempFiles();
  try {
    const store = new TempFiles(temp.file('jobs'));
    await store.initialize();
    const owned = await store.create();
    await writeFile(join(owned, 'clip.mp4'), 'fixture');
    await mkdir(join(store.root, 'user-files'));
    await mkdir(join(store.root, 'job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    const warnings = await store.initialize();
    assert.equal(warnings.length, 1);
    assert.deepEqual((await readdir(store.root)).sort(), ['job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'user-files']);
    await assert.rejects(store.remove(temp.directory));
  } finally { await temp.cleanup(); }
});

test('single activity queue cancels and cleans its workspace before shutdown', async () => {
  const temp = await tempFiles();
  try {
    const store = new TempFiles(temp.file('jobs')); await store.initialize();
    const queue = new DiagnosticQueue(store, () => {});
    const engines = { ffmpeg: 'no-such-ffmpeg', ffprobe: 'no-such-ffprobe', build: 'fixture' };
    const id = queue.start(engines);
    assert.throws(() => queue.start(engines), { code: 'JOB_BUSY' });
    assert.throws(() => queue.cancel('wrong'), { code: 'JOB_NOT_FOUND' });
    queue.cancel(id);
    await queue.shutdown();
    assert.equal(queue.snapshot()?.state, 'cancelled');
    assert.deepEqual(await readdir(store.root), []);
  } finally { await temp.cleanup(); }
});
