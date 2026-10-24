import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}

test('desktop switches effective modes, restores edits and actually renders verified private video/JPEG drafts offline', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-export-ui-')); const userData = join(directory, 'user-data');
  const input = join(directory, 'source.mp4'); const uploaded = join(directory, 'blue.png');
  const ff = (args: string[]) => runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', ...args]);
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let nativeErrors = '';
  try {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=6',
      '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:bframes=3', '-c:a', 'aac', input]);
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=80x40', '-frames:v', '1', '-update', '1', uploaded]);
    const before = await sha256(input); const coverHash = await sha256(uploaded);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    instance.process().stderr?.on('data', chunk => { nativeErrors = (nativeErrors + String(chunk)).slice(-65536); });
    await instance.evaluate(({ dialog }, paths) => { const queue = [...paths]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()!] }); }, [input, uploaded]);
    const page = await instance.firstWindow(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await instance.context().setOffline(true); await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await page.getByTestId('open-video').click();
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    await page.getByRole('button', { name: '自由框选', exact: true }).click();
    const box = (await page.getByTestId('crop-stage').boundingBox())!;
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8, { steps: 8 }); await page.mouse.up();
    const crop = await page.getByTestId('crop-pixels').innerText();
    await page.getByLabel('输出帧率', { exact: true }).selectOption('24'); await page.getByLabel('分辨率', { exact: true }).selectOption('720');
    await page.getByLabel('截取开始', { exact: true }).fill('00:00:02.200'); await page.getByLabel('截取开始', { exact: true }).press('Enter');
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:03.200'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    const copy = page.getByLabel('原画质（跟随原片）', { exact: true }); await copy.check();
    for (const label of ['输出帧率', '分辨率', '画质 CRF']) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '自由框选', exact: true })).toBeDisabled();
    await expect(page.getByTestId('crop-box')).toHaveCount(0); await expect(page.getByTestId('crop-pixels')).toContainText('160 × 120');
    await page.getByTestId('preview-output').click();
    const preview = page.getByRole('dialog', { name: '输出预览', exact: true }); await expect(preview).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('actual-interval')).toHaveText('实际 00:00:02.200 — 00:00:03.200');
    await expect(page.getByTestId('output-proof')).toContainText('原画质预设');
    await expect(page.getByTestId('output-proof')).toContainText('非严格无损');
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => [(node as HTMLVideoElement).videoWidth, (node as HTMLVideoElement).videoHeight])).toEqual([160, 120]);
    await expect.poll(() => page.getByTestId('output-cover').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(160);
    await expect(page.getByTestId('audio-tail')).toHaveCount(0);
    const firstDraft = await page.getByTestId('output-video').getAttribute('src'); expect(firstDraft).toMatch(/^media:\/\/asset\//);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true });
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-copy-draft.png') });
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click(); await copy.uncheck();
    await expect(page.getByTestId('crop-pixels')).toHaveText(crop); await expect(page.getByTestId('crop-box')).toHaveCount(1);
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('24'); await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('720');
    await expect(page.getByLabel('画质 CRF', { exact: true })).toHaveValue('23');
    await page.getByTestId('upload-cover').click(); await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    await page.getByLabel('封面适配', { exact: true }).selectOption('contain');
    await page.getByTestId('preview-output').click(); await expect(preview).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('output-proof')).toContainText('精确模式：视频已重新编码');
    await expect(preview).toContainText('独立封面，无对应视频帧');
    const dimensions = crop.match(/^(\d+) × (\d+)/)!;
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => [(node as HTMLVideoElement).videoWidth, (node as HTMLVideoElement).videoHeight])).toEqual([Number(dimensions[1]), Number(dimensions[2])]);
    expect(await page.evaluate(async url => (await fetch(url!)).status, firstDraft)).toBe(404);
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-encoded-draft.png') });
    await page.getByTestId('output-video').evaluate(async node => { const video = node as HTMLVideoElement; video.muted = true; await video.play(); });
    await page.keyboard.press('Escape'); await expect(preview).not.toBeVisible();
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await page.getByRole('button', { name: '关闭素材', exact: true }).click();
    // A click starts the async IPC handler; the editor disappears only after close() has awaited cleanup.
    await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(await sha256(input)).toBe(before); expect(await sha256(uploaded)).toBe(coverHash); expect(errors).toEqual([]);
  } finally {
    if (/Local (draft rendering|export analysis) failed:/.test(nativeErrors)) console.log('Test main-process diagnostics:', nativeErrors);
    if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
