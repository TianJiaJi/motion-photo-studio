import type { MediaAPI } from './media-ipc.ts';

export const CHANNELS = Object.freeze({
  snapshot: 'motion:snapshot', startDiagnostics: 'motion:start-diagnostics',
  cancelJob: 'motion:cancel-job', changed: 'motion:changed',
});

export type AppErrorCode = 'INVALID_REQUEST' | 'UNTRUSTED_SENDER' | 'ENGINE_NOT_READY'
  | 'ENGINE_MISSING' | 'ENGINE_INTEGRITY' | 'ENGINE_VERSION' | 'JOB_BUSY'
  | 'JOB_NOT_FOUND' | 'MEDIA_FAILED' | 'TEMP_CLEANUP' | 'INTERNAL'
  | 'CANCELLED' | 'SOURCE_CHANGED' | 'MEDIA_NOT_FOUND' | 'HDR_CONFIRM_REQUIRED' | 'FRAME_BOUNDARY'
  | 'OUTPUT_EXISTS' | 'OUTPUT_ACCESS' | 'OUTPUT_UNSUPPORTED' | 'OUTPUT_VERIFY' | 'DISK_SPACE';
export type AppError = { code: AppErrorCode; message: string };
export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type EngineStatus = {
  state: 'checking' | 'ready' | 'error'; version?: string; integrityVerified: boolean; error?: AppError;
};
export type JobState = {
  id: string; kind: 'diagnostics'; state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  progress: number; message: string; startedAt: string; finishedAt?: string; error?: AppError;
};
export type AppSnapshot = {
  revision: number; appVersion: string; milestone: 'M1' | 'M2' | 'M3' | 'M4' | 'M5'; savingReady: boolean; offline: true; defaultProfile: string;
  target: { model: string; osBuild: string; android: string; gallery: string };
  engines: EngineStatus; job: JobState | null; startupWarnings: string[];
};
export type DesktopAPI = {
  readonly security: Readonly<{ sandboxed: boolean; contextIsolated: boolean }>;
  readonly media: Readonly<MediaAPI>;
  getSnapshot(): Promise<Reply<AppSnapshot>>;
  startDiagnostics(): Promise<Reply<{ jobId: string }>>;
  cancelJob(jobId: string): Promise<Reply<null>>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
};
