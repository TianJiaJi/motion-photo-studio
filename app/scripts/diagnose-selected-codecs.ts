// Explicitly selected local video: read-only codec metadata, never uploads media or dumps user tags.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyEngines } from '../src/main/media/engine.ts';
import { openSource, assertSource } from '../src/main/media/source.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { probeCopySource, assessCopySupport } from '../src/main/media/copy-support.ts';

const [argument] = process.argv.slice(2); if (!argument || process.argv.length !== 3) throw new Error('Pass the native selection receipt only');
const path = await realpath(argument); const directory = await realpath(resolve('../artifacts/m5/private-codec-diagnostics'));
if (dirname(path) !== directory) throw new Error('Selection must be in the ignored local diagnostics directory');
const selection = JSON.parse(await readFile(path, 'utf8')) as { canceled?: boolean; path?: unknown };
if (selection.canceled) { console.log('Selection cancelled. No media inspected.'); }
else {
  if (selection.canceled !== false || typeof selection.path !== 'string') throw new Error('Invalid native selection receipt');
  const engines = await verifyEngines(resolve('resources')); const source = await openSource(selection.path); const signal = new AbortController().signal;
  const probe = await probeMedia(source.path, { executable: engines.ffprobe, signal });
  const streams = probe.streams.map(stream => ({ index: stream.index, type: stream.codec_type, codec: stream.codec_name, tag: (stream as { codec_tag_string?: string }).codec_tag_string,
    profile: stream.profile, pixelFormat: stream.pix_fmt, width: stream.width, height: stream.height, timeBase: stream.time_base,
    frameRate: stream.avg_frame_rate, colorRange: stream.color_range, primaries: stream.color_primaries, transfer: stream.color_transfer,
    matrix: stream.color_space, channels: stream.channels, sampleRate: stream.sample_rate, attachedPicture: stream.disposition?.attached_pic ?? 0 }));
  const config = await probeCopySource(source, engines.ffprobe, signal);
  const strictAudioVideo = assessCopySupport(config, true); const videoOnly = assessCopySupport(config, false);
  await assertSource(source);
  const report = { status: 'metadata-read-only-no-media-modified-or-uploaded', name: basename(source.path), size: source.size,
    streams, strictAudioVideo: { supported: strictAudioVideo.supported, reasons: strictAudioVideo.supported ? [] : strictAudioVideo.reasons, warnings: strictAudioVideo.warnings },
    videoOnly: { supported: videoOnly.supported, reasons: videoOnly.supported ? [] : videoOnly.reasons, warnings: videoOnly.warnings },
    scope: 'Selected source metadata and current policy assessment only; not phone compatibility proof. User tags/location/embedded artwork not dumped.' };
  const output = join(directory, `codec-${randomUUID()}.json`); await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', flush: true });
  console.log(output); console.log(JSON.stringify(report, null, 2));
}
