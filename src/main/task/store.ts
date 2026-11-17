import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROHIBITED_ITEMS } from '@shared/items'
import type { FrameRecord, TaskRecord, TaskSummary } from '@shared/types'
import { isTaskActive } from '@shared/task'
import { logger } from '../logger'
import { getTaskDir, getTaskFilePath, getTasksDir, isTaskId } from '../paths'
import { emitSummary } from './event'
import { prepareTaskSnapshot } from './diagnostics'
import { buildSummary } from './summary'
import { clearImageCache } from '../media/images'

const taskCache = new Map<string, TaskRecord>()
const saveTimers = new Map<string, NodeJS.Timeout>()
const saveChains = new Map<string, Promise<void>>()
const dirtySince = new Map<string, number>()
const dirtyTasks = new Set<TaskRecord>()
const cacheSizes = new Map<string, number>()
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: TaskSummary }>()
const MAX_CACHED_TASKS = 8
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const SAVE_DELAY_MS = 700
const MAX_SAVE_WAIT_MS = 2000

export function newFrame(index: number, timestampMs: number, fileName: string): FrameRecord {
  return {
    index,
    timestampMs,
    fileName,
    status: 'pending',
    verdict: 'pending',
    riskLevel: 'none',
    categories: [],
    description: '',
    evidence: '',
    confidence: null,
    needHumanReview: false,
    error: '',
    rawResponse: '',
    analyzedAt: null,
    model: '',
    regions: [],
    regionStatus: 'none',
    regionLevel: 'L0',
    regionModel: '',
    regionError: '',
    regionRaw: '',
    callTraces: []
  }
}

function normalizeFrame<T extends FrameRecord>(frame: T): T {
  return {
    ...newFrame(frame.index, frame.timestampMs, frame.fileName),
    ...frame,
    riskLevel: frame.riskLevel || 'none',
    categories: Array.isArray(frame.categories) ? frame.categories : [],
    description: frame.description || '',
    evidence: frame.evidence || '',
    error: frame.error || '',
    rawResponse: frame.rawResponse || '',
    model: frame.model || '',
    regions: Array.isArray(frame.regions) ? frame.regions : [],
    regionStatus: frame.regionStatus || 'none',
    regionLevel: frame.regionLevel || 'L0',
    regionModel: frame.regionModel || '',
    regionError: frame.regionError || '',
    regionRaw: frame.regionRaw || '',
    callTraces: Array.isArray(frame.callTraces) ? frame.callTraces : []
  }
}

function normalizeTask(raw: TaskRecord): TaskRecord {
  const rawConfig = (raw.config ?? {}) as Partial<TaskRecord['config']>
  return {
    ...raw,
    saveError: '',
    kind: raw.kind === 'behavior' ? 'behavior' : 'items',
    progress: Number(raw.progress) || 0,
    phaseMessage: raw.phaseMessage || '',
    errorMessage: raw.errorMessage || '',
    regionProfile: raw.regionProfile ?? null,
    config: {
      ...(raw.config as TaskRecord['config']),
      prohibitedItems:
        Array.isArray(rawConfig.prohibitedItems)
          ? rawConfig.prohibitedItems
          : [...DEFAULT_PROHIBITED_ITEMS],
      customProhibitedItems: Array.isArray(rawConfig.customProhibitedItems)
        ? rawConfig.customProhibitedItems
        : [],
      behaviorItems: Array.isArray(rawConfig.behaviorItems) ? rawConfig.behaviorItems : []
    },
    frames: (raw.frames || []).map(normalizeFrame),
    ...(raw.kind === 'behavior'
      ? { behaviorWindows: (raw.behaviorWindows || []).map(normalizeFrame) }
      : {})
  }
}

export function validateTaskId(taskId: string): void {
  if (!isTaskId(taskId)) throw new Error('任务不存在')
}

export function readTask(taskId: string): TaskRecord | null {
  validateTaskId(taskId)
  const cached = taskCache.get(taskId)
  if (cached) { taskCache.delete(taskId); taskCache.set(taskId, cached); return cached }
  const filePath = getTaskFilePath(taskId)
  if (!fs.existsSync(filePath)) return null
  try {
    const json = fs.readFileSync(filePath, 'utf8')
    const task = normalizeTask(JSON.parse(json) as TaskRecord)
    taskCache.set(task.id, task)
    cacheSizes.set(task.id, Buffer.byteLength(json))
    trimTaskCache()
    return task
  } catch (error) {
    logger.error('读取任务失败', error)
    return null
  }
}

