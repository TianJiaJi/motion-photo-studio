import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clipSelectionAt, createClip, editClip } from '../../src/shared/editor.ts';
import { parseClipModels, clipReference } from '../../src/main/media/clip-requests.ts';
import { parseMediaRequest } from '../../src/main/media/requests.ts';

test('adding clips preserves playhead, short tail, EOF and independent overlapping defaults', () => {
  assert.deepEqual(clipSelectionAt(1_000_000, 10_000_000), { startUs: 1_000_000, endUs: 4_000_000 });
  assert.deepEqual(clipSelectionAt(9_999_999, 10_000_000), { startUs: 9_999_999, endUs: 10_000_000 });
  assert.deepEqual(clipSelectionAt(10_000_000, 10_000_000), { startUs: 7_000_000, endUs: 10_000_000 });
  assert.deepEqual(clipSelectionAt(2_000_000, 2_000_000), { startUs: 0, endUs: 2_000_000 });
  const first = createClip(randomUUID(), { startUs: 0, endUs: 10_000_000 }, 10_000_000);
  const second = createClip(randomUUID(), clipSelectionAt(0, 10_000_000), 10_000_000, 2);
  const changed = editClip(first, { crop: { x: 0.1, y: 0, width: 0.8, height: 1 }, background: '#ffffff' });
  assert.equal(changed.revision, 1); assert.equal(second.revision, 0);
  assert.equal(second.crop.x, 0); assert.equal(second.background, '#000000');
  assert.equal(first.crop.x, 0);
});
test('clip IPC rejects incomplete identity, stale-shaped objects, oversized lists and invalid geometry', () => {
  const assetId = randomUUID(); const clip = createClip(assetId, { startUs: 0, endUs: 3_000_000 }, 3_000_000);
  assert.deepEqual(parseClipModels([clip], 3_000_000), [clip]);
  assert.deepEqual(parseMediaRequest('syncClips', [{ assetId, clips: [clip] }]), { assetId, clips: [clip] });
  assert.deepEqual(clipReference({ clipId: assetId, revision: 0 }), { clipId: assetId, revision: 0 });
  for (const value of [{ clipId: assetId }, { revision: 0 }, { clipId: '../path', revision: 0 }, { clipId: assetId, revision: -1 }])
    assert.throws(() => clipReference(value), { code: 'INVALID_REQUEST' });
  for (const clips of [[], [clip, clip], [{ ...clip, crop: { x: -1, y: 0, width: 1, height: 1 } }], [{ ...clip, path: 'C:/private' }],
    Array.from({ length: 101 }, (_, i) => ({ ...clip, id: randomUUID(), number: i + 1 }))])
    assert.throws(() => parseClipModels(clips), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseMediaRequest('uploadCover', [{ assetId, clipId: assetId }]), { code: 'INVALID_REQUEST' });
});
