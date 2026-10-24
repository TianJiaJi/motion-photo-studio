import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {TempFiles} from '../../src/main/jobs/temp-files.ts';
import {tempFiles} from '../helpers.ts';

test('a real Windows exclusive handle retains ownership and cleanup recovers after handle release',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const temp=await tempFiles();let child:ReturnType<typeof spawn>|undefined,closed:Promise<void>|undefined;
  try{
    const store=new TempFiles(temp.file('jobs'));await store.initialize();const directory=await store.create(),path=join(directory,'locked.mp4');
    await writeFile(path,'owned cache');await writeFile(temp.file('original.mp4'),'original source');
    const marker=await readFile(join(directory,'.owner.json'),'utf8');
    const script=`$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open($env:MOTION_TEST_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { $f.Dispose() }`;
    const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MOTION_TEST_LOCK_FILE:path}});
    closed=new Promise<void>(resolve=>child!.once('close',()=>resolve()));
    await new Promise<void>((resolve,reject)=>{
      let output='',error='';const timer=setTimeout(()=>{cleanup();reject(new Error(`Exclusive-handle fixture did not start: ${error}`));},10000);
      const cleanup=()=>{clearTimeout(timer);child!.stdout!.off('data',data);child!.off('error',failed);child!.off('close',exited);};
      const data=(chunk:Buffer)=>{output+=chunk.toString();if(output.includes('locked')){cleanup();resolve();}};
      const failed=(cause:Error)=>{cleanup();reject(cause);};
      const exited=()=>{cleanup();reject(new Error(`Exclusive-handle fixture exited: ${error}`));};
      child!.stdout!.on('data',data);child!.stderr!.on('data',(chunk:Buffer)=>{error=(error+chunk.toString()).slice(-4096);});child!.once('error',failed);child!.once('close',exited);
    });
    await assert.rejects(store.remove(directory));
    assert.equal(await readFile(join(directory,'.owner.json'),'utf8'),marker);
    assert.ok(['in-use','permission'].includes(store.issues[0]!.reason));
    child.stdin!.end('\n');await closed;child=undefined;
    assert.equal(await readFile(path,'utf8'),'owned cache');
    const recovered=new TempFiles(store.root);assert.deepEqual(await recovered.initialize(),[]);assert.deepEqual(await readdir(store.root),[]);
    assert.equal(await readFile(temp.file('original.mp4'),'utf8'),'original source');
  }finally{if(child){child.kill();await closed;}await temp.cleanup();}
});
