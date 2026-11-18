import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  BootstrapData,
  DeleteTaskResult,
  FileDialogResult,
  ModelProbeResult,
  SaveSettingsInput,
  TestModelInput
} from '@shared/types'
import { getResolvedModelConfigForTesting } from './config/model-config'
import { getPublicSettings, isModelTracingEnabled, saveSettings } from './config/settings'
import { probeModelConfig } from './localization/probe'
import { getVideoThumbnail } from './media/ffmpeg'
import { testModelConnection } from './model/client'
import { getModelCallTrace, listModelCallTraces } from './model/call-history'
import { completeWindowClose } from './app/window'
import {
  cancelActiveTask,
  deleteTask,
  exportTaskResults,
  getTaskView,
  getFrameDiagnostics,
  listTasks,
  reanalyzeFrame,
  retryFailedFrames,
  startReview,
  startBehaviorReview
} from './task/manager'

export function registerIpcHandlers(): void {
  ipcMain.on('app:closeReady', (event, saved: unknown) => {
    if (event.senderFrame === event.sender.mainFrame && typeof saved === 'boolean') {
      completeWindowClose(event.sender.id, saved)
    }
  })
  ipcMain.handle('app:bootstrap', (): BootstrapData => ({
    settings: getPublicSettings(),
    tasks: listTasks()
  }))

  ipcMain.handle('dialog:selectVideo', async (event): Promise<FileDialogResult> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择视频',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts'] }
      ]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0], paths: result.filePaths }
  })

  ipcMain.handle('video:thumbnail', (event, filePath: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof filePath !== 'string') return null
    return getVideoThumbnail(filePath)
  })

  ipcMain.handle('task:start', async (_event, filePath: string) => startReview(filePath))
  ipcMain.handle('task:startBehavior', async (_event, filePath: string) => startBehaviorReview(filePath))
  ipcMain.handle('task:list', async () => listTasks())
  ipcMain.handle('task:get', async (_event, taskId: string) => getTaskView(taskId))
  ipcMain.handle('task:diagnostics', async (_event, taskId: string, index: number) => {
    const diagnostics = await getFrameDiagnostics(taskId, index)
    return isModelTracingEnabled() ? diagnostics : { ...diagnostics, callTraces: [] }
  })
  ipcMain.handle('task:cancel', async (_event, taskId: string) => cancelActiveTask(taskId))
  ipcMain.handle('task:retryFailed', async (_event, taskId: string) => retryFailedFrames(taskId))
  ipcMain.handle('task:reanalyzeFrame', async (_event, taskId: string, index: number) => reanalyzeFrame(taskId, index))
  ipcMain.handle('task:delete', async (_event, taskId: string): Promise<DeleteTaskResult> => {
    await deleteTask(taskId)
    return { deleted: true }
  })
  ipcMain.handle('task:exportResults', async (event, taskId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return exportTaskResults(taskId, window)
  })

  ipcMain.handle('settings:save', async (_event, input: SaveSettingsInput) => saveSettings(input))
  const requireTracingEnabled = (): void => {
    if (!isModelTracingEnabled()) throw new Error('请先展开高级设置并打开「启用轨迹」')
  }
  ipcMain.handle('model:traces', async (_event, before?: string) => {
    requireTracingEnabled()
    const page = await listModelCallTraces(before)
    requireTracingEnabled()
    const names = new Map(listTasks().map((task) => [task.id, task.name]))
    return { ...page, items: page.items.map((item) => ({ ...item, taskName: item.taskId ? names.get(item.taskId) : undefined })) }
  })
  ipcMain.handle('model:trace', async (_event, id: string) => {
    requireTracingEnabled()
    const trace = await getModelCallTrace(id)
    requireTracingEnabled()
    return trace
  })

  ipcMain.handle(
    'model:test',
    async (_event, input: TestModelInput) => {
      try {
        await testModelConnection(getResolvedModelConfigForTesting(input))
        return { ok: true, message: '连接成功' }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle(
    'model:probe',
    async (_event, input: TestModelInput): Promise<ModelProbeResult> => {
      try {
        const config = getResolvedModelConfigForTesting(input)
        const outcome = await probeModelConfig(config)
        const { profile, evaluation } = outcome
        const message = outcome.reusedExisting
          ? `本次探测未通过（${evaluation.notes.join('；') || '输出不稳定'}），已沿用上次成功结论`
          : profile.localizationOk
            ? `定位可用（匹配得分 ${evaluation.score.toFixed(2)}）`
            : evaluation.notes.length > 0
              ? `定位不可用：${evaluation.notes.join('；')}`
              : '定位不可用：模型未能返回可解析的框'
        return {
          ok: profile.localizationOk,
          message,
          profile,
          score: evaluation.score,
          meanIoU: evaluation.meanIoU
        }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          profile: null
        }
      }
    }
  )
}
