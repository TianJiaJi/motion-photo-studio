// An isolated Electron prototype shell. Does NOT change or load the production editor.
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/probe-native-surface.ts <synthetic-test-video>');
const root = resolve('../artifacts/native-preview', `native-surface-${Date.now()}`);
await mkdir(root, { recursive: true });
const client = await readFile(resolve('scripts/lib/native-prototype.ts'), 'utf8');
await writeFile(join(root, 'client.cjs'), ts.transpileModule(client, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
await writeFile(join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('probe', {
 command: value => ipcRenderer.invoke('prototype-command',value),
 onFrame: callback => { ipcRenderer.on('prototype-frame',(_event,frame)=>callback(frame)); }
});`);
await writeFile(join(root, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');
const {join}=require('node:path');
const {NativePrototype}=require('./client.cjs');
app.setPath('userData',join(__dirname,'user-data'));
let native,win,exiting=false;
app.whenReady().then(async()=>{
 native=new NativePrototype();
 win=new BrowserWindow({width:1000,height:650,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 ipcMain.handle('prototype-command',async(event,request)=>{
  if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('untrusted');
  if(!['hello','open','seek','read','audioStart','audioStatus','audioStop','close'].includes(request.command))throw Error('unknown command');
  if(request.command==='open')request={command:'open',path:process.env.NATIVE_PROBE_SOURCE,maximumEdge:request.maximumEdge};
  const response=await native.request(request);
  if(response.pixels.length)win.webContents.send('prototype-frame',{...response.header.result,pixels:new Uint8Array(response.pixels)});
  return response.header.result;
 });
 await win.loadFile(join(__dirname,'surface.html'));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(exiting)return;event.preventDefault();exiting=true;(native?native.shutdown():Promise.resolve()).finally(()=>app.exit(0));});`);
await writeFile(join(root, 'surface.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{background:#151517;color:white;margin:0}canvas{display:block;max-width:100%;margin:auto}</style></head><body><canvas id="preview"></canvas><output id="status"></output><script>
window.presented=[];
window.probe.onFrame(frame=>{
 const canvas=document.getElementById('preview');
 if(canvas.width!==frame.width||canvas.height!==frame.height){canvas.width=frame.width;canvas.height=frame.height;}
 const context=canvas.getContext('2d');
 const pixels=new Uint8ClampedArray(frame.pixels);
 context.putImageData(new ImageData(pixels,frame.width,frame.height),0,0);
 let hash=2166136261;for(let i=0;i<pixels.length;i+=64){hash=Math.imul(hash^pixels[i],16777619);}
 window.presented.push({frameId:frame.frameId,pts:frame.timestampHns,hash:hash>>>0,at:performance.now()});
 document.getElementById('status').textContent=frame.timestampHns;
});
</script></body></html>`);
const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
for (const key of Object.keys(env)) if (['electron_run_as_node', 'electron_renderer_url'].includes(key.toLowerCase())) delete env[key];
env.NATIVE_PROBE_SOURCE = resolve(input);
const instance = await electron.launch({ args: [join(root, 'main.cjs')], env, timeout: 60000 });
const report: Record<string, unknown> = {};
try {
  const page = await instance.firstWindow();
  report.hello = await page.evaluate(() => (window as any).probe.command({ command: 'hello' }));
  report.open = await page.evaluate(() => (window as any).probe.command({ command: 'open', maximumEdge: 960 }));
  report.seeks = await page.evaluate(async () => {
    const rows = [];
    for (const timeUs of [0, 3600000, 18000000, 7200000, 20400000]) {
      const start = performance.now();
      const frame = await (window as any).probe.command({ command: 'seek', timeUs });
      await new Promise<void>((resolve, reject) => {
        const until = performance.now() + 5000;
        function observe() {
          if ((window as any).presented.at(-1)?.frameId === frame.frameId) resolve();
          else if (performance.now() > until) reject(new Error('Frame IPC was not presented'));
          else requestAnimationFrame(observe);
        }
        observe();
      });
      rows.push({ timeUs, requestToDrawMs: performance.now() - start, shown: (window as any).presented.at(-1) });
    }
    return rows;
  });
  await page.screenshot({ path: join(root, 'native-canvas.png') });
  expect(new Set((report.seeks as any[]).map(x => x.shown.hash)).size).toBe(5);
  report.audioVideo = await page.evaluate(async () => {
    const p = (window as any).probe;
    await p.command({ command: 'seek', timeUs: 1000000 });
    await p.command({ command: 'audioStart', timeUs: 1000000 });
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const status = await p.command({ command: 'audioStatus' });
      if (!status.running || status.error) throw Error('Native audio stopped: ' + JSON.stringify(status));
      // Native sample comes next; presentation delay uses the native audio device clock, not timeupdate.
      const frame = await p.command({ command: 'read' });
      const ahead = (Number(frame.timestampHns) - Number(status.timeHns)) / 10000;
      if (ahead > 0 && ahead < 1000) await new Promise(resolve => setTimeout(resolve, ahead));
      rows.push({ frame: frame.timestampHns, audio: status.timeHns });
    }
    const stopped = await p.command({ command: 'audioStop' });
    return { rows, stopped, totalPresented: (window as any).presented.length };
  });
  await page.evaluate(() => (window as any).probe.command({ command: 'close' }));
  console.log(JSON.stringify({ seeks: report.seeks, totalPresented: (report.audioVideo as any).totalPresented }));
} catch (error) { report.error = String(error); console.error(error); process.exitCode = 1; }
finally { await instance.close(); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(`Native surface evidence: ${root}`); }
