import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import { openSource } from '../../src/main/media/source.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { probeMedia } from '../../src/main/media/probe.ts';

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
    assert.deepEqual([v.width, v.height, v.avg_frame_rate], [320, 180, '60/1']); assert.deepEqual([a.codec_name, a.sample_rate, a.channels], [audioCodec, '44100', 2]);
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', draft.video.path, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
    if (audioCodec === 'pcm_s16le') {
      const originalRaw = temp.file('source.raw'); const actualRaw = temp.file('actual.raw');
      for (const [path, output] of [[input, originalRaw], [draft.video.path, actualRaw]]) await runProcess(engines.ffmpeg,
        ['-v', 'error', '-nostdin', '-n', '-i', path!, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 's16le', output!]);
      assert.deepEqual(await readFile(actualRaw), (await readFile(originalRaw)).subarray(44100 * 4, 88200 * 4), 'actual output PCM samples equal exact selected source bytes');
    }
    assert.equal(await sha256(input), originalHash);
    const cancelDir = temp.file('cancel'); await mkdir(cancelDir); const controller = new AbortController();
    await assert.rejects(renderExportDraft({ source, analysis, image: { fit: 'cover', background: '#000000' }, directory: cancelDir, engines, signal: controller.signal,
      onStage: stage => { if (stage === 'audio') controller.abort(); } }));
    assert.deepEqual(await readdir(cancelDir), []);
  } finally { await temp.cleanup(); }
});
