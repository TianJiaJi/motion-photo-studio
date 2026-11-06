import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullMediaScanMarkers, assertNoFullMediaScan, type MediaActivity } from '../media-activity.ts';

function activity(spawns: MediaActivity['spawns'], native: MediaActivity['native']): MediaActivity {
  return { spawns, native };
}

test('whole-file scan markers flag ffprobe frame enumeration, transcodes and unbounded native scans', () => {
  const strict = activity(
    [{ executable: 'C:\\bin\\ffprobe.exe', args: ['-v', 'error', '-show_frames', 'clip.mp4'] },
      { executable: 'C:\\bin\\ffprobe.exe', args: ['-v', 'error', '-show_entries', 'frame=pts,nb_samples', 'clip.mp4'] },
      { executable: 'C:\\bin\\ffmpeg.exe', args: ['-i', 'clip.mp4', '-c:v', 'libx264', 'proxy.mp4'] },
      { executable: 'C:\\bin\\ffprobe.exe', args: ['-v', 'error', '-show_streams', 'clip.mp4'] }],
    [{ command: 'resetScan', request: { command: 'resetScan' } },
      { command: 'audioScanOpen', request: { command: 'audioScanOpen' } }]);
  const markers = fullMediaScanMarkers(strict);
  assert.ok(markers.some(marker => marker.includes('ffprobe 全片帧枚举')));
  assert.ok(markers.some(marker => marker.includes('ffmpeg 整片转码')));
  assert.equal(markers.length, 3, 'both frame enumerations and the transcode are flagged');
  assert.throws(() => assertNoFullMediaScan(strict, '严格路径基线'), /不应执行全片扫描/);
});

test('bounded neighborhood work raises no whole-file markers', () => {
  const quick = activity(
    [{ executable: 'C:\\bin\\ffprobe.exe', args: ['-v', 'error', '-show_streams', 'clip.mp4'] },
      { executable: 'C:\\bin\\ffmpeg.exe', args: ['-i', 'clip.mp4', '-frames:v', '64', '-f', 'framehash', '-'] },
      { executable: 'C:\\bin\\ffmpeg.exe', args: ['-i', 'clip.mp4', '-c:a', 'pcm_s16le', '-f', 'framehash', '-'] }],
    [{ command: 'seek', request: { command: 'seek', timeUs: 1000000 } },
      { command: 'read', request: { command: 'read' } },
      { command: 'resetScan', request: { command: 'resetScan' } },
      { command: 'scanFrames', request: { command: 'scanFrames', count: 128 } },
      { command: 'audioScanOpen', request: { command: 'audioScanOpen' } },
      { command: 'audioScan', request: { command: 'audioScan', count: 128 } }]);
  assert.deepEqual(fullMediaScanMarkers(quick), []);
  assertNoFullMediaScan(quick, '快路径');
});

test('accumulated native scan blocks above the window budget are flagged', () => {
  const native: MediaActivity['native'] = [];
  for (let i = 0; i < 40; i++) native.push({ command: 'scanFrames', request: { command: 'scanFrames', count: 128 } });
  const markers = fullMediaScanMarkers(activity([], native));
  assert.equal(markers.length, 1);
  assert.match(markers[0]!, /原生视频样本扫描 5120 帧/);
});
