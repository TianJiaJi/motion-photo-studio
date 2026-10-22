import type { ClipSelection } from './editor.ts';
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
export type CancelResult = { saved: SavedMotion | null };
export type ExportProgress = { assetId: string; analysisId: string; stage: string; timeUs?: number; saveId?: string; writtenBytes?: number; totalBytes?: number };
