// Local-only acceptance probe. Original user media is read, hashed, never rewritten or uploaded.
import {_electron as electron,expect} from '@playwright/test';
import {mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {runProcess} from '../src/main/media/runner.ts';
import {probeMedia} from '../src/main/media/probe.ts';
import {mediaInfo} from '../src/main/media/info.ts';
import {sha256} from '../src/main/motion/io.ts';
import {setTimeout as delay} from 'node:timers/promises';
const soak=process.argv[4]==='--soak';
if(process.argv.length!==4&&!(process.argv.length===5&&soak))throw new Error('Usage: node scripts/measure-real-native-preview.ts <exact-exe> <selected-local-manifest> [--soak]');
const exe=await realpath(resolve(process.argv[2]!)),selection=JSON.parse(await readFile(resolve(process.argv[3]!),'utf8')) as {cases:{name:string;path:string}[]};
if(!Array.isArray(selection.cases)||selection.cases.length<1||selection.cases.length>8)throw new Error('Bounded explicit selection required');
const allowed=await Promise.all(['Downloads','Videos'].map(name=>realpath(join(process.env.USERPROFILE!,name))));
const root=resolve(`../artifacts/native-preview/real-performance-${Date.now()}`);await mkdir(root,{recursive:true});
const ffprobe=resolve('resources/bin/ffprobe.exe'),reports:unknown[]=[];
async function packageIdentity(){
  const resources=join(dirname(exe),'resources');
  return {exe:await sha256(exe),asar:await sha256(join(resources,'app.asar')),helper:await sha256(join(resources,'bin/motion-preview.exe')),nativeManifest:await sha256(join(resources,'native-preview-manifest.json'))};
}
const packageBefore=await packageIdentity();
function environment(userData:string){
  const env=Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>row[1]!==undefined));
  for(const key of Object.keys(env))if(['path','electron_run_as_node','electron_renderer_url','ffmpeg_path','ffprobe_path','motion_preview_prototype_exe'].includes(key.toLowerCase()))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;return env;
}
function distribution(values:number[]){const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1]??null,p95:sorted[Math.ceil(sorted.length*.95)-1]??null,max:sorted.at(-1)??null};}
type ProcessSample={pid:number;cpuMs:number;workingSet:number;privateBytes:number;gpu?:unknown;gpuError?:string;gpuMethod?:string;gpuPdhError?:string};
async function processSample(pid:number,includeGpu=false):Promise<ProcessSample>{
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid owned helper PID');
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await runProcess(powershell,['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction Stop; @{pid=$p.Id;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;workingSet=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64} | ConvertTo-Json -Compress`],{timeoutMs:10000});
  const sample=JSON.parse(result.stdout) as ProcessSample;
  // A missing/hung GPU provider must not discard CPU/memory samples or be reported as zero GPU usage.
  if(includeGpu)try{
    const gpu=await runProcess(powershell,['-NoProfile','-NonInteractive','-Command',`$g=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -OperationTimeoutSec 2 -ErrorAction Stop | Where-Object { $_.Name -like 'pid_${pid}_*' } | Select-Object Name,UtilizationPercentage); ConvertTo-Json -InputObject $g -Depth 4 -Compress`],{timeoutMs:5000});
    sample.gpu=JSON.parse(gpu.stdout);sample.gpuMethod='CIM';
  }catch(error){
    sample.gpuError=String(error);
    try{
      const pdh=await runProcess(powershell,['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $c=Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage'; $g=@($c.CounterSamples | Where-Object { $_.InstanceName -like 'pid_${pid}_*' } | Select-Object InstanceName,CookedValue); ConvertTo-Json -InputObject $g -Depth 4 -Compress`],{timeoutMs:5000});
      sample.gpu=JSON.parse(pdh.stdout);sample.gpuMethod='PDH';
    }catch(pdhError){sample.gpuPdhError=String(pdhError);}
  }
  return sample;
}
for(const entry of selection.cases){
  if(!/^[a-z0-9-]{1,64}$/.test(entry.name))throw new Error('Invalid evidence name');
  const source=await realpath(entry.path);if(!allowed.some(path=>source.toLowerCase().startsWith((path+sep).toLowerCase())))throw new Error('Source outside user-authorized folders');
  const directory=join(root,entry.name);await mkdir(directory);const userData=join(directory,'user-data');
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  const record:any={name:entry.name,source,scope:'Packaged Canvas, real local source, fixed targets and held sweeps; not physical AV latency or verified hardware decoding'};
  try{
    record.sourceSha256=await sha256(source);const info=mediaInfo(await probeMedia(source,{executable:ffprobe}));record.info=info;
    const oracle=JSON.parse((await runProcess(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp,key_frame','-of','json=compact=1',source],{timeoutMs:180000})).stdout) as {frames:{best_effort_timestamp:number;key_frame:number}[]};
    const rows=oracle.frames.map(frame=>{
      if(!Number.isSafeInteger(frame.best_effort_timestamp))throw new Error('Oracle PTS must be safely representable before integer conversion');
      const pts=BigInt(frame.best_effort_timestamp),timeUs=Number((pts-BigInt(info.startPts))*BigInt(info.timeBase.numerator)*1000000n/BigInt(info.timeBase.denominator));
      return {pts:String(pts),timeUs,key:frame.key_frame===1};
    });
    if(rows.length<24||rows.some((row,i)=>i>0&&row.timeUs<rows[i-1]!.timeUs))throw new Error('Unsupported/insufficient oracle frame ordering');
    const keys=rows.filter(row=>row.key);record.maximumKeyframeGapUs=Math.max(0,...keys.slice(1).map((row,i)=>row.timeUs-keys[i]!.timeUs));
    app=await electron.launch({executablePath:exe,args:[],env:environment(userData),timeout:60000});const page=await app.firstWindow();
    await app.context().setOffline(true);await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
    await app.evaluate(({dialog},file)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
      const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn,starts:{exe:string;pid:number|undefined;closed:boolean}[]=[];(globalThis as any).__realStarts=starts;
      cp.spawn=((...args:Parameters<typeof original>)=>{const child=Reflect.apply(original,cp,args),row={exe:String(args[0]),pid:child.pid,closed:false};starts.push(row);child.once('close',()=>{row.closed=true;});return child;}) as typeof original;
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    },source);
    const began=Date.now();await page.getByTestId('open-video').click();const canvas=page.getByTestId('native-preview');
    await expect(canvas).toHaveAttribute('data-frame-id',/\d+/,{timeout:300000});record.firstVisibleMs=Date.now()-began;
    await expect(page.getByTestId('play-video')).toBeEnabled();await expect(page.locator('.thumbnails img')).toHaveCount(8,{timeout:60000});record.readyWithThumbnailsMs=Date.now()-began;
    record.caption=await page.locator('.preview-caption strong').innerText();
    const starts=await app.evaluate(()=>(globalThis as any).__realStarts as {exe:string;pid:number;closed:boolean}[]),helper=starts.filter(row=>row.exe.endsWith('motion-preview.exe'));
    expect(helper).toHaveLength(1);const baselineStarts=starts.length;record.importStarts=starts;record.helperPid=helper[0]!.pid;
    await page.evaluate(()=>{
      const rows:any[]=[],inputs:any[]=[];(window as any).__realPaints=rows;(window as any).__realInputs=inputs;
      const canvas=document.querySelector<HTMLCanvasElement>('[data-testid="native-preview"]')!;
      new MutationObserver(()=>{if(canvas.dataset.frameId){rows.push({time:performance.now(),pts:canvas.dataset.pts,timeUs:Number(canvas.dataset.timeUs),frameId:canvas.dataset.frameId});if(rows.length>10000)rows.shift();}}).observe(canvas,{attributes:true,attributeFilter:['data-frame-id']});
      document.addEventListener('pointermove',e=>{inputs.push({time:performance.now(),x:e.clientX,y:e.clientY,buttons:e.buttons,pointerId:e.pointerId});if(inputs.length>2000)inputs.shift();},true);
    });
    record.processBefore=await processSample(record.helperPid);
    const samples:{pass:string;target:number;pts:string;latencyMs:number}[]=[];record.samples=samples;
    const fractions=[.08,.31,.62,.17,.81,.43,.92,.24,.73,.52,.11,.67];
    for(const pass of ['first-pass','warmed']){
      const handle=page.getByTestId('timeline-playhead'),box=(await handle.boundingBox())!,track=(await page.getByTestId('timeline').boundingBox())!;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      for(const fraction of fractions){
        await page.mouse.move(track.x+track.width*fraction,box.y+box.height/2);
        const input=await page.evaluate(()=>(window as any).__realInputs.at(-1));
        expect(input.buttons).toBe(1);expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),input.pointerId)).toBe(true);
        expect(Math.abs(Number(await handle.getAttribute('aria-valuenow'))-fraction*info.durationUs)).toBeLessThan(info.durationUs/track.width+1);
        const target=Number(await handle.getAttribute('aria-valuenow')),expected=rows.find(row=>row.timeUs>=target);if(!expected)throw new Error('No oracle frame at target');
        await expect.poll(()=>page.evaluate(({pts,time})=>(window as any).__realPaints.some((row:any)=>row.pts===pts&&row.time>=time),{pts:expected.pts,time:input.time}),{timeout:20000}).toBe(true);
        const painted=await page.evaluate(({pts,time})=>(window as any).__realPaints.find((row:any)=>row.pts===pts&&row.time>=time),{pts:expected.pts,time:input.time});
        samples.push({pass,target,pts:expected.pts,latencyMs:painted.time-input.time});
        await expect(page.getByTestId('displayed-frame')).toHaveAttribute('data-pts',expected.pts);
      }
      await page.mouse.up();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    }
    record.firstPass=distribution(samples.filter(x=>x.pass==='first-pass').map(x=>x.latencyMs));record.warmed=distribution(samples.filter(x=>x.pass==='warmed').map(x=>x.latencyMs));
    // Continuous held movement: record real painted progression, final catch-up, and retained capture.
    const handle=page.getByTestId('timeline-playhead'),box=(await handle.boundingBox())!,track=(await page.getByTestId('timeline').boundingBox())!;
    const sweepStart=await page.evaluate(()=>performance.now());await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    for(let i=0;i<60;i++){
      const fraction=.1+.8*(i%20)/19;await page.mouse.move(track.x+track.width*fraction,box.y+box.height/2);
      const input=await page.evaluate(()=>(window as any).__realInputs.at(-1));expect(input.buttons).toBe(1);expect(await handle.evaluate((node,id)=>node.hasPointerCapture(id),input.pointerId)).toBe(true);
      await page.waitForTimeout(16); // Intentional input pacing, not waiting on a background tool.
    }
    const target=Number(await handle.getAttribute('aria-valuenow')),expected=rows.find(row=>row.timeUs>=target)!;
    await expect(canvas).toHaveAttribute('data-pts',expected.pts,{timeout:20000});
    const sweep=await page.evaluate(time=>(window as any).__realPaints.filter((row:any)=>row.time>=time),sweepStart);
    expect(new Set(sweep.map((row:any)=>row.pts)).size).toBeGreaterThan(3);
    record.sweep={paints:sweep.length,distinctFrames:new Set(sweep.map((row:any)=>row.pts)).size,maxPaintGapMs:Math.max(0,...sweep.slice(1).map((row:any,i:number)=>row.time-sweep[i].time))};
    await page.mouse.up();record.processAfter=await processSample(record.helperPid);
    if(info.durationUs>=65000000&&entry===selection.cases[0]){
      const field=page.getByLabel('精确定位',{exact:true});await field.fill('00:00:00.000');await field.press('Enter');await expect(canvas).toHaveAttribute('data-time-us','0');
      const playbackStart=Date.now();await page.getByTestId('play-video').click();
      let sampling=true,gpuAvailable=true;const metrics:unknown[]=[];
      const sampled=(async()=>{while(sampling){try{const sample=await processSample(record.helperPid,gpuAvailable);if(sample.gpu===undefined&&sample.gpuError)gpuAvailable=false;metrics.push({elapsedMs:Date.now()-playbackStart,...sample});}catch(error){metrics.push({error:String(error)});break;}if(sampling)await new Promise(done=>setTimeout(done,4000));}})();
      try{
        await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us')),{timeout:90000}).toBeGreaterThanOrEqual(60000000);
        record.playback={wallMs:Date.now()-playbackStart,lastDisplayedUs:Number(await canvas.getAttribute('data-time-us')),audioSelected:await page.getByLabel('保留音轨',{exact:true}).isChecked(),physicalAVLatencyVerified:false};
        await page.getByTestId('play-video').click();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
      }finally{sampling=false;await sampled;record.playbackMetrics=metrics;}
    }
    if(soak){
      const began=Date.now(),metrics:any[]=[],gestures:any[]=[];record.soak={requestedHeldMs:180000,metrics,gestures};
      const stopped=new AbortController();let sampling=true;
      const sampled=(async()=>{while(sampling){
        try{
          const startedMs=Date.now()-began,sample=await processSample(record.helperPid);
          const electronMetrics=await app!.evaluate(({app})=>app.getAppMetrics().map(({pid,type,cpu,memory})=>({pid,type,cpu,memory})));
          metrics.push({startedMs,completedMs:Date.now()-began,helper:sample,electron:electronMetrics});
        }catch(error){metrics.push({error:String(error)});break;}
        try{await delay(10000,undefined,{signal:stopped.signal});}catch(error){if(!stopped.signal.aborted)throw error;}
      }})();
      try{
        for(const kind of ['start','end','playhead'] as const){
          await page.getByRole('button',{name:'全选片段',exact:true}).click();
          await expect(page.getByTestId('trim-start')).toHaveAttribute('aria-valuenow','0');
          await expect(page.getByTestId('trim-end')).toHaveAttribute('aria-valuenow',String(info.durationUs));
          const slider=page.getByTestId(kind==='playhead'?'timeline-playhead':`trim-${kind}`),box=(await slider.boundingBox())!,track=(await page.getByTestId('timeline').boundingBox())!;
          const gesture:any={kind,pixelHashes:[],moves:0};gestures.push(gesture);
          const start=await page.evaluate(()=>performance.now());
          await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
          const wallStart=Date.now();
          while(Date.now()-wallStart<60000){
            const phase=(gesture.moves*73%257)/256,fraction=kind==='start'?.05+.4*phase:kind==='end'?.55+.4*phase:.05+.9*phase;
            await page.mouse.move(track.x+track.width*fraction,box.y+box.height/2);
            const input=await page.evaluate(()=>(window as any).__realInputs.at(-1));
            expect(input.buttons).toBe(1);expect(await slider.evaluate((node,id)=>node.hasPointerCapture(id),input.pointerId)).toBe(true);
            expect(Math.abs(Number(await slider.getAttribute('aria-valuenow'))-fraction*info.durationUs)).toBeLessThan(info.durationUs/track.width+1);
            if(gesture.moves%100===0)gesture.pixelHashes.push(await canvas.evaluate(node=>{
              const canvas=node as HTMLCanvasElement,data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
              let hash=2166136261;for(const byte of data)hash=Math.imul(hash^byte,16777619);return (hash>>>0).toString(16);
            }));
            gesture.moves++;await page.waitForTimeout(16);
          }
          const target=Number(await slider.getAttribute('aria-valuenow'));
          const expected=kind==='end'?rows.findLast(row=>row.timeUs<target):rows.find(row=>row.timeUs>=target);
          if(!expected)throw new Error('Soak target has no source oracle frame');
          await expect(canvas).toHaveAttribute('data-pts',expected.pts,{timeout:20000});
          const lastInput=await page.evaluate(()=>(window as any).__realInputs.at(-1));
          expect(lastInput.buttons).toBe(1);expect(await slider.evaluate((node,id)=>node.hasPointerCapture(id),lastInput.pointerId)).toBe(true);
          const painted=await page.evaluate(time=>(window as any).__realPaints.filter((row:any)=>row.time>=time),start);
          gesture.heldMs=Date.now()-wallStart;gesture.target=target;gesture.finalPts=expected.pts;
          gesture.paints=painted.length;gesture.distinctFrames=new Set(painted.map((row:any)=>row.pts)).size;
          gesture.maxPaintGapMs=Math.max(0,...painted.slice(1).map((row:any,i:number)=>row.time-painted[i].time));
          expect(gesture.distinctFrames).toBeGreaterThan(3);expect(new Set(gesture.pixelHashes).size).toBeGreaterThan(1);
          await page.mouse.up();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
        }
      }finally{sampling=false;stopped.abort();await sampled;await page.mouse.up();}
      record.soak.elapsedMs=Date.now()-began;
      expect(metrics.filter(value=>value.helper).length).toBeGreaterThanOrEqual(8);
      expect(metrics.some(value=>value.error)).toBe(false);
      record.soak.limitations='Three minutes across real trim/playhead gestures. Memory samples are time windows, not instantaneous; OS/decoder/Electron allocations are separate from the bounded application pixel cache. Not an indefinite soak proof.';
    }
    record.editingStarts=(await app.evaluate(()=>(globalThis as any).__realStarts)).slice(baselineStarts);expect(record.editingStarts).toEqual([]);
    record.inputs=await page.evaluate(()=>(window as any).__realInputs);record.paints=await page.evaluate(()=>(window as any).__realPaints);
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await sha256(source)).toBe(record.sourceSha256);
    record.closedStarts=await app.evaluate(()=>(globalThis as any).__realStarts);expect(record.closedStarts.find((row:any)=>row.pid===record.helperPid).closed).toBe(true);
    record.targets={warmedP95Under100Ms:record.warmed.p95<=100,firstPassP95Under150Ms:record.firstPass.p95<=150};record.status='functional-passed';
    record.limitations=['First-pass targets are not guaranteed cold: import verification may warm frames','Paint time is DOM observation immediately after Canvas draw, not physical monitor scanout','12 targets per pass; not a statistically broad benchmark','Only playhead latency measured; trim functional checks are separate','GPU counters sampled only during the first case playback if available; decoder identity remains unverified','No acoustic capture to prove physical AV latency'];
  }catch(error){record.status='failed';record.error=String(error);const page=app?.windows()[0];if(page){record.inputs=await page.evaluate(()=>(window as any).__realInputs).catch(()=>null);record.paints=await page.evaluate(()=>(window as any).__realPaints).catch(()=>null);record.dom=await page.locator('body').innerText().catch(()=>'');}process.exitCode=1;}
  finally{await app?.close();record.sourceHashAfter=await sha256(source).catch(error=>String(error));record.sourceUnchanged=record.sourceHashAfter===record.sourceSha256;if(!record.sourceUnchanged)process.exitCode=1;reports.push(record);await writeFile(join(directory,'report.json'),JSON.stringify(record,null,2),{flag:'wx'});}
}
const packageAfter=await packageIdentity(),packageUnchanged=JSON.stringify(packageBefore)===JSON.stringify(packageAfter);if(!packageUnchanged)process.exitCode=1;
await writeFile(join(root,'report.json'),JSON.stringify({exe,exeSha256:packageAfter.exe,packageBefore,packageAfter,packageUnchanged,reports,limits:'Functional pass is separate from performance targets; unresolved HDR/GPU/physical AV acceptance is not waived.'},null,2),{flag:'wx'});
console.log(`Private real-material evidence: ${root}`);
