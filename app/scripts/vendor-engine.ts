import { copyFile, mkdir, readFile, writeFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { sha256, readExactly } from '../src/main/motion/io.ts';
import { runProcess } from '../src/main/media/runner.ts';
import type { EngineManifest } from '../src/main/media/engine.ts';

const { values } = parseArgs({ options: { 'source-dir': { type: 'string' }, 'gpl-license': { type: 'string' } } });
if (!values['source-dir'] || !values['gpl-license']) throw new Error('Provide --source-dir and --gpl-license. No automatic PATH selection or download.');
const root = fileURLToPath(new URL('../', import.meta.url));
const resources = join(root, 'resources');
await mkdir(join(resources, 'bin'), { recursive: true });
await mkdir(join(resources, 'licenses'), { recursive: true });
const manifest: EngineManifest = {
  schemaVersion: 1, platform: 'win32', arch: 'x64', build: '', binaries: [],
  provenance: 'Explicit local snapshot; vendor signature/source provenance not independently attested.',
  releaseStatus: 'internal-development-only',
};
for (const name of ['ffmpeg.exe', 'ffprobe.exe'] as const) {
  const source = join(resolve(values['source-dir']), name);
  const handle = await open(source, 'r');
  try {
    const dos = await readExactly(handle, 0, 64);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE executable');
    const pe = await readExactly(handle, dos.readUInt32LE(0x3c), 6);
    if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) throw new Error('Engine must be Windows x64');
  } finally { await handle.close(); }
  const sourceHash = await sha256(source);
  const version = (await runProcess(source, ['-version'])).stdout;
  const first = version.split(/\r?\n/)[0]!;
  const build = first.split(' version ')[1]?.split(' Copyright')[0];
  if (!build || manifest.build && manifest.build !== build) throw new Error('FFmpeg and ffprobe must come from the exact same build');
  manifest.build = build;
  const destination = join(resources, 'bin', name);
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (await sha256(destination) !== sourceHash || await sha256(source) !== sourceHash) throw new Error('Copy mismatch or changed source');
  manifest.binaries.push({ name, sha256: sourceHash, size: (await lstat(destination)).size });
  await writeFile(join(resources, 'licenses', `${name}.build.txt`), version + '\n' + (await runProcess(source, ['-buildconf'])).stdout);
  await writeFile(join(resources, 'licenses', `${name}.license-notice.txt`), (await runProcess(source, ['-L'])).stdout);
}
const license = await readFile(resolve(values['gpl-license']), 'utf8');
if (!license.includes('GNU GENERAL PUBLIC LICENSE') || !license.includes('Version 3, 29 June 2007')) throw new Error('Expected complete GPLv3 license text');
await writeFile(join(resources, 'licenses', 'GPL-3.0.txt'), license);
await writeFile(join(resources, 'licenses', 'DISTRIBUTION-STATUS.txt'),
  'INTERNAL DEVELOPMENT BUILD ONLY\nThese local tools have pinned hashes and matching versions, not an independent source/provenance attestation.\nPublic redistribution is blocked until M5 completes corresponding-source and third-party license review.\nUpstream source: https://git.ffmpeg.org/ffmpeg.git (revision embedded in build label); this pointer alone does NOT satisfy corresponding-source obligations for the full configured build.\n');
await writeFile(join(resources, 'engine-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Pinned ${manifest.build}; copied ${manifest.binaries.length} Windows x64 tools to ${resources}`);
