import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, truncate } from 'node:fs/promises';
import { tempFiles } from '../helpers.ts';
import { FrameIndex, INDEX_RECORD_BYTES } from '../../src/main/media/frame-index.ts';
import { nativeInteger, type NativePreview } from '../../src/main/media/native-preview.ts';
import type { MediaInfo } from '../../src/shared/media.ts';
const info: MediaInfo = {
  videoIndex: 0, encodedWidth: 320, encodedHeight: 180, displayWidth: 320, displayHeight: 180,
  rotation: 0, durationUs: 400000, startPts: '9007199254740995', startUs: 0,
  timeBase: { numerator: 1, denominator: 1000 }, frameRate: null, sampleAspectRatio: { numerator: 1, denominator: 1 },
  audioTracks: [], codec: 'h264', hasAudio: false, hdr: false, originalPreviewMime: 'video/mp4',
};
async function fixture() {
  const temp = await tempFiles(); const data = Buffer.alloc(3 * INDEX_RECORD_BYTES);
  for (const [index, delta] of [0, 100, 250].entries()) {
    const offset = index * INDEX_RECORD_BYTES;
    data.writeBigInt64LE(BigInt(info.startPts) + BigInt(delta), offset);
    data.writeBigInt64LE(BigInt(delta * 1000), offset + 8);
    data.writeBigInt64LE(BigInt(delta * 10000 + 2000000), offset + 16);
    data.writeBigInt64LE(index === 0 ? 100n : 150n, offset + 24);
    data.writeBigInt64LE(1000000n, offset + 32);
    data.writeUInt32LE(index === 0 ? 1 : 0, offset + 40);
  }
  await writeFile(temp.file('index.bin'), data);
  const index = new FrameIndex(temp.file('index.bin'), 3, info);
  return { temp, index };
}
function native(stamps: string[]) {
  let sent = false;
  return { request: async (request: Record<string, unknown>) => {
    if (request.command === 'resetScan') { sent = false; return { value: {} }; }
    if (request.command === 'scanFrames') {
      const frames = sent ? [] : stamps.map(timestampHns => ({ timestampHns, durationHns: '1000000' })); sent = true;
      return { value: { frames, ended: true } };
    }
    return { value: { timestampHns: request.timeHns }, pixels: Buffer.alloc(4) };
  } } as unknown as NativePreview;
}
test('VFR boundaries preserve bigint source PTS; right trim is strictly exclusive', async () => {
  const { temp, index } = await fixture();
  try {
    assert.equal((await index.at(100000)).pts, '9007199254741095');
    assert.equal((await index.at(100000, 'before')).index, 0);
    assert.equal((await index.at(100001, 'before')).index, 1);
    assert.equal((await index.at(100001)).index, 2);
    assert.equal((await index.at(400000, 'before')).index, 2);
    await assert.rejects(index.at(0, 'before'), { code: 'FRAME_BOUNDARY' });
    await assert.rejects(index.at(400000), { code: 'FRAME_BOUNDARY' });
    await assert.rejects(index.get(3), { code: 'FRAME_INDEX' });
    await assert.rejects(index.fromNative('2000000'), { code: 'FRAME_INDEX' });
  } finally { await index.close(); await temp.cleanup(); }
});
test('full scan validates variable intervals and records each native timestamp independently', async () => {
  const { temp, index } = await fixture();
  try {
    await index.mapNative(native(['2000000','3000000','4500000']), new AbortController().signal);
    assert.equal(index.mappingReady, true);
    assert.equal((await index.fromNative('4500000')).index, 2);
    await assert.rejects(index.fromNative('4000000'), { code: 'FRAME_INDEX' });
    await assert.rejects(index.mapNative(native(['2000000','3100000','4500000']), new AbortController().signal), { code: 'FRAME_INDEX' });
    assert.equal(index.mappingReady, false, 'Never reuse a partially rewritten mapping');
    await assert.rejects(index.mapNative(native(['2000000','3000000']), new AbortController().signal), { code: 'FRAME_INDEX' });
  } finally { await index.close(); await temp.cleanup(); }
});
test('truncated indexes and malformed native integers fail closed', async () => {
  const { temp, index } = await fixture();
  try {
    await truncate(index.path, 2 * INDEX_RECORD_BYTES);
    await assert.rejects(index.get(0), { code: 'FRAME_INDEX' });
    for (const value of ['1.5', '9223372036854775808', '1e3', {}, '']) assert.throws(() => nativeInteger(value), { code: 'NATIVE_PROTOCOL' });
    assert.equal(nativeInteger('-9223372036854775808'), -(1n << 63n));
  } finally { await index.close(); await temp.cleanup(); }
});
