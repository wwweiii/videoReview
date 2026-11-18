import { dialog, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { behaviorTime } from '@shared/behavior'
import { verdictExportText } from '@shared/task'
import type { BehaviorWindowRecord, ExportResult } from '@shared/types'
import { writeItemResults } from './export-items'
import { readTask } from './store'

export async function exportTaskResults(taskId: string, parentWindow?: BrowserWindow): Promise<ExportResult> {
  const task = readTask(taskId)
  if (!task) throw new Error('任务不存在')
  const name = task.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  const behavior = task.kind === 'behavior'
  const fileName = behavior ? name + '_行为识别结果.csv' : name + '_结果.xlsx'
  const options: Electron.SaveDialogOptions = {
    title: '导出结果',
    defaultPath: path.join(process.env.USERPROFILE || process.cwd(), fileName),
    filters: behavior
      ? [{ name: '表格文件', extensions: ['csv'] }]
      : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { saved: false }

  if (behavior) await writeBehaviorCsv(result.filePath, task.behaviorWindows ?? [])
  else await writeItemResults(result.filePath, task.id, task.frames)
  return { saved: true, path: result.filePath }
}

async function writeBehaviorCsv(filePath: string, windows: BehaviorWindowRecord[]): Promise<void> {
  const rows: unknown[][] = [['序号', '开始时间', '结束时间', '判定', '行为类别', '行为说明', '证据', '置信度', '采样帧数', '错误']]
  for (const window of windows) {
    rows.push([window.index + 1, behaviorTime(window.timestampMs), behaviorTime(window.endTimestampMs),
      verdictExportText(window.verdict), window.categories.join('、'), window.description, window.evidence,
      window.confidence === null ? '' : window.confidence.toFixed(3), window.samples.length, window.error])
  }
  await fs.writeFile(filePath, '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'utf8')
}

function csvCell(value: unknown): string {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"'
}
