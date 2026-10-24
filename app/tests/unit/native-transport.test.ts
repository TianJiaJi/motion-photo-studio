import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {resolve} from 'node:path';
import {NativePreview} from '../../src/main/media/native-preview.ts';
import {publicError} from '../../src/main/errors.ts';

function transport(){
  const original=childProcess.spawn;
  const emitter=new EventEmitter();
  const child=Object.assign(emitter,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:123,exitCode:null as number|null,signalCode:null,killed:false,
    kill(){if(!this.killed){this.killed=true;queueMicrotask(()=>{this.exitCode=1;emitter.emit('close',1);});}return true;}});
  childProcess.spawn=(()=>child) as unknown as typeof childProcess.spawn;syncBuiltinESMExports();
  const native=new NativePreview(resolve('test-only-helper.exe'));
  return {native,child,restore(){childProcess.spawn=original;syncBuiltinESMExports();}};
}
for(const stream of ['stdin','stdout'] as const)test(`${stream} error before process close remains a stable native exit failure`,async()=>{
  const h=transport();
  try{
    const cause=Object.assign(new Error('broken pipe'),{code:'EPIPE'});
    let first:unknown;
    const rejected=assert.rejects(h.native.request({command:'hello'}),error=>{first=error;assert.equal((error as Error).cause,cause);assert.equal(publicError(error).code,'NATIVE_EXIT');assert.match(publicError(error).message,/原生预览/);return true;});
    h.child[stream].emit('error',cause);await rejected;await h.native.terminated;
    await assert.rejects(h.native.request({command:'hello'}),error=>error===first);
    assert.equal(h.child.killed,true);
  }finally{await h.native.shutdown();h.restore();}
});
test('malformed transport data is a protocol failure, not an unclassified UI error',async()=>{
  const h=transport();
  try{
    const rejected=assert.rejects(h.native.request({command:'hello'}),{code:'NATIVE_PROTOCOL'});
    const oversized=Buffer.alloc(4);oversized.writeUInt32LE(16385);h.child.stdout.write(oversized);
    await rejected;await h.native.terminated;assert.equal(h.child.killed,true);
  }finally{await h.native.shutdown();h.restore();}
});
test('spawn failures retain their diagnostic cause and public native classification',async()=>{
  const h=transport();
  try{
    const rejected=assert.rejects(h.native.request({command:'hello'}),{code:'NATIVE_EXIT'});
    h.child.emit('error',Object.assign(new Error('denied'),{code:'EPERM'}));h.child.kill();await rejected;await h.native.terminated;
  }finally{await h.native.shutdown();h.restore();}
});
