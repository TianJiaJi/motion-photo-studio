import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppFailure, publicError, reply } from '../../src/main/errors.ts';

test('native failure causes remain available locally but never cross the public IPC reply', async () => {
  const cause = new Error('decoder details: C:\\private\\source.mp4');
  const error = new AppFailure('MEDIA_FAILED', '媒体处理失败。', { cause });
  assert.equal(error.cause, cause);
  assert.deepEqual(publicError(error), { code: 'MEDIA_FAILED', message: '媒体处理失败。' });
  let local: unknown;
  const result = await reply(() => { throw error; }, value => { local = value; });
  assert.equal(local, error);
  assert.deepEqual(result, { ok: false, error: { code: 'MEDIA_FAILED', message: '媒体处理失败。' } });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(await reply(() => { throw error; }, () => { throw new Error('diagnostic sink failure'); }), result);
});
