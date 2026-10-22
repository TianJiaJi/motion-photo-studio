export type Rational = { numerator: number; denominator: number };
export type CropRect = { x: number; y: number; width: number; height: number };
export type PixelCrop = CropRect;
export type ExportSettings = { fps: number | null; resolution: 'original' | 720 | 1080 | 1440 | 2160; crf: number };
export type ClipSelection = { startUs: number; endUs: number };

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

export function validateExportSettings(value: ExportSettings): ExportSettings {
  if (value.fps !== null && (!Number.isFinite(value.fps) || value.fps <= 0 || value.fps > 240)) throw new Error('帧率须在 0–240 之间或保留原帧率');
  if (!['original', 720, 1080, 1440, 2160].includes(value.resolution)) throw new Error('无效的分辨率设置');
  if (!Number.isInteger(value.crf) || value.crf < 0 || value.crf > 51) throw new Error('CRF 须为 0–51 的整数');
  return { ...value };
}
