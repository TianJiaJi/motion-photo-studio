import { resolve, relative, isAbsolute } from 'node:path';
import { AppFailure } from './errors.ts';

export const APP_URL = 'app://ui/index.html';
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: media:; media-src media:; font-src 'self'; connect-src media:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export function isTrustedRenderer(url: string, devUrl?: string): boolean {
  try {
    const incoming = new URL(url);
    if (devUrl) {
      const expected = new URL(devUrl);
      return ['http:', 'https:'].includes(expected.protocol)
        && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)
        && incoming.origin === expected.origin && incoming.pathname === expected.pathname
        && incoming.search === expected.search;
    }
    return incoming.protocol === 'app:' && incoming.hostname === 'ui'
      && incoming.pathname === '/index.html' && !incoming.search && !incoming.username && !incoming.password && !incoming.port;
  } catch { return false; }
}

export function resolveAppResource(root: string, url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'app:' || parsed.hostname !== 'ui' || parsed.username || parsed.password || parsed.port) throw new Error('Unknown resource origin');
  const path = decodeURIComponent(parsed.pathname);
  if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw new Error('Invalid resource path');
  const candidate = resolve(root, `.${path}`);
  const rel = relative(resolve(root), candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Resource path escapes renderer root');
  return candidate;
}

export function assertNoArgs(args: unknown[]): void {
  if (args.length) throw new AppFailure('INVALID_REQUEST', '此操作不接受额外参数。');
}
export function parseJobId(args: unknown[]): string {
  if (args.length !== 1 || typeof args[0] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[0])) {
    throw new AppFailure('INVALID_REQUEST', '无效的任务编号。');
  }
  return args[0];
}
