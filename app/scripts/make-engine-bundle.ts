// Maintainer-only: packages the exact locally verified engine snapshot, never user media.
import { mkdir, copyFile, writeFile, readFile, cp, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEngines } from '../src/main/media/engine.ts';
import { sha256 } from '../src/main/motion/io.ts';
import { runProcess } from '../src/main/media/runner.ts';
const resources = fileURLToPath(new URL('../resources/', import.meta.url));
const destination = resolve(process.argv[2] ?? '../artifacts/engine-snapshot');
await verifyEngines(resources);
await mkdir(destination); // Refuse accidental reuse/overwrite.
const payload = join(destination, 'payload'); await mkdir(join(payload, 'bin'), { recursive: true });
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(join(resources, 'bin', name), join(payload, 'bin', name));
await copyFile(join(resources, 'engine-manifest.json'), join(payload, 'engine-manifest.json'));
await cp(join(resources, 'licenses'), join(payload, 'licenses'), { recursive: true });
await writeFile(join(payload, 'licenses', 'DISTRIBUTION-STATUS.txt'),
  'Development-preview dependency snapshot, published at the project owner request.\n' +
  'Hashes pin identity, not legal approval or vendor authentication.\n' +
  'GPLv3 license and full native build configuration are included.\n' +
  'Corresponding-source/dependency license audit remains incomplete; do not claim M5 or stable-release acceptance.\n' +
  'FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/tree/0857141823\n' +
  'Build provider: https://www.gyan.dev/ffmpeg/builds/\n' +
  'These source pointers alone are not a complete corresponding-source archive.\n');
const archive = join(destination, 'ffmpeg-2026-05-21-win-x64.zip');
// Pass paths as argv (never interpolate path strings into PowerShell code).
const ps = join(destination, 'compress.ps1');
await writeFile(ps, 'param([string]$Source,[string]$Target)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Target,[IO.Compression.CompressionLevel]::Optimal,$false)\n');
await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ps, payload, archive], { timeoutMs: 300000 });
const digest = await sha256(archive);
await writeFile(join(destination, 'SHA256SUMS.txt'), `${digest}  ffmpeg-2026-05-21-win-x64.zip\n`);
const result = { archive, size: (await stat(archive)).size, sha256: digest,
  manifest: JSON.parse(await readFile(join(payload, 'engine-manifest.json'), 'utf8')) as unknown };
await writeFile(join(destination, 'bundle-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
