export type CleanupReason = 'missing-marker' | 'invalid-marker' | 'in-use' | 'permission' | 'unsafe-path' | 'invalid-journal' | 'io';
export type CleanupIssue = {
  area: string;
  directory: string;
  reason: CleanupReason;
  message: string;
  retryable: boolean;
};
export const CLEANUP_REASONS: Record<CleanupReason, string> = {
  'missing-marker': '缺少所有权标记，未删除内容',
  'invalid-marker': '所有权标记损坏或不匹配，未获清理授权',
  'in-use': '文件被占用，已保留所有权供下次重试',
  permission: '没有删除权限，已保留恢复信息',
  'unsafe-path': '路径被替换、含链接或异常内容，拒绝清理',
  'invalid-journal': '恢复记录损坏或与目录不匹配，拒绝认领',
  io: '磁盘或文件系统错误，清理尚未完成',
};
