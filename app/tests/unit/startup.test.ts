import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupMessage } from '../../src/shared/startup.ts';
import { parseNativeControl } from '../../src/main/media/native-requests.ts';
test('startup reports real verification phases without fictional percentage or timeout guarantees', () => {
  assert.match(startupMessage(), /读取本地引擎清单/);
  assert.match(startupMessage({ stage: 'integrity', binary: 'ffmpeg.exe', index: 1, total: 2 }), /校验 ffmpeg\.exe.*1\/2/);
  assert.match(startupMessage({ stage: 'version', binary: 'ffprobe.exe', index: 2, total: 2 }), /是否可运行.*2\/2/);
});
test('native preview accepts bounded controls, not legacy proxy requests or caller-supplied paths', () => {
  const request = { assetId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', epoch: 1, action: 'seek', timeUs: 3000000, boundary: 'after', maximumEdge: 640, final: false };
  assert.deepEqual(parseNativeControl([request]), request);
  for (const extra of [{ prefetch: true }, { forceProxy: true }, { output: 'C:\\user.mp4' }, { command: 'ffmpeg.exe' }])
    assert.throws(() => parseNativeControl([{ ...request, ...extra }]), { code: 'INVALID_REQUEST' });
});
