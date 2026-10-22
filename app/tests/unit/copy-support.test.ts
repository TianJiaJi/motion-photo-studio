import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCopySupport, copyVideoSignature, copyAudioSignature, type CopyProbe } from '../../src/main/media/copy-support.ts';

function fixture(): CopyProbe {
  return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', codec_tag_string: 'avc1', profile: 'High', pix_fmt: 'yuv420p',
      width: 320, height: 240, time_base: '1/15360', start_pts: 0, duration_ts: 92160,
      is_avc: 'true', nal_length_size: '4', extradata_hash: 'SHA256:' + 'ab'.repeat(32), color_transfer: 'bt709' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', codec_tag_string: 'mp4a', profile: 'LC', channels: 2,
      sample_rate: '48000', channel_layout: 'stereo', time_base: '1/48000', start_pts: 0, duration_ts: 288000,
      extradata_hash: 'SHA256:' + 'cd'.repeat(32) },
  ] };
}
test('copy support explicitly separates retained stream policy from image processing', () => {
  const probe = fixture(); const before = structuredClone(probe); const supported = assessCopySupport(probe, true);
  assert.equal(supported.supported, true);
  if (!supported.supported) throw new Error('expected support');
  assert.equal(supported.video.endPts, '92160'); assert.equal(supported.audio?.sampleRate, 48000);
  assert.deepEqual(probe, before);
  const silent = assessCopySupport(probe, false); assert.equal(silent.supported, true);
  if (!silent.supported) throw new Error('expected support');
  assert.equal(silent.audio, null); assert.match(silent.warnings.join(' '), /明确选择不保留/);
});
test('unsupported container, HDR, codec/profile and incomplete timing cannot silently enter copy mode', () => {
  for (const patch of [
    { codec_name: 'hevc' }, { profile: 'High 10' }, { pix_fmt: 'yuv420p10le' },
    { color_transfer: 'smpte2084' }, { color_transfer: 'arib-std-b67' }, { color_primaries: 'bt2020' },
    { start_pts: Number.MAX_SAFE_INTEGER + 1 }, { duration_ts: 0 }, { time_base: '0/1' }, { nal_length_size: '3' }, { extradata_hash: undefined },
  ]) {
    const probe = fixture(); Object.assign(probe.streams[0]!, patch);
    const result = assessCopySupport(probe, true); assert.equal(result.supported, false, JSON.stringify(patch));
    if (!result.supported) assert.ok(result.reasons.length > 0);
  }
  const probe = fixture(); probe.format.format_name = 'matroska,webm';
  assert.equal(assessCopySupport(probe, true).supported, false);
  for (const patch of [{ time_base: '1/1000' }, { start_pts: undefined }, { duration_ts: 0 }]) {
    const invalidClock = fixture(); Object.assign(invalidClock.streams[1]!, patch);
    assert.equal(assessCopySupport(invalidClock, true).supported, false);
    assert.equal(assessCopySupport(invalidClock, false).supported, true);
  }
});
test('unsupported or multiple audio tracks require an explicit choice; attached pictures are not primary video', () => {
  const probe = fixture(); probe.streams[1]!.codec_name = 'ac3';
  assert.equal(assessCopySupport(probe, true).supported, false);
  assert.equal(assessCopySupport(probe, false).supported, true);
  const multiple = fixture(); multiple.streams.push({ ...multiple.streams[1]!, index: 2 });
  assert.equal(assessCopySupport(multiple, true).supported, false);
  assert.equal(assessCopySupport(multiple, false).supported, true);
  const attached = fixture(); attached.streams.unshift({ index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } });
  const result = assessCopySupport(attached, true); assert.equal(result.supported, true);
  if (result.supported) { assert.equal(result.video.index, 0); assert.match(result.warnings.join(' '), /内嵌静态封面/); }
});
test('copy stream signatures preserve decoder/geometry/color parameters but do not equate VFR averages to frame timing', () => {
  const probe = fixture(); const video = probe.streams[0]!; const audio = probe.streams[1]!;
  assert.equal(copyVideoSignature(video), copyVideoSignature({ ...video, avg_frame_rate: '15/1', r_frame_rate: '30/1' }));
  assert.notEqual(copyVideoSignature(video), copyVideoSignature({ ...video, color_primaries: 'bt2020' }));
  assert.notEqual(copyVideoSignature(video), copyVideoSignature({ ...video, extradata_hash: 'SHA256:' + 'cd'.repeat(32) }));
  assert.notEqual(copyAudioSignature(audio), copyAudioSignature({ ...audio, sample_rate: '44100' }));
});
