import crypto from 'node:crypto'
import { withTaskContext } from '../runtime/scheduler'
import type { TaskKind, TaskRecord, TaskSummary } from '@shared/types'
import { taskResults } from '@shared/behavior'
import { frameView } from '@shared/task-view'
import { getTaskStats, invalidateTaskStats } from './stats'
import { readFrameDiagnostics } from './diagnostics'
import { getResolvedModelConfig } from '../config/model-config'
import { getAnalysisConfig, getBehaviorConfig } from '../config/settings'
import { probeVideo } from '../media/ffmpeg'
import { analyzeFrames, markUnresolvedFailed } from './analysis'
import { clearSummaryThrottle, emitSummary } from './event'
import { regionCandidateFrames, localizeFrames } from './regions'
import { runTask } from './runner'
import { failTask, finishTask } from './outcome'
import { taskSession, type ActiveRun } from './session'
import {
  allTaskIds, deleteStoredTask, ensureTasksDirectory, flushAllTasks, flushSave,
  readTask, rememberTask, scheduleSave, validateTaskId, readTaskSummary, trimTaskCache
} from './store'
import { buildSummary } from './summary'
import { runBehaviorTask } from './behavior'

export { exportTaskCsv } from './export'

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
function launchRun(task: TaskRecord, work: (controller: AbortController) => Promise<void>): void {
  assertAcceptingTasks()
  rememberTask(task)
  invalidateTaskStats(task)
  const abortController = new AbortController()
  const run: ActiveRun = { taskId: task.id, abortController, cancelRequested: false, completion: Promise.resolve() }
  taskSession.activeRuns.set(task.id, run)
  run.completion = Promise.resolve()
    .then(() => withTaskContext(task.id, () => work(abortController)))
    .catch((error) => failTask(task, error, run.cancelRequested))
    .finally(() => {
      taskSession.activeRuns.delete(task.id)
      clearSummaryThrottle(task.id)
      trimTaskCache()
    })
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
    await flushSave(task)
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
      await analyzeFrames(task, modelConfig, controller.signal, new Set(failed.map((frame) => frame.index)))
      await localizeFrames(task, modelConfig, controller.signal, retryIndices)
      if (controller.signal.aborted) throw new Error('任务已取消')
      await finishTask(task, controller.signal)
    }
  })
  return buildSummary(task)
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
