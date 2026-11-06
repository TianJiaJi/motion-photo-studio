import type { ClipSelection, CropRect, ExportSettings } from './editor.ts';
import type { EffectiveProcessing } from './processing.ts';
export type AudioSelection = { kind: 'omit' } | { kind: 'track'; index: number; downmixStereo: boolean };
export function initialAudioTrack(tracks: readonly { index: number }[]): number | null {
  const index = tracks.length === 1 ? tracks[0]!.index : null;
  return index !== null && Number.isSafeInteger(index) && index >= 0 ? index : null;
}
export function audioSelection(keep: boolean, index: number | null, tracks: readonly { index: number }[], downmixStereo: boolean): AudioSelection | null {
  if (!keep) return { kind: 'omit' };
  if (index === null || !Number.isSafeInteger(index) || index < 0 || !tracks.some(track => track.index === index)) return null;
  return { kind: 'track', index, downmixStereo };
}
export type ExportOptions = { clip: ClipSelection; processing: EffectiveProcessing; audio: AudioSelection; hdrConsent: boolean };
// Frozen per-clip snapshot for one serial batch export. The main process re-validates every
// clipId/revision against its own per-clip resources before rendering; the renderer never
// supplies output paths (the save directory dialog and safe filenames belong to the main side).
export type BatchClipSnapshot = {
  clipId: string; revision: number; selection: ClipSelection; crop: CropRect;
  cover: { kind: 'auto' } | { kind: 'frame'; coverId: string } | { kind: 'custom'; coverId: string };
  coverFit: 'cover' | 'contain'; background: string;
};
export type BatchSnapshot = {
  assetId: string; batchId: string; clips: BatchClipSnapshot[];
  mode: 'copy' | 'source' | 'encode'; settings: ExportSettings;
  audio: AudioSelection; hdrConsent: boolean;
};
export type BatchClipResult = {
  clipId: string; name: string | null; index: number; number: number; total: number;
  status: 'saved' | 'failed' | 'cancelled' | 'skipped';
  saved: SavedMotion | null; error: { code: string; message: string } | null;
};
export type BatchResult = {
  batchId: string; canceled: boolean; stopped: boolean; stopReason: string | null;
  saved: SavedMotion[]; results: BatchClipResult[]; cleanupFailed?: boolean;
};
export type ExportInspection = {
  id: string; mode: 'encode' | 'copy' | 'source'; supported: boolean; requested: ClipSelection; actual: ClipSelection | null;
  width: number; height: number; reasons: string[]; warnings: string[];
};
export type DraftOptions = { fit: 'cover' | 'contain'; background: string };
export type ExportDraft = {
  id: string; assetId: string; analysisId: string; videoUrl: string; coverUrl: string; durationUs: number;
  width: number; height: number; coverTimestampUs: number; warnings: string[];
  proof: { kind: 'copy'; videoPackets: number; videoPayloadSha256: string; videoTimingSha256: string;
    audioPackets: number; audioTailUs: number } | { kind: 'encode'; sourceMatched?: boolean; audioCodec?: string; audioSampleRate?: number; audioChannels?: number };
};
export type SavedMotion = { name: string; size: number; profile: string; width: number; height: number; timestampUs: number; durationUs: number; warnings: string[] };
export type CancelResult = { saved: SavedMotion | null; batch?: BatchResult };
export type ExportProgress = { assetId: string; analysisId: string; stage: string; timeUs?: number; saveId?: string; writtenBytes?: number; totalBytes?: number;
  batch?: { batchId: string; clipId: string; index: number; total: number; clipName?: string } };
