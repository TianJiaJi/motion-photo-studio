// Opt-in real-media stress harness. Not a product limit or part of the short fixture suite.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, statfs, stat, unlink, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyEngines } from '../src/main/media/engine.ts';
import { runProcess } from '../src/main/media/runner.ts';
import { openSource } from '../src/main/media/source.ts';
import { analyzeExport, renderExportDraft } from '../src/main/media/export-pipeline.ts';
import { Publications } from '../src/main/jobs/publications.ts';
import { publishMotionPhoto } from '../src/main/motion/publish.ts';
import { validateMotion } from '../src/main/motion/validate.ts';
import { sha256, extractRange } from '../src/main/motion/io.ts';

if (process.argv.length !== 2) throw new Error('This fixed stress harness takes no paths or engine overrides');
const space = await statfs(tmpdir(), { bigint: true });
if (space.bavail * space.bsize < 26n * 1024n ** 3n) throw new Error('Stress harness needs 26 GiB free in system temp, including an 8 GiB safety reserve. Product limits are unchanged.');
const root = await mkdtemp(join(tmpdir(), 'Motion Photo M5-'));
const evidence = resolve('../artifacts/m5'); await mkdir(evidence, { recursive: true });
const tag = root.split(/[\\/]/).at(-1)!;
const records: Record<string, unknown>[] = [];
let peakRss = process.memoryUsage().rss; const started = Date.now();
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 250); sampler.unref();
function json(value: unknown): string { return JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2); }
async function checkpoint(name: string, value: Record<string, unknown>): Promise<void> {
  const item = { name, utc: new Date().toISOString(), ...value }; records.push(item);
  await writeFile(join(root, `${records.length.toString().padStart(2, '0')}-${name}.json`), json(item), { flag: 'wx', flush: true });
  console.log(json(item));
}
try {
  const engines = await verifyEngines(resolve('resources')); const signal = new AbortController().signal;
  await checkpoint('started', { root, engine: engines.build, availableBytes: space.bavail * space.bsize,
    memoryScope: 'Parent Node RSS sampled every 250ms only; excludes native children, Electron and OS cache. Not total system peak.',
    fixtureScope: 'Actual encoded synthetic media and full byte IO, not sparse files, free-box padding or duration-only metadata.' });
  const color = 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  // Calibrate real AVC filler packets before spending several GiB; a small output is a failure, not a fake big-file pass.
  const calibration = join(root, 'calibration.mp4');
  const cbr = ['-b:v', '96M', '-minrate', '96M', '-maxrate', '96M', '-bufsize', '192M', '-level:v', '5.1',
    '-x264-params', 'nal-hrd=cbr:filler=1:vbv-init=1:keyint=30:min-keyint=30:scenecut=0:open-gop=0'];
  await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
    '-vf', color, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-pix_fmt', 'yuv420p', '-bf', '0', ...cbr, calibration]);
  const calibrationBytes = (await stat(calibration)).size; assert.ok(calibrationBytes > 20000000, `CBR calibration too small: ${calibrationBytes}`);
  await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', calibration, '-f', 'null', '-']);
  await unlink(calibration); await checkpoint('calibration', { bytes: calibrationBytes });
  for (const fixture of [{ name: 'large', seconds: 380, fps: 30, audio: true }, { name: 'long', seconds: 7200, fps: 10, audio: false }]) {
    const began = Date.now(); const folder = join(root, fixture.name); await mkdir(folder);
    const privateDir = join(folder, 'private'); const outputDir = join(folder, '成品 photos'); await mkdir(privateDir); await mkdir(outputDir);
    const input = join(folder, '输入 source.mp4'); const output = join(outputDir, '实况照片.jpg');
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=${fixture.fps}:duration=${fixture.seconds}`,
      ...(fixture.audio ? ['-f', 'lavfi', '-i', `sine=frequency=523:sample_rate=48000:duration=${fixture.seconds}`] : []),
      '-vf', color, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-pix_fmt', 'yuv420p', '-bf', '0',
      ...(fixture.name === 'large' ? cbr : ['-crf', '23', '-x264-params', 'keyint=10:min-keyint=10:scenecut=0:open-gop=0']),
      ...(fixture.audio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']), '-t', String(fixture.seconds), '-movflags', '+faststart', input]);
    const source = await openSource(input); if (fixture.name === 'large') assert.ok(source.size > 0xffffffff, 'actual input must exceed 4 GiB');
    const originalHash = await sha256(input); await checkpoint(`${fixture.name}-input`, { input, size: source.size, sha256: originalHash, fixture });
    const analysis = await analyzeExport(source, { clip: { startUs: 0, endUs: fixture.seconds * 1000000 }, processing: { mode: 'copy' },
      audio: fixture.audio ? { kind: 'track', index: 1, downmixStereo: false } : { kind: 'omit' }, hdrConsent: false }, engines, signal);
    assert.equal(analysis.public.supported, true, analysis.public.reasons.join('; '));
    let stage = '';
    const draft = await renderExportDraft({ source, analysis, directory: privateDir, image: { fit: 'cover', background: '#000000' }, engines, signal,
      onStage: next => { if (next !== stage) { stage = next; console.log(`${fixture.name}: ${next}`); } } });
    assert.equal(draft.report.durationUs, fixture.seconds * 1000000); assert.equal(draft.report.proof.kind, 'copy');
    if (draft.report.proof.kind === 'copy') assert.equal(draft.report.proof.videoPackets, fixture.seconds * fixture.fps);
    const journal = new Publications(join(folder, 'journal')); assert.deepEqual(await journal.initialize(), []);
    const publish = { cover: draft.cover, video: draft.video, sources: [source], output, timestampUs: draft.report.coverTimestampUs,
      videoDurationUs: draft.report.durationUs, journal, signal, forbiddenRoots: [privateDir] };
    const saved = await publishMotionPhoto({ ...publish, onStage: next => { if (next !== stage) { stage = next; console.log(`${fixture.name}: ${next}`); } } });
    if (fixture.name === 'large') assert.ok(saved.size > 0xffffffff, 'actual final JPG must exceed 4 GiB');
    const inspected = await validateMotion(output, true); assert.equal(inspected.videoEnd, saved.size); assert.equal(inspected.metadata.videoLength, draft.video.size);
    const extracted = join(folder, 'extracted.mp4'); await extractRange(output, extracted, inspected.videoStart, inspected.videoEnd);
    const videoHash = await sha256(draft.video.path); assert.equal(await sha256(extracted), videoHash);
    await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', extracted, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    await unlink(extracted); // Release this generated copy before the cancellation trial; retain final JPG and original fixture.
    const cancelledOutput = join(outputDir, 'must-not-exist.jpg'); const cancellation = new AbortController();
    await assert.rejects(publishMotionPhoto({ ...publish, output: cancelledOutput, signal: cancellation.signal,
      onStage: next => { if (next === 'read-back') cancellation.abort(); } }), { code: 'CANCELLED' });
    await assert.rejects(access(cancelledOutput), { code: 'ENOENT' }); assert.deepEqual(await readdir(journal.root), []);
    assert.deepEqual(await readdir(outputDir), ['实况照片.jpg']); assert.equal(await sha256(input), originalHash);
    const finalHash = await sha256(output);
    await checkpoint(`${fixture.name}-passed`, { input, output, inputBytes: source.size, outputBytes: saved.size, durationUs: saved.durationUs,
      inputSha256: originalHash, outputSha256: finalHash, embeddedVideoSha256: videoHash, proof: draft.report.proof,
      cancellation: 'after full target-side mux and before readback/commit; no final, workspace/journal empty',
      elapsedMs: Date.now() - began, parentPeakRss: peakRss });
    await unlink(draft.video.path); await unlink(draft.cover.path);
  }
  await checkpoint('completed', { elapsedMs: Date.now() - started, parentPeakRss: peakRss, root,
    limitations: ['Native-process/renderer peaks and UI responsiveness not measured by this harness', 'Not camera-captured footage or target-phone acceptance', 'No actual disk-fill, clean installation or power-loss simulation'] });
  await writeFile(join(evidence, `${tag}-passed.json`), json({ status: 'passed', root, records }), { flag: 'wx', flush: true });
} catch (error) {
  const failure = { status: 'failed', root, records, error: String(error), stack: error instanceof Error ? error.stack : undefined };
  await writeFile(join(evidence, `${tag}-failed.json`), json(failure), { flag: 'wx', flush: true }); throw error;
} finally { clearInterval(sampler); }
