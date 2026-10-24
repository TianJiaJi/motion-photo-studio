import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

test('offline editor imports through native dialog, paints Canvas, steps frames, crops, selects covers and cleans up', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-editor-ui-'));
  const evidenceRoot = resolve(`../artifacts/native-preview/editor-${Date.now()}`); await mkdir(evidenceRoot, {recursive:true});
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
    await page.evaluate(()=>{
      const rows:unknown[]=[];(window as any).__editorEvidence=rows;
      const record=(row:unknown)=>{rows.push(row);if(rows.length>2048)rows.shift();};
      for(const type of ['focusin','focusout','input','change','keydown','keyup','pointerdown','pointerup'])document.addEventListener(type,event=>{
        const element=event.target as HTMLInputElement;
        record({type,time:performance.now(),label:element?.getAttribute?.('aria-label'),testid:element?.dataset?.testid,value:element?.value,
          key:(event as KeyboardEvent).key,buttons:(event as PointerEvent).buttons,x:(event as PointerEvent).clientX,y:(event as PointerEvent).clientY,
          active:(document.activeElement as HTMLElement)?.getAttribute('aria-label'),playhead:document.querySelector('[data-testid="playhead"]')?.textContent});
      },true);
      window.motion.media.native.onFrame(frame=>record({type:'frame',time:performance.now(),epoch:frame.epoch,frameId:frame.frameId,timeUs:frame.timeUs}));
      window.motion.media.native.onStatus(status=>record({type:'status',time:performance.now(),...status}));
    });
    await instance.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByTestId('start-diagnostics')).not.toBeVisible();
    await expect(page.getByText('M2 视频导入与编辑', { exact: true })).toHaveCount(0);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true });
    await page.screenshot({ path: resolve('../artifacts/desktop/m4-ui-welcome.png') });
    await page.getByTestId('open-video').click();
    await expect(page.getByTestId('asset-name')).toHaveText('测试片段.mp4');
    const canvas = page.getByTestId('native-preview');
    await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    await expect(page.locator('.thumbnails img')).toHaveCount(8);
    // Original video is no longer exposed as a browser URL; bounded image resources retain Range support.
    const originalUrl = await page.locator('.thumbnails img').first().getAttribute('src');
    expect(originalUrl).toMatch(/^media:\/\/asset\//);
    const range = await page.evaluate(async url => {
      const response = await fetch(url!, { headers: { Range: 'bytes=0-15' } });
      return { status: response.status, length: (await response.arrayBuffer()).byteLength };
    }, originalUrl);
    expect(range).toEqual({ status: 206, length: 16 });
    await page.getByLabel('精确定位', { exact: true }).fill('00:00:00.533');
    await page.getByLabel('精确定位', { exact: true }).press('Enter');
    await expect(canvas).toHaveAttribute('data-time-us', '533333');
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
    await expect.poll(async () => Math.abs(Number(await canvas.getAttribute('data-time-us')) - 6000000)).toBeLessThan(40000);
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
    await expect(canvas).toHaveAttribute('data-time-us','1000000');
    const sameValueEpoch=Number(await canvas.getAttribute('data-epoch'));
    await page.getByLabel('精确定位', { exact: true }).fill('00:00:01.000');await page.getByLabel('精确定位', { exact: true }).press('Enter');
    await expect.poll(async()=>Number(await canvas.getAttribute('data-epoch'))).toBeGreaterThan(sameValueEpoch);
    await expect(canvas).toHaveAttribute('data-time-us','1000000');
    await page.getByLabel('输出帧率', { exact: true }).selectOption('24');
    await page.getByLabel('分辨率', { exact: true }).selectOption('1080');
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('24');
    await page.getByLabel('保留音轨', { exact: true }).uncheck();
    // Independently observe IPC pixel payloads and compare the actual Canvas readback, not a wall clock.
    // This muted visual check does not establish physical audio/video latency.
    await page.evaluate(() => {
      const rows: {frameId:number;timeUs:number;hash:number}[]=[];
      (window as any).__paintEvidence=rows;
      window.motion.media.native.onFrame(frame=>{
        let hash=2166136261;for(const byte of frame.pixels)hash=Math.imul(hash^byte,16777619)>>>0;
        rows.push({frameId:frame.frameId,timeUs:frame.timeUs,hash});if(rows.length>240)rows.shift();
      });
    });
    const seekField=page.getByLabel('精确定位',{exact:true});
    await expect(seekField).toHaveValue('00:00:01.000');
    await seekField.fill('00:00:01.000'); // An explicit same-value input may not fire React onChange.
    // Start real native playback without blurring the field: isolate incoming-prop/input ordering.
    // Actual pointer-capture acceptance remains in the separate native-preview tests.
    await page.getByTestId('play-video').evaluate(node=>(node as HTMLButtonElement).click());
    await expect(seekField).toBeFocused();
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1100000);
    const whileTyping=Number(await canvas.getAttribute('data-time-us'));
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(whileTyping+100000);
    await expect(seekField).toHaveValue('00:00:01.000'); // Native frame updates must not clobber an active draft.
    await seekField.press('Enter');await expect(canvas).toHaveAttribute('data-time-us','1000000');
    await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    await page.getByTestId('play-video').click();
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1100000);
    await page.getByTestId('play-video').click();
    await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    const presented = await canvas.evaluate(node=>{
      const c=node as HTMLCanvasElement;let hash=2166136261;
      for(const byte of c.getContext('2d')!.getImageData(0,0,c.width,c.height).data)hash=Math.imul(hash^byte,16777619)>>>0;
      const frameId=Number(c.dataset.frameId),timeUs=Number(c.dataset.timeUs);
      const received=(window as any).__paintEvidence.findLast((row:any)=>row.frameId===frameId);
      return {hash,timeUs,received};
    });
    expect(presented.received).toBeDefined();expect(presented.hash).toBe(presented.received.hash);expect(presented.timeUs).toBe(presented.received.timeUs);
    await expect.poll(async()=>parseTime(await page.getByTestId('playhead').innerText())).toBe(Math.floor(presented.timeUs/1000)*1000);
    await expect(page.getByTestId('video-preview')).toHaveCount(0);
    await expect(page.getByLabel('强制兼容预览', { exact: true })).toHaveCount(0);
    await expect(page.locator('.preview-caption strong')).toContainText('原片解码');
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
    await writeFile(join(evidenceRoot,'events.json'),JSON.stringify(await page.evaluate(()=>(window as any).__editorEvidence),null,2));
    await instance.close(); instance = undefined;
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(errors).toEqual([]);
  } catch(error) {
    await writeFile(join(evidenceRoot,'failure.json'),JSON.stringify({error:String(error)},null,2));
    const page=instance?.windows()[0];if(page){
      await writeFile(join(evidenceRoot,'events.json'),JSON.stringify(await page.evaluate(()=>(window as any).__editorEvidence).catch(()=>null),null,2));
      await writeFile(join(evidenceRoot,'dom.txt'),await page.locator('body').innerText().catch(()=>''));
      await page.screenshot({path:join(evidenceRoot,'failure.png')}).catch(()=>{});
    }
    throw error;
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('editor maps rotated display coordinates, previews HEVC natively and gates HDR preparation consent', async () => {
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
    const canvas=page.getByTestId('native-preview');
    await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, {timeout:60000});
    await expect.poll(()=>canvas.evaluate(node=>[(node as HTMLCanvasElement).width,(node as HTMLCanvasElement).height])).toEqual([240,320]);
    const first=await canvas.getAttribute('data-frame-id');
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    await expect(canvas).not.toHaveAttribute('data-frame-id',first!);
    await expect.poll(()=>canvas.evaluate(node=>[(node as HTMLCanvasElement).width,(node as HTMLCanvasElement).height])).toEqual([240,320]);
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
    await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, {timeout:60000});
    await expect(page.locator('.preview-caption strong')).toContainText('原生低清预览');
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
    await expect(canvas).not.toHaveAttribute('data-frame-id');
    await consent.check();
    await expect(page.locator('.preview-caption strong')).toContainText('兼容素材');
    await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, {timeout:60000});
    await consent.uncheck(); await expect(page.getByTestId('play-video')).toBeDisabled();
    await expect(canvas).not.toHaveAttribute('data-frame-id');
    await expect.poll(()=>canvas.evaluate(node=>{const c=node as HTMLCanvasElement;return c.getContext('2d')!.getImageData(0,0,c.width,c.height).data.every(byte=>byte===0);})).toBe(true);
    await expect(page.getByTestId('displayed-frame')).toHaveCount(0);
    // Re-enabling must reuse the controller's monotonic epoch and drain dropped-frame ACKs.
    await consent.check();await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, {timeout:60000});
    await expect(page.getByTestId('play-video')).toBeEnabled();
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(0);
    await page.getByRole('button', { name: '关闭素材', exact: true }).click();
    await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
