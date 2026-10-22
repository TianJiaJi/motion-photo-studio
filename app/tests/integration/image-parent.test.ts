import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A disconnected parent channel is the same lifecycle event seen when its owner process dies.
// This test exercises the actual native worker, not a substituted image implementation.
test('native image worker exits when its parent channel disappears while waiting for work', { timeout: 15000 }, async t => {
  const child = fork(fileURLToPath(new URL('../../src/main/media/image-worker.ts', import.meta.url)), [],
    { execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stdout?.resume(); child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  child.stdin?.on('error', () => {});
  // Observe OS process exit, not the closure of every parent-owned stream. On this Windows/Node
  // combination explicit IPC disconnect can leave `close` undelivered despite exitCode === 1.
  const exited = new Promise<number | null>(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(null)); });
  const abort = () => { child.kill('SIGKILL'); }; t.signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error(`Worker exited before native-ready: ${stderr}`)));
      child.once('message', value => { if ((value as { type?: string }).type === 'ready') resolve(); else reject(new Error('Invalid worker lifecycle message')); });
    });
    // Keep stdin open: without the parent-death guard this worker would remain waiting forever.
    child.disconnect(); assert.equal(await exited, 1);
  } finally {
    t.signal.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited;
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
});
