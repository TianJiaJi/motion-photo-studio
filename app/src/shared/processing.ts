import { cropToPixels, validateExportSettings, type CropRect, type ExportSettings, type PixelCrop } from './editor.ts';
import type { MediaInfo } from './media.ts';

export type ProcessingEdits = { crop: Readonly<CropRect>; settings: Readonly<ExportSettings> };
export type ProcessingState = Readonly<{ mode: 'encode' | 'copy'; saved: Readonly<ProcessingEdits> }>;
export type EffectiveProcessing = Readonly<{ mode: 'copy' }> | Readonly<{ mode: 'source' }> | Readonly<{ mode: 'encode' } & ProcessingEdits>;
export const SOURCE_MATCH_EDITS: Readonly<ProcessingEdits> = Object.freeze({
  crop: Object.freeze({ x: 0, y: 0, width: 1, height: 1 }),
  settings: Object.freeze({ fps: null, resolution: 'original', crf: 16 }),
});
const FULL_FRAME: Readonly<CropRect> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
function savedEdits(edits: ProcessingEdits): Readonly<ProcessingEdits> {
  const crop = edits.crop;
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) throw new Error('Invalid normalized crop');
  return Object.freeze({ crop: Object.freeze({ ...crop }), settings: Object.freeze(validateExportSettings(edits.settings)) });
}
export function createProcessingState(edits: ProcessingEdits = {
  crop: FULL_FRAME, settings: { fps: 30, resolution: 1080, crf: 23 },
}): ProcessingState {
  return Object.freeze({ mode: 'encode', saved: savedEdits(edits) });
}
export function setProcessingMode(state: ProcessingState, mode: ProcessingState['mode']): ProcessingState {
  if (mode !== 'encode' && mode !== 'copy') throw new Error('Invalid processing mode');
  return mode === state.mode ? state : Object.freeze({ mode, saved: state.saved });
}
export function updateProcessingEdits(state: ProcessingState, edits: Partial<ProcessingEdits>): ProcessingState {
  // Ignore stale pointer/change events delivered after the controls have been suspended.
  if (state.mode === 'copy') return state;
  return Object.freeze({ mode: 'encode', saved: savedEdits({ ...state.saved, ...edits }) });
}
export function effectiveProcessing(state: ProcessingState): EffectiveProcessing {
  // No suspended filter/quality parameters exist on a copy request, rather than merely setting CRF to zero.
  return state.mode === 'copy' ? Object.freeze({ mode: 'copy' }) : Object.freeze({ mode: 'encode', ...state.saved });
}
export function previewCrop(state: ProcessingState): Readonly<CropRect> {
  return state.mode === 'copy' ? FULL_FRAME : state.saved.crop;
}
export type OutputGeometry = {
  width: number; height: number; displayWidth: number; displayHeight: number;
  crop: PixelCrop | null; warnings: string[];
};
export function processingGeometry(processing: EffectiveProcessing,
  source: Pick<MediaInfo, 'encodedWidth' | 'encodedHeight' | 'displayWidth' | 'displayHeight'>): OutputGeometry {
  if (![source.encodedWidth, source.encodedHeight, source.displayWidth, source.displayHeight]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid source dimensions');
  if (processing.mode === 'copy') return { width: source.encodedWidth, height: source.encodedHeight,
    displayWidth: source.displayWidth, displayHeight: source.displayHeight, crop: null, warnings: [] };
  const edits = processing.mode === 'source' ? SOURCE_MATCH_EDITS : processing;
  const settings = validateExportSettings(edits.settings);
  const crop = cropToPixels(edits.crop, source.displayWidth, source.displayHeight);
  const ratio = settings.resolution === 'original' ? 1 : Math.min(1, settings.resolution / Math.max(crop.width, crop.height));
  const even = (value: number) => Math.round(value / 2) * 2;
  const width = even(crop.width * ratio); const height = even(crop.height * ratio);
  if (width < 2 || height < 2) throw new Error('该长宽比无法在所选分辨率下形成有效的偶数尺寸，请调整裁剪或使用原尺寸。');
  const warnings = Math.abs(width * crop.height / (height * crop.width) - 1) > 0.01
    ? ['偶数像素对齐会明显改变该极端长宽比，请检查预览或使用原尺寸。'] : [];
  return { width, height, displayWidth: width, displayHeight: height, crop, warnings };
}
