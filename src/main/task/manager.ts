import crypto from 'node:crypto'
import fs from 'node:fs'
import type { TaskKind, TaskRecord, TaskSummary } from '@shared/types'
import { BEHAVIOR_CONFIG, taskResults } from '@shared/behavior'
import { getResolvedModelConfig } from '../config/model-config'
import { getAnalysisConfig } from '../config/settings'
import { logger } from '../logger'
import { probeVideo } from '../media/ffmpeg'
import { getTaskDir } from '../paths'
import { analyzeFrames, markUnresolvedFailed } from './analysis'
import { clearSummaryThrottle, emitSummary } from './event'
import { regionCandidateFrames, localizeFrames } from './regions'
import { finishTask, runTask } from './runner'
import { taskSession } from './session'
import {
  allTaskIds,
  deleteStoredTask,
  ensureTasksDirectory,
  flushSave,
  readTask,
  rememberTask,
  scheduleSave,
  validateTaskId
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
    const task = readTask(taskId)
    if (!task) continue
    if (task.status === 'extracting' || task.status === 'analyzing') {
      task.status = 'interrupted'
      task.phaseMessage = '已中断'
      for (const frame of taskResults(task)) {
        if (frame.status === 'analyzing' || frame.status === 'pending') {
          frame.status = 'failed'
          frame.verdict = 'failed'
          frame.error = '任务已中断'
        }
      }
      scheduleSave(task, true)
    }
  }
}

export function listTasks(): TaskSummary[] {
  return allTaskIds()
    .map((taskId) => readTask(taskId))
    .filter((task): task is TaskRecord => Boolean(task))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(buildSummary)
}

export function getTask(taskId: string): TaskRecord {
  validateTaskId(taskId)
  const task = readTask(taskId)
  if (!task) throw new Error('任务不存在')
  return task
}

export async function startReview(filePath: string): Promise<TaskSummary> {
  return startTask(filePath, 'items')
}

export async function startBehaviorReview(filePath: string): Promise<TaskSummary> {
  return startTask(filePath, 'behavior')
}

async function startTask(filePath: string, kind: TaskKind): Promise<TaskSummary> {
  if (taskSession.activeRun) throw new Error('当前有任务正在处理')
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择视频文件')

  const modelConfig = getResolvedModelConfig()
  const config = getAnalysisConfig()
  if (kind === 'items' && config.prohibitedItems.length === 0) {
    throw new Error('请先在设置中选择检测物品')
  }
  if (kind === 'behavior' && config.behaviorItems.length === 0) {
    throw new Error('请先在设置中添加至少一个识别行为')
  }

  const source = await probeVideo(filePath)
  if (taskSession.activeRun) throw new Error('当前有任务正在处理')

  const now = new Date().toISOString()
  const task: TaskRecord = {
    id: crypto.randomUUID(),
    kind,
    name: source.fileName,
    source,
    config: kind === 'behavior' ? { ...config, localize: false } : config,
    status: 'extracting',
    createdAt: now,
    updatedAt: now,
    frames: [],
    errorMessage: '',
    progress: 0,
    phaseMessage: '正在抽帧',
    regionProfile: null,
    ...(kind === 'behavior'
      ? {
          behaviorConfig: {
            ...BEHAVIOR_CONFIG,
            behaviors: config.behaviorItems.map((item) => item.label)
          },
          behaviorWindows: []
        }
      : {})
  }

  fs.mkdirSync(getTaskDir(task.id), { recursive: true })
  rememberTask(task)
  scheduleSave(task, true)
  emitSummary(task, true)

  const abortController = new AbortController()
  taskSession.activeRun = { taskId: task.id, abortController, cancelRequested: false }
  const runner = kind === 'behavior' ? runBehaviorTask : runTask
  void runner(task, modelConfig, abortController).catch((error) => {
    logger.error('任务运行异常', error)
  })
  return buildSummary(task)
}

