import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePresentedFrame, requestedFramePts } from '../../src/main/media/encode-plan.ts';
import { mediaInfo } from '../../src/main/media/info.ts';

test('decoded frame boundaries keep integer ticks, use native presentation timestamps and reject malformed reports', () => {
  const hash = 'ab'.repeat(32);
  assert.deepEqual(parsePresentedFrame(`0, 9007199254740993, 9007199254740993, 3003, 424, ${hash}`, 0),
    { pts: 9007199254740993n, duration: 3003n });
  assert.deepEqual(parsePresentedFrame(`0, -10, -10, 5, 424, ${hash}`, 0), { pts: -10n, duration: 5n });
  assert.equal(parsePresentedFrame('#codec_id 0: wrapped_avframe', 0), null);
  assert.throws(() => parsePresentedFrame(`0, 0, 0, 1, 424, ${hash}, extra`, 0), /report/);
  assert.throws(() => parsePresentedFrame(`1, 0, 0, 1, 424, ${hash}`, 0), /report/);
  assert.throws(() => parsePresentedFrame(`0, 0, N/A, 1, 424, ${hash}`, 0), /Missing/);
  assert.throws(() => parsePresentedFrame(`0, 9223372036854775808, 9223372036854775808, 1, 424, ${hash}`, 0), /64 bits/);
  assert.equal(requestedFramePts({ startPts: '450000', timeBase: { numerator: 1, denominator: 90000 } }, 1000001), 540001n);
});
test('embedded still images do not replace the main video when deriving editing geometry', () => {
  const info = mediaInfo({ format: { format_name: 'mov,mp4' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 32, height: 32, disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', codec_name: 'h264', width: 160, height: 120, pix_fmt: 'yuv420p',
      time_base: '1/30', start_pts: 0, duration_ts: 180 },
  ] });
  assert.equal(info.videoIndex, 1); assert.equal(info.displayWidth, 160); assert.equal(info.durationUs, 6000000);
});
