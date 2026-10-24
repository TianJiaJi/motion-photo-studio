import {test,expect,_electron as electron} from '@playwright/test';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runProcess} from '../../src/main/media/runner.ts';
import {sha256} from '../../src/main/motion/io.ts';
function environment(userData:string):Record<string,string>{
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  for(const key of Object.keys(env))if(key.toLowerCase()==='path'||['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','FFMPEG_PATH','FFPROBE_PATH'].includes(key))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;return env;
}
test('native desktop switches audio, replaces playing source, reports helper death and recovers by reimport',async()=>{
  test.setTimeout(180000);
  const root=resolve(`../artifacts/native-preview/lifecycle-${Date.now()}`);await mkdir(root,{recursive:true});
  const first=join(root,'audio-tracks.mp4'),second=join(root,'replacement.mp4'),userData=join(root,'user-data');
  const ff=(args:string[])=>runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n',...args]);
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=8',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8,volume=0.005',
      '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=8,volume=0.005',
      '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-g','120','-bf','3','-c:a','aac',first]);
    await ff(['-f','lavfi','-i','testsrc2=size=480x270:rate=24:duration=8','-an','-c:v','libx264','-preset','ultrafast',second]);
    const hashes=await Promise.all([sha256(first),sha256(second)]);
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env:environment(userData),timeout:60000});
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await app.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
    await app.evaluate(({dialog},files)=>{
      const queue=[...files];dialog.showOpenDialog=async()=>{const file=queue.shift();return {canceled:!file,filePaths:file?[file]:[]};};
      const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn;
      const rows:{executable:string;pid:number|undefined;closed:boolean}[]=[];(globalThis as any).__lifecycleSpawns=rows;
      cp.spawn=((...args:Parameters<typeof original>)=>{const child=Reflect.apply(original,cp,args),row={executable:String(args[0]),pid:child.pid,closed:false};rows.push(row);child.once('close',()=>{row.closed=true;});return child;}) as typeof original;
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    },[first,second,first]);
    await page.getByTestId('open-video').click();const canvas=page.getByTestId('native-preview'),play=page.getByTestId('play-video');
    await expect(canvas).toHaveAttribute('width','320',{timeout:60000});await expect(play).toBeEnabled();
    const beforeEditing=await app.evaluate(()=>(globalThis as any).__lifecycleSpawns.length);
    await page.getByLabel('所保留的音轨',{exact:true}).selectOption('2');
    await play.click();await expect(play).toHaveText('暂停');
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1000000);
    await page.getByLabel('所保留的音轨',{exact:true}).selectOption('1');await expect(play).toHaveText('播放选段');
    await play.click();await expect(play).toHaveText('暂停');
    await page.getByLabel('保留音轨',{exact:true}).uncheck();await expect(play).toHaveText('播放选段');
    await play.click();await expect(play).toHaveText('暂停');
    expect(await app.evaluate(()=>(globalThis as any).__lifecycleSpawns.length)).toBe(beforeEditing);
    // Import/replacement is an explicit preparation boundary; process starts here are expected.
    await page.getByTestId('open-video').click();await expect(page.getByTestId('asset-name')).toHaveText('replacement.mp4');
    await expect(canvas).toHaveAttribute('width','480',{timeout:60000});await expect(play).toBeEnabled();
    const replacement=await app.evaluate(()=>(globalThis as any).__lifecycleSpawns);
    const helpers=replacement.filter((row:{executable:string})=>row.executable.endsWith('motion-preview.exe'));
    expect(helpers).toHaveLength(2);expect(helpers[0].closed).toBe(true);expect(helpers[1].closed).toBe(false);
    await play.click();await expect(play).toHaveText('暂停');
    // Kill only the exact, still-live helper recorded by this isolated app's spawn hook.
    await app.evaluate(()=>{
      const row=(globalThis as any).__lifecycleSpawns.findLast((row:any)=>row.executable.endsWith('motion-preview.exe')&&!row.closed);
      if(!row?.pid)throw new Error('No owned native helper');process.kill(row.pid);
    });
    await expect(play).toBeDisabled();await expect(page.getByTestId('capture-cover')).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText(/原生|预览/);
    await page.getByRole('button',{name:'准备预览',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
    await expect(play).toBeDisabled();expect(await app.evaluate(()=>(globalThis as any).__lifecycleSpawns.length)).toBe(replacement.length);
    await page.getByTestId('open-video').click();await expect(page.getByTestId('asset-name')).toHaveText('audio-tracks.mp4');
    await expect(canvas).toHaveAttribute('width','320',{timeout:60000});await expect(play).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await Promise.all([sha256(first),sha256(second)])).toEqual(hashes);expect(errors).toEqual([]);
    const spawns=await app.evaluate(()=>(globalThis as any).__lifecycleSpawns);
    expect(spawns.filter((row:{executable:string})=>row.executable.endsWith('motion-preview.exe'))).toHaveLength(3);
    expect(spawns.every((row:{closed:boolean})=>row.closed)).toBe(true);
    await writeFile(join(root,'report.json'),JSON.stringify({spawns,errors,sourceUnchanged:true,reimportRecovered:true},null,2));
  }catch(error){
    await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error)},null,2));
    const page=app?.windows()[0];if(page){await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});await writeFile(join(root,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));}
    throw error;
  }finally{await app?.close();}
});

