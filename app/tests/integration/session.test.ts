import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { MediaSession } from '../../src/main/media/session.ts';
import { MediaResources } from '../../src/main/media/resources.ts';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { sha256 } from '../../src/main/motion/io.ts';

const engines = () => ({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'test-explicit-engine-paths' });
const ff = (args: string[]) => runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
async function fixture(path: string, seconds = 2, extra: string[] = []) {
  await ff(['-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=30:duration=${seconds}`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, path]);
}
async function harness() {
  const temp = await tempFiles();
  const store = new TempFiles(temp.file('sessions')); await store.initialize();
  const resources = new MediaResources(); const warnings: string[] = [];
  const manager = new MediaSession(engines(), store, resources, message => warnings.push(message));
  return { temp, store, resources, warnings, manager,
    cleanup: async () => { await manager.shutdown(); resources.dispose(); await temp.cleanup(); } };
}

test('media sessions import safely, cache thumbnails, pin covers, revoke old assets and leave inputs intact', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const input = h.temp.file('视频 source.mp4'); await fixture(input);
    const originalHash = await sha256(input);
    const asset = await h.manager.open(input);
    assert.equal(asset.name, '视频 source.mp4'); assert.equal('path' in asset, false);
    const preview = await h.manager.preview(asset.id, 0, false, false);
    assert.equal(preview.kind, 'original');
    const response = await h.resources.respond(new Request(preview.url, { headers: { Range: 'bytes=0-31' } }), 'app://ui');
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 32);
    const thumb = await h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 3, false);
    assert.equal(thumb.length, 3);
    assert.deepEqual(await h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 3, false), thumb);
    const frame = await h.manager.frame(asset.id, 510000, false);
    const next = await h.manager.frame(asset.id, frame.actualTimeUs, false, { cursor: frame.id, direction: 1 });
    assert.ok(BigInt(next.pts) > BigInt(frame.pts));
    const cover = await h.manager.coverFromFrame(asset.id, frame.actualTimeUs, false);
    const coverBytes = await (await h.resources.respond(new Request(cover.url), 'app://ui')).arrayBuffer();
    for (const time of [700000, 900000, 1100000, 1300000]) await h.manager.frame(asset.id, time, false);
    assert.equal((await h.resources.respond(new Request(frame.url), 'app://ui')).status, 404);
    assert.deepEqual(await (await h.resources.respond(new Request(cover.url), 'app://ui')).arrayBuffer(), coverBytes);
    const image = h.temp.file('uploaded.png');
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=240x180', '-frames:v', '1', '-update', '1', image]);
    const imageHash = await sha256(image);
    const uploaded = await h.manager.uploadCover(asset.id, image);
    assert.equal(uploaded.kind, 'custom'); assert.equal(uploaded.timeUs, null); assert.equal(uploaded.width, 240);
    assert.equal((await h.resources.respond(new Request(cover.url), 'app://ui')).status, 404);
    const fake = h.temp.file('not-an-image.png'); await writeFile(fake, '<svg>not a PNG</svg>');
    await assert.rejects(h.manager.uploadCover(asset.id, fake), { code: 'INVALID_REQUEST' });
    await assert.rejects(h.manager.open(fake), { code: 'MEDIA_FAILED' });
    assert.equal((await h.manager.preview(asset.id, 0, false, false)).url, preview.url, 'Failed imports must not replace the active source');
    await h.manager.close(asset.id);
    assert.equal((await h.resources.respond(new Request(uploaded.url), 'app://ui')).status, 404);
    assert.equal((await h.resources.respond(new Request(preview.url), 'app://ui')).status, 404);
    assert.deepEqual(await readdir(h.store.root), []);
    assert.equal(await sha256(input), originalHash); assert.equal(await sha256(image), imageHash);
    assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});

test('proxy previews are bounded windows and do not upscale small input or clamp source duration', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const input = h.temp.file('long-enough.mp4'); await fixture(input, 16);
    const asset = await h.manager.open(input);
    assert.equal(asset.info.durationUs, 16000000);
    const later = await h.manager.preview(asset.id, 12000000, true, false);
    assert.equal(later.kind, 'proxy'); assert.ok(later.startUs >= 10000000 && later.startUs < 10100000);
    assert.ok(later.endUs - later.startUs <= 12150000); assert.ok(later.endUs <= asset.info.durationUs);
    const copy = h.temp.file('read-back-proxy.mp4');
    await writeFile(copy, new Uint8Array(await (await h.resources.respond(new Request(later.url), 'app://ui')).arrayBuffer()));
    const result = mediaInfo(await probeMedia(copy, { executable: ffprobe() }));
    assert.equal(result.displayWidth, 160); assert.equal(result.displayHeight, 120); assert.equal(result.startUs, 0);
    const first = await h.manager.preview(asset.id, 0, true, false);
    assert.equal(first.startUs, 0); assert.ok(first.endUs <= 12150000);
    assert.equal((await h.resources.respond(new Request(later.url), 'app://ui')).status, 404);
    assert.equal((await h.manager.preview(asset.id, 1000000, true, false)).url, first.url, 'Reuse the existing window');
    const pending = h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 12, false);
    const cancelled = assert.rejects(pending, { code: 'CANCELLED' });
    await h.manager.cancel(asset.id); await cancelled;
    const [directory] = await readdir(h.store.root);
    const files = await readdir(join(h.store.root, directory!));
    assert.equal(files.filter(name => name.endsWith('.mp4')).length, 1);
    assert.equal(files.filter(name => name.endsWith('.start.jpg')).length, 0);
    await h.manager.shutdown(); assert.deepEqual(await readdir(h.store.root), []);
  } finally { await h.cleanup(); }
});

