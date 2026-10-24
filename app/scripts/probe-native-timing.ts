// Correlate native samples with FFmpeg oracle pictures before deciding source-time mapping.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { runProcess } from '../src/main/media/runner.ts';
import { NativePrototype } from './lib/native-prototype.ts';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/probe-native-timing.ts <synthetic-24s-test-video>');
const root = resolve('../artifacts/native-preview', `native-timing-${Date.now()}`);
await mkdir(root, { recursive: true });
const path = resolve(input);
const ff = resolve('resources/bin/ffmpeg.exe');
const probe = await runProcess(resolve('resources/bin/ffprobe.exe'), ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts,best_effort_timestamp_time', '-of', 'json', path]);
const index: { pts: number; best_effort_timestamp_time: string }[] = JSON.parse(probe.stdout).frames;
const native = new NativePrototype();
const report: Record<string, unknown> = { groups: [] };
try {
  report.metadata = (await native.request({ command: 'open', path, maximumEdge: 640 })).header.result;
  for (const startUs of [0, 3600000, 7200000, 18000000]) {
    const startIndex = Math.max(0, Math.round(startUs / 1000000 * 30) - 4);
    const oraclePath = join(root, `oracle-${startUs}.rgb`);
    // Use decoded frame index to avoid making seek timestamp assumptions in the oracle itself.
    await runProcess(ff, ['-v', 'error', '-nostdin', '-n', '-i', path, '-an', '-vf', `select=between(n\\,${startIndex}\\,${startIndex + 11}),scale=64:36:flags=bilinear`,
      '-fps_mode', 'passthrough', '-frames:v', '12', '-pix_fmt', 'rgb24', '-f', 'rawvideo', oraclePath]);
    const oracle = await readFile(oraclePath);
    const bytes = 64 * 36 * 3;
    const rows = [];
    for (let n = 0; n < 4; n++) {
      const reply = await native.request(n === 0 ? { command: 'seek', timeUs: startUs } : { command: 'read' });
      const f = reply.header.result;
      const picture = await sharp(reply.pixels, { raw: { width: f.width, height: f.height, channels: 4 } }).removeAlpha().resize(64, 36, { kernel: 'linear' }).raw().toBuffer();
      const candidates = [];
      for (let k = 0; k < oracle.length / bytes; k++) {
        let error = 0;
        for (let b = 0; b < bytes; b++) error += Math.abs(picture[b]! - oracle[k * bytes + b]!);
        candidates.push({ index: startIndex + k, mae: error / bytes });
      }
      candidates.sort((a, b) => a.mae - b.mae);
      const best = candidates[0]!;
      const source = index[best.index]!;
      rows.push({ nativeHns: f.timestampHns, oracleFrame: best.index, sourcePts: source.pts,
        sourceSeconds: source.best_effort_timestamp_time, mae: best.mae,
        secondBest: candidates[1], offsetUs: Number(f.timestampHns) / 10 - Number(source.best_effort_timestamp_time) * 1000000 });
    }
    (report.groups as unknown[]).push({ startUs, rows });
  }
  const rows = (report.groups as { rows: { offsetUs: number; mae: number; secondBest: { mae: number } }[] }[]).flatMap(g => g.rows);
  report.offsetRangeUs = [Math.min(...rows.map(r => r.offsetUs)), Math.max(...rows.map(r => r.offsetUs))];
  report.notes = 'Pixel correlation on this fixture only; not a general edit-list/source-PTS mapping policy.';
  if (rows.some(r => r.mae > 12 || r.secondBest.mae <= r.mae)) throw new Error('Oracle/native picture correlation inconclusive');
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.error = String(error); console.error(error); process.exitCode = 1; }
finally { await native.shutdown().catch(() => native.child.kill()); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(`Native timing evidence: ${root}`); }
