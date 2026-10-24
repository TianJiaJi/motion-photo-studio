import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { AppFailure } from '../errors.ts';
import { PREVIEW_ENGINE_VERSION } from '../../shared/native-preview.ts';

export type NativeVideoInfo = {
  width: number; height: number; sourceWidth: number; sourceHeight: number;
  d3dEnabled: boolean; hardwareDecodeVerified: boolean; fallbackReason: string | null;
  hasAudio: boolean; matrix709: boolean; fullRange: boolean;
};
export type NativeSampleTime = { timestampHns: string; durationHns: string };
export type NativeFrameInfo = NativeSampleTime & { frameId: number; width: number; height: number; format: 'rgba8' };
export type NativeResult<T> = { value: T; pixels: Buffer; generation: number };
const HEADER_LIMIT = 16384;
const PIXEL_LIMIT = 1280 * 1280 * 4;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function nativeInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value)) throw new AppFailure('NATIVE_PROTOCOL', '原生时间戳无效。');
  const result = BigInt(value);
  if (result < -(1n << 63n) || result >= 1n << 63n) throw new AppFailure('NATIVE_PROTOCOL', '原生时间戳超出范围。');
  return result;
}

// Internal main-process transport. Only the host supplies a reviewed helper path and source paths.
// AbortSignal cancels a whole import/session, never an individual pointermove.
export class NativePreview {
  private readonly child: ChildProcessWithoutNullStreams;
  private carry = Buffer.alloc(0);
  private next = 0;
  private generation = 0;
  private failure?: Error;
  private stderr = '';
  private pending = new Map<number, {
    generation: number; resolve(value: NativeResult<unknown>): void; reject(error: Error): void;
    timer: NodeJS.Timeout; signal?: AbortSignal; abort(): void;
  }>();
  readonly terminated: Promise<number | null>;
  constructor(executable: string) {
    if (!isAbsolute(executable)) throw new Error('Native helper requires an absolute verified path');
    this.child = spawn(executable, [], { cwd: dirname(executable), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.terminated = new Promise(resolve => this.child.once('close', code => {
      this.fail(new AppFailure('NATIVE_EXIT', '原生预览进程已退出。', { cause: new Error(`Exit ${code}: ${this.stderr}`) }));
      resolve(code);
    }));
    this.child.once('error', error => this.fail(new AppFailure('NATIVE_EXIT', '原生预览进程无法启动，请检查预览引擎或重新导入素材。', { cause: error })));
    const disconnected = (error: Error) => {
      this.fail(new AppFailure('NATIVE_EXIT', '原生预览进程通信已中断，请重新导入素材。', { cause: error }));
      this.child.kill();
    };
    this.child.stdin.on('error', disconnected);
    this.child.stdout.on('error', disconnected);
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16384); });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.consume(chunk); }
      catch (error) { this.fail(error instanceof AppFailure ? error : new AppFailure('NATIVE_PROTOCOL', '原生预览返回了无效数据，已停止该进程。', { cause: error })); this.child.kill(); }
    });
  }
  get pid(): number | undefined { return this.child.pid; }
  get epoch(): number { return this.generation; }
  advanceEpoch(): number {
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new Error('Native epoch exhausted');
    return ++this.generation;
  }
  get busy(): boolean { return this.pending.size > 0; }
  get alive(): boolean { return !this.failure && this.child.exitCode === null && this.child.signalCode === null; }
  private fail(error: Error) {
    this.failure ??= error;
    for (const [id, pending] of this.pending) { this.clear(id); pending.reject(this.failure); }
    this.carry = Buffer.alloc(0);
  }
  private clear(id: number) {
    const pending = this.pending.get(id);
    if (pending) { clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort); this.pending.delete(id); }
  }
  private consume(chunk: Buffer) {
    if (this.carry.length + chunk.length > HEADER_LIMIT + PIXEL_LIMIT + 65536) throw new Error('Native receive budget exceeded');
    this.carry = Buffer.concat([this.carry, chunk]);
    while (this.carry.length >= 4) {
      const length = this.carry.readUInt32LE();
      if (length < 1 || length > HEADER_LIMIT) throw new Error('Invalid native header length');
      if (this.carry.length < length + 4) return;
      const header = JSON.parse(this.carry.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
      if (!header || header.version !== 1 || !integer(header.id) || !integer(header.generation)
        || !integer(header.bodyBytes) || header.bodyBytes > PIXEL_LIMIT
        || Object.keys(header).some(key => !['version', 'id', 'generation', 'bodyBytes', 'result', 'error'].includes(key))) throw new Error('Invalid native envelope');
      const pending = this.pending.get(header.id);
      if (!pending || pending.generation !== header.generation) throw new Error('Stale or unsolicited native response');
      const total = 4 + length + header.bodyBytes;
      if (this.carry.length < total) return;
      const pixels = Buffer.from(this.carry.subarray(4 + length, total));
      this.carry = this.carry.subarray(total);
      if (header.bodyBytes) {
        const frame = header.result as NativeFrameInfo;
        if (!frame || !integer(frame.frameId) || !integer(frame.width) || !integer(frame.height)
          || frame.width < 1 || frame.height < 1 || frame.width > 1280 || frame.height > 1280
          || frame.format !== 'rgba8' || frame.width * frame.height * 4 !== header.bodyBytes) throw new Error('Invalid native frame layout');
        nativeInteger(frame.timestampHns); nativeInteger(frame.durationHns);
      }
      if (header.error !== undefined && (typeof header.error !== 'string' || header.error.length > 4096 || pixels.length)) throw new Error('Invalid native error');
      this.clear(header.id);
      if (header.error !== undefined) {
        const kind = header.error === 'cancelled' ? 'CANCELLED' : header.error === 'busy' ? 'NATIVE_BUSY' : 'NATIVE_MEDIA';
        pending.reject(new AppFailure(kind, kind === 'CANCELLED' ? '原生请求已被新交互替代。' : '原生预览无法处理此请求。', { cause: new Error(header.error as string) }));
      } else pending.resolve({ value: header.result, pixels, generation: header.generation });
    }
  }
  request<T>(command: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<NativeResult<T>> {
    options.signal?.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 4) return Promise.reject(new AppFailure('NATIVE_BUSY', '原生预览请求队列已满。'));
    const id = ++this.next;
    const data = Buffer.from(JSON.stringify({ ...command, version: 1, id, generation: this.generation }));
    if (data.length > HEADER_LIMIT) return Promise.reject(new Error('Native request too large'));
    const length = Buffer.alloc(4); length.writeUInt32LE(data.length);
    return new Promise((resolve, reject) => {
      const abort = () => { this.fail(new AppFailure('CANCELLED', '原生媒体会话已取消。')); this.child.kill(); };
      const timer = setTimeout(() => { this.fail(new AppFailure('NATIVE_TIMEOUT', '原生预览超时，已停止该进程。')); this.child.kill(); }, options.timeoutMs ?? 30000);
      this.pending.set(id, { generation: this.generation, resolve: result => resolve(result as NativeResult<T>), reject, timer, signal: options.signal, abort });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      this.child.stdin.write(Buffer.concat([length, data]));
    });
  }
  async hello(signal?: AbortSignal) {
    const { value } = await this.request<{ engine: string; engineVersion: string; platform: string; mediaFoundation: boolean }>({ command: 'hello' }, { signal, timeoutMs: 5000 });
    if (value?.engine !== 'motion-preview' || value.engineVersion !== PREVIEW_ENGINE_VERSION || value.platform !== 'windows-x64') throw new AppFailure('NATIVE_ENGINE_VERSION', '原生预览引擎版本或平台不匹配，请重新安装。');
    if (value.mediaFoundation !== true) throw new AppFailure('NATIVE_PLATFORM', '系统 Media Foundation 不可用；Windows N 需要 Media Feature Pack。');
    return value;
  }
  async open(path: string, maximumEdge = 960, signal?: AbortSignal, color?: { matrix709: boolean; fullRange: boolean }): Promise<NativeVideoInfo> {
    if (this.pending.size) throw new Error('Cannot replace source during an active native operation');
    this.advanceEpoch();
    const { value } = await this.request<NativeVideoInfo>({ command: 'open', path, maximumEdge, ...color }, { signal });
    if (!value || !integer(value.width) || !integer(value.height) || !value.width || !value.height
      || value.width > 1280 || value.height > 1280 || !integer(value.sourceWidth) || !integer(value.sourceHeight)
      || typeof value.matrix709 !== 'boolean' || typeof value.fullRange !== 'boolean') throw new Error('Invalid native source metadata');
    return value;
  }
  async close() { await this.request({ command: 'close' }); }
  async shutdown(): Promise<void> {
    if (this.alive) {
      try { await this.request({ command: 'shutdown' }, { timeoutMs: 5000 }); }
      catch { this.child.kill(); }
      this.child.stdin.end();
    }
    if (!this.alive && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.terminated, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AppFailure('NATIVE_TIMEOUT', '无法确认原生进程退出，保留缓存文件。')), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
