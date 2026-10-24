import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join,basename} from 'node:path';
import {TempFiles,type CleanupStage} from '../../src/main/jobs/temp-files.ts';
import {CleanupJournal} from '../../src/main/jobs/cleanup-journal.ts';
import {tempFiles} from '../helpers.ts';
const unknown='job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
for(const stage of ['journal','contents','marker','directory'] as const)test(`cleanup resumes safely after interruption at ${stage}`,async()=>{
  const temp=await tempFiles();
  try{
    const store=new TempFiles(temp.file('jobs'),{checkpoint:async at=>{if(at===stage)throw new Error('Simulated interruption');}});await store.initialize();
    const directory=await store.create(),journal=new CleanupJournal(store.root);await fs.mkdir(join(directory,'nested'));await fs.writeFile(join(directory,'nested','clip.mp4'),'cache');
    await assert.rejects(store.remove(directory),/Simulated interruption/);assert.equal((await journal.jobs()).length,1);
    if(stage==='journal'||stage==='contents')assert.equal((JSON.parse(await fs.readFile(join(directory,'.owner.json'),'utf8')) as {owner:string}).owner,'android-motion-photo.jobs.v2');
    const recovered=new TempFiles(store.root);assert.deepEqual(await recovered.initialize(),[]);
    assert.deepEqual(await fs.readdir(store.root),[]);assert.deepEqual(await journal.jobs(),[]);
    await recovered.remove(directory); // Successful deletion is idempotent.
  }finally{await temp.cleanup();}
});
test('partial occupied-file cleanup retains marker and journal until a later successful retry',async()=>{
  const temp=await tempFiles(),original=fs.unlink;
  try{
    const store=new TempFiles(temp.file('jobs'));await store.initialize();const directory=await store.create();
    for(const name of ['a.bin','b.bin','c.bin'])await fs.writeFile(join(directory,name),name);
    const marker=await fs.readFile(join(directory,'.owner.json'),'utf8');let deletes=0;
    fs.unlink=(async(path)=>{if(String(path).endsWith('.bin')&&++deletes>1)throw Object.assign(new Error('busy'),{code:'EBUSY'});return original(path);}) as typeof original;syncBuiltinESMExports();
    await assert.rejects(store.remove(directory),{code:'EBUSY'});
    assert.equal(await fs.readFile(join(directory,'.owner.json'),'utf8'),marker);
    assert.equal((await fs.readdir(directory)).filter(name=>name.endsWith('.bin')).length,2);
    assert.equal(store.issues[0]?.reason,'in-use');assert.equal((await new CleanupJournal(store.root).jobs()).length,1);
    fs.unlink=original;syncBuiltinESMExports();assert.deepEqual(await store.initialize(),[]);assert.deepEqual(await fs.readdir(store.root),[]);
  }finally{fs.unlink=original;syncBuiltinESMExports();await temp.cleanup();}
});
test('unmarked history is preserved and a journal never adopts unexpected unmarked content',async()=>{
  const temp=await tempFiles();
  try{
    const root=temp.file('jobs'),store=new TempFiles(root,{checkpoint:async stage=>{if(stage==='marker')throw new Error('crash');}});await store.initialize();
    const history=join(root,unknown);await fs.mkdir(history);await fs.writeFile(join(history,'original.mp4'),'historical');
    const owned=await store.create();await store.remove(owned).catch(()=>{});await fs.writeFile(join(owned,'unexpected.mp4'),'new data');
    const recovered=new TempFiles(root);const warnings=await recovered.initialize();assert.equal(warnings.length,1);
    assert.equal(recovered.issues.length,2);assert.ok(recovered.issues.every(issue=>issue.reason==='missing-marker'&&!issue.retryable));
    assert.equal(await fs.readFile(join(history,'original.mp4'),'utf8'),'historical');assert.equal(await fs.readFile(join(owned,'unexpected.mp4'),'utf8'),'new data');
    assert.deepEqual((await fs.readdir(history)),['original.mp4']);
  }finally{await temp.cleanup();}
});
test('marker create failure rolls back only its newly created empty directory',async()=>{
  const temp=await tempFiles();
  try{
    const root=temp.file('jobs');let directory='';
    const store=new TempFiles(root,{checkpoint:async(stage,path)=>{if(stage==='create-marker'){directory=path;throw new Error('write failed');}}});await store.initialize();
    await assert.rejects(store.create(),/write failed/);assert.deepEqual(await fs.readdir(root),[]);assert.deepEqual(await new CleanupJournal(root).jobs(),[]);
    const foreign=new TempFiles(root,{checkpoint:async(stage,path)=>{if(stage==='create-marker'){directory=path;await fs.writeFile(join(path,'keep'),'foreign');throw new Error('write failed');}}});
    await assert.rejects(foreign.create(),{code:'TEMP_CLEANUP'});assert.equal(await fs.readFile(join(directory,'keep'),'utf8'),'foreign');
    await new TempFiles(root).initialize();assert.equal(await fs.readFile(join(directory,'keep'),'utf8'),'foreign');
  }finally{await temp.cleanup();}
});
test('legacy v1 markers work; forged v2 bindings and nested junctions are rejected before deleting content',async()=>{
  const temp=await tempFiles();let link:string|undefined;
  try{
    const store=new TempFiles(temp.file('jobs'));await store.initialize();const legacy=join(store.root,unknown);await fs.mkdir(legacy);
    await fs.writeFile(join(legacy,'.owner.json'),JSON.stringify({owner:'android-motion-photo.jobs.v1'}));await fs.writeFile(join(legacy,'old'),'cache');await store.remove(legacy);
    const forged=await store.create();const marker=JSON.parse(await fs.readFile(join(forged,'.owner.json'),'utf8'));marker.job=unknown;await fs.writeFile(join(forged,'.owner.json'),JSON.stringify(marker));
    await assert.rejects(store.remove(forged),{reason:'invalid-marker'});
    const owned=await store.create(),target=temp.file('outside');await fs.mkdir(target);await fs.writeFile(join(target,'keep'),'source');await fs.writeFile(join(owned,'cache'),'untouched');
    link=join(owned,'linked');await fs.symlink(target,link,'junction');await assert.rejects(store.remove(owned),{reason:'unsafe-path'});
    assert.equal(await fs.readFile(join(owned,'cache'),'utf8'),'untouched');assert.equal(await fs.readFile(join(target,'keep'),'utf8'),'source');
    await assert.rejects(store.remove(target),{reason:'unsafe-path'});
  }finally{if(link)await fs.unlink(link);await temp.cleanup();}
});
test('directory replacement after journaling cannot redirect removal',async()=>{
  const temp=await tempFiles();
  try{
    const kept=temp.file('retained');let replaced=false;
    const store=new TempFiles(temp.file('jobs'),{checkpoint:async(stage:CleanupStage,path)=>{
      if(stage==='journal'&&!replaced){replaced=true;await fs.rename(path,kept);await fs.mkdir(path);await fs.writeFile(join(path,'new'),'foreign');}
    }});await store.initialize();const directory=await store.create();await fs.writeFile(join(directory,'old'),'original');
    await assert.rejects(store.remove(directory),{reason:'unsafe-path'});
    assert.equal(await fs.readFile(join(kept,'old'),'utf8'),'original');assert.equal(await fs.readFile(join(directory,'new'),'utf8'),'foreign');
    const recovered=new TempFiles(store.root);await recovered.initialize();assert.equal(recovered.issues.find(issue=>issue.directory===basename(directory))?.reason,'invalid-journal');
  }finally{await temp.cleanup();}
});
