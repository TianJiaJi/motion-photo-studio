import type { ClipModel } from './editor.ts';
import type { Reply } from './contracts.ts';
import type { ExportOptions, ExportInspection, DraftOptions, ExportDraft, ExportProgress, SavedMotion, CancelResult, BatchSnapshot, BatchResult } from './export.ts';
import type { VideoAsset, Thumbnail, CoverAsset } from './media.ts';
import type { PreviewAck, PreviewControl, PreviewPixels, PreviewReady, PreviewStatus } from './native-preview.ts';

export const MEDIA_CHANNELS = Object.freeze({
  exportAll: 'motion:media:export-all',
  syncClips: 'motion:media:sync-clips', clearCover: 'motion:media:clear-cover',
  importSelected: 'motion:media:import-selected',
  open: 'motion:media:open', cancelImport: 'motion:media:cancel-import',
  thumbnails: 'motion:media:thumbnails', uploadCover: 'motion:media:upload-cover',
  cancel: 'motion:media:cancel', close: 'motion:media:close',
  analyze: 'motion:media:analyze', renderDraft: 'motion:media:render-draft', saveDraft: 'motion:media:save-draft',
  progress: 'motion:media:export-progress',
});
export type AssetRequest = { assetId: string };
export type ClipReference = { clipId: string; revision: number };
// Absent scope preserves the original single-clip contract at revision zero only.
export type ClipScope = { clipId?: string; revision?: number };
export type MediaRequests = {
  exportAll: AssetRequest & { snapshot: BatchSnapshot };
  syncClips: AssetRequest & { clips: ClipModel[] };
  clearCover: AssetRequest & ClipScope;
  thumbnails: AssetRequest & { startUs: number; endUs: number; count: number; hdrConsent: boolean };
  uploadCover: AssetRequest & ClipScope; cancel: AssetRequest & { saveId?: string; batchId?: string }; close: AssetRequest;
  analyze: AssetRequest & ClipScope & { options: ExportOptions };
  renderDraft: AssetRequest & ClipScope & { analysisId: string; image: DraftOptions };
  saveDraft: AssetRequest & ClipScope & { draftId: string; saveId: string };
};
export type NativePreviewAPI = {
  prepare(request: AssetRequest & { hdrConsent: boolean; audioTrack?: number | null; forceStrict?: boolean }): Promise<Reply<PreviewReady>>;
  control(request: PreviewControl): Promise<Reply<null>>;
  acknowledge(request: PreviewAck): Promise<Reply<null>>;
  capture(request: AssetRequest & ClipScope & { frameId: number; epoch: number }): Promise<Reply<CoverAsset>>;
  onFrame(listener: (frame: PreviewPixels) => void): () => void;
  onStatus(listener: (status: PreviewStatus) => void): () => void;
};
export type MediaAPI = {
  readonly native: Readonly<NativePreviewAPI>;
  exportAll(request: MediaRequests['exportAll']): Promise<Reply<BatchResult>>;
  syncClips(request: MediaRequests['syncClips']): Promise<Reply<null>>;
  clearCover(request: MediaRequests['clearCover']): Promise<Reply<null>>;
  open(): Promise<Reply<VideoAsset | null>>;
  onImportSelected(listener: () => void): () => void;
  cancelImport(): Promise<Reply<null>>;
  thumbnails(request: MediaRequests['thumbnails']): Promise<Reply<Thumbnail[]>>;
  uploadCover(request: MediaRequests['uploadCover']): Promise<Reply<CoverAsset | null>>;
  analyze(request: MediaRequests['analyze']): Promise<Reply<ExportInspection>>;
  renderDraft(request: MediaRequests['renderDraft']): Promise<Reply<ExportDraft>>;
  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
  saveDraft(request: MediaRequests['saveDraft']): Promise<Reply<SavedMotion | null>>;
  cancel(request: MediaRequests['cancel']): Promise<Reply<CancelResult>>;
  close(request: AssetRequest): Promise<Reply<null>>;
};
