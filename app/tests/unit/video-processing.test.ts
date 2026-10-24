import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaInfo } from '../../src/main/media/info.ts';
import { MOTION_VIDEO_TRANSFER, videoProcessing } from '../../src/main/media/video-processing.ts';
import type { Stream } from '../../src/main/media/probe.ts';
const video: Stream = { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p',
  time_base: '1/30', start_pts: 0, duration_ts: 90, color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' };
const edits = { crop: { x: 0, y: 0, width: 1, height: 1 }, settings: { fps: 30, resolution: 720 as const, crf: 23 } };
const info = (stream: Stream) => mediaInfo({ streams: [stream], format: {} });
test('normal processing really converts colors and geometry, removes stale side data and outputs limited-range 8-bit SDR', () => {
  const result = videoProcessing(info(video), video, edits, false);
  assert.deepEqual([result.geometry.width, result.geometry.height], [720, 406]);
  assert.match(result.filters.join(','), /zscale=.*pin=bt709.*p=bt709:t=bt709:m=bt709:r=tv/);
  assert.ok(result.filters.includes('sidedata=mode=delete')); assert.ok(result.filters.includes('format=yuv420p'));
  assert.equal(result.warnings.length, 0);
});
test('motion sRGB conversion occurs before quantization without changing the canonical cover intermediate', () => {
  const canonical = videoProcessing(info(video), video, edits, false);
  assert.equal(canonical.filters.at(-1), 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  const motion = videoProcessing(info(video), video, edits, false, MOTION_VIDEO_TRANSFER);
  const conversion = motion.filters.findIndex(filter => filter.startsWith('zscale=pin=bt709:tin=bt709:') && filter.includes(':t=iec61966-2-1:'));
  assert.ok(conversion >= 0 && conversion < motion.filters.indexOf('format=yuv420p'));
  assert.equal(motion.filters.at(-1), 'setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709');
  assert.deepEqual(motion.geometry, canonical.geometry);
});
test('HDR requires consent; unknown/wide/alpha inputs are not relabeled into a claimed SDR conversion', () => {
  const hdr = { ...video, color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc' };
  assert.throws(() => videoProcessing(info(hdr), hdr, edits, false), { code: 'HDR_CONFIRM_REQUIRED' });
  assert.match(videoProcessing(info(hdr), hdr, edits, true).filters.join(','), /tonemap=tonemap=hable/);
  assert.throws(() => videoProcessing(info(hdr), { ...hdr, color_transfer: 'unknown' }, edits, true), /缺少传递函数/);
  assert.throws(() => videoProcessing(info(video), { ...video, color_transfer: 'injected,filter' }, edits, false), /尚未验证/);
  assert.throws(() => videoProcessing(info(video), { ...video, pix_fmt: 'yuva420p' }, edits, false), /透明/);
  const unknown = { ...video, color_primaries: undefined, color_transfer: undefined, color_space: undefined, color_range: undefined };
  assert.equal(videoProcessing(info(unknown), unknown, edits, false).warnings.length, 4);
});
