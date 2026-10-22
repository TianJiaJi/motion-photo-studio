import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type LineProcessOptions = { signal?: AbortSignal; timeoutMs?: number; maxLineChars?: number };
// Async line callbacks provide backpressure to the child pipe; neither output nor packet lists accumulate.
// Return true from onLine to stop intentionally. Cancellation/errors still wait for process termination.
export async function streamProcessLines(executable: string, args: string[],
  onLine: (line: string) => Promise<boolean | void> | boolean | void,
  options: LineProcessOptions = {}): Promise<{ stopped: boolean; stderr: string; stdoutBytes: number }> {
  options.signal?.throwIfAborted();
  const maxLine = options.maxLineChars ?? 16384;
  const timeout = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(maxLine) || maxLine < 1 || maxLine > 1024 * 1024
    || !Number.isSafeInteger(timeout) || timeout < 0) throw new Error('Invalid streaming process limits');
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure: unknown; let exitCode: number | null = null; let ended = false; let stopped = false;
  let stderr = Buffer.alloc(0);
  const closed = new Promise<void>(resolve => child.once('close', code => { exitCode = code; ended = true; resolve(); }));
  const stop = (error: unknown) => { failure ??= error; if (!ended) child.kill(); };
  child.on('error', error => stop(error));
  child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536); });
  child.stdout.setEncoding('utf8');
  const abort = () => stop(new Error('Media operation cancelled'));
  const timer = timeout > 0 ? setTimeout(() => stop(new Error('Streaming media inspection timed out')), timeout) : undefined;
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let carry = ''; let stdoutBytes = 0;
  const intentionalStop = () => {
    stopped = true;
    if (!ended) child.kill();
    // Keep the pipe attached until the killed/already-exited child closes it. Destroying it
    // from inside an async Writable callback races pipeline teardown with the pending write.
    // Subsequent chunks are drained without invoking the consumer or accumulating output.
  };
  // Pipe to a real Writable before the child can exit. The writable callback gates each chunk,
  // including async consumers, so child close/stdio drainage cannot race an async iterator's
  // next read. No unbounded queue of output strings or unresolved callback promises is kept.
  const sink = new Writable({ decodeStrings: false, highWaterMark: 65536,
    write(chunk: string, _encoding, done) {
      const consume = async () => {
        if (failure || stopped) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (!Number.isSafeInteger(stdoutBytes)) throw new Error('Process byte counter exceeds safe precision');
        carry += chunk;
        for (;;) {
          const newline = carry.indexOf('\n'); if (newline < 0) break;
          if (newline > maxLine) throw new Error('Process line exceeded bound');
          const line = carry.slice(0, newline).replace(/\r$/, ''); carry = carry.slice(newline + 1);
          if (await onLine(line)) { intentionalStop(); return; }
          if (failure) return;
        }
        if (carry.length > maxLine) throw new Error('Process line exceeded bound');
      };
      void consume().then(() => done(), error => done(error instanceof Error ? error : new Error(String(error))));
    },
    final(done) {
      const consume = async () => {
        if (failure || stopped || !carry) return;
        if (carry.length > maxLine) throw new Error('Process line exceeded bound');
        if (await onLine(carry.replace(/\r$/, ''))) intentionalStop();
        carry = '';
      };
      void consume().then(() => done(), error => done(error instanceof Error ? error : new Error(String(error))));
    },
  });
  try { await pipeline(child.stdout, sink); }
  catch (error) { if (!stopped && !failure) stop(error); }
  finally {
    await closed;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
  if (options.signal?.aborted) throw new Error('Media operation cancelled');
  if (failure) throw failure;
  if (!stopped && exitCode !== 0) throw new Error(`${executable} exited ${exitCode}: ${stderr.toString('utf8')}`);
  return { stopped, stderr: stderr.toString('utf8'), stdoutBytes };
}
