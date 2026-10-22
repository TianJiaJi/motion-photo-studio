import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

if (process.argv.slice(2).some(arg => arg !== '--dir')) throw new Error('Only the --dir packaging switch is accepted');
const tag = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomUUID().slice(0, 8);
const parent = resolve('../artifacts/desktop'); await mkdir(parent, { recursive: true });
const output = join(parent, `m4-internal-${tag}`); await mkdir(output);
await writeFile(join(output, 'INTERNAL-BUILD.txt'), 'Internal development build. Not approved for public redistribution.\nCreating an installer is not clean-install or phone acceptance.\n', { flag: 'wx' });
console.log(`Unique internal package output: ${output}`);
const child = spawn(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--win', '--x64',
  ...(process.argv.includes('--dir') ? ['--dir'] : []), `-c.directories.output=${output}`, '--publish', 'never'],
{ shell: false, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
