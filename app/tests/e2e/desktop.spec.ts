import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, rm, cp, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { DesktopAPI } from '../../src/shared/contracts.ts';

const appRoot = resolve('.');
const packaged = process.env.MOTION_PACKAGED_EXE;
function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.FFMPEG_PATH; delete env.FFPROBE_PATH;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`;
  env.MOTION_USER_DATA_DIR = userData;
  return env;
}

test('offline desktop uses bundled engines, isolates renderer, completes and cancels jobs', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'motion-desktop-'));
  const instance = await electron.launch({ ...(packaged ? { executablePath: resolve(packaged), args: [] } : { args: [appRoot] }), env: environment(userData), timeout: 60000 });
  let closed = false;
  try {
    const page = await instance.firstWindow();
    await instance.context().setOffline(true);
    await expect(page.getByTestId('engine-state')).toHaveText('引擎就绪', { timeout: 60000 });
    const surface = await page.evaluate(() => ({
      nodeRequire: typeof (globalThis as unknown as { require?: unknown }).require,
      nodeProcess: typeof (globalThis as unknown as { process?: unknown }).process,
      keys: Object.keys((window as Window & { motion: DesktopAPI }).motion).sort(),
      security: window.motion.security,
    }));
    expect(surface.nodeRequire).toBe('undefined'); expect(surface.nodeProcess).toBe('undefined');
    expect(surface.keys).toEqual(['cancelJob', 'getSnapshot', 'media', 'onSnapshot', 'security', 'startDiagnostics']);
    expect(await page.evaluate(() => Object.keys(window.motion.media).sort())).toEqual(['analyze', 'cancel', 'cancelImport', 'close', 'native', 'onExportProgress', 'open', 'renderDraft', 'saveDraft', 'thumbnails', 'uploadCover']);
    expect(await page.evaluate(() => Object.keys(window.motion.media.native).sort())).toEqual(['acknowledge', 'capture', 'control', 'onFrame', 'onStatus', 'prepare']);
    const nativeInvalid = await page.evaluate(() => window.motion.media.native.prepare({ assetId: '12345678-1234-1234-1234-123456789abc', hdrConsent: false, path: 'C:\\arbitrary.mp4' } as any));
    expect(nativeInvalid.ok).toBe(false);
    if (!nativeInvalid.ok) expect(nativeInvalid.error.code).toBe('INVALID_REQUEST');
    // Read actual preload process facts, not an injected script's unrelated isolated-world globals.
    expect(surface.security).toEqual({ sandboxed: true, contextIsolated: true });
    await expect(page.getByTestId('preview-engine-state')).toHaveText('原生预览就绪');
    const osSandbox = await instance.evaluate(({ BrowserWindow, app }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return app.getAppMetrics().find(item => item.pid === contents.getOSProcessId())?.sandboxed;
    });
    expect(osSandbox).toBe(true);
    const invalid = await page.evaluate(() => window.motion.cancelJob('C:\\secret & arbitrary-command'));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_REQUEST');
    expect(await page.evaluate(async () => { try { await fetch('https://example.com/'); return 'allowed'; } catch { return 'blocked'; } })).toBe('blocked');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '帮助与检查', exact: true }).click();
    await page.getByTestId('diagnostics').locator('summary').first().click();
    await page.getByTestId('start-diagnostics').click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-state', 'running');
    await page.getByTestId('cancel-job').click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-state', 'cancelled');
    expect(await readdir(join(userData, 'jobs'))).toEqual([]);
    await page.getByTestId('start-diagnostics').click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-state', 'completed');
    expect(await readdir(join(userData, 'jobs'))).toEqual([]);
    await mkdir(resolve('../artifacts/desktop'), { recursive: true });
    await page.screenshot({ path: resolve(`../artifacts/desktop/m4-ui-${packaged ? 'packaged' : 'development'}-support.png`) });
    await page.getByTestId('start-diagnostics').click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-state', 'running');
    await instance.close(); closed = true;
    expect(await readdir(join(userData, 'jobs'))).toEqual([]);
  } finally {
    if (!closed) await instance.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('missing engine package stays disabled rather than using PATH or downloading', async () => {
  test.skip(Boolean(packaged), 'Missing-resource fixture runs against the same development bundle without mutating packaged resources.');
  const directory = await mkdtemp(join(tmpdir(), 'motion-missing-'));
  try {
    await cp(join(appRoot, 'out'), join(directory, 'out'), { recursive: true });
    // Keep the complete installed runtime (including Sharp and its platform dependencies).
    // Only resources/bin is absent: a missing JS module would test a startup crash instead.
    await symlink(join(appRoot, 'node_modules'), join(directory, 'node_modules'), 'junction');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'motion-missing-fixture', version: '0.0.0', type: 'module', main: 'out/main/index.js' }));
    const instance = await electron.launch({ args: [directory], env: environment(join(directory, 'user-data')), timeout: 60000 });
    try {
      const page = await instance.firstWindow();
      await expect(page.getByTestId('engine-state')).toHaveText('引擎不可用');
      await expect(page.getByRole('alert').filter({ hasText: '缺少有效的离线媒体引擎清单' })).toBeVisible();
      await expect(page.getByTestId('open-video')).toBeDisabled();
      await page.getByRole('button', { name: '帮助与检查', exact: true }).click();
      await page.getByTestId('diagnostics').locator('summary').first().click();
      await expect(page.getByTestId('start-diagnostics')).toBeDisabled();
    } finally { await instance.close(); }
  } finally {
    // Remove the junction itself before recursively removing this owned fixture.
    await unlink(join(directory, 'node_modules')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
