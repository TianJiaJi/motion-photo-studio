// Import-only shortcut for ordinary CFR AVC/HEVC. This produces CANDIDATES, not a ready mapping.
// The unchanged full native scan/count/interval/seek gates, plus duration checks, must still pass.
import {open,type FileHandle} from 'node:fs/promises';
import {extname} from 'node:path';
import {setImmediate as yieldTask} from 'node:timers/promises';
import type {MediaInfo} from '../../shared/media.ts';
import {ptsToUs} from '../../shared/editor.ts';
import {readMp4SampleIndex,selectMp4Track} from './mp4-sample-index.ts';
import {FrameIndex,INDEX_RECORD_BYTES} from './frame-index.ts';
import {assertSource,type SourceFile} from './source.ts';
import {unlinkCreatedFile} from '../jobs/temp-files.ts';
async function writeAll(file:FileHandle,bytes:Buffer){let at=0;while(at<bytes.length){const {bytesWritten}=await file.write(bytes,at,bytes.length-at);if(!bytesWritten)throw new Error('Index write made no progress');at+=bytesWritten;}}
export async function buildContainerFrameIndex(options:{source:SourceFile;info:MediaInfo;trackId:unknown;output:string;signal:AbortSignal;
  maxBytes:number;onProgress?:(frames:number)=>void|Promise<void>}):Promise<FrameIndex|undefined>{
  const {source,info,signal}=options;signal.throwIfAborted();await assertSource(source);
  if(!['.mp4','.mov','.m4v'].includes(extname(source.path).toLowerCase()))return;
  let container:Awaited<ReturnType<typeof readMp4SampleIndex>>;
  let track:ReturnType<typeof selectMp4Track>;
  try{container=await readMp4SampleIndex(source,{signal});track=selectMp4Track(container,options.trackId,'vide');}
  catch{signal.throwIfAborted();await assertSource(source);return; /* Unsupported metadata keeps the original decode-based path. */}
  if(!['avc1','hvc1'].includes(track.codec)||track.sampleCount<2||track.sampleCount>100000
    ||track.sampleCount*INDEX_RECORD_BYTES>options.maxBytes
    ||BigInt(info.timeBase.numerator)*BigInt(track.timescale)!==BigInt(info.timeBase.denominator))return;
  let leading=0n,media=false,shift=0n;
  for(const edit of track.edits){
    if(edit.mediaTime===-1n&&!media){const value=edit.duration*BigInt(track.timescale);if(value%BigInt(container.movieTimescale))return;leading+=value/BigInt(container.movieTimescale);}
    else if(edit.mediaTime>=0n&&!media){media=true;shift=leading-edit.mediaTime;}
    else return;
  }
  if(track.edits.length&&!media)return;
  // 17 bytes per video sample, capped at 100k. No lossy Number conversion of PTS.
  const count=track.sampleCount,pts=new BigInt64Array(count),order=new Uint32Array(count),duration=new Uint32Array(count),keys=new Uint8Array(count);
  for(let i=0;i<count;i++){
    if((i&4095)===0){await yieldTask();signal.throwIfAborted();}
    const sample=track.sample(i),value=sample.pts+shift;if(value<-(1n<<63n)||value>=(1n<<63n))return;
    pts[i]=value;order[i]=i;duration[i]=sample.duration;keys[i]=Number(sample.sync);
  }
  order.sort((a,b)=>pts[a]!<pts[b]!?-1:pts[a]!>pts[b]!?1:0);signal.throwIfAborted();
  const first=order[0]!,interval=pts[order[1]!]!-pts[first]!;
  if(pts[first]!==BigInt(info.startPts)||!keys[first]||interval<=0n)return;
  for(let i=0;i<count;i++){
    if((i&4095)===0){await yieldTask();signal.throwIfAborted();}
    const row=order[i]!;
    // Genuine VFR, duplicate timestamps, shortened durations and ambiguous edits use the old path.
    if(BigInt(duration[row]!)!==interval||i>0&&pts[row]!-pts[order[i-1]!]! !==interval)return;
    const time=ptsToUs(String(pts[row]),info.startPts,info.timeBase);
    if(!Number.isSafeInteger(time)||time<0||time>=info.durationUs)return;
  }
  await assertSource(source);signal.throwIfAborted();
  const file=await open(options.output,'wx');let success=false;
  try{
    for(let start=0;start<count;start+=128){
      signal.throwIfAborted();const rows=Math.min(128,count-start),block=Buffer.alloc(rows*INDEX_RECORD_BYTES);
      for(let i=0;i<rows;i++){
        const row=order[start+i]!,at=i*INDEX_RECORD_BYTES;
        block.writeBigInt64LE(pts[row]!,at);block.writeBigInt64LE(BigInt(ptsToUs(String(pts[row]),info.startPts,info.timeBase)),at+8);
        block.writeBigInt64LE(BigInt(duration[row]!),at+24);block.writeUInt32LE(keys[row]!,at+40);
      }
      await writeAll(file,block);await options.onProgress?.(start+rows);
    }
    await file.sync();await assertSource(source);signal.throwIfAborted();success=true;
    return new FrameIndex(options.output,count,info,true);
  }finally{try{await file.close();}finally{if(!success)await unlinkCreatedFile(options.output);}}
}
