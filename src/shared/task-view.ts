import type { FrameStats } from './task'
import type { FrameRecord, TaskSummary } from './types'

/** 普通查询和进度事件只携带展示字段，诊断内容通过单独接口读取。 */
export function frameView<T extends FrameRecord>(frame: T): T {
  return { ...frame, rawResponse: '', regionRaw: '', callTraces: [] }
}

export function summaryStats(summary: TaskSummary): FrameStats {
  return {
    total: summary.totalFrames, processed: summary.processedFrames,
    abnormal: summary.abnormalCount, review: summary.reviewCount, normal: summary.normalCount,
    failed: summary.failedCount, located: summary.locatedCount,
    pending: summary.totalFrames - summary.processedFrames
  }
}

/** 一批变更只复制一次结果数组；未改变的行保留对象引用。 */
export function applyResultPatches<T extends FrameRecord>(current: T[], patches: T[]): T[] {
  if (!patches.length) return current
  const pending = new Map(patches.map((frame) => [frame.index, frame]))
  const next = current.map((frame) => {
    const replacement = pending.get(frame.index)
    pending.delete(frame.index)
    return replacement ?? frame
  })
  if (pending.size) next.push(...pending.values())
  return next
}
