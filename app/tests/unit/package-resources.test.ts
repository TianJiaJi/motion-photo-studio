import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {tempFiles} from '../helpers.ts';
import {resourceSnapshot,checkPackagedResources} from '../../scripts/lib/package-resources.ts';
import {PREVIEW_ENGINE_VERSION,PREVIEW_RUST_VERSION} from '../../src/shared/native-preview.ts';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('package resource verification binds the exact lock and notice bytes, rejecting differences before executing any helper',async()=>{
  const temp=await tempFiles();
  try{
    const pe=Buffer.alloc(256);pe.writeUInt16LE(0x5a4d,0);pe.writeUInt32LE(128,60);pe.writeUInt32LE(0x4550,128);pe.writeUInt16LE(0x8664,132);pe.writeUInt16LE(0x20b,152);
    const lock='fixture lock';
    const files:{[name:string]:string|Buffer}={
      'bin/motion-preview.exe':pe,'engine-manifest.json':'{}',
      'native-preview-manifest.json':JSON.stringify({schemaVersion:1,engine:'motion-preview',engineVersion:PREVIEW_ENGINE_VERSION,protocolVersion:1,platform:'win32',arch:'x64',target:'x86_64-pc-windows-msvc',rustVersion:PREVIEW_RUST_VERSION,crt:'static',sourceLockSha256:hash(lock),binary:{name:'motion-preview.exe',size:pe.length,sha256:hash(pe)}}),
      'licenses/native-preview/Cargo.lock':lock,'licenses/native-preview/DEPENDENCIES.json':'{}','licenses/native-preview/NOTICE.txt':'notice',
      'licenses/native-preview/rust-toolchain/COPYRIGHT-library.html':'copyright',
    };
    for(const [name,content] of Object.entries(files)){const path=temp.file(name);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
    const before=await resourceSnapshot(temp.directory);assert.equal(before.licenseFiles.length,4);
    await writeFile(temp.file('licenses/native-preview/NOTICE.txt'),'changed notice');
    // The PE is only a header fixture. This must fail on the resource diff before any process is launched.
    await assert.rejects(checkPackagedResources(temp.directory,before),/Packaged binaries\/manifests\/notices must match/);
    await writeFile(temp.file('licenses/native-preview/Cargo.lock'),'changed lock');
    await assert.rejects(resourceSnapshot(temp.directory),/Packaged source lock must match/);
  }finally{await temp.cleanup();}
});