test('source changes fail closed and switching sources invalidates old session IDs', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const input = h.temp.file('source.mp4'); const second = h.temp.file('second.mp4');
    await fixture(input); await fixture(second, 1);
    const first = await h.manager.open(input);
    const original = await h.manager.preview(first.id, 0, false, false);
    const pendingImport = h.manager.open(second);
    const cancelledImport = assert.rejects(pendingImport, { code: 'CANCELLED' });
    await h.manager.cancelImport(); await cancelledImport;
    assert.equal((await h.manager.preview(first.id, 0, false, false)).url, original.url);
    const replacement = await h.manager.open(second);
    await assert.rejects(h.manager.frame(first.id, 0, false), { code: 'MEDIA_NOT_FOUND' });
    assert.equal((await h.resources.respond(new Request(original.url), 'app://ui')).status, 404);
    await writeFile(second, 'source modified outside application');
    await assert.rejects(h.manager.preview(replacement.id, 0, false, false), { code: 'SOURCE_CHANGED' });
    await h.manager.shutdown();
    assert.equal(await readFile(second, 'utf8'), 'source modified outside application');
    assert.deepEqual(await readdir(h.store.root), []);
  } finally { await h.cleanup(); }
});

test('nonzero source timestamps support exact frame stepping and zero-based proxies', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const offset = h.temp.file('offset.mp4'); await fixture(offset, 2, ['-output_ts_offset', '5']);
    const source = await h.manager.open(offset);
    assert.equal(source.info.startUs, 5000000); assert.equal(source.info.durationUs, 2000000);
    const beginning = await h.manager.frame(source.id, 0, false);
    assert.equal(beginning.actualTimeUs, 0); assert.equal(beginning.pts, source.info.startPts);
    const middle = await h.manager.frame(source.id, 510000, false);
    assert.ok(middle.actualTimeUs >= 510000 && middle.actualTimeUs < 600000);
    const following = await h.manager.frame(source.id, middle.actualTimeUs, false, { cursor: middle.id, direction: 1 });
    const preceding = await h.manager.frame(source.id, following.actualTimeUs, false, { cursor: following.id, direction: -1 });
    assert.equal(preceding.pts, middle.pts);
    const proxy = await h.manager.preview(source.id, 0, false, false);
    assert.equal(proxy.kind, 'proxy'); assert.equal(proxy.startUs, 0); assert.equal(proxy.mediaStartUs, 0);
  } finally { await h.cleanup(); }
});

for (const transfer of ['smpte2084', 'arib-std-b67']) {
  test(`${transfer} sources require explicit consent and produce SDR-tagged proxies`, { timeout: 120000 }, async () => {
    const h = await harness();
    try {
      const hdr = h.temp.file('hdr-tagged.mp4');
      // Tagged synthetic data tests consent, filter execution and signaling, not HDR visual fidelity.
      // This build takes primaries/transfer from frame properties; codec options alone are insufficient.
      await fixture(hdr, 1, ['-vf', `setparams=range=limited:color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`]);
      const tagged = await probeMedia(hdr, { executable: ffprobe() });
      assert.equal(tagged.streams[0]?.color_transfer, transfer, 'Verify the fixture actually carries HDR signaling');
      assert.equal(tagged.streams[0]?.color_primaries, 'bt2020');
      const asset = await h.manager.open(hdr); assert.equal(asset.info.hdr, true);
      await assert.rejects(h.manager.preview(asset.id, 0, false, false), { code: 'HDR_CONFIRM_REQUIRED' });
      await assert.rejects(h.manager.frame(asset.id, 0, false), { code: 'HDR_CONFIRM_REQUIRED' });
      await assert.rejects(h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 1, false), { code: 'HDR_CONFIRM_REQUIRED' });
      const preview = await h.manager.preview(asset.id, 0, false, true);
      assert.equal(preview.kind, 'proxy');
      const copy = h.temp.file('sdr-proxy.mp4');
      await writeFile(copy, new Uint8Array(await (await h.resources.respond(new Request(preview.url), 'app://ui')).arrayBuffer()));
      const output = await probeMedia(copy, { executable: ffprobe() });
      assert.equal(output.streams[0]?.color_transfer, 'bt709');
      assert.equal(output.streams[0]?.color_primaries, 'bt709');
      assert.equal(mediaInfo(output).hdr, false);
    } finally { await h.cleanup(); }
  });
}
