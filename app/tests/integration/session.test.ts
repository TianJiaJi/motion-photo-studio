import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeSessionHarness as harness } from '../native-session-harness.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const ff = (args: string[]) => runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
async function fixture(path: string, seconds = 2, extra: string[] = []) {
  await ff(['-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=30:duration=${seconds}`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, path]);
}

test('native sessions cache thumbnails, pin confirmed covers, revoke old assets and leave inputs intact', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const input = h.temp.file('视频 source.mp4'); await fixture(input);
    const originalHash = await sha256(input),asset = await h.manager.open(input);
    assert.equal(asset.name, '视频 source.mp4'); assert.equal('path' in asset, false);
    await assert.rejects(h.manager.thumbnails(asset.id,0,asset.info.durationUs,3,false),{code:'ENGINE_NOT_READY'});
    await h.manager.prepareNative(asset.id,false);
    const thumb = await h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 3, false);
    assert.equal(thumb.length, 3);
    const response = await h.resources.respond(new Request(thumb[0]!.url, { headers: { Range: 'bytes=0-31' } }), 'app://ui');
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 32);
    assert.deepEqual(await h.manager.thumbnails(asset.id, 0, asset.info.durationUs, 3, false), thumb);
    const frame = await h.seek(asset.id,510000),next = await h.step(asset.id,frame.frameId,1);
    assert.ok(BigInt(next.pts) > BigInt(frame.pts));
    await assert.rejects(h.manager.nativeCover(asset.id,frame.frameId),{code:'FRAME_BOUNDARY'});
    const cover = await h.manager.nativeCover(asset.id,next.frameId);
    const coverBytes = await (await h.resources.respond(new Request(cover.url), 'app://ui')).arrayBuffer();
    for (const time of [700000, 900000, 1100000, 1300000]) await h.seek(asset.id,time);
    assert.deepEqual(await (await h.resources.respond(new Request(cover.url), 'app://ui')).arrayBuffer(), coverBytes);
    const image = h.temp.file('uploaded.png');
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=240x180', '-frames:v', '1', '-update', '1', image]);
    const imageHash = await sha256(image),uploaded = await h.manager.uploadCover(asset.id, image);
    assert.equal(uploaded.kind, 'custom'); assert.equal(uploaded.timeUs, null); assert.equal(uploaded.width, 240);
    assert.equal((await h.resources.respond(new Request(cover.url), 'app://ui')).status, 404);
    const fake = h.temp.file('not-an-image.png'); await writeFile(fake, '<svg>not a PNG</svg>');
    await assert.rejects(h.manager.uploadCover(asset.id, fake), { code: 'INVALID_REQUEST' });
    await assert.rejects(h.manager.open(fake), { code: 'MEDIA_FAILED' });
    assert.equal((await h.seek(asset.id,0)).assetId,asset.id,'Failed imports must not replace the active source');
    await h.manager.close(asset.id);
    for(const url of [uploaded.url,...thumb.map(t=>t.url)])assert.equal((await h.resources.respond(new Request(url), 'app://ui')).status,404);
    assert.deepEqual(await readdir(h.store.root), []);
    assert.equal(await sha256(input), originalHash); assert.equal(await sha256(image), imageHash);assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});

test('persistent preview crosses former proxy boundaries without upscaling, duration clamps or segment files', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const input = h.temp.file('long-enough.mp4'); await fixture(input, 16);
    const asset = await h.manager.open(input);assert.equal(asset.info.durationUs,16000000);
    assert.equal((await h.manager.prepareNative(asset.id,false)).compatibility,false);
    for(const time of [12000000,0,1000000,14000000]){
      const frame=await h.seek(asset.id,time);assert.equal(frame.timeUs,time);assert.equal(frame.width,160);assert.equal(frame.height,120);
    }
    const pending=h.manager.thumbnails(asset.id,0,asset.info.durationUs,12,false),cancelled=assert.rejects(pending,{code:'CANCELLED'});
    await h.manager.cancel(asset.id);await cancelled;
    const [directory]=await readdir(h.store.root),files=await readdir(join(h.store.root,directory!));
    assert.equal(files.filter(name=>name.endsWith('.mp4')||name.startsWith('proxy-')||name.endsWith('.start.jpg')).length,0);
    await h.manager.shutdown();assert.deepEqual(await readdir(h.store.root),[]);
  } finally { await h.cleanup(); }
});

