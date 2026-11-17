import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { frameView } from '@shared/task-view'
import type { FrameDiagnostics, FrameRecord, ModelCallTrace, TaskRecord } from '@shared/types'
import { getTaskDir } from '../paths'
import { compactRequestBody } from '../model/trace'

interface StoredDetail { rawResponse: string; regionRaw: string; traceRefs: string[] }
const emptyDetail = (): StoredDetail => ({ rawResponse: '', regionRaw: '', traceRefs: [] })

function artifactPath(taskId: string, kind: 'details' | 'calls', hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('诊断记录引用无效')
  return path.join(getTaskDir(taskId), kind, `${hash}.json`)
}

async function readDetail(taskId: string, frame: FrameRecord): Promise<StoredDetail> {
  if (!frame.detailRef) return emptyDetail()
  return JSON.parse(await fs.readFile(artifactPath(taskId, 'details', frame.detailRef), 'utf8')) as StoredDetail
}

export async function readFrameDiagnostics(taskId: string, frame: FrameRecord): Promise<FrameDiagnostics> {
  // 异步读取期间保存可能清空内存正文；固定同一版本的引用和待写数据。
  const snapshot = { ...frame, callTraces: [...frame.callTraces] }
  const saved = await readDetail(taskId, snapshot)
  const traces: ModelCallTrace[] = []
  for (const hash of saved.traceRefs) {
    traces.push(JSON.parse(await fs.readFile(artifactPath(taskId, 'calls', hash), 'utf8')) as ModelCallTrace)
  }
  const unique = new Map<string, ModelCallTrace>()
  for (const trace of [...traces, ...snapshot.callTraces]) {
    const compact = { ...trace, requestBody: compactRequestBody(trace.requestBody) }
    unique.set(JSON.stringify(compact), compact)
  }
  return { rawResponse: snapshot.rawResponse || saved.rawResponse, regionRaw: snapshot.regionRaw || saved.regionRaw, callTraces: [...unique.values()] }
}

/** 不可变诊断文件先写，清单最后替换；中途失败不会破坏旧清单引用。 */
export async function prepareTaskSnapshot(task: TaskRecord, overrides?: Partial<TaskRecord>): Promise<{
  record: TaskRecord
  commit: () => void
}> {
  const capture = <T extends FrameRecord>(frame: T): T => ({ ...frame, callTraces: [...frame.callTraces] })
  const frames = task.frames.map(capture)
  const windows = task.behaviorWindows?.map(capture)
  const record = { ...task, ...overrides, schemaVersion: 2, saveError: '', frames, ...(windows ? { behaviorWindows: windows } : {}) }
  delete record.stats
  const written = new Set<string>()
  async function artifact(kind: 'details' | 'calls', value: unknown): Promise<string> {
    const json = JSON.stringify(value)
    const hash = crypto.createHash('sha256').update(json).digest('hex')
    if (written.has(hash)) return hash
    const target = artifactPath(task.id, kind, hash)
    try { await fs.access(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      try { await fs.writeFile(temporary, json, 'utf8'); await fs.rename(temporary, target) }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
    }
    written.add(hash)
    return hash
  }
  const commits: Array<() => void> = []
  async function prepare<T extends FrameRecord>(captured: T[], live: T[]): Promise<void> {
    for (const [index, snapshot] of captured.entries()) {
      if (!snapshot.rawResponse && !snapshot.regionRaw && !snapshot.callTraces.length) continue
      const old = await readDetail(task.id, snapshot)
      const refs = new Set(old.traceRefs)
      for (const trace of snapshot.callTraces) refs.add(await artifact('calls', { ...trace, requestBody: compactRequestBody(trace.requestBody) }))
      const detailRef = await artifact('details', {
        rawResponse: snapshot.rawResponse || old.rawResponse,
        regionRaw: snapshot.regionRaw || old.regionRaw,
        traceRefs: [...refs]
      })
      captured[index] = { ...frameView(snapshot), detailRef }
      const original = live[index]
      commits.push(() => {
        if (original.rawResponse === snapshot.rawResponse && original.regionRaw === snapshot.regionRaw &&
            original.detailRef === snapshot.detailRef && original.callTraces.length === snapshot.callTraces.length &&
            original.callTraces.every((trace, i) => trace === snapshot.callTraces[i])) {
          original.detailRef = detailRef
          original.rawResponse = ''
          original.regionRaw = ''
          original.callTraces = []
        }
      })
    }
  }
  await prepare(frames, task.frames)
  if (windows && task.behaviorWindows) await prepare(windows, task.behaviorWindows)
  return { record, commit: () => { task.schemaVersion = 2; commits.forEach((commit) => commit()) } }
}
