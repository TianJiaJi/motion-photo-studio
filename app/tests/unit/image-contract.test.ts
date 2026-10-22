import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJpegCoverRequest } from '../../src/main/media/image-contract.ts';
test('image requests accept only fixed JPEG geometry/fit/opaque background options, not commands or encoder knobs', () => {
  const request = { input: 'private-source.png', output: 'private-draft.jpg', width: 1080, height: 1920, fit: 'contain', background: '#15243A' };
  assert.deepEqual(parseJpegCoverRequest(request), request);
  for (const patch of [{ width: 0 }, { height: 1.5 }, { width: Number.MAX_SAFE_INTEGER }, { fit: 'fill' }, { background: 'rgba(0,0,0,0)' },
    { background: '#00000000' }, { output: '' }, { command: 'arbitrary' }, { quality: 0 }]) assert.throws(() => parseJpegCoverRequest({ ...request, ...patch }));
});
