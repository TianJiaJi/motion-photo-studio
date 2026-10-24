import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import {tempFiles} from '../helpers.ts';
import {runProcess} from '../../src/main/media/runner.ts';
import {NativePreview} from '../../src/main/media/native-preview.ts';
const skip=process.platform!=='win32',helper=resolve('resources/bin/motion-preview.exe');
type Scan={frames:{timestampHns:string;samples:number}[];ended:boolean};
type Status={running:boolean;timeHns:string;submittedFrames:number;underruns:number;error:string|null};
test('MF selects actual audio tracks; delayed/short audio and tiny intervals have bounded source clocks', {skip,timeout:60000},async()=>{
  const temp=await tempFiles();const native=new NativePreview(helper);
  try {
    const path=temp.file('multitrack.mp4');
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n',
      '-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=3',
      '-f','lavfi','-i','sine=frequency=330:sample_rate=32000:duration=1',
      '-itsoffset','0.4','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
      '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-bf','0','-c:a','aac','-ac','2',path]);
    await native.hello();
    await assert.rejects(native.request({command:'audioScanOpen',path,streamIndex:64}),{code:'NATIVE_MEDIA'});
    const {value:enumeration}=await native.request<{streams:{streamIndex:number;sampleRate:number}[]}>({command:'audioStreams',path});
    assert.equal(enumeration.streams.length,2);
    const stream32=enumeration.streams.find(stream=>stream.sampleRate===32000),stream48=enumeration.streams.find(stream=>stream.sampleRate===48000);
    assert.ok(stream32);assert.ok(stream48);assert.notEqual(stream32.streamIndex,stream48.streamIndex);
    const summaries:{rate:number;samples:number;first:bigint}[]=[];
    for(const streamIndex of [stream32.streamIndex,stream48.streamIndex]) {
      const {value:info}=await native.request<{sampleRate:number}>({command:'audioScanOpen',path,streamIndex});
      let samples=0,first:bigint|undefined,ended=false;
      while(!ended) {
        const {value}=await native.request<Scan>({command:'audioScan',count:128});ended=value.ended;
        for(const frame of value.frames){first??=BigInt(frame.timestampHns);samples+=frame.samples;}
      }
      assert.notEqual(first,undefined);summaries.push({rate:info.sampleRate,samples,first:first!});
      await native.request({command:'audioScanClose'});
    }
    const [firstTrack,secondTrack]=summaries;assert.ok(firstTrack);assert.ok(secondTrack);
    assert.equal(firstTrack.rate,32000);assert.equal(secondTrack.rate,48000);
    assert.ok(firstTrack.samples>=30000&&firstTrack.samples<35000);
    assert.ok(secondTrack.samples>=94000&&secondTrack.samples<100000);
    // Explicit negative offset creates a leading source-timeline gap regardless of MP4 edit-list convention.
    const start=await native.request<Status>({command:'audioStart',path,streamIndex:stream48.streamIndex,timeUs:0,endUs:600000,offsetHns:(secondTrack.first-2_000_000n).toString()});
    assert.equal(start.value.error,null);
    let status=start.value;
    const deadline=Date.now()+5000;
    while(status.running&&Date.now()<deadline){await delay(25);status=(await native.request<Status>({command:'audioStatus'})).value;}
    assert.equal(status.error,null);assert.equal(status.running,false);assert.equal(status.submittedFrames,28800);
    assert.ok(BigInt(status.timeHns)>=5_800_000n&&BigInt(status.timeHns)<=6_000_000n);
    await native.request({command:'audioStop'});
    // One second of PCM stretched to a two-second playback interval must pad silence, not stop early.
    await native.request({command:'audioStart',path,streamIndex:stream32.streamIndex,timeUs:0,endUs:2_000_000,offsetHns:firstTrack.first.toString()});
    status=(await native.request<Status>({command:'audioStatus'})).value;
    const paddedDeadline=Date.now()+5000;
    while(status.running&&Date.now()<paddedDeadline){await delay(25);status=(await native.request<Status>({command:'audioStatus'})).value;}
    assert.equal(status.error,null);assert.equal(status.running,false);assert.equal(status.submittedFrames,64000);
    assert.ok(BigInt(status.timeHns)>=19_800_000n&&BigInt(status.timeHns)<=20_000_000n);
    await native.request({command:'audioStop'});
    const tiny=(await native.request<Status>({command:'audioStart',path,streamIndex:stream32.streamIndex,timeUs:0,endUs:1,offsetHns:'0'})).value;
    assert.equal(tiny.error,null);assert.equal(tiny.running,false);assert.equal(tiny.timeHns,'10');assert.equal(tiny.submittedFrames,0);
  } finally {await native.shutdown();await temp.cleanup();}
});
