/**
 * 数值与时间的格式化/收敛工具（纯函数，主进程与渲染进程共用）。
 */

/** 把任意数值收敛到 [min, max]；非法数值返回 min */
export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 抽帧间隔（秒）：0.5–60，保留 1 位小数 */
export function normalizeInterval(value: number): number {
  return Math.round(clampNumber(value, 0.5, 60) * 10) / 10
}

/** 时长展示：超过 1 小时带小时位，如 01:23:45；否则 12:34 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 视频时间点展示：固定 时:分:秒 */
export function formatTimeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00:00'
  const totalMs = Math.round(ms)
  const totalSeconds = Math.floor(totalMs / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
