import type { FileHandle } from 'node:fs/promises';
import { fromBigInt, readExactly, safeInteger } from '../motion/io.ts';
import { streamProcessLines } from './lines.ts';

export type MediaPacket = {
  streamIndex: number; pts: bigint | null; dts: bigint | null; duration: bigint | null;
  size: number; position: number | null; key: boolean; discard: boolean; corrupt: boolean;
  hash?: string; skipSamples: number; discardPadding: number;
};
function timestamp(value: string | undefined): bigint | null {
  if (value === undefined || value === 'N/A') return null;
  if (!/^-?\d{1,20}$/.test(value)) throw new Error('Invalid packet integer');
  const n = BigInt(value);
  if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error('Packet integer out of range');
  return n;
}
function natural(value: string | undefined, label: string): number {
  const n = timestamp(value); if (n === null) throw new Error(`Missing ${label}`);
  return fromBigInt(n, label);
}
export function parsePacketLine(line: string, requireHash = false): MediaPacket | null {
  if (!line) return null;
  if (!line.startsWith('packet|')) throw new Error('Unexpected packet report section');
  const fields = new Map<string, string>();
  for (const field of line.slice(7).split('|')) {
    const equals = field.indexOf('='); if (equals < 0) continue;
    let key = field.slice(0, equals);
    if (key.endsWith(':skip_samples')) key = 'skip_samples';
    if (key.endsWith(':discard_padding')) key = 'discard_padding';
    if (fields.has(key)) throw new Error('Duplicate packet report field');
    fields.set(key, field.slice(equals + 1));
  }
  const flags = fields.get('flags');
  if (!flags || !/^[A-Z_]+$/.test(flags)) throw new Error('Invalid packet flags');
  const hash = fields.get('data_hash');
  if (hash !== undefined && !/^SHA256:[a-fA-F0-9]{64}$/.test(hash) || requireHash && hash === undefined) throw new Error('Missing or invalid packet SHA-256');
  const position = timestamp(fields.get('pos'));
  const duration = timestamp(fields.get('duration'));
  if (duration !== null && duration < 0n) throw new Error('Negative packet duration');
  return {
    streamIndex: natural(fields.get('stream_index'), 'stream index'), pts: timestamp(fields.get('pts')),
    dts: timestamp(fields.get('dts')), duration, size: natural(fields.get('size'), 'packet size'),
    position: position === null || position === -1n ? null : fromBigInt(position, 'packet position'),
    key: flags.includes('K'), discard: flags.includes('D'), corrupt: flags.includes('C'),
    hash: hash?.slice(7).toLowerCase(),
    skipSamples: natural(fields.get('skip_samples') ?? '0', 'skip samples'),
    discardPadding: natural(fields.get('discard_padding') ?? '0', 'discard padding'),
  };
}

export async function scanPackets(options: {
  executable: string; input: string; hashes?: boolean; signal?: AbortSignal;
  onPacket(packet: MediaPacket): Promise<boolean | void> | boolean | void;
}): Promise<{ stopped: boolean }> {
  const result = await streamProcessLines(options.executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_packets', ...(options.hashes ? ['-show_data_hash', 'sha256'] : []), '-show_entries',
    'packet=stream_index,pts,dts,duration,size,pos,flags,data_hash:packet_side_data=skip_samples,discard_padding',
    '-of', 'compact=p=1:nk=0', '-i', options.input], async line => {
    const packet = parsePacketLine(line, options.hashes); if (packet) return options.onPacket(packet);
  }, { signal: options.signal, timeoutMs: 0 });
  return { stopped: result.stopped };
}

// A container K flag alone does not prove an independently decodable H.264 start (open GOPs).
// For AVCC MP4/MOV samples inspect length-prefixed NAL headers directly, with bounded reads.
export async function packetHasIdr(file: FileHandle, fileSize: number, packet: MediaPacket,
  lengthBytes: number, signal?: AbortSignal): Promise<boolean> {
  if (![1, 2, 4].includes(lengthBytes)) throw new Error('Unsupported AVC NAL length field');
  if (packet.position === null) throw new Error('Packet has no source-file position');
  safeInteger(fileSize, 'source size');
  const end = safeInteger(packet.position + packet.size, 'packet extent');
  if (end > fileSize) throw new Error('Packet escapes source file');
  let position = packet.position; let idr = false;
  while (position < end) {
    signal?.throwIfAborted();
    if (end - position < lengthBytes + 1) throw new Error('Truncated AVC sample');
    const prefix = await readExactly(file, position, lengthBytes + 1);
    const size = prefix.readUIntBE(0, lengthBytes);
    if (size < 1 || size > end - position - lengthBytes || (prefix[lengthBytes]! & 0x80) !== 0) throw new Error('Invalid AVC NAL extent or header');
    if ((prefix[lengthBytes]! & 0x1f) === 5) idr = true;
    position += lengthBytes + size;
  }
  return idr;
}
