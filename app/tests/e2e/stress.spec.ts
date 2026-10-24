import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, extractRange } from '../../src/main/motion/io.ts';
import { validateMotion } from '../../src/main/motion/validate.ts';
import { runProcess } from '../../src/main/media/runner.ts';
import { MediaResources } from '../../src/main/media/resources.ts';

function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (['path', 'electron_run_as_node', 'electron_renderer_url', 'ffmpeg_path', 'ffprobe_path'].includes(key.toLowerCase())) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}
function time(seconds: number): string {
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}.000`;
}
type Fixture = { name: string; input: string; inputBytes: number; inputSha256: string; durationUs: number };

test('opt-in packaged native UI handles large sources and two-hour end seeks, independently checks 64-bit resource ranges and saves verified short tails', async () => {
  test.skip(!process.env.MOTION_STRESS_MANIFEST || !process.env.MOTION_PACKAGED_EXE, 'Requires passed actual-media stress manifest and exact new packaged EXE; never substitutes tiny fixtures.');
  test.setTimeout(600000);
  const manifest = JSON.parse(await readFile(resolve(process.env.MOTION_STRESS_MANIFEST!), 'utf8')) as { status: string; records: Fixture[] };
  expect(manifest.status).toBe('passed');
  const fixtures = ['large-passed', 'long-passed'].map(name => { const row = manifest.records.find(record => record.name === name); expect(row).toBeTruthy(); return row!; });
  expect(fixtures[0]!.inputBytes).toBeGreaterThan(0xffffffff); expect(fixtures[1]!.durationUs).toBe(7200000000);
  const directory = await mkdtemp(join(tmpdir(), 'motion-ui-stress-')); const userData = join(directory, 'user-data');
  const outputDir = resolve(`../artifacts/m5/ui-${Date.now()}-${randomUUID().slice(0, 8)}`); await mkdir(outputDir, { recursive: true });
  const outputs = fixtures.map((_row, i) => join(outputDir, `${i}-尾部实况.jpg`));
  const results: unknown[] = []; const metrics: unknown[] = [];
  let instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let stopped = false; let sampling: Promise<void> | undefined;
  try {
    instance = await electron.launch({ executablePath: resolve(process.env.MOTION_PACKAGED_EXE!), args: [], env: environment(userData), timeout: 60000 });
    await instance.evaluate(({ dialog }, paths) => {
      const opens = [...paths.inputs]; const saves = [...paths.outputs];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [opens.shift()!] });
      dialog.showSaveDialog = async () => { const filePath = saves.shift(); if (!filePath) throw new Error('Unexpected save chooser'); return { canceled: false, filePath }; };
    }, { inputs: fixtures.map(row => row.input), outputs });
    const app = instance;
    sampling = (async () => {
      while (!stopped) {
        try { metrics.push({ utc: new Date().toISOString(), rows: await app.evaluate(({ app }) => app.getAppMetrics().map(row => ({ pid: row.pid, type: row.type, memory: row.memory }))) }); }
        catch { break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    })();
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.evaluate(() => {
      let count = 0; let last = performance.now(); let maxGapMs = 0;
      const handle = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; count++; }, 50);
      (window as unknown as { __stressHeartbeat: () => { count: number; maxGapMs: number } }).__stressHeartbeat = () => ({ count, maxGapMs: Math.max(maxGapMs, performance.now() - last) });
      window.addEventListener('beforeunload', () => clearInterval(handle), { once: true });
    });
    for (const [index, fixture] of fixtures.entries()) {
      const end = fixture.durationUs / 1000000; const start = end - (index === 0 ? 2 : 3); const seek = end - 1;
      await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); await page.getByTestId('open-video').click();
      await expect(page.getByTestId('asset-name')).toHaveText('输入 source.mp4', { timeout: 60000 });
      const player = page.getByTestId('native-preview'); await expect(player).toHaveAttribute('data-frame-id', /\d+/, { timeout: 300000 });
      const offset = index === 0 ? 4294967296 : fixture.inputBytes - 64;
      // The native editor deliberately does not expose original video URLs. Test the range implementation
      // independently here; this is not an assertion about browser playback of the original source.
      const resources = new MediaResources();
      const range = await (async () => {
        try {
          const ref = await resources.register(fixture.input, 'video/mp4');
          const response = await resources.respond(new Request(ref.url, { headers: { Range: `bytes=${offset}-${offset + 63}` } }), 'app://ui');
          return { status: response.status, range: response.headers.get('Content-Range'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
        } finally { await resources.dispose(); }
      })();
      const file = await open(fixture.input, 'r'); const expected = Buffer.alloc(64);
      try { expect((await file.read(expected, 0, 64, offset)).bytesRead).toBe(64); } finally { await file.close(); }
      expect(range).toEqual({ status: 206, range: `bytes ${offset}-${offset + 63}/${fixture.inputBytes}`, bytes: [...expected] });
      await page.getByLabel('精确定位', { exact: true }).fill(time(seek)); await page.getByLabel('精确定位', { exact: true }).press('Enter');
      await expect(page.getByTestId('playhead')).toHaveText(time(seek), { timeout: 60000 });
      const sourceFrameTimeUs = Number(await player.getAttribute('data-time-us'));
      expect(sourceFrameTimeUs).toBeGreaterThanOrEqual(seek * 1000000);expect(sourceFrameTimeUs - seek * 1000000).toBeLessThan(100000);
      await expect(page.getByTestId('video-preview')).toHaveCount(0);
      await expect(page.getByLabel('强制兼容预览', { exact: true })).toHaveCount(0);
      await page.getByLabel('截取开始', { exact: true }).fill(time(start)); await page.getByLabel('截取开始', { exact: true }).press('Enter');
      await page.getByLabel('截取结束', { exact: true }).fill(time(end)); await page.getByLabel('截取结束', { exact: true }).press('Enter');
      await page.getByLabel('原画质（跟随原片）', { exact: true }).check();
      let cancelMs: number | null = null;
      if (index === 0) {
        await page.getByTestId('export-motion').click(); await expect(page.getByRole('button', { name: '取消处理', exact: true })).toBeVisible();
        const began = Date.now(); await page.getByRole('button', { name: '取消处理', exact: true }).click();
        const cancelled = page.getByRole('dialog', { name: '输出预览', exact: true });
        await expect(cancelled).toContainText('处理已取消，未发布新的成品。', { timeout: 10000 }); cancelMs = Date.now() - began;
        expect(cancelMs).toBeLessThan(10000); expect(await readdir(outputDir)).toEqual([]);
        await page.getByRole('button', { name: '关闭输出预览', exact: true }).click();
      }
      await page.getByTestId('export-motion').click(); const preview = page.getByRole('dialog', { name: '输出预览', exact: true });
      await expect(preview).toBeVisible({ timeout: 240000 }); await page.getByTestId('save-motion').click();
      await expect(page.getByTestId('save-result')).toContainText('已保存', { timeout: 120000 });
      await page.screenshot({ path: join(outputDir, `${index}-saved.png`) });
      const inspected = await validateMotion(outputs[index]!, true); const video = join(outputDir, `${index}-extracted.mp4`);
      await extractRange(outputs[index]!, video, inspected.videoStart, inspected.videoEnd);
      await runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', video, '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']); await unlink(video);
      await page.getByRole('button', { name: '关闭输出预览', exact: true }).click(); await page.getByRole('button', { name: '关闭素材', exact: true }).click();
      await expect(page.getByTestId('editor')).toHaveCount(0); expect(await sha256(fixture.input)).toBe(fixture.inputSha256);
      results.push({ fixture: fixture.name, requestedStartSeconds: start, requestedEndSeconds: end, range: { offset, length: 64, total: fixture.inputBytes },
        sourceFrameTimeUs, cancelMs, output: outputs[index], outputSha256: await sha256(outputs[index]!), validated: inspected });
    }
    const heartbeat = await page.evaluate(() => (window as unknown as { __stressHeartbeat: () => { count: number; maxGapMs: number } }).__stressHeartbeat());
    expect(heartbeat.count).toBeGreaterThan(10); expect(heartbeat.maxGapMs).toBeLessThan(2000); expect(pageErrors).toEqual([]);
    stopped = true; await sampling; expect(metrics.length).toBeGreaterThan(2);
    expect(await readdir(join(userData, 'publications'))).toEqual([]); expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
    await writeFile(join(outputDir, 'result.json'), JSON.stringify({ status: 'passed', executable: process.env.MOTION_PACKAGED_EXE, results, heartbeat, metrics,
      scope: 'Real large/long native UI import, independent host resource 64-bit range check (not browser source streaming), end seek, cancellation and short tail outputs only. Metrics are sampled Electron process working sets; native child/OS cache not included, shared pages not deduplicated. Not full long/large UI export, phone or clean install.' }, null, 2), { flag: 'wx', flush: true });
  } catch (error) {
    await writeFile(join(outputDir, 'failure.json'), JSON.stringify({ status: 'failed', results, metrics, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2), { flag: 'wx', flush: true }); throw error;
  } finally {
    stopped = true; await sampling; if (instance) await instance.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
