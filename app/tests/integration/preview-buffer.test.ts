import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeSessionHarness} from '../native-session-harness.ts';
import {ffmpeg,runProcess} from '../../src/main/media/runner.ts';
import {sha256} from '../../src/main/motion/io.ts';

test('native foreground and background work cross old segment boundaries without any new process or proxy file',{timeout:120000},async()=>{
  const h=await nativeSessionHarness(),original=childProcess.spawn,starts:string[]=[];
  try{
    const input=h.temp.file('source.mp4');
    await runProcess(ffmpeg(),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=60:duration=16','-an','-c:v','libx264','-pix_fmt','yuv420p',input]);
    const before=await sha256(input),asset=await h.manager.open(input);
    await h.manager.prepareNative(asset.id,false);assert.equal(asset.info.durationUs,16000000);
    childProcess.spawn=((...args:Parameters<typeof original>)=>{starts.push(String(args[0]));return Reflect.apply(original,childProcess,args);}) as typeof original;syncBuiltinESMExports();
    const thumbnails=h.manager.thumbnails(asset.id,0,asset.info.durationUs,12,false);
    for(const time of [500000,3000000,12000000,14000000,0])assert.equal((await h.seek(asset.id,time)).timeUs,time);
    assert.equal((await thumbnails).length,12);assert.deepEqual(starts,[],'No editing FFmpeg, ffprobe, or replacement helper');
    const [directory]=await readdir(h.store.root),files=await readdir(join(h.store.root,directory!));
    assert.equal(files.filter(name=>name.endsWith('.mp4')||name.startsWith('proxy-')).length,0);
    for(const legacy of ['preview','frame','coverFromFrame'])assert.equal(legacy in h.manager,false);
    await h.manager.close(asset.id);assert.deepEqual(await readdir(h.store.root),[]);assert.equal(await sha256(input),before);
  }finally{childProcess.spawn=original;syncBuiltinESMExports();await h.cleanup();}
});