/** 只重跑定位（不重跑判定），用于换模型后补框 */
export function relocalizeTask(taskId: string): TaskSummary {
  if (taskSession.activeRun) throw new Error('当前有任务正在处理')
  const task = getTask(taskId)
  if (task.kind === 'behavior') throw new Error('行为任务不使用物品定位')
  if (!task.config.localize) throw new Error('当前任务未开启定位标记')
  const targets = regionCandidateFrames(task)
  if (targets.length === 0) throw new Error('没有需要定位的异常帧')

  const modelConfig = getResolvedModelConfig()
  for (const frame of targets) {
    frame.regions = []
    frame.regionStatus = 'pending'
    frame.regionLevel = 'L0'
    frame.regionError = ''
    frame.regionRaw = ''
  }
  task.status = 'analyzing'
  task.progress = 0
  task.phaseMessage = '正在定位违禁物'
  task.errorMessage = ''
  scheduleSave(task, true)
  emitSummary(task, true)

  const abortController = new AbortController()
  taskSession.activeRun = { taskId: task.id, abortController, cancelRequested: false }
  void (async () => {
    try {
      await localizeFrames(task, modelConfig, abortController.signal, { onlyLocalize: true })
      await finishTask(task)
    } catch (error) {
      const cancelled = abortController.signal.aborted && (taskSession.activeRun?.cancelRequested ?? false)
      const message = error instanceof Error ? error.message : String(error)
      if (cancelled) {
        task.status = 'cancelled'
        task.phaseMessage = '已取消'
        task.errorMessage = ''
      } else {
        task.status = 'failed'
        task.phaseMessage = '任务失败'
        task.errorMessage = message
      }
      for (const frame of targets) {
        if (frame.regionStatus === 'pending') {
          frame.regionStatus = 'failed'
          frame.regionError = message
        }
      }
      await flushSave(task)
      emitSummary(task, true)
    } finally {
      if (taskSession.activeRun?.taskId === task.id) taskSession.activeRun = null
      clearSummaryThrottle(task.id)
    }
  })()
  return buildSummary(task)
}

export function retryFailedFrames(taskId: string): TaskSummary {
  if (taskSession.activeRun) throw new Error('当前有任务正在处理')
  const task = getTask(taskId)
  if (task.kind === 'behavior') {
    const failedWindows = (task.behaviorWindows ?? []).filter((window) => window.status === 'failed')
    if (failedWindows.length === 0) throw new Error('没有失败片段')
    const modelConfig = getResolvedModelConfig()
    for (const window of failedWindows) {
      window.status = 'pending'
      window.verdict = 'pending'
      window.error = ''
      window.rawResponse = ''
      window.analyzedAt = null
    }
    task.status = 'analyzing'
    task.phaseMessage = '正在重试行为识别'
    task.errorMessage = ''
    scheduleSave(task, true)
    emitSummary(task, true)
    const abortController = new AbortController()
    taskSession.activeRun = { taskId: task.id, abortController, cancelRequested: false }
    void runBehaviorTask(task, modelConfig, abortController, true)
    return buildSummary(task)
  }
  const failed = task.frames.filter((frame) => frame.status === 'failed')
  if (failed.length === 0) throw new Error('没有失败帧')

  const modelConfig = getResolvedModelConfig()
  for (const frame of failed) {
    frame.status = 'pending'
    frame.verdict = 'pending'
    frame.error = ''
    frame.rawResponse = ''
    frame.analyzedAt = null
    frame.model = ''
    frame.regions = []
    frame.regionStatus = 'none'
    frame.regionLevel = 'L0'
    frame.regionError = ''
    frame.regionRaw = ''
  }
  task.status = 'analyzing'
  task.progress = 0
  task.phaseMessage = '正在分析'
  task.errorMessage = ''
  scheduleSave(task, true)
  emitSummary(task, true)

  const abortController = new AbortController()
  taskSession.activeRun = { taskId: task.id, abortController, cancelRequested: false }
  const indices = new Set(failed.map((frame) => frame.index))
  void (async () => {
    try {
      await analyzeFrames(task, modelConfig, abortController.signal, indices)
      await localizeFrames(task, modelConfig, abortController.signal, {
        onlyLocalize: false,
        onlyPendingRegions: true
      })
      await finishTask(task)
    } catch (error) {
      const cancelled = abortController.signal.aborted && (taskSession.activeRun?.cancelRequested ?? false)
      const message = error instanceof Error ? error.message : String(error)
      if (cancelled) {
        task.status = 'cancelled'
        task.phaseMessage = '已取消'
        markUnresolvedFailed(task, '任务已取消')
      } else {
        task.status = 'failed'
        task.phaseMessage = '任务失败'
        task.errorMessage = message
        markUnresolvedFailed(task, message)
      }
      await flushSave(task)
      emitSummary(task, true)
    } finally {
      if (taskSession.activeRun?.taskId === task.id) taskSession.activeRun = null
    }
  })()
  return buildSummary(task)
}

export function cancelActiveTask(taskId: string): boolean {
  if (!taskSession.activeRun || taskSession.activeRun.taskId !== taskId) return false
  taskSession.activeRun.cancelRequested = true
  taskSession.activeRun.abortController.abort()
  return true
}

export function deleteTask(taskId: string): void {
  validateTaskId(taskId)
  if (taskSession.activeRun?.taskId === taskId) throw new Error('任务正在处理')
  deleteStoredTask(taskId)
}

export function shutdownTaskManager(): void {
  if (taskSession.activeRun) {
    taskSession.activeRun.cancelRequested = true
    taskSession.activeRun.abortController.abort()
  }
}
