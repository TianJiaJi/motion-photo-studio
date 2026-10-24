import {spawn} from 'node:child_process';
import {cp,copyFile,lstat,mkdir,readdir,rename,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha256} from '../src/main/motion/io.ts';
import {parseNativeEngineManifest,verifyNativeFiles} from '../src/main/media/native-engine.ts';
import {PREVIEW_ENGINE_VERSION,PREVIEW_PROTOCOL_VERSION,PREVIEW_RUST_VERSION} from '../src/shared/native-preview.ts';

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Preview builds require Windows x64 + MSVC/Windows SDK');
if(process.argv.length>2)throw new Error('This build script takes no arbitrary executable or destination arguments');
const app=fileURLToPath(new URL('../',import.meta.url)),root=resolve(app,'../native/preview-engine'),resources=join(app,'resources');
const cargoHome=process.env.CARGO_HOME??join(process.env.USERPROFILE! ,'.cargo');
const cargo=join(cargoHome,'bin','cargo.exe'),rustc=join(cargoHome,'bin','rustc.exe'),target='x86_64-pc-windows-msvc';
const env={...process.env,CARGO_TARGET_DIR:join(root,'target'),RUSTC:rustc,RUSTFLAGS:'-C target-feature=+crt-static'};
async function run(executable:string,args:string[],capture=false):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore',capture?'pipe':'inherit','inherit']});let output='';
    child.stdout?.on('data',(chunk:Buffer)=>{output+=chunk.toString();if(output.length>8*1024*1024){child.kill();reject(new Error('Build metadata output exceeded budget'));}});
    child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim()):reject(new Error(`${args[0]} failed with exit ${code}`)));
  });
}
for(const [executable,name] of [[cargo,'cargo'],[rustc,'rustc']] as const){
  const version=await run(executable,['--version'],true);if(!version.startsWith(`${name} ${PREVIEW_RUST_VERSION} `))throw new Error(`Expected ${name} ${PREVIEW_RUST_VERSION}, got ${version}`);
}
await run(cargo,['fmt','--check']);
await run(cargo,['clippy','--locked','--offline','--all-targets','--target',target,'--','-D','warnings']);
await run(cargo,['test','--locked','--offline','--all-targets','--target',target]);
await run(cargo,['build','--locked','--offline','--release','--target',target]);
type Package={name:string;version:string;license:string|null;manifest_path:string;source:string|null};
const metadata=JSON.parse(await run(cargo,['metadata','--locked','--offline','--format-version=1','--filter-platform',target],true)) as {packages:Package[]};
const own=metadata.packages.find(pkg=>pkg.name==='motion-preview');if(own?.version!==PREVIEW_ENGINE_VERSION)throw new Error('Cargo/host engine versions disagree');
const binary=join(root,'target',target,'release','motion-preview.exe');
const notices=join(resources,'licenses','native-preview');await mkdir(notices,{recursive:true});
const inventory:{name:string;version:string;license:string;files:{path:string;sha256:string}[]}[]=[];
for(const pkg of metadata.packages){
  if(pkg.name==='motion-preview')continue;
  if(!/^[a-z0-9_-]+$/.test(pkg.name)||!/^\d+\.\d+\.\d+$/.test(pkg.version)||!pkg.source?.startsWith('registry+')||!pkg.license)throw new Error('Unreviewed dependency identity');
  const accepted=['MIT OR Apache-2.0','Unlicense OR MIT','Apache-2.0 OR BSL-1.0','(MIT OR Apache-2.0) AND Unicode-3.0'];
  if(!accepted.includes(pkg.license))throw new Error(`Review new license expression before building: ${pkg.name}: ${pkg.license}`);
  const directory=dirname(pkg.manifest_path),destination=join(notices,`${pkg.name}-${pkg.version}`);await mkdir(destination,{recursive:true});
  const files:{path:string;sha256:string}[]=[];
  for(const name of await readdir(directory)){
    if(!/^(LICENSE|LICENCE|COPYING|NOTICE)([._-].*)?$/i.test(name))continue;
    const source=join(directory,name),info=await lstat(source);if(!info.isFile()||info.isSymbolicLink())throw new Error(`Unsafe license file: ${pkg.name}/${name}`);
    await copyFile(source,join(destination,name));files.push({path:`${pkg.name}-${pkg.version}/${name}`,sha256:await sha256(source)});
  }
  if(!files.length)throw new Error(`Missing full license texts: ${pkg.name}`);
  inventory.push({name:pkg.name,version:pkg.version,license:pkg.license,files});
}
const sysroot=await run(rustc,['--print','sysroot'],true),rustNotices=join(sysroot,'share','doc','rust');
await mkdir(join(notices,'rust-toolchain'),{recursive:true});
for(const name of ['COPYRIGHT.html','COPYRIGHT-library.html','licenses'])await cp(join(rustNotices,name),join(notices,'rust-toolchain',name),{recursive:true});
await copyFile(join(root,'Cargo.lock'),join(notices,'Cargo.lock'));
await writeFile(join(notices,'DEPENDENCIES.json'),JSON.stringify({rustVersion:PREVIEW_RUST_VERSION,inventory},null,2));
await writeFile(join(notices,'NOTICE.txt'),'Motion Preview: independently implemented Windows Media Foundation/WASAPI preview helper.\nNo FilmCraft source code is included. Windows system DLLs are not redistributed.\nCargo crate license texts and Rust toolchain copyright notices are preserved here.\nMSVC CRT is statically linked. This inventory is not approval to publicly redistribute the full application/FFmpeg/Sharp bundle.\n');
await mkdir(join(resources,'bin'),{recursive:true});
const stage=join(resources,'bin',`.motion-preview-${randomUUID()}.exe`);await copyFile(binary,stage);
await rename(stage,join(resources,'bin','motion-preview.exe'));
const manifest=parseNativeEngineManifest({schemaVersion:1,engine:'motion-preview',engineVersion:PREVIEW_ENGINE_VERSION,protocolVersion:PREVIEW_PROTOCOL_VERSION,
  platform:'win32',arch:'x64',target,rustVersion:PREVIEW_RUST_VERSION,crt:'static',sourceLockSha256:await sha256(join(root,'Cargo.lock')),
  binary:{name:'motion-preview.exe',size:(await lstat(binary)).size,sha256:await sha256(binary)}});
const manifestStage=join(resources,`.native-preview-manifest-${randomUUID()}.json`);await writeFile(manifestStage,JSON.stringify(manifest,null,2));await rename(manifestStage,join(resources,'native-preview-manifest.json'));
await verifyNativeFiles(resources);
console.log(`Native preview built and verified: ${manifest.engineVersion}, ${manifest.binary.sha256}; ${inventory.length} crate notices archived.`);
