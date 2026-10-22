import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempFiles } from '../helpers.ts';
import { ffmpeg, ffprobe, runProcess } from '../../src/main/media/runner.ts';
import { openSource } from '../../src/main/media/source.ts';
import { assessCopySupport, probeCopySource } from '../../src/main/media/copy-support.ts';

test('native copy inspection obtains real AVC/AAC configuration hashes and rotation metadata', async () => {
  const temp = await tempFiles();
  try {
    const input = temp.file('source.mp4'); const rotated = temp.file('rotated.mov');
    await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const source = await openSource(input); const metadata = await probeCopySource(source, ffprobe());
    const supported = assessCopySupport(metadata, true);
    assert.equal(supported.supported, true, JSON.stringify(supported));
    if (!supported.supported) throw new Error('expected compatible fixture');
    assert.equal(supported.video.nalLengthBytes, 4); assert.equal(supported.audio?.sampleRate, 48000);
    assert.equal(supported.audio?.channels, 1);
    await runProcess(ffmpeg(), ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-display_rotation:v:0', '90', '-i', input, '-c', 'copy', rotated]);
    const rotatedMetadata = await probeCopySource(await openSource(rotated), ffprobe());
    const rotatedSupport = assessCopySupport(rotatedMetadata, true);
    assert.equal(rotatedSupport.supported, true, JSON.stringify(rotatedSupport));
    if (rotatedSupport.supported) {
      assert.notEqual(rotatedSupport.videoSignature, supported.videoSignature);
      assert.equal(rotatedSupport.audioSignature, supported.audioSignature);
    }
    assert.equal(rotatedMetadata.streams.find(s => s.codec_type === 'video')?.side_data_list?.some(s => Math.abs(s.rotation ?? 0) === 90), true);
  } finally { await temp.cleanup(); }
});
