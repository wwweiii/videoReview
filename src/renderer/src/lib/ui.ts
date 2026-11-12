/**
 * 渲染进程 UI 专属辅助（URL 拼装、错误文案、取色）。
 *
 * 任务状态/帧判定文案与统计已迁到 `@shared/task`，时间/数值格式化在 `@shared/format`，
 * 本文件只保留纯前端展示逻辑。
 */

export function frameImageUrl(taskId: string, fileName: string, thumb = false): string {
  return `vr-media://frames/${taskId}/${encodeURIComponent(fileName)}${thumb ? '?thumb=1' : ''}`
}

export function friendlyError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '')
  message = message.replace(/^Error:\s*/i, '')
  return message || '操作失败'
}

/* ------------------------------ Toast 契约 ------------------------------ */

export type ToastKind = 'success' | 'error' | 'info'

/** 全局 toast 触发函数（App 注入，页面/组件复用） */
export type ShowToast = (kind: ToastKind, message: string) => void

/* ------------------------------ 定位框取色 ------------------------------ */

/** 违禁物类别 → 稳定取色（FNV-1a 哈希 + 低饱和色板，同类同色、跨类别可区分） */
const REGION_PALETTE = [
  '#c4553d',
  '#b07c2a',
  '#5c7d3a',
  '#2f7d6b',
  '#37718c',
  '#4a5fa5',
  '#7457a6',
  '#a04b84',
  '#8a5a3f',
  '#4d6b52'
] as const

export function regionColor(category: string): string {
  const text = category.trim() || '?'
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return REGION_PALETTE[hash % REGION_PALETTE.length]
}
