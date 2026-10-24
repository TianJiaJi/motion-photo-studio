// Wrap only a byte-identified, already runtime-tested internal directory; never rebuild/replace M1.
import assert from 'node:assert/strict';
import { realpath, readFile, mkdir, writeFile, readdir, statfs, stat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sha256 } from '../src/main/motion/io.ts';
import { runProcess } from '../src/main/media/runner.ts';

const [argument] = process.argv.slice(2); if (!argument || process.argv.length !== 3) throw new Error('Pass exactly one inventoried internal candidate directory');
const candidate = await realpath(argument); const desktop = await realpath(resolve('../artifacts/desktop'));
assert.equal(dirname(candidate), desktop); assert.match(basename(candidate), /^m4-internal-\d{17}-[a-f0-9]{8}$/);
const evidence = JSON.parse(await readFile(join(candidate, 'candidate-evidence.json'), 'utf8')) as { archive: { sha256: string }; exe: { sha256: string }; rollback: { path: string; sha256: string } };
const unpacked = join(candidate, 'win-unpacked'); const exe = join(unpacked, 'Motion Photo Studio.exe'); const archive = join(unpacked, 'resources', 'app.asar');
assert.equal(await sha256(exe), evidence.exe.sha256); assert.equal(await sha256(archive), evidence.archive.sha256);
const space = await statfs(desktop, { bigint: true }); if (space.bavail * space.bsize < 1536n * 1024n ** 2n) throw new Error('Installer test needs 1.5 GiB free including safety headroom');
const tag = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomUUID().slice(0, 8);
const output = join(desktop, `m5-installer-${tag}`); await mkdir(output);
await writeFile(join(output, 'INTERNAL-BUILD.txt'), 'Internal development installer. Not approved for public redistribution.\nNot clean-install/uninstall or phone acceptance.\n', { flag: 'wx' });
console.log(`Unique installer output: ${output}`);
try {
  const child = spawn(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--win', 'nsis', '--x64',
    '--prepackaged', unpacked, `-c.directories.output=${output}`, '--publish', 'never'], { shell: false, windowsHide: true, stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Builder exited ${code}`))); });
  assert.equal(await sha256(exe), evidence.exe.sha256, 'prepackaged EXE changed'); assert.equal(await sha256(archive), evidence.archive.sha256, 'prepackaged archive changed');
  assert.equal(await sha256(evidence.rollback.path), evidence.rollback.sha256, 'M1 rollback changed');
  const names = (await readdir(output)).filter(name => name.endsWith('.exe')); assert.equal(names.length, 1);
  const installer = join(output, names[0]!); const quoted = installer.replaceAll("'", "''");
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const signature = (await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${quoted}').Status.ToString()`])).stdout.trim();
  const report = { status: 'generated-only-not-installed-or-approved', candidate, installer, size: (await stat(installer)).size,
    sha256: await sha256(installer), authenticode: signature, originalCandidateBytesUnchanged: true, rollbackPreserved: true,
    limitations: ['Unsigned/internal unless signature states otherwise', 'No clean Windows install or uninstall performed', 'No public distribution; legal/source/official-spec and phone gates remain'] };
  await writeFile(join(output, 'installer-evidence.json'), JSON.stringify(report, null, 2), { flag: 'wx', flush: true }); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(output, 'installer-failure.json'), JSON.stringify({ status: 'failed', candidate, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2), { flag: 'wx' }); throw error;
}
