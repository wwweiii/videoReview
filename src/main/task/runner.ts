import type { TaskRecord } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { logger } from '../logger'
import { extractFrames } from '../media/ffmpeg'
import { analyzeFrames, markUnresolvedFailed } from './analysis'
import { clearSummaryThrottle, emitSummary } from './event'
import { createRegionRunner } from './regions'
import { taskSession } from './session'
import { flushSave, newFrame } from './store'

export async function runTask(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  abortController: AbortController
): Promise<void> {
  const run = taskSession.activeRuns.get(task.id)
  try {
    const extracted = await extractFrames({
      taskId: task.id,
      filePath: task.source.filePath,
      durationMs: task.source.durationMs,
      intervalSec: task.config.intervalSec,
      signal: abortController.signal,
      onProgress: (progress) => {
        task.progress = progress.percent
        task.phaseMessage = progress.message
        emitSummary(task)
      }
    })

    task.frames = extracted.map((frame) =>
      newFrame(frame.index, frame.timestampMs, frame.fileName)
    )
    task.status = 'analyzing'
    task.progress = 0
    task.phaseMessage = '正在分析'
    await flushSave(task)
    emitSummary(task, true)

    // 判定与定位重叠：判定出一帧异常就立刻入队定位，框不用等全部判定跑完
    const runner = task.config.localize
      ? createRegionRunner(task, modelConfig, abortController.signal, false)
      : null
    try {
      await analyzeFrames(
        task,
        modelConfig,
        abortController.signal,
        null,
        runner
          ? {
              onFrameAnalyzed: (frame) => runner.enqueue(frame),
              getCounts: () => runner.counts()
            }
          : undefined
      )
      if (runner) await runner.finish()
    } catch (error) {
      runner?.abort()
      throw error
    }
    await finishTask(task)
  } catch (error) {
    const cancelled = abortController.signal.aborted && (run?.cancelRequested ?? false)
    const message = error instanceof Error ? error.message : String(error)
    if (cancelled) {
      task.status = 'cancelled'
      task.phaseMessage = '已取消'
      task.errorMessage = ''
      markUnresolvedFailed(task, '任务已取消')
    } else {
      task.status = 'failed'
      task.phaseMessage = '任务失败'
      task.errorMessage = message
      markUnresolvedFailed(task, message)
      logger.error('任务失败', error)
    }
    await flushSave(task)
    emitSummary(task, true)
  } finally {
    taskSession.activeRuns.delete(task.id)
    clearSummaryThrottle(task.id)
  }
}

export async function finishTask(task: TaskRecord): Promise<void> {
  const failedCount = task.frames.filter((frame) => frame.status === 'failed').length
  task.status = failedCount > 0 ? 'completed_with_errors' : 'completed'
  task.progress = 100
  task.phaseMessage = '已完成'
  task.errorMessage = ''
  await flushSave(task)
  emitSummary(task, true)
}
