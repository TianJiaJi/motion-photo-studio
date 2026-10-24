import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseMediaRequest } from '../../src/main/media/requests.ts';

test('media IPC accepts bounded typed requests, never caller-supplied file paths or commands', () => {
  const assetId = randomUUID();
  const frame = { assetId, startUs: 0, endUs: 1234567, count: 3, hdrConsent: false };
  assert.deepEqual(parseMediaRequest('thumbnails', [frame]), frame);
  const step = { cursor: randomUUID(), direction: -1 };
  for (const value of [null, [], { ...frame, path: 'C:\\private\\secret.mp4' }, { ...frame, command: 'cmd.exe' },
    { ...frame, assetId: 'file:///secret' }, { ...frame, startUs: Infinity }, { ...frame, startUs: -1 },
    { ...frame, startUs: 1.5 }, { ...frame, hdrConsent: 'true' }, { ...frame, step: null },
    { ...frame, step: { ...step, direction: 0 } }, { ...frame, step: { ...step, path: 'C:\\private' } },
    Object.assign(Object.create({ step }), frame)]) {
    assert.throws(() => parseMediaRequest('thumbnails', [value]), { code: 'INVALID_REQUEST' });
  }
  for (const removed of ['preview', 'frame', 'captureCover', '__proto__'])
    assert.throws(() => parseMediaRequest(removed as Parameters<typeof parseMediaRequest>[0], [frame]), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseMediaRequest('close', [{ assetId }, 'extra']), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseMediaRequest('thumbnails', [{ assetId, startUs: 0, endUs: 1000, count: 100000, hdrConsent: false }]), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseMediaRequest('thumbnails', [{ assetId, startUs: 1000, endUs: 0, count: 8, hdrConsent: false }]), { code: 'INVALID_REQUEST' });
  const options = { clip: { startUs: 0, endUs: 1000000 }, processing: { mode: 'copy' }, audio: { kind: 'omit' }, hdrConsent: false };
  assert.deepEqual(parseMediaRequest('analyze', [{ assetId, options }]), { assetId, options });
  assert.throws(() => parseMediaRequest('analyze', [{ assetId, options: { ...options, output: 'C:\\private' } }]), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseMediaRequest('renderDraft', [{ assetId, analysisId: 'forged', image: { fit: 'cover', background: '#000000' } }]), { code: 'INVALID_REQUEST' });
  const save = { assetId, draftId: randomUUID(), saveId: randomUUID() };
  assert.deepEqual(parseMediaRequest('saveDraft', [save]), save);
  for (const extra of [{ output: 'C:\\secret.jpg' }, { profileId: 'arbitrary' }, { timestampUs: 0 }, { path: 'C:\\source' }])
    assert.throws(() => parseMediaRequest('saveDraft', [{ ...save, ...extra }]), { code: 'INVALID_REQUEST' });
  assert.deepEqual(parseMediaRequest('cancel', [{ assetId, saveId: save.saveId }]), { assetId, saveId: save.saveId });
  assert.throws(() => parseMediaRequest('cancel', [{ assetId, saveId: 'invalid' }]), { code: 'INVALID_REQUEST' });
});
