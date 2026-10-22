import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { openSource } from '../../src/main/media/source.ts';
import { analyzeExport, renderExportDraft } from '../../src/main/media/export-pipeline.ts';
import { sha256 } from '../../src/main/motion/io.ts';

test('explicit second-track choice preserves its actual frequency; original mode refuses implicit multi-track loss', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('multi.mp4'); const directory = temp.file('private'); await mkdir(directory);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const source = await openSource(input); const hash = await sha256(input); const signal = new AbortController().signal;
    const engines = { ffmpeg: ffmpeg(), ffprobe: ffprobe(), build: 'integration-test' };
    const selected = await analyzeExport(source, { clip: { startUs: 500000, endUs: 1500000 },
      processing: { mode: 'encode', crop: { x: 0, y: 0, width: 1, height: 1 }, settings: { fps: 30, resolution: 'original', crf: 23 } },
      audio: { kind: 'track', index: 2, downmixStereo: false }, hdrConsent: false }, engines, signal);
    const result = await renderExportDraft({ source, analysis: selected, directory, image: { fit: 'cover', background: '#000000' }, engines, signal });
    assert.match(result.report.warnings.join(' '), /保留音轨 2/); assert.match(result.report.warnings.join(' '), /其余音轨不保留/);
    const pcm = temp.file('segment.f32');
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-i', result.video.path, '-map', '0:a:0', '-vn',
      '-af', 'atrim=start=0.2:end=0.7', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcm]);
    const data = await readFile(pcm); assert.equal(data.length, 24000 * 4);
    let crossings = 0; let previous = data.readFloatLE(0);
    for (let offset = 4; offset < data.length; offset += 4) {
      const value = data.readFloatLE(offset); if ((value >= 0) !== (previous >= 0)) crossings++; previous = value;
    }
    // Independent waveform check: 0.5s of 880Hz has ~880 zero crossings; silently choosing track 1 gives ~440.
    assert.ok(Math.abs(crossings - 880) <= 4, `wrong retained frequency: ${crossings} crossings`);
    const copy = await analyzeExport(source, { ...selected.options, processing: { mode: 'copy' } }, engines, signal);
    assert.equal(copy.public.supported, false); assert.match(copy.public.reasons.join(' '), /多音轨/);
    const omitted = await analyzeExport(source, { ...selected.options, processing: { mode: 'copy' }, audio: { kind: 'omit' } }, engines, signal);
    assert.equal(omitted.public.supported, true);
    const silent = await renderExportDraft({ source, analysis: omitted, directory, image: { fit: 'cover', background: '#000000' }, engines, signal });
    assert.equal((await probeMedia(silent.video.path)).streams.filter(s => s.codec_type === 'audio').length, 0);
    assert.match(silent.report.warnings.join(' '), /明确选择不保留/); assert.equal(await sha256(input), hash);
  } finally { await temp.cleanup(); }
});
