import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tempFiles} from '../helpers.ts';
import {runProcess} from '../../src/main/media/runner.ts';
import {openSource} from '../../src/main/media/source.ts';
import {probeMedia} from '../../src/main/media/probe.ts';
import {mediaInfo} from '../../src/main/media/info.ts';
import {prepareNativeMedia,type PreparedNativeMedia} from '../../src/main/media/native-import.ts';
import {NativeTimeline} from '../../src/main/media/native-timeline.ts';
import type {PreviewStamp,PreviewStatus} from '../../src/shared/native-preview.ts';
const helper=resolve('resources/bin/motion-preview.exe'),ffmpeg=resolve('resources/bin/ffmpeg.exe'),ffprobe=resolve('resources/bin/ffprobe.exe');
const assetId='12345678-1234-1234-1234-123456789abc';
test('host bounds unacknowledged pixels across epochs, steps from confirmed frames and uses a monotonic silent clock',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const temp=await tempFiles();let prepared:PreparedNativeMedia|undefined,timeline:NativeTimeline|undefined;
  try {
    const path=temp.file('source.mp4');await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.5','-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-g','60','-bf','3','-c:a','aac',path]);
    const source=await openSource(path),info=mediaInfo(await probeMedia(path,{executable:ffprobe}));
    const directory=temp.file('session');await mkdir(directory);
    prepared=await prepareNativeMedia({source,info,directory,helper,ffmpeg,ffprobe,signal:new AbortController().signal});
    const frames:(PreviewStamp&{hash:string})[]=[],statuses:PreviewStatus[]=[];let autoAck=false;
    let ended:(()=>void)|undefined;let endEpoch=12;
    timeline=new NativeTimeline(assetId,source,prepared,{
      frame(frame){const {pixels,...stamp}=frame;frames.push({...stamp,hash:createHash('sha256').update(pixels).digest('hex')});
        // Simulated renderer acknowledgment, not a claim of real Canvas/physical latency acceptance.
        if(autoAck)timeline!.acknowledge({assetId,epoch:frame.epoch,frameId:frame.frameId,painted:true});},
      status(status){statuses.push(status);if(status.epoch===endEpoch&&status.state==='paused')ended?.();},
    });
    for(let epoch=1;epoch<=8;epoch++)await timeline.control({assetId,epoch,action:'seek',timeUs:(epoch-1)*100000,boundary:'after',maximumEdge:640,final:true});
    assert.equal(frames.length,1,'An unresponsive renderer must receive only one pixel message');
    assert.equal(timeline.stats.pendingImages,1);assert.equal(timeline.stats.inFlight,1);
    const initial=frames[0];assert.ok(initial);
    assert.throws(()=>timeline!.capture(initial.frameId),{code:'FRAME_BOUNDARY'});
    timeline.acknowledge({assetId,epoch:initial.epoch,frameId:initial.frameId,painted:false});
    assert.equal(frames.length,2);const latest=frames[1];assert.ok(latest);assert.equal(latest.epoch,8);
    timeline.acknowledge({assetId,epoch:8,frameId:latest.frameId,painted:true});
    assert.equal(timeline.capture(latest.frameId).pts,latest.pts);
    autoAck=true;
    await timeline.control({assetId,epoch:9,action:'pause'});
    const paused=frames.at(-1)!;assert.equal(paused.epoch,9);
    await timeline.control({assetId,epoch:10,action:'step',frameId:paused.frameId,direction:1});
    assert.equal(frames.at(-1)!.sourceFrame,paused.sourceFrame+1);
    await timeline.control({assetId,epoch:11,action:'seek',timeUs:1000000,boundary:'before',maximumEdge:960,final:true});
    const right=frames.at(-1)!;assert.ok(right.timeUs<1000000);assert.ok((await prepared.index.get(right.sourceFrame+1)).timeUs>=1000000);
    let deadline:NodeJS.Timeout|undefined;
    const completed=new Promise<void>((resolve,reject)=>{ended=resolve;deadline=setTimeout(()=>reject(new Error('Native host playback did not stop at the exclusive boundary')),6000);});
    try {
      await timeline.control({assetId,epoch:12,action:'play',startUs:0,endUs:400000,audioTrack:null});await completed;
    }finally{if(deadline)clearTimeout(deadline);}
    const played=frames.filter(frame=>frame.epoch===12);
    assert.ok(played.length>=4);assert.ok(new Set(played.map(frame=>frame.hash)).size>=4);
    assert.ok(played.every(frame=>frame.timeUs<400000));assert.equal(statuses.at(-1)!.state,'paused');
    assert.ok(timeline.stats.pixelBytes<=3*1280*1280*4);assert.equal(timeline.stats.pendingControls,0);
    endEpoch=13;
    const audioTrack=prepared.audio[0];assert.ok(audioTrack);
    const audible=new Promise<void>((resolve,reject)=>{ended=resolve;deadline=setTimeout(()=>reject(new Error('Audio-clock playback did not reach its end')),6000);});
    try {
      await timeline.control({assetId,epoch:13,action:'play',startUs:0,endUs:300000,audioTrack:audioTrack.sourceIndex});await audible;
    }finally{if(deadline)clearTimeout(deadline);}
    assert.ok(frames.filter(frame=>frame.epoch===13).length>=3);
    assert.ok(!statuses.some(status=>status.epoch===13&&status.error),'Actual WASAPI clock replies must be decoded correctly');
    // Unexpected helper termination is terminal; never silently invoke FFmpeg as a fallback.
    process.kill(prepared.native.pid!);await prepared.native.terminated;
    await assert.rejects(timeline.control({assetId,epoch:14,action:'pause'}),{code:'NATIVE_EXIT'});
    assert.equal(statuses.at(-1)!.state,'failed');
  }finally{if(timeline)await timeline.dispose();else {await prepared?.native.shutdown();await prepared?.index.close();}await temp.cleanup();}
});
