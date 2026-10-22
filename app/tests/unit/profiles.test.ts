import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE_ID, VERIFIED_TARGET, getProfile } from '../../src/main/motion/profiles.ts';
import { buildXmp, parseMotionXmp } from '../../src/main/motion/xmp.ts';
import { makeExif, readExifSummary } from '../../src/main/motion/jpeg.ts';

test('device-scoped default uses modern XMP and the observed Xiaomi EXIF flag', () => {
  const profile = getProfile(DEFAULT_PROFILE_ID);
  assert.equal(profile.id, 'C-modern-xiaomi');
  assert.equal(profile.legacy, false);
  assert.equal(profile.xiaomiFlag, true);
  assert.equal(parseMotionXmp(buildXmp(profile, 5000, -1)).timestampUs, -1);
  assert.equal(parseMotionXmp(buildXmp(profile, 5000, 0)).legacy, false);
  assert.equal(readExifSummary(makeExif(profile.xiaomiFlag).subarray(4)).xiaomiFlag, 1);
  assert.equal(VERIFIED_TARGET.osBuild, '3.0.304.0.WNLCNXM.C11');
  assert.equal(VERIFIED_TARGET.gallery, '4.3.1.18');
  assert.equal(VERIFIED_TARGET.model, 'Redmi K70E');
});
