import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256 } from '../../src/main/motion/io.ts';

test('import welcome separates native choosing from reading, recovers from cancel/error, and opens a real video', async () => {
  test.setTimeout(120000);
  const dir=await mkdtemp(join(tmpdir(),'motion-welcome-')), userData=join(dir,'profile');
  const source=join(dir,'landscape.mp4'), invalid=join(dir,'invalid.mp4');
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try {
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=2','-c:v','libx264','-preset','ultrafast',source]);
    await writeFile(invalid,'not a video');const before=await sha256(source);
    const env=Object.fromEntries(Object.entries(process.env).filter((r):r is [string,string]=>r[1]!==undefined));
    delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;env.MOTION_USER_DATA_DIR=userData;
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env,timeout:60000});
    const page=await app.firstWindow();await app.context().setOffline(true);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const button=page.getByTestId('open-video'), welcome=page.getByTestId('import-welcome');
    await expect(button).toBeEnabled({timeout:60000});await expect(welcome).toHaveAttribute('data-phase','idle');
    await expect(page.getByRole('button',{name:'取消导入',exact:true})).toHaveCount(0);
    await expect(page.locator('.welcome-track')).toHaveCount(0);
    const artifacts=resolve('../artifacts/desktop/import-welcome');await mkdir(artifacts,{recursive:true});
    await page.screenshot({path:join(artifacts,'welcome.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(860,640));
    await expect(button).toBeInViewport();await expect(page.locator('.import-privacy')).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('.app-body').evaluate(node=>node.scrollHeight<=node.clientHeight+1 && node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await page.screenshot({path:join(artifacts,'welcome-small.png')});
    // Hold the native chooser without inventing a read phase. The second latch holds
    // only the real open reply so its genuine selected notification is observable.
    await app.evaluate(({dialog,ipcMain})=>{
      const state: {calls:number;opened:boolean;hold:boolean;choose?:(value:any)=>void;release?:()=>void} = {calls:0,opened:false,hold:false};
      (globalThis as any).__welcome=state;
      dialog.showOpenDialog=async()=>{state.calls++;return new Promise<any>(resolve=>{state.choose=resolve;});};
      const original=(ipcMain as any)._invokeHandlers.get('motion:media:open');
      ipcMain.removeHandler('motion:media:open');
      ipcMain.handle('motion:media:open',async(event,...args)=>{
        const result=await original(event,...args);
        if(state.hold && result.ok && result.value){state.opened=true;await new Promise<void>(resolve=>{state.release=resolve;});}
        return result;
      });
    });
    await page.evaluate(()=>{(window as any).__selectedCount=0;window.motion.media.onImportSelected(()=>{(window as any).__selectedCount++;});});
    await button.focus();await page.keyboard.press('Space');
    await expect(welcome).toHaveAttribute('data-phase','choosing');await expect(button).toBeDisabled();
    await expect(welcome.getByRole('status')).toHaveText('请在系统窗口中选择视频');
    await expect(welcome).not.toContainText('正在读取');
    expect(await page.evaluate(()=>(window as any).__selectedCount)).toBe(0);
    await app.evaluate(()=>(globalThis as any).__welcome.choose({canceled:true,filePaths:[]}));
    await expect(welcome).toHaveAttribute('data-phase','idle');await expect(button).toBeEnabled();
    await expect(welcome.getByRole('alert')).toHaveCount(0);await expect(welcome.getByRole('status')).toBeEmpty();
    await button.click();await expect.poll(()=>app!.evaluate(()=>(globalThis as any).__welcome.calls)).toBe(2);
    await app.evaluate((_electron,file)=>(globalThis as any).__welcome.choose({canceled:false,filePaths:[file]}),invalid);
    await expect(welcome.getByRole('alert')).toContainText('没能打开这个视频',{timeout:30000});
    await expect(button).toBeEnabled();await expect(welcome).toHaveAttribute('data-phase','idle');
    expect(await page.evaluate(()=>(window as any).__selectedCount)).toBe(1);
    await app.evaluate(()=>{(globalThis as any).__welcome.hold=true;});
    await button.click();await expect.poll(()=>app!.evaluate(()=>(globalThis as any).__welcome.calls)).toBe(3);
    await expect(welcome.getByRole('alert')).toHaveCount(0);
    await app.evaluate((_electron,file)=>(globalThis as any).__welcome.choose({canceled:false,filePaths:[file]}),source);
    await expect.poll(()=>app!.evaluate(()=>(globalThis as any).__welcome.opened)).toBe(true);
    await expect(welcome).toHaveAttribute('data-phase','reading');await expect(button).toHaveText('正在打开视频…');
    await expect(welcome.getByRole('status')).toContainText('正在读取视频信息');
    await expect(page.getByRole('button',{name:'取消导入',exact:true})).toHaveCount(0);
    await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).__selectedCount)).toBe(2);
    await page.screenshot({path:join(artifacts,'reading.png')});
    await app.evaluate(()=>(globalThis as any).__welcome.release());
    await expect(page.getByTestId('asset-name')).toHaveText('landscape.mp4');
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id',/\d+/,{timeout:60000});
    await expect(welcome).toHaveCount(0);
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();
    await expect(welcome).toHaveAttribute('data-phase','idle');await expect(button).toBeEnabled();
    await expect(welcome.getByRole('status')).toBeEmpty();
    expect(await sha256(source)).toBe(before);expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(errors).toEqual([]);
  } finally {await app?.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
