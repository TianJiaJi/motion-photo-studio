import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { recordMediaActivity } from '../media-activity.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { LocalFrameResolver } from '../../src/main/media/local-frame-resolver.ts';
import { frameAtOrAfter } from '../../src/main/media/encode-plan.ts';
import { prepareQuickMedia, type PreparedQuickMedia } from '../../src/main/media/quick-import.ts';
const ffmpeg = resolve('resources/bin/ffmpeg.exe'), ffprobe = resolve('resources/bin/ffprobe.exe');
const helper = resolve('resources/bin/motion-preview.exe');
const skip = process.platform !== 'win32';
async function fixture(path: string) {
  await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-g', '90', path]);
  const source = await openSource(path), probe = await probeMedia(path, { executable: ffprobe });
  return { source, probe, info: mediaInfo(probe) };
}
test('local resolution reuses verified queries but checks source identity before every cache hit', { skip, timeout: 120000 }, async () => {
  const temp = await tempFiles();
  try {
    const input = await fixture(temp.file('source.mp4'));
    const resolver = new LocalFrameResolver({ ...input, executable: ffmpeg });
    const first = await resolver.resolveAt(500_000); const pair = await resolver.neighborsOf(first);
    assert.ok(pair.previous && pair.next);
    const hit = await recordMediaActivity(async () => {
      assert.deepEqual(await resolver.resolveAt(500_000), first);
      assert.deepEqual(await resolver.neighborsOf(first), pair);
    });
    assert.equal(hit.activity.spawns.length, 0, 'cache hits must not start fresh decoders');
    await appendFile(input.source.path, Buffer.from('modified'));
    await assert.rejects(resolver.resolveAt(500_000), { code: 'SOURCE_CHANGED' });
    await assert.rejects(resolver.neighborsOf(first), { code: 'SOURCE_CHANGED' });
    resolver.close();
    await assert.rejects(resolver.resolveAt(500_000), { code: 'CANCELLED' });
  } finally { await temp.cleanup(); }
});
test('interactive frame scans enforce a frame budget and cancel without killing the preview helper', { skip, timeout: 120000 }, async () => {
  const temp = await tempFiles(); let prepared: PreparedQuickMedia | undefined;
  try {
    const input = await fixture(temp.file('source.mp4'));
    await assert.rejects(frameAtOrAfter(input.source, input.info, 1_500_000, ffmpeg, undefined, undefined,
      { maxFrames: 1, maxBackUs: 1_000_000, timeoutMs: 15000 }), { code: 'LOCAL_FRAME_LIMIT' });
    const directory = temp.file('session'); await mkdir(directory);
    prepared = await prepareQuickMedia({ ...input, directory, helper, ffmpeg, signal: new AbortController().signal });
    const frame = await prepared.frames.frameAt(prepared.native, 500_000, 'after');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10);
    try { await assert.rejects(prepared.frames.step(prepared.native, frame, 1, abort.signal)); }
    finally { clearTimeout(timer); }
    assert.ok(prepared.native.alive);
    await prepared.native.hello();
    const identity = await prepared.frames.resolveIdentity(prepared.native, frame);
    assert.ok(identity.pts);
    await assert.rejects(prepared.frames.resolveIdentity(prepared.native, { ...frame, nativeHns: String(BigInt(frame.nativeHns!) + 100n) }), { code: 'FRAME_INDEX' });
    await assert.rejects(prepared.frames.resolveIdentity(prepared.native, { ...frame, nativeHns: undefined }), { code: 'FRAME_INDEX' });
  } finally { await prepared?.native.shutdown(); await prepared?.frames.close(); await temp.cleanup(); }
});
