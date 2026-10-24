import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { sdrColorProcessing } from '../../src/main/media/video-processing.ts';
import { buildFrameIndex, FrameIndex } from '../../src/main/media/frame-index.ts';
import { AppFailure } from '../../src/main/errors.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const helper = resolve('resources/bin/motion-preview.exe');
const ffmpeg = () => resolve('resources/bin/ffmpeg.exe');
const ffprobe = () => resolve('resources/bin/ffprobe.exe');
const windows = process.platform === 'win32';
async function generate(path: string, variable = false) {
  await runProcess(ffmpeg(), ['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=6',
    ...(variable ? ['-vf', 'select=if(lt(n\\,75)\\,not(mod(n\\,3))\\,not(mod(n\\,2))),setpts=PTS+2/TB'] : []),
    '-an','-c:v','libx264','-preset','veryfast','-crf','18','-g','180','-bf','3','-pix_fmt','yuv420p',
    '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv',
    '-fps_mode','passthrough','-video_track_timescale','90000',path]);
}
async function release(prepared: PreparedNativeMedia | undefined) {
  await prepared?.native.shutdown(); await prepared?.index.close();
}
function mae(a: Buffer, b: Buffer) { assert.equal(a.length,b.length); return a.reduce((sum,value,index) => sum + Math.abs(value-b[index]!),0)/a.length; }

test('native import preserves CFR/VFR/nonzero PTS and compatibility frame identity; edits spawn no FFmpeg', { skip: !windows, timeout: 180000 }, async (t) => {
  const temp = await tempFiles(); const starts: string[] = []; const commands: string[][] = [];
  const original = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof original>) => { starts.push(String(args[0])); commands.push(Array.isArray(args[1]) ? args[1].map(String) : []); return Reflect.apply(original,childProcess,args); }) as typeof original;
  syncBuiltinESMExports();
  try {
    for (const [name, variable, forceCompatibility] of [['cfr',false,false],['vfr',true,false],['compat',true,true]] as const) {
      const sourcePath = temp.file(`${name}.mp4`); await generate(sourcePath,variable);
      const before = await sha256(sourcePath); const source = await openSource(sourcePath);
      const probe = await probeMedia(sourcePath,{executable:ffprobe()});
      const info = mediaInfo(probe);
      const directory = temp.file(name); await mkdir(directory);
      let prepared: PreparedNativeMedia | undefined;
      try {
        t.diagnostic(`Starting ${name} import using ${helper}`);
        const importCommands = commands.length;
        prepared = await prepareNativeMedia({ source, info, directory, helper, ffmpeg: ffmpeg(), ffprobe: ffprobe(),
          signal: new AbortController().signal, maximumEdge: 640, forceCompatibility });
        const { native, index } = prepared; const pid = native.pid;
        t.diagnostic(`${name}: ${index.count} frames, compatibility=${prepared.compatibility}, helper PID=${pid}; ${prepared.warnings.join('; ')}`);
        assert.ok(index.mappingReady); assert.ok(index.count > 60);
        if (forceCompatibility) assert.equal(prepared.compatibility,true);
        if (name === 'cfr') {
          assert.equal(prepared.compatibility,false,'Supported CFR H.264 must not be transcoded for a tail seek');
          assert.equal(index.containerCandidate,true,'Ordinary CFR should use the fully native-verified container candidate');
          assert.equal(commands.slice(importCommands).some(args=>args.includes('-show_frames')),false,'Eligible import must eliminate the full ffprobe video decode');
        } else {
          assert.equal(index.containerCandidate,false,'VFR/compatibility retain the original decoded-frame path');
          assert.ok(commands.slice(importCommands).some(args=>args.includes('-show_frames')));
        }
        assert.equal(prepared.nativeInfo.matrix709,true,'Use imported color metadata even when MF omits it');
        if (variable) assert.ok(BigInt(info.startPts)>0n);
        assert.ok(starts.some(path => basename(path).toLowerCase()==='ffprobe.exe'), 'Process hook must observe import probes');
        const editStart = starts.length;
        const frames: { row: number; image: Buffer }[] = [];
        for (const number of [0,7,Math.floor(index.count/2),index.count-1,1]) {
          const row = await index.get(number);
          const response = await index.locate(native,number);
          assert.equal((await index.fromNative(response.value.timestampHns)).pts,row.pts);
          assert.equal(native.pid,pid);
          assert.equal(response.pixels.length,response.value.width*response.value.height*4);
          frames.push({row:number,image:await sharp(response.pixels,{raw:{width:response.value.width,height:response.value.height,channels:4}})
            .removeAlpha().resize(64,36,{kernel:'linear',fit:'fill'}).raw().toBuffer()});
        }
        assert.equal(starts.length,editStart,'Interactive frame requests must start no child processes');
        // Decode the ORIGINAL for the oracle. Compatibility deliberately applies the approved
        // SDR normalization; comparing it with unnormalized RGB would test different policies.
        // Never decode the proxy as its own identity oracle or relax the pixel-error threshold.
        const oracleColor = prepared.compatibility ? sdrColorProcessing(info,probe.streams.find(s=>s.index===info.videoIndex)!,false).filters : [];
        for (const frame of frames) {
          const comparisons: { frame: number; error: number }[] = [];
          for (const candidate of [frame.row-1,frame.row,frame.row+1].filter(n=>n>=0&&n<index.count)) {
            const png = temp.file(`${name}-${frame.row}-${candidate}.png`);
            await runProcess(ffmpeg(),['-v','error','-nostdin','-n','-i',sourcePath,'-vf',[`select=eq(n\\,${candidate})`,...oracleColor,'scale=64:36:flags=bilinear'].join(','),
              '-frames:v','1',png]);
            const rgb = await sharp(png).removeAlpha().raw().toBuffer(); comparisons.push({frame:candidate,error:mae(frame.image,rgb)});
          }
          comparisons.sort((a,b)=>a.error-b.error);
          if (comparisons[0]!.frame!==frame.row || comparisons[0]!.error>=12) {
            const evidence=resolve('../artifacts/native-preview',`import-pixel-failure-${Date.now()}`); await mkdir(evidence,{recursive:true});
            await copyFile(sourcePath,join(evidence,'source.mp4')); await copyFile(prepared.resource,join(evidence,'editing.mp4'));
            await writeFile(join(evidence,'native.rgb'),frame.image);
            await copyFile(temp.file(`${name}-${frame.row}-${frame.row}.png`),join(evidence,'oracle.png'));
            await writeFile(join(evidence,'report.json'),JSON.stringify({name,frame:frame.row,comparisons,oracleColor,probe,native:prepared.nativeInfo},null,2));
            t.diagnostic(`Pixel evidence retained: ${evidence}`);
          }
          assert.equal(comparisons[0]!.frame,frame.row,`${name}: source image identity ${JSON.stringify(comparisons)}`);
          assert.ok(comparisons[0]!.error<12,`${name}: preview/oracle MAE ${comparisons[0]!.error}`);
        }
        const cut = await index.get(7);
        assert.equal((await index.at(cut.timeUs,'before')).index,6,'Right trim excludes its exact boundary');
        assert.equal((await index.at(cut.timeUs)).index,7);
        assert.equal(await sha256(sourcePath),before);
        await release(prepared); assert.equal(await native.terminated,0); prepared = undefined;
      } finally { await release(prepared); }
    }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); await temp.cleanup(); }
});

