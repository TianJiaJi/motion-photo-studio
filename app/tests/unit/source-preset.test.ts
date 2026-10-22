import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExportOptions } from '../../src/main/media/export-requests.ts';
import { SOURCE_MATCH_EDITS, processingGeometry } from '../../src/shared/processing.ts';
test('source preset is a bounded one-click request, preserves Full HD dimensions and does not impose 30fps/1080-edge defaults', () => {
  const request = { clip: { startUs: 0, endUs: 1000000 }, processing: { mode: 'source' }, audio: { kind: 'omit' }, hdrConsent: false };
  assert.deepEqual(parseExportOptions(request).processing, { mode: 'source' });
  assert.throws(() => parseExportOptions({ ...request, processing: { mode: 'source', fps: 30 } }));
  assert.deepEqual(SOURCE_MATCH_EDITS.settings, { fps: null, resolution: 'original', crf: 16 });
  const geometry = processingGeometry({ mode: 'source' }, { encodedWidth: 1920, encodedHeight: 1080, displayWidth: 1920, displayHeight: 1080 });
  assert.deepEqual([geometry.width, geometry.height], [1920, 1080]);
});
