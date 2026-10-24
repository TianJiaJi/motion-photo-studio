import type { FileHandle } from 'node:fs/promises';
import { fromBigInt, readExactly, safeInteger } from './io.ts';

export type Mp4Box = { type: string; offset: number; size: number };

// ISO BMFF top-level box walk; mdat is skipped, not loaded. Extended size is 64-bit.
export async function inspectMp4(file: FileHandle, start: number, length: number, options: { signal?: AbortSignal; maximumBoxes?: number } = {}): Promise<Mp4Box[]> {
  safeInteger(start, 'MP4 start'); safeInteger(length, 'MP4 length', 8);
  const maximumBoxes = options.maximumBoxes ?? 100000;
  safeInteger(maximumBoxes, 'MP4 box limit', 1);
  if (maximumBoxes > 100000) throw new Error('Excessive MP4 box limit');
  const end = safeInteger(start + length, 'MP4 end');
  const boxes: Mp4Box[] = [];
  let position = start;
  while (position < end) {
    options.signal?.throwIfAborted();
    if (boxes.length >= maximumBoxes) throw new Error('Excessive MP4 boxes');
    if (end - position < 8) throw new Error('Truncated MP4 box header');
    const header = await readExactly(file, position, 8);
    let size = header.readUInt32BE();
    const type = header.toString('ascii', 4, 8);
    let headerSize = 8;
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error('Invalid MP4 box type');
    if (size === 1) {
      if (end - position < 16) throw new Error('Truncated extended MP4 box header');
      size = fromBigInt((await readExactly(file, position + 8, 8)).readBigUInt64BE(), 'MP4 box size');
      headerSize = 16;
    } else if (size === 0) size = end - position;
    if (size < headerSize || size > end - position) throw new Error(`Invalid MP4 ${type} box extent`);
    if (!boxes.length && type !== 'ftyp') throw new Error('MP4 does not begin with ftyp box');
    if (type === 'ftyp') {
      if (boxes.length || size < headerSize + 8 || (size - headerSize) % 4) throw new Error('Invalid ftyp box');
    }
    boxes.push({ type, offset: position - start, size });
    position += size;
  }
  if (!boxes.some(box => box.type === 'moov') || !boxes.some(box => box.type === 'mdat')) {
    throw new Error('MP4 needs moov and mdat boxes');
  }
  return boxes;
}
