import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { publishMotionPhoto } from '../../src/main/motion/publish.ts';
import { openSource } from '../../src/main/media/source.ts';
import { ffmpeg, runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';

test('real Windows exclusive file lock leaves a recoverable owned stage and never a false final JPG', { timeout: 45000, skip: process.platform !== 'win32' }, async t => {
  const temp = await tempFiles();
  let locker: ReturnType<typeof spawn> | undefined; let closed: Promise<number | null> | undefined;
  const abort = () => { locker?.kill('SIGKILL'); }; t.signal.addEventListener('abort', abort, { once: true });
  try {
    const outputDir = temp.file('output'); await mkdir(outputDir); const output = join(outputDir, 'final.jpg');
    const cover = temp.file('cover.jpg'); const video = temp.file('video.mp4');
    await sharp({ create: { width: 160, height: 120, channels: 3, background: '#408080' } }).withIccProfile('srgb').jpeg().toFile(cover);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const coverBefore = await sha256(cover); const videoBefore = await sha256(video);
    const journal = new Publications(temp.file('journal')); await journal.initialize();
    await assert.rejects(publishMotionPhoto({ cover: await openSource(cover), video: await openSource(video), output, timestampUs: 0, videoDurationUs: 3000000,
      journal, signal: new AbortController().signal, onStage: async stage => {
        if (stage !== 'read-back') return;
        const [recordName] = await readdir(journal.root); const record = JSON.parse(await readFile(join(journal.root, recordName!), 'utf8')) as { directory: string };
        const path = join(record.directory, 'container.part').replaceAll("'", "''");
        const command = `$ErrorActionPreference='Stop';$s=[IO.File]::Open('${path}','Open','Read','None');try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$s.Dispose()}`;
        const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        locker = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        closed = new Promise(resolve => locker!.once('close', code => resolve(code)));
        let stdout = ''; let stderr = ''; locker.stdin?.on('error', () => {});
        await new Promise<void>((resolve, reject) => {
          locker!.once('error', reject); locker!.once('exit', () => reject(new Error(`Lock helper exited before acquisition: ${stderr}`)));
          locker!.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
          locker!.stdout?.on('data', data => { stdout = (stdout + String(data)).slice(-4096); if (stdout.includes('LOCKED')) resolve(); });
        });
      } }), { code: 'TEMP_CLEANUP' });
    await assert.rejects(access(output), { code: 'ENOENT' }); assert.equal((await readdir(journal.root)).length, 1);
    locker!.stdin!.end('\n'); assert.equal(await closed, 0); locker = undefined;
    assert.deepEqual(await journal.initialize(), []); assert.deepEqual(await readdir(journal.root), []); assert.deepEqual(await readdir(outputDir), []);
    assert.equal(await sha256(cover), coverBefore); assert.equal(await sha256(video), videoBefore);
  } finally {
    t.signal.removeEventListener('abort', abort);
    if (locker && locker.exitCode === null && locker.signalCode === null) locker.kill('SIGKILL'); if (closed) await closed;
    await temp.cleanup();
  }
});
