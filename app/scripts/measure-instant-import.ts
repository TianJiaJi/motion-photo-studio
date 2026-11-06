// Bounded local-only measurement for the on-demand preview contract. No uploads or source writes.
// Fresh app/helper each run; source hashing warms the OS cache, so these are NOT cold-disk measurements.
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { sha256 } from '../src/main/motion/io.ts';
import { openSource } from '../src/main/media/source.ts';
import { probeMedia } from '../src/main/media/probe.ts';
import { mediaInfo } from '../src/main/media/info.ts';
import { frameAtOrAfter } from '../src/main/media/encode-plan.ts';
import { formatTime, ptsToUs } from '../src/shared/editor.ts';

if (process.argv.length < 4 || process.argv.length > 5) throw new Error('Usage: node scripts/measure-instant-import.ts <selected-local-manifest> <runs:1..10> [exact-packaged-exe]');
const runs = Number(process.argv[3]);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Bounded run count required');
const selection = JSON.parse(await readFile(resolve(process.argv[2]!), 'utf8')) as { cases: { name: string; path: string }[] };
if (!Array.isArray(selection.cases) || !selection.cases.length || selection.cases.length > 8) throw new Error('Explicit bounded selection required');
const exe = process.argv[4] ? await realpath(process.argv[4]) : undefined;
const allowed = await Promise.all(['Downloads', 'Videos'].map(name => realpath(join(process.env.USERPROFILE!, name))));
const resources = exe ? join(dirname(exe), 'resources') : resolve('resources');
const ffprobe = join(resources, 'bin/ffprobe.exe'), ffmpeg = join(resources, 'bin/ffmpeg.exe');
const root = resolve(`../artifacts/native-preview/instant-import-${Date.now()}`); await mkdir(root, { recursive: true });
const report: { scope: string; helperSha256: string; packageIdentity?: Record<string, string>; packageUnchanged?: boolean; runs: unknown[] } = {
  scope: 'Dialog-confirmation to painted frame + enabled playback; selected audio subsequently played. Fresh app/helper, hash-warmed/uncontrolled OS cache. Two source-oracle seeks and an exact step/capture per run. Not physical AV sync, cold-disk P95, sustained drift, or full performance matrix.',
  helperSha256: await sha256(join(resources, 'bin/motion-preview.exe')), runs: [],
};
async function packageIdentity() {
  if (!exe) return undefined;
  return { exeSha256: await sha256(exe), asarSha256: await sha256(join(resources, 'app.asar')),
    nativeManifestSha256: await sha256(join(resources, 'native-preview-manifest.json')) };
}
report.packageIdentity = await packageIdentity();
console.log(`Local evidence directory: ${root}`);
let failed = false;
for (const entry of selection.cases) {
  if (!/^[a-z0-9-]{1,64}$/.test(entry.name)) throw new Error('Invalid evidence label');
  const sourcePath = await realpath(entry.path);
  if (!allowed.some(folder => sourcePath.toLowerCase().startsWith((folder + sep).toLowerCase()))) throw new Error('Source outside previously authorized Downloads/Videos');
  const source = await openSource(sourcePath), before = await sha256(sourcePath);
  const info = mediaInfo(await probeMedia(sourcePath, { executable: ffprobe }));
  for (let run = 1; run <= runs; run++) {
    const userData = join(root, `${entry.name}-${run}`);
    const row: any = { name: entry.name, run, durationUs: info.durationUs, width: info.displayWidth, height: info.displayHeight,
      hasAudio: info.hasAudio, sourceSha256: before, cache: 'hash-warmed/uncontrolled', helperCold: true, packaged: Boolean(exe) };
    report.runs.push(row);
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
      delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; env.MOTION_USER_DATA_DIR = userData;
      const launchAt = Date.now();
      app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: [resolve('.')] }), env, timeout: 60000 });
      const page = await app.firstWindow(); await app.context().setOffline(true);
      await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 }); row.appLaunchToImportEnabledMs = Date.now() - launchAt;
      await app.evaluate(({ dialog }, source) => {
        const record: any = { confirmedAt: 0, processes: [] }; (globalThis as any).__instantMain = record;
        dialog.showOpenDialog = async () => { record.confirmedAt = Date.now(); return { canceled: false, filePaths: [source] }; };
        const cp = process.getBuiltinModule('node:child_process'), original = cp.spawn;
        cp.spawn = ((...args: Parameters<typeof original>) => {
          const child = Reflect.apply(original, cp, args);
          const item = { executable: String(args[0]), args: Array.isArray(args[1]) ? args[1] : [], pid: child.pid, startedAt: Date.now(), closed: false };
          record.processes.push(item); child.once('close', () => { item.closed = true; }); return child;
        }) as typeof original;
        process.getBuiltinModule('node:module').syncBuiltinESMExports();
      }, sourcePath);
      await page.evaluate(() => {
        const record: any = { firstPixelsAt: null, readyAt: null, states: [] }; (window as any).__instantRenderer = record;
        window.motion.media.native.onStatus(status => record.states.push({ ...status, observedAt: Date.now() }));
        new MutationObserver(() => {
          const canvas = document.querySelector<HTMLElement>('[data-testid="native-preview"]');
          const play = document.querySelector<HTMLButtonElement>('[data-testid="play-video"]');
          if (canvas?.dataset.frameId) {
            record.firstPixelsAt ??= Date.now();
            if (play && !play.disabled) record.readyAt ??= Date.now();
          }
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-frame-id', 'disabled'] });
      });
      await page.getByTestId('open-video').click();
      const canvas = page.getByTestId('native-preview');
      await expect(canvas).toHaveAttribute('data-frame-id', /\d+/, { timeout: 240000 });
      await expect(page.getByTestId('play-video')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__instantRenderer.readyAt))).toBe(true);
      const main = await app.evaluate(() => (globalThis as any).__instantMain);
      const rendered = await page.evaluate(() => (window as any).__instantRenderer);
      row.firstPixelsMs = rendered.firstPixelsAt - main.confirmedAt; row.readyMs = rendered.readyAt - main.confirmedAt;
      row.fallbackReasons = [...new Set(rendered.states.filter((s: any) => s.reason).map((s: any) => s.reason))];
      row.preReadyFullProbe = main.processes.some((p: any) => p.startedAt <= rendered.readyAt && p.args.includes('-show_frames') && !p.args.includes('-read_intervals'));
      row.caption = await page.locator('.preview-caption strong').innerText();
      row.audioSelected = info.hasAudio ? await page.getByLabel('保留音轨', { exact: true }).isChecked() : false;
      if (info.hasAudio) expect(row.audioSelected).toBe(true);
      await page.getByTestId('play-video').click();
      await expect.poll(() => page.evaluate(() => (window as any).__instantRenderer.states.some((s: any) => s.state === 'playing')), { timeout: 15000 }).toBe(true);
      await expect.poll(async () => Number(await canvas.getAttribute('data-time-us')), { timeout: 15000 }).toBeGreaterThan(200000);
      await page.getByTestId('play-video').click(); await expect(page.getByTestId('play-video')).toHaveText('播放选段');
      row.playbackAdvancedWithSelectedAudio = true;
      const seek: { targetUs: number; shownUs: number; ms: number; expectedPts?: string }[] = []; row.seeks = seek;
      for (const fraction of [.8, .2]) {
        const targetUs = Math.floor(info.durationUs * fraction / 1000) * 1000;
        const field = page.getByLabel('精确定位', { exact: true }); await field.fill(formatTime(targetUs));
        const previousEpoch = Number(await canvas.getAttribute('data-epoch')), began = Date.now(); await field.press('Enter');
        await expect.poll(async () => Number(await canvas.getAttribute('data-epoch')), { timeout: 30000 }).toBeGreaterThan(previousEpoch);
        seek.push({ targetUs, shownUs: Number(await canvas.getAttribute('data-time-us')), ms: Date.now() - began });
      }
      const previousTime = Number(await canvas.getAttribute('data-time-us')), began = Date.now();
      await page.getByRole('button', { name: '下一帧', exact: true }).click();
      await expect.poll(async () => Number(await canvas.getAttribute('data-time-us')), { timeout: 30000 }).toBeGreaterThan(previousTime);
      row.stepMs = Date.now() - began; row.stepPts = await canvas.getAttribute('data-pts'); expect(row.stepPts).toMatch(/^-?\d+$/);
      const captureAt = Date.now(); await page.getByTestId('capture-cover').click();
      await expect(page.getByTestId('cover-preview')).toBeVisible({ timeout: 30000 }); row.captureMs = Date.now() - captureAt;
      // Oracle work happens AFTER all latency samples, never as a prerequisite to measured opening.
      const budget = { maxFrames: 4096, maxBackUs: 32_000_000, timeoutMs: 15000 };
      for (const sample of seek) {
        const expected = await frameAtOrAfter(source, info, sample.targetUs, ffmpeg, undefined, undefined, budget);
        if (!expected.found) throw new Error('No oracle frame at seek'); sample.expectedPts = expected.found.pts.toString();
        expect(Math.abs(ptsToUs(sample.expectedPts, info.startPts, info.timeBase) - sample.shownUs)).toBeLessThanOrEqual(8);
      }
      const next = await frameAtOrAfter(source, info, previousTime + 8, ffmpeg, undefined, undefined, budget);
      expect(row.stepPts).toBe(next.found?.pts.toString()); row.sourceTimeOracleMatched = true;
      await page.getByRole('button', { name: '关闭素材', exact: true }).click(); await expect(page.getByTestId('editor')).toHaveCount(0);
      expect(await readdir(join(userData, 'media-sessions'))).toEqual([]);
      const processes = await app.evaluate(() => (globalThis as any).__instantMain.processes);
      row.processes = processes.map((p: any) => ({ executable: basename(p.executable), pid: p.pid, closed: p.closed }));
      expect(processes.every((p: any) => p.closed)).toBe(true); row.cleaned = true;
    } catch (error) { row.error = String(error); failed = true; }
    finally {
      await app?.close(); row.sourceUnchanged = await sha256(sourcePath) === before;
      if (!row.sourceUnchanged) failed = true;
      await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ name: row.name, run, readyMs: row.readyMs, fallback: row.fallbackReasons, error: row.error ?? null, sourceUnchanged: row.sourceUnchanged }));
    }
  }
}
if (exe) {
  report.packageUnchanged = JSON.stringify(await packageIdentity()) === JSON.stringify(report.packageIdentity)
    && await sha256(join(resources, 'bin/motion-preview.exe')) === report.helperSha256;
  if (!report.packageUnchanged) failed = true;
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
if (failed) process.exitCode = 1;
