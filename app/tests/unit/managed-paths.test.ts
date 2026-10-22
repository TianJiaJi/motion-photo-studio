import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempFiles } from '../helpers.ts';
import { isManagedPath, isPublicationWorkspace } from '../../src/main/jobs/managed-paths.ts';

test('managed-directory checks respect path boundaries and reserve target-side publication workspaces', async () => {
  const temp = await tempFiles();
  try {
    const root = temp.file('cache'); const sibling = temp.file('cache-other'); await mkdir(root); await mkdir(sibling);
    const canonical = await realpath(root); const other = await realpath(sibling);
    assert.equal(await isManagedPath(join(canonical, 'job', 'final.jpg'), [root]), true);
    assert.equal(await isManagedPath(join(other, 'final.jpg'), [root]), false);
    assert.equal(isPublicationWorkspace(join(other, `.motion-photo-job-${randomUUID()}`, 'final.jpg')), true);
    assert.equal(isPublicationWorkspace(join(other, 'regular-folder', 'final.jpg')), false);
  } finally { await temp.cleanup(); }
});
