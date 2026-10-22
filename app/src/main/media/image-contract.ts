export type JpegCoverRequest = { input: string; output: string; width: number; height: number;
  fit: 'cover' | 'contain'; background: string };
export type JpegCoverReport = { width: number; height: number; inputWidth: number; inputHeight: number;
  colorSpace: 'srgb'; iccConverted: boolean; alphaFlattened: boolean; upscaled: boolean; warnings: string[];
  engine: { sharp: string; vips: string; lcms: string } };
export function parseJpegCoverRequest(value: unknown): JpegCoverRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid image request');
  const v = value as Record<string, unknown>; const keys = ['input', 'output', 'width', 'height', 'fit', 'background'];
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))
    || typeof v.input !== 'string' || typeof v.output !== 'string' || !v.input || !v.output
    || !Number.isSafeInteger(v.width) || !Number.isSafeInteger(v.height) || Number(v.width) <= 0 || Number(v.height) <= 0
    || !Number.isSafeInteger(Number(v.width) * Number(v.height)) || !['cover', 'contain'].includes(String(v.fit))
    || typeof v.background !== 'string' || !/^#[\da-f]{6}$/i.test(v.background)) throw new Error('Invalid image request');
  return v as JpegCoverRequest;
}
