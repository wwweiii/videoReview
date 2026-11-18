import crypto from 'node:crypto'
import { withTaskContext } from '../runtime/scheduler'
import type { TaskKind, TaskRecord, TaskSummary } from '@shared/types'
import { taskResults } from '@shared/behavior'
import { frameView } from '@shared/task-view'
import { getTaskStats, invalidateTaskStats } from './stats'
import { readFrameDiagnostics } from './diagnostics'
import { getResolvedModelConfig, type ResolvedModelConfig } from '../config/model-config'
import { getAnalysisConfig, getBehaviorConfig } from '../config/settings'
import { getVideoThumbnailBuffer, probeVideo } from '../media/ffmpeg'
import { analyzeFrames, markUnresolvedFailed, markUnresolvedFrameFailed } from './analysis'
import { clearSummaryThrottle, emitFrame, emitSummary } from './event'
import { regionCandidateFrames, localizeFrames } from './regions'
import { runTask } from './runner'
import { failTask, finishTask } from './outcome'
import { reanalyzingFrameIndices, taskSession, type ActiveRun, type FrameReanalysis } from './session'
import {
  allTaskIds, deleteStoredTask, ensureTasksDirectory, flushAllTasks, flushSave,
  newFrame, readTask, rememberTask, scheduleSave, validateTaskId, readTaskSummary, trimTaskCache
} from './store'
import { buildSummary } from './summary'
import { runBehaviorTask } from './behavior'

export { exportTaskResults } from './export'

let initialized = false

export function initializeTaskManager(): void {
  if (initialized) return
  initialized = true
  ensureTasksDirectory()
  for (const taskId of allTaskIds()) {
    const summary = readTaskSummary(taskId)
    if (!summary || (!['extracting', 'analyzing'].includes(summary.status) && !summary.hasUnfinishedResults)) continue
    const task = readTask(taskId)
    if (!task) continue
    if (task.status === 'extracting' || task.status === 'analyzing') {
      task.status = 'interrupted'
      task.phaseMessage = '已中断'
      markUnresolvedFailed(task, '任务已中断')
      scheduleSave(task, true)
    } else if (task.frames.some((frame) => frame.regionStatus === 'pending')) {
      // 修复旧版本取消后遗留的定位中状态。
      markUnresolvedFailed(task, '定位已中断')
      scheduleSave(task, true)
    }
  }
}

