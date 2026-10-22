import { open } from 'node:fs/promises';
import { inspectJpeg, readExifSummary } from './jpeg.ts';
import { parseMotionXmp } from './xmp.ts';
import { inspectMp4 } from './mp4.ts';
import { fromBigInt } from './io.ts';

export async function validateMotion(path: string, strictGenerated = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const size = fromBigInt((await file.stat({ bigint: true })).size, 'file size');
    const jpeg = await inspectJpeg(file, size, signal);
    if (jpeg.xmp.length !== 1) throw new Error('Expected exactly one standard XMP packet');
    const metadata = parseMotionXmp(jpeg.xmp[0]!);
    const videoStart = size - metadata.videoPadding - metadata.videoLength;
    if (videoStart < jpeg.end || videoStart < metadata.primaryPadding) throw new Error('Video extent overlaps JPEG');
    const unexplainedGap = videoStart - metadata.primaryPadding - jpeg.end;
    if (unexplainedGap < 0) throw new Error('Primary padding overlaps JPEG');
    if (strictGenerated && (unexplainedGap !== 0 || metadata.primaryPadding !== 0 || metadata.videoPadding !== 0)) {
      throw new Error('Generated simple container must have no gap or padding');
    }
    signal?.throwIfAborted();
    const boxes = await inspectMp4(file, videoStart, metadata.videoLength);
    signal?.throwIfAborted();
    return {
      size, width: jpeg.width, height: jpeg.height, jpegEnd: jpeg.end,
      videoStart, videoEnd: videoStart + metadata.videoLength, unexplainedGap,
      metadata, exif: jpeg.exif.map(readExifSummary), boxes,
      warnings: unexplainedGap ? ['Bytes between first JPEG EOI and video; may contain auxiliary image/vendor payload. Not copied by the muxer.'] : [],
    };
  } finally { await file.close(); }
}
