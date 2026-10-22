import type { AppError, AppErrorCode, Reply } from '../shared/contracts.ts';

export class AppFailure extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.code = code; }
}
export function publicError(error: unknown): AppError {
  if (error instanceof AppFailure) return { code: error.code, message: error.message };
  return { code: 'INTERNAL', message: '本地操作失败，请检查文件权限或重新启动应用。' };
}
export async function reply<T>(operation: () => T | Promise<T>, onFailure?: (error: unknown) => void): Promise<Reply<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    // Optional local-main-process diagnostics must never widen the public reply or change its result.
    try { onFailure?.(error); } catch { /* A diagnostic sink is not part of the operation's authority. */ }
    return { ok: false, error: publicError(error) };
  }
}
