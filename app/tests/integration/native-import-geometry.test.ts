import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { sdrColorProcessing } from '../../src/main/media/video-processing.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
const helper=resolve('resources/bin/motion-preview.exe');
const ffmpeg=resolve('resources/bin/ffmpeg.exe'), ffprobe=resolve('resources/bin/ffprobe.exe');
const skip=process.platform!=='win32';

test('rotation and non-square pixels are normalized once without changing source PTS identity', { skip, timeout:90000 },async()=>{
  const temp=await tempFiles();
  try {
    const base=temp.file('base.mp4');
    await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=12:duration=2',
      '-vf','setsar=4/3','-c:v','libx264','-an',base]);
    for(const rotation of [0,90]) {
      const path=rotation?temp.file('rotated.mp4'):base;
      if(rotation) await runProcess(ffmpeg,['-v','error','-nostdin','-n','-display_rotation:v:0','90','-i',base,'-c','copy',path]);
      const source=await openSource(path), probe=await probeMedia(path,{executable:ffprobe}), info=mediaInfo(probe);
      assert.equal(info.rotation,rotation); assert.deepEqual(info.sampleAspectRatio,{numerator:4,denominator:3});
      const directory=temp.file(`session-${rotation}`); await mkdir(directory); let prepared:PreparedNativeMedia|undefined;
      try {
        prepared=await prepareNativeMedia({source,info,directory,helper,ffmpeg,ffprobe,signal:new AbortController().signal,maximumEdge:640});
        assert.equal(prepared.compatibility,true); assert.equal(prepared.index.count,24);
        assert.equal(prepared.nativeInfo.sourceWidth,Math.floor(info.displayWidth/2)*2);
        assert.equal(prepared.nativeInfo.sourceHeight,Math.floor(info.displayHeight/2)*2);
        const last=await prepared.index.locate(prepared.native,23);
        assert.equal((await prepared.index.fromNative(last.value.timestampHns)).index,23);
        const edited=mediaInfo(await probeMedia(prepared.resource,{executable:ffprobe}));
        assert.equal(edited.rotation,0); assert.deepEqual(edited.sampleAspectRatio,{numerator:1,denominator:1});
        const oracle=temp.file(`oracle-${rotation}.png`);
        const color=sdrColorProcessing(info,probe.streams.find(s=>s.index===info.videoIndex)!,false).filters;
        await runProcess(ffmpeg,['-v','error','-nostdin','-n','-i',path,'-vf',[
          'select=eq(n\\,23)',...color,`scale=${prepared.nativeInfo.sourceWidth}:${prepared.nativeInfo.sourceHeight}:flags=bilinear`,
          'setsar=1','scale=64:36:flags=bilinear'].join(','),'-frames:v','1',oracle]);
        const expected=await sharp(oracle).removeAlpha().raw().toBuffer();
        const actual=await sharp(last.pixels,{raw:{width:last.value.width,height:last.value.height,channels:4}}).removeAlpha().resize(64,36,{kernel:'linear',fit:'fill'}).raw().toBuffer();
        const error=actual.reduce((sum,v,i)=>sum+Math.abs(v-expected[i]!),0)/actual.length;
        if(error>=12) {
          const evidence=resolve('../artifacts/native-preview',`geometry-failure-${Date.now()}`); await mkdir(evidence,{recursive:true});
          await copyFile(path,join(evidence,'source.mp4')); await copyFile(prepared.resource,join(evidence,'editing.mp4')); await copyFile(oracle,join(evidence,'oracle.png'));
          await sharp(last.pixels,{raw:{width:last.value.width,height:last.value.height,channels:4}}).png().toFile(join(evidence,'native.png'));
          await runProcess(ffmpeg,['-v','error','-nostdin','-n','-i',prepared.resource,'-vf','select=eq(n\\,23),scale=64:36:flags=bilinear','-frames:v','1',join(evidence,'proxy-decoded.png')]);
          await writeFile(join(evidence,'report.json'),JSON.stringify({rotation,info,edited,color,error,native:prepared.nativeInfo,frame:last.value},null,2));
          console.log(`Geometry evidence: ${evidence}`);
        }
        assert.ok(error<12,`Rotation ${rotation}/SAR pixel error ${error}`);
        assert.deepEqual(await openSource(path),source);
      } finally { await prepared?.native.shutdown(); await prepared?.index.close(); }
    }
  } finally { await temp.cleanup(); }
});

test('real PQ/BT2020 input requires consent and produces bounded SDR editing frames', { skip, timeout:90000 },async()=>{
  const temp=await tempFiles(); let prepared:PreparedNativeMedia|undefined;
  try {
    const path=temp.file('hdr.mp4');
    await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=12:duration=1',
      '-vf','format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
      '-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:pools=1','-an',path]);
    const source=await openSource(path),info=mediaInfo(await probeMedia(path,{executable:ffprobe})); assert.equal(info.hdr,true);
    const directory=temp.file('session'); await mkdir(directory);
    const options={source,info,directory,helper,ffmpeg,ffprobe,signal:new AbortController().signal};
    await assert.rejects(prepareNativeMedia(options),{code:'HDR_CONFIRM_REQUIRED'}); assert.deepEqual(await readdir(directory),[]);
    prepared=await prepareNativeMedia({...options,hdrConsent:true});
    assert.equal(prepared.compatibility,true); assert.equal(prepared.index.count,12);
    assert.equal(prepared.nativeInfo.matrix709,true); assert.equal(prepared.nativeInfo.fullRange,false);
    const edited=mediaInfo(await probeMedia(prepared.resource,{executable:ffprobe})); assert.equal(edited.hdr,false);
    assert.ok(prepared.warnings.some(message=>message.includes('HDR→SDR')));
    assert.equal((await prepared.index.locate(prepared.native,11)).pixels.length,320*180*4);
    assert.deepEqual(await openSource(path),source);
  } finally { await prepared?.native.shutdown(); await prepared?.index.close(); await temp.cleanup(); }
});
