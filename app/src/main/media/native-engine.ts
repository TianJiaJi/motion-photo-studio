import {lstat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {AppFailure} from '../errors.ts';
import {sha256} from '../motion/io.ts';
import {NativePreview} from './native-preview.ts';
import {PREVIEW_ENGINE_VERSION,PREVIEW_PROTOCOL_VERSION,PREVIEW_RUST_VERSION} from '../../shared/native-preview.ts';

export type NativeEngineManifest={
  schemaVersion:1;engine:'motion-preview';engineVersion:string;protocolVersion:1;platform:'win32';arch:'x64';
  target:'x86_64-pc-windows-msvc';rustVersion:string;crt:'static';sourceLockSha256:string;
  binary:{name:'motion-preview.exe';size:number;sha256:string};
};
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function fields(value:unknown,keys:string[]):value is Record<string,unknown>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','));}
export function parseNativeEngineManifest(raw:unknown):NativeEngineManifest{
  if(!fields(raw,['schemaVersion','engine','engineVersion','protocolVersion','platform','arch','target','rustVersion','crt','sourceLockSha256','binary'])
    ||raw.schemaVersion!==1||raw.engine!=='motion-preview'||raw.engineVersion!==PREVIEW_ENGINE_VERSION||raw.protocolVersion!==PREVIEW_PROTOCOL_VERSION
    ||raw.platform!=='win32'||raw.arch!=='x64'||raw.target!=='x86_64-pc-windows-msvc'||raw.rustVersion!==PREVIEW_RUST_VERSION||raw.crt!=='static'||!hash(raw.sourceLockSha256)
    ||!fields(raw.binary,['name','size','sha256'])||raw.binary.name!=='motion-preview.exe'||!hash(raw.binary.sha256)
    ||!Number.isSafeInteger(raw.binary.size)||(raw.binary.size as number)<256||(raw.binary.size as number)>64*1024*1024)throw new AppFailure('NATIVE_ENGINE_VERSION','原生预览清单格式、版本或目标平台不匹配。');
  return raw as unknown as NativeEngineManifest;
}
export async function verifyNativeFiles(resources:string):Promise<{helper:string;manifest:NativeEngineManifest}>{
  const manifestPath=join(resources,'native-preview-manifest.json');let raw:unknown;
  try{
    const info=await lstat(manifestPath);if(!info.isFile()||info.isSymbolicLink()||info.size>16384)throw new Error('Invalid manifest file');
    const file=await open(manifestPath,'r');
    try{const buffer=Buffer.alloc(16385);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw new Error('Oversized manifest');raw=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}
    finally{await file.close();}
  }catch(error){throw new AppFailure('NATIVE_ENGINE_MISSING','缺少有效的原生预览引擎清单，不会使用系统 PATH 或联网下载。',{cause:error});}
  const manifest=parseNativeEngineManifest(raw),helper=join(resources,'bin',manifest.binary.name);
  let info;
  try{
    const directory=await lstat(join(resources,'bin'));if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('Unsafe native binary directory');
    info=await lstat(helper);
  }catch(error){throw new AppFailure('NATIVE_ENGINE_MISSING','原生预览引擎文件缺失或路径异常，请重新安装完整程序。',{cause:error});}
  if(!info.isFile()||info.isSymbolicLink()||info.size!==manifest.binary.size||await sha256(helper)!==manifest.binary.sha256)throw new AppFailure('NATIVE_ENGINE_INTEGRITY','原生预览引擎完整性校验失败，已阻止启动。');
  // Independently verify the PE machine; a JSON x64 label is not architecture evidence.
  const file=await open(helper,'r');
  try{
    const dos=Buffer.alloc(64);if((await file.read(dos,0,64,0)).bytesRead!==64||dos.readUInt16LE(0)!==0x5a4d)throw new Error('Not PE');
    const offset=dos.readUInt32LE(0x3c);if(offset<64||offset>info.size-26)throw new Error('Invalid PE offset');
    const pe=Buffer.alloc(26);if((await file.read(pe,0,26,offset)).bytesRead!==26||pe.readUInt32LE(0)!==0x4550||pe.readUInt16LE(4)!==0x8664||pe.readUInt16LE(24)!==0x20b)throw new Error('Not Windows x64 PE32+');
  }catch(error){throw new AppFailure('NATIVE_ENGINE_INTEGRITY','原生预览引擎不是有效的 Windows x64 程序。',{cause:error});}
  finally{await file.close();}
  return {helper,manifest};
}
export async function verifyNativeEngine(resources:string):Promise<{helper:string;version:string}>{
  const verified=await verifyNativeFiles(resources);
  if(process.platform!=='win32'||process.arch!=='x64')throw new AppFailure('NATIVE_PLATFORM','原生预览只支持 Windows x64。');
  const native=new NativePreview(verified.helper);
  try{
    const hello=await native.hello();return {helper:verified.helper,version:hello.engineVersion};
  }catch(error){
    if(error instanceof AppFailure&&['NATIVE_ENGINE_VERSION','NATIVE_PROTOCOL'].includes(error.code))throw new AppFailure('NATIVE_ENGINE_VERSION','原生预览引擎握手版本或协议不匹配。',{cause:error});
    throw new AppFailure('NATIVE_PLATFORM','原生预览引擎无法初始化。请检查系统 Media Foundation；Windows N 需要 Media Feature Pack。不会用转码伪装系统能力。',{cause:error});
  }finally{await native.shutdown();}
}
