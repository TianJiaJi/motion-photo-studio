// Synthetic flash/tone alignment to the actual WASAPI-reported device clock.
// This measures software presentation relative to that clock, NOT acoustic/physical AV latency.
import {_electron as electron,expect} from '@playwright/test';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {runProcess} from '../src/main/media/runner.ts';
import {sha256} from '../src/main/motion/io.ts';
const flags=process.argv.slice(3),occlusion=flags.includes('--occlusion'),diagnostics=flags.includes('--diagnostics');
if(!process.argv[2]||new Set(flags).size!==flags.length||flags.some(flag=>!['--occlusion','--diagnostics'].includes(flag)))throw new Error('Usage: node scripts/verify-packaged-av-clock.ts <exact-packaged-exe> [--occlusion] [--diagnostics]');
const exe=resolve(process.argv[2]!),root=resolve(`../artifacts/native-preview/packaged-av-clock-${Date.now()}`);
await mkdir(root,{recursive:true});
const file=join(root,'flash-tone.mov'),ffmpeg=resolve('resources/bin/ffmpeg.exe');
await runProcess(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i',"color=c=black:s=640x360:r=30:d=65,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.1)'",'-f','lavfi','-i',"aevalsrc='if(lt(mod(t,1),0.1),0.2*sin(2*PI*1000*t),0)':s=48000:d=65",'-c:v','libx264','-preset','ultrafast','-g','30','-bf','3','-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-c:a','pcm_s16le','-ac','2','-shortest',file],{timeoutMs:120000});
async function identity(){const resources=join(dirname(exe),'resources');return {exe:await sha256(exe),asar:await sha256(join(resources,'app.asar')),helper:await sha256(join(resources,'bin/motion-preview.exe')),manifest:await sha256(join(resources,'native-preview-manifest.json'))};}
const before=await identity(),sourceHash=await sha256(file),userData=join(root,'user-data');
const env=Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>row[1]!==undefined));
for(const key of Object.keys(env))if(['path','electron_run_as_node','electron_renderer_url','ffmpeg_path','ffprobe_path','motion_preview_prototype_exe'].includes(key.toLowerCase()))delete env[key];
env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;
const report:any={exe,occlusion,diagnostics,packageBefore:before,sourceHash,method:'Canvas center-pixel flash rising edges, compared to preceding running WASAPI clock response plus elapsed receive-to-paint time. Excludes pulse zero. No loopback, microphone or display scanout capture; not physical AV latency.'};
let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
try{
  app=await electron.launch({executablePath:exe,args:[],env,timeout:60000});const page=await app.firstWindow();await app.context().setOffline(true);
  await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
  await app.evaluate(({dialog,BrowserWindow},{file,diagnostics})=>{
    const window=BrowserWindow.getAllWindows()[0]!,states:any[]=[];(globalThis as any).__avWindowStates=states;
    const record=(event:string)=>states.push({event,wallMs:performance.timeOrigin+performance.now(),visible:window.isVisible(),focused:window.isFocused(),minimized:window.isMinimized(),backgroundThrottling:window.webContents.backgroundThrottling});
    record('initial');window.on('show',()=>record('show'));window.on('hide',()=>record('hide'));
    window.on('focus',()=>record('focus'));window.on('blur',()=>record('blur'));
    window.on('minimize',()=>record('minimize'));window.on('restore',()=>record('restore'));
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
    const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn;
    const starts:any[]=[],clocks:any[]=[],parseErrors:string[]=[];
    const wire:any[]=[],loopGaps:any[]=[];
    Object.assign(globalThis,{__avStarts:starts,__avClocks:clocks,__avParseErrors:parseErrors,__avWire:wire,__avLoopGaps:loopGaps,__avTraceEnabled:false});
    // Optional diagnostics only: bounded metadata, no pixel copies and no private request paths.
    if(diagnostics){
      let previous=performance.timeOrigin+performance.now();
      const timer=setInterval(()=>{
        const now=performance.timeOrigin+performance.now(),gapMs=now-previous;previous=now;
        if((globalThis as any).__avTraceEnabled&&gapMs>50&&loopGaps.length<1024)loopGaps.push({wallMs:now,gapMs});
      },20);timer.unref();(globalThis as any).__avDiagnosticTimer=timer;
    }
    cp.spawn=((...args:Parameters<typeof original>)=>{
      const child=Reflect.apply(original,cp,args),row={exe:String(args[0]),pid:child.pid,closed:false};starts.push(row);child.once('close',()=>{row.closed=true;});
      if(row.exe.endsWith('motion-preview.exe')){
        // Observe only bounded JSON headers. Skip RGBA bodies without retaining/copying them.
        const pending=new Map<number,any>();let bodyTrace:any;
        if(diagnostics&&child.stdin){
          const stdin=child.stdin,write=stdin.write;
          stdin.write=((...args:any[])=>{
            if((globalThis as any).__avTraceEnabled)try{
              const data=args[0];if(!Buffer.isBuffer(data)||data.length<4||data.length>16388||data.readUInt32LE()!==data.length-4)throw new Error('Unrecognized diagnostic request framing');
              const request=JSON.parse(data.subarray(4).toString('utf8'));
              if(pending.size>=8)throw new Error('Diagnostic pending budget exceeded');
              pending.set(request.id,{id:request.id,pid:child.pid,generation:request.generation,command:request.command,timeHns:request.timeHns,seekHns:request.seekHns,sentMs:performance.timeOrigin+performance.now()});
            }catch(error){if(parseErrors.length<32)parseErrors.push(String(error));}
            return Reflect.apply(write,stdin,args);
          }) as typeof write;
        }
        let prefix=Buffer.alloc(4),prefixAt=0,header=Buffer.alloc(0),headerAt=0,bodyLeft=0,broken=false;
        child.stdout?.on('data',(chunk:Buffer)=>{
          if(broken)return;
          try{let at=0;while(at<chunk.length){
            if(bodyLeft){
              const take=Math.min(bodyLeft,chunk.length-at);bodyLeft-=take;at+=take;
              if(!bodyLeft&&bodyTrace){bodyTrace.completeMs=performance.timeOrigin+performance.now();bodyTrace=undefined;}
              continue;
            }
            if(!header.length){
              const take=Math.min(4-prefixAt,chunk.length-at);chunk.copy(prefix,prefixAt,at,at+take);prefixAt+=take;at+=take;
              if(prefixAt<4)continue;const length=prefix.readUInt32LE();if(length<1||length>16384)throw new Error('Invalid observed header length');
              header=Buffer.alloc(length);headerAt=0;prefixAt=0;
            }
            const take=Math.min(header.length-headerAt,chunk.length-at);chunk.copy(header,headerAt,at,at+take);headerAt+=take;at+=take;
            if(headerAt===header.length){
              const response=JSON.parse(header.toString('utf8'));if(response.version!==1||!Number.isSafeInteger(response.bodyBytes)||response.bodyBytes<0||response.bodyBytes>1280*1280*4)throw new Error('Invalid observed envelope');
              const value=response.result,trace=pending.get(response.id);
              if(trace){
                pending.delete(response.id);if(wire.length>=12000)throw new Error('Diagnostic response budget exceeded');
                Object.assign(trace,{headerMs:performance.timeOrigin+performance.now(),bodyBytes:response.bodyBytes,nativeTimestampHns:value?.timestampHns,nativeFrameId:value?.frameId,clockHns:value?.timeHns,error:response.error});
                if(response.bodyBytes)bodyTrace=trace;else trace.completeMs=trace.headerMs;
                wire.push(trace);
              }
              if(value&&typeof value.running==='boolean'&&typeof value.timeHns==='string'){
                if(clocks.length>=20000)throw new Error('Audio observation budget exceeded');
                clocks.push({receivedMs:performance.timeOrigin+performance.now(),generation:response.generation,...value});
              }
              bodyLeft=response.bodyBytes;header=Buffer.alloc(0);headerAt=0;
            }
          }}catch(error){broken=true;parseErrors.push(String(error));}
        });
      }
      return child;
    }) as typeof original;
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
  },{file,diagnostics});
  await page.getByTestId('open-video').click();const canvas=page.getByTestId('native-preview');
  await expect(canvas).toHaveAttribute('data-time-us','0',{timeout:120000});await expect(page.locator('.thumbnails img')).toHaveCount(8,{timeout:60000});
  const importStarts=await app.evaluate(()=>(globalThis as any).__avStarts);report.importStarts=importStarts;expect(importStarts.filter((row:any)=>row.exe.endsWith('motion-preview.exe'))).toHaveLength(1);
  await expect(page.getByLabel('保留音轨',{exact:true})).toBeChecked();
  await page.evaluate(()=>{
    const canvas=document.querySelector<HTMLCanvasElement>('[data-testid="native-preview"]')!,flashes:any[]=[],frames:any[]=[];
    const visibility:any[]=[];Object.assign(window,{__avFlashes:flashes,__avFrames:frames,__avVisibility:visibility});let wasWhite=false;
    const note=(event:string)=>visibility.push({event,wallMs:performance.timeOrigin+performance.now(),visibility:document.visibilityState,focused:document.hasFocus()});
    note('initial');document.addEventListener('visibilitychange',()=>note('visibilitychange'));window.addEventListener('focus',()=>note('focus'));window.addEventListener('blur',()=>note('blur'));
    new MutationObserver(()=>{
      if(!canvas.dataset.frameId)return;
      const rgba=canvas.getContext('2d')!.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data;
      const white=rgba[0]!>230&&rgba[1]!>230&&rgba[2]!>230&&rgba[3]===255;
      const row={paintedMs:performance.timeOrigin+performance.now(),timeUs:Number(canvas.dataset.timeUs),pts:canvas.dataset.pts,frameId:canvas.dataset.frameId,white,visibility:document.visibilityState,focused:document.hasFocus()};
      frames.push(row);if(frames.length>10000)frames.shift();if(white&&!wasWhite)flashes.push(row);wasWhite=white;
    }).observe(canvas,{attributes:true,attributeFilter:['data-frame-id']});
  });
  if(diagnostics)await app.evaluate(()=>{(globalThis as any).__avTraceEnabled=true;});
  const began=Date.now();await page.getByTestId('play-video').click();
  const visibilityChange=occlusion?(async()=>{
    await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us')),{timeout:30000}).toBeGreaterThanOrEqual(10000000);
    await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.minimize());
    await new Promise(done=>setTimeout(done,12000)); // Controlled background interval, not a tool wait.
    await app!.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0]!;window.restore();window.show();window.focus();});
  })():Promise.resolve();
  await Promise.all([visibilityChange,expect.poll(async()=>Number(await canvas.getAttribute('data-time-us')),{timeout:90000}).toBeGreaterThanOrEqual(61000000)]);
  report.playbackWallMs=Date.now()-began;await page.getByTestId('play-video').click();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
  report.clocks=await app.evaluate(()=>(globalThis as any).__avClocks);report.parseErrors=await app.evaluate(()=>(globalThis as any).__avParseErrors);
  report.flashes=await page.evaluate(()=>(window as any).__avFlashes);report.frames=await page.evaluate(()=>(window as any).__avFrames);
  expect(report.parseErrors).toEqual([]);expect(report.clocks.length).toBeGreaterThan(60);
  report.pulses=[];report.missingPulses=[];
  for(let second=1;second<=60;second++){
    const flash=report.flashes.find((row:any)=>Math.floor(row.timeUs/1000000)===second);if(!flash){report.missingPulses.push(second);continue;}
    const clock=report.clocks.findLast((row:any)=>row.running&&row.receivedMs<=flash.paintedMs);if(!clock)throw new Error(`No preceding running device clock for pulse ${second}`);
    const ageMs=flash.paintedMs-clock.receivedMs;expect(ageMs).toBeLessThanOrEqual(100);
    const deltaMs=Number(BigInt(clock.timeHns))/10000+ageMs-second*1000;
    report.pulses.push({second,sourceTimeUs:flash.timeUs,clockAgeMs:ageMs,videoMinusDevicePulseMs:deltaMs});
  }
  expect(report.missingPulses,'Every one of the 60 flash markers must actually be painted').toEqual([]);
  const absolute=report.pulses.map((row:any)=>Math.abs(row.videoMinusDevicePulseMs)).sort((a:number,b:number)=>a-b);
  report.logicalAlignment={count:absolute.length,p50Ms:absolute[Math.ceil(absolute.length*.5)-1],p95Ms:absolute[Math.ceil(absolute.length*.95)-1],maximumMs:absolute.at(-1),within80Ms:absolute.every((value:number)=>value<=80)};
  if(!report.logicalAlignment.within80Ms)process.exitCode=2;
  report.editingStarts=(await app.evaluate(()=>(globalThis as any).__avStarts)).slice(importStarts.length);expect(report.editingStarts).toEqual([]);
  await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
  expect(await readdir(join(userData,'media-sessions'))).toEqual([]);report.closedStarts=await app.evaluate(()=>(globalThis as any).__avStarts);expect(report.closedStarts.every((row:any)=>row.closed)).toBe(true);
  report.status='functional-passed'; // Quantitative target is reported separately, never implied by exit zero.
}catch(error){report.status='failed';report.error=String(error);process.exitCode=1;}
finally{
  if(app&&diagnostics){
    const diagnostic=await app.evaluate(()=>{
      (globalThis as any).__avTraceEnabled=false;clearInterval((globalThis as any).__avDiagnosticTimer);
      return {wire:(globalThis as any).__avWire,loopGaps:(globalThis as any).__avLoopGaps};
    }).catch(error=>({error:String(error)}));report.diagnostic=diagnostic;
  }
  if(app){report.windowStates=await app.evaluate(()=>(globalThis as any).__avWindowStates).catch(()=>null);report.clocks??=await app.evaluate(()=>(globalThis as any).__avClocks).catch(()=>null);const page=app.windows()[0];if(page){report.visibility=await page.evaluate(()=>(window as any).__avVisibility).catch(()=>null);report.flashes??=await page.evaluate(()=>(window as any).__avFlashes).catch(()=>null);report.frames??=await page.evaluate(()=>(window as any).__avFrames).catch(()=>null);}await app.close();}
  report.packageAfter=await identity();report.packageUnchanged=JSON.stringify(before)===JSON.stringify(report.packageAfter);report.sourceUnchanged=await sha256(file)===sourceHash;
  if(!report.packageUnchanged||!report.sourceUnchanged)process.exitCode=1;
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(`Synthetic device-clock evidence: ${root}`);
}
