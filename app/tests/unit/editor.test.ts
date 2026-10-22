import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { parseTime, formatTime, secondsToUs, usToSeconds, ptsToUs, cropToPixels, validateClip, validateExportSettings } from '../../src/shared/editor.ts';
import { parseRange } from '../../src/main/media/range.ts';
import { MediaResources } from '../../src/main/media/resources.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { tempFiles } from '../helpers.ts';

test('millisecond UI and rational frame time do not wrap after one hour or at 32 bits', () => {
  assert.equal(parseTime('125:45:12.345'), 452712345000);
  assert.equal(formatTime(452712345000), '125:45:12.345');
  assert.equal(usToSeconds(secondsToUs('-12345.000001')), '-12345.000001');
  assert.equal(ptsToUs('8704', '0', { numerator: 1, denominator: 15360 }), 566666);
  assert.throws(() => parseTime('00:60:00.000'));
  assert.throws(() => secondsToUs('NaN'));
  assert.throws(() => validateClip({ startUs: 100, endUs: 100 }, 200));
  assert.deepEqual(validateClip({ startUs: 0, endUs: 10 ** 12 }, 10 ** 12), { startUs: 0, endUs: 10 ** 12 });
});

test('crop maps normalized display geometry to explicit even output pixels', () => {
  assert.deepEqual(cropToPixels({ x: .25, y: .1, width: .5, height: .75 }, 1919, 1079), { x: 478, y: 106, width: 958, height: 808 });
  assert.deepEqual(cropToPixels({ x: 0, y: 0, width: 1, height: 1 }, 1080, 1440), { x: 0, y: 0, width: 1080, height: 1440 });
  assert.throws(() => cropToPixels({ x: 0, y: 0, width: 2, height: 1 }, 1080, 1440));
  assert.throws(() => cropToPixels({ x: NaN, y: 0, width: 1, height: 1 }, 1080, 1440));
  assert.equal(validateExportSettings({ fps: null, resolution: 'original', crf: 23 }).fps, null);
  assert.throws(() => validateExportSettings({ fps: 0, resolution: 1080, crf: 23 }));
});

test('single byte ranges support suffix/open-ended and files above 4 GiB', () => {
  assert.deepEqual(parseRange('bytes=4294967296-', 2 ** 33), { start: 4294967296, end: 2 ** 33 - 1, partial: true });
  assert.deepEqual(parseRange('bytes=-3', 100), { start: 97, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99, partial: true });
  for (const header of ['bytes=100-', 'bytes=-0', 'bytes=3-2', 'bytes=1-2,4-5', 'bytes=999999999999999999-', 'bytes=-']) {
    assert.throws(() => parseRange(header, 100));
  }
});

test('media URLs only read registered unchanged files, obey ranges and revoke access', async () => {
  const temp = await tempFiles(); const resources = new MediaResources();
  try {
    const path = temp.file('private name.mp4'); await writeFile(path, '0123456789');
    const asset = await resources.register(path, 'video/mp4');
    assert.equal(asset.url.includes('private'), false);
    const request = new Request(asset.url, { headers: { Range: 'bytes=3-5', Origin: 'app://ui' } });
    const response = await resources.respond(request, 'app://ui');
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 3-5/10');
    assert.equal(await response.text(), '345');
    const head = await resources.respond(new Request(asset.url, { method: 'HEAD' }), 'app://ui');
    assert.equal(head.headers.get('Content-Length'), '10'); assert.equal(await head.text(), '');
    assert.equal((await resources.respond(new Request(asset.url, { headers: { Origin: 'https://example.com' } }), 'app://ui')).status, 403);
    assert.equal((await resources.respond(new Request(asset.url, { headers: { Range: 'bytes=99-' } }), 'app://ui')).status, 416);
    await writeFile(path, 'changed-size');
    assert.equal((await resources.respond(new Request(asset.url), 'app://ui')).status, 409);
    resources.revoke(asset.id);
    assert.equal((await resources.respond(new Request(asset.url), 'app://ui')).status, 404);
    assert.equal((await readFile(path, 'utf8')), 'changed-size');
  } finally { resources.dispose(); await temp.cleanup(); }
});

test('display dimensions account for rotation/SAR and incompatible codecs require proxies', () => {
  const base = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240,
    pix_fmt: 'yuv420p', time_base: '1/15360', start_pts: 0, duration_ts: 30720, avg_frame_rate: '30/1', sample_aspect_ratio: '1:1' }],
    format: { duration: '2.000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } };
  const normal = mediaInfo(base);
  assert.equal(normal.originalPreviewMime, 'video/mp4'); assert.equal(normal.durationUs, 2000000);
  const rotated = mediaInfo({ ...base, streams: [{ ...base.streams[0]!, side_data_list: [{ rotation: -90 }] }] });
  assert.equal(rotated.displayWidth, 240); assert.equal(rotated.displayHeight, 320);
  const hevc = mediaInfo({ ...base, streams: [{ ...base.streams[0]!, codec_name: 'hevc' }] });
  assert.equal(hevc.originalPreviewMime, null);
  const hdr = mediaInfo({ ...base, streams: [{ ...base.streams[0]!, color_transfer: 'smpte2084' }] });
  assert.equal(hdr.hdr, true); assert.equal(hdr.originalPreviewMime, null);
});
