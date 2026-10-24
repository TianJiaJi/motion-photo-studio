import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import { openSource } from '../../src/main/media/source.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { preservePcmAudio } from '../../src/main/media/pcm-audio.ts';

for (const audioCodec of ['pcm_s16le', 'aac']) test(`source-matching exports HEVC 60fps + ${audioCodec} with original resolution/rate/channels and real decode`, async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('source.mp4'); const directory = temp.file('private'); await mkdir(directory);
    const engines = { ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'test' }; const signal = new AbortController().signal;
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=44100:duration=3', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=1:frame-threads=1', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', audioCodec, '-ac', '2', input]);
    const originalHash = await sha256(input); const source = await openSource(input);
    const request = { clip: { startUs: 1000000, endUs: 2000000 }, processing: { mode: 'source' as const }, audio: { kind: 'track' as const, index: 1, downmixStereo: false }, hdrConsent: false };
    const analysis = await analyzeExport(source, request, engines, signal); assert.equal(analysis.public.supported, true);
    const draft = await renderExportDraft({ source, analysis, image: { fit: 'cover', background: '#000000' }, directory, engines, signal });
    assert.equal(draft.report.proof.kind, 'encode'); if (draft.report.proof.kind === 'encode') assert.equal(draft.report.proof.sourceMatched, true);
    const metadata = await probeMedia(draft.video.path, { executable: engines.ffprobe }); const v = metadata.streams.find(s => s.codec_type === 'video')!; const a = metadata.streams.find(s => s.codec_type === 'audio')!;
    assert.deepEqual([v.width, v.height, v.avg_frame_rate], [320, 180, '60/1']); assert.deepEqual([a.codec_name, a.profile, a.sample_rate, a.channels], ['aac', 'LC', '44100', 2]);
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', draft.video.path, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
    const originalRaw = temp.file('source.raw'), actualRaw = temp.file('actual.raw');
    await runProcess(engines.ffmpeg,['-v','error','-nostdin','-n','-i',input,'-map','0:a','-c:a','pcm_s16le','-f','s16le',originalRaw]);
    await runProcess(engines.ffmpeg,['-v','error','-nostdin','-n','-i',draft.video.path,'-map','0:a','-af','atrim=end=1','-c:a','pcm_s16le','-f','s16le',actualRaw]);
    const expected=(await readFile(originalRaw)).subarray(44100*4,88200*4),actual=await readFile(actualRaw);
    assert.equal(actual.length,expected.length,'The selected one-second audio interval must remain complete');
    let energy=0,error=0;for(let i=0;i<actual.length;i+=2){const a=actual.readInt16LE(i),b=expected.readInt16LE(i);energy+=b*b;error+=(a-b)**2;}
    assert.ok(Math.sqrt(energy/(actual.length/2))/32768>0.01,'Reference contains audible signal');
    assert.ok(10*Math.log10(energy/Math.max(error,1))>20,'AAC must preserve the selected source waveform, not merely contain an audio stream');
    if (audioCodec === 'pcm_s16le') {
      // Keep the independent PCM utility's exact-byte guarantee; it is no longer the source-preset export policy.
      assert.equal(analysis.plan?.kind,'encode');if(analysis.plan?.kind!=='encode')throw new Error('Missing encode plan');
      const pcm=await preservePcmAudio({source,index:1,...analysis.plan.value,output:temp.file('pcm-utility.mp4'),engines,signal});
      const raw=temp.file('pcm-utility.raw');await runProcess(engines.ffmpeg,['-v','error','-nostdin','-n','-i',pcm.file.path,'-map','0:a','-c:a','pcm_s16le','-f','s16le',raw]);
      assert.deepEqual(await readFile(raw),expected,'Standalone PCM transport still preserves exact source bytes');
    }
    assert.equal(await sha256(input), originalHash);
    const cancelDir = temp.file('cancel'); await mkdir(cancelDir); const controller = new AbortController();
    await assert.rejects(renderExportDraft({ source, analysis, image: { fit: 'cover', background: '#000000' }, directory: cancelDir, engines, signal: controller.signal,
      onStage: stage => { if (stage === 'audio') controller.abort(); } }));
    assert.deepEqual(await readdir(cancelDir), []);
  } finally { await temp.cleanup(); }
});
