import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256, extractRange } from '../../src/main/motion/io.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { probeMedia } from '../../src/main/media/probe.ts';

test('clip inspector centers safely, edits boundaries, preserves in-points in batch and exports synchronized crops', async () => {
  test.setTimeout(180000);
  const dir=await mkdtemp(join(tmpdir(),'motion-inspector-')), userData=join(dir,'profile');
  const source=join(dir,'source.mp4'),cover=join(dir,'blue.png'),output=join(dir,'output');
  const ff=(args:string[])=>runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n',...args]);
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try {
    await mkdir(output);
    await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=12','-c:v','libx264','-preset','ultrafast',source]);
    await ff(['-f','lavfi','-i','color=blue:size=80x40','-frames:v','1','-update','1',cover]);
    const hashes=await Promise.all([sha256(source),sha256(cover)]);
    const env=Object.fromEntries(Object.entries(process.env).filter((r):r is [string,string]=>r[1]!==undefined));
    delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;env.MOTION_USER_DATA_DIR=userData;
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env,timeout:60000});
    await app.evaluate(({dialog},paths)=>{const opens=[paths.source,paths.cover];dialog.showOpenDialog=async(...args:any[])=>({canceled:false,filePaths:[args.at(-1).properties.includes('openDirectory')?paths.output:opens.shift()!]});},{source,cover,output});
    const page=await app.firstWindow();await app.context().setOffline(true);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});await page.getByTestId('open-video').click();
    const canvas=page.getByTestId('native-preview');await expect(canvas).toHaveAttribute('data-time-us','0',{timeout:60000});
    await expect(page.getByLabel('保留音轨',{exact:true})).toHaveCount(0);
    await expect(page.getByTestId('inspector-duration')).toHaveText('12.00 秒');
    await expect(page.locator('.clip-tab .clip-length')).toHaveText('12.00s');
    const card=page.getByTestId('clip-inspector'),side=page.locator('.editor-sidebar');
    await expect.poll(async()=>{const a=(await card.boundingBox())!,b=(await side.boundingBox())!;return Math.abs(a.y+a.height/2-b.y-b.height/2);}).toBeLessThan(2);
    expect((await page.getByTestId('inspector-cover-stage').boundingBox())!.width).toBeGreaterThan(220);
    const artifacts=resolve('../artifacts/desktop/inspector');await mkdir(artifacts,{recursive:true});
    await page.screenshot({path:join(artifacts,'default.png')});
    await page.getByTestId('jump-clip-end').click();await expect(canvas).toHaveAttribute('data-time-us','11966666');
    await expect(page.getByTestId('playhead')).toHaveText('00:00:12.000');
    await page.getByTestId('jump-clip-start').click();await expect(canvas).toHaveAttribute('data-time-us','0');
    const seek=async(value:string,us:number)=>{const field=page.getByLabel('精确定位',{exact:true});await field.fill(value);await field.press('Enter');await expect(canvas).toHaveAttribute('data-time-us',String(us));};
    await seek('00:00:01.000',1000000);await page.getByTestId('set-clip-start').click();
    await expect(page.getByLabel('截取开始',{exact:true})).toHaveValue('00:00:01.000');
    await seek('00:00:04.000',4000000);await page.getByTestId('set-clip-end').click();
    await expect(page.getByTestId('inspector-duration')).toHaveText('3.00 秒');
    await seek('00:00:00.000',0);await page.getByTestId('set-clip-start').click();
    await page.getByRole('button',{name:'裁剪比例 1:1',exact:true}).click();await expect(page.getByTestId('inspector-dimensions')).toHaveText('180 × 180');
    await page.getByTestId('upload-cover').click();const firstCover=await page.getByTestId('cover-preview').getAttribute('src');
    await seek('00:00:04.000',4000000);await page.getByTestId('add-clip').click();
    await expect(page.getByTestId('inspector-dimensions')).toHaveText('320 × 180');
    await seek('00:00:11.000',11000000);await page.getByTestId('add-clip').click();
    const startsBefore=await page.locator('.clip-range .trim-start').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-valuenow')));
    // Use role-based handles too, so an accidentally empty selector cannot pass preservation checks.
    expect(startsBefore).toHaveLength(3);
    const batch=page.getByTestId('batch-clip-tools');await batch.locator('summary').click();
    await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 8.00 秒');
    await page.getByTestId('apply-all-clips-duration').click();
    await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 7.00 秒');
    await expect(page.locator('.editor-status')).toContainText('1 段距片尾不足 3 秒');
    expect(await page.locator('.clip-range .trim-start').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-valuenow')))).toEqual(startsBefore);
    for(const [n,start,end] of [[1,0,3000000],[2,4000000,7000000],[3,11000000,12000000]]) {
      await expect(page.getByRole('slider',{name:`片段 ${n} 入点`,exact:true})).toHaveAttribute('aria-valuenow',String(start));
      await expect(page.getByRole('slider',{name:`片段 ${n} 出点`,exact:true})).toHaveAttribute('aria-valuenow',String(end));
    }
    await expect(page.locator('.clip-tab .clip-length')).toHaveText(['3.00s','3.00s','1.00s']);
    const durationInput=page.getByLabel('统一片段时长（秒）',{exact:true}),apply=page.getByTestId('apply-all-clips-duration');
    await expect(durationInput).toHaveValue('3');
    for(const invalid of ['', '0', '-2', 'abc', '0.0001', '1e3']) {
      await durationInput.fill(invalid);await expect(apply).toBeDisabled();await expect(durationInput).toHaveAttribute('aria-invalid','true');
      await durationInput.press('Enter');await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 7.00 秒');
    }
    await durationInput.fill('5');await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 7.00 秒');
    await durationInput.press('Enter');await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 11.00 秒');
    await expect(page.locator('.clip-tab .clip-length')).toHaveText(['5.00s','5.00s','1.00s']);
    await durationInput.fill('2.5');await apply.click();await expect(page.getByTestId('total-clip-duration')).toHaveText('合计 6.00 秒');
    await expect(page.locator('.clip-tab .clip-length')).toHaveText(['2.50s','2.50s','1.00s']);
    expect(await page.locator('.clip-range .trim-start').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-valuenow')))).toEqual(startsBefore);
    await expect(page.getByRole('slider',{name:'片段 1 出点',exact:true})).toHaveAttribute('aria-valuenow','2500000');
    await expect(page.getByRole('slider',{name:'片段 2 出点',exact:true})).toHaveAttribute('aria-valuenow','6500000');
    await apply.scrollIntoViewIfNeeded();await page.screenshot({path:join(artifacts,'custom-duration.png')});
    await page.getByRole('button',{name:'片段 01',exact:true}).click();await expect(page.getByTestId('cover-preview')).toHaveAttribute('src',firstCover!);
    await page.getByTestId('sync-all-crops').click();
    for(const n of ['02','03']){await page.getByRole('button',{name:`片段 ${n}`,exact:true}).click();await expect(page.getByTestId('inspector-dimensions')).toHaveText('180 × 180');await expect(page.getByTestId('cover-preview')).toHaveCount(0);}
    await expect(page.getByTestId('inspector-duration')).toHaveText('1.00 秒');
    await page.getByTestId('jump-clip-start').click();await expect(canvas).toHaveAttribute('data-time-us','11000000');
    await expect(page.getByTestId('set-clip-end')).toBeDisabled();
    await page.getByRole('button',{name:'片段 01',exact:true}).click();await expect(page.getByTestId('cover-preview')).toHaveAttribute('src',firstCover!);
    await page.screenshot({path:join(artifacts,'batch.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(860,640));
    await page.getByTestId('apply-all-clips-duration').scrollIntoViewIfNeeded();await expect(page.getByTestId('apply-all-clips-duration')).toBeInViewport();
    await page.getByTestId('capture-cover').scrollIntoViewIfNeeded();await expect(page.getByTestId('capture-cover')).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const mainBox=(await page.locator('.editing-main').boundingBox())!,cropControls=(await page.locator('.crop-controls').boundingBox())!;
    expect(cropControls.y+cropControls.height).toBeLessThanOrEqual(mainBox.y+mainBox.height);
    await page.screenshot({path:join(artifacts,'small.png')});
    await page.getByTestId('export-motion').click();await expect(page.getByLabel('保留音轨',{exact:true})).toBeVisible();
    await page.getByTestId('source-matching').check();await expect(page.locator('.aspect-presets button').nth(1)).toBeDisabled();
    await page.getByTestId('source-matching').uncheck();await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('batch-result')).toContainText('已保存 3',{timeout:90000});
    for(let n=1;n<=3;n++){
      const jpg=join(output,`source_片段0${n}.jpg`),report=await validateMotion(jpg,true),video=join(dir,`clip${n}.mp4`);
      await extractRange(jpg,video,report.videoStart,report.videoEnd);
      const probe=await probeMedia(video,{executable:resolve('resources/bin/ffprobe.exe')}),stream=probe.streams.find(s=>s.codec_type==='video')!;
      expect([stream.width,stream.height]).toEqual([180,180]);expect(Number(probe.format?.duration)).toBe(n===3?1:2.5);
      if(n===1)expect(report.metadata.timestampUs).toBe(-1);
    }
    await page.getByRole('button',{name:'关闭导出',exact:true}).click();await page.getByRole('button',{name:'关闭素材',exact:true}).click();
    await expect(page.getByTestId('editor')).toHaveCount(0);expect(await readdir(join(userData,'media-sessions'))).toEqual([]);
    expect(await Promise.all([sha256(source),sha256(cover)])).toEqual(hashes);expect(errors).toEqual([]);
  } finally {await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
