export type Rational = { numerator: number; denominator: number };
export type CropRect = { x: number; y: number; width: number; height: number };
export type PixelCrop = CropRect;
export type ExportSettings = { fps: number | null; resolution: 'original' | 720 | 1080 | 1440 | 2160; crf: number };
export type ClipSelection = { startUs: number; endUs: number };
// One exportable segment of a single source video. Identity (id/revision) is stable across
// edits; revision bumps whenever the selection/cover/crop changes so stale analyses and
// drafts can never publish. Covers live in the main process and are referenced by clipId.
export type ClipModel = {
  id: string; number: number; revision: number; selection: ClipSelection;
  crop: CropRect; cropLocked: boolean; coverFit: 'cover' | 'contain'; background: string;
};
export const FULL_CROP: CropRect = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
export const MAX_CLIPS = 100;
export function createClip(id: string, selection: ClipSelection, durationUs: number, number = 1): ClipModel {
  return { id, number, revision: 0, selection: validateClip(selection, durationUs), crop: { ...FULL_CROP }, cropLocked: true, coverFit: 'cover', background: '#000000' };
}
export function editClip(clip: ClipModel, change: Partial<Pick<ClipModel, 'selection' | 'crop' | 'cropLocked' | 'coverFit' | 'background'>>): ClipModel {
  return { ...clip, ...change, revision: clip.revision + 1 };
}
// Adding a clip at the playhead: three seconds, shortened near EOF; at EOF use the last up-to-3s window.
// Clips may overlap freely.
export function clipSelectionAt(positionUs: number, durationUs: number): ClipSelection {
  if (!Number.isSafeInteger(positionUs) || positionUs < 0 || positionUs > durationUs || durationUs <= 0) throw new Error('Invalid clip position');
  const startUs = positionUs === durationUs ? Math.max(0, durationUs - 3_000_000) : positionUs;
  const endUs = Math.min(durationUs, startUs + 3_000_000);
  return validateClip({ startUs, endUs }, durationUs);
}

/** Positive seconds with millisecond precision; reject rather than round invalid input. */
export function parseClipDurationSeconds(value: string): number | null {
  const text = value.trim();
  if (text.length > 32 || !/^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const us = BigInt(whole || '0') * 1_000_000n + BigInt(fraction.padEnd(3, '0')) * 1_000n;
  return us > 0n && us <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(us) : null;
}

/** Resize from the existing in-point; never shift it to compensate for EOF. */
export function clipSelectionWithDuration(selection: ClipSelection, durationUs: number, lengthUs: number): ClipSelection {
  validateClip(selection, durationUs);
  if (!Number.isSafeInteger(lengthUs) || lengthUs <= 0) throw new Error('Invalid clip length');
  return { startUs: selection.startUs, endUs: selection.startUs + Math.min(lengthUs, durationUs - selection.startUs) };
}

export function parseRational(value: string | undefined): Rational | null {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const numerator = Number(match[1]); const denominator = Number(match[2]);
  return Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0
    ? { numerator, denominator } : null;
}

export function secondsToUs(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid decimal timestamp');
  const fraction = (match[3] ?? '').padEnd(6, '0').slice(0, 6);
  const magnitude = BigInt(match[2]!) * 1000000n + BigInt(fraction || '0');
  const result = Number(match[1] ? -magnitude : magnitude);
  if (!Number.isSafeInteger(result)) throw new Error('Timestamp exceeds safe precision');
  return result;
}

export function usToSeconds(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid integer microseconds');
  const absolute = Math.abs(value);
  return `${value < 0 ? '-' : ''}${Math.floor(absolute / 1000000)}.${String(absolute % 1000000).padStart(6, '0')}`;
}

export function formatTime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid timeline time');
  const milliseconds = Math.floor(value / 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function parseTime(value: string): number {
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value.trim());
  if (!match) throw new Error('时间格式应为 时:分:秒.毫秒');
  const result = (Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4])) * 1000;
  if (!Number.isSafeInteger(result)) throw new Error('时间数值超出精度范围');
  return result;
}

export function ptsToUs(pts: string, startPts: string, timeBase: Rational): number {
  if (!/^-?\d+$/.test(pts) || !/^-?\d+$/.test(startPts)) throw new Error('Invalid frame PTS');
  const ticks = BigInt(pts) - BigInt(startPts);
  const value = Number(ticks * BigInt(timeBase.numerator) * 1000000n / BigInt(timeBase.denominator));
  if (!Number.isSafeInteger(value)) throw new Error('Frame time exceeds safe precision');
  return value;
}

export function validateClip(clip: ClipSelection, durationUs: number): ClipSelection {
  if (![durationUs, clip.startUs, clip.endUs].every(Number.isSafeInteger)
    || durationUs <= 0 || clip.startUs < 0 || clip.endUs <= clip.startUs || clip.endUs > durationUs) throw new Error('截取区间必须位于视频内，结束时间须大于开始时间');
  return { ...clip };
}

export function cropToPixels(crop: CropRect, width: number, height: number): PixelCrop {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new Error('Invalid image dimensions');
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) throw new Error('Invalid normalized crop');
  const even = (n: number) => Math.floor(n / 2) * 2;
  const x = Math.min(even(crop.x * width), even(width - 2));
  const y = Math.min(even(crop.y * height), even(height - 2));
  return { x, y, width: Math.max(2, Math.min(even(width - x), even(crop.width * width))),
    height: Math.max(2, Math.min(even(height - y), even(crop.height * height))) };
}

/** Largest centered crop in display coordinates, preserving the requested aspect ratio. */
export function centeredAspectCrop(width: number, height: number, aspect: number): CropRect {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 2)
    || !Number.isFinite(aspect) || aspect <= 0) throw new Error('Invalid crop aspect or display dimensions');
  const sourceAspect = width / height;
  const w = Math.min(1, aspect / sourceAspect), h = Math.min(1, sourceAspect / aspect);
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
}

export function validateExportSettings(value: ExportSettings): ExportSettings {
  if (value.fps !== null && (!Number.isFinite(value.fps) || value.fps <= 0 || value.fps > 240)) throw new Error('帧率须在 0–240 之间或保留原帧率');
  if (!['original', 720, 1080, 1440, 2160].includes(value.resolution)) throw new Error('无效的分辨率设置');
  if (!Number.isInteger(value.crf) || value.crf < 0 || value.crf > 51) throw new Error('CRF 须为 0–51 的整数');
  return { ...value };
}
