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
  getVideoThumbnail: (filePath: string) => ipcRenderer.invoke('video:thumbnail', filePath),
  startReview: (filePath: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:start', filePath),
  startBehaviorReview: (filePath: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:startBehavior', filePath),
  listTasks: (): Promise<TaskSummary[]> => ipcRenderer.invoke('task:list'),
  getFrameDiagnostics: (taskId: string, index: number) => ipcRenderer.invoke('task:diagnostics', taskId, index),
  getTask: (taskId: string): Promise<TaskRecord> => ipcRenderer.invoke('task:get', taskId),
  cancelTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke('task:cancel', taskId),
  retryFailedFrames: (taskId: string): Promise<TaskSummary> =>
    ipcRenderer.invoke('task:retryFailed', taskId),
  reanalyzeFrame: (taskId: string, index: number): Promise<void> =>
    ipcRenderer.invoke('task:reanalyzeFrame', taskId, index),
  deleteTask: (taskId: string): Promise<DeleteTaskResult> =>
    ipcRenderer.invoke('task:delete', taskId),
  exportTaskResults: (taskId: string): Promise<ExportResult> =>
    ipcRenderer.invoke('task:exportResults', taskId),
  saveSettings: (input: SaveSettingsInput): Promise<PublicSettings> =>
    ipcRenderer.invoke('settings:save', input),
  testModel: (input: TestModelInput): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke('model:test', input),
  listModelCallTraces: (before?: string) => ipcRenderer.invoke('model:traces', before),
  getModelCallTrace: (id: string) => ipcRenderer.invoke('model:trace', id),
  probeModel: (input: TestModelInput): Promise<ModelProbeResult> =>
    ipcRenderer.invoke('model:probe', input),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onBeforeClose: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:beforeClose', listener)
    return () => ipcRenderer.removeListener('app:beforeClose', listener)
  },
  completeClose: (saved: boolean): void => ipcRenderer.send('app:closeReady', saved),
  onTaskEvent: (callback: (event: TaskEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, taskEvent: TaskEvent): void => {
      callback(taskEvent)
    }
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  }
}

contextBridge.exposeInMainWorld('framelens', api)
