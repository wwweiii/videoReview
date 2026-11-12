import {
  DEFAULT_BEHAVIOR_FPS,
  DEFAULT_BEHAVIOR_STRIDE_SEC,
  DEFAULT_BEHAVIOR_WINDOW_SEC,
  MAX_BEHAVIOR_FPS,
  MAX_BEHAVIOR_ITEMS,
  MAX_BEHAVIOR_LABEL_LENGTH,
  MAX_BEHAVIOR_STRIDE_SEC,
  MAX_BEHAVIOR_WINDOW_SEC,
  MIN_BEHAVIOR_FPS,
  MIN_BEHAVIOR_STRIDE_SEC,
  MIN_BEHAVIOR_WINDOW_SEC
} from './defaults'
import { clampNumber } from './format'
import type { BehaviorAnalysisConfig, BehaviorItem, BehaviorWindowRecord, FrameRecord, TaskRecord } from './types'

/** 行为识别采样参数：窗口时长、推进步长、每秒采样帧数 */
export interface BehaviorSampling {
  windowSec: number
  strideSec: number
  fps: number
}

export interface BehaviorSamplingInput {
  windowSec?: unknown
  strideSec?: unknown
  fps?: unknown
}

export const BEHAVIOR_CONFIG: Readonly<BehaviorAnalysisConfig> = Object.freeze({
  windowSec: DEFAULT_BEHAVIOR_WINDOW_SEC,
  strideSec: DEFAULT_BEHAVIOR_STRIDE_SEC,
  fps: DEFAULT_BEHAVIOR_FPS,
  behaviors: []
})

/** 读取有限数值；null/undefined/空串/布尔/NaN 视为未配置。 */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 窗口/推进按 0.5 秒粒度取整后 clamp 到允许范围；未配置时回退默认值。 */
function normalizeSeconds(value: unknown, fallback: number, min: number, max: number): number {
  const base = readFiniteNumber(value) ?? fallback
  return clampNumber(Math.round(base * 2) / 2, min, max)
}

/** 行为识别采样参数清洗：设置持久化与设置页表单保存共用。 */
export function normalizeBehaviorSampling(input: BehaviorSamplingInput = {}): BehaviorSampling {
  return {
    windowSec: normalizeSeconds(
      input.windowSec,
      DEFAULT_BEHAVIOR_WINDOW_SEC,
      MIN_BEHAVIOR_WINDOW_SEC,
      MAX_BEHAVIOR_WINDOW_SEC
    ),
    strideSec: normalizeSeconds(
      input.strideSec,
      DEFAULT_BEHAVIOR_STRIDE_SEC,
      MIN_BEHAVIOR_STRIDE_SEC,
      MAX_BEHAVIOR_STRIDE_SEC
    ),
    fps: Math.round(
      clampNumber(
        readFiniteNumber(input.fps) ?? DEFAULT_BEHAVIOR_FPS,
        MIN_BEHAVIOR_FPS,
        MAX_BEHAVIOR_FPS
      )
    )
  }
}

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

/**
 * 按「窗口/推进」把连续采样画面切分为待判定片段。
 *
 * 语义：以 strideSec 为步长生成窗口起点，每个窗口覆盖 [start, start + windowSec)。
 * windowSec > strideSec 时相邻窗口重叠（同一画面会出现在多个片段里），
 * windowSec < strideSec 时窗口之间留有空隙（部分画面不参与判定）。
 * 默认 2 秒窗口 + 2 秒推进即旧版互不重叠的切分方式。
 */
export function groupBehaviorSamples(
  samples: Array<{ timestampMs: number; fileName: string }>,
  durationMs: number,
  makeFrame: (index: number, timestampMs: number, fileName: string) => FrameRecord,
  config: BehaviorAnalysisConfig = BEHAVIOR_CONFIG
): BehaviorWindowRecord[] {
  const windows: BehaviorWindowRecord[] = []
  const windowMs = Math.max(1, Math.round(config.windowSec * 1000))
  const strideMs = Math.max(1, Math.round(config.strideSec * 1000))
  const ordered = samples
    .filter((sample) => sample.timestampMs >= 0 && sample.timestampMs < durationMs)
    .sort((a, b) => a.timestampMs - b.timestampMs)
  let cursor = 0
  for (let start = 0, index = 0; start < durationMs; start += strideMs, index += 1) {
    const end = Math.min(durationMs, start + windowMs)
    // 窗口起点单调递增，游标只需跳过已经落在当前窗口之前的采样；重叠窗口会复用中间采样。
    while (cursor < ordered.length && ordered[cursor].timestampMs < start) cursor += 1
    const frames: Array<{ timestampMs: number; fileName: string }> = []
    for (let scan = cursor; scan < ordered.length && ordered[scan].timestampMs < end; scan += 1) {
      frames.push(ordered[scan])
    }
    windows.push({
      ...makeFrame(index, start, frames[0]?.fileName ?? ''),
      endTimestampMs: end,
      samples: frames
    })
  }
  return windows
}
