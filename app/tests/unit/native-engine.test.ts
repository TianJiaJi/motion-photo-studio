import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseNativeEngineManifest,verifyNativeFiles,verifyNativeEngine} from '../../src/main/media/native-engine.ts';
import {PREVIEW_ENGINE_VERSION,PREVIEW_RUST_VERSION} from '../../src/shared/native-preview.ts';
import {tempFiles} from '../helpers.ts';
function fixture(){
  const pe=Buffer.alloc(256);pe.writeUInt16LE(0x5a4d,0);pe.writeUInt32LE(128,0x3c);pe.writeUInt32LE(0x4550,128);pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(0x20b,152);
  const manifest={schemaVersion:1,engine:'motion-preview',engineVersion:PREVIEW_ENGINE_VERSION,protocolVersion:1,platform:'win32',arch:'x64',target:'x86_64-pc-windows-msvc',rustVersion:PREVIEW_RUST_VERSION,crt:'static',sourceLockSha256:'a'.repeat(64),binary:{name:'motion-preview.exe',size:pe.length,sha256:createHash('sha256').update(pe).digest('hex')}};
  return {pe,manifest};
}
test('native manifest has a distinct, closed version/target/hash schema',()=>{
  const {manifest}=fixture();assert.equal(parseNativeEngineManifest(manifest).binary.name,'motion-preview.exe');
  for(const changed of [{protocolVersion:2},{engineVersion:'9.0.0'},{rustVersion:'latest'},{arch:'arm64'},{extra:'path'},{crt:'dynamic'},{sourceLockSha256:'no'}])assert.throws(()=>parseNativeEngineManifest({...manifest,...changed}),{code:'NATIVE_ENGINE_VERSION'});
  for(const binary of [{...manifest.binary,name:'../motion-preview.exe'},{...manifest.binary,size:Infinity},{...manifest.binary,size:65*1024*1024},{...manifest.binary,sha256:'x'.repeat(64)},{...manifest.binary,args:[]}])assert.throws(()=>parseNativeEngineManifest({...manifest,binary}),{code:'NATIVE_ENGINE_VERSION'});
});
test('missing, tampered and wrong-machine native resources fail before any helper launch',async()=>{
  const temp=await tempFiles();
  try{
    await assert.rejects(verifyNativeEngine(temp.directory),{code:'NATIVE_ENGINE_MISSING'});
    const {pe,manifest}=fixture();await mkdir(temp.file('bin'));
    const manifestPath=temp.file('native-preview-manifest.json'),exe=temp.file('bin/motion-preview.exe');
    await writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(verifyNativeEngine(temp.directory),{code:'NATIVE_ENGINE_MISSING'});
    await writeFile(exe,pe);assert.equal((await verifyNativeFiles(temp.directory)).helper,exe); // Never execute this PE-header fixture.
    const bad=Buffer.from(pe);bad[200]=1;await writeFile(exe,bad);await assert.rejects(verifyNativeEngine(temp.directory),{code:'NATIVE_ENGINE_INTEGRITY'});
    bad.writeUInt16LE(0x14c,132);manifest.binary.sha256=createHash('sha256').update(bad).digest('hex');await writeFile(exe,bad);await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(verifyNativeEngine(temp.directory),{code:'NATIVE_ENGINE_INTEGRITY'});
    manifest.protocolVersion=2;await writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(verifyNativeEngine(temp.directory),{code:'NATIVE_ENGINE_VERSION'});
  }finally{await temp.cleanup();}
});
test('binary-directory junctions are refused and no alternate PATH executable is selected',async()=>{
  const temp=await tempFiles();let link:string|undefined;
  try{
    const {pe,manifest}=fixture(),outside=temp.file('outside'),root=temp.file('resources');await mkdir(outside);await mkdir(root);
    await writeFile(join(outside,'motion-preview.exe'),pe);await writeFile(join(root,'native-preview-manifest.json'),JSON.stringify(manifest));
    link=join(root,'bin');await symlink(outside,link,'junction');await assert.rejects(verifyNativeEngine(root),{code:'NATIVE_ENGINE_MISSING'});
    assert.deepEqual(await readFile(join(outside,'motion-preview.exe')),pe);
  }finally{if(link)await unlink(link);await temp.cleanup();}
});
