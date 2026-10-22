import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/contracts.ts';
import { MEDIA_CHANNELS } from '../shared/media-ipc.ts';
import type { AppSnapshot, DesktopAPI } from '../shared/contracts.ts';
import type { ExportProgress } from '../shared/export.ts';

const api: DesktopAPI = {
  security: Object.freeze({ sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true }),
  media: Object.freeze({
    open: () => ipcRenderer.invoke(MEDIA_CHANNELS.open),
    cancelImport: () => ipcRenderer.invoke(MEDIA_CHANNELS.cancelImport),
    preview: (request: Parameters<DesktopAPI['media']['preview']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.preview, request),
    frame: (request: Parameters<DesktopAPI['media']['frame']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.frame, request),
    thumbnails: (request: Parameters<DesktopAPI['media']['thumbnails']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.thumbnails, request),
    uploadCover: (request: Parameters<DesktopAPI['media']['uploadCover']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.uploadCover, request),
    captureCover: (request: Parameters<DesktopAPI['media']['captureCover']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.captureCover, request),
    analyze: (request: Parameters<DesktopAPI['media']['analyze']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.analyze, request),
    renderDraft: (request: Parameters<DesktopAPI['media']['renderDraft']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.renderDraft, request),
    saveDraft: (request: Parameters<DesktopAPI['media']['saveDraft']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.saveDraft, request),
    onExportProgress: (listener: (progress: ExportProgress) => void) => {
      const handler = (_event: unknown, progress: ExportProgress) => listener(progress);
      ipcRenderer.on(MEDIA_CHANNELS.progress, handler);
      return () => { ipcRenderer.removeListener(MEDIA_CHANNELS.progress, handler); };
    },
    cancel: (request: Parameters<DesktopAPI['media']['cancel']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.cancel, request),
    close: (request: Parameters<DesktopAPI['media']['close']>[0]) => ipcRenderer.invoke(MEDIA_CHANNELS.close, request),
  }),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  startDiagnostics: () => ipcRenderer.invoke(CHANNELS.startDiagnostics),
  cancelJob: jobId => ipcRenderer.invoke(CHANNELS.cancelJob, jobId),
  onSnapshot: listener => {
    const handler = (_event: unknown, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => { ipcRenderer.removeListener(CHANNELS.changed, handler); };
  },
};
contextBridge.exposeInMainWorld('motion', Object.freeze(api));
