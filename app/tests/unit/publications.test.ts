import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile, readFile, readdir, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Publications } from '../../src/main/jobs/publications.ts';
import { tempFiles } from '../helpers.ts';

test('restart recovery removes only owned publication scratch and keeps a committed final hard link', async () => {
  const temp = await tempFiles();
  try {
    const root = temp.file('journal'); const parent = temp.file('output'); await mkdir(parent);
    const journal = new Publications(root); assert.deepEqual(await journal.initialize(), []);
    const workspace = await journal.begin(parent); await writeFile(workspace.stage, 'fully written fixture');
    await writeFile(`${workspace.directory}/.container.part.${randomUUID()}.tmp`, 'interrupted mux fixture');
    const output = `${parent}/final.jpg`; await link(workspace.stage, output);
    assert.deepEqual(await new Publications(root).initialize(), []);
    assert.equal(await readFile(output, 'utf8'), 'fully written fixture'); assert.deepEqual(await readdir(root), []);
    await assert.rejects(access(workspace.directory), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});
test('unknown workspace files and forged manifests are kept untouched with one recovery warning', async () => {
  const temp = await tempFiles();
  try {
    const journal = new Publications(temp.file('journal')); await journal.initialize();
    const parent = temp.file('output'); await mkdir(parent); const workspace = await journal.begin(parent);
    const sentinel = `${workspace.directory}/user-sentinel.txt`; await writeFile(sentinel, 'do not delete');
    assert.equal((await new Publications(journal.root).initialize()).length, 1); assert.equal(await readFile(sentinel, 'utf8'), 'do not delete');
    await assert.rejects(journal.cleanup('../elsewhere'));
    const id = randomUUID(); const outside = temp.file('user-data'); await mkdir(outside); await writeFile(`${outside}/important.txt`, 'untouched');
    await writeFile(`${journal.root}/${id}.json`, JSON.stringify({ owner: 'motion-photo-studio.publication.v1', id, directory: outside }));
    assert.equal((await new Publications(journal.root).initialize()).length, 1); assert.equal(await readFile(`${outside}/important.txt`, 'utf8'), 'untouched');
  } finally { await temp.cleanup(); }
});
