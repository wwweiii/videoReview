import { countFrameStats } from '@shared/task'
import { taskResults } from '@shared/behavior'
import type { TaskRecord, TaskSummary } from '@shared/types'

/** 由任务记录生成列表/事件使用的摘要（统计口径由 @shared/task 统一） */
export function buildSummary(task: TaskRecord): TaskSummary {
  const frames = taskResults(task)
  const stats = countFrameStats(frames)

  let progress = task.progress
  if (task.status === 'completed' || task.status === 'completed_with_errors') progress = 100
  else if (task.status === 'analyzing' && frames.length > 0 && task.progress === 0) {
    progress = Math.round((stats.processed / frames.length) * 1000) / 10
  }

  return {
    id: task.id,
    kind: task.kind ?? 'items',
    name: task.name,
    filePath: task.source.filePath,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    durationMs: task.source.durationMs,
    width: task.source.width,
    height: task.source.height,
    totalFrames: frames.length,
    processedFrames: stats.processed,
    abnormalCount: stats.abnormal,
    reviewCount: stats.review,
    normalCount: stats.normal,
    failedCount: stats.failed,
    locatedCount: stats.located,
    progress,
    phaseMessage: task.phaseMessage,
    errorMessage: task.errorMessage
  }
}
