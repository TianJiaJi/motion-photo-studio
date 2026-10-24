import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}
test('multi-audio UI requires a track choice or explicit omission and never silently defaults to first track', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-audio-choice-')); const userData = join(directory, 'user-data'); const input = join(directory, 'multi.mp4');
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const before = await sha256(input);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    await instance.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, input);
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    const tracks = page.getByLabel('所保留的音轨', { exact: true }); await expect(tracks).toHaveValue('');
    await expect(page.getByLabel('保留音轨', { exact: true })).toBeChecked();
    await page.getByTestId('preview-output').click(); await expect(page.getByRole('alert')).toContainText('请选择要保留的音轨');
    await expect(page.getByTestId('export-inspection')).toHaveCount(0);
    const preview = page.getByRole('dialog', { name: '输出预览', exact: true }); await expect(preview).toBeVisible();
    await expect(page.getByTestId('save-motion')).toBeDisabled();
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await tracks.selectOption('2'); await page.getByTestId('preview-output').click(); await expect(preview).toBeVisible({ timeout: 60000 });
    await preview.getByText('处理说明', { exact: true }).click(); await expect(preview).toContainText('按明确选择保留音轨 2');
    await expect(page.getByTestId('output-proof')).toContainText('精确模式');
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await page.getByLabel('保留音轨', { exact: true }).uncheck(); await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
    await page.getByTestId('preview-output').click(); await expect(preview).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('output-proof')).toContainText('原画质预设');
    await preview.getByText('处理说明', { exact: true }).click(); await expect(preview).toContainText('已明确选择不保留音轨');
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]); expect(await sha256(input)).toBe(before); expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
