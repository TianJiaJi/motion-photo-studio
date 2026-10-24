// Observational baseline for the OLD editor. Run before native preview migration.
// Isolated userData only; never opens or cleans the user's real cache.
import { _electron as electron, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { runProcess } from '../src/main/media/runner.ts';
import { sha256 } from '../src/main/motion/io.ts';

const root = resolve('../artifacts/native-preview', `baseline-${Date.now()}`);
await mkdir(root, { recursive: true });
const input = join(root, '1080p-long-gop.mp4');
console.log(`Baseline evidence: ${root}`);
await runProcess(resolve('resources/bin/ffmpeg.exe'), ['-v', 'error', '-nostdin', '-n',
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-g', '180', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', input], { timeoutMs: 180000 });
const before = await sha256(input);
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
for (const key of Object.keys(env)) if (['electron_run_as_node', 'electron_renderer_url', 'ffmpeg_path', 'ffprobe_path'].includes(key.toLowerCase())) delete env[key];
env.MOTION_USER_DATA_DIR = join(root, 'user-data');
let app: ElectronApplication | undefined;
const report: Record<string, unknown> = { source: { width: 1920, height: 1080, duration: 24, fps: 30, gop: 180, sha256: before }, runs: [] };
async function diskBytes(directory: string): Promise<number> {
  let total = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) total += await diskBytes(path);
    else if (item.isFile()) total += (await stat(path)).size;
  }
  return total;
}
async function capture(page: Page) {
  const state = await page.evaluate(() => {
    const player = document.querySelector<HTMLVideoElement>('[data-testid="video-preview"]');
    const exact = document.querySelector<HTMLImageElement>('[data-testid="exact-frame"]');
    return { at: performance.now(), currentTime: player?.currentTime, seeking: player?.seeking,
      readyState: player?.readyState, videoUrl: player?.src, exactUrl: exact?.src,
      playhead: document.querySelector('[data-testid="playhead"]')?.textContent };
  });
  const pixels = await page.getByTestId('crop-stage').screenshot({ animations: 'disabled' });
  return { ...state, imageHash: createHash('sha256').update(pixels).digest('hex') };
}
try {
  app = await electron.launch({ args: [resolve('.')], env, timeout: 60000 });
  const page = await app.firstWindow();
  await app.context().setOffline(true);
  await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
  // Instrument actual spawn calls, including ESM named imports, in this isolated test process only.
  await app.evaluate(async ({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    const cp = process.getBuiltinModule('node:child_process');
    const original = cp.spawn;
    const rows: unknown[] = [];
    (globalThis as any).__previewSpawns = rows;
    cp.spawn = ((...args: Parameters<typeof original>) => {
      const child = (original as Function)(...args);
      if (/ffmpeg|ffprobe/i.test(String(args[0]))) {
        const record = { executable: String(args[0]).split(/[\\/]/).at(-1), args: args[1], time: Date.now(), pid: child.pid, code: null as number | null };
        if (rows.length < 1000) rows.push(record);
        child.once('close', (code: number | null) => { record.code = code; });
      }
      return child;
    }) as typeof original;
    process.getBuiltinModule('node:module').syncBuiltinESMExports();
  }, input);
  const imported = Date.now();
  await page.getByTestId('open-video').click();
  await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).readyState), { timeout: 60000 }).toBeGreaterThanOrEqual(2);
  report.firstVisibleMs = Date.now() - imported;
  for (const mode of ['original', 'proxy'] as const) {
    if (mode === 'proxy') {
      await page.getByLabel('强制兼容预览', { exact: true }).check();
      await expect(page.getByTestId('play-video')).toBeEnabled({ timeout: 60000 });
      await expect.poll(() => page.getByTestId('video-preview').evaluate(node => (node as HTMLVideoElement).duration), { timeout: 60000 }).toBeLessThan(4);
      await expect(page.getByTestId('next-preview')).toHaveCount(1, { timeout: 60000 });
    }
    await expect(page.getByTestId('trim-end')).toBeEnabled({ timeout: 60000 });
    const track = (await page.getByTestId('timeline').boundingBox())!;
    for (const kind of ['end', 'start', 'playhead'] as const) {
      const beforeDrag = await capture(page);
      const started = Date.now();
      const spawnStart = await app.evaluate(() => (globalThis as any).__previewSpawns.length);
      const handle = page.getByTestId(kind === 'playhead' ? 'timeline-playhead' : `trim-${kind}`);
      const rect = (await handle.boundingBox())!;
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
      const fractions = kind === 'end' ? [.9, .8, .7, .6] : kind === 'start' ? [.1, .2, .3, .4] : [.15, .75, .3, .85];
      const held = [];
      for (const fraction of fractions) {
        const requested = Date.now();
        await page.mouse.move(track.x + track.width * fraction, track.y + track.height / 2, { steps: 8 });
        // Controlled observation interval, not a wait for a background tool task.
        await page.waitForTimeout(150);
        held.push({ fraction, observedAfterMs: Date.now() - requested, ...await capture(page) });
      }
      await page.getByTestId('crop-stage').screenshot({ path: join(root, `${mode}-${kind}-held.png`) });
      const released = Date.now();
      await page.mouse.up();
      if (kind === 'playhead') await expect(page.getByTestId('exact-frame')).toBeVisible({ timeout: 60000 });
      const after = await capture(page);
      const spawns = await app.evaluate(() => (globalThis as any).__previewSpawns);
      const row = { mode, kind, beforeDrag, held, after,
        distinctHeldFrames: new Set(held.map(item => item.imageHash)).size,
        changedFromInitialWhileHeld: held.some(item => item.imageHash !== beforeDrag.imageHash),
        releaseToCaptureMs: Date.now() - released, elapsedMs: Date.now() - started,
        spawnStart, spawnEnd: spawns.length, spawns: spawns.slice(spawnStart),
        sessionCacheBytes: await diskBytes(join(env.MOTION_USER_DATA_DIR!, 'media-sessions')) };
      (report.runs as unknown[]).push(row);
      await writeFile(join(root, 'baseline.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, kind, distinctHeldFrames: row.distinctHeldFrames,
        changedWhileHeld: row.changedFromInitialWhileHeld, releaseToCaptureMs: row.releaseToCaptureMs,
        nativeStarts: row.spawnEnd - row.spawnStart }));
      await expect(page.getByRole('button', { name: '全选片段', exact: true })).toBeEnabled({ timeout: 60000 });
      await page.getByRole('button', { name: '全选片段', exact: true }).click();
    }
  }
  report.spawns = await app.evaluate(() => (globalThis as any).__previewSpawns);
  await page.getByRole('button', { name: '关闭素材', exact: true }).click();
  await expect(page.getByTestId('editor')).toHaveCount(0);
  report.cacheAfterClose = await readdir(join(env.MOTION_USER_DATA_DIR!, 'media-sessions'));
  report.sourceUnchanged = await sha256(input) === before;
  if (!report.sourceUnchanged) throw new Error('Baseline changed the synthetic source');
} catch (error) {
  report.failure = String(error); throw error;
} finally {
  if (app) await app.close();
  await writeFile(join(root, 'baseline.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(root, 'baseline.json')}`);
}
