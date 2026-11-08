import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error Dependency-free pre-install release helper.
import { sharpWindowsSource } from '../../scripts/release/package-source.mjs';
test('locked mirror packages resolve to canonical upstream without changing integrity',()=>{
  const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
  const pins=JSON.parse(readFileSync('release/sources.json','utf8'));
  const pkg=lock.packages['node_modules/@img/sharp-win32-x64'];
  const version=pins.imageSources.find((item:{name:string})=>item.name==='sharp').version;
  const expected={url:`https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-${version}.tgz`,integrity:pkg.integrity};
  assert.deepEqual(sharpWindowsSource(pkg,version),expected);
  assert.deepEqual(sharpWindowsSource({...pkg,resolved:'https://registry.npmmirror.com/mirror.tgz'},version),expected);
  assert.deepEqual(sharpWindowsSource({...pkg,resolved:'https://untrusted.invalid/not-used'},version),expected);
  for(const bad of [{...pkg,version:'0.0.0'},{...pkg,integrity:'sha1-bad'},null])assert.throws(()=>sharpWindowsSource(bad,version));
  assert.throws(()=>sharpWindowsSource(pkg,'../bad'));
});
