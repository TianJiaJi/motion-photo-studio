import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename, normalize } from 'node:path';
import { listPackage, extractFile } from '@electron/asar';
import { verifyEngines } from '../src/main/media/engine.ts';
import { sha256 } from '../src/main/motion/io.ts';
import { runProcess } from '../src/main/media/runner.ts';

const [argument] = process.argv.slice(2);
if (!argument || process.argv.length !== 3) throw new Error('Pass exactly one unique internal candidate directory');
const directory = await realpath(argument); const desktop = await realpath(resolve('../artifacts/desktop'));
assert.equal(dirname(directory), desktop); assert.match(basename(directory), /^m4-internal-\d{17}-[a-f0-9]{8}$/);
assert.match(await readFile(join(directory, 'INTERNAL-BUILD.txt'), 'utf8'), /Not approved for public redistribution/);
const unpacked = join(directory, 'win-unpacked'); const resources = join(unpacked, 'resources');
const engines = await verifyEngines(resources); const archive = join(resources, 'app.asar');
const files = listPackage(archive, { isPack: false }).map(path => path.replaceAll('\\', '/').replace(/^\//, ''));
const packages = files.filter(path => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path)).map(path => {
  const pkg = JSON.parse(extractFile(archive, normalize(path)).toString('utf8')) as { name?: string; version?: string; license?: unknown };
  return { path, name: pkg.name, version: pkg.version, declaredLicense: pkg.license ?? null };
});
for (const name of ['sharp', '@img/sharp-win32-x64', 'saxes', 'xmlchars']) assert.ok(packages.some(pkg => pkg.name === name), `Missing shipped runtime ${name}`);
const nativeDir = join(resources, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib');
const nativeFiles = [];
for (const name of await readdir(nativeDir)) {
  const path = join(nativeDir, name); if (!(await stat(path)).isFile()) continue;
  nativeFiles.push({ name, size: (await stat(path)).size, sha256: await sha256(path) });
}
assert.ok(nativeFiles.some(file => file.name.endsWith('.node'))); assert.ok(nativeFiles.filter(file => file.name.endsWith('.dll')).length >= 2);
const rollback = join(desktop, 'MotionPhotoStudio-M1-0.1.0-win-x64-setup.exe');
const rollbackSha = await sha256(rollback); assert.equal(rollbackSha, '9700d9c87fde063f9ddc36deea254f7fb978c5d774890ea55e67ae6670a44a7e');
const exe = join(unpacked, 'Motion Photo Studio.exe');
const quote = exe.replaceAll("'", "''");
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const signature = JSON.parse((await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command',
  `$s=Get-AuthenticodeSignature -LiteralPath '${quote}';[pscustomobject]@{Status=$s.Status.ToString();Subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}}|ConvertTo-Json -Compress`])).stdout.trim()) as unknown;
const evidence = { schema: 1, status: 'inventory-only-not-license-or-install-approval', directory, utc: new Date().toISOString(), engines,
  exe: { size: (await stat(exe)).size, sha256: await sha256(exe), authenticode: signature },
  archive: { size: (await stat(archive)).size, sha256: await sha256(archive) }, packages, nativeFiles,
  bundledNoticePaths: files.filter(path => /(?:^|\/)(?:licen[cs]e(?:[.-].*)?|copying(?:[.-].*)?|notice(?:[.-].*)?)$/i.test(path)),
  electronNotices: await Promise.all(['LICENSE.electron.txt', 'LICENSES.chromium.html'].map(async name => ({ name, sha256: await sha256(join(unpacked, name)) }))),
  rollback: { path: rollback, sha256: rollbackSha, preserved: true },
  limitations: ['Dependency license fields and filenames are inventory, not complete notice/corresponding-source approval', 'Not an installer or clean Windows evidence', 'Actual runtime verification is recorded separately'] };
const path = join(directory, 'candidate-evidence.json'); await writeFile(path, JSON.stringify(evidence, null, 2), { flag: 'wx', flush: true });
console.log(path); console.log(JSON.stringify({ signature, packageCount: packages.length, rollbackPreserved: true }));
