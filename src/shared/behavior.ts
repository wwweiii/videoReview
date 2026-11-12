import {
  MAX_BEHAVIOR_ITEMS,
  MAX_BEHAVIOR_LABEL_LENGTH
} from './defaults'
import type { BehaviorAnalysisConfig, BehaviorItem, BehaviorWindowRecord, FrameRecord, TaskRecord } from './types'

export const BEHAVIOR_CONFIG: Readonly<BehaviorAnalysisConfig> = Object.freeze({
  windowSec: 2,
  strideSec: 2,
  fps: 4,
  behaviors: []
})

function makeBehaviorItemId(): string {
  return `behavior:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function normalizeBehaviorLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 设置持久化和渲染表单共用的行为项清洗。行为没有内置项，全部来自用户设置。 */
export function normalizeBehaviorItems(input: unknown): BehaviorItem[] {
  if (!Array.isArray(input)) return []
  const result: BehaviorItem[] = []
  const labels = new Set<string>()
  const ids = new Set<string>()
  for (const raw of input) {
    const record = raw && typeof raw === 'object' ? raw as { id?: unknown; label?: unknown } : {}
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const normalized = normalizeBehaviorLabel(label)
    if (!label || label.length > MAX_BEHAVIOR_LABEL_LENGTH || !normalized || labels.has(normalized)) continue
    let id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!/^behavior:[a-z0-9_-]+$/i.test(id) || ids.has(id)) id = makeBehaviorItemId()
    labels.add(normalized)
    ids.add(id)
    result.push({ id, label })
    if (result.length >= MAX_BEHAVIOR_ITEMS) break
  }
  return result
}

export function taskResults(task: TaskRecord): FrameRecord[] {
  return task.kind === 'behavior' ? task.behaviorWindows ?? [] : task.frames
}

export function behaviorTime(timestampMs: number): string {
  const total = Math.max(0, timestampMs) / 1000
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = (total % 60).toFixed(2).padStart(5, '0')
  return `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${seconds}`
}

export function groupBehaviorSamples(
  samples: Array<{ timestampMs: number; fileName: string }>,
  durationMs: number,
  makeFrame: (index: number, timestampMs: number, fileName: string) => FrameRecord,
  config: BehaviorAnalysisConfig = BEHAVIOR_CONFIG
): BehaviorWindowRecord[] {
  const windows: BehaviorWindowRecord[] = []
  const buckets = new Map<number, typeof samples>()
  // 首版固定无重叠窗口，每个采样只属于一个窗口。
  for (const sample of samples) {
    if (sample.timestampMs < 0 || sample.timestampMs >= durationMs) continue
    const index = Math.floor(sample.timestampMs / (config.strideSec * 1000))
    const bucket = buckets.get(index) ?? []
    bucket.push(sample)
    buckets.set(index, bucket)
  }
  for (let start = 0, index = 0; start < durationMs; start += config.strideSec * 1000, index += 1) {
    const frames = buckets.get(index) ?? []
    windows.push({
      ...makeFrame(index, start, frames[0]?.fileName ?? ''),
      endTimestampMs: Math.min(durationMs, start + config.windowSec * 1000),
      samples: frames
    })
  }
  return windows
}
