// Read-only ISO BMFF sample-table index. This is NOT a decoded-frame index.
// Raw media PTS/DTS and edit-list entries stay separate: callers must not guess MF mapping.
// Initial scope: self-contained, non-fragmented MP4/MOV with one sample description per track.
import {open} from 'node:fs/promises';
import {setImmediate as yieldTask} from 'node:timers/promises';
import {inspectMp4} from '../motion/mp4.ts';
import {readExactly} from '../motion/io.ts';
import {assertSource,type SourceFile} from './source.ts';

export class Mp4IndexError extends Error {
  readonly kind:'unsupported'|'invalid'|'limit';
  constructor(kind:Mp4IndexError['kind'],message:string){super(message);this.name='Mp4IndexError';this.kind=kind;}
}
const fail=(message:string):never=>{throw new Mp4IndexError('invalid',message);};
const unsupported=(message:string):never=>{throw new Mp4IndexError('unsupported',message);};
const limit=(message:string):never=>{throw new Mp4IndexError('limit',message);};
type Box={type:string;body:Buffer};
type TimeRun={first:number;count:number;start:bigint;value:number};
type ChunkRun={first:number;chunk:number;perChunk:number};
export type Mp4Edit={duration:bigint;mediaTime:bigint};
export type Mp4Sample={decodeIndex:number;chunkIndex:number;offset:bigint;size:number;dts:bigint;pts:bigint;duration:number;sync:boolean};
export type Mp4TrackIndex={
  trackId:number;handler:string;timescale:number;duration:bigint;codec:string;sampleDescription:Buffer;
  edits:readonly Mp4Edit[];sampleCount:number;fixedSampleSize:number;sample(index:number):Mp4Sample;
};
export type Mp4SampleIndex={movieTimescale:number;tracks:readonly Mp4TrackIndex[];metadataBytes:number;indexBytes:number;samplePayloadBytesRead:0};
export type Mp4IndexLimits={metadataBytes?:number;indexBytes?:number;samples?:number;fixedSamples?:number;signal?:AbortSignal};
// ffprobe's stream.index is an ordinal, not an MP4 track ID. Never infer one from the other.
export function selectMp4Track(index:Mp4SampleIndex,id:unknown,handler:'vide'|'soun'):Mp4TrackIndex {
  const text=typeof id==='string'&&/^(?:0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$/.test(id)?id:unsupported('A verified container track ID is required');
  const number=BigInt(text);if(number<=0n||number>0xffffffffn)fail('Invalid container track ID');
  const found=index.tracks.filter(track=>BigInt(track.trackId)===number);
  if(found.length!==1||found[0]!.handler!==handler)fail('Selected track ID/handler does not match the container');
  return found[0]!;
}
const MAX_METADATA=32*1024*1024,MAX_INDEX=32*1024*1024,MAX_SAMPLES=1_000_000;
class Budget {
  boxes=0;indexBytes=0;samples=0;fixedSamples=0;
  readonly maximum:number;readonly sampleMaximum:number;readonly fixedMaximum:number;readonly signal?:AbortSignal;
  constructor(options:Mp4IndexLimits){
    this.maximum=bounded(options.indexBytes??MAX_INDEX,1,MAX_INDEX,'index budget');
    this.sampleMaximum=bounded(options.samples??MAX_SAMPLES,1,MAX_SAMPLES,'variable sample budget');
    this.fixedMaximum=bounded(options.fixedSamples??0xffffffff,1,0xffffffff,'fixed sample budget');this.signal=options.signal;
  }
  check(){this.signal?.throwIfAborted();}
  async yield(){this.check();await yieldTask();this.check();}
  charge(bytes:number){this.check();if(!Number.isSafeInteger(bytes)||bytes<0||bytes>this.maximum-this.indexBytes)limit('Sample index exceeds memory budget');this.indexBytes+=bytes;}
  count(samples:number,fixed:boolean){
    if(fixed){if(samples>this.fixedMaximum-this.fixedSamples)limit('Fixed sample count exceeds budget');this.fixedSamples+=samples;}
    else{if(samples>this.sampleMaximum-this.samples)limit('Variable sample count exceeds budget');this.samples+=samples;}
  }
}
function bounded(value:number,min:number,max:number,label:string){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Mp4IndexError('limit',`Invalid ${label}`);return value;}
function need(b:Buffer,length:number){if(b.length<length)fail('Truncated sample-table field');}
function full(b:Buffer,versions:readonly number[]=[0]){need(b,4);if(!versions.includes(b[0]!))unsupported('Unsupported full-box version');if(b.readUIntBE(1,3)!==0)unsupported('Unsupported full-box flags');return b[0]!;}
function children(buffer:Buffer,budget:Budget):Box[]{
  const boxes:Box[]=[];let at=0;
  while(at<buffer.length){
    budget.check();if(++budget.boxes>10000)limit('Too many metadata boxes');
    if(buffer.length-at<8)fail('Truncated metadata box');
    let size=buffer.readUInt32BE(at),header=8;
    if(size===1){need(buffer.subarray(at),16);const big=buffer.readBigUInt64BE(at+8);if(big>BigInt(Number.MAX_SAFE_INTEGER))fail('Oversized metadata box');size=Number(big);header=16;}
    else if(size===0)size=buffer.length-at;
    if(size<header||size>buffer.length-at)fail('Invalid metadata box extent');
    boxes.push({type:buffer.toString('latin1',at+4,at+8),body:buffer.subarray(at+header,at+size)});at+=size;
  }
  return boxes;
}
function one(boxes:Box[],type:string,optional=false):Buffer|undefined {
  const found=boxes.filter(box=>box.type===type);if(found.length>1)fail(`Duplicate ${type}`);
  if(!found.length&&!optional)fail(`Missing ${type}`);return found[0]?.body;
}
function entries(b:Buffer,width:number,offset=8){need(b,offset);const count=b.readUInt32BE(offset-4);if(count>(b.length-offset)/width||b.length!==offset+count*width)fail('Invalid table entry count/extent');return count;}
function timing(b:Buffer,movie=false){
  const version=full(b,[0,1]),at=version===1?20:12;need(b,movie?(version===1?112:100):(version===1?36:24));
  const timescale=b.readUInt32BE(at),duration=version===1?b.readBigUInt64BE(at+4):BigInt(b.readUInt32BE(at+4));
  if(!timescale||duration>(1n<<63n)-1n)fail('Invalid track timescale/duration');return {timescale,duration};
}
function trackId(b:Buffer){
  need(b,4);if(b[0]!==0&&b[0]!==1)unsupported('Unsupported track header version');
  const at=b[0]===1?20:12;need(b,b[0]===1?96:84);const id=b.readUInt32BE(at);if(!id)fail('Zero track ID');return id;
}
async function runs(b:Buffer,count:number,composition:boolean,budget:Budget):Promise<TimeRun[]>{
  // Yield between bounded batches so an AbortSignal can actually be delivered.
  const version=full(b,composition?[0,1]:[0]);const n=entries(b,8);budget.charge(n*128);
  const result:TimeRun[]=[];let first=0,start=0n;
  for(let i=0;i<n;i++){
    if((i&4095)===0)await budget.yield();
    const at=8+i*8,length=b.readUInt32BE(at),value=composition&&version===1?b.readInt32BE(at+4):b.readUInt32BE(at+4);
    if(!length||length>count-first||!composition&&!value)fail('Invalid sample timing run');
    result.push({first,count:length,start,value});first+=length;
    if(!composition){start+=BigInt(length)*BigInt(value);if(start>(1n<<63n)-1n)fail('Decode time overflow');}
  }
  if(first!==count)fail('Timing/sample counts differ');return result;
}
function floor<T>(rows:readonly T[],value:number,key:(row:T)=>number):T {
  let lo=0,hi=rows.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(key(rows[mid]!)<=value)lo=mid+1;else hi=mid;}
  if(!lo)fail('Sample is outside table');return rows[lo-1]!;
}
function edits(trak:Box[],budget:Budget):Mp4Edit[]{
  const edts=one(trak,'edts',true);if(!edts)return [];
  const elst=one(children(edts,budget),'elst')!,version=full(elst,[0,1]),width=version===1?20:12,n=entries(elst,width);
  if(n>1024)limit('Too many edit segments');budget.charge(n*32);const result:Mp4Edit[]=[];
  for(let i=0;i<n;i++){
    const at=8+i*width,duration=version===1?elst.readBigUInt64BE(at):BigInt(elst.readUInt32BE(at));
    const mediaTime=version===1?elst.readBigInt64BE(at+8):BigInt(elst.readInt32BE(at+4));
    const rateAt=at+(version===1?16:8);
    if(elst.readInt16BE(rateAt)!==1||elst.readInt16BE(rateAt+2)!==0)unsupported('Non-unit edit rate');
    if(!duration||duration>(1n<<63n)-1n||mediaTime< -1n)fail('Invalid edit segment');result.push({duration,mediaTime});
  }
  return result;
}
function insideMedia(ranges:readonly [bigint,bigint][],start:bigint,end:bigint){
  // Top-level payload ranges are sorted and disjoint. Avoid chunks × mdat linear scans.
  let lo=0,hi=ranges.length;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(ranges[mid]![0]<=start)lo=mid+1;else hi=mid;}
  return lo>0&&end<=ranges[lo-1]![1];
}
async function parseTrack(data:Buffer,mdat:readonly [bigint,bigint][],budget:Budget):Promise<Mp4TrackIndex|undefined> {
  const trak=children(data,budget),id=trackId(one(trak,'tkhd')!),mdia=children(one(trak,'mdia')!,budget);
  const hdlr=one(mdia,'hdlr')!;full(hdlr);need(hdlr,24);const handler=hdlr.toString('latin1',8,12);
  if(handler!=='vide'&&handler!=='soun')return undefined;
  const {timescale,duration}=timing(one(mdia,'mdhd')!),minf=children(one(mdia,'minf')!,budget);
  const dinf=children(one(minf,'dinf')!,budget),dref=one(dinf,'dref')!;full(dref);need(dref,8);
  const references=children(dref.subarray(8),budget);
  if(dref.readUInt32BE(4)!==1||references.length!==1||references[0]!.type!=='url ')unsupported('External/multiple data references');
  const url=references[0]!.body;if(url.length!==4||url[0]!==0||url.readUIntBE(1,3)!==1)unsupported('Media must be self-contained');
  const stbl=children(one(minf,'stbl')!,budget);
  if(stbl.some(box=>['stz2','senc','saiz','saio'].includes(box.type)))unsupported('Compact/encrypted sample tables are not supported');
  const stsd=one(stbl,'stsd')!;full(stsd);need(stsd,8);const descriptions=children(stsd.subarray(8),budget);
  if(stsd.readUInt32BE(4)!==1||descriptions.length!==1)unsupported('Multiple sample descriptions');
  const description=descriptions[0]!;need(description.body,8);
  if(description.body.readUInt16BE(6)!==1)unsupported('Nonlocal sample description');
  const supported=handler==='vide'?['avc1','avc3','hvc1','hev1']:['mp4a','sowt','twos','lpcm','ipcm'];
  if(!supported.includes(description.type))unsupported(`Unsupported sample entry ${description.type}`);
  const stsz=one(stbl,'stsz')!;full(stsz);need(stsz,12);
  const fixed=stsz.readUInt32BE(4),count=stsz.readUInt32BE(8);if(!count)unsupported('Empty media track');budget.count(count,fixed!==0);
  if(stsz.length!==12+(fixed?0:count*4))fail('Invalid sample sizes');
  // PCM can have millions of fixed-size samples. Keep its prefix implicit, O(1),
  // rather than allocating/visiting one BigInt entry for every PCM sample.
  let prefix:BigUint64Array|undefined;
  if(!fixed){
    budget.charge((count+1)*8);prefix=new BigUint64Array(count+1);
    for(let i=0;i<count;i++){
      if((i&4095)===0)await budget.yield();const size=stsz.readUInt32BE(12+i*4);if(!size)fail('Zero sample size');
      const sum=prefix[i]!+BigInt(size);if(sum>BigInt(Number.MAX_SAFE_INTEGER))fail('Sample sizes overflow');prefix[i+1]=sum;
    }
  }
  const bytesBefore=(i:number)=>fixed?BigInt(i)*BigInt(fixed):prefix![i]!;
  const decode=await runs(one(stbl,'stts')!,count,false,budget),ctts=one(stbl,'ctts',true),compose=ctts?await runs(ctts,count,true,budget):undefined;
  const sync=one(stbl,'stss',true);
  if(sync){full(sync);const n=entries(sync,4);let previous=0;for(let i=0;i<n;i++){if((i&4095)===0)await budget.yield();const value=sync.readUInt32BE(8+i*4);if(value<=previous||value>count)fail('Invalid sync sample table');previous=value;}}
  const stco=one(stbl,'stco',true),co64=one(stbl,'co64',true);if(Boolean(stco)===Boolean(co64))fail('Exactly one chunk-offset table is required');
  const offsets=(stco??co64)!,wide=Boolean(co64);full(offsets);const chunks=entries(offsets,wide?8:4);
  if(!chunks||chunks>count)fail('Invalid chunk count');
  const chunkOffset=(i:number)=>wide?offsets.readBigUInt64BE(8+i*8):BigInt(offsets.readUInt32BE(8+i*4));
  const stsc=one(stbl,'stsc')!;full(stsc);const n=entries(stsc,12);if(!n||n>chunks)fail('Invalid chunk runs');budget.charge(n*64);
  const chunkRuns:ChunkRun[]=[];let first=0;
  for(let i=0;i<n;i++){
    const at=8+i*12,chunk=stsc.readUInt32BE(at),perChunk=stsc.readUInt32BE(at+4),descriptionIndex=stsc.readUInt32BE(at+8);
    const next=i+1<n?stsc.readUInt32BE(at+12):chunks+1;
    if(!chunk||i===0&&chunk!==1||chunk>chunks||next<=chunk||next>chunks+1||!perChunk||descriptionIndex!==1)fail('Invalid sample-to-chunk mapping');
    const samples=(next-chunk)*perChunk;if(!Number.isSafeInteger(samples)||samples>count-first)fail('Chunk/sample counts differ');
    chunkRuns.push({first,chunk:chunk-1,perChunk});
    for(let c=chunk-1;c<next-1;c++){
      if((c&4095)===0)await budget.yield();const start=chunkOffset(c),end=start+bytesBefore(first+perChunk)-bytesBefore(first);
      if(!insideMedia(mdat,start,end))fail('Sample bytes are outside an mdat payload');first+=perChunk;
    }
  }
  if(first!==count)fail('Chunk/sample counts differ');
  // Metadata remains backing storage; no sample payload is read or interpreted here.
  return {trackId:id,handler,timescale,duration,codec:description.type,sampleDescription:description.body,
    edits:edits(trak,budget),sampleCount:count,fixedSampleSize:fixed,sample(index:number){
      if(!Number.isSafeInteger(index)||index<0||index>=count)throw new RangeError('Sample index out of range');
      const time=floor(decode,index,row=>row.first),dts=time.start+BigInt(index-time.first)*BigInt(time.value);
      const pts=dts+BigInt(compose?floor(compose,index,row=>row.first).value:0);
      if(pts<-(1n<<63n)||pts>(1n<<63n)-1n)fail('Presentation time overflow');
      const run=floor(chunkRuns,index,row=>row.first),relative=index-run.first,chunk=run.chunk+Math.floor(relative/run.perChunk),chunkFirst=index-relative%run.perChunk;
      let isSync=true;
      if(sync){let lo=0,hi=sync.readUInt32BE(4);while(lo<hi){const mid=Math.floor((lo+hi)/2);if(sync.readUInt32BE(8+mid*4)<index+1)lo=mid+1;else hi=mid;}isSync=lo<sync.readUInt32BE(4)&&sync.readUInt32BE(8+lo*4)===index+1;}
      return {decodeIndex:index,chunkIndex:chunk,offset:chunkOffset(chunk)+bytesBefore(index)-bytesBefore(chunkFirst),size:fixed||Number(bytesBefore(index+1)-bytesBefore(index)),dts,pts,duration:time.value,sync:isSync};
    }};
}
export async function readMp4SampleIndex(source:SourceFile,options:Mp4IndexLimits={}):Promise<Mp4SampleIndex>{
  const metadataLimit=bounded(options.metadataBytes??MAX_METADATA,1,MAX_METADATA,'metadata budget'),budget=new Budget(options);
  budget.check();await assertSource(source);const file=await open(source.path,'r');
  try{
    const stamp=async()=>{const s=await file.stat({bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;};
    if(await stamp()!==source.stamp)fail('Opened source identity changed');
    const top=await inspectMp4(file,0,source.size,{signal:options.signal,maximumBoxes:10000});budget.check();
    if(top.some(box=>box.type==='moof'))unsupported('Fragmented MP4 needs a separate index path');
    const moovs=top.filter(box=>box.type==='moov');if(moovs.length!==1)fail('Exactly one moov is required');
    const moov=moovs[0]!;if(moov.size>metadataLimit)limit('Movie metadata exceeds budget');
    const mdat:[bigint,bigint][]=[];
    for(const box of top.filter(box=>box.type==='mdat')){
      const header=await readExactly(file,box.offset,8),size=header.readUInt32BE()===1?16:8;
      mdat.push([BigInt(box.offset+size),BigInt(box.offset+box.size)]);
    }
    const raw=await readExactly(file,moov.offset,moov.size),header=raw.readUInt32BE()===1?16:8;
    const movie=children(raw.subarray(header),budget);if(one(movie,'mvex',true))unsupported('Fragmented MP4 initialization');
    const movieTimescale=timing(one(movie,'mvhd')!,true).timescale,trackBoxes=movie.filter(box=>box.type==='trak');
    if(!trackBoxes.length||trackBoxes.length>64)limit('Invalid track count');
    const tracks:Mp4TrackIndex[]=[],ids=new Set<number>();
    for(const box of trackBoxes){
      budget.check();const track=await parseTrack(box.body,mdat,budget);if(!track)continue;
      if(ids.has(track.trackId))fail('Duplicate track ID');ids.add(track.trackId);tracks.push(track);
    }
    if(!tracks.some(track=>track.handler==='vide'))unsupported('No indexed video track');
    budget.check();if(await stamp()!==source.stamp)fail('Source changed while reading metadata');await assertSource(source);
    return {movieTimescale,tracks,metadataBytes:raw.length,indexBytes:budget.indexBytes,samplePayloadBytesRead:0};
  }finally{await file.close();}
}
