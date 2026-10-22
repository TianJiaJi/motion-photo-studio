import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { extractRange, sha256 } from '../../src/main/motion/io.ts';
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}

test('offline desktop saves validated single Motion JPGs through native chooser only and never overwrites', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-save-ui-')); const userData = join(directory, 'user-data');
  const output = join(directory, 'output'); const input = join(directory, 'source.mp4'); const cover = join(directory, 'blue.png');
  const copy = join(output, 'copy.jpg'); const encoded = join(output, '自定义实况.jpg'); const existing = join(output, 'existing.jpg');
  const executable = resolve('resources/bin/ffmpeg.exe');
  const ff = (args: string[]) => runProcess(executable, ['-v', 'error', '-nostdin', '-n', ...args]);
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(output); await writeFile(existing, 'existing user file');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=3',
      '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:open-gop=0', '-c:a', 'aac', input]);
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=80x40', '-frames:v', '1', '-update', '1', cover]);
    const before = await sha256(input); const coverBefore = await sha256(cover);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    await instance.evaluate(({ dialog }, paths) => {
      const opens = [...paths.opens]; const saves = [...paths.saves];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [opens.shift()!] });
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { defaultPath?: string; title?: string };
        if (!options.defaultPath?.endsWith('.jpg') || !options.title?.includes('不覆盖')) throw new Error('Invalid save dialog contract');
        const filePath = saves.shift(); if (filePath === undefined) throw new Error('Unexpected save dialog');
        return { canceled: filePath === null, filePath: filePath ?? '' };
      };
    }, { opens: [input, cover], saves: [null, existing, copy, encoded] });
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await page.evaluate(() => { window.motion.media.onExportProgress(p => { if (p.saveId) { document.body.dataset.saveId = p.saveId; document.body.dataset.saveAsset = p.assetId; } }); });
    await page.getByTestId('open-video').click();
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
    await page.getByTestId('export-motion').click();
    const preview = page.getByRole('dialog', { name: '输出预览', exact: true }); await expect(preview).toBeVisible({ timeout: 60000 });
    await page.getByTestId('save-motion').click(); await expect(preview.getByRole('status')).toContainText('已取消保存位置选择');
    expect(await readdir(output)).toEqual(['existing.jpg']);
    await page.getByTestId('save-motion').click(); await expect(preview.getByRole('alert')).toContainText('目标文件已存在');
    expect(await readFile(existing, 'utf8')).toBe('existing user file');
    await page.getByTestId('save-motion').click(); await expect(page.getByTestId('save-result')).toContainText('已保存 copy.jpg');
    const first = await validateMotion(copy, true); expect(first.metadata.timestampUs).toBe(0); expect(first.exif[0]?.xiaomiFlag).toBe(1);
    // Query the retained receipt after completion: the cancellation channel must acknowledge an already committed save.
    const receipt = await page.evaluate(async () => window.motion.media.cancel({ assetId: document.body.dataset.saveAsset!, saveId: document.body.dataset.saveId! }));
    expect(receipt.ok && receipt.value.saved?.name).toBe('copy.jpg');
    const forged = await page.evaluate(async ids => window.motion.media.saveDraft({ assetId: document.body.dataset.saveAsset!, draftId: ids.draft, saveId: ids.save }), { draft: randomUUID(), save: randomUUID() });
    expect(forged.ok).toBe(false); if (!forged.ok) expect(forged.error.code).toBe('INVALID_REQUEST');
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await page.getByLabel('原画质（跟随原片）', { exact: true }).uncheck(); await page.getByTestId('upload-cover').click();
    await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    await page.getByTestId('export-motion').click(); await expect(preview).toBeVisible({ timeout: 60000 });
    await page.getByTestId('save-motion').click(); await expect(page.getByTestId('save-result')).toContainText('已保存 自定义实况.jpg');
    const second = await validateMotion(encoded, true); expect(second.metadata.timestampUs).toBe(-1);
    for (const [path, report, name] of [[copy, first, 'copy.mp4'], [encoded, second, 'encoded.mp4']] as const) {
      const video = join(directory, name); await extractRange(path, video, report.videoStart, report.videoEnd);
      await ff(['-xerror', '-err_detect', 'explode', '-i', video, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    }
    await mkdir(resolve('../artifacts/desktop'), { recursive: true }); await page.screenshot({ path: resolve('../artifacts/desktop/m4-saved.png') });
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
    expect((await readdir(output)).sort()).toEqual(['copy.jpg', 'existing.jpg', '自定义实况.jpg']);
    expect(await readdir(join(userData, 'publications'))).toEqual([]); expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(await sha256(input)).toBe(before); expect(await sha256(cover)).toBe(coverBefore); expect(pageErrors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
