import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tempFiles } from '../helpers.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
import { mediaInfo } from '../../src/main/media/info.ts';
import { openSource } from '../../src/main/media/source.ts';
import { buildFrameIndex } from '../../src/main/media/frame-index.ts';
import { prepareNativeMedia, type PreparedNativeMedia } from '../../src/main/media/native-import.ts';
import { planEncodeRange } from '../../src/main/media/encode-plan.ts';
import { exportEncodedMedia } from '../../src/main/media/encode-export.ts';
import { probeCopySource, assessCopySupport } from '../../src/main/media/copy-support.ts';
import { sha256 } from '../../src/main/motion/io.ts';

const ffmpeg = resolve('resources/bin/ffmpeg.exe'), ffprobe = resolve('resources/bin/ffprobe.exe');
test('MOV underreported media duration retains the final frame through import, seek and export', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const temp = await tempFiles(); let prepared: PreparedNativeMedia | undefined;
  try {
    const path = temp.file('short-mdhd.mov');
    await runProcess(ffmpeg, ['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=160x90:rate=60:duration=1',
      '-an','-frames:v','60','-fps_mode','passthrough','-c:v','libx264','-bf','2','-g','30','-pix_fmt','yuv420p','-video_track_timescale','15360',
      '-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv',path]);
    // Reproduce the real MOV's mismatch without committing private media: only the
    // generated fixture's mdhd duration is shortened; PTS, sample data and edit stay intact.
    const bytes = await readFile(path);
    const boxes = (start: number, end: number) => {
      const result: { type: string; body: number; end: number }[] = [];
      for (let at = start; at < end;) {
        const size = bytes.readUInt32BE(at); assert.ok(size >= 8 && size <= end - at);
        result.push({ type: bytes.toString('latin1', at + 4, at + 8), body: at + 8, end: at + size }); at += size;
      }
      return result;
    };
    const movie = boxes(0, bytes.length).find(box => box.type === 'moov')!;
    const track = boxes(movie.body, movie.end).find(box => box.type === 'trak')!;
    const media = boxes(track.body, track.end).find(box => box.type === 'mdia')!;
    const header = boxes(media.body, media.end).find(box => box.type === 'mdhd')!;
    assert.equal(bytes[header.body], 0); assert.equal(bytes.readUInt32BE(header.body + 12), 15360);
    assert.ok(bytes.readUInt32BE(header.body + 16) >= 15360, 'Decode duration may include B-frame delay');
    bytes.writeUInt32BE(15104, header.body + 16); await writeFile(path, bytes);
    const before = await sha256(path), source = await openSource(path);
    const raw = JSON.parse((await runProcess(ffprobe, ['-v','error','-show_streams','-show_format','-of','json',path])).stdout);
    assert.equal(raw.streams[0].duration_ts, 15104);
    await assert.rejects(buildFrameIndex({ source, info: mediaInfo(raw), executable: ffprobe,
      output: temp.file('old-index.bin'), signal: new AbortController().signal }), { code: 'FRAME_INDEX' });
    const probe = await probeMedia(path, { executable: ffprobe }), info = mediaInfo(probe);
    assert.equal(probe.streams[0]!.duration_ts, 15360); assert.equal(info.durationUs, 1000000);
    const copy = assessCopySupport(await probeCopySource(source, ffprobe), false);
    assert.equal(copy.supported, true); if (copy.supported) assert.equal(copy.video.endPts, '15360');
    const directory = temp.file('session'); await mkdir(directory);
    prepared = await prepareNativeMedia({ source, info, directory, ffprobe, ffmpeg,
      helper: resolve('resources/bin/motion-preview.exe'), signal: new AbortController().signal });
    assert.equal(prepared.index.count, 60); assert.equal(prepared.index.mappingReady, true);
    const last = await prepared.index.get(59); assert.equal(last.pts, '15104');
    const frame = await prepared.index.locate(prepared.native, 59);
    assert.ok(frame.pixels.length); assert.equal((await prepared.index.fromNative(frame.value.timestampHns)).pts, last.pts);
    const clip = { startUs: 0, endUs: info.durationUs };
    const plan = await planEncodeRange(source, probe, clip, { executable: ffmpeg });
    assert.equal(plan.lastPts, last.pts); assert.equal(plan.endPts, '15360');
    const output = temp.file('export.mp4');
    const exported = await exportEncodedMedia({ source, clip, output, coverSourcePts: last.pts,
      edits: { crop: { x: 0, y: 0, width: 1, height: 1 }, settings: { fps: null, resolution: 'original', crf: 18 } },
      audio: { kind: 'omit' }, hdrConsent: false, engines: { ffprobe, ffmpeg, build: 'test' }, signal: new AbortController().signal });
    assert.equal(exported.report.plan.lastPts, last.pts); assert.equal(exported.report.coverTimestampUs, last.timeUs);
    const count = JSON.parse((await runProcess(ffprobe, ['-v','error','-count_frames','-select_streams','v:0',
      '-show_entries','stream=nb_read_frames','-of','json',output])).stdout);
    assert.equal(Number(count.streams[0].nb_read_frames), 60);
    assert.equal(await sha256(path), before);
  } finally { await prepared?.native.shutdown(); await prepared?.index.close(); await temp.cleanup(); }
});
