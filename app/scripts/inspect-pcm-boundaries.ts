// Fixed synthetic experiment: PCM copying vs sample-preserving trimming. Never reads user media.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/main/media/runner.ts';
import { scanPackets } from '../src/main/media/packets.ts';
const directory = await mkdtemp(join(tmpdir(), 'pcm-boundary-'));
const ffmpeg = resolve('resources/bin/ffmpeg.exe'); const ffprobe = resolve('resources/bin/ffprobe.exe');
const ff = (args: string[]) => runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-n', ...args]);
try {
  const source = join(directory, 'source.mp4'); const copied = join(directory, 'copy.mp4'); const trimmed = join(directory, 'trim.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=60:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=44100:duration=4',
    '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-x265-params', 'log-level=error:pools=1:frame-threads=1:keyint=60:min-keyint=60:scenecut=0:open-gop=0', '-tag:v', 'hvc1', '-c:a', 'pcm_s16le', '-ac', '2', source]);
  await ff(['-copyts', '-seek_timestamp', '1', '-ss', '1', '-noaccurate_seek', '-i', source, '-map', '0:v', '-map', '0:a', '-c', 'copy', '-to', '2',
    '-output_ts_offset', '-1', '-avoid_negative_ts', 'disabled', '-use_editlist', '1', copied]);
  await ff(['-i', source, '-map', '0:a', '-af', 'atrim=start_sample=44100:end_sample=88200,asetpts=PTS-STARTPTS', '-c:a', 'pcm_s16le', trimmed]);
  const originalRaw = join(directory, 'source.raw'); await ff(['-i', source, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 's16le', originalRaw]);
  const reference = (await readFile(originalRaw)).subarray(44100 * 4, 88200 * 4);
  for (const [name, path] of [['copy', copied], ['trim', trimmed]]) {
    const raw = join(directory, `${name}.raw`); await ff(['-i', path!, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 's16le', raw]);
    const actual = await readFile(raw); let first: unknown; let last: unknown; let count = 0;
    await scanPackets({ input: path!, executable: ffprobe, onPacket: packet => { if (packet.streamIndex !== (name === 'copy' ? 1 : 0)) return; first ??= packet; last = packet; count++; } });
    console.log(JSON.stringify({ name, bytes: actual.length, expectedBytes: reference.length, exactSelectedSamples: actual.equals(reference),
      first, last, packets: count }, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2));
  }
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
