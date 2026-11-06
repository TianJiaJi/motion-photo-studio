import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { MediaResources } from '../../src/main/media/resources.ts';
import { MediaSession } from '../../src/main/media/session.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { createClip, type ClipModel } from '../../src/shared/editor.ts';
import type { ExportOptions } from '../../src/shared/export.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const scope = (clip: ClipModel) => ({ clipId: clip.id, revision: clip.revision });
const options = (clip: ClipModel): ExportOptions => ({ clip: clip.selection,
  processing: { mode: 'encode', crop: clip.crop, settings: { fps: 30, resolution: 'original', crf: 23 } }, audio: { kind: 'omit' }, hdrConsent: false });

test('20 overlapping clips own independent covers and revisions; drafts are scoped and heavy cache is bounded', { timeout: 120000 }, async () => {
  const temp = await tempFiles(); let manager: MediaSession | undefined; const resources = new MediaResources();
  try {
    const input = temp.file('source.mp4'), blue = temp.file('blue.png'), red = temp.file('red.png');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', input]);
    for (const [path, color] of [[blue, '#0000ff'], [red, '#ff0000']] as const)
      await sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).png().toFile(path);
    const original = await sha256(input);
    const store = new TempFiles(temp.file('sessions')); await store.initialize();
    const publications = new Publications(temp.file('journal')); await publications.initialize();
    manager = new MediaSession({ ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'test' }, store, resources, undefined, undefined, publications);
    const asset = await manager.open(input);
    let clips = Array.from({ length: 20 }, (_, i) => ({ ...createClip(i === 0 ? asset.id : randomUUID(),
      { startUs: (i % 3) * 200_000, endUs: 1_000_000 + (i % 3) * 200_000 }, asset.info.durationUs, i + 1), revision: i === 0 ? 1 : 0 }));
    await manager.syncClips(asset.id, clips);
    const first = clips[0]!, second = clips[1]!;
    const cover1 = await manager.uploadCover(asset.id, blue, scope(first));
    const cover2 = await manager.uploadCover(asset.id, red, scope(second));
    const exists = async (url: string) => { const reply = await resources.respond(new Request(url), 'app://ui'); await reply.arrayBuffer(); return reply.status; };
    assert.equal(await exists(cover1.url), 200); assert.equal(await exists(cover2.url), 200);
    const replacement = await manager.uploadCover(asset.id, blue, scope(second));
    assert.equal(await exists(cover1.url), 200); assert.equal(await exists(cover2.url), 404);
    const analysis1 = await manager.analyze(asset.id, options(first), scope(first));
    await assert.rejects(manager.renderDraft(asset.id, analysis1.id, { fit: 'cover', background: '#000000' }, scope(second)), { code: 'INVALID_REQUEST' });
    const draft1 = await manager.renderDraft(asset.id, analysis1.id, { fit: 'cover', background: '#000000' }, scope(first));
    const analysis2 = await manager.analyze(asset.id, options(second), scope(second));
    const draft2 = await manager.renderDraft(asset.id, analysis2.id, { fit: 'cover', background: '#000000' }, scope(second));
    assert.equal(await exists(draft1.videoUrl), 404, 'only one heavy single-clip draft is retained');
    assert.equal(await exists(draft2.videoUrl), 200); assert.equal(await exists(cover1.url), 200);
    assert.throws(() => manager!.assertDraft(asset.id, draft2.id, scope(first)), { code: 'INVALID_REQUEST' });
    clips = clips.map(c => c.id === first.id ? { ...c, revision: c.revision + 1, crop: { x: 0.1, y: 0, width: 0.8, height: 1 } } : c);
    await manager.syncClips(asset.id, clips);
    await assert.rejects(manager.uploadCover(asset.id, red, scope(first)), { code: 'INVALID_REQUEST' });
    assert.equal(await exists(draft2.videoUrl), 200, 'editing another clip must not invalidate this clip');
    await manager.clearCover(asset.id, scope(clips[0]!));
    assert.equal(await exists(cover1.url), 404); assert.equal(await exists(replacement.url), 200);
    const remaining = clips.filter(c => c.id !== second.id);
    await manager.syncClips(asset.id, remaining);
    assert.equal(await exists(replacement.url), 404); assert.equal(await exists(draft2.videoUrl), 404);
    await assert.rejects(manager.syncClips(asset.id, clips), { code: 'INVALID_REQUEST' });
    await assert.rejects(manager.syncClips(asset.id, []), { code: 'INVALID_REQUEST' });
    await manager.close(asset.id); assert.deepEqual(await readdir(store.root), []);
    assert.equal(await sha256(input), original);
  } finally { await manager?.shutdown(); await resources.dispose(); await temp.cleanup(); }
});
