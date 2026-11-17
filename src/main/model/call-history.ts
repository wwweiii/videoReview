import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ModelCallTrace, ModelCallTracePage, ModelCallTraceRecord, ModelCallTraceSummary } from '@shared/types'
import { getDataDir, isTaskId } from '../paths'
import { logger } from '../logger'
import { compactRequestBody } from './trace'

const PAGE_SIZE = 30
const ID_PATTERN = /^\d{13}-[a-f0-9]{64}$/
const directory = (): string => path.join(getDataDir(), 'model-calls')
let migration: Promise<void> | undefined

function recordPath(id: string, summary = false): string {
  if (!ID_PATTERN.test(id)) throw new Error('调用轨迹编号无效')
  return path.join(directory(), `${id}${summary ? '.summary' : ''}.json`)
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value), 'utf8')
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

function modelFromTrace(trace: ModelCallTrace): string {
  try {
    const body = JSON.parse(trace.requestBody) as { model?: unknown }
    return typeof body.model === 'string' ? body.model : ''
  } catch { return '' }
}

async function persistTrace(trace: ModelCallTrace, taskId: string | null, model?: string): Promise<void> {
  const compact = { ...trace, requestBody: compactRequestBody(trace.requestBody) }
  // 同一请求在分组帧中可能被多次引用，导入时按内容去重。
  const hash = crypto.createHash('sha256').update(JSON.stringify([taskId, compact])).digest('hex')
  const timestamp = Math.max(0, Date.parse(trace.startedAt) || 0).toString().padStart(13, '0')
  const id = `${timestamp}-${hash}`
  try { await fs.access(recordPath(id, true)); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const record: ModelCallTraceRecord = { ...compact, id, taskId, model: modelFromTrace(trace) || model || '' }
  const { requestBody: _request, responseBody: _response, ...summary } = record
  await fs.mkdir(directory(), { recursive: true })
  await writeAtomic(recordPath(id), record)
  // 摘要最后提交，列表不会读到尚未写完的正文。
  await writeAtomic(recordPath(id, true), summary)
}

/** 开发者诊断写入失败不改变模型调用结果。 */
export async function recordModelCallTrace(trace: ModelCallTrace, taskId: string | null, model: string): Promise<void> {
  try { await persistTrace(trace, taskId, model) }
  catch (error) { logger.warn('保存调用轨迹失败', error) }
}

async function entries(dir: string) {
  try { return await fs.readdir(dir, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function isTrace(value: unknown): value is ModelCallTrace {
  if (!value || typeof value !== 'object') return false
  const trace = value as Partial<ModelCallTrace>
  return typeof trace.startedAt === 'string' && typeof trace.requestBody === 'string' &&
    typeof trace.responseBody === 'string' && typeof trace.operation === 'string'
}

/** 首次打开统一列表时导入旧任务记录；完成标记持久化，后续启动无需重扫。 */
async function migrateTaskTraces(): Promise<void> {
  const marker = path.join(directory(), 'legacy-import.json')
  try { if (JSON.parse(await fs.readFile(marker, 'utf8')) === 1) return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('读取轨迹导入标记失败', error)
  }
  let complete = true
  for (const task of await entries(path.join(getDataDir(), 'tasks'))) {
    if (!task.isDirectory() || !isTaskId(task.name)) continue
    const taskDir = path.join(getDataDir(), 'tasks', task.name)
    try {
      const calls = (await entries(path.join(taskDir, 'calls'))).filter((file) => /^[a-f0-9]{64}\.json$/.test(file.name))
      for (const file of calls) {
        const trace: unknown = JSON.parse(await fs.readFile(path.join(taskDir, 'calls', file.name), 'utf8'))
        if (isTrace(trace)) await persistTrace(trace, task.name)
      }
      // 旧版任务还可能把轨迹内嵌在帧或行为片段中。
      const record = JSON.parse(await fs.readFile(path.join(taskDir, 'task.json'), 'utf8')) as {
        schemaVersion?: number; frames?: Array<{ callTraces?: unknown[] }>; behaviorWindows?: Array<{ callTraces?: unknown[] }>
      }
      if (record.schemaVersion !== 2) {
        for (const frame of [...(record.frames ?? []), ...(record.behaviorWindows ?? [])]) {
          for (const trace of frame.callTraces ?? []) if (isTrace(trace)) await persistTrace(trace, task.name)
        }
      }
    } catch (error) { complete = false; logger.warn('导入旧任务调用轨迹失败', { taskId: task.name, error: String(error) }) }
  }
  if (complete) {
    await fs.mkdir(directory(), { recursive: true })
    await writeAtomic(marker, 1)
  }
}

export async function listModelCallTraces(before?: string): Promise<ModelCallTracePage> {
  if (before !== undefined && !ID_PATTERN.test(before)) throw new Error('调用轨迹分页参数无效')
  migration ??= migrateTaskTraces().catch((error) => { migration = undefined; throw error })
  await migration
  const ids = (await entries(directory())).map((file) => file.name.replace(/\.summary\.json$/, ''))
    .filter((id) => ID_PATTERN.test(id)).sort().reverse()
  const page = ids.filter((id) => !before || id < before).slice(0, PAGE_SIZE + 1)
  const selected = page.slice(0, PAGE_SIZE)
  const items = await Promise.all(selected.map(async (id) =>
    JSON.parse(await fs.readFile(recordPath(id, true), 'utf8')) as ModelCallTraceSummary))
  return { items, total: ids.length, nextBefore: page.length > PAGE_SIZE ? selected.at(-1)! : null }
}

export async function getModelCallTrace(id: string): Promise<ModelCallTraceRecord> {
  return JSON.parse(await fs.readFile(recordPath(id), 'utf8')) as ModelCallTraceRecord
}
