import type {
  BootstrapData,
  FrameDiagnostics,
  ConnectionTestResult,
  DeleteTaskResult,
  ExportResult,
  FileDialogResult,
  ModelProbeResult,
  ModelCallTracePage,
  ModelCallTraceRecord,
  PublicSettings,
  SaveSettingsInput,
  TaskEvent,
  TaskRecord,
  TaskSummary,
  TestModelInput
} from './types'

export interface FramelensApi {
  getBootstrap(): Promise<BootstrapData>
  selectVideoFile(): Promise<FileDialogResult>
  getVideoThumbnail(filePath: string): Promise<string | null>
  startReview(filePath: string): Promise<TaskSummary>
  startBehaviorReview(filePath: string): Promise<TaskSummary>
  listTasks(): Promise<TaskSummary[]>
  getTask(taskId: string): Promise<TaskRecord>
  getFrameDiagnostics(taskId: string, frameIndex: number): Promise<FrameDiagnostics>
  cancelTask(taskId: string): Promise<boolean>
  retryFailedFrames(taskId: string): Promise<TaskSummary>
  reanalyzeFrame(taskId: string, frameIndex: number): Promise<void>
  deleteTask(taskId: string): Promise<DeleteTaskResult>
  exportTaskResults(taskId: string): Promise<ExportResult>
  saveSettings(input: SaveSettingsInput): Promise<PublicSettings>
  testModel(input: TestModelInput): Promise<ConnectionTestResult>
  listModelCallTraces(before?: string): Promise<ModelCallTracePage>
  getModelCallTrace(id: string): Promise<ModelCallTraceRecord>
  /** 运行模型能力探针（坐标空间/方言/轴序/多框能力） */
  probeModel(input: TestModelInput): Promise<ModelProbeResult>
  getPathForFile(file: File): string
  onTaskEvent(callback: (event: TaskEvent) => void): () => void
  onBeforeClose(callback: () => void): () => void
  completeClose(saved: boolean): void
}
