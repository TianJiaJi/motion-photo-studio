import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { NativePrototype } from './lib/native-prototype.ts';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/probe-native-audio.ts <synthetic-audio-video>');
const root = resolve('../artifacts/native-preview', `native-audio-${Date.now()}`);
await mkdir(root, { recursive: true });
const client = new NativePrototype();
const report: Record<string, unknown> = { samples: [] };
try {
  report.hello = (await client.request({ command: 'hello' })).header.result;
  report.video = (await client.request({ command: 'open', path: resolve(input), maximumEdge: 640 })).header.result;
  const first = await client.request({ command: 'seek', timeUs: 1000000 });
  report.firstVideo = first.header.result;
  report.audio = (await client.request({ command: 'audioStart', timeUs: 1000000 })).header.result;
  const start = performance.now();
  let previousClock = 0;
  for (let index = 0; index < 60; index++) {
    const frame = await client.request({ command: 'read' });
    if (frame.header.result.ended) throw new Error('Fixture ended too early');
    const targetUs = Number(frame.header.result.timestampHns) / 10;
    let status = (await client.request({ command: 'audioStatus' })).header.result;
    if (status.error || !status.running) throw new Error(`Audio stopped: ${JSON.stringify(status)}`);
    const deltaMs = (targetUs - Number(status.timeHns) / 10) / 1000;
    if (deltaMs > 0 && deltaMs < 1000) await wait(deltaMs);
    status = (await client.request({ command: 'audioStatus' })).header.result;
    const clock = Number(status.timeHns) / 10;
    if (clock < previousClock) throw new Error('Audio clock moved backward');
    previousClock = clock;
    (report.samples as unknown[]).push({ index, videoUs: targetUs, audioUs: clock, skewMs: (clock - targetUs) / 1000,
      wallMs: performance.now() - start, bytes: frame.pixels.length, submittedFrames: status.submittedFrames });
  }
  report.stop = (await client.request({ command: 'audioStop' })).header.result;
  if ((report.stop as any).running) throw new Error('Audio still running after stop');
  report.seekAfterStop = (await client.request({ command: 'seek', timeUs: 15000000 })).header.result;
  report.restartedAudio = (await client.request({ command: 'audioStart', timeUs: 15000000 })).header.result;
  await wait(300);
  report.restartClock = (await client.request({ command: 'audioStatus' })).header.result;
  if (Number((report.restartClock as any).timeHns) < 150000000) throw new Error('Stale audio after seek');
  await client.request({ command: 'close' });
  report.exitCode = await client.shutdown();
  const samples = report.samples as { skewMs: number }[];
  report.maxAbsClockSkewMs = Math.max(...samples.map(x => Math.abs(x.skewMs)));
  console.log(JSON.stringify({ audio: report.audio, stop: report.stop, maxAbsClockSkewMs: report.maxAbsClockSkewMs }));
  // This measures device-clock/video-sample scheduling, not acoustic/display latency.
  if ((report.maxAbsClockSkewMs as number) > 80) throw new Error('Prototype video/audio clock skew exceeds 80ms');
} catch (error) { report.error = String(error); console.error(error); process.exitCode = 1; }
finally {
  await client.shutdown().catch(() => client.child.kill());
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Native audio report: ${root}`);
}
