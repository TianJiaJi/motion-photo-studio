import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Real capability probe: the helper mirrors playback's WASAPI opening calls. A host with
// no audio render endpoint cannot validate actual playback; such tests skip explicitly
// there and must still fail for real audio errors wherever an endpoint exists.
let audioEndpointProbe: Promise<boolean> | undefined;
export function audioEndpointAvailable(helper: string): Promise<boolean> {
  audioEndpointProbe ??= (async () => {
    const output = execFileSync(helper, ['--probe-audio'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
    const value = JSON.parse(output) as { ok?: unknown };
    if (typeof value?.ok !== 'boolean') throw new Error(`Unexpected audio endpoint probe output: ${output.slice(0, 200)}`);
    return value.ok;
  })();
  return audioEndpointProbe;
}

export async function tempFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'motion-test-'));
  return { directory, file: (name: string) => join(directory, name), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff; header[1] = marker; header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// Structural fixture only. This is not an encoded image; integration tests use actual FFmpeg JPEGs.
export function structuralJpeg(extras: Buffer[] = [], entropy = Buffer.from([1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4])): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...extras,
    segment(0xc0, Buffer.from([8, 0, 2, 0, 2, 1, 1, 0x11, 0])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), entropy, Buffer.from([0xff, 0xd9]),
  ]);
}

export function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
export function structuralMp4(): Buffer {
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov'), box('mdat', Buffer.from('fixture, not a decodable video'))]);
}

export async function structuralInputs(temp: Awaited<ReturnType<typeof tempFiles>>, extras: Buffer[] = []) {
  const cover = temp.file('cover.jpg'); const video = temp.file('video.mp4');
  await writeFile(cover, structuralJpeg(extras));
  await writeFile(video, structuralMp4());
  return { cover, video };
}
