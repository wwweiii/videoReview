import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FramelensApi } from '@shared/api'
import type {
  BootstrapData,
  ConnectionTestResult,
  DeleteTaskResult,
  ExportResult,
  FileDialogResult,
  ModelProbeResult,
  PublicSettings,
  SaveSettingsInput,
  TaskEvent,
  TaskRecord,
  TaskSummary,
  TestModelInput
} from '@shared/types'

const api: FramelensApi = {
  getBootstrap: (): Promise<BootstrapData> => ipcRenderer.invoke('app:bootstrap'),
  selectVideoFile: (): Promise<FileDialogResult> => ipcRenderer.invoke('dialog:selectVideo'),
  startReview: (filePath: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:start', filePath),
  startBehaviorReview: (filePath: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:startBehavior', filePath),
  listTasks: (): Promise<TaskSummary[]> => ipcRenderer.invoke('task:list'),
  getTask: (taskId: string): Promise<TaskRecord> => ipcRenderer.invoke('task:get', taskId),
  cancelTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke('task:cancel', taskId),
  retryFailedFrames: (taskId: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:retryFailed', taskId),
  relocalizeTask: (taskId: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:relocalize', taskId),
  deleteTask: (taskId: string): Promise<DeleteTaskResult> =>
    ipcRenderer.invoke('task:delete', taskId),
  exportTaskCsv: (taskId: string): Promise<ExportResult> =>
    ipcRenderer.invoke('task:exportCsv', taskId),
  saveSettings: (input: SaveSettingsInput): Promise<PublicSettings> =>
    ipcRenderer.invoke('settings:save', input),
  testModel: (input: TestModelInput): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke('model:test', input),
  probeModel: (input: TestModelInput): Promise<ModelProbeResult> =>
    ipcRenderer.invoke('model:probe', input),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onTaskEvent: (callback: (event: TaskEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, taskEvent: TaskEvent): void => {
      callback(taskEvent)
    }
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  }
}

contextBridge.exposeInMainWorld('framelens', api)
