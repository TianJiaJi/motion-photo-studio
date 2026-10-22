import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { inspectJpeg } from './jpeg.ts';
import { fromBigInt } from './io.ts';

// Compare all kept JPEG bytes, including compressed scans, ICC/JFIF/Adobe decoding markers and EOI.
// Only metadata that the muxer deliberately replaces/strips is excluded. No pixel buffers are built.
export async function canonicalJpegHash(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); const file = await open(path, 'r');
  try {
    const info = await inspectJpeg(file, fromBigInt((await file.stat({ bigint: true })).size, 'JPEG size'), signal);
    const hash = createHash('sha256'); const buffer = Buffer.alloc(65536);
    let position = 0;
    for (const range of [...info.stripRanges, { start: info.end, end: info.end }]) {
      while (position < range.start) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, range.start - position), position);
        if (!bytesRead) throw new Error('JPEG changed while hashing');
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      position = range.end;
    }
    signal?.throwIfAborted(); return hash.digest('hex');
  } finally { await file.close(); }
}
