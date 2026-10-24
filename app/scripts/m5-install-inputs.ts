// Small synthetic inputs for manual offline installation testing, distinct from Motion JPG outputs.
import assert from 'node:assert/strict';
import { realpath, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyEngines } from '../src/main/media/engine.ts';
import { runProcess } from '../src/main/media/runner.ts';
import { sha256 } from '../src/main/motion/io.ts';

const [argument] = process.argv.slice(2); if (!argument || process.argv.length !== 3) throw new Error('Pass one locally validated synthetic phone-kit directory');
const root = await realpath(argument); assert.equal(dirname(root), await realpath(resolve('../artifacts/m5'))); assert.match(basename(root), /^phone-\d{17}-[a-f0-9]{8}$/);
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { status: string; syntheticOnly: boolean; work: string };
assert.equal(manifest.status, 'local-decode-passed-phone-NOT_TESTED'); assert.equal(manifest.syntheticOnly, true);
const work = await realpath(manifest.work); assert.equal(dirname(work), await realpath(tmpdir())); assert.match(basename(work), /^motion-m5-phone-/);
const output = join(root, 'desktop-test-inputs'); await mkdir(output);
const engines = await verifyEngines(resolve('resources')); const landscape = join(output, 'landscape-clock-beeps-6s.mp4');
await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-i', join(work, 'clock-and-beeps.mp4'), '-t', '6', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', landscape]);
await copyFile(join(work, 'portrait-silent.mp4'), join(output, 'portrait-silent-3s.mp4'), constants.COPYFILE_EXCL);
await copyFile(join(work, 'static-cover.png'), join(output, 'transparent-cover.png'), constants.COPYFILE_EXCL);
for (const name of ['landscape-clock-beeps-6s.mp4', 'portrait-silent-3s.mp4']) await runProcess(engines.ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', join(output, name), '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
const files = [];
for (const name of ['landscape-clock-beeps-6s.mp4', 'portrait-silent-3s.mp4', 'transparent-cover.png']) files.push({ name, sha256: await sha256(join(output, name)) });
await writeFile(join(output, 'README.txt'), 'Synthetic manual installer test inputs, not user originals.\nImport MP4 files into the editor; use PNG as uploaded cover.\nCopy these inputs and the internal NSIS to a clean Windows x64 test environment, disconnect its network, and follow docs/clean-windows-checklist.md.\nThis directory is not phone-kit; do not mistake pre-existing Motion JPG outputs for supported editable inputs.\n', { flag: 'wx' });
await writeFile(join(root, 'desktop-inputs-evidence.json'), JSON.stringify({ status: 'synthetic-inputs-locally-decoded-not-clean-install', output, files }, null, 2), { flag: 'wx', flush: true });
console.log(output); console.log(JSON.stringify(files, null, 2));
