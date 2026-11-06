import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuickFrameProvider } from '../../src/main/media/quick-import.ts';
import type { NativePreview } from '../../src/main/media/native-preview.ts';
import type { LocalFrameResolver } from '../../src/main/media/local-frame-resolver.ts';
import type { MediaInfo } from '../../src/shared/media.ts';

for (const origin of [0n, 76800n, -76800n]) test(`quick clock keeps source boundaries despite 100ns quantization (origin ${origin})`, async () => {
  const info = { startPts: origin.toString(), timeBase: { numerator: 1, denominator: 15360 }, durationUs: 2_000_000 } as MediaInfo;
  const anchor = 333333n;
  const samples = [0n, 7424n, 7680n, 7936n].map(tick => ({ tick, stamp: tick === 0n ? anchor : anchor + tick * 10_000_000n / 15360n - 1n }));
  const native = { async request(request: { timeHns: string; boundary: 'before' | 'after' }) {
    const target = BigInt(request.timeHns);
    const row = request.boundary === 'after' ? samples.find(row => row.stamp >= target) : samples.findLast(row => row.stamp < target);
    assert.ok(row);
    return { value: { timestampHns: row.stamp.toString(), durationHns: '166666', width: 1, height: 1 }, pixels: Buffer.alloc(4) };
  } } as unknown as NativePreview;
  const provider = new QuickFrameProvider({ info, firstPts: origin, firstNativeHns: anchor, firstTimeUs: 0, resolver: {} as LocalFrameResolver });
  const at = await provider.frameAt(native, 500000, 'after');
  assert.equal(at.timeUs, 500000); assert.equal(at.identity, null, 'clock normalization must not fabricate verified source identity');
  assert.equal((await provider.frameAt(native, 500000, 'before')).timeUs, 483333);
  assert.equal((await provider.frameAt(native, 500001, 'before')).timeUs, 500000);
  assert.equal((await provider.frameAt(native, 500001, 'after')).timeUs, 516666);
});
test('quick clock rejects timestamps off the calibrated source clock grid', async () => {
  const info = { startPts: '0', timeBase: { numerator: 1, denominator: 15360 }, durationUs: 2_000_000 } as MediaInfo;
  const provider = new QuickFrameProvider({ info, firstPts: 0n, firstNativeHns: 0n, firstTimeUs: 0, resolver: {} as LocalFrameResolver });
  const native = { async request() { return { value: { timestampHns: '5000020', durationHns: '166666', width: 1, height: 1 }, pixels: Buffer.alloc(4) }; } } as unknown as NativePreview;
  await assert.rejects(provider.frameAt(native, 500000, 'after'), { code: 'FRAME_INDEX' });
});
