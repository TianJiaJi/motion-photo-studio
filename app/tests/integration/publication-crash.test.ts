import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { tempFiles } from '../helpers.ts';
import { Publications } from '../../src/main/jobs/publications.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { ffmpeg, runProcess } from '../../src/main/media/runner.ts';
import { extractRange, sha256 } from '../../src/main/motion/io.ts';

for (const phase of ['before', 'after']) test(`real publisher process termination ${phase} commit recovers owned scratch without pseudo-success`, { timeout: 45000 }, async t => {
  const temp = await tempFiles();
  try {
    const outputDir = temp.file('output'); await mkdir(outputDir); const root = temp.file('journal');
    const cover = temp.file('cover.jpg'); const video = temp.file('video.mp4'); const output = `${outputDir}/final.jpg`;
    const sentinel = `${outputDir}/user-file.jpg`; await writeFile(sentinel, 'never delete this');
    await sharp({ create: { width: 160, height: 120, channels: 3, background: '#408080' } }).withIccProfile('srgb').jpeg().toFile(cover);
    await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const beforeCover = await sha256(cover); const beforeVideo = await sha256(video);
    const child = fork(fileURLToPath(new URL('../../scripts/publication-crash-fixture.ts', import.meta.url)),
      [root, cover, video, output, phase], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stdout?.resume(); child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-8192); });
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    const abort = () => { child.kill('SIGKILL'); }; t.signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject); child.once('exit', () => reject(new Error(`Checkpoint exited before signal: ${stderr}`)));
        child.once('message', value => {
          const message = value as { phase?: string; message?: string };
          if (message.phase === phase) resolve(); else reject(new Error(`Checkpoint error: ${message.message ?? JSON.stringify(value)}`));
        });
      });
      assert.equal((await readdir(root)).length, 1, 'durable recovery intent exists before interruption');
      assert.equal(child.kill('SIGKILL'), true); assert.notEqual(await closed, 0);
    } finally {
      t.signal.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;
    }
    assert.deepEqual(await new Publications(root).initialize(), []); assert.deepEqual(await readdir(root), []);
    assert.equal(await readFile(sentinel, 'utf8'), 'never delete this');
    if (phase === 'before') {
      await assert.rejects(access(output), { code: 'ENOENT' }); assert.deepEqual(await readdir(outputDir), ['user-file.jpg']);
    } else {
      const report = await validateMotion(output, true); const extracted = temp.file('extracted.mp4');
      await extractRange(output, extracted, report.videoStart, report.videoEnd); assert.equal(await sha256(extracted), beforeVideo);
      await runProcess(ffmpeg(), ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', extracted, '-map', '0:v', '-f', 'null', '-']);
      await sharp(output).stats(); assert.deepEqual((await readdir(outputDir)).sort(), ['final.jpg', 'user-file.jpg']);
    }
    assert.equal(await sha256(cover), beforeCover); assert.equal(await sha256(video), beforeVideo);
  } finally { await temp.cleanup(); }
});
