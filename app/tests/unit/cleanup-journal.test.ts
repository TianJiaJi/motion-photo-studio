import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,rename,symlink,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {CleanupJournal,directoryIdentity,checkedJson,writeNewJson} from '../../src/main/jobs/cleanup-journal.ts';
import {tempFiles} from '../helpers.ts';
const job='job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('durable cleanup records bind the root and exact directory identity',async()=>{
  const temp=await tempFiles();
  try{
    const root=temp.file('sessions');await mkdir(root);const directory=join(root,job);await mkdir(directory);
    const journal=new CleanupJournal(root),id=await directoryIdentity(directory);
    await journal.ensure(job,id);await journal.ensure(job,id);
    assert.deepEqual(await journal.jobs(),[job]);assert.equal((await journal.read(job))?.identity,id);
    await rename(directory,temp.file('retained'));await mkdir(directory);
    await assert.rejects(journal.ensure(job,await directoryIdentity(directory)),{reason:'invalid-journal'});
    await journal.forget(job);assert.deepEqual(await journal.jobs(),[]);
    assert.deepEqual(await readdir(temp.file('retained')),[]);
  }finally{await temp.cleanup();}
});
test('journal cannot authorize a replaced root or carry arbitrary paths',async()=>{
  const temp=await tempFiles();
  try{
    const root=temp.file('sessions');await mkdir(root);await mkdir(join(root,job));
    const journal=new CleanupJournal(root);await journal.ensure(job,await directoryIdentity(join(root,job)));
    await rename(root,temp.file('old-root'));await mkdir(root);
    await assert.rejects(journal.read(job),{reason:'invalid-journal'});
    await assert.rejects(journal.ensure('../outside','1:2:3'),{reason:'unsafe-path'});
    assert.equal((await readdir(temp.file('old-root')))[0],job);
  }finally{await temp.cleanup();}
});
test('exclusive metadata creation and bounded reads preserve foreign or corrupt records',async()=>{
  const temp=await tempFiles();
  try{
    const path=temp.file('existing.json');await writeFile(path,'foreign');
    await assert.rejects(writeNewJson(path,{owner:'new'}),{code:'EEXIST'});assert.equal(await readFile(path,'utf8'),'foreign');
    await assert.rejects(checkedJson(path,1024,'invalid-marker'),{reason:'invalid-marker'});
    await writeFile(path,'x'.repeat(8193));await assert.rejects(checkedJson(path,8192,'invalid-journal'),{reason:'invalid-journal'});
  }finally{await temp.cleanup();}
});
test('junction ancestors and linked record entries are refused without touching their targets',async()=>{
  const temp=await tempFiles();let ancestor:string|undefined,entry:string|undefined;
  try{
    const target=temp.file('target');await mkdir(target);await writeFile(join(target,'keep.txt'),'keep');
    ancestor=temp.file('alias');await symlink(target,ancestor,'junction');
    await assert.rejects(directoryIdentity(ancestor),{reason:'unsafe-path'});
    const root=temp.file('sessions');await mkdir(root);const journal=new CleanupJournal(root);await mkdir(journal.directory);
    entry=join(journal.directory,`${job}.json`);await symlink(target,entry,'junction');
    await assert.rejects(journal.read(job),{reason:'invalid-journal'});
    assert.equal(await readFile(join(target,'keep.txt'),'utf8'),'keep');assert.deepEqual(await readdir(target),['keep.txt']);
  }finally{if(entry)await unlink(entry);if(ancestor)await unlink(ancestor);await temp.cleanup();}
});
