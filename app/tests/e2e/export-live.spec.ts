import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';

test('space toggles playback without stealing forms; every export clip previews instantly on one native canvas', async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), 'motion-live-export-')), source = join(dir, 'source.mp4'), blue = join(dir, 'blue.png');
  const userData = join(dir, 'profile'); let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const ff = (args: string[]) => runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v','error','-nostdin','-n',...args]);
    await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=6','-f','lavfi','-i','sine=sample_rate=48000:duration=6','-c:v','libx264','-preset','ultrafast','-c:a','aac','-ac','2',source]);
    await ff(['-f','lavfi','-i','color=blue:size=80x40','-frames:v','1','-update','1',blue]);
    const sourceHash = await sha256(source);
    const env = Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined));
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; env.MOTION_USER_DATA_DIR=userData;
    app = await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env,timeout:60000});
    await app.evaluate(({dialog},files)=>{const queue=[...files];dialog.showOpenDialog=async()=>({canceled:false,filePaths:[queue.shift()!]});},[source,blue]);
    const page=await app.firstWindow();await app.context().setOffline(true);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});await page.getByTestId('open-video').click();
    const canvas=page.getByTestId('native-preview');await expect(canvas).toHaveAttribute('data-frame-id',/\d+/,{timeout:60000});
    await expect(page.locator('.thumbnails img')).toHaveCount(8,{timeout:30000});
    await page.getByTestId('crop-stage').focus();await page.keyboard.down('Space');
    await expect(page.getByTestId('play-video')).toHaveText('暂停');
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(100000);
    await page.keyboard.down('Space');await expect(page.getByTestId('play-video')).toHaveText('暂停');await page.keyboard.up('Space');
    await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    await page.getByTestId('add-clip').focus();await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('暂停');
    await expect(page.locator('.clip-tab')).toHaveCount(1);await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    const time=page.getByLabel('精确定位',{exact:true});await time.focus();await page.keyboard.press('Space');
    await expect(page.getByTestId('play-video')).toHaveText('播放选段');await time.fill('00:00:00.000');await time.press('Enter');
    await expect(canvas).toHaveAttribute('data-time-us','0');
    await page.getByRole('button',{name:'自由框选',exact:true}).click();
    const cropBox=(await page.getByTestId('crop-stage').boundingBox())!;
    await page.mouse.move(cropBox.x+cropBox.width*.4,cropBox.y+cropBox.height*.1);await page.mouse.down();
    await page.mouse.move(cropBox.x+cropBox.width*.6,cropBox.y+cropBox.height*.8,{steps:5});await page.mouse.up();
    await expect(page.getByTestId('crop-stage')).toBeFocused(); // Includes the overlay's pointer handler, not just its parent.
    const crop=(await page.getByTestId('crop-pixels').innerText()).match(/^(\d+) × (\d+)/)!;
    await page.getByTestId('upload-cover').click();const customCover=await page.getByTestId('cover-preview').getAttribute('src');
    for(let n=1;n<=4;n++) {
      if(n>1)await page.getByTestId('add-clip').click();
      const end=page.getByLabel('截取结束',{exact:true});await end.fill(`00:00:0${n}.000`);await end.press('Enter');
    }
    await expect(page.getByTestId('playhead')).toHaveText('00:00:04.000');
    await expect(canvas).toHaveAttribute('data-time-us','3966666');
    const editFrame = await canvas.getAttribute('data-time-us');
    const editStart=await page.getByLabel('截取开始',{exact:true}).inputValue(), editEnd=await page.getByLabel('截取结束',{exact:true}).inputValue();
    await app.evaluate(()=>{
      const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn;(globalThis as any).__livePreviewProcesses=[];
      cp.spawn=((...args:Parameters<typeof original>)=>{(globalThis as any).__livePreviewProcesses.push(String(args[0]));return Reflect.apply(original,cp,args);}) as typeof original;
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    });
    await page.getByTestId('export-motion').click();const dialog=page.getByRole('dialog',{name:'导出实况照片',exact:true});
    await expect(dialog).toBeVisible();await expect(page.locator('canvas[data-testid=native-preview]')).toHaveCount(1);await expect(page.locator('video')).toHaveCount(0);
    await expect(dialog.locator('details')).toHaveCount(0);await expect(dialog).not.toContainText('查看校验与处理详情');
    const close=dialog.getByRole('button',{name:'关闭导出',exact:true});const cb=(await close.boundingBox())!,icon=(await close.locator('svg').boundingBox())!;
    expect(Math.abs(cb.x+cb.width/2-icon.x-icon.width/2)).toBeLessThan(.6);expect(Math.abs(cb.y+cb.height/2-icon.y-icon.height/2)).toBeLessThan(.6);
    for(let n=1;n<=4;n++) {
      await dialog.getByRole('button',{name:`预览片段 ${n}`,exact:true}).click();
      await expect(canvas).toHaveAttribute('data-time-us',String((n-1)*1000000));
      await expect(page.getByTestId('export-preview-time')).toHaveText('00:00:00.000 / 00:00:01.000');
      if(n===1) {
        await expect(page.getByTestId('export-cover-preview')).toHaveAttribute('src',customCover!);
        const b=(await page.getByTestId('export-preview-stage').boundingBox())!;expect(Math.abs(b.width/b.height-Number(crop[1])/Number(crop[2]))).toBeLessThan(.01);
        const coverBox=(await dialog.locator('.export-cover-image').boundingBox())!;expect(coverBox.height).toBeLessThanOrEqual(154);expect(Math.abs(coverBox.width/coverBox.height-Number(crop[1])/Number(crop[2]))).toBeLessThan(.01);
      } else await expect(page.getByTestId('export-cover-preview')).toHaveAttribute('src',/^data:image\/png/);
      const coverBefore=await page.getByTestId('export-cover-preview').getAttribute('src');
      await page.keyboard.press('Space');await expect(page.getByTestId('export-play')).toHaveText('暂停');
      await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan((n-1)*1000000+100000);
      await expect(page.getByTestId('export-play')).toHaveText('播放',{timeout:5000});
      expect(Number(await canvas.getAttribute('data-time-us'))).toBeLessThan(n*1000000);
      expect(await page.getByTestId('export-cover-preview').getAttribute('src')).toBe(coverBefore);
    }
    // Natural end replays from this segment's start; switching while playing fences late frames.
    await page.getByTestId('export-play').click();await expect(page.getByTestId('export-play')).toHaveText('暂停');
    await dialog.getByRole('button',{name:'预览片段 2',exact:true}).click();await expect(canvas).toHaveAttribute('data-time-us','1000000');
    await expect(page.getByTestId('export-play')).toHaveText('播放');
    const slider=page.getByLabel('片段预览进度',{exact:true});await slider.evaluate(node=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,'1999000');node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));});
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1900000);
    expect(Number(await canvas.getAttribute('data-time-us'))).toBeLessThan(2000000);
    expect(await app.evaluate(()=>(globalThis as any).__livePreviewProcesses)).toEqual([]);
    const images=resolve('../artifacts/desktop/export-live');await mkdir(images,{recursive:true});await page.screenshot({path:join(images,'four-clips.png')});
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(canvas).toHaveAttribute('data-time-us',editFrame!);await expect(page.getByTestId('playhead')).toHaveText('00:00:04.000');
    await expect(page.getByRole('button',{name:'片段 04',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(page.getByLabel('截取开始',{exact:true})).toHaveValue(editStart);await expect(page.getByLabel('截取结束',{exact:true})).toHaveValue(editEnd);
    await page.getByTestId('play-video').focus();await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('暂停');
    await page.keyboard.press('Space');await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await sha256(source)).toBe(sourceHash);expect(errors).toEqual([]);
  } finally { await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
});
