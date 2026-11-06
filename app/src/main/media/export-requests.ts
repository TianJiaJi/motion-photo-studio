import { validateExportSettings, type CropRect, type ExportSettings } from '../../shared/editor.ts';
import type { AudioSelection, BatchClipSnapshot, BatchSnapshot, DraftOptions, ExportOptions } from '../../shared/export.ts';
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

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function crop(value: unknown): CropRect {
  const c = object(value, ['x', 'y', 'width', 'height']);
  if (![c.x, c.y, c.width, c.height].every(item => typeof item === 'number' && Number.isFinite(item))) fail();
  const result = c as unknown as CropRect;
  if (result.x < 0 || result.y < 0 || result.width <= 0 || result.height <= 0 || result.x + result.width > 1 + 1e-9 || result.y + result.height > 1 + 1e-9) fail();
  return { ...result };
}
function audio(value: unknown): AudioSelection {
  if (!value || typeof value !== 'object') fail();
  const kind = (value as Record<string, unknown>).kind;
  const a = object(value, kind === 'omit' ? ['kind'] : ['kind', 'index', 'downmixStereo']);
  if (kind === 'omit') return { kind: 'omit' };
  if (kind === 'track' && Number.isSafeInteger(a.index) && Number(a.index) >= 0 && typeof a.downmixStereo === 'boolean')
    return { kind, index: Number(a.index), downmixStereo: a.downmixStereo };
  fail();
}
export function parseBatchSnapshot(value: unknown, assetId: string): BatchSnapshot {
  try {
    const v = object(value, ['assetId', 'batchId', 'clips', 'mode', 'settings', 'audio', 'hdrConsent']);
    if (v.assetId !== assetId || typeof v.batchId !== 'string' || !uuid.test(v.batchId)) fail();
    if (!Array.isArray(v.clips) || v.clips.length < 1 || v.clips.length > 100) fail();
    const clips: BatchClipSnapshot[] = v.clips.map(item => {
      const c = object(item, ['clipId', 'revision', 'selection', 'crop', 'cover', 'coverFit', 'background']);
      if (typeof c.clipId !== 'string' || !uuid.test(c.clipId) || !Number.isSafeInteger(c.revision) || Number(c.revision) < 0) fail();
      const selection = object(c.selection, ['startUs', 'endUs']);
      if (!Number.isSafeInteger(selection.startUs) || !Number.isSafeInteger(selection.endUs)
        || Number(selection.startUs) < 0 || Number(selection.endUs) <= Number(selection.startUs)) fail();
      if (!c.cover || typeof c.cover !== 'object' || Array.isArray(c.cover)) fail();
      const cover = object(c.cover, (c.cover as Record<string, unknown>).kind === 'auto' ? ['kind'] : ['kind', 'coverId']);
      let parsedCover: BatchClipSnapshot['cover'];
      if (cover.kind === 'auto') parsedCover = { kind: 'auto' };
      else {
        const withId = object(c.cover, ['kind', 'coverId']);
        if (withId.kind !== 'frame' && withId.kind !== 'custom' || typeof withId.coverId !== 'string' || !uuid.test(withId.coverId)) fail();
        parsedCover = { kind: withId.kind, coverId: withId.coverId };
      }
      if (c.coverFit !== 'cover' && c.coverFit !== 'contain' || typeof c.background !== 'string' || !/^#[a-f0-9]{6}$/i.test(c.background)) fail();
      return {
        clipId: c.clipId as string, revision: Number(c.revision),
        selection: { startUs: Number(selection.startUs), endUs: Number(selection.endUs) },
        crop: crop(c.crop), cover: parsedCover, coverFit: c.coverFit, background: c.background as string,
      };
    });
    if (new Set(clips.map(clip => clip.clipId)).size !== clips.length) fail();
    if (v.mode !== 'copy' && v.mode !== 'source' && v.mode !== 'encode' || typeof v.hdrConsent !== 'boolean') fail();
    return { assetId, batchId: v.batchId as string, clips, mode: v.mode, settings: validateExportSettings(object(v.settings, ['fps', 'resolution', 'crf']) as unknown as ExportSettings), audio: audio(v.audio), hdrConsent: v.hdrConsent };
  } catch { fail(); }
}
