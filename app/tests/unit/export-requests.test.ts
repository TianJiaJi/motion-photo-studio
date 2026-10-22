import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraftOptions, parseExportOptions } from '../../src/main/media/export-requests.ts';
const base = { clip: { startUs: 1000000, endUs: 2000000 }, processing: { mode: 'copy' }, audio: { kind: 'omit' }, hdrConsent: false };
test('copy export cannot carry suspended image filters, CRF, paths or command arguments', () => {
  assert.deepEqual(parseExportOptions(base), base);
  for (const patch of [{ processing: { mode: 'copy', crop: { x: 0, y: 0, width: 1, height: 1 } } },
    { processing: { mode: 'copy', settings: { crf: 0 } } }, { output: 'C:\\arbitrary.jpg' }, { command: '-c copy' },
    { audio: { kind: 'omit', downmixStereo: true } }, { clip: { startUs: 0, endUs: 0 } }, { hdrConsent: 1 }])
    assert.throws(() => parseExportOptions({ ...base, ...patch }), { code: 'INVALID_REQUEST' });
});
test('encode requests validate nested edits and explicit audio/downmix choices', () => {
  const encoded = { ...base, processing: { mode: 'encode', crop: { x: .1, y: .2, width: .8, height: .7 }, settings: { fps: 24, resolution: 1080, crf: 23 } },
    audio: { kind: 'track', index: 2, downmixStereo: false } };
  assert.deepEqual(parseExportOptions(encoded), encoded);
  assert.throws(() => parseExportOptions({ ...encoded, processing: { ...encoded.processing, crop: { x: .8, y: 0, width: .8, height: 1 } } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseExportOptions({ ...encoded, audio: { kind: 'track', index: -1, downmixStereo: false } }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(parseDraftOptions({ fit: 'contain', background: '#aAbB00' }), { fit: 'contain', background: '#aAbB00' });
  assert.throws(() => parseDraftOptions({ fit: 'fill', background: '#000000' }), { code: 'INVALID_REQUEST' });
});
