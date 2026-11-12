import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { formatTimeMs } from '@shared/format'
import { behaviorTime } from '@shared/behavior'
import { REGION_STATUS_EXPORT_LABELS, VERDICT_EXPORT_LABELS } from '@shared/task'
import type { FrameRecord, RegionStatus, Verdict } from '@shared/types'
import { readTask, validateTaskId } from './store'

export async function exportTaskCsv(
  taskId: string,
  parentWindow?: BrowserWindow
): Promise<{ saved: boolean; path?: string }> {
  validateTaskId(taskId)
  const task = readTask(taskId)
  if (!task) throw new Error('任务不存在')
  const name = task.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  const options: Electron.SaveDialogOptions = {
    title: '导出结果',
    defaultPath: path.join(process.env.USERPROFILE || process.cwd(), `${name}_${task.kind === 'behavior' ? '行为识别结果' : '结果'}.csv`),
    filters: [{ name: '表格文件', extensions: ['csv'] }]
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { saved: false }

  if (task.kind === 'behavior') {
    const rows: unknown[][] = [['序号', '开始时间', '结束时间', '判定', '行为类别', '行为说明', '证据', '置信度', '采样帧数', '错误']]
    for (const window of task.behaviorWindows ?? []) {
      rows.push([window.index + 1, behaviorTime(window.timestampMs), behaviorTime(window.endTimestampMs),
        verdictText(window.verdict), window.categories.join('、'), window.description, window.evidence,
        window.confidence === null ? '' : window.confidence.toFixed(3), window.samples.length, window.error])
    }
    fs.writeFileSync(result.filePath, `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`, 'utf8')
    return { saved: true, path: result.filePath }
  }

  const header = [
    '序号',
    '时间',
    '判定',
    '异常类型',
    '异常说明',
    '证据',
    '置信度',
    '定位状态',
    '检测框(归一化)',
    '帧文件',
    '错误'
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const frame of task.frames) {
    lines.push(
      [
        frame.index + 1,
        formatTimeMs(frame.timestampMs),
        verdictText(frame.verdict),
        frame.categories.join('、'),
        frame.description,
        frame.evidence,
        frame.confidence === null ? '' : frame.confidence.toFixed(3),
        regionStatusText(frame.regionStatus),
        formatRegions(frame),
        frame.fileName,
        frame.error
      ]
        .map(csvCell)
        .join(',')
    )
  }
  fs.writeFileSync(result.filePath, `﻿${lines.join('\r\n')}`, 'utf8')
  return { saved: true, path: result.filePath }
}

function verdictText(verdict: Verdict): string {
  return VERDICT_EXPORT_LABELS[verdict] ?? '待分析'
}

function regionStatusText(status: RegionStatus): string {
  return REGION_STATUS_EXPORT_LABELS[status] ?? '未定位'
}

function formatRegions(frame: FrameRecord): string {
  if (frame.regions.length === 0) return ''
  return frame.regions
    .map(
      (region) =>
        `${region.category}:[${region.box.map((value) => value.toFixed(4)).join(',')}]`
    )
    .join('; ')
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}
