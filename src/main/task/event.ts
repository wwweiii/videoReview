import { BrowserWindow } from 'electron'
import { frameView } from '@shared/task-view'
import type { BehaviorWindowRecord, FrameRecord, TaskEvent, TaskRecord } from '@shared/types'
import { buildSummary } from './summary'
import { updateResultStats } from './stats'

interface Pending {
  task: TaskRecord
  frames: Map<number, FrameRecord>
  windows: Map<number, BehaviorWindowRecord>
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<string, Pending>()
const BATCH_MS = 150

function broadcast(event: TaskEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('task:event', event)
  }
}

function flush(taskId: string): void {
  const entry = pending.get(taskId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(taskId)
  const summary = buildSummary(entry.task)
  if (entry.frames.size || entry.windows.size) {
    broadcast({ kind: 'results', summary, frames: [...entry.frames.values()].map(frameView), windows: [...entry.windows.values()].map(frameView) })
  } else broadcast({ kind: 'summary', summary })
}

function queue(task: TaskRecord): Pending {
  let entry = pending.get(task.id)
  if (!entry) {
    entry = { task, frames: new Map(), windows: new Map(), timer: setTimeout(() => flush(task.id), BATCH_MS) }
    pending.set(task.id, entry)
  }
  return entry
}

export function emitSummary(task: TaskRecord, force = false): void {
  if (!force) { queue(task); return }
  flush(task.id)
  broadcast({ kind: 'summary', summary: buildSummary(task) })
}

export function emitFrame(task: TaskRecord, frame: FrameRecord): void {
  updateResultStats(task, frame)
  queue(task).frames.set(frame.index, frame)
}

export function emitBehaviorWindow(task: TaskRecord, window: BehaviorWindowRecord): void {
  updateResultStats(task, window)
  queue(task).windows.set(window.index, window)
}

export function clearSummaryThrottle(taskId: string): void { flush(taskId) }
