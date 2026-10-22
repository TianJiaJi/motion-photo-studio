import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { streamProcessLines } from '../../src/main/media/lines.ts';
import { parsePacketLine, packetHasIdr } from '../../src/main/media/packets.ts';

const hash = 'ab'.repeat(32);
const line = `packet|stream_index=0|pts=9007199254740993|dts=-1024|duration=512|size=9|pos=5000000000|flags=K__|data_hash=SHA256:${hash}`;

test('packet parsing preserves signed 64-bit ticks, large file offsets and AAC padding metadata', () => {
  const packet = parsePacketLine(line, true)!;
  assert.equal(packet.pts, 9007199254740993n); assert.equal(packet.dts, -1024n);
  assert.equal(packet.position, 5000000000); assert.equal(packet.hash, hash);
  const audio = parsePacketLine(line + '|side_datum/skip_samples:skip_samples=1024|side_datum/skip_samples:discard_padding=13')!;
  assert.equal(audio.skipSamples, 1024); assert.equal(audio.discardPadding, 13);
  for (const bad of [line + '|pts=1', line.replace('size=9', 'size=-1'), line.replace('duration=512', 'duration=-1'),
    line.replace('pts=9007199254740993', 'pts=9223372036854775808'), line.replace('pos=5000000000', 'pos=9007199254740992'),
    line.replace(`data_hash=SHA256:${hash}`, 'data_hash=SHA256:bad')]) assert.throws(() => parsePacketLine(bad, true));
  assert.throws(() => parsePacketLine(line.replace(`|data_hash=SHA256:${hash}`, ''), true));
  assert.equal(parsePacketLine(''), null);
});

test('AVCC inspection distinguishes an IDR from container key flags without reading complete packets', async () => {
  const temp = await tempFiles();
  try {
    const path = temp.file('samples.bin');
    const nonIdr = Buffer.from([0, 0, 0, 2, 0x61, 0]);
    const idr = Buffer.from([0, 0, 0, 2, 0x67, 0, 0, 0, 0, 3, 0x65, 0, 0]);
    await writeFile(path, Buffer.concat([nonIdr, idr]));
    const file = await open(path, 'r');
    try {
      const base = parsePacketLine(line)!; const size = nonIdr.length + idr.length;
      assert.equal(await packetHasIdr(file, size, { ...base, position: 0, size: nonIdr.length }, 4), false);
      assert.equal(await packetHasIdr(file, size, { ...base, position: nonIdr.length, size: idr.length }, 4), true);
      await assert.rejects(packetHasIdr(file, size, { ...base, position: nonIdr.length, size: idr.length - 1 }, 4), /extent/);
      await assert.rejects(packetHasIdr(file, size, { ...base, position: 0, size: 3 }, 4), /Truncated/);
      await assert.rejects(packetHasIdr(file, size, base, 4), /escapes/);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(packetHasIdr(file, size, { ...base, position: 0, size: nonIdr.length }, 4, controller.signal));
    } finally { await file.close(); }
  } finally { await temp.cleanup(); }
});

test('streaming process consumes output larger than capture limits with ordered async backpressure', async () => {
  let count = 0;
  const result = await streamProcessLines(process.execPath, ['-e', `
    let n=0; function pump(){ while(n<20000){if(!process.stdout.write(String(n++)+'x'.repeat(80)+'\\r\\n')){process.stdout.once('drain',pump);return;}} } pump();
  `], async value => { assert.equal(value, String(count++) + 'x'.repeat(80)); }, { timeoutMs: 15000 });
  assert.equal(count, 20000); assert.equal(result.stopped, false); assert.ok(result.stdoutBytes > 1024 * 1024);
});

test('fast-exiting children keep their first and final lines while asynchronous consumers exert backpressure', async () => {
  for (let batch = 0; batch < 12; batch++) await Promise.all(Array.from({ length: 4 }, async () => {
    const received: string[] = [];
    const result = await streamProcessLines(process.execPath, ['-e', "process.stdout.write('first\\n'+'middle\\n'.repeat(20)+'last')"], async line => {
      await new Promise<void>(resolve => setImmediate(resolve)); received.push(line);
    });
    assert.equal(result.stopped, false); assert.equal(result.stdoutBytes, 150);
    assert.equal(received.length, 22); assert.equal(received[0], 'first'); assert.equal(received.at(-1), 'last');
  }));
});

test('intentional stop drains live buffered pipes and waits for child close after async callbacks', { timeout: 30000 }, async () => {
  const producer = ['-e', "let n=0;function pump(){while(n<200000){if(!process.stdout.write(String(n++)+'x'.repeat(80)+'\\n')){process.stdout.once('drain',pump);return;}}}pump();"];
  for (let batch = 0; batch < 4; batch++) await Promise.all(Array.from({ length: 4 }, async () => {
    let received = 0;
    const result = await streamProcessLines(process.execPath, producer, async () => {
      await new Promise<void>(resolve => setImmediate(resolve)); return ++received === 127;
    }, { timeoutMs: 10000 });
    assert.equal(result.stopped, true); assert.equal(received, 127);
  }));
});

test('streaming process stops intentionally or cancels, and refuses oversized lines and callback failures', async () => {
  const live = ['-e', "console.log('first');setInterval(()=>console.log('later'),20)"];
  let count = 0;
  assert.equal((await streamProcessLines(process.execPath, live, () => { count++; return true; })).stopped, true);
  assert.equal(count, 1);
  const controller = new AbortController();
  await assert.rejects(streamProcessLines(process.execPath, live, () => controller.abort(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(streamProcessLines(process.execPath, ['-e', "console.log('x'.repeat(1000))"], () => {}, { maxLineChars: 64 }), /line exceeded/);
  await assert.rejects(streamProcessLines(process.execPath, live, () => { throw new Error('consumer failure'); }), /consumer failure/);
  await assert.rejects(streamProcessLines(process.execPath, ['-e', 'process.exit(7)'], () => {}), /exited 7/);
});
