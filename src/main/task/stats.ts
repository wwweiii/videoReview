import { taskResults } from '@shared/behavior'
import { countFrameStats, type FrameStats } from '@shared/task'
import type { FrameRecord, TaskRecord } from '@shared/types'

interface Contribution { stats: FrameStats; pendingRegion: number }
interface State {
  source: FrameRecord[]
  length: number
  stats: FrameStats
  pendingRegions: number
  entries: Map<number, Contribution>
}
const states = new WeakMap<TaskRecord, State>()
const keys: Array<keyof FrameStats> = ['total', 'processed', 'abnormal', 'review', 'normal', 'failed', 'pending', 'located']

function contribution(frame: FrameRecord): Contribution {
  return { stats: countFrameStats([frame]), pendingRegion: Number(frame.regionStatus === 'pending') }
}

function stateFor(task: TaskRecord): State {
  const frames = taskResults(task)
  const existing = states.get(task)
  if (existing?.source === frames && existing.length === frames.length) return existing
  const state: State = { source: frames, length: frames.length, stats: countFrameStats(frames), pendingRegions: 0, entries: new Map() }
  for (const frame of frames) {
    const entry = contribution(frame)
    state.entries.set(frame.index, entry)
    state.pendingRegions += entry.pendingRegion
  }
  states.set(task, state)
  return state
}

export function updateResultStats(task: TaskRecord, frame: FrameRecord): void {
  const state = stateFor(task)
  const before = state.entries.get(frame.index)
  const after = contribution(frame)
  if (!before) { states.delete(task); return }
  for (const key of keys) state.stats[key] += after.stats[key] - before.stats[key]
  state.pendingRegions += after.pendingRegion - before.pendingRegion
  state.entries.set(frame.index, after)
}

export function invalidateTaskStats(task: TaskRecord): void { states.delete(task) }
export function getTaskStats(task: TaskRecord): FrameStats { return { ...stateFor(task).stats } }
export function hasUnfinishedResults(task: TaskRecord): boolean {
  const state = stateFor(task)
  return state.stats.pending > 0 || state.pendingRegions > 0
}
