import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';

test('one timeline holds independent range selectors, including overlapping clips, covers, crops and EOF additions', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-clips-ui-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const input = join(directory, 'source.mp4'), cover = join(directory, 'blue.png');
    const ff = resolve('resources/bin/ffmpeg.exe');
    await runProcess(ff, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', input]);
    await runProcess(ff, ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=blue:size=100x100', '-frames:v', '1', '-update', '1', cover]);
    const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    env.MOTION_USER_DATA_DIR = join(directory, 'profile');
    app = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env, timeout: 60000 });
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths]; dialog.showOpenDialog = async () => { const next = queue.shift(); return { canceled: !next, filePaths: next ? [next] : [] }; };
    }, [input, cover]);
    const page = await app.firstWindow(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); await app.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    const expectSingleTimeline = async (count: number) => {
      await expect(page.getByTestId('timeline')).toHaveCount(1);
      await expect(page.getByTestId('trim-timeline')).toHaveCount(1);
      await expect(page.locator('.time-ticks')).toHaveCount(1);
      await expect(page.locator('.thumbnails')).toHaveCount(1);
      await expect(page.getByTestId('timeline-playhead')).toHaveCount(1);
      await expect(page.getByTestId('clip-range')).toHaveCount(count);
      await expect(page.locator('.clip-range .trim-handle')).toHaveCount(count * 2);
      await expect(page.getByTestId('clip-row')).toHaveCount(0);
      expect(await page.getByTestId('clip-range').evaluateAll(nodes => {
        const track = document.querySelector('.timeline-track')!.getBoundingClientRect();
        return nodes.every(node => { const rect = node.getBoundingClientRect(); return rect.y === track.y && rect.height === track.height; });
      })).toBe(true);
    };
    // Keep physical desktop pointer activity from canceling CDP's captured drag.
    const desktopLeft=await app.evaluate(({BrowserWindow,screen})=>{
      const window=BrowserWindow.getAllWindows()[0]!,bounds=window.getBounds();
      const left=Math.min(...screen.getAllDisplays().map(display=>display.bounds.x));
      window.setPosition(left-bounds.width-256,bounds.y,false);return left;
    });
    // Windows applies the native move asynchronously; don't begin gestures until it lands.
    await expect.poll(()=>app!.evaluate(({BrowserWindow},left)=>{const b=BrowserWindow.getAllWindows()[0]!.getBounds();return b.x+b.width<left;},desktopLeft)).toBe(true);
    await expectSingleTimeline(1);
    const originalHeight = (await page.getByTestId('timeline').boundingBox())!.height;
    await expect(page.getByRole('button', { name: '删除片段 1', exact: true })).toBeDisabled();
    await page.getByTestId('upload-cover').click(); await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    await page.getByRole('button', { name: '自由框选', exact: true }).click();
    const box = (await page.getByTestId('crop-stage').boundingBox())!;
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8, { steps: 5 }); await page.mouse.up();
    const firstCrop = await page.getByTestId('crop-pixels').innerText(); expect(firstCrop).not.toMatch(/^160 × 120/);
    await page.getByLabel('精确定位', { exact: true }).fill('00:00:02.000'); await page.getByLabel('精确定位', { exact: true }).press('Enter');
    await expect(page.getByTestId('playhead')).toHaveText('00:00:02.000');
    await page.getByTestId('add-clip').click(); await expectSingleTimeline(2);
    await expect(page.getByLabel('截取开始', { exact: true })).toHaveValue('00:00:02.000');
    await expect(page.getByLabel('截取结束', { exact: true })).toHaveValue('00:00:05.000');
    await expect(page.getByTestId('crop-pixels')).toHaveText('160 × 120 · x 0 / y 0');
    await expect(page.getByTestId('cover-preview')).toHaveCount(0);
    // Keyboard/pointer activation must edit the grabbed range, not whichever clip was active.
    const firstStart = page.getByRole('slider', { name: '片段 1 入点', exact: true });
    await firstStart.focus(); await firstStart.press('ArrowRight');
    await expect(page.getByLabel('截取开始', { exact: true })).toHaveValue('00:00:00.001');
    await expect(page.getByRole('slider', { name: '片段 2 入点', exact: true })).toHaveAttribute('aria-valuenow', '2000000');
    const secondStart = page.getByRole('slider', { name: '片段 2 入点', exact: true });
    const handle = (await secondStart.boundingBox())!, track = (await page.getByTestId('timeline').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(track.x + track.width * .4, handle.y + handle.height / 2, { steps: 5 }); await page.mouse.up();
    expect(Math.abs(Number(await secondStart.getAttribute('aria-valuenow')) - 2_400_000)).toBeLessThan(40000);
    await expect(firstStart).toHaveAttribute('aria-valuenow', '1000');
    await expect(page.getByRole('button', { name: '片段 02', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // A real handle drag leaves focus on the slider: Space must transport, not disappear.
    await expect(secondStart).toBeFocused();
    const rangesBefore=await page.locator('.trim-handle').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-valuenow')));
    const beforePlay=Number(await page.getByTestId('native-preview').getAttribute('data-time-us'));
    await page.keyboard.down('Space');await expect(page.getByTestId('play-video')).toHaveText('暂停');
    await expect.poll(async()=>Number(await page.getByTestId('native-preview').getAttribute('data-time-us'))).toBeGreaterThan(beforePlay+100000);
    await page.keyboard.down('Space');await expect(page.getByTestId('play-video')).toHaveText('暂停');await page.keyboard.up('Space');
    await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    expect(await page.locator('.trim-handle').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-valuenow')))).toEqual(rangesBefore);
    await page.getByTestId('export-motion').click();
    await page.getByLabel('输出帧率', { exact: true }).selectOption('24');
    await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await page.getByRole('button', { name: '片段 01', exact: true }).click();
    await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    await expect(page.getByTestId('crop-pixels')).toHaveText(firstCrop);
    await page.getByTestId('export-motion').click();
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('24');
    await page.getByTestId('source-matching').check(); await expect(page.getByTestId('crop-pixels')).toHaveText('160 × 120 · x 0 / y 0');
    await page.getByTestId('source-matching').uncheck(); await expect(page.getByTestId('crop-pixels')).toHaveText(firstCrop);
    await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await page.getByRole('button', { name: '片段 02', exact: true }).click();
    await page.getByLabel('截取结束', { exact: true }).fill('00:00:06.000'); await page.getByLabel('截取结束', { exact: true }).press('Enter');
    await page.getByTestId('add-clip').click();
    await expect(page.getByLabel('截取开始', { exact: true })).toHaveValue('00:00:03.000');
    await expect(page.getByLabel('截取结束', { exact: true })).toHaveValue('00:00:06.000');
    for (let count = 3; count < 20; count++) await page.getByTestId('add-clip').click();
    await expectSingleTimeline(20);
    expect((await page.getByTestId('timeline').boundingBox())!.height).toBe(originalHeight);
    await expect(page.locator('.thumbnails img')).toHaveCount(8);
    await page.getByRole('button', { name: '删除片段 2', exact: true }).click();
    await expectSingleTimeline(19);
    await page.getByTestId('add-clip').click(); await expect(page.getByRole('button', { name: '片段 21', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '片段 01', exact: true }).click();
    await expect(page.getByTestId('cover-description')).toContainText('blue.png');
    expect(errors).toEqual([]);
    await expect(page.locator('.editor-status .error')).toHaveCount(0);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
