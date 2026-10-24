// Isolated diagnostic. Does NOT replace resources/bin/motion-preview.exe or enable a production path.
import assert from 'node:assert/strict';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import sharp from 'sharp';
import {readMp4SampleIndex,selectMp4Track} from '../src/main/media/mp4-sample-index.ts';
import {openSource,assertSource} from '../src/main/media/source.ts';
import {probeMedia} from '../src/main/media/probe.ts';
import {mediaInfo} from '../src/main/media/info.ts';
import {runProcess,ffmpeg,ffprobe} from '../src/main/media/runner.ts';
import {streamProcessLines} from '../src/main/media/lines.ts';
import {sha256} from '../src/main/motion/io.ts';
const arguments_=process.argv.slice(2),compareTiming=arguments_.at(-1)==='--compare-timing';
if(compareTiming)arguments_.pop();
if(arguments_.length>1||arguments_[0]?.startsWith('--'))throw new Error('Usage: node scripts/probe-direct-sample-decode.ts [explicit-local-H264-selection.json] [--compare-timing]');
const selectionPath=arguments_[0];
const timingModes=['complete','no-duration','no-dts','pts-only','boundary-duration','first-discontinuity','positive-epoch'] as const;
type TimingMode=typeof timingModes[number];
const root=resolve(`../artifacts/native-preview/direct-samples-${Date.now()}`);await mkdir(root,{recursive:true});
const helper=resolve('../native/preview-engine/target/x86_64-pc-windows-msvc/release/examples/direct-sample-decode.exe');
const helperSha256=await sha256(helper),productionHelper=resolve('resources/bin/motion-preview.exe'),productionBefore=await sha256(productionHelper);
const json=(value:unknown)=>JSON.stringify(value,(_key,value)=>typeof value==='bigint'?value.toString():value,2);
function configuration(description:Buffer){
  if(description.length<78)throw new Error('Truncated visual sample entry');
  const boxes:{type:string;data:Buffer}[]=[];let at=78;
  while(at<description.length){
    if(description.length-at<8)throw new Error('Truncated AVC entry child');const length=description.readUInt32BE(at);
    if(length<8||length>description.length-at)throw new Error('Unsupported AVC entry child extent');
    boxes.push({type:description.toString('latin1',at+4,at+8),data:description.subarray(at+8,at+length)});at+=length;
  }
  if(boxes.some(box=>['clap','sinf'].includes(box.type)))throw new Error('Prototype does not cover aperture/encryption');
  const configs=boxes.filter(box=>box.type==='avcC');if(configs.length!==1)throw new Error('One avcC required');const data=configs[0]!.data;
  if(data.length<7||data.length>65536||data[0]!==1)throw new Error('Invalid AVC configuration');
  const nalLengthSize=(data[4]!&3)+1;if(![1,2,4].includes(nalLengthSize))throw new Error('Reserved AVC length width');
  const parameterSets:number[][]=[];at=6;
  const units=(count:number)=>{for(let i=0;i<count;i++){if(at+2>data.length)throw new Error('Truncated parameter length');const length=data.readUInt16BE(at);at+=2;if(!length||length>data.length-at)throw new Error('Truncated parameter set');parameterSets.push([...data.subarray(at,at+length)]);at+=length;}};
  const spsCount=data[5]!&31;if(!spsCount)throw new Error('No SPS');units(spsCount);
  if(at>=data.length)throw new Error('No PPS count');const ppsCount=data[at++]!;if(!ppsCount)throw new Error('No PPS');units(ppsCount);
  if(at<data.length){
    if(![100,110,122,144].includes(data[1]!)||data.length-at<4)throw new Error('Unsupported AVC configuration extension');
    if((data[at]!&3)!==1||(data[at+1]!&7)!==0||(data[at+2]!&7)!==0)throw new Error('Prototype requires 8-bit 4:2:0 AVC');
    const count=data[at+3]!;at+=4;units(count);
  }
  if(at!==data.length||parameterSets.length>64)throw new Error('Unconsumed/oversized AVC configuration');return {nalLengthSize,parameterSets};
}
let cases:{name:string;path:string;wantedFrames?:number;variableTiming?:boolean;timingMode?:TimingMode}[];
if(selectionPath){
  const manifest=resolve(selectionPath);if((await stat(manifest)).size>65536)throw new Error('Selection too large');
  cases=JSON.parse(await readFile(manifest,'utf8')).cases;
  if(!Array.isArray(cases)||!cases.length||cases.length>8)throw new Error('Bounded explicit local selection required');
  const allowed=await Promise.all(['Downloads','Videos'].map(name=>realpath(join(process.env.USERPROFILE!,name))));
  for(const entry of cases){entry.path=await realpath(entry.path);if(!allowed.some(root=>entry.path.toLowerCase().startsWith((root+sep).toLowerCase())))throw new Error('Outside authorized local roots');}
}else{
  cases=[];
  for(const [name,filter,negative] of [['cfr-bframes','',false],['vfr-rate-change','select=if(lt(n\\,30)\\,not(mod(n\\,3))\\,not(mod(n\\,2))),setpts=PTS+2/TB',false],['signed-ctts','',true]] as const){
    const path=join(root,`${name}.mp4`);
    await runProcess(ffmpeg(),['-v','error','-nostdin','-n','-f','lavfi','-i',`testsrc2=size=160x96:rate=30:duration=${name==='vfr-rate-change'?6:3}`,
      ...(filter?['-vf',filter]:[]),'-an','-c:v','libx264','-preset','ultrafast','-g','60','-bf','3','-pix_fmt','yuv420p','-fps_mode','passthrough',
      '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-video_track_timescale','90000',
      ...(negative?['-movflags','+negative_cts_offsets']:[]),path]);cases.push({name,path,wantedFrames:name==='vfr-rate-change'?12:3,variableTiming:name==='vfr-rate-change'});
  }
}
if(compareTiming)cases=cases.flatMap(entry=>timingModes.map(timingMode=>({...entry,name:`${entry.name}-${timingMode}`,timingMode})));
const reports:any[]=[],names=new Set<string>();
for(const entry of cases){
  if(typeof entry.name!=='string'||! /^[a-z0-9-]{1,64}$/.test(entry.name)||names.has(entry.name))throw new Error('Invalid/duplicate case name');names.add(entry.name);
  const wantedFrames=entry.wantedFrames??3,timingMode=entry.timingMode??'complete';
  if(!Number.isSafeInteger(wantedFrames)||wantedFrames<3||wantedFrames>12||!timingModes.includes(timingMode))throw new Error('Invalid diagnostic output/timing mode');
  const directory=join(root,entry.name);await mkdir(directory);const record:any={name:entry.name,wantedFrames,timingMode,scope:'Bounded prefix synchronous H264 MFT prototype; not production playback/seek/audio acceptance'};reports.push(record);
  const source=await openSource(entry.path);record.sourceSha256=await sha256(source.path);
  try{
    const probe=await probeMedia(source.path,{executable:ffprobe()}),info=mediaInfo(probe),stream=probe.streams.find(stream=>stream.index===info.videoIndex)!;
    if(stream.codec_name!=='h264'||stream.pix_fmt!=='yuv420p'||info.hdr||info.rotation||info.sampleAspectRatio.numerator!==info.sampleAspectRatio.denominator)throw new Error('Outside prototype scope: only 8-bit SDR H264, unrotated square pixels');
    const began=performance.now(),index=await readMp4SampleIndex(source),track=selectMp4Track(index,stream.id,'vide');record.indexMs=performance.now()-began;
    if(track.codec!=='avc1')throw new Error('Prototype requires avc1');
    if(stream.time_base!==`1/${track.timescale}`)throw new Error('Prototype oracle requires the original container time base');
    const config=configuration(track.sampleDescription);
    const packets=Array.from({length:Math.min(128,track.sampleCount)},(_,i)=>{const row=track.sample(i);return {offset:String(row.offset),size:row.size,pts:String(row.pts),dts:String(row.dts),duration:row.duration,sync:row.sync};});
    const manifest={version:1,source:source.path,sourceBytes:String(source.size),trackId:track.trackId,timescale:track.timescale,width:info.encodedWidth,height:info.encodedHeight,
      maximumEdge:960,matrix709:stream.color_space==='bt709',fullRange:stream.color_range==='pc',...config,packets,wantedFrames,timingMode};
    const input=join(directory,'input.json'),output=join(directory,'first.rgba');await writeFile(input,json(manifest),{flag:'wx'});
    const launched=performance.now();const result=await runProcess(helper,[input,output],{timeoutMs:30000});record.processMs=performance.now()-launched;
    const decoded=JSON.parse(result.stdout);record.native=decoded;
    assert.equal(decoded.trackId,track.trackId);assert.equal(decoded.frames.length,wantedFrames);assert.ok(decoded.inputPackets<=128);assert.ok(decoded.inputPackets<track.sampleCount,'Prefix decode must not consume this entire fixture/source');
    const expected:string[]=[];
    await streamProcessLines(ffprobe(),['-v','error','-ignore_editlist','1','-select_streams',String(stream.index),'-show_frames',
      '-show_entries','frame=best_effort_timestamp','-of','compact=p=0:nk=0',source.path],line=>{
      const match=/(?:^|\|)best_effort_timestamp=(-?\d+)/.exec(line);if(match)expected.push(match[1]!);return expected.length===wantedFrames;
    },{timeoutMs:30000});
    assert.equal(expected.length,wantedFrames);assert.deepEqual(decoded.frames.map((frame:{sourcePts:string})=>frame.sourcePts),expected);
    if(entry.variableTiming){record.presentationIntervals=[...new Set(expected.slice(1).map((pts,i)=>String(BigInt(pts)-BigInt(expected[i]!))))];assert.ok(record.presentationIntervals.length>1,'The checked output prefix must cross an actual timing-rate change');}
    const oracle=join(directory,'oracle.rgba');
    await runProcess(ffmpeg(),['-v','error','-nostdin','-n','-ignore_editlist','1','-i',source.path,'-map',`0:${stream.index}`,'-an','-frames:v','1',
      '-vf',`scale=${decoded.width}:${decoded.height}:flags=neighbor`,'-pix_fmt','rgba','-f','rawvideo',oracle],{timeoutMs:30000});
    const actual=await readFile(output),reference=await readFile(oracle);assert.equal(actual.length,decoded.width*decoded.height*4);assert.equal(actual.length,reference.length);
    let difference=0;for(let i=0;i<actual.length;i++)difference+=Math.abs(actual[i]!-reference[i]!);record.firstImageMae=difference/actual.length;assert.ok(record.firstImageMae<12,`First output pixel MAE ${record.firstImageMae}`);
    await sharp(actual,{raw:{width:decoded.width,height:decoded.height,channels:4}}).png().toFile(join(directory,'first.png'));
    record.status='prototype-passed';
  }catch(error){record.status='failed';record.error=String(error);process.exitCode=1;}
  finally{
    try{await assertSource(source);record.sourceHashUnchanged=await sha256(source.path)===record.sourceSha256;assert.equal(record.sourceHashUnchanged,true);}catch(error){record.status='failed';record.sourceError=String(error);process.exitCode=1;}
    await writeFile(join(directory,'report.json'),json(record),{flag:'wx'});console.log(`${entry.name}: ${record.status}; ${record.error??`first native output ${record.native.firstOutputMs.toFixed(2)}ms; ${record.native.inputPackets} inputs; pixel MAE ${record.firstImageMae.toFixed(2)}`}`);
  }
}
assert.equal(await sha256(helper),helperSha256);assert.equal(await sha256(productionHelper),productionBefore);
await writeFile(join(root,'summary.json'),json({helperSha256,productionHelperUnchanged:true,compareTiming,scope:'Diagnostic only; no HEVC, audio, seek/flush or production readiness claim',cacheState:'Uncontrolled; source hashed before measurements',reports}),{flag:'wx'});
console.log(`Direct sample evidence: ${root}`);
