import { taskResults } from '@shared/behavior'
import type { TaskRecord } from '@shared/types'
import { logger } from '../logger'
import { markUnresolvedFailed } from './analysis'
import { emitSummary } from './event'
import { flushSave } from './store'

export async function finishTask(task: TaskRecord, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('任务已取消')
  const failed = taskResults(task).some((frame) => frame.status === 'failed' || frame.regionStatus === 'failed')
  const terminal: Partial<TaskRecord> = {
    status: failed ? 'completed_with_errors' : 'completed',
    progress: 100,
    phaseMessage: failed ? '已完成，部分结果失败' : '已完成',
    errorMessage: ''
  }
  // 终态先落盘，成功后再向查询和事件暴露；保存期间仍接受取消。
  await flushSave(task, terminal)
  if (signal?.aborted) throw new Error('任务已取消')
  Object.assign(task, terminal)
  emitSummary(task, true)
}

/** 所有工作协程退出后才调用；落盘失败仍须发布真实的失败状态。 */
export async function failTask(task: TaskRecord, error: unknown, cancelled: boolean): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  task.status = cancelled && !task.saveError ? 'cancelled' : 'failed'
  task.phaseMessage = task.saveError ? '保存失败' : cancelled ? '已取消' : '任务失败'
  task.errorMessage = task.saveError || (cancelled ? '' : message)
  markUnresolvedFailed(task, cancelled ? '任务已取消' : message)
  if (!cancelled) logger.error('任务失败', error)
  try {
    await flushSave(task)
  } catch {
    task.status = 'failed'
    task.phaseMessage = '保存失败'
    task.errorMessage = task.saveError || '保存结果失败'
  } finally {
    emitSummary(task, true)
  }
}
