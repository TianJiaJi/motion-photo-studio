import {test,expect,_electron as electron} from '@playwright/test';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {runProcess} from '../../src/main/media/runner.ts';
import {sha256} from '../../src/main/motion/io.ts';
function environment(userData:string){
  const env=Object.fromEntries(Object.entries(process.env).filter((row):row is [string,string]=>row[1]!==undefined));
  for(const key of Object.keys(env))if(['path','electron_run_as_node','electron_renderer_url','ffmpeg_path','ffprobe_path'].includes(key.toLowerCase()))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;return env;
}
test('HEVC60 plays continuously through former segment boundaries on one Canvas and helper with no editing processes',async()=>{
  test.setTimeout(180000);
  const root=resolve(`../artifacts/native-preview/hevc-playback-${Date.now()}`);await mkdir(root,{recursive:true});
  const userData=join(root,'user-data'),input=join(root,'HEVC60.mp4');
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=60:duration=16',
      '-f','lavfi','-i','sine=frequency=523:sample_rate=44100:duration=16','-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:pools=1:frame-threads=1','-pix_fmt','yuv420p','-c:a','aac',input]);
    const before=await sha256(input);
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env:environment(userData),timeout:60000});
    const page=await app.firstWindow();await app.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({timeout:60000});
    await app.evaluate(({dialog},file)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
      const cp=process.getBuiltinModule('node:child_process'),original=cp.spawn;
      const rows:{exe:string;pid:number|undefined}[]=[];(globalThis as any).__continuousStarts=rows;
      cp.spawn=((...args:Parameters<typeof original>)=>{const child=Reflect.apply(original,cp,args);rows.push({exe:String(args[0]),pid:child.pid});return child;}) as typeof original;
      process.getBuiltinModule('node:module').syncBuiltinESMExports();
    },input);
    await page.getByTestId('open-video').click();await expect(page.getByTestId('asset-name')).toHaveText('HEVC60.mp4');
    const canvas=page.getByTestId('native-preview');await expect(canvas).toHaveAttribute('data-frame-id',/\d+/,{timeout:60000});
    await expect(page.locator('.thumbnails img')).toHaveCount(8);await expect(page.getByTestId('play-video')).toBeEnabled();
    const prepared=await app.evaluate(()=>(globalThis as any).__continuousStarts as {exe:string;pid:number}[]);
    expect(prepared.filter(row=>row.exe.endsWith('motion-preview.exe'))).toHaveLength(1);
    await canvas.evaluate(node=>{(node as HTMLCanvasElement).dataset.identityMarker='persistent';});
    const initial=await canvas.evaluate(node=>(node as HTMLCanvasElement).toDataURL());
    await page.getByTestId('play-video').click();
    for(const boundary of [4000000,14000000]){
      await expect.poll(async()=>Number(await canvas.getAttribute('data-time-us')),{timeout:22000}).toBeGreaterThan(boundary);
      await expect(canvas).toHaveAttribute('data-identity-marker','persistent');
      expect(await canvas.evaluate(node=>(node as HTMLCanvasElement).toDataURL())).not.toBe(initial);
    }
    await page.getByTestId('play-video').click();await expect(page.getByTestId('play-video')).toHaveText('播放选段');
    await expect(page.getByTestId('video-preview')).toHaveCount(0);await expect(page.getByTestId('next-preview')).toHaveCount(0);
    const after=await app.evaluate(()=>(globalThis as any).__continuousStarts);expect(after).toEqual(prepared);
    const [directory]=await readdir(join(userData,'media-sessions')),files=await readdir(join(userData,'media-sessions',directory!));
    expect(files.filter(name=>name.startsWith('proxy-'))).toEqual([]);
    expect(files.filter(name=>name.endsWith('.mp4')).length).toBeLessThanOrEqual(1); // At most one whole-file import compatibility resource.
    await page.getByRole('button',{name:'关闭素材',exact:true}).click();await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData,'media-sessions'))).toEqual([]);expect(await sha256(input)).toBe(before);
    await writeFile(join(root,'report.json'),JSON.stringify({prepared,after,files,sourceSha256:before,limits:'Synthetic visual continuity only; not physical AV latency or hardware decode proof.'},null,2));
  }catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error)},null,2));throw error;}
  finally{if(app)await app.close();}
});
