import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROHIBITED_ITEMS } from '@shared/items'
import type { FrameRecord, TaskRecord } from '@shared/types'
import { logger } from '../logger'
import { getTaskDir, getTaskFilePath, getTasksDir, isTaskId } from '../paths'

const taskCache = new Map<string, TaskRecord>()
const saveTimers = new Map<string, NodeJS.Timeout>()
const saveChains = new Map<string, Promise<void>>()

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
    regionRaw: ''
  }
}

function normalizeTask(raw: TaskRecord): TaskRecord {
  const rawConfig = (raw.config ?? {}) as Partial<TaskRecord['config']>
  return {
    ...raw,
    kind: raw.kind === 'behavior' ? 'behavior' : 'items',
    progress: Number(raw.progress) || 0,
    phaseMessage: raw.phaseMessage || '',
    errorMessage: raw.errorMessage || '',
    regionProfile: raw.regionProfile ?? null,
    config: {
      ...(raw.config as TaskRecord['config']),
      prohibitedItems:
        Array.isArray(rawConfig.prohibitedItems) && rawConfig.prohibitedItems.length > 0
          ? rawConfig.prohibitedItems
          : [...DEFAULT_PROHIBITED_ITEMS],
      customProhibitedItems: Array.isArray(rawConfig.customProhibitedItems)
        ? rawConfig.customProhibitedItems
        : [],
      behaviorItems: Array.isArray(rawConfig.behaviorItems) ? rawConfig.behaviorItems : []
    },
    frames: (raw.frames || []).map((frame) => ({
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
      regionRaw: frame.regionRaw || ''
    }))
  }
}

export function validateTaskId(taskId: string): void {
  if (!isTaskId(taskId)) throw new Error('任务不存在')
}

export function readTask(taskId: string): TaskRecord | null {
  validateTaskId(taskId)
  const cached = taskCache.get(taskId)
  if (cached) return cached
  const filePath = getTaskFilePath(taskId)
  if (!fs.existsSync(filePath)) return null
  try {
    const task = normalizeTask(JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskRecord)
    taskCache.set(task.id, task)
    return task
  } catch (error) {
    logger.error('读取任务失败', error)
    return null
  }
}

function writeTaskNow(task: TaskRecord): Promise<void> {
  const filePath = getTaskFilePath(task.id)
  const json = JSON.stringify(task)
  const previous = saveChains.get(task.id) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${Date.now()}.tmp`
      await fs.promises.writeFile(temporary, json, 'utf8')
      await fs.promises.rename(temporary, filePath)
    })
    .catch((error) => logger.error('保存任务失败', error))
  saveChains.set(task.id, next)
  return next
}

export function scheduleSave(task: TaskRecord, immediate = false): void {
  const existing = saveTimers.get(task.id)
  if (existing) clearTimeout(existing)
  saveTimers.delete(task.id)
  task.updatedAt = new Date().toISOString()
  if (immediate) {
    void writeTaskNow(task)
    return
  }
  const timer = setTimeout(() => {
    saveTimers.delete(task.id)
    void writeTaskNow(task)
  }, 700)
  saveTimers.set(task.id, timer)
}

export async function flushSave(task: TaskRecord): Promise<void> {
  const timer = saveTimers.get(task.id)
  if (timer) {
    clearTimeout(timer)
    saveTimers.delete(task.id)
  }
  task.updatedAt = new Date().toISOString()
  await writeTaskNow(task)
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
export function deleteStoredTask(taskId: string): void {
  fs.rmSync(getTaskDir(taskId), { recursive: true, force: true })
  taskCache.delete(taskId)
  const timer = saveTimers.get(taskId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(taskId)
}

/** 新任务建好后立刻放入缓存（跨模块只暴露最小写入口） */
export function rememberTask(task: TaskRecord): void {
  taskCache.set(task.id, task)
}
