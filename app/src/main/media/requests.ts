import type { MediaRequests } from '../../shared/media-ipc.ts';
import { AppFailure } from '../errors.ts';
import { parseExportOptions, parseDraftOptions } from './export-requests.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const keys: Record<keyof MediaRequests, readonly string[]> = {
  thumbnails: ['assetId', 'startUs', 'endUs', 'count', 'hdrConsent'], uploadCover: ['assetId'],
  cancel: ['assetId', 'saveId'], close: ['assetId'],
  analyze: ['assetId', 'options'], renderDraft: ['assetId', 'analysisId', 'image'], saveDraft: ['assetId', 'draftId', 'saveId'],
};
function fail(): never { throw new AppFailure('INVALID_REQUEST', '媒体请求参数不合法。'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as Record<string, unknown>;
}
export function parseMediaRequest<K extends keyof MediaRequests>(kind: K, args: unknown[]): MediaRequests[K] {
  if (args.length !== 1 || !Object.hasOwn(keys, kind)) fail();
  const value = object(args[0]);
  const optional = kind === 'cancel' ? ['saveId'] : [];
  if (Object.keys(value).some(key => !keys[kind].includes(key))
    || keys[kind].some(key => !optional.includes(key) && !Object.hasOwn(value, key))
    || typeof value.assetId !== 'string' || !uuid.test(value.assetId)) fail();
  for (const key of ['startUs', 'endUs']) {
    if (keys[kind].includes(key) && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) fail();
  }
  if (keys[kind].includes('hdrConsent') && typeof value.hdrConsent !== 'boolean') fail();
  if (kind === 'thumbnails' && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 12
    || (value.endUs as number) <= (value.startUs as number))) fail();
  if (Object.hasOwn(value, 'saveId') && (typeof value.saveId !== 'string' || !uuid.test(value.saveId))) fail();
  if (kind === 'saveDraft' && (typeof value.draftId !== 'string' || !uuid.test(value.draftId))) fail();
  if (kind === 'analyze') return { ...value, options: parseExportOptions(value.options) } as MediaRequests[K];
  if (kind === 'renderDraft') {
    if (typeof value.analysisId !== 'string' || !uuid.test(value.analysisId)) fail();
    return { ...value, image: parseDraftOptions(value.image) } as MediaRequests[K];
  }
  return value as MediaRequests[K];
}
