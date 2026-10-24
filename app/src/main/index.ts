import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNELS } from '../shared/contracts.ts';
import { MEDIA_CHANNELS } from '../shared/media-ipc.ts';
import { parseMediaRequest } from './media/requests.ts';
import { NATIVE_CHANNELS } from '../shared/native-preview.ts';
import { parseNativePrepare, parseNativeControl, parseNativeAck, parseNativeCapture } from './media/native-requests.ts';
import { MediaResources } from './media/resources.ts';
import { MediaSession } from './media/session.ts';
import type { AppSnapshot, EngineStatus } from '../shared/contracts.ts';
import { DEFAULT_PROFILE_ID, VERIFIED_TARGET } from './motion/profiles.ts';
import { verifyEngines } from './media/engine.ts';
import { verifyNativeEngine, verifyNativeFiles } from './media/native-engine.ts';
import type { EnginePaths } from './media/engine.ts';
import { DiagnosticQueue } from './jobs/queue.ts';
import { TempFiles } from './jobs/temp-files.ts';
import { Publications } from './jobs/publications.ts';
import { randomUUID } from 'node:crypto';
import { AppFailure, publicError, reply } from './errors.ts';
import { APP_URL, CONTENT_SECURITY_POLICY, isTrustedRenderer, resolveAppResource, assertNoArgs, parseJobId } from './security.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '../renderer');
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (developmentUrl && !isTrustedRenderer(developmentUrl, developmentUrl)) throw new Error('Development renderer must use localhost');
// Deployment/test override changes only the app-private data directory, not renderer privileges.
if (process.env.MOTION_USER_DATA_DIR) app.setPath('userData', resolve(process.env.MOTION_USER_DATA_DIR));
app.setName('Motion Photo Studio');
app.setAppUserModelId('local.motionphotostudio.desktop');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let window: BrowserWindow | null = null;
let engines: EnginePaths | undefined;
let engineStatus: EngineStatus = { state: 'checking', integrityVerified: false };
let previewEngineStatus: EngineStatus = { state: 'checking', integrityVerified: false };
let previewCheck: Promise<unknown> | undefined;
let warnings: string[] = [];
const cleanupStores: TempFiles[] = [];
let jobs: DiagnosticQueue | undefined;
let editor: MediaSession | undefined;
let publications: Publications | undefined;
let pickingFile = false;
const mediaResources = new MediaResources();
let shuttingDown = false;
let safeToQuit = false;
let revision = 0;

function snapshot(): AppSnapshot {
  return {
    revision, appVersion: app.getVersion(), milestone: 'M4', savingReady: Boolean(publications), offline: true, defaultProfile: DEFAULT_PROFILE_ID,
    target: VERIFIED_TARGET, engines: structuredClone(engineStatus), previewEngine: structuredClone(previewEngineStatus), job: jobs?.snapshot() ?? null,
    startupWarnings: [...new Set(warnings)], cleanupIssues: cleanupStores.flatMap(store => store.issues),
  };
}
function broadcast() {
  revision++;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(CHANNELS.changed, snapshot());
}
function trusted(event: Electron.IpcMainInvokeEvent) {
  if (!window || !event.senderFrame || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !isTrustedRenderer(event.senderFrame.url, developmentUrl)) throw new AppFailure('UNTRUSTED_SENDER', '拒绝来自非应用主页面的请求。');
}

