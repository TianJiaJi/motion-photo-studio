import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256, extractRange } from '../../src/main/motion/io.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'FFMPEG_PATH', 'FFPROBE_PATH'].includes(key)) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}
test('multi-audio UI requires a track choice or explicit omission and never silently defaults to first track', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-audio-choice-')); const userData = join(directory, 'user-data'); const input = join(directory, 'multi.mp4');
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-vf', 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const before = await sha256(input);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
    const output = join(directory, 'output'); await mkdir(output);
    await instance.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async (...args: any[]) => ({ canceled: false, filePaths: [args.at(-1).properties.includes('openDirectory') ? paths.output : paths.input] }); }, {input,output});
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
    await expect(page.getByTestId('play-video')).toBeDisabled();
    await expect(page.getByTestId('capture-cover')).toBeDisabled();
    await expect(page.getByTestId('native-preview')).not.toHaveAttribute('data-frame-id', /\d+/);
    await expect(page.locator('.editor-sidebar').getByLabel('保留音轨', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '前往导出设置选择音轨', exact: true }).click();
    const tracks = page.getByLabel('所保留的音轨', { exact: true }); await expect(tracks).toHaveValue('');
    await expect(page.getByLabel('保留音轨', { exact: true })).toBeChecked();
    const preview = page.getByRole('dialog', { name: '导出实况照片', exact: true }); await expect(preview).toBeVisible();
    await expect(preview).toContainText('请选择音轨或关闭声音');
    await expect(page.getByTestId('confirm-export-all')).toBeDisabled(); await expect(page.getByTestId('export-play')).toBeDisabled();
    await tracks.selectOption('2');
    await expect(page.getByTestId('native-preview')).toHaveAttribute('data-frame-id', /\d+/, { timeout: 60000 });
    await expect(page.getByTestId('export-play')).toBeEnabled();
    await page.getByTestId('export-play').click(); await expect(page.getByTestId('export-play')).toHaveText('暂停');
    await expect.poll(async()=>Number(await page.getByTestId('native-preview').getAttribute('data-time-us'))).toBeGreaterThan(100000);
    await page.getByTestId('export-play').click();
    await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('batch-result')).toContainText('multi_片段01.jpg', { timeout: 60000 });
    const selected = join(output,'multi_片段01.jpg'), report = await validateMotion(selected,true), video = join(directory,'selected.mp4');
    await extractRange(selected,video,report.videoStart,report.videoEnd);
    const pcm=join(directory,'selected.s16');
    await runProcess(resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-n','-i',video,'-map','0:a:0','-ac','1','-ar','48000','-c:a','pcm_s16le','-f','s16le',pcm]);
    const samples=await readFile(pcm);let energy=0,sine=0,cosine=0;const count=samples.length/2;
    for(let i=0;i<count;i++){const v=samples.readInt16LE(i*2)/32768,angle=2*Math.PI*880*i/48000;energy+=v*v;sine+=v*Math.sin(angle);cosine+=v*Math.cos(angle);}
    expect(Math.sqrt(energy/count)).toBeGreaterThan(.01);
    expect(Math.SQRT2*Math.hypot(sine,cosine)/count/Math.sqrt(energy/count)).toBeGreaterThan(.8);
    await page.getByLabel('保留音轨', { exact: true }).uncheck(); await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
    await expect(page.getByTestId('export-play')).toBeEnabled({timeout:60000});
    await page.getByTestId('confirm-export-all').click();
    await expect(page.getByTestId('batch-result')).toContainText('multi_片段01-2.jpg', { timeout: 60000 });
    const omitted=join(output,'multi_片段01-2.jpg'), omittedReport=await validateMotion(omitted,true), silent=join(directory,'silent.mp4');
    await extractRange(omitted,silent,omittedReport.videoStart,omittedReport.videoEnd);
    expect((await probeMedia(silent,{executable:resolve('resources/bin/ffprobe.exe')})).streams.filter(s=>s.codec_type==='audio')).toHaveLength(0);
    await page.getByRole('button', { name: '关闭导出', exact: true }).click();
    await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await readdir(join(userData, 'media-sessions'))).toEqual([]); expect(await sha256(input)).toBe(before); expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
