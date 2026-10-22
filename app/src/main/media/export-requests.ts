import { validateExportSettings, type CropRect, type ExportSettings } from '../../shared/editor.ts';
import type { DraftOptions, ExportOptions } from '../../shared/export.ts';
import { AppFailure } from '../errors.ts';
function fail(): never { throw new AppFailure('INVALID_REQUEST', '导出参数无效，请检查选段和设置。'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value); const data = value as Record<string, unknown>;
  if (prototype !== Object.prototype && prototype !== null || Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) fail();
  return data;
}
export function parseExportOptions(value: unknown): ExportOptions {
  try {
    const v = object(value, ['clip', 'processing', 'audio', 'hdrConsent']);
    const clip = object(v.clip, ['startUs', 'endUs']);
    if (!Number.isSafeInteger(clip.startUs) || !Number.isSafeInteger(clip.endUs) || Number(clip.startUs) < 0 || Number(clip.endUs) <= Number(clip.startUs) || typeof v.hdrConsent !== 'boolean') fail();
    if (!v.processing || typeof v.processing !== 'object') fail();
    const mode = (v.processing as Record<string, unknown>).mode;
    const p = object(v.processing, mode === 'copy' || mode === 'source' ? ['mode'] : ['mode', 'crop', 'settings']);
    let processing: ExportOptions['processing'];
    if (mode === 'copy' || mode === 'source') processing = { mode };
    else if (mode === 'encode') {
      const crop = object(p.crop, ['x', 'y', 'width', 'height']);
      if (![crop.x, crop.y, crop.width, crop.height].every(value => typeof value === 'number' && Number.isFinite(value))) fail();
      const c = crop as CropRect;
      if (c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.x + c.width > 1 + 1e-9 || c.y + c.height > 1 + 1e-9) fail();
      const s = object(p.settings, ['fps', 'resolution', 'crf']);
      processing = { mode, crop: { ...c }, settings: validateExportSettings(s as ExportSettings) };
    } else fail();
    if (!v.audio || typeof v.audio !== 'object') fail();
    const kind = (v.audio as Record<string, unknown>).kind;
    const a = object(v.audio, kind === 'omit' ? ['kind'] : ['kind', 'index', 'downmixStereo']);
    let audio: ExportOptions['audio'];
    if (kind === 'omit') audio = { kind: 'omit' };
    else if (kind === 'track' && Number.isSafeInteger(a.index) && Number(a.index) >= 0 && typeof a.downmixStereo === 'boolean')
      audio = { kind, index: Number(a.index), downmixStereo: a.downmixStereo };
    else fail();
    return { clip: { startUs: Number(clip.startUs), endUs: Number(clip.endUs) }, processing, audio, hdrConsent: v.hdrConsent };
  } catch { fail(); }
}
export function parseDraftOptions(value: unknown): DraftOptions {
  const v = object(value, ['fit', 'background']);
  if (v.fit !== 'cover' && v.fit !== 'contain' || typeof v.background !== 'string' || !/^#[a-f0-9]{6}$/i.test(v.background)) fail();
  return { fit: v.fit, background: v.background };
}
