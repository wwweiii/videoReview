import { BEHAVIOR_CONFIG, groupBehaviorSamples } from '@shared/behavior'
import type { TaskRecord } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { extractFrames } from '../media/ffmpeg'
import { analyzeBehaviorWindow } from '../model/behavior'
import { deriveVerdict } from '../model/analysis'
import { FatalModelError } from '../model/client'
import { getFramesDir } from '../paths'
import { logger } from '../logger'
import { clearSummaryThrottle, emitBehaviorWindow, emitSummary } from './event'
import { markUnresolvedFailed } from './analysis'
import { taskSession } from './session'
import { flushSave, newFrame, scheduleSave } from './store'

export async function runBehaviorTask(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  controller: AbortController,
  retryOnly = false
): Promise<void> {
  const run = taskSession.activeRuns.get(task.id)
  try {
    const sampling = {
      ...BEHAVIOR_CONFIG,
      ...(task.behaviorConfig ?? {}),
      behaviors: task.behaviorConfig?.behaviors ?? []
    }
    if (!retryOnly) {
      const samples = await extractFrames({
        taskId: task.id,
        filePath: task.source.filePath,
        durationMs: task.source.durationMs,
        intervalSec: 1 / sampling.fps,
        imageFormat: 'jpeg',
        maxEdge: Math.min(modelConfig.imageMaxEdge || 1120, 1120),
        startAtZero: true,
        signal: controller.signal,
        onProgress: ({ percent }) => {
          task.progress = percent
          task.phaseMessage = `正在提取行为画面（${sampling.fps} FPS）`
          emitSummary(task)
        }
      })
      task.behaviorWindows = groupBehaviorSamples(samples, task.source.durationMs, newFrame, sampling)
    }
    task.status = 'analyzing'
    task.progress = 0
    task.phaseMessage = '正在识别行为'
    task.errorMessage = ''
    await flushSave(task)
    emitSummary(task, true)
    const windows = task.behaviorWindows ?? []
    for (const window of windows) {
      if (controller.signal.aborted) throw new Error('任务已取消')
      if (window.status === 'completed') continue
      window.status = 'analyzing'
      emitBehaviorWindow(task, window)
      try {
        const result = await analyzeBehaviorWindow(
          modelConfig,
          window,
          getFramesDir(task.id),
          controller.signal,
          sampling.behaviors,
          sampling.fps
        )
        const verdict = deriveVerdict(result, task.config.confidenceThreshold)
        Object.assign(window, {
          status: 'completed',
          verdict: verdict.verdict,
          riskLevel: result.riskLevel,
          categories: result.categories,
          description: result.description,
          evidence: result.evidence,
          confidence: result.confidence,
          needHumanReview: verdict.needHumanReview,
          rawResponse: result.raw,
          error: '',
          analyzedAt: new Date().toISOString(),
          model: modelConfig.label
        })
      } catch (error) {
        if (controller.signal.aborted || error instanceof FatalModelError) throw error
        window.status = 'failed'
        window.verdict = 'failed'
        window.error = error instanceof Error ? error.message : String(error)
        window.analyzedAt = new Date().toISOString()
        window.model = modelConfig.label
      }
      const processed = windows.filter((item) => item.status === 'completed' || item.status === 'failed').length
      task.progress = Math.round(processed / windows.length * 1000) / 10
      task.phaseMessage = `正在识别行为 ${processed}/${windows.length}`
      scheduleSave(task)
      emitBehaviorWindow(task, window)
    }
    task.status = windows.some((window) => window.status === 'failed') ? 'completed_with_errors' : 'completed'
    task.progress = 100
    task.phaseMessage = '已完成'
    await flushSave(task)
    emitSummary(task, true)
  } catch (error) {
    const cancelled = controller.signal.aborted && Boolean(run?.cancelRequested)
    const message = error instanceof Error ? error.message : String(error)
    task.status = cancelled ? 'cancelled' : 'failed'
    task.phaseMessage = cancelled ? '已取消' : '行为识别失败'
    task.errorMessage = cancelled ? '' : message
    markUnresolvedFailed(task, cancelled ? '任务已取消' : message)
    if (!cancelled) logger.error('行为识别失败', error)
    await flushSave(task)
    emitSummary(task, true)
  } finally {
    taskSession.activeRuns.delete(task.id)
    clearSummaryThrottle(task.id)
  }
}
