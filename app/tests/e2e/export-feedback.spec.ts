import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { runProcess } from '../../src/main/media/runner.ts';
import { sha256, extractRange } from '../../src/main/motion/io.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { probeMedia } from '../../src/main/media/probe.ts';
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (['path', 'electron_run_as_node', 'electron_renderer_url', 'ffmpeg_path', 'ffprobe_path'].includes(key.toLowerCase())) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}
test('source-matching preset preserves final-photo color and audible AAC from HEVC60 plus PCM; failures remain visible', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-source-preset-')); const output = join(directory, 'output'); await mkdir(output);
  const input = join(directory, 'hevc-pcm.mp4'); const surround = join(directory, 'surround.mp4'); const final = join(output, 'source-matched.jpg');
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const ff = (args: string[]) => runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n', ...args]);
  const color = 'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  try {
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=44100:duration=3',
      '-vf', `drawbox=x=0:y=0:w=64:h=64:color=0x666666:t=fill,${color}`, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=1:frame-threads=1', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'pcm_s16le', '-ac', '2', input]);
    await ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=3', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000:duration=3',
      '-vf', color, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', surround]);
    const before = await sha256(input); const surroundBefore = await sha256(surround);
    instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(join(directory, 'user-data')), timeout: 60000 });
    await instance.evaluate(({ dialog }, paths) => {
      const queue = [...paths.inputs]; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()!] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.output });
    }, { inputs: [input, surround], output: final });
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
    await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('original'); await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('original');
    await expect(page.getByLabel('画质 CRF', { exact: true })).toHaveValue('16');
    await page.getByTestId('export-motion').click();
    const dialog = page.getByRole('dialog', { name: '输出预览', exact: true }); await expect(dialog).toBeVisible();
    await expect(page.getByTestId('save-motion')).toBeEnabled({ timeout: 60000 });
    await expect(page.getByTestId('output-proof')).toContainText('原画质预设'); await expect(page.getByTestId('output-proof')).toContainText('非严格无损');
    await expect(page.getByTestId('source-audio-parameters')).toContainText('aac · 44100 Hz · 2 声道');
    await expect(page.getByTestId('source-audio-compatibility')).toContainText('AAC-LC');
    await expect(page.getByTestId('output-color-compatibility')).toContainText('sRGB'); expect(await readdir(output)).toEqual([]);
    await page.getByTestId('save-motion').click(); await expect(page.getByTestId('save-result')).toContainText('已保存 source-matched.jpg');
    const inspected = await validateMotion(final, true); const video = join(directory, 'extracted.mp4'); await extractRange(final, video, inspected.videoStart, inspected.videoEnd);
    const metadata = await probeMedia(video, { executable: resolve('resources/bin/ffprobe.exe') });
    const v = metadata.streams.find(stream => stream.codec_type === 'video')!; const a = metadata.streams.find(stream => stream.codec_type === 'audio')!;
    expect([v.width, v.height, v.avg_frame_rate]).toEqual([640, 360, '60/1']); expect([a.codec_name, a.profile, a.sample_rate, a.channels]).toEqual(['aac', 'LC', '44100', 2]);
    await ff(['-xerror', '-err_detect', 'explode', '-i', video, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
    expect([v.color_primaries, v.color_transfer, v.color_space, v.color_range]).toEqual(['bt709', 'iec61966-2-1', 'bt709', 'tv']);
    // The final JPEG and its embedded MP4 must agree on the midtone patch even
    // with matrix/range-only video decoding. A tag-only sRGB change cannot pass.
    const patchPath = join(directory, 'final-color.rgb');
    await ff(['-i', video, '-vf', 'crop=16:16:24:24,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', patchPath]);
    const patch = await readFile(patchPath), coverPatch = await sharp(final).extract({ left: 24, top: 24, width: 16, height: 16 })
      .withIccProfile('srgb').removeAlpha().raw().toBuffer();
    expect(patch.length).toBe(16 * 16 * 3); expect(coverPatch.length).toBe(patch.length);
    for (let i = 0; i < patch.length; i++) expect(Math.abs(patch[i]! - coverPatch[i]!)).toBeLessThanOrEqual(4);
    // Verify sound in the MP4 extracted from the FINAL JPEG, not only in the preview draft.
    const raw=join(directory,'final-audio.s16');await ff(['-i',video,'-map','0:a:0','-af','atrim=end=3','-c:a','pcm_s16le','-f','s16le',raw]);
    const samples=await readFile(raw);expect(samples.length).toBe(3*44100*4);
    let sine=0,cosine=0,energy=0;const frames=samples.length/4;
    for(let i=0;i<frames;i++){const value=samples.readInt16LE(i*4)/32768,angle=2*Math.PI*523*i/44100;sine+=value*Math.sin(angle);cosine+=value*Math.cos(angle);energy+=value*value;}
    const rms=Math.sqrt(energy/frames),toneRms=Math.SQRT2*Math.hypot(sine,cosine)/frames;
    expect(rms).toBeGreaterThan(0.01);expect(toneRms/rms).toBeGreaterThan(0.8);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true }); await page.screenshot({ path: resolve(`../artifacts/desktop/m5-source-preset-${process.env.MOTION_PACKAGED_EXE ? 'packaged' : 'development'}.png`) });
    await page.getByRole('button', { name: '关闭输出预览', exact: true }).click(); await page.getByLabel('原画质（跟随原片）', { exact: true }).uncheck();
    await expect(page.getByLabel('输出帧率', { exact: true })).toHaveValue('30'); await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('1080');
    await page.getByTestId('open-video').click(); await page.getByTestId('export-motion').click(); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('多声道'); await expect(page.getByTestId('save-motion')).toBeDisabled();
    expect(await readdir(output)).toEqual(['source-matched.jpg']); await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
    expect(await sha256(input)).toBe(before); expect(await sha256(surround)).toBe(surroundBefore); expect(errors).toEqual([]);
  } finally { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
