import { randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { app1, inspectJpeg, makeExif, readExifSummary, XMP_HEADER } from './jpeg.ts';
import { inspectMp4 } from './mp4.ts';
import { buildXmp } from './xmp.ts';
import { copyRange, fromBigInt, writeAll } from './io.ts';
import { getProfile } from './profiles.ts';
import { validateMotion } from './validate.ts';

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
    && before.ino === after.ino && before.dev === after.dev;
}

export async function muxMotion(options: {
  cover: string; video: string; output: string; profileId: string; timestampUs: number; signal?: AbortSignal;
  onProgress?: (writtenBytes: number, totalBytes: number) => void | Promise<void>;
}) {
  const { signal } = options;
  const profile = getProfile(options.profileId);
  signal?.throwIfAborted();
  const cover = await open(options.cover, 'r');
  try {
    const video = await open(options.video, 'r');
    try {
      const coverBefore = await cover.stat({ bigint: true });
      const videoBefore = await video.stat({ bigint: true });
      if (!coverBefore.isFile() || !videoBefore.isFile()) throw new Error('Inputs must be regular files');
      const jpeg = await inspectJpeg(cover, fromBigInt(coverBefore.size, 'cover size'), signal);
      if (jpeg.exif.some(payload => {
        const orientation = readExifSummary(payload).orientation;
        return orientation !== undefined && orientation !== 1;
      })) throw new Error('Cover orientation must be normalized before muxing');
      const videoLength = fromBigInt(videoBefore.size, 'video size');
      await inspectMp4(video, 0, videoLength);
      const metadata = app1(Buffer.concat([XMP_HEADER, Buffer.from(buildXmp(profile, videoLength, options.timestampUs))]));
      const exif = makeExif(profile.xiaomiFlag);
      const totalBytes = jpeg.end + exif.length + metadata.length + videoLength - jpeg.stripRanges.reduce((n, range) => n + range.end - range.start, 0);
      if (!Number.isSafeInteger(totalBytes)) throw new Error('Output exceeds safe file addressing');
      const progress = options.onProgress ? (writtenBytes: number) => options.onProgress!(writtenBytes, totalBytes) : undefined;
      const staging = join(dirname(options.output), `.${basename(options.output)}.${randomUUID()}.tmp`);
      const target = await open(staging, 'wx');
      try {
        try {
          let at = await writeAll(target, Buffer.from([0xff, 0xd8]), 0);
          at = await writeAll(target, exif, at);
          at = await writeAll(target, metadata, at);
          let sourceAt = 2;
          for (const range of jpeg.stripRanges) {
            at = await copyRange(cover, target, sourceAt, range.start, at, signal, progress);
            sourceAt = range.end;
          }
          at = await copyRange(cover, target, sourceAt, jpeg.end, at, signal, progress);
          await copyRange(video, target, 0, videoLength, at, signal, progress);
          if (!unchanged(coverBefore, await cover.stat({ bigint: true })) || !unchanged(videoBefore, await video.stat({ bigint: true }))) {
            throw new Error('Source changed during export');
          }
          await target.sync();
        } finally { await target.close(); }
        signal?.throwIfAborted();
        const report = await validateMotion(staging, true, signal);
        if (report.exif.length !== 1 || report.exif[0]!.orientation !== 1
          || report.exif[0]!.xiaomiFlag !== (profile.xiaomiFlag ? 1 : undefined)) throw new Error('EXIF read-back mismatch');
        signal?.throwIfAborted();
        // Atomic, no-clobber publication. link fails if output exists (including an input alias).
        // Staging is on the same volume; no rename-over-existing behavior on any OS.
        await link(staging, options.output);
        return report;
      } finally { await unlink(staging).catch(() => {}); }
    } finally { await video.close(); }
  } finally { await cover.close(); }
}
