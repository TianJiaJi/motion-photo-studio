import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';
import { parseTime } from '../../src/shared/editor.ts';

function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}

test('offline editor imports through native dialog, streams, steps frames, crops, selects covers and cleans up', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-editor-ui-'));
  const userData = join(directory, 'user-data');
  const input = join(directory, '测试片段.mp4'); const cover = join(directory, '自定义封面.png');
  const executable = resolve('resources/bin/ffmpeg.exe');
  const ff = (args: string[]) => runProcess(executable, ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', input]);
    await ff(['-f', 'lavfi', '-i', 'color=blue:size=240x180', '-frames:v', '1', '-update', '1', cover]);
    const sourceHash = await sha256(input); const coverHash = await sha256(cover);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    // Replace only the OS file chooser in the test main process; the production renderer still cannot supply paths.
    await instance.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => {
        const path = queue.shift(); return { canceled: !path, filePaths: path ? [path] : [] };
      };
    }, [input, cover, null, input]);
    const page = await instance.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await instance.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByTestId('start-diagnostics')).not.toBeVisible();
    await expect(page.getByText('M2 视频导入与编辑', { exact: true })).toHaveCount(0);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true });
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-ui-welcome.png') });
    await page.getByTestId('open-video').click();
    await expect(page.getByTestId('asset-name')).toHaveText('测试片段.mp4');
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    const originalUrl = await page.getByTestId('video-preview').getAttribute('src');
    expect(originalUrl).toMatch(/^media:\/\/asset\//);
    const range = await page.evaluate(async url => {
      const response = await fetch(url!, { headers: { Range: 'bytes=0-15' } });
      return { status: response.status, length: (await response.arrayBuffer()).byteLength };
    }, originalUrl);
    expect(range).toEqual({ status: 206, length: 16 });
    await page.getByLabel('精确定位', { exact: true }).fill('00:00:00.533');
    await page.getByLabel('精确定位', { exact: true }).press('Enter');
    await expect(page.getByTestId('exact-frame')).toBeVisible();
    await expect(page.getByTestId('playhead')).toHaveText('00:00:00.533');
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    await expect(page.getByTestId('playhead')).toHaveText('00:00:00.566');
    await page.getByRole('button', { name: '上一帧', exact: true }).click();
    await expect(page.getByTestId('playhead')).toHaveText('00:00:00.533');
    await page.getByRole('button', { name: '自由框选', exact: true }).click();
    const stage = page.getByTestId('crop-stage'); await stage.scrollIntoViewIfNeeded();
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8, { steps: 5 }); await page.mouse.up();
    const crop = (await page.getByTestId('crop-pixels').innerText()).match(/^(\d+) × (\d+)/)!;
    expect(Number(crop[1])).toBeLessThan(160); expect(Number(crop[1])).toBeGreaterThan(80);
    expect(Number(crop[2])).toBeLessThan(120); expect(Number(crop[2])).toBeGreaterThan(50);
    await page.getByTestId('capture-cover').click();
    await expect(page.getByTestId('cover-description')).toContainText('00:00:00.533');
    await page.getByTestId('upload-cover').click();
    await expect(page.getByTestId('cover-description')).toContainText('自定义封面.png');
    await page.getByLabel('封面适配', { exact: true }).selectOption('contain');
    await expect(page.getByTestId('cover-preview')).toHaveCSS('object-fit', 'contain');
    await page.getByLabel('截取开始', { exact: true }).fill('00:00:01.000'); await page.getByLabel('截取开始', { exact: true }).press('Enter');
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:03.000'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    await expect(page.getByTestId('clip-duration')).toHaveText('选段 00:00:02.000');
    // Native pointer capture on both trim handles, separate from the playhead.
    await page.getByRole('button', { name: '全选片段', exact: true }).click();
    const timeline = page.getByTestId('timeline');
    const track = (await timeline.boundingBox())!;
    const trimStart = page.getByTestId('trim-start'); const trimEnd = page.getByTestId('trim-end');
    const dragHandle = async (handle: typeof trimStart, toFraction: number) => {
      const rect = (await handle.boundingBox())!;
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
      await page.mouse.move(track.x + track.width * toFraction, rect.y + rect.height / 2, { steps: 10 }); await page.mouse.up();
    };
    await dragHandle(trimStart, .25); await dragHandle(trimEnd, .75);
    expect(Math.abs(Number(await trimStart.getAttribute('aria-valuenow')) - 3000000)).toBeLessThan(40000);
    expect(Math.abs(Number(await trimEnd.getAttribute('aria-valuenow')) - 9000000)).toBeLessThan(40000);
    const beforeKeyboard = Number(await trimStart.getAttribute('aria-valuenow'));
    await trimStart.focus(); await trimStart.press('ArrowRight');
    await expect(trimStart).toHaveAttribute('aria-valuenow', String(beforeKeyboard + 1000));
    // Scrubbing the white playhead must not change the selected interval.
    const beforeScrub = [await trimStart.getAttribute('aria-valuenow'), await trimEnd.getAttribute('aria-valuenow')];
    await page.mouse.click(track.x + track.width * .5, track.y + track.height / 2);
    await expect(page.getByTestId('exact-frame')).toBeVisible();
    expect([await trimStart.getAttribute('aria-valuenow'), await trimEnd.getAttribute('aria-valuenow')]).toEqual(beforeScrub);
    // Zoom/pan mapping uses viewport time, not the full duration; keyboard endpoints can restore full range.
    await page.getByLabel('时间轴缩放', { exact: true }).focus(); await page.getByLabel('时间轴缩放', { exact: true }).press('ArrowRight');
    await expect(page.getByLabel('时间轴缩放', { exact: true })).toHaveValue('1');
    const zoomEnd = (await trimEnd.boundingBox())!;
    await page.mouse.move(zoomEnd.x + zoomEnd.width / 2, zoomEnd.y + zoomEnd.height / 2); await page.mouse.down();
    await page.mouse.move(track.x + track.width * .75, zoomEnd.y + zoomEnd.height / 2, { steps: 8 }); await page.mouse.up();
    expect(Math.abs(Number(await trimEnd.getAttribute('aria-valuenow')) - 7500000)).toBeLessThan(40000);
    await page.getByRole('button', { name: '全选片段', exact: true }).click();
    await expect(trimStart).toHaveAttribute('aria-valuenow', '0'); await expect(trimEnd).toHaveAttribute('aria-valuenow', '12000000');
    // Restore the interval for the independent playback-PTS assertions below.
    await page.getByLabel('截取开始', { exact: true }).fill('00:00:01.000'); await page.getByLabel('截取开始', { exact: true }).press('Enter');
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:03.000'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    await page.getByLabel('精确定位', { exact: true }).fill('00:00:01.000'); await page.getByLabel('精确定位', { exact: true }).press('Enter');
    await expect(page.getByTestId('playhead')).toHaveText('00:00:01.000');
    await page.getByLabel('输出帧率', { exact: true }).selectOption('24');
    await page.getByLabel('分辨率', { exact: true }).selectOption('1080');
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('24');
    await page.getByLabel('保留音轨', { exact: true }).uncheck();
    // Visual playback test is muted; audible correctness remains a separate acceptance check.
    await page.getByTestId('video-preview').evaluate(node => {
      const player = node as HTMLVideoElement; player.muted = true;
      let lastPtsUs: number | undefined; let handle = 0;
      const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        lastPtsUs = Math.floor(metadata.mediaTime * 1000000);
        handle = player.requestVideoFrameCallback(observe);
      };
      handle = player.requestVideoFrameCallback(observe);
      document.querySelector('[data-testid="play-video"]')!.addEventListener('click', () => {
        // Capture independently before React's pause handler, not from application state or the wall clock.
        if (!player.paused) {
          document.body.dataset.pauseFrameUs = String(lastPtsUs);
          player.cancelVideoFrameCallback(handle);
        }
      }, { capture: true });
    });
    await page.getByTestId('play-video').click();
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(1.1);
    await page.getByTestId('play-video').click();
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    const pausedTime = await page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).currentTime);
    const displayedTime = parseTime(await page.getByTestId('playhead').innerText()) / 1000000;
    const presentedUs = Number(await page.evaluate(() => document.body.dataset.pauseFrameUs));
    expect(Number.isFinite(presentedUs)).toBe(true);
    expect(displayedTime).toBe(Math.floor(presentedUs / 1000) / 1000);
    // A submitted video frame may lead/lag currentTime; the contract is the frame PTS, not a 10 ms clock match.
    expect(Math.abs(pausedTime - displayedTime)).toBeLessThan(1 / 30 + 0.005);
    await page.getByLabel('强制兼容预览', { exact: true }).check();
    await expect(page.getByTestId('video-preview')).not.toHaveAttribute('src', originalUrl!);
    await expect(page.locator('.preview-caption strong')).toContainText('低清代理');
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.getByLabel('时间轴缩放', { exact: true }).focus(); await page.getByLabel('时间轴缩放', { exact: true }).press('ArrowRight');
    await expect(page.getByLabel('时间轴缩放', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('时间轴视口起点', { exact: true })).toBeVisible();
    await page.getByTestId('open-video').click(); // Native chooser cancellation preserves current edits.
    await expect(page.getByTestId('asset-name')).toHaveText('测试片段.mp4');
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('24');
    await expect(page.getByTestId('cover-description')).toContainText('自定义封面.png');
    await expect(page.locator('.thumbnails img')).toHaveCount(8);
    await expect.poll(() => page.locator('.thumbnails img').evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true });
    await page.locator('.editor-sidebar').evaluate(node => { node.scrollTop = 0; });
    await page.getByTestId('editor').screenshot({ path: resolve('../artifacts/desktop/m4-ui-editor.png') });
    // The default 1260x860 workspace has no body scrolling or clipped timeline. Also check compact layout.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight)).toBe(true);
    await instance.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1024, 740); });
    await expect(page.getByTestId('trim-start')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-ui-compact.png') });
    await page.getByRole('button', { name: '关闭素材', exact: true }).click();
    await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(await sha256(input)).toBe(sourceHash); expect(await sha256(cover)).toBe(coverHash);
    await page.getByTestId('open-video').click(); await expect(page.getByTestId('asset-name')).toHaveText('测试片段.mp4');
    await instance.close(); instance = undefined;
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('editor maps rotated display coordinates, previews HEVC through a proxy and gates HDR consent', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-editor-formats-'));
  const userData = join(directory, 'user-data');
  const input = join(directory, 'source.mp4'); const rotated = join(directory, 'rotated.mp4');
  const hevc = join(directory, 'HEVC.mp4'); const hdr = join(directory, 'HDR.mp4');
  const ff = (args: string[]) => runProcess(resolve('resources/bin/ffmpeg.exe'), ['-hide_banner', '-v', 'error', '-nostdin', '-n', ...args]);
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    await ff(['-display_rotation:v:0', '90', '-i', input, '-c', 'copy', rotated]);
    await ff(['-i', input, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1', '-pix_fmt', 'yuv420p10le', hevc]);
    await ff(['-i', input, '-vf', 'setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'libx264', hdr]);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    await instance.evaluate(({ dialog }, paths) => {
      const queue = [...paths]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()!] });
    }, [rotated, hevc, hdr]);
    const page = await instance.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await instance.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await page.getByTestId('open-video').click(); await expect(page.getByTestId('asset-name')).toHaveText('rotated.mp4');
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => [(node as HTMLVideoElement).videoWidth, (node as HTMLVideoElement).videoHeight])).toEqual([240, 320]);
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    await expect.poll(() => page.getByTestId('exact-frame').evaluate(node => [(node as HTMLImageElement).naturalWidth, (node as HTMLImageElement).naturalHeight])).toEqual([240, 320]);
    await page.getByRole('button', { name: '自由框选', exact: true }).click();
    await page.getByTestId('crop-stage').scrollIntoViewIfNeeded();
    const box = (await page.getByTestId('crop-stage').boundingBox())!;
    expect(Math.abs(box.width / box.height - .75)).toBeLessThan(.01);
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .25); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .75, box.y + box.height * .75, { steps: 5 }); await page.mouse.up();
    const pixels = (await page.getByTestId('crop-pixels').innerText()).match(/^(\d+) × (\d+)/)!;
    expect(Number(pixels[1])).toBeGreaterThanOrEqual(116); expect(Number(pixels[1])).toBeLessThanOrEqual(122);
    expect(Number(pixels[2])).toBeGreaterThanOrEqual(156); expect(Number(pixels[2])).toBeLessThanOrEqual(162);
    await page.locator('.editor-sidebar').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-ui-portrait.png') });
    await page.getByTestId('open-video').click(); await expect(page.getByTestId('asset-name')).toHaveText('HEVC.mp4');
    await expect(page.locator('.preview-caption strong')).toContainText('低清代理');
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
    await page.getByTestId('preview-output').click();
    const matched = page.getByRole('dialog', { name: '输出预览', exact: true });
    await expect(matched).toBeVisible(); await expect(page.getByTestId('save-motion')).toBeEnabled({ timeout: 60000 });
    await expect(page.getByTestId('output-proof')).toContainText('原画质预设');
    await expect.poll(() => page.getByTestId('output-video').evaluate(node => [(node as HTMLVideoElement).videoWidth, (node as HTMLVideoElement).videoHeight])).toEqual([320, 240]);
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
    await expect(page.getByLabel('原画质（跟随原片）', { exact: true })).toBeChecked();
    await expect(page.getByLabel('输出帧率', { exact: true })).toBeDisabled();
    await page.getByTestId('open-video').click(); await expect(page.getByTestId('asset-name')).toHaveText('HDR.mp4');
    await expect(page.getByLabel('原画质（跟随原片）', { exact: true })).not.toBeChecked();
    const consent = page.getByLabel('同意 HDR 转 SDR', { exact: true });
    await expect(consent).not.toBeChecked(); await expect(page.getByTestId('play-video')).toBeDisabled();
    await expect(page.getByTestId('video-preview')).not.toHaveAttribute('src');
    await consent.check();
    await expect(page.locator('.preview-caption strong')).toContainText('低清代理');
    await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await consent.uncheck(); await expect(page.getByTestId('play-video')).toBeDisabled();
    await expect(page.getByTestId('video-preview')).not.toHaveAttribute('src');
    await page.getByRole('button', { name: '关闭素材', exact: true }).click();
    await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