function mediaReady(): MediaSession {
  if (!editor || engineStatus.state !== 'ready' || shuttingDown) throw new AppFailure('ENGINE_NOT_READY', '离线媒体引擎尚未就绪。');
  if (pickingFile || ['running', 'cancelling'].includes(jobs?.snapshot()?.state ?? '')) throw new AppFailure('JOB_BUSY', '请先完成文件选择或离线自检。');
  return editor;
}
async function chooseFile(cover: boolean): Promise<string | null> {
  if (!window || pickingFile) throw new AppFailure('JOB_BUSY', '已有文件选择窗口，请先完成操作。');
  pickingFile = true;
  try {
    const result = await dialog.showOpenDialog(window, { title: cover ? '选择 JPG / PNG 封面' : '导入本地视频', properties: ['openFile'],
      filters: [{ name: cover ? '封面图片' : '视频文件', extensions: cover ? ['jpg', 'jpeg', 'png']
        : ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv'] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } finally { pickingFile = false; }
}

async function chooseSaveFile(): Promise<string | null> {
  if (!window || pickingFile) throw new AppFailure('JOB_BUSY', '已有文件选择窗口，请先完成操作。');
  pickingFile = true;
  try {
    const name = `MVIMG_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}.jpg`;
    const selected = await dialog.showSaveDialog(window, { title: '保存实况照片（不覆盖已有文件）', buttonLabel: '保存',
      defaultPath: join(app.getPath('pictures'), name), filters: [{ name: 'JPEG 实况照片', extensions: ['jpg', 'jpeg'] }],
      properties: ['createDirectory', 'dontAddToRecent'] });
    return selected.canceled ? null : selected.filePath ?? null;
  } finally { pickingFile = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (safeToQuit) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([jobs?.shutdown(), editor?.shutdown(), previewCheck])
      .then(results => {
        for (const result of results) if (result.status === 'rejected') console.error('Task cleanup failed:', publicError(result.reason));
        return mediaResources.dispose();
      })
      .catch(error => console.error('Resource drain failed:', publicError(error)))
      .finally(() => { safeToQuit = true; app.quit(); });
  });
  void app.whenReady().then(async () => {
    const localSession = session.defaultSession;
    localSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    localSession.setPermissionCheckHandler(() => false);
    localSession.on('will-download', event => event.preventDefault());
    localSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        const dev = developmentUrl ? new URL(developmentUrl) : undefined;
        const localDev = dev && (url.origin === dev.origin
          || ['ws:', 'wss:'].includes(url.protocol) && url.host === dev.host);
        callback({ cancel: !(url.protocol === 'app:' && url.hostname === 'ui'
          || url.protocol === 'media:' && url.hostname === 'asset' && !url.username && !url.password && !url.port
          || url.protocol === 'data:' || localDev) });
      } catch { callback({ cancel: true }); }
    });
    await protocol.handle('app', async request => {
      try {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const path = resolveAppResource(rendererRoot, request.url);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) return new Response(null, { status: 404 });
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(path)), {
          headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
            'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
        });
      } catch { return new Response(null, { status: 404 }); }
    });
    await protocol.handle('media', request => mediaResources.respond(request, developmentUrl ? new URL(developmentUrl).origin : 'app://ui'));
    const sessionTemp = new TempFiles(join(app.getPath('userData'), 'media-sessions'));
    const temp = new TempFiles(join(app.getPath('userData'), 'jobs'));
    cleanupStores.push(temp, sessionTemp);
    try { await temp.initialize(); }
    catch { warnings = ['任务目录不可写，媒体自检将无法完成。']; }
    try { await sessionTemp.initialize(); }
    catch { warnings.push('媒体缓存目录不可写，请检查应用数据目录权限。'); }
    try {
      const candidate = new Publications(join(app.getPath('userData'), 'publications'));
      warnings.push(...await candidate.initialize()); publications = candidate;
    } catch { warnings.push('保存恢复目录不可写或所有权异常，实况保存已禁用；未删除源文件或已有成品。'); }
    jobs = new DiagnosticQueue(temp, broadcast);
    ipcMain.handle(CHANNELS.snapshot, (event, ...args: unknown[]) => reply(() => { trusted(event); assertNoArgs(args); return snapshot(); }));
    ipcMain.handle(CHANNELS.startDiagnostics, (event, ...args: unknown[]) => reply(() => {
      trusted(event); assertNoArgs(args);
      if (!engines || engineStatus.state !== 'ready' || !jobs || shuttingDown) throw new AppFailure('ENGINE_NOT_READY', '离线媒体引擎尚未就绪。');
      if (editor?.busy || pickingFile) throw new AppFailure('JOB_BUSY', '媒体处理尚未结束，请稍后运行自检。');
      return { jobId: jobs.start(engines) };
    }));
    ipcMain.handle(CHANNELS.cancelJob, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const id = parseJobId(args);
      if (!jobs) throw new AppFailure('JOB_NOT_FOUND', '任务不存在。');
      jobs.cancel(id); return null;
    }));
    ipcMain.handle(MEDIA_CHANNELS.open, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); assertNoArgs(args); mediaReady();
      const path = await chooseFile(false); return path ? mediaReady().open(path) : null;
    }));
    ipcMain.handle(MEDIA_CHANNELS.cancelImport, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); assertNoArgs(args); await mediaReady().cancelImport(); return null;
    }));
    ipcMain.handle(NATIVE_CHANNELS.prepare, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseNativePrepare(args);
      if (previewEngineStatus.state !== 'ready') throw new AppFailure('ENGINE_NOT_READY', '原生预览引擎未通过校验，请检查帮助中的状态。');
      return mediaReady().prepareNative(p.assetId, p.hdrConsent);
    }, error => console.error('Native preparation failed:', error)));
    ipcMain.handle(NATIVE_CHANNELS.control, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); const p = parseNativeControl(args);
      const target = p.action === 'pause' && editor && !shuttingDown ? editor : mediaReady();
      await target.nativeControl(p); return null;
    }));
    ipcMain.handle(NATIVE_CHANNELS.ack, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseNativeAck(args);
      if (!editor) throw new AppFailure('CANCELLED', '预览会话已关闭。');
      editor.nativeAcknowledge(p); return null;
    }));
    ipcMain.handle(NATIVE_CHANNELS.capture, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseNativeCapture(args); return mediaReady().nativeCover(p.assetId, p.frameId);
    }));
    ipcMain.handle(MEDIA_CHANNELS.thumbnails, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseMediaRequest('thumbnails', args);
      return mediaReady().thumbnails(p.assetId, p.startUs, p.endUs, p.count, p.hdrConsent);
    }));
    ipcMain.handle(MEDIA_CHANNELS.uploadCover, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); const p = parseMediaRequest('uploadCover', args); mediaReady().assertActive(p.assetId);
      const path = await chooseFile(true); return path ? mediaReady().uploadCover(p.assetId, path) : null;
    }));
    ipcMain.handle(MEDIA_CHANNELS.analyze, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseMediaRequest('analyze', args); return mediaReady().analyze(p.assetId, p.options);
    }, error => console.error('Local export analysis failed:', error)));
    ipcMain.handle(MEDIA_CHANNELS.renderDraft, (event, ...args: unknown[]) => reply(() => {
      trusted(event); const p = parseMediaRequest('renderDraft', args); return mediaReady().renderDraft(p.assetId, p.analysisId, p.image);
    }, error => console.error('Local draft rendering failed:', error)));
    ipcMain.handle(MEDIA_CHANNELS.saveDraft, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); const p = parseMediaRequest('saveDraft', args); mediaReady().assertDraft(p.assetId, p.draftId);
      const path = await chooseSaveFile();
      return path ? mediaReady().saveDraft(p.assetId, p.draftId, p.saveId, path) : null;
    }, error => console.error('Local final publication failed:', error)));
    ipcMain.handle(MEDIA_CHANNELS.cancel, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); const p = parseMediaRequest('cancel', args); return mediaReady().cancel(p.assetId, p.saveId);
    }));
    ipcMain.handle(MEDIA_CHANNELS.close, (event, ...args: unknown[]) => reply(async () => {
      trusted(event); const p = parseMediaRequest('close', args); await mediaReady().close(p.assetId); return null;
    }));
    window = new BrowserWindow({
      width: 1180, height: 820, minWidth: 860, minHeight: 640, backgroundColor: '#151517',
      title: `实况工坊 ${app.getVersion()} · 本地视频编辑`, show: false, autoHideMenuBar: true,
      // Native WASAPI playback is outside Chromium's media detection. Throttling RAF
      // in the background stalls Canvas ACKs while its audio/device clock keeps running.
      webPreferences: { preload: join(here, '../preload/index.cjs'), sandbox: true, contextIsolation: true,
        backgroundThrottling: false, nodeIntegration: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false },
    });
    window.on('page-title-updated', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!isTrustedRenderer(url, developmentUrl)) event.preventDefault(); });
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => { window = null; });
    const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
    // Verify concurrently with rendering the first UI, but never enable media operations early.
    // Attach rejection handling immediately, even if renderer loading takes longer or fails.
    const verification = verifyEngines(resources, check => {
      engineStatus = { state: 'checking', integrityVerified: false, check }; broadcast();
    }).then(paths => ({ ok: true as const, paths }), error => ({ ok: false as const, error }));
    const nativeVerification = verifyNativeEngine(resources).then(engine => {
      previewEngineStatus = { state: 'ready', integrityVerified: true, version: engine.version }; broadcast();
      return { ok: true as const, engine };
    }, error => {
      previewEngineStatus = { state: 'error', integrityVerified: false, error: publicError(error) }; broadcast();
      return { ok: false as const, error };
    });
    previewCheck = nativeVerification;
    await window.loadURL(developmentUrl ?? APP_URL);
    try {
      const [verified, preview] = await Promise.all([verification, nativeVerification]);
      if (shuttingDown) return;
      if (!verified.ok) throw verified.error;
      engines = verified.paths;
      editor = new MediaSession(engines, sessionTemp, mediaResources, message => { warnings.push(message); broadcast(); }, progress => {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(MEDIA_CHANNELS.progress, progress);
      }, publications, [temp.root], preview.ok ? {
        helper: preview.engine.helper,
        verify: async () => {
          try { await verifyNativeFiles(resources); }
          catch (error) { previewEngineStatus = { state: 'error', integrityVerified: false, error: publicError(error) }; broadcast(); throw error; }
        },
        frame: frame => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(NATIVE_CHANNELS.frame, frame); },
        status: status => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(NATIVE_CHANNELS.status, status); },
      } : undefined);
      engineStatus = { state: 'ready', version: engines.build, integrityVerified: true };
    } catch (error) { engineStatus = { state: 'error', integrityVerified: false, error: publicError(error) }; }
    broadcast();
  }).catch(error => { console.error('Desktop startup failed:', error); app.exit(1); });
}
