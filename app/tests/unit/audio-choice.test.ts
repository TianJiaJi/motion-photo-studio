import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioSelection, initialAudioTrack } from '../../src/shared/export.ts';
test('multiple audio tracks have no silent default; an incomplete keep choice never becomes omission', () => {
  const tracks = [{ index: 1 }, { index: 2 }];
  assert.equal(initialAudioTrack(tracks), null); assert.equal(initialAudioTrack([]), null);
  assert.equal(initialAudioTrack([{ index: 4 }]), 4);
  assert.equal(audioSelection(true, null, tracks, false), null);
  assert.equal(audioSelection(true, 0, tracks, false), null);
  assert.deepEqual(audioSelection(true, 2, tracks, false), { kind: 'track', index: 2, downmixStereo: false });
  assert.deepEqual(audioSelection(false, null, tracks, false), { kind: 'omit' });
  assert.deepEqual(audioSelection(true, 1, tracks, true), { kind: 'track', index: 1, downmixStereo: true });
});
