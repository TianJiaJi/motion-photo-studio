import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkCreatedFile } from '../jobs/temp-files.ts';
import { assertSource, openSource, type SourceFile } from './source.ts';
import { parseJpegCoverRequest, type JpegCoverReport, type JpegCoverRequest } from './image-contract.ts';

function workerPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './image-worker.ts' : './image-worker.js', import.meta.url));
}
async function runImageWorker(request: JpegCoverRequest, signal: AbortSignal): Promise<JpegCoverReport> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'SHARP_IGNORE_GLOBAL_LIBVIPS', 'SHARP_FORCE_GLOBAL_LIBVIPS'].includes(key.toUpperCase())) delete env[key];
  env.ELECTRON_RUN_AS_NODE = '1'; env.SHARP_IGNORE_GLOBAL_LIBVIPS = '1';
  const child = spawn(process.execPath, [workerPath()], { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = ''; let stderr = ''; let failure: Error | undefined; let exit: number | null = null;
  const closed = new Promise<void>(resolveClose => child.once('close', code => { exit = code; resolveClose(); }));
  const stop = (error: Error) => { failure ??= error; child.kill(); };
  const abort = () => stop(new Error('Image operation cancelled'));
  child.on('error', error => stop(error));
  const input = child.stdin; const output = child.stdout; const errors = child.stderr;
  if (!input || !output || !errors) { const error = new Error('Image worker pipes unavailable'); stop(error); await closed; throw error; }
  input.on('error', error => stop(error));
  output.setEncoding('utf8'); errors.setEncoding('utf8');
  output.on('data', (data: string) => { stdout += data; if (stdout.length > 16384) stop(new Error('Image worker output exceeded bound')); });
  errors.on('data', (data: string) => { stderr = (stderr + data).slice(-16384); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const json = JSON.stringify(request); if (json.length > 128 * 1024) throw new Error('Image request exceeded bound');
    input.end(json); await closed;
    signal.throwIfAborted(); if (failure) throw failure;
    if (exit !== 0) throw new Error(`Cover image worker exited ${exit}: ${stderr}`);
    const result = JSON.parse(stdout) as JpegCoverReport;
    if (result.width !== request.width || result.height !== request.height || result.colorSpace !== 'srgb'
      || !Array.isArray(result.warnings) || result.warnings.some(v => typeof v !== 'string') || !result.engine?.sharp || !result.engine.vips || !result.engine.lcms)
      throw new Error('Invalid image worker result');
    return result;
  } catch (error) { child.kill(); await closed; throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
// Private JPEG draft only; M4 adds the chosen Motion Photo EXIF/XMP and publishes atomically.
export async function createJpegCover(options: {
  source: SourceFile; output: string; width: number; height: number; fit: 'cover' | 'contain'; background: string;
  signal: AbortSignal; onStage?: (stage: 'image') => void | Promise<void>;
}): Promise<{ file: SourceFile; report: JpegCoverReport }> {
  const { source, signal } = options;
  const request = parseJpegCoverRequest({ input: source.path, output: resolve(options.output), width: options.width,
    height: options.height, fit: options.fit, background: options.background });
  if (process.platform === 'win32' ? request.output.toLowerCase() === source.path.toLowerCase() : request.output === source.path) throw new Error('Cannot overwrite source');
  signal.throwIfAborted(); await assertSource(source);
  await writeFile(request.output, '', { flag: 'wx' }); let succeeded = false;
  try {
    await options.onStage?.('image');
    const report = await runImageWorker(request, signal); const file = await openSource(request.output);
    await assertSource(source); await assertSource(file); signal.throwIfAborted(); succeeded = true;
    return { file, report };
  } catch (error) { if (!signal.aborted) await assertSource(source); throw error; }
  finally { if (!succeeded) await unlinkCreatedFile(request.output); }
}
