import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentationDurationTicks } from '../../src/main/media/presentation-duration.ts';
import type { Mp4TrackIndex } from '../../src/main/media/mp4-sample-index.ts';
import type { Stream } from '../../src/main/media/probe.ts';

const stream: Stream = { index: 0, codec_type: 'video', codec_name: 'h264', time_base: '1/15360', start_pts: 0, duration_ts: 768 };
function track(overrides: Partial<Mp4TrackIndex> = {}): Mp4TrackIndex {
  // Decode order differs from presentation order; the last presented sample ends at 1024.
  const pts = [512n, 1280n, 768n];
  return { trackId: 1, handler: 'vide', timescale: 15360, duration: 768n, codec: 'avc1',
    sampleDescription: Buffer.alloc(0), fixedSampleSize: 0, sampleCount: pts.length,
    edits: [{ duration: 67n, mediaTime: 512n }],
    sample: i => ({ decodeIndex: i, chunkIndex: i, offset: 0n, size: 1, dts: BigInt(i * 256), pts: pts[i]!, duration: 256, sync: i === 0 }),
    ...overrides };
}
test('B-frame presentation duration extends an underreported decode duration without guessing FPS', async () => {
  assert.equal(await presentationDurationTicks(track(), 1000, stream), 1024);
  assert.equal(await presentationDurationTicks(track(), 1000, { ...stream, duration_ts: 1024 }), undefined);
  assert.equal(await presentationDurationTicks(track(), 1000, { ...stream, duration_ts: 2048 }), undefined, 'Never shorten declared coverage');
});
test('duration reconciliation respects edit clipping, ambiguous edits, time bases and stream starts', async () => {
  for (const edits of [
    [{ duration: 50n, mediaTime: 512n }], // Deliberately clips the tail; must not resurrect it.
    [{ duration: 66n, mediaTime: 512n }], // Even a fractional-tick overhang is not rounded into the edit.
    [{ duration: 67n, mediaTime: 512n }, { duration: 67n, mediaTime: 512n }],
    [{ duration: 67n, mediaTime: -1n }],
    [{ duration: 1n, mediaTime: -1n }, { duration: 67n, mediaTime: 512n }], // Non-integral leading delay.
  ]) assert.equal(await presentationDurationTicks(track({ edits }), 1000, stream), undefined);
  assert.equal(await presentationDurationTicks(track(), 1000, { ...stream, time_base: '1/90000' }), undefined);
  assert.equal(await presentationDurationTicks(track(), 1000, { ...stream, start_pts: 1 }), undefined);
  assert.equal(await presentationDurationTicks(track(), 1000, { ...stream, duration_ts: undefined }), undefined);
  assert.equal(await presentationDurationTicks(track({ sampleCount: 100001 }), 1000, stream), undefined);
});
test('mixed decode durations cannot prove a reordered VFR presentation tail', async () => {
  const base = track();
  const variable = track({ edits: [{ duration: 200n, mediaTime: 512n }],
    sample: i => ({ ...base.sample(i), duration: i === 1 ? 512 : 256 }) });
  assert.equal(await presentationDurationTicks(variable, 1000, stream), undefined);
});
test('leading empty edit preserves the nonzero origin and cancellation is honored', async () => {
  assert.equal(await presentationDurationTicks(track({ edits: [{ duration: 1000n, mediaTime: -1n }, { duration: 67n, mediaTime: 512n }] }),
    1000, { ...stream, start_pts: 15360 }), 1024);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(presentationDurationTicks(track(), 1000, stream, abort.signal), { name: 'AbortError' });
});
