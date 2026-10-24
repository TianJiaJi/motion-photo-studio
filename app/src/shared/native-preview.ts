import type { Rational } from './editor.ts';
import type { AppError } from './contracts.ts';
export const PREVIEW_ENGINE_VERSION = '0.1.0';
export const PREVIEW_PROTOCOL_VERSION = 1;
export const PREVIEW_RUST_VERSION = '1.99.1';
export type PreviewBoundary = 'after' | 'before';
export type PreviewControl = { assetId: string; epoch: number } & (
  | { action: 'seek'; timeUs: number; boundary: PreviewBoundary; maximumEdge: 640 | 960; final: boolean }
  | { action: 'step'; frameId: number; direction: -1 | 1 }
  | { action: 'play'; startUs: number; endUs: number; audioTrack: number | null }
  | { action: 'pause' }
);
export type PreviewStamp = {
  assetId: string; epoch: number; frameId: number; sourceFrame: number;
  pts: string; timeUs: number; timeBase: Rational; width: number; height: number;
};
export type PreviewPixels = PreviewStamp & { pixels: Uint8Array };
export type PreviewAck = { assetId: string; epoch: number; frameId: number; painted: boolean };
export type PreviewReady = {
  assetId: string; frameCount: number; compatibility: boolean; warnings: string[];
  sourceWidth: number; sourceHeight: number; previewWidth: number; previewHeight: number;
  hardwareDecodeVerified: boolean;
};
export type PreviewStatus = {
  assetId: string; epoch: number; state: 'preparing' | 'ready' | 'playing' | 'paused' | 'failed';
  stage?: 'source-index' | 'native-index' | 'compatibility' | 'audio'; frames?: number; bytes?: number;
  error?: AppError;
};
export const NATIVE_CHANNELS = Object.freeze({
  prepare: 'motion:native:prepare', control: 'motion:native:control', frame: 'motion:native:frame',
  ack: 'motion:native:ack', status: 'motion:native:status', capture: 'motion:native:capture',
});
