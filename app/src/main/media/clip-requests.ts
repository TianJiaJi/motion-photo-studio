import { MAX_CLIPS, validateClip, type ClipModel } from '../../shared/editor.ts';
import type { ClipReference, ClipScope } from '../../shared/media-ipc.ts';
import { AppFailure } from '../errors.ts';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(): never { throw new AppFailure('INVALID_REQUEST', '片段身份、版本或设置无效。'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>, prototype = Object.getPrototypeOf(v);
  if (prototype !== Object.prototype && prototype !== null || Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) fail();
  return v;
}
export function clipReference(value: ClipScope): ClipReference | undefined {
  if (!Object.hasOwn(value, 'clipId') && !Object.hasOwn(value, 'revision')) return undefined;
  if (typeof value.clipId !== 'string' || !uuid.test(value.clipId) || !Number.isSafeInteger(value.revision) || value.revision! < 0) fail();
  return { clipId: value.clipId, revision: value.revision! };
}
export function parseClipModels(value: unknown, durationUs = Number.MAX_SAFE_INTEGER): ClipModel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CLIPS) fail();
  const models = value.map(item => {
    const c = object(item, ['id', 'number', 'revision', 'selection', 'crop', 'cropLocked', 'coverFit', 'background']);
    clipReference({ clipId: c.id as string, revision: c.revision as number });
    if (!Number.isSafeInteger(c.number) || Number(c.number) < 1 || typeof c.cropLocked !== 'boolean'
      || c.coverFit !== 'cover' && c.coverFit !== 'contain' || typeof c.background !== 'string' || !/^#[a-f0-9]{6}$/i.test(c.background)) fail();
    const selection = object(c.selection, ['startUs', 'endUs']);
    const crop = object(c.crop, ['x', 'y', 'width', 'height']);
    if (![crop.x, crop.y, crop.width, crop.height].every(v => typeof v === 'number' && Number.isFinite(v))) fail();
    const rect = crop as ClipModel['crop'];
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 + 1e-9 || rect.y + rect.height > 1 + 1e-9) fail();
    try {
      return { id: c.id as string, number: Number(c.number), revision: Number(c.revision),
        selection: validateClip(selection as ClipModel['selection'], durationUs), crop: { ...rect },
        cropLocked: c.cropLocked, coverFit: c.coverFit, background: c.background } as ClipModel;
    } catch { fail(); }
  });
  if (new Set(models.map(c => c.id)).size !== models.length || models.some((c, i) => i > 0 && c.number <= models[i - 1]!.number)) fail();
  return models;
}
