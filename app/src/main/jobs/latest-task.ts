import { AppFailure } from '../errors.ts';

// One native operation at a time. A newer request aborts the old one, then waits for its cleanup.
export class LatestTask {
  private controller?: AbortController;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  get busy(): boolean { return this.pending > 0; }
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AppFailure('CANCELLED', '媒体会话已关闭。'));
    this.controller?.abort();
    const controller = new AbortController(); this.controller = controller;
    const previous = this.tail;
    this.pending++;
    const result = (async () => {
      try { await previous; controller.signal.throwIfAborted(); return await operation(controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw new AppFailure('CANCELLED', '媒体操作已取消。');
        throw error;
      } finally { this.pending--; }
    })();
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  async cancel(): Promise<void> { this.controller?.abort(); await this.tail; }
  async close(): Promise<void> { this.closed = true; await this.cancel(); }
}
