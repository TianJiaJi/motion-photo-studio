import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
// @ts-expect-error The release CLI is intentionally dependency-free JavaScript for the pre-install CI job.
import { releasePlan } from '../../scripts/release/plan.mjs';
const input = { version:'0.1.5', lockVersion:'0.1.5', rootVersion:'0.1.5', previousVersion:'0.1.4', event:'push', refType:'branch', refName:'main', notes:'# Motion Photo Studio v0.1.5\n'+ 'Detailed release notes. '.repeat(8) };
test('release follows a main version change, not every commit or a PR',()=>{
  assert.equal(releasePlan(input).release,true);
  assert.equal(releasePlan({...input,previousVersion:'0.1.5'}).prepare,false);
  assert.equal(releasePlan({...input,event:'pull_request'}).release,false);
  assert.equal(releasePlan({...input,refName:'feature'}).release,false);
  assert.equal(releasePlan({...input,previousVersion:null}).release,false);
  assert.throws(()=>releasePlan({...input,previousVersion:'0.2.0'}));
});
test('explicit tagged/manual release validates its exact version and intent',()=>{
  assert.equal(releasePlan({...input,refType:'tag',refName:'v0.1.5'}).release,true);
  assert.throws(()=>releasePlan({...input,refType:'tag',refName:'v0.1.4'}));
  assert.equal(releasePlan({...input,event:'workflow_dispatch'}).prepare,true);
  assert.equal(releasePlan({...input,event:'workflow_dispatch'}).release,false);
  assert.equal(releasePlan({...input,event:'workflow_dispatch',publish:true}).release,true);
});
test('release CLI resolves metadata from both repository and app working directories',()=>{
  const script=resolve('scripts/release/plan.mjs');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GITHUB_')&&!['BEFORE_SHA','PUBLISH_RELEASE'].includes(key)));
  for(const cwd of [resolve('.'),resolve('..')]) {
    const result=JSON.parse(execFileSync(process.execPath,[script],{cwd,env,encoding:'utf8'}));
    assert.equal(result.release,false);assert.equal(result.tag,`v${result.version}`);
  }
});
test('release rejects version drift, path-like versions and missing detailed notes',()=>{
  for(const change of [{lockVersion:'0.1.4'},{rootVersion:'0.1.4'},{version:'../bad'},{version:'01.1.5'},{notes:''},{notes:'# Wrong version\n'+input.notes}])assert.throws(()=>releasePlan({...input,...change}));
  assert.equal(releasePlan(input).notesPath,'docs/releases/v0.1.5.md');
});
