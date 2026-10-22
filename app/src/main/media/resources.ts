import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileFingerprint as fingerprint } from './source.ts';
import { parseRange } from './range.ts';

export type MediaMime = 'video/mp4' | 'video/webm' | 'image/jpeg' | 'image/png';
export type ResourceRef = { id: string; url: string };
type Resource = { path: string; mime: MediaMime; stamp: string; size: number; streams: Set<ReadStream> };

// Renderer receives unguessable resource tokens, never arbitrary local paths or file:// access.
export class MediaResources {
  private readonly entries = new Map<string, Resource>();
  async register(path: string, mime: MediaMime): Promise<ResourceRef> {
    const canonical = await realpath(path);
    const info = await fingerprint(canonical);
    const id = randomUUID();
    this.entries.set(id, { path: canonical, mime, ...info, streams: new Set() });
    return { id, url: `media://asset/${id}` };
  }
  revoke(id: string): void {
    const resource = this.entries.get(id);
    if (!resource) return;
    for (const stream of resource.streams) stream.destroy(new Error('Media resource revoked'));
    this.entries.delete(id);
  }
  dispose(): void { for (const id of this.entries.keys()) this.revoke(id); }
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
    resource.streams.add(stream);
    const cancel = () => stream.destroy(new Error('Media request cancelled'));
    request.signal.addEventListener('abort', cancel, { once: true });
    stream.once('close', () => { request.signal.removeEventListener('abort', cancel); resource.streams.delete(stream); });
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    if (request.signal.aborted) cancel();
    return new Response(body, { status, headers });
  }
}
