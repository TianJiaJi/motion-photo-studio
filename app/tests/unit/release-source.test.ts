import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error Dependency-free pre-install release helper.
import { sharpWindowsSource, verifyPinnedNotice } from '../../scripts/release/package-source.mjs';
// @ts-expect-error Dependency-free release diagnostics helper.
import { safeConfigureDiagnostics } from '../../scripts/release/sanitize-config.mjs';
test('configure diagnostics exclude the initial environment dump, retaining actual link errors',()=>{
  const raw="# ./configure\nPRIVATE_KEY='secret\nmultiline'\nGITHUB_TOKEN='token'\ntest_cpp_condition windows.h _MSC_FULL_VER\ncheck_func_headers x265.h x265_api_get\nundefined reference to setupAssemblyPrimitives\n";
  const safe=safeConfigureDiagnostics(raw);assert.doesNotMatch(safe,/PRIVATE_KEY|GITHUB_TOKEN|secret|multiline|token/);
  assert.match(safe,/undefined reference to setupAssemblyPrimitives/);
  assert.doesNotMatch(safeConfigureDiagnostics("SECRET='no compiler probes'"),/SECRET|no compiler probes'/);
});
test('vendored runtime notice exactly matches upstream bytes and rejects tampering',()=>{
  const pins=JSON.parse(readFileSync('release/sources.json','utf8'));
  assert.ok(pins.vendoredNotices.length>0);
  for(const pin of pins.vendoredNotices) {
    const bytes=readFileSync(`release/licenses/${pin.file}`);
    verifyPinnedNotice(pin,bytes);
    assert.throws(()=>verifyPinnedNotice(pin,Buffer.concat([bytes,Buffer.from('changed')])));
    assert.throws(()=>verifyPinnedNotice(pin,bytes.subarray(0,bytes.length-1)));
    assert.throws(()=>verifyPinnedNotice({...pin,file:'../escape.txt'},bytes));
    assert.throws(()=>verifyPinnedNotice({...pin,sha256:'0'.repeat(64)},bytes));
    assert.throws(()=>verifyPinnedNotice({...pin,gitBlob:'0'.repeat(40)},bytes));
  }
});
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
