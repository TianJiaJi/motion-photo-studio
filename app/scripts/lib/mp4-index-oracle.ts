// Test/diagnostic adapter only. Never used by interactive import or playback.
// Compare raw container samples first, then the edit-applied demux view separately.
// PCM samples may be grouped into one demux packet; compressed samples are NOT frames.
import type {Mp4SampleIndex,Mp4TrackIndex} from '../../src/main/media/mp4-sample-index.ts';
import {selectMp4Track} from '../../src/main/media/mp4-sample-index.ts';
import type {Stream} from '../../src/main/media/probe.ts';
import {streamProcessLines} from '../../src/main/media/lines.ts';
type Phase='raw'|'edited';
type Counter={packets:number;samples:number};
type State={track:Mp4TrackIndex;stream:number;numerator:bigint;denominator:bigint;shift:bigint;endNumerator:bigint|null;
  raw:Counter;edited:Counter;expectedEdited:Counter;excludedTailPackets:number;excludedTailSamples:number};
export type Mp4OracleReport={passed:boolean;mismatchCounts:Record<string,number>;mismatches:unknown[];tracks:{
  streamIndex:number;trackId:number;raw:Counter;edited:Counter;expectedEdited:Counter;excludedTailPackets:number;excludedTailSamples:number;
}[];tailExclusions:unknown[]};
function integer(text:string|undefined){if(!text||! /^-?\d{1,19}$/.test(text))throw new Error('Invalid packet integer');return BigInt(text);}
function editGeometry(track:Mp4TrackIndex,movieScale:number){
  let leading=0n,media=false,shift=0n,endNumerator:bigint|null=null;
  for(const edit of track.edits){
    if(edit.mediaTime===-1n&&!media){const ticks=edit.duration*BigInt(track.timescale);if(ticks%BigInt(movieScale))throw new Error('Oracle adapter does not cover fractional empty edits');leading+=ticks/BigInt(movieScale);}
    else if(edit.mediaTime>=0n&&!media){media=true;shift=leading-edit.mediaTime;endNumerator=edit.mediaTime*BigInt(movieScale)+edit.duration*BigInt(track.timescale);}
    else throw new Error('Oracle adapter covers only leading empty edits and one media edit');
  }
  if(track.edits.length&&!media)throw new Error('Oracle adapter does not cover an empty-only edit list');
  return {shift,endNumerator};
}
export async function verifyMp4PacketIndex(options:{index:Mp4SampleIndex;streams:Stream[];source:string;ffprobe:string;signal?:AbortSignal}):Promise<Mp4OracleReport>{
  const {index}=options,states=new Map<number,State>();
  const report:Mp4OracleReport={passed:false,mismatchCounts:{},mismatches:[],tracks:[],tailExclusions:[]};
  for(const stream of options.streams.filter(stream=>['video','audio'].includes(stream.codec_type))){
    const track=selectMp4Track(index,stream.id,stream.codec_type==='video'?'vide':'soun'),base=/^(\d+)\/(\d+)$/.exec(stream.time_base??'');
    if(!base||BigInt(base[1]!)<=0n||BigInt(base[2]!)<=0n||states.has(stream.index))throw new Error('Invalid oracle stream identity/time base');
    states.set(stream.index,{track,stream:stream.index,...editGeometry(track,index.movieTimescale),numerator:BigInt(base[1]!),denominator:BigInt(base[2]!),
      raw:{samples:0,packets:0},edited:{samples:0,packets:0},expectedEdited:{samples:0,packets:0},excludedTailPackets:0,excludedTailSamples:0});
  }
  const mismatch=(phase:Phase,field:string,stream:number,sample:number,expected:unknown,actual:unknown)=>{
    const key=`${phase}.${field}`;report.mismatchCounts[key]=(report.mismatchCounts[key]??0)+1;
    if(report.mismatches.length<32)report.mismatches.push({phase,field,stream,sample,expected,actual});
  };
  for(const phase of ['raw','edited'] as const){
    let totalPackets=0;
    await streamProcessLines(options.ffprobe,['-v','error',...(phase==='raw'?['-ignore_editlist','1']:[]),'-show_packets',
      '-show_entries','packet=stream_index,pts,dts,duration,pos,size,flags','-of','compact=p=0:nk=0',options.source],line=>{
      const fields=Object.fromEntries(line.split('|').map(part=>{const at=part.indexOf('=');return [part.slice(0,at),part.slice(at+1)];}));
      if(!Object.hasOwn(fields,'stream_index'))return;
      if(++totalPackets>1_000_000)throw new Error('Oracle packet count exceeds diagnostic bound');
      const stream=Number(fields.stream_index),state=states.get(stream);if(!state)return;
      const counter=state[phase],firstIndex=counter.samples,bytes=integer(fields.size);
      const pcm=state.track.handler==='soun'&&['ipcm','lpcm','sowt','twos'].includes(state.track.codec);
      let span=1;
      if(pcm){
        const fixed=BigInt(state.track.fixedSampleSize);if(!fixed||bytes<=0n||bytes%fixed)throw new Error('PCM oracle packet is not an integral fixed-sample span');
        const samples=bytes/fixed;if(samples>BigInt(state.track.sampleCount))throw new Error('PCM oracle packet exceeds track');span=Number(samples);
      }
      counter.samples+=span;counter.packets++;
      if(counter.samples>state.track.sampleCount){mismatch(phase,'extra-samples',stream,firstIndex,state.track.sampleCount,counter.samples);return;}
      const first=state.track.sample(firstIndex),last=state.track.sample(counter.samples-1);
      // The initial adapter verifies grouped PCM within a chunk, not arbitrary repacketization.
      if(first.chunkIndex!==last.chunkIndex)throw new Error('Oracle adapter does not cover packets spanning multiple chunks');
      const offset=phase==='raw'?0n:state.shift,scale=BigInt(state.track.timescale)*state.numerator;
      const values:{[key:string]:[bigint|boolean,bigint|boolean]}={
        offset:[first.offset,integer(fields.pos)],size:[last.offset+BigInt(last.size)-first.offset,bytes],
        pts:[(first.pts+offset)*state.denominator,integer(fields.pts)*scale],
        dts:[(first.dts+offset)*state.denominator,integer(fields.dts)*scale],
        duration:[(last.dts+BigInt(last.duration)-first.dts)*state.denominator,integer(fields.duration)*scale],sync:[first.sync,(fields.flags??'').includes('K')],
      };
      for(const [field,[expected,actual]] of Object.entries(values))if(expected!==actual)mismatch(phase,field,stream,firstIndex,expected,actual);
      if(phase==='raw'){
        // Count complete raw-demux packets before the edit end, not PCM samples or decoded frames.
        // The edited pass must reproduce this exact prefix: holes/reordering still fail byte/PTS checks.
        if(state.endNumerator!==null&&first.pts*BigInt(index.movieTimescale)>=state.endNumerator){
          state.excludedTailPackets++;state.excludedTailSamples+=span;
          if(report.tailExclusions.length<16)report.tailExclusions.push({stream,sample:firstIndex,samples:span,pts:first.pts,editEndNumerator:state.endNumerator,denominator:index.movieTimescale});
        }else{
          if(state.excludedTailPackets)throw new Error('Oracle adapter does not cover presentation reordering across an edit end');
          state.expectedEdited.packets++;state.expectedEdited.samples+=span;
        }
      }
    },{timeoutMs:180000,signal:options.signal});
    for(const [stream,state] of states){
      const expected=phase==='raw'?state.track.sampleCount:state.expectedEdited.samples;
      if(state[phase].samples!==expected)mismatch(phase,'sample-count',stream,state[phase].samples,expected,state[phase].samples);
      if(phase==='edited'&&state.edited.packets!==state.expectedEdited.packets)mismatch(phase,'packet-count',stream,state.edited.samples,state.expectedEdited.packets,state.edited.packets);
    }
  }
  report.tracks=[...states.values()].map(state=>({streamIndex:state.stream,trackId:state.track.trackId,raw:state.raw,edited:state.edited,
    expectedEdited:state.expectedEdited,excludedTailPackets:state.excludedTailPackets,excludedTailSamples:state.excludedTailSamples}));
  report.passed=Object.keys(report.mismatchCounts).length===0;return report;
}
