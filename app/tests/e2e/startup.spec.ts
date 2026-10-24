import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
function environment(userData: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined));
  for (const key of Object.keys(env)) if (['path', 'electron_run_as_node', 'electron_renderer_url', 'ffmpeg_path', 'ffprobe_path'].includes(key.toLowerCase())) delete env[key];
  env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`; env.MOTION_USER_DATA_DIR = userData; return env;
}
test('startup phases explain disabled import, error stays visible, readiness unlocks and native version title persists', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'motion-startup-ui-'));
  const instance = await electron.launch({ ...(process.env.MOTION_PACKAGED_EXE ? { executablePath: resolve(process.env.MOTION_PACKAGED_EXE), args: [] } : { args: [resolve('.')] }), env: environment(userData), timeout: 60000 });
  try {
    const page = await instance.firstWindow(); await instance.context().setOffline(true);
    await expect(page.getByTestId('open-video')).toBeEnabled({ timeout: 60000 });
    const title = await instance.evaluate(({ BrowserWindow, app }) => ({ title: BrowserWindow.getAllWindows()[0]!.getTitle(), version: app.getVersion() }));
    expect(title.title).toContain(title.version);
    const result = await page.evaluate(() => window.motion.getSnapshot()); if (!result.ok) throw Error('No snapshot');
    // Deterministically replay snapshot phases through the real preload event route, not a timing-dependent startup screenshot.
    const snapshot = result.value;
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value),
      { ...snapshot, revision: snapshot.revision + 100, engines: { state: 'checking', integrityVerified: false, check: { stage: 'integrity', binary: 'ffmpeg.exe', index: 1, total: 2 } } });
    await expect(page.getByTestId('startup-status')).toContainText('正在校验 ffmpeg.exe');
    await expect(page.getByTestId('startup-status')).toContainText('完成后自动启用导入'); await expect(page.getByTestId('open-video')).toBeDisabled();
    await expect(page.getByTestId('open-video')).toHaveText('正在准备引擎…');
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value),
      { ...snapshot, revision: snapshot.revision + 101, engines: { state: 'error', integrityVerified: false, error: { code: 'ENGINE_INTEGRITY', message: '引擎校验失败（测试）' } } });
    await expect(page.getByTestId('startup-status')).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('引擎校验失败');
    await expect(page.getByTestId('open-video')).toBeDisabled();
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value), { ...snapshot, revision: snapshot.revision + 102 });
    await expect(page.getByTestId('open-video')).toBeEnabled(); await expect(page.getByTestId('startup-status')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value),
      { ...snapshot, revision: snapshot.revision + 103, previewEngine: { state: 'checking', integrityVerified: false } });
    await expect(page.getByTestId('startup-status')).toContainText('正在校验原生预览引擎'); await expect(page.getByTestId('open-video')).toBeDisabled();
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value),
      { ...snapshot, revision: snapshot.revision + 104, previewEngine: { state: 'error', integrityVerified: false, error: { code: 'NATIVE_PLATFORM', message: '原生预览系统组件不可用（测试）' } } });
    await expect(page.getByTestId('engine-state')).toHaveText('引擎就绪');
    await expect(page.getByTestId('preview-engine-state')).toHaveText('原生预览不可用');
    await expect(page.getByRole('alert')).toContainText('原生预览系统组件不可用'); await expect(page.getByTestId('open-video')).toBeDisabled();
    await instance.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('motion:changed', value), { ...snapshot, revision: snapshot.revision + 105 });
    await expect(page.getByTestId('open-video')).toBeEnabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { await instance.close(); await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
