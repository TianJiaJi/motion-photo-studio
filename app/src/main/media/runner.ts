import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type ProcessResult = { stdout: string; stderr: string };
export type ProcessOptions = {
  timeoutMs?: number; signal?: AbortSignal; captureStdout?: boolean; onStdout?: (chunk: string) => void;
};
export function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let failure: Error | undefined;
    const limit = 1024 * 1024;
    const stop = (error: Error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => stop(new Error(`${executable} timed out`)), options.timeoutMs ?? 120000);
    const abort = () => stop(new Error('Media operation cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk: Buffer) => {
      try { options.onStdout?.(chunk.toString('utf8')); }
      catch { stop(new Error('Process progress callback failed')); }
      if (options.captureStdout === false) return;
      if (stdout.length + chunk.length > limit) stop(new Error('Process stdout exceeded bound'));
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-limit); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${executable} exited ${code}: ${stderr.toString('utf8')}`));
      else resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
    if (options.signal?.aborted) abort();
  });
}

// Development/test convenience only; production passes paths from verifyEngines explicitly.
// Never let an unconfigured regression/oracle silently select a different executable from PATH.
export const ffmpeg = () => fileURLToPath(new URL('../../../resources/bin/ffmpeg.exe', import.meta.url));
export const ffprobe = () => fileURLToPath(new URL('../../../resources/bin/ffprobe.exe', import.meta.url));
export async function toolVersions() {
  return {
    ffmpeg: (await runProcess(ffmpeg(), ['-version'])).stdout.split(/\r?\n/)[0],
    ffprobe: (await runProcess(ffprobe(), ['-version'])).stdout.split(/\r?\n/)[0],
  };
}
