import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tempFiles} from '../helpers.ts';
import {runProcess} from '../../src/main/media/runner.ts';
import {openSource,assertSource} from '../../src/main/media/source.ts';
import {probeMedia} from '../../src/main/media/probe.ts';
import {mediaInfo} from '../../src/main/media/info.ts';
import {prepareNativeMedia,type PreparedNativeMedia} from '../../src/main/media/native-import.ts';
const skip=process.platform!=='win32';
const helper=resolve('resources/bin/motion-preview.exe'),ffmpeg=resolve('resources/bin/ffmpeg.exe'),ffprobe=resolve('resources/bin/ffprobe.exe');
test('all audio tracks are prepared at import; nonzero origin/delay match original PCM oracle, quota and cancellation drain files',{skip,timeout:90000},async()=>{
  const temp=await tempFiles();let prepared:PreparedNativeMedia|undefined;
  try {
    const path=temp.file('source.mp4');
    await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=3',
      '-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=2',
      '-itsoffset','0.4','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
      '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-bf','0','-c:a','aac','-ac','2','-output_ts_offset','2',path]);
    const source=await openSource(path),info=mediaInfo(await probeMedia(path,{executable:ffprobe}));
    assert.ok(info.startUs>=1_900_000);assert.equal(info.audioTracks.length,2);
    const directory=temp.file('session');await mkdir(directory);
    const common={source,info,helper,ffmpeg,ffprobe,reserveBytes:0};
    prepared=await prepareNativeMedia({...common,directory,signal:new AbortController().signal});
    assert.equal(prepared.audio.length,2);assert.ok(prepared.audio.every(track=>track.kind==='pcm'&&track.offsetHns==='0'&&track.sampleRate===48000));
    assert.ok(prepared.warnings.some(warning=>warning.includes('多音轨')),'Same-rate/same-duration tracks must not be matched by shape or numeric index');
    assert.notEqual(prepared.audio[0]?.path,prepared.audio[1]?.path);
    // Independent original-source oracle, not playback work or an oracle decoded from the proxy itself.
    const duration=(info.durationUs/1_000_000).toFixed(6);
    const filter=`asetpts=PTS-(${info.startPts}*${info.timeBase.numerator}/${info.timeBase.denominator})/TB,aresample=48000:async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`;
    const oracle=temp.file('original.f32'),actual=temp.file('prepared.f32');
    await runProcess(ffmpeg,['-v','error','-nostdin','-n','-copyts','-i',source.path,'-map','0:2','-vn','-af',filter,'-ac','2','-ar','48000','-c:a','pcm_f32le','-f','f32le',oracle]);
    const secondTrack=prepared.audio[1];assert.ok(secondTrack?.path);
    await runProcess(ffmpeg,['-v','error','-nostdin','-n','-i',secondTrack.path,'-map','0:a:0','-ac','2','-ar','48000','-c:a','pcm_f32le','-f','f32le',actual]);
    const expected=await readFile(oracle),decoded=await readFile(actual);assert.equal(decoded.length,expected.length);
    let error=0;for(let at=0;at<decoded.length;at+=4)error+=Math.abs(decoded.readFloatLE(at)-expected.readFloatLE(at));
    assert.ok(error/(decoded.length/4)<0.00005,'PCM16 preview should differ only by bounded quantization');
    function rms(start:number,end:number){let energy=0,count=0;for(let i=Math.floor(start*48000)*2;i<Math.floor(end*48000)*2;i++){energy+=decoded.readFloatLE(i*4)**2;count++;}return Math.sqrt(energy/count);}
    assert.ok(rms(0,0.3)<1e-7,'Original leading delay must remain silent');assert.ok(rms(0.6,0.8)>0.01);assert.ok(rms(2.8,2.9)<1e-7);
    await prepared.native.shutdown();await prepared.index.close();prepared=undefined;
    const limited=temp.file('limited');await mkdir(limited);
    await assert.rejects(prepareNativeMedia({...common,directory:limited,signal:new AbortController().signal,maxBytes:1024**2}),{code:'PREVIEW_BUDGET'});
    assert.deepEqual(await readdir(limited),[]);
    const cancelled=temp.file('cancelled');await mkdir(cancelled);const abort=new AbortController();let audioSeen=false;
    await assert.rejects(prepareNativeMedia({...common,directory:cancelled,signal:abort.signal,onProgress(progress){if(progress.stage==='audio'){audioSeen=true;abort.abort();}}}));
    assert.equal(audioSeen,true);assert.deepEqual(await readdir(cancelled),[]);await assertSource(source);
  } finally {await prepared?.native.shutdown();await prepared?.index.close();await temp.cleanup();}
});
