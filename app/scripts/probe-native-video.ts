import { mkdir, copyFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { NativePrototype } from './lib/native-prototype.ts';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/probe-native-video.ts <synthetic-test-video>');
const root = resolve('../artifacts/native-preview', `native-video-${Date.now()}`);
await mkdir(root, { recursive: true });
const source = join(root, 'source.mp4');
await copyFile(resolve(input), source);
const client = new NativePrototype();
const report: Record<string, unknown> = { frames: [] };
try {
  report.hello = (await client.request({ command: 'hello' })).header.result;
  report.open = (await client.request({ command: 'open', path: source, maximumEdge: 960 })).header.result;
  const hashes = new Set<string>();
  for (const timeUs of [0, 3600000, 18000000, 7200000, 20400000, 500000, 20000000]) {
    const start = performance.now();
    const reply = await client.request({ command: 'seek', timeUs });
    const elapsedMs = performance.now() - start;
    const frame = reply.header.result;
    if (reply.pixels.length !== frame.width * frame.height * 4) throw new Error('Frame dimensions/payload mismatch');
    const actualUs = Number(BigInt(frame.timestampHns)) / 10;
    // MF has its own presentation timeline (e.g. MP4 edit-list/B-frame offsets).
    // The first sample need not be at zero. This probe tests raw MF positioning, NOT source-PTS mapping.
    if (actualUs < timeUs || timeUs > 0 && actualUs - timeUs > 34000) throw new Error(`Raw MF seek mismatch ${timeUs} -> ${actualUs}`);
    if (timeUs === 0) report.firstMfTimestampUs = actualUs;
    const hash = createHash('sha256').update(reply.pixels).digest('hex'); hashes.add(hash);
    await sharp(reply.pixels, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toFile(join(root, `frame-${timeUs}.png`));
    const row = { timeUs, actualUs, elapsedMs, hash, width: frame.width, height: frame.height };
    (report.frames as unknown[]).push(row); console.log(JSON.stringify(row));
  }
  if (hashes.size < 6) throw new Error('Native seeks did not produce distinct frames');
  const start = performance.now();
  let bytes = 0; let last = -Infinity;
  for (let index = 0; index < 60; index++) {
    const reply = await client.request({ command: 'read' });
    if (reply.header.result.ended) break;
    const timestamp = Number(reply.header.result.timestampHns);
    if (timestamp <= last) throw new Error('Non-monotonic native video output');
    last = timestamp; bytes += reply.pixels.length;
  }
  report.continuous = { elapsedMs: performance.now() - start, bytes, pid: client.child.pid };
  await client.request({ command: 'close' });
  await unlink(source);
  report.releasedSource = await stat(source).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
  report.exitCode = await client.shutdown();
  if (report.exitCode !== 0) throw new Error('Native helper failed shutdown');
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.shutdown().catch(() => { client.child.kill(); });
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Native video report: ${root}`);
}
