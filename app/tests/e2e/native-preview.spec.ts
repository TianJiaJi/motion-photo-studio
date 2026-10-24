import {test,expect,_electron as electron} from '@playwright/test';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {runProcess} from '../../src/main/media/runner.ts';
import {sha256} from '../../src/main/motion/io.ts';
function environment(userData:string):Record<string,string>{
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  for(const key of Object.keys(env))if(key.toLowerCase()==='path'||['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','FFMPEG_PATH','FFPROBE_PATH'].includes(key))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;return env;
}
for(const compatibility of [false,true])test(`native Canvas updates while held: ${compatibility?'import compatibility':'direct H264'}`,async()=>{
  test.setTimeout(180000);
  const root=resolve(`../artifacts/native-preview/ui-${compatibility?'compat':'direct'}-${Date.now()}`);await mkdir(root,{recursive:true});
  const input=join(root,compatibility?'source.mkv':'source.mp4'),userData=join(root,'user-data');
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  const evidence:unknown[]=[];
  try {
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i',`testsrc2=size=${compatibility?'640x360':'1920x1080'}:rate=30:duration=6`,
      '-an',...(compatibility?['-c:v','ffv1']:['-c:v','libx264','-preset','ultrafast','-g','180','-bf','3']),input]);
    const before=await sha256(input);
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env:environment(userData),timeout:60000});
    const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await app.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
    await app.evaluate(({dialog},file)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
      const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn;
      const rows:{executable:string;pid:number|undefined;closed:boolean}[]=[];
      (globalThis as any).__nativeUiSpawns=rows;
      cp.spawn=((...args:Parameters<typeof original>)=>{
        const child=Reflect.apply(original,cp,args);const row={executable:String(args[0]),pid:child.pid,closed:false};rows.push(row);
        child.once('close',()=>{row.closed=true;});return child;
      }) as typeof original;
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    },input);
    await page.getByTestId('open-video').click();
    const canvas=page.getByTestId('native-preview');
    await expect(canvas).toHaveAttribute('data-frame-id',/\d+/,{timeout:60000});
    await expect(page.getByTestId('play-video')).toBeEnabled();
    await expect(page.locator('.thumbnails img')).toHaveCount(8,{timeout:30000});
    await expect(page.getByTestId('video-preview')).toHaveCount(0);
    // CDP-held mouse input and unrelated OS mouse input share pointerId=1 on Windows.
    // Isolate this automated gesture from the interactive desktop instead of swallowing
    // capture loss or weakening its assertions. These timings are NOT foreground benchmarks.
    const inputIsolation=await app.evaluate(({BrowserWindow,screen})=>{
      const window=BrowserWindow.getAllWindows()[0]!,bounds=window.getBounds();
      const desktopLeft=Math.min(...screen.getAllDisplays().map(display=>display.bounds.x));
      window.setPosition(desktopLeft-bounds.width-256,bounds.y,false);
      const actual=window.getBounds();return {bounds:actual,desktopLeft,offscreen:actual.x+actual.width<desktopLeft};
    });
    expect(inputIsolation.offscreen).toBe(true);
    await writeFile(join(root,'input-isolation.json'),JSON.stringify(inputIsolation,null,2));
    const preparedStarts=await app.evaluate(()=>(globalThis as any).__nativeUiSpawns.length);
    await page.evaluate(()=>{
      const events:unknown[]=[];(window as any).__nativePointerEvents=events;
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,event=>{
        const e=event as PointerEvent,element=e.target as HTMLElement;
        events.push({type,x:e.clientX,y:e.clientY,id:e.pointerId,buttons:e.buttons,pointerType:e.pointerType,focused:document.hasFocus(),target:element?.dataset?.testid,trusted:e.isTrusted,time:performance.now()});if(events.length>1000)events.shift();
      },true);
    });
    for(const kind of ['end','start','playhead'] as const){
      await page.getByRole('button',{name:'全选片段',exact:true}).click();
      await expect(page.getByTestId('trim-start')).toHaveAttribute('aria-valuenow','0');
      await expect(page.getByTestId('trim-end')).toHaveAttribute('aria-valuenow','6000000');
      const track=(await page.getByTestId('timeline').boundingBox())!;
      const handle=page.getByTestId(kind==='playhead'?'timeline-playhead':`trim-${kind}`),box=(await handle.boundingBox())!;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      const pointerId=await page.evaluate(()=>(window as any).__nativePointerEvents.findLast((event:any)=>event.type==='pointerdown').id as number);
      expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),pointerId)).toBe(true);
      const held:{hash:string;frameId:string|undefined;pts:string|undefined;timeUs:number;target:number;fraction:number;latencyMs:number}[]=[];
      evidence.push({kind,track,box,held});
      const fractions=kind==='end'?[0.8,0.65,0.85,0.7]:kind==='start'?[0.15,0.3,0.2,0.4]:[0.2,0.7,0.3,0.8];
      for(const [index,fraction] of fractions.entries()){
        const started=Date.now();await page.mouse.move(track.x+track.width*fraction,box.y+box.height/2,{steps:10});
        expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),pointerId),'The drag must remain captured until explicit release').toBe(true);
        await expect.poll(async()=>Math.abs(Number(await handle.getAttribute('aria-valuenow'))-Math.round(fraction*6000000)),{timeout:3000,message:'Slider must reach the intended pointer position, not a stale target'}).toBeLessThanOrEqual(6000000/track.width+1);
        const target=Number(await handle.getAttribute('aria-valuenow'));
        await expect.poll(async()=>{
          const at=Number(await canvas.getAttribute('data-time-us'));
          return kind==='end'?at<target&&target-at<=40000:at>=target&&at-target<=40000;
        },{timeout:8000,message:`${kind} must show the requested source frame BEFORE mouseup`}).toBe(true);
        const result=await canvas.evaluate(node=>{
          const c=node as HTMLCanvasElement;
          return {png:c.toDataURL(),frameId:c.dataset.frameId,pts:c.dataset.pts,timeUs:Number(c.dataset.timeUs)};
        });
        held.push({hash:createHash('sha256').update(result.png).digest('hex'),frameId:result.frameId,pts:result.pts,timeUs:result.timeUs,target,fraction,latencyMs:Date.now()-started});
        // Save the same Canvas pixels already checked/hashed above. Element screenshots
        // run browser capture/viewport machinery during an active OS pointer capture;
        // the failed run recorded a buttons=0 move/capture loss between iterations.
        // The observer must not disturb the gesture it is measuring.
        const prefix='data:image/png;base64,';expect(result.png.startsWith(prefix)).toBe(true);
        await writeFile(join(root,`${kind}-held-${index}.png`),Buffer.from(result.png.slice(prefix.length),'base64'));
        expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),pointerId),'Saving pixel evidence must not end the held drag').toBe(true);
      }
      expect(new Set(held.map(frame=>frame.hash)).size).toBe(4);
      expect(new Set(held.map(frame=>frame.frameId)).size).toBe(4);
      // The held-frame assertions above have already succeeded; mouseup is not the trigger under test.
      await page.mouse.up();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
      await writeFile(join(root,'held-progress.json'),JSON.stringify(evidence,null,2));
    }
    for(const cancelKind of ['lost','cancel'] as const){
      await page.getByRole('button',{name:'全选片段',exact:true}).click();
      await expect(page.getByTestId('trim-start')).toHaveAttribute('aria-valuenow','0');
      await page.getByLabel('精确定位',{exact:true}).fill('00:00:00.000');await page.getByLabel('精确定位',{exact:true}).press('Enter');
      await expect(canvas).toHaveAttribute('data-time-us','0');
      await expect(page.getByTestId('displayed-frame')).toContainText('00:00:00.000');
      const handle=page.getByTestId('trim-start'),box=(await handle.boundingBox())!,track=(await page.getByTestId('timeline').boundingBox())!;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(track.x+track.width*0.2,box.y+box.height/2,{steps:8});
      await expect(canvas).toHaveAttribute('data-time-us','1200000');
      const epoch=Number(await canvas.getAttribute('data-epoch'));
      const id=await page.evaluate(()=>(window as any).__nativePointerEvents.findLast((event:any)=>event.type==='pointerdown').id as number);
      if(cancelKind==='lost')await handle.evaluate((node,id)=>node.releasePointerCapture(id),id);
      else await handle.dispatchEvent('pointercancel',{pointerId:id,pointerType:'mouse',isPrimary:true});
      // Capture changes are pending until the next pointer event; do not wait for
      // lostpointercapture while deliberately withholding the event that delivers it.
      await page.mouse.move(track.x+track.width*0.2,box.y+box.height/2);
      await expect.poll(async()=>Number(await canvas.getAttribute('data-epoch'))).toBeGreaterThan(epoch);
      expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),id)).toBe(false);
      await page.mouse.up();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    }
    await page.getByRole('button',{name:'全选片段',exact:true}).click();
    await expect(page.getByTestId('trim-start')).toHaveAttribute('aria-valuenow','0');
    await page.getByTestId('trim-start').focus();await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('trim-start')).toHaveAttribute('aria-valuenow','1000');
    await expect.poll(async()=>{const at=Number(await canvas.getAttribute('data-time-us'));return at>0&&at<=40000;}).toBe(true);
    await page.getByRole('button',{name:'全选片段',exact:true}).click();
    await page.getByLabel('精确定位',{exact:true}).fill('00:00:01.000');await page.getByLabel('精确定位',{exact:true}).press('Enter');
    await expect(canvas).toHaveAttribute('data-time-us','1000000');
    await expect(page.getByTestId('displayed-frame')).toContainText('00:00:01.000');
    await page.getByRole('button',{name:'下一帧',exact:true}).click();
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us'))).toBeGreaterThan(1000000);
    await expect(page.getByTestId('displayed-frame')).toContainText('00:00:01.033');
    await page.getByTestId('capture-cover').click();await expect(page.getByTestId('cover-preview')).toBeVisible();
    await page.getByTestId('play-video').click();await expect(page.getByTestId('play-video')).toHaveText('暂停');
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us')),{timeout:8000}).toBeGreaterThan(1500000);
    await page.getByTestId('play-video').click();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    const spawns=await app.evaluate(()=>(globalThis as any).__nativeUiSpawns);
    expect(spawns.slice(preparedStarts)).toEqual([]);
    expect(spawns.filter((row:{executable:string})=>row.executable.endsWith('motion-preview.exe'))).toHaveLength(1);
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await sha256(input)).toBe(before);expect(errors).toEqual([]);
    const closed=await app.evaluate(()=>(globalThis as any).__nativeUiSpawns);
    expect(closed.find((row:{executable:string})=>row.executable.endsWith('motion-preview.exe')).closed).toBe(true);
    await writeFile(join(root,'pointer-events.json'),JSON.stringify(await page.evaluate(()=>(window as any).__nativePointerEvents),null,2));
    await writeFile(join(root,'report.json'),JSON.stringify({compatibility,inputIsolation,evidence,spawns:closed,errors,sourceUnchanged:true},null,2));
  }catch(error){
    await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error),evidence},null,2));
    const page=app?.windows()[0];if(page){await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});await writeFile(join(root,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));await writeFile(join(root,'pointer-events.json'),JSON.stringify(await page.evaluate(()=>(window as any).__nativePointerEvents).catch(()=>null),null,2));}
    throw error;
  }finally{await app?.close();}
});
