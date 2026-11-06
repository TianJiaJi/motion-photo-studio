import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { TempFiles } from '../../src/main/jobs/temp-files.ts';
import { tempFiles } from '../helpers.ts';
const job = 'job-11111111-1111-1111-1111-111111111111';
test('explicit workspace reset removes unmarked and corrupt legacy caches, not adjacent source or outputs', async () => {
  const t = await tempFiles();
  try {
    const root=t.file('media-sessions'), dir=join(root,job);
    await mkdir(join(dir,'frames'),{recursive:true}); await writeFile(join(dir,'frames','old'),'cache');
    await writeFile(join(dir,'.owner.json'),'corrupt');
    await mkdir(`${root}.cleanup-journal`); await writeFile(join(`${root}.cleanup-journal`,`${job}.json`),'corrupt');
    await writeFile(t.file('source.mp4'),'original'); await writeFile(t.file('saved.jpg'),'published');
    const store=new TempFiles(root); await store.initialize({discardStale:true});
    assert.deepEqual(await readdir(root),[]); assert.deepEqual(await readdir(`${root}.cleanup-journal`),[]); assert.deepEqual(store.issues,[]);
    const fresh=await store.create(); assert.notEqual(fresh,dir); await store.remove(fresh);
    assert.equal(await readFile(t.file('source.mp4'),'utf8'),'original'); assert.equal(await readFile(t.file('saved.jpg'),'utf8'),'published');
  } finally { await t.cleanup(); }
});
test('stale reset refuses junctions and hard links before deleting any data; next safe startup retries', async () => {
  const t=await tempFiles();
  try {
    const root=t.file('jobs'), dir=join(root,job), target=t.file('outside');
    await mkdir(dir,{recursive:true}); await mkdir(target); await writeFile(join(target,'keep'),'source'); await writeFile(join(dir,'cache'),'cache');
    await symlink(target,join(dir,'junction'),process.platform==='win32'?'junction':'dir');
    const store=new TempFiles(root); await store.initialize({discardStale:true});
    assert.equal(store.issues[0]?.reason,'unsafe-path'); assert.equal(await readFile(join(dir,'cache'),'utf8'),'cache');
    await unlink(join(dir,'junction')); await link(join(target,'keep'),join(dir,'hard-link'));
    await store.initialize({discardStale:true}); assert.equal(store.issues[0]?.reason,'unsafe-path');
    await unlink(join(dir,'hard-link')); await store.initialize({discardStale:true}); assert.deepEqual(await readdir(root),[]);
    assert.equal(await readFile(join(target,'keep'),'utf8'),'source');
  } finally { await t.cleanup(); }
});
test('ordinary stores keep strict ownership and reset is rejected outside app workspace roots', async () => {
  const t=await tempFiles();
  try {
    const root=t.file('media-sessions'); await mkdir(join(root,job),{recursive:true}); await writeFile(join(root,job,'keep'),'old');
    const store=new TempFiles(root); await store.initialize(); assert.equal(store.issues[0]?.reason,'missing-marker');
    await assert.rejects(new TempFiles(t.file('pictures')).initialize({discardStale:true}),{code:'TEMP_CLEANUP'});
    assert.equal(await readFile(join(root,job,'keep'),'utf8'),'old');
  } finally { await t.cleanup(); }
});
