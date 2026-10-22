import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { openSource } from '../../src/main/media/source.ts';
import { createJpegCover } from '../../src/main/media/image-cover.ts';
import { sha256 } from '../../src/main/motion/io.ts';
const signal = () => new AbortController().signal;
async function rgb(path: string, x: number, y: number) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
}
function near(actual: number[], expected: number[], tolerance = 4) {
  assert.equal(actual.length, 3); actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) <= tolerance, `${actual} != ${expected}`));
}
function chunk(name: string, bytes: Buffer) {
  const data = Buffer.concat([Buffer.from(name), bytes]); const prefix = Buffer.alloc(4); const crc = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(data)); return Buffer.concat([prefix, data, crc]);
}
test('JPEG covers explicitly flatten alpha and contain/cover without distortion or input mutation', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('alpha.png');
    await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(input);
    const source = await openSource(input); const before = await sha256(input);
    const contain = await createJpegCover({ source, output: temp.file('contain.jpg'), width: 100, height: 100, fit: 'contain', background: '#0000ff', signal: signal() });
    near(await rgb(contain.file.path, 50, 5), [0, 0, 255]); near(await rgb(contain.file.path, 50, 50), [128, 0, 127]);
    assert.equal(contain.report.alphaFlattened, true); assert.equal(contain.report.upscaled, true);
    assert.equal((await sharp(contain.file.path).metadata()).hasAlpha, false);
    const cover = await createJpegCover({ source, output: temp.file('cover.jpg'), width: 100, height: 100, fit: 'cover', background: '#ffffff', signal: signal() });
    near(await rgb(cover.file.path, 50, 5), [255, 127, 127]);
    assert.equal(await sha256(input), before);
  } finally { await temp.cleanup(); }
});
test('EXIF mirrored orientation is normalized and old metadata is stripped, not inherited', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('mirrored.jpg');
    const raw = Buffer.alloc(80 * 40 * 3);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) { const p = (y * 80 + x) * 3; raw[p + (x < 40 ? 0 : 2)] = 255; }
    await sharp(raw, { raw: { width: 80, height: 40, channels: 3 } }).withMetadata({ orientation: 2 })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">private-test-marker</x:xmpmeta>').jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(input);
    const result = await createJpegCover({ source: await openSource(input), output: temp.file('normal.jpg'), width: 80, height: 40, fit: 'contain', background: '#000000', signal: signal() });
    near(await rgb(result.file.path, 10, 20), [0, 0, 255]); near(await rgb(result.file.path, 70, 20), [255, 0, 0]);
    const meta = await sharp(result.file.path).metadata(); assert.equal(meta.exif, undefined); assert.equal(meta.xmp, undefined); assert.ok(meta.icc);
    assert.deepEqual([result.report.width, result.report.height], [80, 40]);
  } finally { await temp.cleanup(); }
});
test('embedded Display P3 pixels are transformed to sRGB, checked against independent linear matrix math', async () => {
  const temp = await tempFiles();
  try {
    const profiled = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#805028' } }).withIccProfile('p3').png().toBuffer();
    const icc = (await sharp(profiled).metadata()).icc!; assert.ok(icc.length > 128);
    // Construct a fixed RGB PNG with untransformed P3 sample values and the known built-in P3 profile.
    const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.alloc(16 * (1 + 16 * 3));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) Buffer.from([128, 80, 40]).copy(rows, y * 49 + 1 + x * 3);
    const input = temp.file('p3.png');
    await writeFile(input, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
      chunk('iCCP', Buffer.concat([Buffer.from('Display P3\0\0'), deflateSync(icc)])), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
    const result = await createJpegCover({ source: await openSource(input), output: temp.file('srgb.jpg'), width: 16, height: 16,
      fit: 'cover', background: '#000000', signal: signal() });
    const decode = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    const linear = [128, 80, 40].map(v => decode(v / 255));
    const matrix = [[1.224745, -.224904, 0], [-.042058, 1.042081, 0], [-.019642, -.078655, 1.098537]];
    const reference = matrix.map(row => {
      const v = Math.max(0, Math.min(1, row.reduce((sum, c, i) => sum + c * linear[i]!, 0)));
      return Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
    });
    const actual = await rgb(result.file.path, 8, 8); near(actual, reference, 3);
    assert.ok(Math.abs(actual[0]! - 128) > 5, 'profile-label-only path must not pass'); assert.equal(result.report.iccConverted, true);
  } finally { await temp.cleanup(); }
});
test('image drafts protect existing files and clean up on cancellation, corruption and source mutation', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('image.png'); await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ffffff' } }).png().toFile(input);
    const source = await openSource(input); const output = temp.file('existing.jpg'); await writeFile(output, 'sentinel');
    const options = { source, output, width: 40, height: 20, fit: 'cover' as const, background: '#000000', signal: signal() };
    await assert.rejects(createJpegCover(options), { code: 'EEXIST' }); assert.equal(await readFile(output, 'utf8'), 'sentinel');
    await assert.rejects(createJpegCover({ ...options, output: input }), /overwrite/);
    const cancelled = temp.file('cancelled.jpg'); const controller = new AbortController();
    await assert.rejects(createJpegCover({ ...options, output: cancelled, signal: controller.signal, onStage: () => controller.abort() }));
    await assert.rejects(access(cancelled), { code: 'ENOENT' });
    const broken = temp.file('broken.png'); await writeFile(broken, 'not-a-PNG'); const brokenOutput = temp.file('broken.jpg');
    await assert.rejects(createJpegCover({ ...options, source: await openSource(broken), output: brokenOutput }));
    await assert.rejects(access(brokenOutput), { code: 'ENOENT' });
    const changed = temp.file('changed.jpg');
    await assert.rejects(createJpegCover({ ...options, output: changed, onStage: () => writeFile(input, 'replaced') }), { code: 'SOURCE_CHANGED' });
    await assert.rejects(access(changed), { code: 'ENOENT' });
  } finally { await temp.cleanup(); }
});