test('failed container-native validation falls back before ready without forcing video transcode', {skip:!windows,timeout:60000},async()=>{
  const temp=await tempFiles(),map=FrameIndex.prototype.mapNative;let prepared:PreparedNativeMedia|undefined,attempts=0;
  try{
    const file=temp.file('fallback.mp4');await generate(file);const source=await openSource(file),before=await sha256(file),info=mediaInfo(await probeMedia(file,{executable:ffprobe()}));
    const directory=temp.file('fallback');await mkdir(directory);
    FrameIndex.prototype.mapNative=async function(...args:Parameters<typeof map>){if(this.containerCandidate){attempts++;throw new AppFailure('FRAME_INDEX','Injected candidate mismatch');}return map.apply(this,args);};
    prepared=await prepareNativeMedia({source,info,directory,helper,ffmpeg:ffmpeg(),ffprobe:ffprobe(),signal:new AbortController().signal});
    assert.equal(attempts,1);assert.equal(prepared.index.containerCandidate,false);assert.equal(prepared.index.mappingReady,true);
    assert.equal(prepared.compatibility,false);assert.ok(prepared.warnings.some(warning=>warning.includes('回退')));
    assert.equal(await sha256(file),before);
  }finally{FrameIndex.prototype.mapNative=map;await release(prepared);await temp.cleanup();}
});

test('import cancellation and resource limits remove only new files after draining handles', { skip: !windows, timeout: 60000 }, async () => {
  const temp = await tempFiles();
  try {
    const sourcePath = temp.file('source.mp4'); await generate(sourcePath);
    const source = await openSource(sourcePath); const info = mediaInfo(await probeMedia(sourcePath,{executable:ffprobe()}));
    const directory = temp.file('session'); await mkdir(directory);
    const options = { source, info, directory, helper, ffmpeg:ffmpeg(), ffprobe:ffprobe() };
    await assert.rejects(buildFrameIndex({ source, info, executable:ffprobe(), output:temp.file('too-large.bin'),
      signal:new AbortController().signal,maxBytes:64 }),{code:'FRAME_INDEX'});
    assert.ok(!(await readdir(temp.directory)).includes('too-large.bin'));
    await assert.rejects(prepareNativeMedia({...options,signal:new AbortController().signal,reserveBytes:Number.MAX_SAFE_INTEGER}),{code:'PREVIEW_DISK_FULL'});
    assert.deepEqual(await readdir(directory),[]);
    const controller = new AbortController(); let nativeScanStarted = false;
    await assert.rejects(prepareNativeMedia({...options,signal:controller.signal,onProgress:value=>{
      if(value.stage==='native-index') { nativeScanStarted = true; controller.abort(); }
    }}));
    assert.equal(nativeScanStarted,true,'A helper startup failure must not masquerade as a successful cancellation test');
    assert.deepEqual(await readdir(directory),[],'Cancelled import must not leave a partial index');
    assert.deepEqual(await openSource(sourcePath),source);
  } finally { await temp.cleanup(); }
});
