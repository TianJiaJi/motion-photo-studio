import type { Reply } from './contracts.ts';
import type { ExportOptions, ExportInspection, DraftOptions, ExportDraft, ExportProgress, SavedMotion, CancelResult } from './export.ts';
import type { VideoAsset, VideoPreview, NativeFrame, Thumbnail, CoverAsset } from './media.ts';

export const MEDIA_CHANNELS = Object.freeze({
  open: 'motion:media:open', cancelImport: 'motion:media:cancel-import', preview: 'motion:media:preview', frame: 'motion:media:frame',
  thumbnails: 'motion:media:thumbnails', uploadCover: 'motion:media:upload-cover',
  captureCover: 'motion:media:capture-cover', cancel: 'motion:media:cancel', close: 'motion:media:close',
  analyze: 'motion:media:analyze', renderDraft: 'motion:media:render-draft', saveDraft: 'motion:media:save-draft', progress: 'motion:media:export-progress',
});
export type AssetRequest = { assetId: string };
export type TimeRequest = AssetRequest & { timeUs: number; hdrConsent: boolean };
export type MediaRequests = {
  preview: TimeRequest & { forceProxy: boolean };
  frame: TimeRequest & { step?: { cursor: string; direction: -1 | 1 } };
  thumbnails: AssetRequest & { startUs: number; endUs: number; count: number; hdrConsent: boolean };
  uploadCover: AssetRequest; captureCover: TimeRequest; cancel: AssetRequest & { saveId?: string }; close: AssetRequest;
  analyze: AssetRequest & { options: ExportOptions };
  renderDraft: AssetRequest & { analysisId: string; image: DraftOptions };
  saveDraft: AssetRequest & { draftId: string; saveId: string };
};
export type MediaAPI = {
  open(): Promise<Reply<VideoAsset | null>>;
  cancelImport(): Promise<Reply<null>>;
  preview(request: MediaRequests['preview']): Promise<Reply<VideoPreview>>;
  frame(request: MediaRequests['frame']): Promise<Reply<NativeFrame>>;
  thumbnails(request: MediaRequests['thumbnails']): Promise<Reply<Thumbnail[]>>;
  uploadCover(request: AssetRequest): Promise<Reply<CoverAsset | null>>;
  captureCover(request: TimeRequest): Promise<Reply<CoverAsset>>;
  analyze(request: MediaRequests['analyze']): Promise<Reply<ExportInspection>>;
  renderDraft(request: MediaRequests['renderDraft']): Promise<Reply<ExportDraft>>;
  onExportProgress(listener: (progress: ExportProgress) => void): () => void;
  saveDraft(request: MediaRequests['saveDraft']): Promise<Reply<SavedMotion | null>>;
  cancel(request: MediaRequests['cancel']): Promise<Reply<CancelResult>>;
  close(request: AssetRequest): Promise<Reply<null>>;
};
