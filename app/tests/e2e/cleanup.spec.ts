import {test,expect,_electron as electron} from '@playwright/test';
import {mkdir,writeFile,readFile,readdir,symlink,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {TempFiles} from '../../src/main/jobs/temp-files.ts';
import {CleanupJournal} from '../../src/main/jobs/cleanup-journal.ts';

test('startup recovers owned interrupted cleanup but keeps unmarked history and shows classified nonblocking records',async()=>{
  test.setTimeout(120000);
  const root=resolve(`../artifacts/native-preview/cleanup-ui-${Date.now()}`),userData=join(root,'user-data');await mkdir(userData,{recursive:true});
  const sessions=join(userData,'media-sessions'),jobs=join(userData,'jobs');await mkdir(sessions);
  const history='job-11111111-1111-1111-1111-111111111111',corrupt='job-22222222-2222-2222-2222-222222222222';
  await mkdir(join(sessions,history));await writeFile(join(sessions,history,'original.mp4'),'unowned historical bytes');
  await mkdir(join(sessions,corrupt));await writeFile(join(sessions,corrupt,'.owner.json'),'broken-json');await writeFile(join(sessions,corrupt,'keep'),'keep');
  const store=new TempFiles(jobs,{checkpoint:async stage=>{if(stage==='marker')throw new Error('interrupted after marker');}});await store.initialize();
  const interrupted=await store.create();await store.remove(interrupted).catch(()=>{});
  const linked=await store.create(),target=join(root,'outside');await mkdir(target);await writeFile(join(target,'source.mp4'),'source');
  const link=join(linked,'junction');await symlink(target,link,'junction');
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  for(const key of Object.keys(env))if(key.toLowerCase()==='path'||['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','FFMPEG_PATH','FFPROBE_PATH'].includes(key))delete env[key];
  env.PATH=`${env.SystemRoot??'C:\\Windows'}\\System32`;env.MOTION_USER_DATA_DIR=userData;
  let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
  try{
    app=await electron.launch({...(process.env.MOTION_PACKAGED_EXE?{executablePath:resolve(process.env.MOTION_PACKAGED_EXE),args:[]}:{args:[resolve('.')]}),env,timeout:60000});
    const page=await app.firstWindow();await app.context().setOffline(true);
    await expect(page.getByTestId('engine-state')).toHaveText('引擎就绪',{timeout:60000});await expect(page.getByTestId('open-video')).toBeEnabled();
    const response=await page.evaluate(()=>window.motion.getSnapshot());expect(response.ok).toBe(true);if(!response.ok)throw new Error(response.error.message);
    expect(response.value.startupWarnings).toEqual([]);
    expect(response.value.cleanupIssues.map(issue=>issue.reason).sort()).toEqual(['invalid-marker','missing-marker','unsafe-path']);
    await expect(page.getByTestId('cleanup-notice')).toContainText('3 项');await expect(page.getByTestId('cleanup-notice')).not.toHaveAttribute('open','');
    await page.getByRole('button',{name:'帮助与检查',exact:true}).click();await page.getByTestId('cleanup-details').locator('summary').click();
    await expect(page.getByTestId('cleanup-details')).toContainText(history);await expect(page.getByTestId('cleanup-details')).toContainText('不能补造所有权标记');
    await page.screenshot({path:join(root,'classified-records.png')});
    expect(await readFile(join(sessions,history,'original.mp4'),'utf8')).toBe('unowned historical bytes');
    expect(await readdir(join(sessions,history))).toEqual(['original.mp4']);expect(await readFile(join(sessions,corrupt,'.owner.json'),'utf8')).toBe('broken-json');
    expect(await readFile(join(target,'source.mp4'),'utf8')).toBe('source');expect(await new CleanupJournal(jobs).jobs()).toEqual([]);
    await writeFile(join(root,'report.json'),JSON.stringify(response.value.cleanupIssues,null,2));
  }finally{await app?.close();await unlink(link);}
});
