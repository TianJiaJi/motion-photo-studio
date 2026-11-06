import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseMediaRequest } from '../../src/main/media/requests.ts';
import type { BatchSnapshot } from '../../src/shared/export.ts';

function request() {
  const assetId = randomUUID();
  const snapshot: BatchSnapshot = { assetId, batchId: randomUUID(), mode: 'source',
    settings: { fps: null, resolution: 'original', crf: 16 }, audio: { kind: 'omit' }, hdrConsent: false,
    clips: [{ clipId: assetId, revision: 0, selection: { startUs: 0, endUs: 1_000_000 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, cover: { kind: 'auto' }, coverFit: 'cover', background: '#000000' }] };
  return { assetId, snapshot };
}
test('batch IPC clones all settings and accepts only typed cover references', () => {
  for (const kind of ['auto', 'frame', 'custom'] as const) {
    const input = request(); input.snapshot.clips[0]!.cover = kind === 'auto' ? { kind } : { kind, coverId: randomUUID() };
    const parsed = parseMediaRequest('exportAll', [input]);
    assert.deepEqual(parsed, input);
    input.snapshot.settings.crf = 50; input.snapshot.clips[0]!.selection.startUs = 123;
    input.snapshot.clips[0]!.crop.width = .5;
    assert.equal(parsed.snapshot.settings.crf, 16); assert.equal(parsed.snapshot.clips[0]!.selection.startUs, 0);
    assert.equal(parsed.snapshot.clips[0]!.crop.width, 1);
  }
});
test('batch IPC rejects renderer paths, invalid identities, duplicate clips and oversized lists', () => {
  const valid = request();
  for (const input of [
    { ...valid, outputDirectory: 'C:/output' },
    { ...valid, snapshot: { ...valid.snapshot, outputDirectory: 'C:/output' } },
    { ...valid, snapshot: { ...valid.snapshot, assetId: randomUUID() } },
    { ...valid, snapshot: { ...valid.snapshot, clips: [] } },
    { ...valid, snapshot: { ...valid.snapshot, clips: [valid.snapshot.clips[0], valid.snapshot.clips[0]] } },
    { ...valid, snapshot: { ...valid.snapshot, clips: Array.from({ length: 101 }, () => ({ ...valid.snapshot.clips[0], clipId: randomUUID() })) } },
    { ...valid, snapshot: { ...valid.snapshot, clips: [{ ...valid.snapshot.clips[0], revision: -1 }] } },
    { ...valid, snapshot: { ...valid.snapshot, clips: [{ ...valid.snapshot.clips[0], cover: { kind: 'custom', path: 'C:/private.png' } }] } },
  ]) assert.throws(() => parseMediaRequest('exportAll', [input]), { code: 'INVALID_REQUEST' });
  assert.deepEqual(parseMediaRequest('cancel', [{ assetId: valid.assetId, batchId: valid.snapshot.batchId }]), { assetId: valid.assetId, batchId: valid.snapshot.batchId });
  assert.throws(() => parseMediaRequest('cancel', [{ assetId: valid.assetId, batchId: 'not-an-id' }]), { code: 'INVALID_REQUEST' });
});
