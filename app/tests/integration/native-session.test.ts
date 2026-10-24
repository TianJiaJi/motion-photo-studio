import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
import {tempFiles} from '../helpers.ts';
import {MediaSession} from '../../src/main/media/session.ts';
import {MediaResources} from '../../src/main/media/resources.ts';
import {TempFiles} from '../../src/main/jobs/temp-files.ts';
import {runProcess} from '../../src/main/media/runner.ts';
import {sha256} from '../../src/main/motion/io.ts';
import type {PreviewStamp} from '../../src/shared/native-preview.ts';
const ffmpeg=resolve('resources/bin/ffmpeg.exe'),ffprobe=resolve('resources/bin/ffprobe.exe'),helper=resolve('resources/bin/motion-preview.exe');
test('session native controls, thumbnails and confirmed-frame cover spawn zero editing processes and drain on replacement',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const temp=await tempFiles(),store=new TempFiles(temp.file('sessions'));await store.initialize();
  const resources=new MediaResources(),warnings:string[]=[],frames:PreviewStamp[]=[],starts:string[]=[];
  let manager:MediaSession;
  manager=new MediaSession({ffmpeg,ffprobe,build:'fixture'},store,resources,message=>warnings.push(message),undefined,undefined,[],{
    helper,status:()=>{},frame(frame){const {pixels:_pixels,...stamp}=frame;frames.push(stamp);
      queueMicrotask(()=>manager.nativeAcknowledge({assetId:stamp.assetId,epoch:stamp.epoch,frameId:stamp.frameId,painted:true}));},
  });
  const original=childProcess.spawn;
  childProcess.spawn=((...args:Parameters<typeof original>)=>{starts.push(String(args[0]));return Reflect.apply(original,childProcess,args);}) as typeof original;
  syncBuiltinESMExports();
  try {
    const path=temp.file('source.mp4');await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=2','-an','-c:v','libx264','-preset','ultrafast','-g','60','-bf','3',path]);
    const before=await sha256(path),asset=await manager.open(path);
    const [ready,again]=await Promise.all([manager.prepareNative(asset.id,false),manager.prepareNative(asset.id,false)]);
    assert.equal(ready.frameCount,60);assert.equal(again.frameCount,60);
    assert.equal(starts.filter(path=>path.endsWith('motion-preview.exe')).length,1,'Concurrent prepare calls share one helper');
    const preparedStarts=starts.length;
    await manager.nativeControl({assetId:asset.id,epoch:1,action:'seek',timeUs:500000,boundary:'after',maximumEdge:640,final:true});
    const thumbs=manager.thumbnails(asset.id,0,asset.info.durationUs,4,false);
    await manager.nativeControl({assetId:asset.id,epoch:2,action:'seek',timeUs:1000000,boundary:'before',maximumEdge:960,final:true});
    assert.equal((await thumbs).length,4);
    const shown=frames.at(-1);assert.ok(shown);assert.ok(shown.timeUs<1000000);
    const cover=await manager.nativeCover(asset.id,shown.frameId);assert.equal(cover.kind,'frame');assert.equal(cover.timeUs,shown.timeUs);
    await assert.rejects(manager.nativeCover(asset.id,shown.frameId+999),{code:'FRAME_BOUNDARY'});
    assert.deepEqual(starts.slice(preparedStarts),[],'Ready editing starts neither media tools nor extra helpers');
    const replacement=await manager.open(path);assert.notEqual(replacement.id,asset.id);
    await manager.close(replacement.id);assert.deepEqual(await readdir(store.root),[]);assert.deepEqual(warnings,[]);assert.equal(await sha256(path),before);
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await manager.shutdown();await resources.dispose();await temp.cleanup();}
});
