import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
const helper = resolve('resources/bin/motion-preview.exe');
const ffmpeg = () => resolve('resources/bin/ffmpeg.exe');
const ffprobe = () => resolve('resources/bin/ffprobe.exe');
const windows = process.platform === 'win32';

test('actual compatibility conversion obeys disk cap, cancellation and HDR consent', { skip: !windows, timeout: 120000 }, async () => {
  const temp = await tempFiles();
  try {
    const sourcePath = temp.file('noise.mp4');
    await runProcess(ffmpeg(), ['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=960x540:rate=30:duration=4,noise=alls=100:allf=t',
      '-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-an',sourcePath]);
    const source = await openSource(sourcePath); const info = mediaInfo(await probeMedia(sourcePath,{executable:ffprobe()}));
    const directory = temp.file('session'); await mkdir(directory);
    const options = { source, info, directory, helper, ffmpeg:ffmpeg(), ffprobe:ffprobe(), forceCompatibility:true };
    await assert.rejects(prepareNativeMedia({...options,info:{...info,hdr:true},signal:new AbortController().signal}),{code:'HDR_CONFIRM_REQUIRED'});
    assert.deepEqual(await readdir(directory),[]);
    await assert.rejects(prepareNativeMedia({...options,signal:new AbortController().signal,maxBytes:1024*1024}),{code:'PREVIEW_BUDGET'});
    assert.deepEqual(await readdir(directory),[],'Quota stop must remove the partial MP4 and index');
    const controller = new AbortController(); let encodingStarted = false;
    await assert.rejects(prepareNativeMedia({...options,signal:controller.signal,onProgress:value=>{
      if(value.stage==='compatibility') { encodingStarted=true; controller.abort(); }
    }}));
    assert.equal(encodingStarted,true,'Test must cancel during the encoder, not before preparation');
    assert.deepEqual(await readdir(directory),[]);
    assert.deepEqual(await openSource(sourcePath),source);
  } finally { await temp.cleanup(); }
});

test('unsupported FFV1 container takes import-only fallback and preserves all source frames', { skip: !windows, timeout: 60000 }, async () => {
  const temp = await tempFiles(); let prepared: PreparedNativeMedia | undefined;
  try {
    const path = temp.file('unsupported.mkv');
    await runProcess(ffmpeg(),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=2',
      '-c:v','ffv1','-an',path]);
    const source = await openSource(path); const info = mediaInfo(await probeMedia(path,{executable:ffprobe()}));
    const directory = temp.file('session'); await mkdir(directory);
    prepared = await prepareNativeMedia({source,info,directory,helper,ffmpeg:ffmpeg(),ffprobe:ffprobe(),signal:new AbortController().signal});
    assert.equal(prepared.compatibility,true); assert.equal(prepared.index.count,50);
    assert.equal((await prepared.index.get(49)).pts,'1960');
    assert.equal(prepared.index.mappingReady,true);
  } finally { await prepared?.native.shutdown(); await prepared?.index.close(); await temp.cleanup(); }
});