test('source changes fail closed and switching sources invalidates old session IDs', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const input=h.temp.file('source.mp4'),second=h.temp.file('second.mp4');await fixture(input);await fixture(second,1);
    const first=await h.manager.open(input);await h.manager.prepareNative(first.id,false);
    const thumbs=await h.manager.thumbnails(first.id,0,first.info.durationUs,1,false);
    const pendingImport=h.manager.open(second),cancelledImport=assert.rejects(pendingImport,{code:'CANCELLED'});
    await h.manager.cancelImport();await cancelledImport;
    assert.equal((await h.seek(first.id,0)).assetId,first.id);
    const replacement=await h.manager.open(second);
    await assert.rejects(h.seek(first.id,0),{code:'MEDIA_NOT_FOUND'});
    assert.equal((await h.resources.respond(new Request(thumbs[0]!.url),'app://ui')).status,404);
    await writeFile(second,'source modified outside application');
    await assert.rejects(h.manager.prepareNative(replacement.id,false),{code:'SOURCE_CHANGED'});
    await h.manager.shutdown();assert.equal(await readFile(second,'utf8'),'source modified outside application');assert.deepEqual(await readdir(h.store.root),[]);
  } finally { await h.cleanup(); }
});

test('nonzero source timestamps retain integer source PTS and zero-based native stepping', { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const offset=h.temp.file('offset.mp4');await fixture(offset,2,['-output_ts_offset','5']);
    const source=await h.manager.open(offset);assert.equal(source.info.startUs,5000000);assert.equal(source.info.durationUs,2000000);
    await h.manager.prepareNative(source.id,false);
    const beginning=await h.seek(source.id,0);assert.equal(beginning.timeUs,0);assert.equal(beginning.pts,source.info.startPts);
    const middle=await h.seek(source.id,510000);assert.ok(middle.timeUs>=510000&&middle.timeUs<600000);
    const following=await h.step(source.id,middle.frameId,1),preceding=await h.step(source.id,following.frameId,-1);assert.equal(preceding.pts,middle.pts);
  } finally { await h.cleanup(); }
});

for(const transfer of ['smpte2084','arib-std-b67'])test(`${transfer} requires consent and prepares a whole-file SDR compatibility resource`,{timeout:120000},async()=>{
  const h=await harness();
  try{
    const hdr=h.temp.file('hdr-tagged.mp4');
    // Synthetic tags verify consent/filter/signaling, not HDR visual fidelity.
    await fixture(hdr,1,['-vf',`setparams=range=limited:color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`]);
    const tagged=await probeMedia(hdr,{executable:ffprobe()});assert.equal(tagged.streams[0]?.color_transfer,transfer);assert.equal(tagged.streams[0]?.color_primaries,'bt2020');
    const asset=await h.manager.open(hdr);assert.equal(asset.info.hdr,true);
    await assert.rejects(h.manager.prepareNative(asset.id,false),{code:'HDR_CONFIRM_REQUIRED'});
    await assert.rejects(h.manager.thumbnails(asset.id,0,asset.info.durationUs,1,false),{code:'HDR_CONFIRM_REQUIRED'});
    assert.equal((await h.manager.prepareNative(asset.id,true)).compatibility,true);
    const [directory]=await readdir(h.store.root),root=join(h.store.root,directory!),files=(await readdir(root)).filter(name=>name.endsWith('.mp4'));assert.equal(files.length,1);
    const output=await probeMedia(join(root,files[0]!),{executable:ffprobe()});assert.equal(output.streams[0]?.color_transfer,'bt709');assert.equal(output.streams[0]?.color_primaries,'bt709');assert.equal(mediaInfo(output).hdr,false);
    assert.equal(mediaInfo(output).durationUs,asset.info.durationUs);await h.seek(asset.id,500000);
  }finally{await h.cleanup();}
});
