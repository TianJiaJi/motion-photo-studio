import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function safeConfigureDiagnostics(raw) {
  const lines=raw.split(/\r?\n/);
  const start=lines.findIndex(line=>/^(?:check|test)_[a-z_]+(?: |$)/.test(line));
  // FFmpeg configure starts by dumping shell variables. Preserve compiler probes, not that environment.
  return '# Initial configure environment dump intentionally omitted.\n' + (start<0 ? '# No compiler probes were recorded.\n' : lines.slice(start).join('\n'));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const path=resolve('../artifacts/release-engine/repos/ffmpeg/ffbuild/config.log');
  try { await writeFile(path.replace(/\.log$/,'.safe.log'),safeConfigureDiagnostics(await readFile(path,'utf8'))); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
}
