import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import type {MediaInfo} from '../../shared/media.ts';
import {parseRational} from '../../shared/editor.ts';
import {AppFailure} from '../errors.ts';
import {NativePreview,nativeInteger} from './native-preview.ts';
import {assertSource,type SourceFile} from './source.ts';
import type {Stream} from './probe.ts';
import {streamProcessLines} from './lines.ts';
export type PreparedAudioTrack={
  sourceIndex:number;kind:'source'|'pcm'|'silent';path:string|null;streamIndex:number;
  offsetHns:string;sampleRate:number;samples:string;firstRelativeHns:string|null;
};
type Summary={rate:number;samples:bigint;first:bigint|null;end:bigint|null;continuous:boolean;blocks:number};
function fresh(rate:number):Summary{return{rate,samples:0n,first:null,end:null,continuous:true,blocks:0};}
function invalid(message:string):never{throw new AppFailure('FRAME_INDEX',message);}
function add(summary:Summary,time:bigint,samples:number){
  if(!Number.isSafeInteger(samples)||samples<=0||samples>16_777_216||++summary.blocks>20_000_000)invalid('音频样本数量超出验证范围。');
  if(summary.first!==null){const expected=summary.first+summary.samples*10_000_000n/BigInt(summary.rate);
    const delta=time-expected,tolerance=10_000_000n/BigInt(summary.rate)+2n;
    if(delta>tolerance||delta< -tolerance)summary.continuous=false;}
  summary.first??=time;summary.samples+=BigInt(samples);summary.end=time+BigInt(samples)*10_000_000n/BigInt(summary.rate);
}
async function sourceSummary(source:SourceFile,stream:Stream,executable:string,signal:AbortSignal):Promise<Summary>{
  const rate=Number(stream.sample_rate),base=parseRational(stream.time_base);
  if(!Number.isSafeInteger(rate)||rate<1||rate>1_536_000||!base)invalid('音轨缺少可信的采样率或时间基。');
  const summary=fresh(rate);
  await streamProcessLines(executable,['-v','error','-protocol_whitelist','file,pipe','-select_streams',String(stream.index),
    '-show_entries','frame=pts,nb_samples','-of','compact=p=0:nk=0','-i',source.path],line=>{
    const fields=Object.fromEntries(line.split('|').map(part=>{const equal=part.indexOf('=');return [part.slice(0,equal),part.slice(equal+1)];}));
    if(!Object.hasOwn(fields,'nb_samples'))return;
    const text=fields.pts;
    if(typeof text!=='string'||! /^-?\d{1,19}$/.test(text))invalid('音轨含有缺失或无效的源 PTS。');
    const pts=BigInt(text);if(pts<-(1n<<63n)||pts>=(1n<<63n))invalid('音轨 PTS 溢出。');
    add(summary,pts*BigInt(base.numerator)*10_000_000n/BigInt(base.denominator),Number(fields.nb_samples));
  },{signal,timeoutMs:0});
  return summary;
}
async function nativeSummary(native:NativePreview,path:string,streamIndex:number,signal:AbortSignal,onBlocks:(blocks:number)=>Promise<void>):Promise<Summary>{
  try {
    const {value:info}=await native.request<{sampleRate:number}>({command:'audioScanOpen',path,streamIndex},{signal});
    if(!Number.isSafeInteger(info.sampleRate)||info.sampleRate<8000||info.sampleRate>192000)invalid('原生音轨采样率不合法。');
    const summary=fresh(info.sampleRate);
    for(;;){
      const {value}=await native.request<{frames:{timestampHns:string;samples:number}[];ended:boolean}>({command:'audioScan',count:128},{signal});
      if(!Array.isArray(value.frames)||value.frames.length>128||typeof value.ended!=='boolean'||!value.ended&&value.frames.length===0)invalid('原生音频扫描没有进展。');
      for(const frame of value.frames)add(summary,nativeInteger(frame.timestampHns),frame.samples);
      await onBlocks(summary.blocks);if(value.ended)return summary;
    }
  } finally {if(native.alive&&!signal.aborted)await native.request({command:'audioScanClose'},{signal});}
}
// Import-only. All tracks are prepared before ready; selection/playback never invokes media tools.
export async function prepareNativeAudio(options:{source:SourceFile;info:MediaInfo;streams:Stream[];directory:string;
  native:NativePreview;ffmpeg:string;ffprobe:string;signal:AbortSignal;forceCompatibility?:boolean;
  createOwnedFile:(path:string,text:string)=>Promise<void>;checkBudget:(additionalBytes:number)=>Promise<void>;
  onProgress?:(blocks:number)=>void;
}):Promise<{tracks:PreparedAudioTrack[];bytes:number;warnings:string[]}>{
  const {source,info,native,signal}=options;const tracks:PreparedAudioTrack[]=[];const warnings:string[]=[];let bytes=0;
  const videoOrigin=BigInt(info.startPts)*BigInt(info.timeBase.numerator)*10_000_000n/BigInt(info.timeBase.denominator);
  for(const track of info.audioTracks){
    signal.throwIfAborted();await assertSource(source);
    const stream=options.streams.find(stream=>stream.index===track.index&&stream.codec_type==='audio');
    if(!stream)invalid('音轨在准备期间消失。');
    const original=await sourceSummary(source,stream,options.ffprobe,signal);
    const firstRelative=original.first===null?null:original.first-videoOrigin;
    if(firstRelative===null||firstRelative>=BigInt(info.durationUs)*10n||original.end!==null&&original.end<=videoOrigin){
      tracks.push({sourceIndex:track.index,kind:'silent',path:null,streamIndex:0,offsetHns:'0',sampleRate:original.rate,samples:'0',firstRelativeHns:firstRelative?.toString()??null});
      warnings.push(`音轨 ${track.index} 在视频范围内没有音频样本。`);continue;
    }
    if(!options.forceCompatibility) {
    try {
      // MF may reorder streams. Counts/rates/durations do NOT establish the identity of
      // same-shaped tracks. Until container track IDs are verified, isolate multiple
      // tracks by explicit ffmpeg source index during import rather than guess a mapping.
      if(info.audioTracks.length!==1)invalid('多音轨的 MF/容器轨道身份未核对，必须逐轨隔离准备。');
      const {value:enumeration}=await native.request<{streams:{streamIndex:number;sampleRate:number;channels:number}[]}>({command:'audioStreams',path:source.path},{signal});
      if(!Array.isArray(enumeration.streams)||enumeration.streams.length!==1)invalid('MF 与源音轨数量不一致。');
      const selected=enumeration.streams[0];
      if(!selected||!Number.isSafeInteger(selected.streamIndex)||selected.streamIndex<0||selected.streamIndex>=64)invalid('MF 音轨编号不合法。');
      const nativeIndex=selected.streamIndex;
      const decoded=await nativeSummary(native,source.path,nativeIndex,signal,async blocks=>{await options.checkBudget(bytes);options.onProgress?.(blocks);});
      if(!original.continuous||!decoded.continuous||decoded.rate!==original.rate||decoded.samples!==original.samples||decoded.first===null)invalid('原生音轨的完整样本数/连续区间与源轨不一致。');
      const offset=decoded.first-firstRelative;
      tracks.push({sourceIndex:track.index,kind:'source',path:source.path,streamIndex:nativeIndex,offsetHns:offset.toString(),sampleRate:decoded.rate,samples:decoded.samples.toString(),firstRelativeHns:firstRelative.toString()});
      continue;
    } catch(error) {
      signal.throwIfAborted();if(!(error instanceof AppFailure)||!['NATIVE_MEDIA','FRAME_INDEX'].includes(error.code))throw error;
      warnings.push(`音轨 ${track.index} 需要导入期 PCM 兼容资源：${error.message}`);
    }
    } else warnings.push(`音轨 ${track.index} 按明确的导入兼容策略准备整轨 PCM。`);
    // 48 kHz stereo PCM, including original-PTS gaps. No STARTPTS reset that would erase leading delay.
    const expectedSamples=BigInt(info.durationUs)*48000n/1_000_000n;
    const estimate=Number(expectedSamples*4n+4096n);
    if(estimate>3*1024**3)throw new AppFailure('PREVIEW_BUDGET','单轨 PCM 编辑资源超过安全 WAV 大小。');
    await options.checkBudget(bytes+estimate);
    const path=join(options.directory,`audio-${track.index}-${randomUUID()}.wav`);await options.createOwnedFile(path,'');
    const duration=(info.durationUs/1_000_000).toFixed(6);
    const filters=`asetpts=PTS-(${info.startPts}*${info.timeBase.numerator}/${info.timeBase.denominator})/TB,aresample=48000:async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`;
    await streamProcessLines(options.ffmpeg,['-hide_banner','-v','error','-nostdin','-y','-copyts','-protocol_whitelist','file,pipe',
      '-i',source.path,'-map',`0:${track.index}`,'-vn','-sn','-dn','-af',filters,'-ac','2','-ar','48000','-c:a','pcm_s16le',
      '-map_metadata','-1','-progress','pipe:1','-nostats',path],async line=>{
      const match=/^total_size=(\d+)$/.exec(line);if(match)await options.checkBudget(bytes+Number(match[1]));
    },{signal,timeoutMs:0});
    bytes+=(await stat(path)).size;await options.checkBudget(bytes);await assertSource(source);
    const decoded=await nativeSummary(native,path,0,signal,async blocks=>{await options.checkBudget(bytes);options.onProgress?.(blocks);});
    if(decoded.rate!==48000||!decoded.continuous||decoded.first!==0n||decoded.samples<expectedSamples-1n||decoded.samples>expectedSamples+1n)invalid('PCM 编辑音轨未通过零起点/完整时长验证。');
    tracks.push({sourceIndex:track.index,kind:'pcm',path,streamIndex:0,offsetHns:'0',sampleRate:48000,samples:decoded.samples.toString(),firstRelativeHns:'0'});
  }
  await assertSource(source);signal.throwIfAborted();return {tracks,bytes,warnings};
}
