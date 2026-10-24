import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runProcess } from '../src/main/media/runner.ts';
import { NativePrototype } from './lib/native-prototype.ts';
const root = resolve('../artifacts/native-preview', `native-codecs-${Date.now()}`);
await mkdir(root, { recursive: true });
const ffmpeg = resolve('resources/bin/ffmpeg.exe');
const results: unknown[] = [];
for (const codec of ['h264', 'hevc'] as const) {
  const path = join(root, `${codec}.mp4`);
  await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=8', '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', 'ultrafast',
    ...(codec === 'hevc' ? ['-x265-params', 'log-level=error:pools=1:frame-threads=1', '-tag:v', 'hvc1'] : []),
    '-g', '90', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path]);
  const native = new NativePrototype();
  try {
    await native.request({ command: 'hello' });
    const metadata = (await native.request({ command: 'open', path, maximumEdge: 640 })).header.result;
    const frames = [];
    for (const timeUs of [0, 1000000, 5000000, 2000000]) {
      const response = await native.request({ command: 'seek', timeUs });
      if (!response.pixels.length) throw new Error('No native frame');
      frames.push(response.header.result);
    }
    results.push({ codec, supported: true, metadata, frames });
  } catch (error) {
    results.push({ codec, supported: false, error: String(error) });
    if (codec === 'h264') process.exitCode = 1;
  } finally { await native.shutdown().catch(() => native.child.kill()); }
}
await writeFile(join(root, 'report.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`Codec capability evidence: ${root}`);
