import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { inspect } from 'node:util';
import { runProcess } from '../src/main/media/runner.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { mediaInfo } from '../src/main/media/info.ts';
import { openSource } from '../src/main/media/source.ts';
import { buildFrameIndex } from '../src/main/media/frame-index.ts';
import { NativePreview, type NativeFrameInfo } from '../src/main/media/native-preview.ts';
const directory = resolve('../artifacts/native-preview',`native-index-${Date.now()}`); await mkdir(directory,{recursive:true});
const ffmpeg = resolve('resources/bin/ffmpeg.exe'), ffprobe = resolve('resources/bin/ffprobe.exe');
const path = join(directory,'source.mp4');
await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=6',
  '-an','-c:v','libx264','-preset','veryfast','-crf','18','-g','180','-bf','3','-pix_fmt','yuv420p',
  '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv', '-video_track_timescale','90000',path]);
const source = await openSource(path), info = mediaInfo(await probeMedia(path,{executable:ffprobe}));
const index = await buildFrameIndex({source,info,executable:ffprobe,output:join(directory,'index.bin'),signal:new AbortController().signal});
const native = new NativePreview(resolve('resources/bin/motion-preview.exe'));
const report: Record<string,unknown> = {info,count:index.count};
try {
  report.native = await native.open(path,640,undefined,{matrix709:true,fullRange:false});
  try { await index.mapNative(native,new AbortController().signal); report.mapped = true; }
  catch(error) { report.mappingError = inspect(error,{depth:4}); }
  const anchors = [];
  for(const number of [0,7,90,179]) {
    const row = await index.get(number);
    try {
      const result = report.mapped ? await index.locate(native,number) : await native.request<NativeFrameInfo>({command:'locate',timeHns:row.nativeHns});
      anchors.push({row,returned:result.value});
    } catch(error) { anchors.push({row,error:inspect(error,{depth:4})}); }
  }
  report.anchors = anchors;
} finally {
  await native.shutdown(); await index.close();
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); console.log(directory);
}
