import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../../src/main/motion/io.ts';

test('single-photo export uses the shared trusted directory flow with cancellation, no overwrite and committed receipts', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-save-ui-')), userData = join(directory, 'user-data');
  const output = join(directory, 'output'), input = join(directory, 'source.mp4'), cover = join(directory, 'blue.png');
  const existing = join(output, 'source_片段01.jpg'), copy = join(output, 'source_片段01-2.jpg'), encoded = join(output, 'source_片段01-3.jpg');
  const ff = (args: string[]) => runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', ...args]);
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(output); await writeFile(existing, 'existing user file');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=3',
      '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0', '-c:a', 'aac', input]);
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=80x40', '-frames:v', '1', '-update', '1', cover]);
    const before = await sha256(input), coverBefore = await sha256(cover);
    const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
    env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData;
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env, timeout: 60000 });
    await instance.evaluate(({ dialog }, paths) => {
      const opens = [paths.input, paths.cover]; let calls = 0;
      dialog.showSaveDialog = async () => { throw new Error('Single export must use the shared directory flow'); };
      dialog.showOpenDialog = async (...args: any[]) => {
        if (args.at(-1).properties.includes('openDirectory')) { calls++; return { canceled: calls === 1, filePaths: calls === 1 ? [] : [paths.output] }; }
        return { canceled: false, filePaths: [opens.shift()!] };
      };
    }, { input, cover, output });
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await page.evaluate(() => window.motion.media.onExportProgress(p => { if (p.batch) { document.body.dataset.saveBatch = p.batch.batchId; document.body.dataset.saveAsset = p.assetId; } }));
    await page.getByTestId('open-video').click();
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    await page.getByTestId('export-motion').click(); await page.getByTestId('source-matching').check();
    const dialog = page.getByRole('dialog', { name: '导出实况照片', exact: true });
    await page.getByRole('button', { name: '当前片段', exact: true }).click();
    await page.getByTestId('confirm-export-all').click(); await expect(page.getByTestId('batch-result')).toContainText('已取消导出');
    expect(await readdir(output)).toEqual(['source_片段01.jpg']);
    await page.getByTestId('confirm-export-all').click(); await expect(page.getByTestId('batch-result')).toContainText('source_片段01-2.jpg', { timeout: 60000 });
    expect(await readFile(existing, 'utf8')).toBe('existing user file');
    const first = await validateMotion(copy, true); expect(first.metadata.timestampUs).toBe(0); expect(first.exif[0]?.xiaomiFlag).toBe(1);
    const receipt = await page.evaluate(() => window.motion.media.cancel({ assetId: document.body.dataset.saveAsset!, batchId: document.body.dataset.saveBatch! }));
    expect(receipt.ok && receipt.value.batch?.saved[0]?.name).toBe('source_片段01-2.jpg');
    const forged = await page.evaluate(ids => window.motion.media.saveDraft({ assetId: document.body.dataset.saveAsset!, draftId: ids.draft, saveId: ids.save }), { draft: randomUUID(), save: randomUUID() });
    expect(forged.ok).toBe(false); if (!forged.ok) expect(forged.error.code).toBe('INVALID_REQUEST');
    await page.getByTestId('source-matching').uncheck(); await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await page.getByTestId('upload-cover').click(); await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    await page.getByTestId('export-motion').click(); await expect(dialog).toBeVisible();
    await page.getByTestId('confirm-export-all').click(); await expect(page.getByTestId('batch-result')).toContainText('source_片段01-3.jpg', { timeout: 60000 });
    const second = await validateMotion(encoded, true); expect(second.metadata.timestampUs).toBe(-1);
    for (const [path, report, name] of [[copy, first, 'copy.mp4'], [encoded, second, 'encoded.mp4']] as const) {
      const video = join(directory, name); await extractRange(path, video, report.videoStart, report.videoEnd);
      await ff(['-xerror', '-err_detect', 'explode', '-i', video, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    }
    await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
    expect((await readdir(output)).sort()).toEqual(['source_片段01-2.jpg', 'source_片段01-3.jpg', 'source_片段01.jpg']);
    expect(await readdir(join(userData, 'publications'))).toEqual([]); expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(await sha256(input)).toBe(before); expect(await sha256(cover)).toBe(coverBefore); expect(errors).toEqual([]);
  } finally { await instance?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
