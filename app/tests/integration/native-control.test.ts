import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
import type { NativeFrameInfo } from '../../src/main/media/native-preview.ts';
const helper=resolve('resources/bin/motion-preview.exe');
const skip=process.platform!=='win32';

test('new interaction epoch settles obsolete requests; parent-pipe loss releases native reader', {skip,timeout:60000},async()=>{
  const temp=await tempFiles(); let prepared:PreparedNativeMedia|undefined;
  const ffmpeg=resolve('resources/bin/ffmpeg.exe'),ffprobe=resolve('resources/bin/ffprobe.exe');
  try {
    const path=temp.file('source.mp4'); await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=1280x720:rate=30:duration=6',
      '-an','-c:v','libx264','-preset','ultrafast','-g','180','-bf','3',path]);
    const source=await openSource(path),info=mediaInfo(await probeMedia(path,{executable:ffprobe}));
    const directory=temp.file('session'); await mkdir(directory);
    prepared=await prepareNativeMedia({source,info,directory,helper,ffmpeg,ffprobe,signal:new AbortController().signal,maximumEdge:640});
    const {native,index}=prepared;
    await native.request({command:'quality',maximumEdge:320}); await native.request({command:'quality',maximumEdge:640});
    const oldRows=await Promise.all([160,159,158].map(number=>index.get(number))),final=await index.get(3);
    const requests=oldRows.map(row=>native.request<NativeFrameInfo>({command:'locate',timeHns:row.nativeHns,seekHns:'0'}));
    native.advanceEpoch();
    const latest=native.request<NativeFrameInfo>({command:'locate',timeHns:final.nativeHns,seekHns:'0'});
    // Observe every promise immediately, including those cancelled by the independent control thread.
    const results=await Promise.allSettled([...requests,latest]);
    const last=results.at(-1)!; assert.equal(last.status,'fulfilled');
    if(last.status==='fulfilled') {
      assert.equal(last.value.generation,native.epoch);
      assert.equal((await index.fromNative(last.value.value.timestampHns)).index,3);
    }
    for(const result of results.slice(0,-1)) {
      if(result.status==='rejected') assert.equal(result.reason.code,'CANCELLED');
      else assert.ok(result.value.generation<native.epoch,'Old results remain tagged with their old epoch');
    }
    assert.ok(results.some(result=>result.status==='rejected'),'At least one superseded queued target should be cancelled');
    assert.equal(native.busy,false);
    await native.shutdown(); await index.close(); prepared=undefined;

    // Real stdin disconnection without the shutdown command exercises the parent-loss path.
    const orphan=spawn(helper,[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let timer:NodeJS.Timeout|undefined; let stderr=''; let response=Buffer.alloc(0); let disconnected=false;
    const ended=new Promise<number|null>((resolve,reject)=>{
      orphan.once('error',reject); orphan.once('close',code=>resolve(code));
      timer=setTimeout(()=>{orphan.kill();reject(new Error(`Parent EOF did not release helper: ${stderr}`));},8000);
    });
    orphan.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-8192);});
    orphan.stdout.on('data',(data:Buffer)=>{
      response=Buffer.concat([response,data]);
      if(!disconnected&&response.length>=4&&response.length>=4+response.readUInt32LE()) {
        disconnected=true; orphan.stdin.end();
      }
    });
    orphan.stdin.on('error',()=>{});
    const header=Buffer.from(JSON.stringify({version:1,id:1,generation:1,command:'open',path,maximumEdge:640}));
    const length=Buffer.alloc(4);length.writeUInt32LE(header.length);orphan.stdin.write(Buffer.concat([length,header]));
    try {
      assert.equal(await ended,0);assert.equal(disconnected,true);
      const opened=JSON.parse(response.subarray(4,4+response.readUInt32LE()).toString()); assert.equal(opened.error,undefined);assert.ok(opened.result.width>0);
    } finally {if(timer)clearTimeout(timer);}
  } finally {await prepared?.native.shutdown();await prepared?.index.close();await temp.cleanup();}
});
