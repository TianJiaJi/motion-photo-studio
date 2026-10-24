import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {verifyMp4PacketIndex} from '../../scripts/lib/mp4-index-oracle.ts';
import {tempFiles} from '../helpers.ts';
import {runProcess} from '../../src/main/media/runner.ts';
import {openSource} from '../../src/main/media/source.ts';
import {readMp4SampleIndex,selectMp4Track,type Mp4TrackIndex} from '../../src/main/media/mp4-sample-index.ts';
import {probeMedia} from '../../src/main/media/probe.ts';
import {sha256} from '../../src/main/motion/io.ts';
// Oracle-only conversion for the generated fixtures' leading-empty + single-media edit.
// The reader deliberately retains edits instead of claiming a general presentation mapping.
function shift(track:Mp4TrackIndex,movieTimescale:number){
  let delay=0n,mediaSeen=false,result=0n;
  for(const edit of track.edits){
    if(edit.mediaTime===-1n){assert.equal(mediaSeen,false);const ticks=edit.duration*BigInt(track.timescale);assert.equal(ticks%BigInt(movieTimescale),0n);delay+=ticks/BigInt(movieTimescale);}
    else{assert.equal(mediaSeen,false);mediaSeen=true;result=delay-edit.mediaTime;}
  }
  return result;
}
test('sample-table index agrees with bundled packet oracle for B frames, VFR and nonzero starts', {timeout:120000},async t=>{
  const temp=await tempFiles();
  try{
    for(const [name,filter,mov] of [['cfr','',false],['vfr','select=if(lt(n\\,30)\\,not(mod(n\\,3))\\,not(mod(n\\,2))),setpts=PTS+2/TB',false],['mov','',true]] as const){
      const file=temp.file(`${name}.${mov?'mov':'mp4'}`);
      await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=2',
        ...(filter?['-vf',filter]:[]),'-an','-c:v','libx264','-preset','ultrafast','-g','30','-bf','3','-fps_mode','passthrough','-video_track_timescale','90000',file]);
      const before=await sha256(file),source=await openSource(file),index=await readMp4SampleIndex(source);
      const probe=await probeMedia(file,{executable:resolve('resources/bin/ffprobe.exe')});
      const track=selectMp4Track(index,probe.streams.find(stream=>stream.codec_type==='video')!.id,'vide');
      const {stdout}=await runProcess(resolve('resources/bin/ffprobe.exe'),['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,dts,duration,pos,size,flags','-of','json=compact=1',file]);
      const packets=JSON.parse(stdout).packets as {pts:number;dts:number;duration:number;pos:string;size:string;flags:string}[];
      assert.equal(track.timescale,90000);assert.equal(track.sampleCount,packets.length);const offset=shift(track,index.movieTimescale);
      for(let i=0;i<packets.length;i++){
        const sample=track.sample(i),packet=packets[i]!;
        assert.equal(sample.offset,BigInt(packet.pos));assert.equal(sample.size,Number(packet.size));
        assert.equal(sample.pts+offset,BigInt(packet.pts),`${name} PTS ${i}`);assert.equal(sample.dts+offset,BigInt(packet.dts),`${name} DTS ${i}`);
        assert.equal(sample.duration,packet.duration,`${name} duration ${i}`);assert.equal(sample.sync,packet.flags.includes('K'));
      }
      assert.equal(index.samplePayloadBytesRead,0);assert.equal(await sha256(file),before);
      t.diagnostic(`${name}: ${track.sampleCount} samples, moov ${index.metadataBytes} bytes, accounted index ${index.indexBytes} bytes; payload reads 0`);
    }
  }finally{await temp.cleanup();}
});
test('raw PCM grouping and edit-clipped AAC retain strict but distinct sample/packet counts', {timeout:120000},async()=>{
  const temp=await tempFiles();try{
    for(const codec of ['aac','pcm_s16le']){
      const file=temp.file(`${codec}.mp4`);
      await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=128x72:rate=24:duration=2',
        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-preset','ultrafast','-c:a',codec,'-ac','2',file]);
      if(codec==='aac'){
        // Modify only this generated fixture: make its audio edit end before stored AAC packets end.
        // The earlier real-material failure remains intact; do not trim those source bytes.
        const bytes=await readFile(file);
        const boxes=(start:number,end:number)=>{const result:{type:string;body:number;end:number}[]=[];for(let at=start;at<end;){const size=bytes.readUInt32BE(at);assert.ok(size>=8&&size<=end-at);result.push({type:bytes.toString('latin1',at+4,at+8),body:at+8,end:at+size});at+=size;}return result;};
        const movie=boxes(0,bytes.length).find(box=>box.type==='moov')!,contents=boxes(movie.body,movie.end);
        const header=contents.find(box=>box.type==='mvhd')!;assert.equal(bytes[header.body],0);const scale=bytes.readUInt32BE(header.body+12);assert.equal(scale%2,0);
        const track=contents.filter(box=>box.type==='trak').find(box=>{const mdia=boxes(box.body,box.end).find(child=>child.type==='mdia')!,hdlr=boxes(mdia.body,mdia.end).find(child=>child.type==='hdlr')!;return bytes.toString('latin1',hdlr.body+8,hdlr.body+12)==='soun';})!;
        const edts=boxes(track.body,track.end).find(box=>box.type==='edts')!,elst=boxes(edts.body,edts.end).find(box=>box.type==='elst')!;
        assert.equal(bytes[elst.body],0);assert.equal(bytes.readUInt32BE(elst.body+4),1);bytes.writeUInt32BE(scale/2,elst.body+8);await writeFile(file,bytes);
      }
      const before=await sha256(file),index=await readMp4SampleIndex(await openSource(file)),probe=await probeMedia(file,{executable:resolve('resources/bin/ffprobe.exe')});
      const report=await verifyMp4PacketIndex({index,streams:probe.streams,source:file,ffprobe:resolve('resources/bin/ffprobe.exe')});
      assert.equal(report.passed,true,JSON.stringify(report,(_key,value)=>typeof value==='bigint'?value.toString():value));
      const audioId=index.tracks.find(track=>track.handler==='soun')!.trackId,audio=report.tracks.find(track=>track.trackId===audioId)!;
      if(codec==='aac'){assert.ok(audio.excludedTailPackets>0);assert.ok(audio.raw.samples>audio.edited.samples);assert.equal(audio.edited.samples,audio.expectedEdited.samples);}
      else{assert.equal(audio.raw.samples,96000);assert.ok(audio.raw.packets<audio.raw.samples);assert.equal(audio.excludedTailSamples,0);}
      assert.equal(await sha256(file),before);
    }
  }finally{await temp.cleanup();}
});
test('container IDs distinguish same-shaped audio tracks from stream ordinals', {timeout:60000},async()=>{
  const temp=await tempFiles();try{
    const file=temp.file('tracks.mp4');
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=128x72:rate=24:duration=1',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1',
      '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-c:a','aac','-ac','2',
      '-streamid','0:19','-streamid','1:7','-streamid','2:41','-use_stream_ids_as_track_ids','1',file]);
    const index=await readMp4SampleIndex(await openSource(file)),probe=await probeMedia(file,{executable:resolve('resources/bin/ffprobe.exe')});
    assert.deepEqual(probe.streams.map(stream=>stream.index),[0,1,2]);
    assert.deepEqual(probe.streams.map(stream=>selectMp4Track(index,stream.id,stream.codec_type==='video'?'vide':'soun').trackId),[19,7,41]);
    assert.equal(index.tracks.filter(track=>track.handler==='soun').length,2);
  }finally{await temp.cleanup();}
});
