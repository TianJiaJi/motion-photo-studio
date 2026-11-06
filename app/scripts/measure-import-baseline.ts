// End-to-end import timing baseline for the strict (pre-change) preparation path.
// Deterministic local fixtures only; writes de-identified JSON/markdown evidence to
// artifacts/import-baseline/. Usage: node scripts/measure-import-baseline.ts [--durations 30,120] [--runs 2]
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, release, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { runProcess } from '../src/main/media/runner.ts';
import { openSource } from '../src/main/media/source.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { mediaInfo } from '../src/main/media/info.ts';
import { prepareNativeMedia, type PreparedNativeMedia, type ImportProgress } from '../src/main/media/native-import.ts';

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
}
const durations = option('durations', '30,120').split(',').map(value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 6 || number > 3600) throw new Error('Invalid duration');
  return number;
});
const runs = Number(option('runs', '2'));
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('Invalid runs');

const ffmpeg = resolve('resources/bin/ffmpeg.exe');
const ffprobe = resolve('resources/bin/ffprobe.exe');
const helper = resolve('resources/bin/motion-preview.exe');
const root = resolve('../artifacts/import-baseline', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(root, { recursive: true });
console.log(`Baseline evidence: ${root}`);

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null, max: sorted.at(-1) ?? null };
}

type StageRow = { stage: ImportProgress['stage'] | 'total' | 'probe' | 'ready'; startedMs: number; endedMs: number };
async function measure(file: string): Promise<{ stages: StageRow[]; firstProgressMs: Record<string, number>; frames: number; compatibility: boolean; audioTracks: number; seek: Record<string, number[]> }> {
  const stages: StageRow[] = [];
  const mark = <T>(stage: StageRow['stage'], operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    return operation().then(value => { stages.push({ stage, startedMs: Math.round(started), endedMs: Math.round(performance.now()) }); return value; },
      error => { stages.push({ stage, startedMs: Math.round(started), endedMs: Math.round(performance.now()) }); throw error; });
  };
  const source = await mark('probe', async () => openSource(file));
  const probe = await mark('probe', () => probeMedia(file, { executable: ffprobe }));
  const info = mediaInfo(probe);
  const progressAt = new Map<ImportProgress['stage'], number>();
  let prepared: PreparedNativeMedia | undefined;
  const started = performance.now();
  try {
    prepared = await prepareNativeMedia({ source, info, directory: root, helper, ffmpeg, ffprobe,
      signal: new AbortController().signal, maximumEdge: 960,
      onProgress: value => { progressAt.set(value.stage, Math.round(performance.now() - started)); } });
    stages.push({ stage: 'total', startedMs: Math.round(started), endedMs: Math.round(performance.now()) });
    const firstProgressMs = Object.fromEntries([...progressAt]);
    const seek: Record<string, number[]> = { head: [], middle: [], tail: [], repeat: [] };
    const count = prepared.index.count;
    for (let run = 0; run < runs; run++) {
      for (const [name, index] of [['head', 0], ['middle', Math.floor(count / 2)], ['tail', count - 1]] as const) {
        const at = performance.now();
        await prepared.index.locate(prepared.native, index);
        seek[name]!.push(Math.round(performance.now() - at));
      }
      const at = performance.now();
      await prepared.index.locate(prepared.native, Math.floor(count / 2));
      seek.repeat!.push(Math.round(performance.now() - at));
    }
    return { stages, firstProgressMs, frames: prepared.index.count, compatibility: prepared.compatibility,
      audioTracks: prepared.audio.length, seek };
  } finally {
    await prepared?.native.shutdown();
    await prepared?.index.close();
  }
}

const report: Record<string, unknown> = {
  recordedAt: new Date().toISOString(),
  scope: '严格导入路径（整片索引 + 全片原生映射 + 全轨音轨准备）现版本基线；固定本地生成素材。',
  hardware: { cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem(), os: `Windows ${release()} ${arch()}`, node: process.version },
  fixtures: [],
};
for (const duration of durations) {
  const file = join(root, `fixture-1080p30-gop250-${duration}s.mp4`);
  await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`, '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '250', '-bf', '3', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', file], { timeoutMs: 900000 });
  const rows: Awaited<ReturnType<typeof measure>>[] = [];
  for (let run = 0; run < runs; run++) rows.push(await measure(file));
  const stageTiming: Record<string, ReturnType<typeof distribution>> = {};
  for (const stage of ['probe', 'source-index', 'native-index', 'audio', 'total'] as const) {
    const values = rows.flatMap(row => row.stages.filter(entry => entry.stage === stage).map(entry => entry.endedMs - entry.startedMs));
    if (values.length) stageTiming[stage] = distribution(values);
  }
  const seekTiming: Record<string, ReturnType<typeof distribution>> = {};
  const merged: Record<string, number[]> = {};
  for (const row of rows) for (const [name, values] of Object.entries(row.seek)) (merged[name] ??= []).push(...values);
  for (const [name, values] of Object.entries(merged)) seekTiming[name] = distribution(values);
  const fixture = { name: `1080p30-gop250-${duration}s`, durationSeconds: duration, runs: rows.map(row => ({ ...row })),
    stageMs: stageTiming, seekMs: seekTiming, frames: rows[0]?.frames, compatibility: rows[0]?.compatibility, audioTracks: rows[0]?.audioTracks };
  (report.fixtures as unknown[]).push(fixture);
  console.log(JSON.stringify({ fixture: fixture.name, stageMs: stageTiming }, null, 2));
}
await writeFile(join(root, 'baseline.json'), JSON.stringify(report, null, 2));
console.log(`Wrote ${join(root, 'baseline.json')}`);
