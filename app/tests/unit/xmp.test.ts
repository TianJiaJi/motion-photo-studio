import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXmp, parseMotionXmp, NS } from '../../src/main/motion/xmp.ts';
import { PROFILES } from '../../src/main/motion/profiles.ts';

for (const profile of PROFILES) {
  for (const timestamp of [-1, 0, 1234567]) {
    test(`${profile.id}: timestamp ${timestamp} round trip and 64-bit length`, () => {
      const parsed = parseMotionXmp(buildXmp(profile, 2 ** 32 + 321, timestamp));
      assert.equal(parsed.timestampUs, timestamp);
      assert.equal(parsed.videoLength, 2 ** 32 + 321);
      assert.equal(parsed.modern, true);
      assert.equal(parsed.legacy, profile.legacy);
      assert.equal(parsed.primaryPadding, 0);
    });
  }
}

test('XML namespace URI matters, not prefix or layout', () => {
  const xml = buildXmp(PROFILES[1], 1234, 0).replaceAll('GCamera:', 'c:').replace('xmlns:GCamera=', 'xmlns:c=')
    .replaceAll('Container:', 'z:').replace('xmlns:Container=', 'xmlns:z=')
    .replaceAll('Item:', 'i:').replace('xmlns:Item=', 'xmlns:i=');
  assert.equal(parseMotionXmp(xml).videoLength, 1234);
});

test('element property form and single-quoted XML', () => {
  const xml = `<x:xmpmeta xmlns:x='adobe:ns:meta/'><r:RDF xmlns:r='${NS.rdf}'>
    <r:Description xmlns:c='${NS.camera}' xmlns:k='${NS.container}' xmlns:i='${NS.item}'>
      <c:MotionPhoto>1</c:MotionPhoto><c:MotionPhotoVersion>1</c:MotionPhotoVersion>
      <c:MotionPhotoPresentationTimestampUs>0</c:MotionPhotoPresentationTimestampUs>
      <k:Directory><r:Seq>
        <r:li><k:Item><i:Mime>image/jpeg</i:Mime><i:Semantic>Primary</i:Semantic></k:Item></r:li>
        <r:li><k:Item><i:Mime>video/mp4</i:Mime><i:Length>900</i:Length><i:Semantic>MotionPhoto</i:Semantic></k:Item></r:li>
      </r:Seq></k:Directory>
    </r:Description></r:RDF></x:xmpmeta>`;
  assert.equal(parseMotionXmp(xml).videoLength, 900);
});

test('legacy-only MicroVideo packet', () => {
  const xml = `<rdf:RDF xmlns:rdf='${NS.rdf}'><rdf:Description xmlns:c='${NS.camera}'
    c:MicroVideo='1' c:MicroVideoVersion='1' c:MicroVideoOffset='321' c:MicroVideoPresentationTimestampUs='0'/></rdf:RDF>`;
  assert.deepEqual(parseMotionXmp(xml), { modern: false, legacy: true, videoLength: 321, timestampUs: 0, primaryPadding: 0, videoPadding: 0 });
});

test('reject stale legacy values, duplicate properties and spoofed namespaces', () => {
  const xml = buildXmp(PROFILES[1], 1234, 0);
  assert.throws(() => parseMotionXmp(xml.replace('MicroVideoOffset="1234"', 'MicroVideoOffset="999"')), /Conflicting/);
  assert.throws(() => parseMotionXmp(xml.replace('MicroVideoPresentationTimestampUs="0"', 'MicroVideoPresentationTimestampUs="20"')), /Conflicting/);
  assert.throws(() => parseMotionXmp(xml.replace('<Container:Directory>', '<GCamera:MotionPhoto>1</GCamera:MotionPhoto><Container:Directory>')), /Duplicate/);
  assert.throws(() => parseMotionXmp(xml.replace(NS.camera, 'https://attacker.invalid/')), /No enabled/);
});

test('reject unsafe numeric values, unsupported directory layouts, DTD and broken XML', () => {
  const xml = buildXmp(PROFILES[0], 1234, 0);
  assert.throws(() => buildXmp(PROFILES[0], Number.MAX_SAFE_INTEGER + 1, 0), /Invalid/);
  assert.throws(() => buildXmp(PROFILES[0], 100, -2), /Invalid/);
  assert.throws(() => parseMotionXmp(xml.replace('Item:Length="1234"', 'Item:Length="1e3"')), /integer/);
  assert.throws(() => parseMotionXmp(xml.replace('Item:Length="1234"', 'Item:Length="9007199254740992"')), /Invalid/);
  assert.throws(() => parseMotionXmp(xml.replace('<rdf:Seq>', '<rdf:Seq><rdf:li/>')), /exactly/);
  assert.throws(() => parseMotionXmp('<!DOCTYPE x [<!ENTITY a "b">]>' + xml), /DOCTYPE/);
  assert.throws(() => parseMotionXmp(xml.slice(0, -5)));
});
