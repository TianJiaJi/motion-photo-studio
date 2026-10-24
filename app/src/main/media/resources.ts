import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileFingerprint as fingerprint } from './source.ts';
import { parseRange } from './range.ts';
import { AppFailure } from '../errors.ts';

export type MediaMime = 'video/mp4' | 'video/webm' | 'image/jpeg' | 'image/png';
export type ResourceRef = { id: string; url: string };
type Resource = { path: string; mime: MediaMime; stamp: string; size: number; streams: Map<ReadStream, Promise<void>> };

// Renderer receives unguessable resource tokens, never arbitrary local paths or file:// access.
export class MediaResources {
  private readonly entries = new Map<string, Resource>();
  private readonly retired = new Map<string, Resource>();
  private readonly draining = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly timeoutMs: number;
  constructor(timeoutMs = 5000) { this.timeoutMs = timeoutMs; }
  async register(path: string, mime: MediaMime): Promise<ResourceRef> {
    const canonical = await realpath(path);
    const info = await fingerprint(canonical);
    if (this.disposed) throw new AppFailure('CANCELLED', '媒体资源服务正在关闭。');
    const id = randomUUID();
    this.entries.set(id, { path: canonical, mime, ...info, streams: new Map() });
    return { id, url: `media://asset/${id}` };
  }
  revoke(id: string): Promise<void> {
    const active = this.draining.get(id); if (active) return active;
    const resource = this.entries.get(id) ?? this.retired.get(id);
    if (!resource) return Promise.resolve();
    // Fence new GETs synchronously, including requests awaiting their fingerprint check.
    this.entries.delete(id); this.retired.set(id, resource);
    const closed = [...resource.streams.values()];
    for (const stream of resource.streams.keys()) stream.destroy(new Error('Media resource revoked'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = Promise.race([
      Promise.all(closed),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppFailure('TEMP_CLEANUP', '媒体读流未确认关闭，缓存已保留；请稍后重试。')), this.timeoutMs); }),
    ]).then(() => { this.retired.delete(id); }).finally(() => { clearTimeout(timer); this.draining.delete(id); });
    this.draining.set(id, result); return result;
  }
  async revokeAll(ids: Iterable<string>): Promise<void> {
    const results = await Promise.allSettled([...ids].map(id => this.revoke(id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.revokeAll(new Set([...this.entries.keys(), ...this.retired.keys()]));
  }
  async respond(request: Request, allowedOrigin: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== 'media:' || url.hostname !== 'asset' || url.username || url.password || url.port || url.search
      || !/^\/[a-f0-9-]{36}$/.test(url.pathname)) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const origin = request.headers.get('Origin');
    if (origin && origin !== allowedOrigin) return new Response(null, { status: 403 });
    const resource = this.entries.get(url.pathname.slice(1));
    if (!resource) return new Response(null, { status: 404 });
    try {
      if ((await fingerprint(resource.path)).stamp !== resource.stamp) return new Response(null, { status: 409 });
    } catch { return new Response(null, { status: 410 }); }
    if (this.entries.get(url.pathname.slice(1)) !== resource) return new Response(null, { status: 404 });
    if (request.signal.aborted) return new Response(null, { status: 408 });
    const headers = new Headers({
      'Content-Type': resource.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': allowedOrigin,
      'Content-Security-Policy': "default-src 'none'",
    });
    let range;
    try { range = parseRange(request.headers.get('Range'), resource.size); }
    catch { headers.set('Content-Range', `bytes */${resource.size}`); return new Response(null, { status: 416, headers }); }
    headers.set('Content-Length', String(Math.max(0, range.end - range.start + 1)));
    if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${resource.size}`);
    const status = range.partial ? 206 : 200;
    if (request.method === 'HEAD' || resource.size === 0) return new Response(null, { status, headers });
    const stream = createReadStream(resource.path, { start: range.start, end: range.end, highWaterMark: 64 * 1024 });
    const cancel = () => stream.destroy(new Error('Media request cancelled'));
    request.signal.addEventListener('abort', cancel, { once: true });
    resource.streams.set(stream, new Promise<void>(resolve => {
      stream.once('close', () => { request.signal.removeEventListener('abort', cancel); resource.streams.delete(stream); resolve(); });
    }));
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => (chunk as Uint8Array).byteLength } }) as ReadableStream<Uint8Array>;
    if (request.signal.aborted) cancel();
    return new Response(body, { status, headers });
  }
}
