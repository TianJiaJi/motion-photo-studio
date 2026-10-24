import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
import { sha256 } from '../../src/main/motion/io.ts';
type ReaderStats = { cache: { bytes: number; entries: number; budget: number; hits: number; misses: number }; seeks: number; decodedSamples: number };
type Stats = { primary: ReaderStats; thumbnail: ReaderStats | null };
test('native LRU, adjacent reads, prefetch and separate thumbnails preserve foreground position', { skip:process.platform!=='win32',timeout:60000 },async()=>{
  const temp=await tempFiles(); let prepared:PreparedNativeMedia|undefined;
  const ffmpeg=resolve('resources/bin/ffmpeg.exe'),ffprobe=resolve('resources/bin/ffprobe.exe');
  try {
    const path=temp.file('source.mp4'); await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=2',
      '-an','-c:v','libx264','-g','60','-bf','3',path]);
    const source=await openSource(path),before=await sha256(path),info=mediaInfo(await probeMedia(path,{executable:ffprobe}));
    const directory=temp.file('session');await mkdir(directory);
    prepared=await prepareNativeMedia({source,info,directory,helper:resolve('resources/bin/motion-preview.exe'),ffmpeg,ffprobe,signal:new AbortController().signal,maximumEdge:640});
    const {native,index}=prepared,pid=native.pid;
    await native.request({command:'quality',maximumEdge:320}); await native.request({command:'quality',maximumEdge:640});
    await index.locate(native,10);
    const first=(await native.request<Stats>({command:'stats'})).value;
    await index.locate(native,11);
    const forward=(await native.request<Stats>({command:'stats'})).value;
    assert.equal(forward.primary.seeks,first.primary.seeks,'Adjacent forward frame continues the existing decoder');
    await index.locate(native,10);
    const reverse=(await native.request<Stats>({command:'stats'})).value;
    assert.equal(reverse.primary.seeks,forward.primary.seeks); assert.equal(reverse.primary.cache.hits,forward.primary.cache.hits+1);
    await native.request({command:'prefetch',count:2}); await index.locate(native,13);
    const warm=(await native.request<Stats>({command:'stats'})).value;
    assert.equal(warm.primary.seeks,reverse.primary.seeks); assert.ok(warm.primary.cache.hits>reverse.primary.cache.hits);
    const thumb=await index.thumbnail(native,20); assert.ok(thumb.value.width<=240&&thumb.value.height<=240);
    assert.equal((await index.fromNative(thumb.value.timestampHns)).index,20);
    await index.locate(native,14);
    const afterThumb=(await native.request<Stats>({command:'stats'})).value;
    assert.equal(afterThumb.primary.seeks,warm.primary.seeks,'Thumbnail reader must not move foreground decode position');
    assert.ok(afterThumb.thumbnail);
    for(const value of [afterThumb.primary,afterThumb.thumbnail!]) {
      assert.ok(value.cache.bytes<=value.cache.budget); assert.ok(value.cache.entries<=512);
    }
    assert.ok(afterThumb.primary.cache.budget+afterThumb.thumbnail!.cache.budget<=224*1024*1024);
    await native.request({command:'quality',maximumEdge:320});
    assert.equal((await native.request<Stats>({command:'stats'})).value.primary.cache.bytes,afterThumb.primary.cache.bytes,'Changing quality preserves cached variants');
    const resized=await index.locate(native,14); assert.equal(resized.value.width,320); assert.equal(resized.value.height,180);
    const small=(await native.request<Stats>({command:'stats'})).value;
    await native.request({command:'quality',maximumEdge:640});
    const restored=await index.locate(native,14);assert.equal(restored.value.width,640);assert.equal(restored.value.height,360);
    const restoredStats=(await native.request<Stats>({command:'stats'})).value;
    assert.equal(restoredStats.primary.cache.hits,small.primary.cache.hits+1);
    assert.equal(restoredStats.primary.decodedSamples,small.primary.decodedSamples,'Returning to a cached resolution does not decode again');
    assert.ok(restoredStats.primary.cache.bytes<=restoredStats.primary.cache.budget);
    assert.equal(native.pid,pid); assert.equal(await sha256(path),before);
  } finally { await prepared?.native.shutdown(); await prepared?.index.close(); await temp.cleanup(); }
});