export function listTasks(): TaskSummary[] {
  return allTaskIds()
    .map(readTaskSummary)
    .filter((task): task is TaskSummary => Boolean(task))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function getTaskView(taskId: string): TaskRecord {
  const task = getTask(taskId)
  return { ...task, stats: getTaskStats(task), frames: task.frames.map(frameView),
    reanalyzingFrameIndices: reanalyzingFrameIndices(taskId),
    ...(task.behaviorWindows ? { behaviorWindows: task.behaviorWindows.map(frameView) } : {}) }
}

export async function getFrameDiagnostics(taskId: string, index: number) {
  if (!Number.isInteger(index) || index < 0) throw new Error('结果编号无效')
  const frame = taskResults(getTask(taskId)).find((frame) => frame.index === index)
  if (!frame) throw new Error('结果不存在')
  return readFrameDiagnostics(taskId, frame)
}

export function getTask(taskId: string): TaskRecord {
  validateTaskId(taskId)
  const task = readTask(taskId)
  if (!task) throw new Error('任务不存在')
  return task
}

function assertAcceptingTasks(): void {
  if (taskSession.shuttingDown) throw new Error('应用正在退出，请稍后重试')
}

/** 启动和重试共用生命周期，退出时可以等待所有工作完成。 */
function launchRun(
  task: TaskRecord,
  work: (controller: AbortController) => Promise<void>,
  reanalysis?: FrameReanalysis
): ActiveRun {
  assertAcceptingTasks()
  rememberTask(task)
  invalidateTaskStats(task)
  const abortController = new AbortController()
  const run: ActiveRun = { taskId: task.id, abortController, cancelRequested: false, completion: Promise.resolve(), reanalysis }
  taskSession.activeRuns.set(task.id, run)
  run.completion = Promise.resolve()
    .then(() => withTaskContext(task.id, () => work(abortController)))
    .catch((error) => failTask(task, error, run.cancelRequested))
    .finally(() => {
      taskSession.activeRuns.delete(task.id)
      clearSummaryThrottle(task.id)
      trimTaskCache()
    })
  return run
}

function prepareTask(filePath: string, kind: TaskKind): Promise<TaskSummary> {
  const preparation = startTask(filePath, kind)
  taskSession.preparations.add(preparation)
  void preparation.then(() => taskSession.preparations.delete(preparation), () => taskSession.preparations.delete(preparation))
  return preparation
}

export function startReview(filePath: string): Promise<TaskSummary> {
  return prepareTask(filePath, 'items')
}

export function startBehaviorReview(filePath: string): Promise<TaskSummary> {
  return prepareTask(filePath, 'behavior')
}

async function startTask(filePath: string, kind: TaskKind): Promise<TaskSummary> {
  assertAcceptingTasks()
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择视频文件')
  const modelConfig = getResolvedModelConfig()
  const config = getAnalysisConfig()
  const behaviorConfig = kind === 'behavior' ? getBehaviorConfig() : undefined
  if (kind === 'items' && config.prohibitedItems.length === 0) throw new Error('请先在设置中选择检测物品')
  if (kind === 'behavior' && !behaviorConfig?.behaviors.length) throw new Error('请先在设置中添加至少一个识别行为')
  const source = await probeVideo(filePath)
  assertAcceptingTasks()
  const thumbnail = await getVideoThumbnailBuffer(source.filePath)
  assertAcceptingTasks()
  const now = new Date().toISOString()
  const task: TaskRecord = {
    id: crypto.randomUUID(), kind, name: source.fileName, source,
    config: kind === 'behavior' ? { ...config, localize: false } : config,
    status: 'extracting', createdAt: now, updatedAt: now, frames: [],
    errorMessage: '', progress: 0, phaseMessage: '正在抽帧', regionProfile: null,
    ...(behaviorConfig ? { behaviorConfig, behaviorWindows: [] } : {})
  }
  rememberTask(task)
  try {
    await flushSave(task, undefined, thumbnail)
    assertAcceptingTasks()
  } catch (error) {
    await failTask(task, error, false)
    throw error
  }
  emitSummary(task, true)
  launchRun(task, (controller) => (kind === 'behavior' ? runBehaviorTask : runTask)(task, modelConfig, controller))
  return buildSummary(task)
}

export function retryFailedFrames(taskId: string): TaskSummary {
  assertAcceptingTasks()
  const task = getTask(taskId)
  if (taskSession.activeRuns.has(taskId)) throw new Error('任务正在处理')
  const results = taskResults(task)
  const failed = results.filter((frame) => frame.status === 'failed')
  const needsExtraction = results.length === 0
  const failedRegions = task.kind !== 'behavior' && task.config.localize
    ? regionCandidateFrames(task).filter((frame) => frame.regionStatus === 'failed')
    : []
  if (!needsExtraction && failed.length === 0 && failedRegions.length === 0 && !task.saveError) {
    throw new Error('没有需要重试的结果')
  }
  const modelConfig = getResolvedModelConfig()
  const retryIndices = new Set([...failed, ...failedRegions].map((frame) => frame.index))
  for (const frame of failed) {
    Object.assign(frame, {
      status: 'pending', verdict: 'pending', error: '', rawResponse: '', analyzedAt: null,
      detailRef: undefined, callTraces: [],
      model: '', regions: [], regionStatus: 'none', regionLevel: 'L0', regionError: '', regionRaw: ''
    })
  }
  task.status = needsExtraction ? 'extracting' : 'analyzing'
  task.progress = 0
  task.phaseMessage = needsExtraction ? '正在重新抽帧' : '正在重试'
  task.errorMessage = ''
  invalidateTaskStats(task)
  emitSummary(task, true)
  launchRun(task, async (controller) => {
    await flushSave(task)
    if (task.kind === 'behavior') {
      await runBehaviorTask(task, modelConfig, controller, !needsExtraction)
    } else if (needsExtraction) {
      await runTask(task, modelConfig, controller)
    } else {
      const failedIndices = new Set(failed.map((frame) => frame.index))
      await analyzeAndLocalizeFrames(task, modelConfig, controller.signal, failedIndices, retryIndices)
    }
  })
  return buildSummary(task)
}

export async function reanalyzeFrame(taskId: string, index: number): Promise<void> {
  assertAcceptingTasks()
  if (!Number.isInteger(index) || index < 0) throw new Error('结果编号无效')
  const task = getTask(taskId)
  if (task.kind === 'behavior') throw new Error('仅物品识别任务支持重新判断')
  const activeRun = taskSession.activeRuns.get(taskId)
  if (activeRun && (!activeRun.reanalysis?.pending.size || activeRun.abortController.signal.aborted)) {
    throw new Error('任务正在处理')
  }
  const reanalysis = activeRun?.reanalysis ?? { pending: new Map<number, Promise<void>>(), submitted: 0 }
  if (reanalysis.pending.has(index)) throw new Error('该帧正在重新判断')
  const frame = task.frames.find((frame) => frame.index === index)
  if (!frame) throw new Error('结果不存在')

  const modelConfig = getResolvedModelConfig()
  Object.assign(frame, newFrame(frame.index, frame.timestampMs, frame.fileName), { detailRef: undefined })
  task.status = 'analyzing'
  task.phaseMessage = '正在重新判断'
  task.errorMessage = ''
  const run = activeRun ?? launchRun(task, async (controller) => {
    while (reanalysis.pending.size > 0) {
      await Promise.allSettled(reanalysis.pending.values())
    }
    await finishTask(task, controller.signal)
  }, reanalysis)
  const signal = run.abortController.signal
  const indices = new Set([index])
  const work = withTaskContext(taskId, async () => {
    try {
      await flushSave(task)
      await analyzeFrames(task, modelConfig, signal, indices, { manageTaskProgress: false })
      await localizeFrames(task, modelConfig, signal, indices, false)
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      markUnresolvedFrameFailed(frame, message)
      emitFrame(task, frame)
    }
    if (!signal.aborted) await flushSave(task)
  }).finally(() => {
    reanalysis.pending.delete(index)
    updateReanalysisProgress(task, reanalysis)
  })
  reanalysis.submitted += 1
  reanalysis.pending.set(index, work)
  emitFrame(task, frame)
  updateReanalysisProgress(task, reanalysis)
  await work
  if (reanalysis.pending.size === 0) await run.completion
}

function updateReanalysisProgress(task: TaskRecord, reanalysis: FrameReanalysis): void {
  const completed = reanalysis.submitted - reanalysis.pending.size
  task.progress = Math.min(99, Math.round(completed / reanalysis.submitted * 100))
  emitSummary(task, true)
}

async function analyzeAndLocalizeFrames(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  signal: AbortSignal,
  analysisIndices: Set<number>,
  localizationIndices = analysisIndices
): Promise<void> {
  await analyzeFrames(task, modelConfig, signal, analysisIndices)
  await localizeFrames(task, modelConfig, signal, localizationIndices)
  await finishTask(task, signal)
}

export async function cancelActiveTask(taskId: string): Promise<boolean> {
  const run = taskSession.activeRuns.get(taskId)
  if (!run) return false
  run.cancelRequested = true
  run.abortController.abort()
  await run.completion
  return true
}

export async function deleteTask(taskId: string): Promise<void> {
  validateTaskId(taskId)
  if (taskSession.activeRuns.has(taskId)) throw new Error('任务正在处理')
  await deleteStoredTask(taskId)
}

export async function shutdownTaskManager(): Promise<void> {
  taskSession.shuttingDown = true
  const runs = [...taskSession.activeRuns.values()]
  for (const run of runs) {
    run.cancelRequested = true
    run.abortController.abort()
  }
  await Promise.allSettled([...runs.map((run) => run.completion), ...taskSession.preparations])
  await flushAllTasks()
}
