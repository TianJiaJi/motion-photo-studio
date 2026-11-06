import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { openSource } from '../../src/main/media/source.ts';
import { NativeTimeline } from '../../src/main/media/native-timeline.ts';
import type { PreparedMedia } from '../../src/main/media/native-import.ts';
import type { ProvidedFrame } from '../../src/main/media/frame-provider.ts';
import type { PreviewPixels } from '../../src/shared/native-preview.ts';

test('new epochs cancel active local step resolution without terminating the shared helper', async () => {
  const temp = await tempFiles(); let timeline: NativeTimeline | undefined;
  try {
    const path = temp.file('source'); await writeFile(path, 'source'); const source = await openSource(path);
    let exit!: (code: number) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let aborted = false, shutdowns = 0;
    const frame: ProvidedFrame = { key: '0', timeUs: 0, durationUs: 33333, identity: null, nativeHns: '0', width: 1, height: 1, pixels: new Uint8Array(4) };
    const native = { alive: true, terminated: new Promise<number>(resolve => { exit = resolve; }),
      advanceEpoch() {}, request: async () => ({}), async shutdown() { shutdowns++; exit(0); } };
    const media = { native, frames: { mode: 'quick', frameCount: null, info: { durationUs: 3_000_000, timeBase: { numerator: 1, denominator: 30 } },
      frameAt: async () => frame,
      step: async (_native: unknown, _current: unknown, _direction: unknown, signal: AbortSignal) => {
        assert.ok(signal); entered();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
      }, close: async () => {} } } as unknown as PreparedMedia;
    let shown: PreviewPixels | undefined;
    timeline = new NativeTimeline('asset', source, media, { status() {}, frame(value) {
      shown = value;
      timeline!.acknowledge({ assetId: 'asset', epoch: value.epoch, frameId: value.frameId, painted: true });
    } });
    await timeline.control({ assetId: 'asset', epoch: 1, action: 'seek', timeUs: 0, boundary: 'after', final: true, maximumEdge: 960 });
    assert.ok(shown);
    assert.throws(() => timeline!.capture(shown!.frameId, 2), { code: 'FRAME_BOUNDARY' });
    const step = timeline.control({ assetId: 'asset', epoch: 2, action: 'step', frameId: shown.frameId, direction: 1 });
    const rejected = assert.rejects(step);
    await started;
    await timeline.control({ assetId: 'asset', epoch: 3, action: 'pause' });
    await rejected;
    assert.ok(aborted); assert.equal(shutdowns, 0);
  } finally { await timeline?.dispose(); await temp.cleanup(); }
});