function writeTaskNow(task: TaskRecord, snapshot?: Partial<TaskRecord>): Promise<void> {
  const filePath = getTaskFilePath(task.id)
  const previous = saveChains.get(task.id) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      // 在串行队列执行时获取最新状态；序列化失败也走统一错误路径。
      const prepared = await prepareTaskSnapshot(task, snapshot)
      const json = JSON.stringify(prepared.record)
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${Date.now()}.tmp`
      try {
        await fs.promises.writeFile(temporary, json, 'utf8')
        await fs.promises.rename(temporary, filePath)
        prepared.commit()
        cacheSizes.set(task.id, Buffer.byteLength(json))
        const summary = buildSummary(prepared.record)
        if (snapshot?.status === 'completed' || snapshot?.status === 'completed_with_errors') summary.progress = 100
        const stat = await fs.promises.stat(filePath)
        const index = { mtimeMs: stat.mtimeMs, size: stat.size, summary }
        summaryCache.set(task.id, index)
        const summaryFile = path.join(path.dirname(filePath), 'summary.json')
        const summaryTemp = `${summaryFile}.${Date.now()}.tmp`
        try {
          await fs.promises.writeFile(summaryTemp, JSON.stringify(index), 'utf8')
          await fs.promises.rename(summaryTemp, summaryFile)
        } finally { await fs.promises.rm(summaryTemp, { force: true }).catch(() => undefined) }
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
      }
      const recovered = Boolean(task.saveError)
      task.saveError = ''
      if (recovered) emitSummary(task, true)
    })
    .catch((error) => {
      logger.error('保存任务失败', error)
      task.saveError = `保存结果失败：${error instanceof Error ? error.message : String(error)}`
      emitSummary(task, true)
      throw new Error(task.saveError)
    })
  saveChains.set(task.id, next)
  void next.then(() => {
    if (saveChains.get(task.id) === next) {
      saveChains.delete(task.id)
      if (!saveTimers.has(task.id)) dirtyTasks.delete(task)
      trimTaskCache()
    }
  }, () => {
    if (saveChains.get(task.id) === next) saveChains.delete(task.id)
  })
  return next
}

export function scheduleSave(task: TaskRecord, immediate = false): void {
  rememberTask(task)
  const existing = saveTimers.get(task.id)
  if (existing) clearTimeout(existing)
  saveTimers.delete(task.id)
  dirtyTasks.add(task)
  task.updatedAt = new Date().toISOString()
  if (immediate) {
    dirtySince.delete(task.id)
    void writeTaskNow(task).catch(() => undefined)
    return
  }
  const firstDirty = dirtySince.get(task.id) ?? Date.now()
  dirtySince.set(task.id, firstDirty)
  const timer = setTimeout(() => {
    saveTimers.delete(task.id)
    dirtySince.delete(task.id)
    void writeTaskNow(task).catch(() => undefined)
  }, Math.min(SAVE_DELAY_MS, Math.max(0, MAX_SAVE_WAIT_MS - (Date.now() - firstDirty))))
  saveTimers.set(task.id, timer)
}

export async function flushSave(task: TaskRecord, snapshot?: Partial<TaskRecord>): Promise<void> {
  rememberTask(task)
  const timer = saveTimers.get(task.id)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(task.id)
  }
  dirtySince.delete(task.id)
  dirtyTasks.add(task)
  task.updatedAt = new Date().toISOString()
  await writeTaskNow(task, snapshot)
}

export async function flushAllTasks(): Promise<void> {
  const results = await Promise.allSettled([...dirtyTasks].map((task) => flushSave(task)))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}

export function ensureTasksDirectory(): void {
  fs.mkdirSync(getTasksDir(), { recursive: true })
}

export function allTaskIds(): string[] {
  ensureTasksDirectory()
  return fs
    .readdirSync(getTasksDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isTaskId(entry.name))
    .map((entry) => entry.name)
}

/** 删除任务目录与内存缓存（调用方负责校验任务 id 与运行状态） */
export async function deleteStoredTask(taskId: string): Promise<void> {
  const timer = saveTimers.get(taskId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(taskId)
  dirtySince.delete(taskId)
  await saveChains.get(taskId)?.catch(() => undefined)
  await fs.promises.rm(getTaskDir(taskId), { recursive: true, force: true })
  for (const task of dirtyTasks) if (task.id === taskId) dirtyTasks.delete(task)
  taskCache.delete(taskId)
  cacheSizes.delete(taskId)
  summaryCache.delete(taskId)
  clearImageCache(getTaskDir(taskId))
}

/** 新任务建好后立刻放入缓存（跨模块只暴露最小写入口） */
export function rememberTask(task: TaskRecord): void {
  taskCache.set(task.id, task)
}

/** 只淘汰已结束且无待写入的任务；运行中对象保持唯一身份。 */
export function trimTaskCache(): void {
  let bytes = [...cacheSizes.values()].reduce((sum, size) => sum + size, 0)
  for (const [id, task] of taskCache) {
    if (taskCache.size <= MAX_CACHED_TASKS && bytes <= MAX_CACHE_BYTES) break
    if (isTaskActive(task.status) || dirtyTasks.has(task) || saveChains.has(id)) continue
    bytes -= cacheSizes.get(id) ?? 0
    cacheSizes.delete(id)
    taskCache.delete(id)
  }
}

export function taskCacheMetrics() {
  return { entries: taskCache.size, terminalEntries: [...taskCache.values()].filter((task) => !isTaskActive(task.status)).length, bytes: [...cacheSizes.values()].reduce((sum, size) => sum + size, 0) }
}

/** 有效摘要直接返回；旧格式或失效索引仅在首次读取时重建。 */
export function readTaskSummary(taskId: string): TaskSummary | null {
  validateTaskId(taskId)
  const live = taskCache.get(taskId)
  if (live) return buildSummary(live)
  const filePath = getTaskFilePath(taskId)
  try {
    const stat = fs.statSync(filePath)
    const summaryPath = path.join(path.dirname(filePath), 'summary.json')
    let index = summaryCache.get(taskId)
    if (!index) {
      try { index = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as NonNullable<typeof index> } catch { /* 首次建立索引 */ }
    }
    if (index?.mtimeMs === stat.mtimeMs && index.size === stat.size && index.summary?.id === taskId) {
      summaryCache.set(taskId, index)
      return index.summary
    }
    const task = readTask(taskId)
    if (!task) return null
    index = { mtimeMs: stat.mtimeMs, size: stat.size, summary: buildSummary(task) }
    summaryCache.set(taskId, index)
    // 摘要可重建，写入失败不影响读取原始任务。
    const temporary = `${summaryPath}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(index), 'utf8')
      fs.renameSync(temporary, summaryPath)
    } catch (error) { logger.warn('重建任务摘要失败', error) }
    finally { try { fs.rmSync(temporary, { force: true }) } catch { /* 下次重建 */ } }
    return index.summary
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('读取任务摘要失败', error)
    return null
  }
}
