import type { FileHandle } from 'node:fs/promises';
import { readExactly } from './io.ts';

export const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii');
const ICC_HEADER = Buffer.from('ICC_PROFILE\0', 'ascii');
export type JpegSegment = { marker: number; start: number; end: number; payloadStart: number; payloadLength: number };
export type JpegInfo = {
  end: number; width: number; height: number; segments: JpegSegment[];
  xmp: string[]; exif: Buffer[]; stripRanges: { start: number; end: number }[];
};

// Follow JPEG segment lengths and entropy stuffing, including progressive multi-scan JPEG.
// The scan search is chunked: no full image read and no async operation per image byte.
async function nextScanMarker(file: FileHandle, from: number, fileSize: number, signal?: AbortSignal): Promise<number> {
  let position = from;
  while (position < fileSize) {
    signal?.throwIfAborted();
    const data = await readExactly(file, position, Math.min(64 * 1024, fileSize - position));
    let offset = 0;
    while (offset < data.length) {
      const ff = data.indexOf(0xff, offset);
      if (ff < 0) break;
      let next = ff + 1;
      while (next < data.length && data[next] === 0xff) next++;
      if (next === data.length) {
        // Handle a fill run crossing a buffer boundary without rereading forever.
        let absolute = position + next;
        while (absolute < fileSize) {
          signal?.throwIfAborted();
          const byte = (await readExactly(file, absolute, 1))[0]!;
          if (byte !== 0xff) {
            if (byte !== 0x00 && !(byte >= 0xd0 && byte <= 0xd7)) return absolute - 1;
            position = absolute + 1;
            break;
          }
          absolute++;
        }
        if (absolute >= fileSize) throw new Error('Unterminated JPEG scan');
        offset = -1;
        break;
      }
      const marker = data[next]!;
      if (marker !== 0x00 && !(marker >= 0xd0 && marker <= 0xd7)) return position + next - 1;
      offset = next + 1;
    }
    if (offset !== -1) position += data.length;
  }
  throw new Error('JPEG has no EOI');
}

export async function inspectJpeg(file: FileHandle, fileSize: number, signal?: AbortSignal): Promise<JpegInfo> {
  if (fileSize < 4 || !(await readExactly(file, 0, 2)).equals(Buffer.from([0xff, 0xd8]))) {
    throw new Error('Not a JPEG SOI');
  }
  const info: JpegInfo = { end: 0, width: 0, height: 0, segments: [], xmp: [], exif: [], stripRanges: [] };
  let position = 2;
  let sawScan = false;
  while (position < fileSize) {
    signal?.throwIfAborted();
    if (info.segments.length >= 10000) throw new Error('Excessive JPEG segments');
    const start = position;
    let markerBytes = await readExactly(file, position, 2);
    if (markerBytes[0] !== 0xff) throw new Error(`Expected JPEG marker at ${position}`);
    while (markerBytes[1] === 0xff) {
      position++;
      markerBytes = await readExactly(file, position, 2);
    }
    const marker = markerBytes[1]!;
    position += 2;
    if (marker === 0xd9) {
      if (!sawScan || !info.width || !info.height) throw new Error('JPEG missing frame or scan');
      info.end = position;
      return info;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error('Invalid marker outside JPEG entropy');
    }
    if (marker === 0x01) continue;
    const length = (await readExactly(file, position, 2)).readUInt16BE();
    if (length < 2 || position + length > fileSize) throw new Error('Invalid JPEG segment length');
    const segment = { marker, start, end: position + length, payloadStart: position + 2, payloadLength: length - 2 };
    info.segments.push(segment);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) throw new Error('Invalid JPEG SOF');
      const sof = await readExactly(file, position + 2, 5);
      info.height = sof.readUInt16BE(1);
      info.width = sof.readUInt16BE(3);
    }
    if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) {
      const data = await readExactly(file, segment.payloadStart, segment.payloadLength);
      if (marker === 0xe1 && data.subarray(0, XMP_HEADER.length).equals(XMP_HEADER)) {
        info.xmp.push(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(XMP_HEADER.length)).replace(/\0+$/, '').trim());
      }
      if (marker === 0xe1 && data.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) info.exif.push(data);
      // Preserve JFIF/Adobe decoding markers and ICC only. Drop EXIF/XMP/MPF/comments/vendor data.
      const keep = marker === 0xe0 || marker === 0xee || marker === 0xe2 && data.subarray(0, ICC_HEADER.length).equals(ICC_HEADER);
      if (!keep) info.stripRanges.push({ start, end: segment.end });
    }
    position = segment.end;
    if (marker === 0xda) {
      sawScan = true;
      position = await nextScanMarker(file, position, fileSize, signal);
    }
  }
  throw new Error('JPEG missing EOI');
}

export function app1(payload: Buffer): Buffer {
  if (payload.length + 2 > 65535) throw new Error('APP1 payload exceeds JPEG segment limit');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16BE(0xffe1);
  prefix.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([prefix, payload]);
}

// Minimal TIFF, not a copied vendor blob: Orientation=1 and optional ExifIFD BYTE 0x8897=1.
export function makeExif(xiaomiFlag: boolean): Buffer {
  const tiff = Buffer.alloc(xiaomiFlag ? 56 : 26);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(xiaomiFlag ? 2 : 1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(1, 18);
  if (xiaomiFlag) {
    tiff.writeUInt16LE(0x8769, 22); tiff.writeUInt16LE(4, 24);
    tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(38, 30);
    tiff.writeUInt16LE(1, 38);
    tiff.writeUInt16LE(0x8897, 40); tiff.writeUInt16LE(1, 42);
    tiff.writeUInt32LE(1, 44); tiff[48] = 1;
  }
  return app1(Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
}

export function readExifSummary(payload: Buffer): { make?: string; model?: string; orientation?: number; xiaomiFlag?: number } {
  const tiff = payload.subarray(6);
  if (tiff.length < 8) throw new Error('Truncated EXIF TIFF');
  const little = tiff.subarray(0, 2).toString() === 'II';
  if (!little && tiff.subarray(0, 2).toString() !== 'MM') throw new Error('Invalid TIFF endian');
  const u16 = (offset: number) => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const u32 = (offset: number) => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (u16(2) !== 42) throw new Error('Invalid TIFF magic');
  const result: ReturnType<typeof readExifSummary> = {};
  const seen = new Set<number>();
  const visit = (position: number, isExif: boolean) => {
    if (seen.has(position)) throw new Error('EXIF IFD cycle');
    seen.add(position);
    const count = u16(position);
    if (position + 2 + count * 12 + 4 > tiff.length) throw new Error('EXIF IFD out of bounds');
    for (let i = 0; i < count; i++) {
      const entry = position + 2 + i * 12;
      const tag = u16(entry); const type = u16(entry + 2); const n = u32(entry + 4);
      if (!isExif && tag === 0x8769 && type === 4 && n === 1) visit(u32(entry + 8), true);
      if (!isExif && (tag === 0x10f || tag === 0x110) && type === 2) {
        const start = n <= 4 ? entry + 8 : u32(entry + 8);
        if (start + n > tiff.length) throw new Error('EXIF ASCII out of bounds');
        result[tag === 0x10f ? 'make' : 'model'] = tiff.subarray(start, start + n).toString('utf8').replace(/\0+$/, '');
      }
      if (!isExif && tag === 0x112 && type === 3 && n === 1) result.orientation = u16(entry + 8);
      if (isExif && tag === 0x8897 && type === 1 && n === 1) result.xiaomiFlag = tiff[entry + 8];
    }
  };
  visit(u32(4), false);
  return result;
}
