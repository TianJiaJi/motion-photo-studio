// Archive identity only. Does not execute the installer, register the app, or claim clean-install evidence.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../src/main/media/runner.ts';
import { sha256 } from '../src/main/motion/io.ts';

const [argument, option, tool] = process.argv.slice(2);
if (!argument || option !== '--sevenzip' || !tool || process.argv.length !== 5)
  throw new Error('Pass an internal installer directory and --sevenzip with an explicit NSIS-capable full 7z executable');
const sevenZip = await realpath(tool); assert.match(basename(sevenZip), /^7zz?\.exe$/i);
const toolInfo = (await runProcess(sevenZip, ['i'])).stdout;
assert.match(toolInfo, /7-Zip/); assert.match(toolInfo, /\bNsis\b/i, 'Tool lacks NSIS support; reduced builder 7za is not sufficient');
const extractionTool = { path: sevenZip, sha256: await sha256(sevenZip), banner: toolInfo.split(/\r?\n/).find(line => line.includes('7-Zip')) };
const directory = await realpath(argument); assert.equal(dirname(directory), await realpath(resolve('../artifacts/desktop')));
assert.match(basename(directory), /^m5-installer-\d{17}-[a-f0-9]{8}$/);
const info = JSON.parse(await readFile(join(directory, 'installer-evidence.json'), 'utf8')) as { installer: string; sha256: string; candidate: string };
assert.equal(dirname(info.installer), directory); assert.equal(await sha256(info.installer), info.sha256);
const candidate = JSON.parse(await readFile(join(info.candidate, 'candidate-evidence.json'), 'utf8')) as {
  exe: { sha256: string }; archive: { sha256: string }; nativeFiles: { name: string; sha256: string }[];
};
const space = await statfs(tmpdir(), { bigint: true }); if (space.bavail * space.bsize < 3n * 1024n ** 3n) throw new Error('Extraction test needs 3 GiB free including safety headroom');
const temporary = await mkdtemp(join(tmpdir(), 'motion-installer-audit-'));
try {
  const outer = join(temporary, 'outer'); const inner = join(temporary, 'inner');
  await runProcess(sevenZip, ['x', '-y', '-bso0', '-bsp0', '-bse1', `-o${outer}`, info.installer]);
  const archiveEntries = await readdir(outer, { recursive: true, withFileTypes: true });
  const archives = archiveEntries.filter(entry => entry.isFile() && /^app-64\.7z$/i.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
  assert.equal(archives.length, 1, 'Expected one x64 app payload');
  await runProcess(sevenZip, ['x', '-y', '-bso0', '-bsp0', '-bse1', `-o${inner}`, archives[0]!]);
  const entries = await readdir(inner, { recursive: true, withFileTypes: true });
  const asars = entries.filter(entry => entry.isFile() && entry.name === 'app.asar').map(entry => join(entry.parentPath, entry.name));
  assert.equal(asars.length, 1); const archive = asars[0]!; const appRoot = dirname(dirname(archive));
  assert.equal(await sha256(archive), candidate.archive.sha256); assert.equal(await sha256(join(appRoot, 'Motion Photo Studio.exe')), candidate.exe.sha256);
  for (const file of candidate.nativeFiles) assert.equal(await sha256(join(dirname(archive), 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', file.name)), file.sha256);
  const report = { status: 'archive-payload-identity-passed-not-installed', installer: info.installer, installerSha256: info.sha256,
    candidate: info.candidate, extractionTool, archiveSha256: candidate.archive.sha256, executableSha256: candidate.exe.sha256, nativeFiles: candidate.nativeFiles,
    scope: 'Extracted trusted self-generated NSIS and its x64 payload in a fresh test directory; no installer or uninstaller execution, registry changes, clean machine or phone acceptance.' };
  await writeFile(join(directory, 'payload-evidence.json'), JSON.stringify(report, null, 2), { flag: 'wx', flush: true }); console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
