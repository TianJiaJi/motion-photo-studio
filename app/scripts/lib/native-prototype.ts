// Prototype test transport, not exposed to a renderer.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
export type NativeReply = { header: { version: number; id: number; generation: number; bodyBytes: number; result: any; error?: string }; pixels: Buffer };
export class NativePrototype {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  private carry = Buffer.alloc(0);
  private next = 0;
  private failure: Error | undefined;
  private waiting = new Map<number, { resolve(value: NativeReply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  stderr = '';
  constructor() {
    this.child = spawn(resolve(process.env.MOTION_PREVIEW_PROTOTYPE_EXE ?? 'resources/bin/motion-preview.exe'), [], { shell: false, windowsHide: true });
    this.closed = new Promise(resolve => this.child.once('close', code => {
      this.fail(new Error(`Native helper closed ${code}: ${this.stderr}`)); resolve(code);
    }));
    this.child.once('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-16384); });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.carry = Buffer.concat([this.carry, chunk]);
        if (this.carry.length > 1280 * 1280 * 4 + 65536) throw new Error('Native response exceeded buffer budget');
        while (this.carry.length >= 4) {
          const length = this.carry.readUInt32LE();
          if (!length || length > 16384) throw new Error('Invalid native header length');
          if (this.carry.length < 4 + length) return;
          const header = JSON.parse(this.carry.subarray(4, 4 + length).toString('utf8')) as NativeReply['header'];
          if (header.version !== 1 || !Number.isSafeInteger(header.bodyBytes) || header.bodyBytes < 0 || header.bodyBytes > 1280 * 1280 * 4) throw new Error('Invalid native payload');
          const total = 4 + length + header.bodyBytes;
          if (this.carry.length < total) return;
          const pixels = Buffer.from(this.carry.subarray(4 + length, total));
          this.carry = this.carry.subarray(total);
          const pending = this.waiting.get(header.id);
          if (!pending) throw new Error('Unexpected native response id');
          this.waiting.delete(header.id); clearTimeout(pending.timer);
          if (header.error) pending.reject(new Error(header.error)); else pending.resolve({ header, pixels });
        }
      } catch (error) { this.fail(error as Error); this.child.kill(); }
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const entry of this.waiting.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.waiting.clear();
  }
  request(command: Record<string, unknown>): Promise<NativeReply> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    const json = Buffer.from(JSON.stringify({ version: 1, id, generation: 1, ...command }));
    if (json.length > 16384 || this.waiting.size > 2) return Promise.reject(new Error('Prototype request budget exceeded'));
    const size = Buffer.alloc(4); size.writeUInt32LE(json.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('Native request timeout')); this.child.kill(); }, 30000);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(Buffer.concat([size, json]));
    });
  }
  async shutdown() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    try { await this.request({ command: 'shutdown' }); }
    finally { this.child.stdin.end(); }
    return this.closed;
  }
}
