import { BrowserWindow } from 'electron'
import type { BehaviorWindowRecord, FrameRecord, TaskEvent, TaskRecord } from '@shared/types'
import { buildSummary } from './summary'

const lastSummaryEmit = new Map<string, number>()

function broadcast(event: TaskEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('task:event', event)
  }
}

export function emitSummary(task: TaskRecord, force = false): void {
  const now = Date.now()
  if (!force && now - (lastSummaryEmit.get(task.id) ?? 0) < 250) return
  lastSummaryEmit.set(task.id, now)
  broadcast({ kind: 'summary', summary: buildSummary(task) })
}

export function emitFrame(task: TaskRecord, frame: FrameRecord): void {
  broadcast({ kind: 'frame', summary: buildSummary(task), frame: { ...frame } })
}

export function emitBehaviorWindow(task: TaskRecord, window: BehaviorWindowRecord): void {
  broadcast({ kind: 'behavior-window', summary: buildSummary(task), window: { ...window } })
}

/** 任务结束/重新开始时清掉摘要节流时间戳 */
export function clearSummaryThrottle(taskId: string): void {
  lastSummaryEmit.delete(taskId)
}
