import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JobState } from '../../shared/contracts.ts';
import { AppFailure, publicError } from '../errors.ts';
import { TempFiles } from './temp-files.ts';
import { runProcess } from '../media/runner.ts';
import type { EnginePaths } from '../media/engine.ts';

export class DiagnosticQueue {
  private current: JobState | null = null;
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private closing = false;
  private readonly temp: TempFiles;
  private readonly changed: () => void;
  constructor(temp: TempFiles, changed: () => void) { this.temp = temp; this.changed = changed; }
  snapshot(): JobState | null { return this.current ? structuredClone(this.current) : null; }
  start(engines: EnginePaths): string {
    if (this.closing || this.pending) throw new AppFailure('JOB_BUSY', '已有任务正在运行或退出清理中。');
    const id = randomUUID();
    this.controller = new AbortController();
    this.current = { id, kind: 'diagnostics', state: 'running', progress: 0,
      message: '正在生成本地测试片段，不访问网络或你的素材。', startedAt: new Date().toISOString() };
    this.changed();
    this.pending = this.execute(engines, this.controller.signal).finally(() => { this.pending = undefined; this.controller = undefined; this.changed(); });
    return id;
  }
  cancel(id: string): void {
    if (this.current?.id !== id || !this.pending || !this.controller) throw new AppFailure('JOB_NOT_FOUND', '该任务已结束或不存在。');
    this.current.state = 'cancelling'; this.current.message = '正在停止媒体进程并清理临时文件…';
    this.controller.abort(); this.changed();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    await this.pending;
  }
  private async execute(engines: EnginePaths, signal: AbortSignal): Promise<void> {
    let directory: string | undefined;
    let failure: unknown;
    try {
      signal.throwIfAborted();
      directory = await this.temp.create();
      const video = join(directory, 'diagnostic.mp4');
      let progressText = '';
      await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-n',
        '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
        '-progress', 'pipe:1', '-nostats', video], {
        signal, captureStdout: false, timeoutMs: 30000,
        onStdout: chunk => {
          progressText += chunk;
          const lines = progressText.split('\n'); progressText = lines.pop() ?? '';
          if (progressText.length > 4096) throw new Error('Malformed progress');
          for (const line of lines) {
            const match = /^out_time_us=(\d+)/.exec(line);
            if (match && this.current?.state === 'running') {
              this.current.progress = Math.min(85, Math.round(Number(match[1]) / 4000000 * 85));
              this.changed();
            }
          }
        },
      });
      signal.throwIfAborted();
      if (this.current) { this.current.progress = 90; this.current.message = '正在使用捆绑的 ffprobe 校验片段…'; this.changed(); }
      const result = await runProcess(engines.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=codec_name,width,height:format=duration', '-of', 'json', video], { signal, timeoutMs: 15000 });
      const media = JSON.parse(result.stdout) as { streams?: { codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } };
      if (media.streams?.[0]?.codec_name !== 'h264' || media.streams[0].width !== 320 || media.streams[0].height !== 240
        || Math.abs(Number(media.format?.duration) - 4) > 0.1 || !Number.isFinite(Number(media.format?.duration))) throw new Error('Probe mismatch');
      await runProcess(engines.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-nostdin', '-i', video, '-f', 'null', '-'], { signal, timeoutMs: 15000 });
      signal.throwIfAborted();
    } catch (error) { failure = error; }
    if (directory) {
      try { await this.temp.remove(directory); }
      catch { failure = new AppFailure('TEMP_CLEANUP', '任务已停止，但临时文件未能清理。下次启动将安全重试。'); }
    }
    if (!this.current) return;
    this.current.finishedAt = new Date().toISOString();
    if (failure instanceof AppFailure && failure.code === 'TEMP_CLEANUP') {
      this.current.state = 'failed'; this.current.error = publicError(failure); this.current.message = failure.message;
    } else if (signal.aborted) {
      this.current.state = 'cancelled'; this.current.message = '已取消，临时文件已清理。';
    } else if (failure) {
      this.current.state = 'failed';
      this.current.error = { code: 'MEDIA_FAILED', message: '本地媒体自检失败，请确认引擎完整性、磁盘空间和写入权限。' };
      this.current.message = this.current.error.message;
    } else {
      this.current.state = 'completed'; this.current.progress = 100;
      this.current.message = '离线生成、探测、完整解码与临时文件清理均通过。';
    }
    this.changed();
  }
}
