// Mutate only a new, fully copied test package. Never changes the supplied package or user media.
import { _electron as electron, expect } from '@playwright/test';
import {cp,copyFile,lstat,mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {sha256} from '../src/main/motion/io.ts';
import {PREVIEW_ENGINE_VERSION,PREVIEW_RUST_VERSION} from '../src/shared/native-preview.ts';
if(process.argv.length!==3||process.platform!=='win32')throw new Error('Usage on Windows: node scripts/verify-packaged-preview-faults.ts <exact-packaged-exe>');
const original=await realpath(resolve(process.argv[2]!));if(basename(original)!=='Motion Photo Studio.exe')throw new Error('Expected packaged application executable');
const root=resolve(`../artifacts/native-preview/package-faults-${Date.now()}`);await mkdir(root,{recursive:true});
if(root.startsWith(dirname(original)+sep))throw new Error('Evidence directory must be outside the package being copied');
const sourceHelper=join(dirname(original),'resources/bin/motion-preview.exe'),before={app:await sha256(original),helper:await sha256(sourceHelper)};
const appRoot=join(root,'fixture');await cp(dirname(original),appRoot,{recursive:true,force:false,errorOnExist:true});
const exe=join(appRoot,'Motion Photo Studio.exe'),helper=join(appRoot,'resources/bin/motion-preview.exe'),manifestPath=join(appRoot,'resources/native-preview-manifest.json');
if((await lstat(helper)).nlink!==1)throw new Error('Fault fixture must not share a hard link with the input package');
const manifestBytes=await readFile(manifestPath),backup=join(root,'original-helper.exe');await copyFile(helper,backup);
const rust=join(process.env.CARGO_HOME??join(process.env.USERPROFILE!,'.cargo'),'bin/rustc.exe');
const crate=fileURLToPath(new URL('../../native/preview-engine/',import.meta.url));
async function compile(args:string[]){return new Promise<string>((done,reject)=>{
  const child=spawn(rust,args,{cwd:crate,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Protocol fixture compilation timed out'));},120000);
  child.stdout.on('data',b=>{output+=String(b);});child.stderr.on('data',b=>{output+=String(b);});
  child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);code===0?done(output):reject(new Error(output));});
});}
const version=await compile(['--version']);if(!version.startsWith(`rustc ${PREVIEW_RUST_VERSION} `))throw new Error('Wrong fixture compiler version');
const source=join(root,'protocol-fixture.rs'),malformed=join(root,'protocol-fixture.exe');
await writeFile(source,`use std::io::{self,Read,Write};
fn main(){let mut input=io::stdin().lock();let mut length=[0u8;4];if input.read_exact(&mut length).is_err(){return;}
let size=u32::from_le_bytes(length) as usize;if size>16384{return;}let mut payload=vec![0u8;size];if input.read_exact(&mut payload).is_err(){return;}
let reply=br#"{"version":2,"id":1,"generation":0,"bodyBytes":0,"result":{}}"#;
let mut out=io::stdout().lock();out.write_all(&(reply.len() as u32).to_le_bytes()).unwrap();out.write_all(reply).unwrap();out.flush().unwrap();
let mut tail=[0u8;1];let _=input.read(&mut tail);}
`,{flag:'wx'});
await compile(['--edition=2024','--crate-name','preview_protocol_fixture','--target','x86_64-pc-windows-msvc','-C','target-feature=+crt-static',source,'-o',malformed]);
const unavailable=join(root,'mf-unavailable-fixture.exe'),unavailableSource=join(root,'mf-unavailable-fixture.rs');
const missingMfReply=JSON.stringify({version:1,id:1,generation:0,bodyBytes:0,result:{engine:'motion-preview',engineVersion:PREVIEW_ENGINE_VERSION,platform:'windows-x64',mediaFoundation:false}});
await writeFile(unavailableSource,(await readFile(source,'utf8')).replace('{"version":2,"id":1,"generation":0,"bodyBytes":0,"result":{}}',missingMfReply),{flag:'wx'});
await compile(['--edition=2024','--crate-name','preview_mf_unavailable_fixture','--target','x86_64-pc-windows-msvc','-C','target-feature=+crt-static',unavailableSource,'-o',unavailable]);
function environment(userData:string){
  const env=Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>row[1]!==undefined));
  for(const key of Object.keys(env))if(['path','electron_run_as_node','electron_renderer_url','ffmpeg_path','ffprobe_path','motion_preview_prototype_exe'].includes(key.toLowerCase()))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;return env;
}
const results:unknown[]=[];
try{
  for(const [mode,code] of [['missing','NATIVE_ENGINE_MISSING'],['tampered','NATIVE_ENGINE_INTEGRITY'],['wire-version','NATIVE_ENGINE_VERSION'],['no-mf','NATIVE_PLATFORM']] as const){
    await copyFile(backup,helper);await writeFile(manifestPath,manifestBytes);
    if(mode==='missing')await rename(helper,join(root,'missing-helper.exe'));
    if(mode==='tampered'){const bytes=await readFile(helper);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;await writeFile(helper,bytes);}
    if(mode==='wire-version'||mode==='no-mf'){
      await copyFile(mode==='wire-version'?malformed:unavailable,helper);const manifest=JSON.parse(manifestBytes.toString());
      manifest.binary.size=(await lstat(helper)).size;manifest.binary.sha256=await sha256(helper);await writeFile(manifestPath,JSON.stringify(manifest));
    }
    const app=await electron.launch({executablePath:exe,args:[],env:environment(join(root,`user-data-${mode}`)),timeout:60000});
    try{
      const page=await app.firstWindow();await app.context().setOffline(true);
      await expect(page.getByTestId('engine-state')).toHaveText('引擎就绪',{timeout:60000});
      await expect(page.getByTestId('preview-engine-state')).toHaveText('原生预览不可用');await expect(page.getByTestId('open-video')).toBeDisabled();
      const snapshot=await page.evaluate(()=>window.motion.getSnapshot());if(!snapshot.ok)throw new Error('Snapshot unavailable');
      expect(snapshot.value.previewEngine.error?.code).toBe(code);expect(snapshot.value.previewEngine.integrityVerified).toBe(false);
      results.push({mode,expectedCode:code,error:snapshot.value.previewEngine.error});
      await page.screenshot({path:join(root,`${mode}.png`)});
    }finally{await app.close();}
  }
  expect(await sha256(original)).toBe(before.app);expect(await sha256(sourceHelper)).toBe(before.helper);
  await writeFile(join(root,'report.json'),JSON.stringify({original,before,results,sourcePackageUnchanged:true,limits:'Controlled copy faults, including deliberately mismatched wire protocol and a valid hello reporting MF unavailable; not a real Windows N, missing codec extension, physical audio-device loss or clean-machine test.'},null,2),{flag:'wx'});
  console.log(`Packaged fault checks passed: ${root}`);
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error),results},null,2),{flag:'wx'});throw error;}
