import type { EngineCheckProgress } from './contracts.ts';
export function startupMessage(check?: EngineCheckProgress): string {
  if (!check || check.stage === 'manifest') return '正在读取本地引擎清单…';
  const step = `（${check.index}/${check.total}）`;
  return check.stage === 'integrity' ? `正在校验 ${check.binary} ${step}…` : `正在检查 ${check.binary} 是否可运行 ${step}…`;
}
