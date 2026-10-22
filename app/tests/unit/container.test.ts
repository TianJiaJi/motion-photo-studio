import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile, writeFile, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { inspectJpeg, makeExif, readExifSummary, app1, XMP_HEADER } from '../../src/main/motion/jpeg.ts';
import { inspectMp4 } from '../../src/main/motion/mp4.ts';
import { muxMotion } from '../../src/main/motion/mux.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { PROFILES } from '../../src/main/motion/profiles.ts';
import { buildXmp } from '../../src/main/motion/xmp.ts';
import { tempFiles, structuralInputs, structuralJpeg, structuralMp4, segment, box } from '../helpers.ts';

for (const flag of [false, true]) {
  test(`minimal EXIF is valid TIFF, Xiaomi flag ${flag}`, () => {
    assert.deepEqual(readExifSummary(makeExif(flag).subarray(4)), flag ? { orientation: 1, xiaomiFlag: 1 } : { orientation: 1 });
  });
}

test('APP1 length uses UTF-8 bytes and rejects overflow', () => {
  const data = Buffer.from('中文'); const packed = app1(data);
  assert.equal(packed.readUInt16BE(2), data.length + 2);
  assert.throws(() => app1(Buffer.alloc(65534)), /limit/);
});

test('JPEG marker walk ignores fake EOI/ftyp in metadata and stuffed entropy', async () => {
  const temp = await tempFiles();
  try {
    const image = structuralJpeg([segment(0xfe, Buffer.from([0xff, 0xd9, ...Buffer.from('ftyp')]))]);
    const path = temp.file('test.jpg'); await writeFile(path, Buffer.concat([image, structuralMp4()]));
    const file = await open(path, 'r');
    try {
      const info = await inspectJpeg(file, image.length + structuralMp4().length);
      assert.equal(info.end, image.length); assert.equal(info.width, 2);
    } finally { await file.close(); }
  } finally { await temp.cleanup(); }
});

test('JPEG entropy marker split at chunk boundary and progressive scans', async () => {
  const temp = await tempFiles();
  try {
    const entropy = Buffer.concat([Buffer.alloc(65535, 1), Buffer.from([0xff, 0x00, 2, 0xff, 0xd1]),
      segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), Buffer.from([1, 2])]);
    const image = structuralJpeg([], entropy);
    const path = temp.file('progressive.jpg'); await writeFile(path, image);
    const file = await open(path, 'r');
    try { assert.equal((await inspectJpeg(file, image.length)).end, image.length); }
    finally { await file.close(); }
  } finally { await temp.cleanup(); }
});

test('reject truncated JPEG and malicious segment length', async () => {
  const temp = await tempFiles();
  try {
    for (const image of [structuralJpeg().subarray(0, -2), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0])]) {
      const path = temp.file('bad.jpg'); await writeFile(path, image);
      const file = await open(path, 'r');
      try { await assert.rejects(inspectJpeg(file, image.length)); }
      finally { await file.close(); }
    }
  } finally { await temp.cleanup(); }
});

for (const profile of PROFILES) {
  test(`streamed mux round-trip ${profile.id}; source unchanged; no private EXIF leakage`, async () => {
    const temp = await tempFiles();
    try {
      const staleXmp = app1(Buffer.concat([XMP_HEADER, Buffer.from(buildXmp(PROFILES[1], 20, 5))]));
      const inputs = await structuralInputs(temp, [makeExif(true), staleXmp, segment(0xe2, Buffer.from('MPF\0bogus')), segment(0xfe, Buffer.from('GPS private'))]);
      const before = await sha256(inputs.cover);
      const output = temp.file('motion.jpg');
      const report = await muxMotion({ ...inputs, output, profileId: profile.id, timestampUs: 0 });
      assert.equal(report.metadata.legacy, profile.legacy);
      assert.equal(report.metadata.timestampUs, 0);
      assert.equal(report.exif[0]?.xiaomiFlag, profile.xiaomiFlag ? 1 : undefined);
      assert.equal(report.unexplainedGap, 0);
      assert.equal(await sha256(inputs.cover), before);
      assert.equal(await sha256(output, report.videoStart, report.videoEnd), await sha256(inputs.video));
      assert.equal((await readFile(output)).includes(Buffer.from('GPS private')), false);
      await validateMotion(output, true);
    } finally { await temp.cleanup(); }
  });
}

test('no clobber, no input overwrite, cancellation, staging cleaned', async () => {
  const temp = await tempFiles();
  try {
    const inputs = await structuralInputs(temp);
    const hash = await sha256(inputs.cover);
    await assert.rejects(muxMotion({ ...inputs, output: inputs.cover, profileId: 'A-modern', timestampUs: 0 }), /EEXIST/);
    assert.equal(await sha256(inputs.cover), hash);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(muxMotion({ ...inputs, output: temp.file('cancel.jpg'), profileId: 'A-modern', timestampUs: 0, signal: abort.signal }));
    assert.deepEqual((await readdir(temp.directory)).sort(), ['cover.jpg', 'video.mp4']);
  } finally { await temp.cleanup(); }
});

test('validator rejects video-length mismatch and trailing garbage', async () => {
  const temp = await tempFiles();
  try {
    const inputs = await structuralInputs(temp);
    const output = temp.file('motion.jpg');
    await muxMotion({ ...inputs, output, profileId: 'A-modern', timestampUs: 0 });
    const data = await readFile(output);
    await writeFile(output, Buffer.concat([data, Buffer.from('garbage')]));
    await assert.rejects(validateMotion(output));
  } finally { await temp.cleanup(); }
});

test('mux refuses an unnormalized EXIF orientation instead of silently changing the display', async () => {
  const temp = await tempFiles();
  try {
    const rotatedExif = makeExif(false);
    rotatedExif.writeUInt16LE(6, 4 + 6 + 18);
    const inputs = await structuralInputs(temp, [rotatedExif]);
    await assert.rejects(muxMotion({ ...inputs, output: temp.file('rotated.jpg'), profileId: 'A-modern', timestampUs: 0 }), /normalized/);
  } finally { await temp.cleanup(); }
});

test('64-bit MP4 box walking is bounded and does not wrap at 4 GiB', async () => {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
  const moov = box('moov');
  const hugeSize = 2 ** 32 + 16;
  const header = Buffer.alloc(16); header.writeUInt32BE(1); header.write('mdat', 4); header.writeBigUInt64BE(BigInt(hugeSize), 8);
  const chunks = new Map([[0, ftyp], [ftyp.length, moov], [ftyp.length + moov.length, header]]);
  let bytes = 0;
  const fake = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
    for (const [start, data] of chunks) {
      if (position >= start && position + length <= start + data.length) {
        data.copy(buffer, offset, position - start, position - start + length); bytes += length;
        return { bytesRead: length, buffer };
      }
    }
    throw new Error('Unexpected large payload read');
  } } as unknown as FileHandle;
  const boxes = await inspectMp4(fake, 0, ftyp.length + moov.length + hugeSize);
  assert.equal(boxes[2]?.size, hugeSize);
  assert.ok(bytes <= 32);
});
