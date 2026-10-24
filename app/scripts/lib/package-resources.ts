import assert from 'node:assert/strict';
import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyNativeEngine,verifyNativeFiles} from '../../src/main/media/native-engine.ts';
import {verifyEngines} from '../../src/main/media/engine.ts';
import {sha256} from '../../src/main/motion/io.ts';

export async function resourceSnapshot(resources:string){
  const {manifest}=await verifyNativeFiles(resources);
  const files:{path:string;sha256:string}[]=[];
  const queue=[{path:join(resources,'licenses'),relative:'',depth:0}];
  while(queue.length){
    const row=queue.shift()!,info=await lstat(row.path);
    if(info.isSymbolicLink()||row.depth>16||files.length+queue.length>10000)throw new Error('Unsafe or unbounded license tree');
    if(info.isDirectory()){
      for(const name of await readdir(row.path))queue.push({path:join(row.path,name),relative:row.relative?`${row.relative}/${name}`:name,depth:row.depth+1});
    }else{
      if(!info.isFile()||info.size>64*1024*1024)throw new Error('Invalid license file');
      files.push({path:row.relative,sha256:await sha256(row.path)});
    }
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  for(const name of ['native-preview/DEPENDENCIES.json','native-preview/NOTICE.txt','native-preview/Cargo.lock','native-preview/rust-toolchain/COPYRIGHT-library.html'])
    if(!files.some(file=>file.path===name))throw new Error(`Missing native notice: ${name}`);
  assert.equal(files.find(file=>file.path==='native-preview/Cargo.lock')!.sha256,manifest.sourceLockSha256,'Packaged source lock must match native build manifest');
  return {manifest,engineManifestSha256:await sha256(join(resources,'engine-manifest.json')),licenseFiles:files};
}
export async function checkPackagedResources(resources:string,expected:Awaited<ReturnType<typeof resourceSnapshot>>){
  const actual=await resourceSnapshot(resources);assert.deepEqual(actual,expected,'Packaged binaries/manifests/notices must match the verified build inputs');
  const native=await verifyNativeEngine(resources),media=await verifyEngines(resources);
  return {nativeVersion:native.version,nativeBinary:actual.manifest.binary,ffmpegBuild:media.build,
    licenseFiles:actual.licenseFiles.length,licenseTreeSha256:createHash('sha256').update(JSON.stringify(actual.licenseFiles)).digest('hex'),
    limits:'Resource copy/integrity/handshake check only; not application UI, clean-machine, hardware decode or real-material acceptance.'};
}
