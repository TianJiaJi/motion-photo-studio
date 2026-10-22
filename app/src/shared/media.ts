import type { Rational } from './editor.ts';

export type MediaInfo = {
  videoIndex: number; encodedWidth: number; encodedHeight: number; displayWidth: number; displayHeight: number;
  rotation: 0 | 90 | 180 | 270; durationUs: number; startPts: string; startUs: number;
  timeBase: Rational; frameRate: Rational | null; sampleAspectRatio: Rational;
  audioTracks: { index: number; codec: string; channels: number | null }[];
  codec: string; hasAudio: boolean; hdr: boolean; originalPreviewMime: 'video/mp4' | 'video/webm' | null;
};
export type VideoAsset = { id: string; name: string; size: number; info: MediaInfo };
export type VideoPreview = { assetId: string; url: string; kind: 'original' | 'proxy'; startUs: number; endUs: number; mediaStartUs: number };
export type NativeFrame = { id: string; assetId: string; url: string; actualTimeUs: number; pts: string; timeBase: Rational };
export type Thumbnail = { timeUs: number; url: string };
export type CoverAsset = { id: string; name: string; url: string; width: number; height: number; kind: 'custom' | 'frame'; timeUs: number | null };
