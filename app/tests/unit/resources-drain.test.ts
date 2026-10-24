import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {writeFile,readFile,unlink} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {MediaResources} from '../../src/main/media/resources.ts';
import {tempFiles} from '../helpers.ts';

// Delay only close of this test's real file descriptor; retain Node's actual open/read/destroy implementation.
function delayClose(){
  const original=fs.createReadStream,streams:fs.ReadStream[]=[],releases:(()=>void)[]=[];
  fs.createReadStream=((...args:Parameters<typeof original>)=>{
    const stream=Reflect.apply(original,fs,args);streams.push(stream);
    const destroy=stream._destroy;
    stream._destroy=(error,callback)=>{releases.push(()=>destroy.call(stream,error,callback));};
    return stream;
  }) as typeof original;syncBuiltinESMExports();
  return {streams,release(){for(const done of releases.splice(0))done();},restore(){fs.createReadStream=original;syncBuiltinESMExports();}};
}
test('revoke fences access immediately but waits for actual stream close before deletion',async()=>{
  const temp=await tempFiles(),resources=new MediaResources(),hook=delayClose();
  try{
    const path=temp.file('held.mp4');await writeFile(path,Buffer.alloc(256*1024));
    const ref=await resources.register(path,'video/mp4');await resources.respond(new Request(ref.url),'app://ui');
    const stream=hook.streams[0]!;if(stream.pending)await once(stream,'open');
    let removed=false;const draining=resources.revoke(ref.id);
    assert.equal(resources.revoke(ref.id),draining,'Concurrent revocation shares its close barrier');
    const deleting=draining.then(async()=>{assert.equal(stream.closed,true);assert.equal((stream as fs.ReadStream & {fd:number|null}).fd,null);await unlink(path);removed=true;});
    assert.equal((await resources.respond(new Request(ref.url),'app://ui')).status,404);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(removed,false);assert.equal(stream.closed,false);
    assert.equal((await readFile(path)).length,256*1024);
    hook.release();await deleting;assert.equal(removed,true);
  }finally{hook.release();hook.restore();await resources.dispose();await temp.cleanup();}
});
test('drain timeout retains inaccessible resources for retry, never authorizes deletion',async()=>{
  const temp=await tempFiles(),resources=new MediaResources(30),hook=delayClose();
  try{
    const path=temp.file('held.mp4');await writeFile(path,Buffer.alloc(128*1024));
    const ref=await resources.register(path,'video/mp4');await resources.respond(new Request(ref.url),'app://ui');
    const stream=hook.streams[0]!;if(stream.pending)await once(stream,'open');
    await assert.rejects(resources.revoke(ref.id),{code:'TEMP_CLEANUP'});
    assert.equal(stream.closed,false);assert.equal((await readFile(path)).length,128*1024);
    assert.equal((await resources.respond(new Request(ref.url),'app://ui')).status,404);
    hook.release();await resources.revoke(ref.id);assert.equal(stream.closed,true);
    await resources.dispose();await assert.rejects(resources.register(path,'video/mp4'),{code:'CANCELLED'});
  }finally{hook.release();hook.restore();await resources.dispose();await temp.cleanup();}
});
test('disposing during registration cannot publish a new resource token',async()=>{
  const temp=await tempFiles(),resources=new MediaResources();
  try{
    const path=temp.file('source.jpg');await writeFile(path,'image');
    const registering=resources.register(path,'image/jpeg');const rejected=assert.rejects(registering,{code:'CANCELLED'});
    await resources.dispose();await rejected;
    assert.equal(await readFile(path,'utf8'),'image');
  }finally{await resources.dispose();await temp.cleanup();}
});
