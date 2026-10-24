// Bounded diagnostic fixture only (6 seconds); production packet inspection must be streaming.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../src/main/media/runner.ts';
import { verifyEngines } from '../src/main/media/engine.ts';

type Packet = { stream_index: number; pts: number; dts: number; duration: number; data_hash: string; side_data_list?: unknown[] };
const engines = await verifyEngines(resolve('resources'));
const directory = await mkdtemp(join(tmpdir(), 'motion-copy-experiment-'));
try {
  const input = join(directory, 'source.mp4');
  await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:bframes=3', '-c:a', 'aac', input]);
  const inspect = async (path: string) => {
    const { stdout } = await runProcess(engines.ffprobe, ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
      '-show_entries', 'packet=stream_index,pts,dts,duration,data_hash:packet_side_data:stream=index,codec_type,time_base,start_time,duration:format=start_time,duration', '-of', 'json', path]);
    return JSON.parse(stdout) as { packets: Packet[]; streams: unknown[]; format: unknown };
  };
  const source = await inspect(input);
  const video = source.packets.filter(p => p.stream_index === 0);
  const audio = source.packets.filter(p => p.stream_index === 1);
  const selected = video.filter(p => p.pts >= 2 * 15360 && p.pts < 4 * 15360);
  const inputOptions = ['-copyts', '-seek_timestamp', '1', '-ss', '2', '-noaccurate_seek', '-i', input];
  const variants = [
    { name: 'duration-only', input: ['-ss', '2', '-i', input], output: ['-t', '2'] },
    { name: 'count-shortest', input: inputOptions, output: ['-frames:v', String(selected.length), '-shortest', '-output_ts_offset', '-2', '-avoid_negative_ts', 'disabled'] },
    { name: 'count-absolute-end', input: inputOptions, output: ['-frames:v', String(selected.length), '-to', '4', '-output_ts_offset', '-2', '-avoid_negative_ts', 'disabled'] },
    { name: 'decode-end', input: inputOptions, output: ['-to', '3.933333', '-output_ts_offset', '-2', '-avoid_negative_ts', 'disabled'] },
    { name: 'packet-drop-duration', input: ['-ss', '2', '-i', input], output: ['-t', '2', '-bsf:v', `noise=amount=0:drop='gte(n,${selected.length})'`] },
    { name: 'packet-drop-absolute', input: inputOptions, output: ['-to', '4', '-bsf:v', `noise=amount=0:drop='gte(n,${selected.length})'`, '-output_ts_offset', '-2', '-avoid_negative_ts', 'disabled'] },
  ];
  for (const variant of variants) {
    const output = join(directory, `${variant.name}.mp4`);
    await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...variant.input,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', ...variant.output, '-movflags', '+faststart', output]);
    const result = await inspect(output);
    const v = result.packets.filter(p => p.stream_index === 0); const a = result.packets.filter(p => p.stream_index === 1);
    const firstAudio = audio.findIndex(p => p.data_hash === a[0]?.data_hash);
    let decode = 'passed';
    try { await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-i', output, '-f', 'null', '-']); }
    catch { decode = 'failed'; }
    console.log(JSON.stringify({ name: variant.name, videoPackets: v.length, expectedVideoPackets: selected.length,
      exactVideoPayloads: v.length === selected.length && v.every((p, i) => p.data_hash === selected[i]?.data_hash),
      audioPackets: a.length, exactContiguousAudioPayloads: firstAudio >= 0 && a.every((p, i) => p.data_hash === audio[firstAudio + i]?.data_hash),
      sourceAudioStartUs: firstAudio >= 0 ? audio[firstAudio]!.pts / 48000 * 1000000 : null,
      sourceAudioEndUs: firstAudio >= 0 ? (audio[firstAudio + a.length - 1]!.pts + audio[firstAudio + a.length - 1]!.duration) / 48000 * 1000000 : null,
      firstVideo: v[0], lastVideo: v.at(-1), firstAudio: a[0], lastAudio: a.at(-1), streams: result.streams, format: result.format, decode }, null, 2));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
