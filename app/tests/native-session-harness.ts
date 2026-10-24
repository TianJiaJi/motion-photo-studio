import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {tempFiles} from './helpers.ts';
import {MediaSession} from '../src/main/media/session.ts';
import {MediaResources} from '../src/main/media/resources.ts';
import {TempFiles} from '../src/main/jobs/temp-files.ts';
import type {PreviewStamp} from '../src/shared/native-preview.ts';
export async function nativeSessionHarness() {
  const temp=await tempFiles(),store=new TempFiles(temp.file('sessions'));await store.initialize();
  const resources=new MediaResources(),warnings:string[]=[],frames:PreviewStamp[]=[],ackErrors:unknown[]=[];
  let manager:MediaSession,epoch=0;
  manager=new MediaSession({ffmpeg:resolve('resources/bin/ffmpeg.exe'),ffprobe:resolve('resources/bin/ffprobe.exe'),build:'fixture'},store,resources,message=>warnings.push(message),undefined,undefined,[],{
    helper:resolve('resources/bin/motion-preview.exe'),status:()=>{},frame(frame){
      const {pixels:_pixels,...stamp}=frame;frames.push(stamp);
      queueMicrotask(()=>{try{manager.nativeAcknowledge({assetId:stamp.assetId,epoch:stamp.epoch,frameId:stamp.frameId,painted:true});}catch(error){ackErrors.push(error);}});
    },
  });
  function confirmed(){assert.deepEqual(ackErrors,[]);const frame=frames.at(-1);assert.ok(frame);assert.equal(frame.epoch,epoch);return frame;}
  return {temp,store,resources,warnings,manager,frames,
    async seek(assetId:string,timeUs:number){await manager.nativeControl({assetId,epoch:++epoch,action:'seek',timeUs,boundary:'after',maximumEdge:960,final:true});return confirmed();},
    async step(assetId:string,frameId:number,direction:-1|1){await manager.nativeControl({assetId,epoch:++epoch,action:'step',frameId,direction});return confirmed();},
    async cleanup(){await manager.shutdown();await resources.dispose();await temp.cleanup();assert.deepEqual(ackErrors,[]);},
  };
}
