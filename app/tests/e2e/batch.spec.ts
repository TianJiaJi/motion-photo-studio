import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';

test('one export dialog handles current/all clips, owns results, preserves outputs and gives the editor a large canvas', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-batch-ui-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const input = join(directory, 'source.mp4'), output = join(directory, 'output'); await mkdir(output);
    await writeFile(join(output, 'source_片段01.jpg'), 'existing');
    await runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', input]);
    const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; env.MOTION_USER_DATA_DIR = join(directory, 'profile');
    app = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env, timeout: 60000 });
    await app.evaluate(({ dialog }, paths) => {
      const state = { directories: 0 }; (globalThis as any).__batchDialogEvidence = state;
      dialog.showOpenDialog = async (...args: any[]) => {
        const options = args.at(-1);
        if (options.properties.includes('openDirectory')) { state.directories++; return { canceled: state.directories > 2, filePaths: state.directories > 2 ? [] : [paths.output] }; }
        return { canceled: false, filePaths: [paths.input] };
      };
    }, { input, output });
    const page = await app.firstWindow(); await app.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:01.000'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    await page.getByTestId('add-clip').click();
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:02.000'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    await expect(page.locator('.editor-heading')).toHaveCount(0);
    await expect(page.locator('#editor-toolbar [data-testid=asset-name]')).toHaveText('source.mp4');
    await expect(page.locator('.editor-sidebar')).not.toContainText('输出设置');
    expect((await page.locator('.editing-main > .stage-host').boundingBox())!.height).toBeGreaterThan(280);
    const artifacts = resolve('../artifacts/desktop/workspace-refresh'); await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'editor.png') });
    await page.getByTestId('export-motion').click();
    const dialog = page.getByRole('dialog', { name: '导出实况照片' });
    await expect(dialog).toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(1);
    await page.getByTestId('source-matching').check();
    await expect(dialog).toContainText('2 个实况照片');
    await expect(dialog).toContainText('兼容编码，非无损');
    await page.screenshot({ path: join(artifacts, 'export.png') });
    await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('open-video')).toBeDisabled();
    await expect(page.getByTestId('add-clip')).toBeDisabled();
    await expect(page.getByTestId('batch-result')).toContainText('已保存 2', { timeout: 90000 });
    expect(await app.evaluate(() => (globalThis as any).__batchDialogEvidence.directories)).toBe(1);
    expect(await readFile(join(output, 'source_片段01.jpg'), 'utf8')).toBe('existing');
    const outputs = (await readdir(output)).filter(name => name !== 'source_片段01.jpg');
    expect(outputs).toEqual(['source_片段01-2.jpg', 'source_片段02.jpg']);
    for (const name of outputs) await validateMotion(join(output, name), true);
    await expect(dialog.locator('details')).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, 'results.png') });
    await dialog.getByRole('button', { name: '预览片段 1', exact: true }).click();
    await page.getByRole('button', { name: '当前片段', exact: true }).click();
    await expect(dialog).toContainText('1 个实况照片');
    await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('batch-result')).toContainText('已保存 1', { timeout: 90000 });
    const single = join(output, 'source_片段01-3.jpg'); await validateMotion(single, true);
    expect(await app.evaluate(() => (globalThis as any).__batchDialogEvidence.directories)).toBe(2);
    await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('batch-result')).toContainText('已取消导出');
    expect((await readdir(output)).length).toBe(4);
    await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await expect(page.getByTestId('batch-result')).not.toBeVisible();
    await expect(page.locator('.editor > .batch-results')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '片段 02', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('play-video').click();
    await expect.poll(async () => { const at = Number(await page.getByTestId('native-preview').getAttribute('data-time-us')); return at >= 1000000 && at < 1900000; }).toBe(true);
    await page.getByTestId('play-video').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(860, 640));
    await page.getByTestId('export-motion').click();
    const bounds = await dialog.boundingBox(); const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await expect(page.getByTestId('confirm-export-all')).toBeInViewport();
    await page.screenshot({ path: join(artifacts, 'export-small.png') });
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
