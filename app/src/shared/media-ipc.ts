import type { Reply } from './contracts.ts';
import type { ExportOptions, ExportInspection, DraftOptions, ExportDraft, ExportProgress, SavedMotion, CancelResult } from './export.ts';
import type { VideoAsset, Thumbnail, CoverAsset } from './media.ts';
import type { PreviewAck, PreviewControl, PreviewPixels, PreviewReady, PreviewStatus } from './native-preview.ts';

export const MEDIA_CHANNELS = Object.freeze({
  open: 'motion:media:open', cancelImport: 'motion:media:cancel-import',
  thumbnails: 'motion:media:thumbnails', uploadCover: 'motion:media:upload-cover',
  cancel: 'motion:media:cancel', close: 'motion:media:close',
  analyze: 'motion:media:analyze', renderDraft: 'motion:media:render-draft', saveDraft: 'motion:media:save-draft', progress: 'motion:media:export-progress',
});
export type AssetRequest = { assetId: string };
export type MediaRequests = {
  thumbnails: AssetRequest & { startUs: number; endUs: number; count: number; hdrConsent: boolean };
  uploadCover: AssetRequest; cancel: AssetRequest & { saveId?: string }; close: AssetRequest;
  analyze: AssetRequest & { options: ExportOptions };
  renderDraft: AssetRequest & { analysisId: string; image: DraftOptions };
  saveDraft: AssetRequest & { draftId: string; saveId: string };
};
export type NativePreviewAPI = {
  prepare(request: AssetRequest & { hdrConsent: boolean }): Promise<Reply<PreviewReady>>;
  control(request: PreviewControl): Promise<Reply<null>>;
  acknowledge(request: PreviewAck): Promise<Reply<null>>;
  capture(request: AssetRequest & { frameId: number }): Promise<Reply<CoverAsset>>;
  onFrame(listener: (frame: PreviewPixels) => void): () => void;
  onStatus(listener: (status: PreviewStatus) => void): () => void;
};
export type MediaAPI = {
  readonly native: Readonly<NativePreviewAPI>;
  open(): Promise<Reply<VideoAsset | null>>;
  cancelImport(): Promise<Reply<null>>;
  thumbnails(request: MediaRequests['thumbnails']): Promise<Reply<Thumbnail[]>>;
  uploadCover(request: AssetRequest): Promise<Reply<CoverAsset | null>>;
  analyze(request: MediaRequests['analyze']): Promise<Reply<ExportInspection>>;
  renderDraft(request: MediaRequests['renderDraft']): Promise<Reply<ExportDraft>>;
  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
  saveDraft(request: MediaRequests['saveDraft']): Promise<Reply<SavedMotion | null>>;
  cancel(request: MediaRequests['cancel']): Promise<Reply<CancelResult>>;
  close(request: AssetRequest): Promise<Reply<null>>;
};