test('minimized native playback keeps Canvas acknowledgments flowing without background throttling',async()=>{
  test.setTimeout(120000);
  const root=resolve(`../artifacts/native-preview/background-playback-${Date.now()}`);await mkdir(root,{recursive:true});
  const source=join(root,'source.mov'),userData=join(root,'user-data');let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=12',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12,volume=0.005','-c:v','libx264','-preset','ultrafast','-g','30','-bf','3','-c:a','pcm_s16le','-ac','2','-shortest',source]);
    const before=await sha256(source);
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env:environment(userData),timeout:60000});
    const page=await app.firstWindow();await app.context().setOffline(true);await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.backgroundThrottling)).toBe(false);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
    await page.getByTestId('open-video').click();const canvas=page.getByTestId('native-preview');
    await expect(canvas).toHaveAttribute('data-time-us','0',{timeout:60000});await expect(page.locator('.thumbnails img')).toHaveCount(8,{timeout:60000});
    await page.evaluate(()=>{
      const canvas=document.querySelector<HTMLCanvasElement>('[data-testid="native-preview"]')!,rows:any[]=[];(window as any).__backgroundPaints=rows;
      new MutationObserver(()=>{rows.push({wall:Date.now(),pts:canvas.dataset.pts,timeUs:Number(canvas.dataset.timeUs),visibility:document.visibilityState});}).observe(canvas,{attributes:true,attributeFilter:['data-frame-id']});
    });
    await page.getByTestId('play-video').click();await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1000000);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.minimize());
    await expect.poll(()=>app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);
    const began=Date.now();await page.waitForTimeout(3000); // A defined observation interval while minimized.
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);
    const rows=await page.evaluate(time=>(window as any).__backgroundPaints.filter((row:any)=>row.wall>=time),began);
    expect(new Set(rows.map((row:any)=>row.pts)).size).toBeGreaterThan(20);
    expect(rows.at(-1).timeUs-rows[0].timeUs).toBeGreaterThan(2000000);
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0]!;window.restore();window.show();window.focus();});
    await expect(page.getByTestId('play-video')).toHaveText('暂停');await page.getByTestId('play-video').click();
    await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await sha256(source)).toBe(before);
    await writeFile(join(root,'report.json'),JSON.stringify({rows,sourceUnchanged:true,minimizedIntervalMs:3000},null,2),{flag:'wx'});
  }catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error)},null,2),{flag:'wx'});throw error;}
  finally{await app?.close();}
});
