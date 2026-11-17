import type { TaskRecord } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { extractFrames } from '../media/ffmpeg'
import { analyzeFrames } from './analysis'
import { emitSummary } from './event'
import { createRegionRunner } from './regions'
import { taskSession } from './session'
import { flushSave, newFrame } from './store'
import { failTask, finishTask } from './outcome'

export { finishTask } from './outcome'

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
      await runner?.abort()
      throw error
    }
    if (abortController.signal.aborted) throw new Error('任务已取消')
    await finishTask(task, abortController.signal)
  } catch (error) {
    const cancelled = abortController.signal.aborted && (run?.cancelRequested ?? false)
    await failTask(task, error, cancelled)
  }
}
