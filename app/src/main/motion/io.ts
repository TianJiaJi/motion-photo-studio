import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export function safeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

export function fromBigInt(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe file addressing`);
  return Number(value);
}

export async function readExactly(file: FileHandle, position: number, size: number): Promise<Buffer> {
  safeInteger(position, 'read position');
  safeInteger(size, 'read size');
  if (size > 2 * 1024 * 1024) throw new Error('Unbounded read refused');
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const { bytesRead } = await file.read(buffer, done, size - done, position + done);
    if (!bytesRead) throw new Error(`Unexpected EOF at ${position + done}`);
    done += bytesRead;
  }
  return buffer;
}

export async function writeAll(file: FileHandle, data: Buffer, position: number): Promise<number> {
  let done = 0;
  while (done < data.length) {
    const { bytesWritten } = await file.write(data, done, data.length - done, position + done);
    if (!bytesWritten) throw new Error('Write made no progress');
    done += bytesWritten;
  }
  return position + done;
}

export async function copyRange(source: FileHandle, target: FileHandle, start: number, end: number,
  outputOffset: number, signal?: AbortSignal, onProgress?: (writtenBytes: number) => void | Promise<void>): Promise<number> {
  safeInteger(start, 'range start');
  safeInteger(end, 'range end', start);
  safeInteger(outputOffset + end - start, 'output extent');
  const buffer = Buffer.alloc(1024 * 1024);
  for (let position = start; position < end;) {
    signal?.throwIfAborted();
    const size = Math.min(buffer.length, end - position);
    const { bytesRead } = await source.read(buffer, 0, size, position);
    if (!bytesRead) throw new Error('Source truncated while copying');
    outputOffset = await writeAll(target, buffer.subarray(0, bytesRead), outputOffset);
    position += bytesRead;
    await onProgress?.(outputOffset);
  }
  return outputOffset;
}

export async function sha256(path: string, start?: number, endExclusive?: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  if (start !== undefined && endExclusive === start) return hash.digest('hex');
  for await (const chunk of createReadStream(path, {
    start, end: endExclusive === undefined ? undefined : endExclusive - 1, signal,
  })) hash.update(chunk);
  return hash.digest('hex');
}

export async function extractRange(source: string, destination: string, start: number, end: number): Promise<void> {
  const input = await open(source, 'r');
  try {
    const output = await open(destination, 'wx');
    try { await copyRange(input, output, start, end, 0); }
    finally { await output.close(); }
  } finally { await input.close(); }
}
