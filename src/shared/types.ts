import type {
  BoxOrder,
  CoordinateSpace,
  ModelProfile,
  ParseDialect,
  RegionBox
} from './localization/profile'
import type { JudgmentImageOptions, TaskJudgmentImageOptions } from './image'
import type { FrameStats } from './task'

export type ModelMode = 'preset' | 'custom'
export type AnalysisMode = 'single' | 'group'
export type TaskKind = 'items' | 'behavior'

export interface BehaviorAnalysisConfig {
  windowSec: number
  strideSec: number
  fps: number
  /** 创建任务时固定的图片缩放比例；旧任务缺省为 100%。 */
  imageScalePercent?: number
  /** 创建行为任务时从设置复制的行为名称快照。 */
  behaviors: string[]
}

export interface BehaviorItem {
  id: string
  label: string
}

/** 预设违禁物（显示即启用，取消后可按名称重新添加） */
export interface ProhibitedItem {
  id: string
  label: string
  prompt: string
  /** 模型输出标签的别名（英文名/同义词），用于跨模型类别映射 */
  aliases?: string[]
}

/** 用户自定义违禁物（保存在本地设置里，可删除） */
export interface CustomProhibitedItem {
  id: string
  label: string
}

export type TaskStatus =
  | 'extracting'
  | 'analyzing'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export type FrameStatus = 'pending' | 'analyzing' | 'completed' | 'failed'
export type Verdict = 'pending' | 'normal' | 'abnormal' | 'review' | 'failed'
export type RiskLevel = 'high' | 'medium' | 'low' | 'none'

/** 启用轨迹后保留的一次模型调用完整记录。 */
export interface ModelCallTrace {
  queueMs?: number
  requestBytes?: number
  operation: string
  startedAt: string
  finishedAt: string
  latencyMs: number
  endpoint: string
  status: number | null
  requestBody: string
  responseBody: string
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  error: string
}

export interface ModelCallTraceRecord extends ModelCallTrace {
  id: string
  model: string
  taskId: string | null
}

export interface ModelCallTraceSummary extends Omit<ModelCallTraceRecord, 'requestBody' | 'responseBody'> {
  taskName?: string
}

export interface ModelCallTracePage {
  items: ModelCallTraceSummary[]
  total: number
  nextBefore: string | null
}

/* ------------------------------ 定位标记 ------------------------------ */

export type RegionStatus = 'none' | 'pending' | 'ok' | 'failed' | 'unsupported'
export type RegionSource = 'model' | 'manual' | 'verified'
export type LocateLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type LocatedBy = 'vlm' | 'detector' | 'grid' | 'region_text' | 'manual'

export interface RegionRecord {
  id: string
  /** 对应 BUILTIN_PROHIBITED_ITEMS 的 id；模型类别对不上时为 null */
  itemId: string | null
  /** 展示用类别（优先使用内置中文名，否则保留模型原始 label） */
  category: string
  /** 归一化框：0..1，原点左上 */
  box: RegionBox
  confidence: number | null
  source: RegionSource
  verified: boolean | null
  /** 坐标校验可疑（越界/比例异常），前端只画虚线 */
  suspicious: boolean
  level: LocateLevel
  locatedBy: LocatedBy
  note: string
}

export type { RegionBox }

/* ------------------------------ 视频 / 任务 ------------------------------ */

export interface VideoFileInfo {
  fileName: string
  filePath: string
  durationMs: number
  width: number
  height: number
  fileSizeBytes: number | null
}

export interface AnalysisConfig {
  /** 物品判定与定位共用的图片配置快照。 */
  judgmentImage?: TaskJudgmentImageOptions
  intervalSec: number
  /** 已启用并显示在设置页的检测物品 id */
  prohibitedItems: string[]
  /** 自定义违禁物快照（任务创建时固定，避免后续设置变动影响历史任务） */
  customProhibitedItems: CustomProhibitedItem[]
  analysisMode: AnalysisMode
  groupSize: number
  confidenceThreshold: number
  /** 是否启用违禁物定位标记 */
  localize: boolean
  /** 当前行为设置快照来源；物品任务忽略此字段。 */
  behaviorItems: BehaviorItem[]
}

export interface FrameRecord {
  /** 独立保存的原始响应与调用记录的内容摘要。 */
  detailRef?: string
  index: number
  timestampMs: number
  fileName: string
  status: FrameStatus
  verdict: Verdict
  riskLevel: RiskLevel
  categories: string[]
  description: string
  evidence: string
  confidence: number | null
  needHumanReview: boolean
  error: string
  rawResponse: string
  analyzedAt: string | null
  model: string
  /* 定位 */
  regions: RegionRecord[]
  regionStatus: RegionStatus
  regionLevel: LocateLevel
  regionModel: string
  regionError: string
  regionRaw: string
  /** 启用轨迹后的判定/定位调用轨迹。 */
  callTraces: ModelCallTrace[]
}

export interface TaskRecord {
  schemaVersion?: number
  stats?: FrameStats
  reanalyzingFrameIndices?: number[]
  /** 当前会话的落盘错误；恢复保存后清空。 */
  saveError?: string
  id: string
  /** 旧任务未设置时按物品识别处理。 */
  kind?: TaskKind
  name: string
  source: VideoFileInfo
  config: AnalysisConfig
  status: TaskStatus
  createdAt: string
  updatedAt: string
  frames: FrameRecord[]
  behaviorConfig?: BehaviorAnalysisConfig
  behaviorWindows?: BehaviorWindowRecord[]
  errorMessage: string
  progress: number
  phaseMessage: string
  /** 定位阶段使用的模型能力档案快照（排障用） */
  regionProfile: ModelProfile | null
}

export interface TaskSummary {
  hasUnfinishedResults?: boolean
  reanalyzingFrameIndices?: number[]
  saveError?: string
  id: string
  kind?: TaskKind
  name: string
  /** 原始视频路径，用于在工作台把上传文件与对应任务关联起来。 */
  filePath?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  durationMs: number
  width: number
  height: number
  totalFrames: number
  processedFrames: number
  abnormalCount: number
  reviewCount: number
  normalCount: number
  failedCount: number
  /** 已定位出框的帧数 */
  locatedCount: number
  progress: number
  phaseMessage: string
  errorMessage: string
}

export interface CustomModelPublic {
  baseUrl: string
  model: string
  hasApiKey: boolean
  /** 透传给服务端的额外请求体（JSON 字符串） */
  extraBody: string
  /** 坐标空间手动覆盖（auto = 由探针决定） */
  coordinateSpaceOverride: 'auto' | CoordinateSpace
  /** 轴序手动覆盖 */
  boxOrderOverride: 'auto' | BoxOrder
  /** 解析方言手动覆盖（auto = 由探针决定） */
  parseDialectOverride: 'auto' | ParseDialect
}

export interface PublicSettings {
  requestConcurrency: number
  judgmentImage: JudgmentImageOptions
  modelMode: ModelMode
  presetAvailable: boolean
  customModel: CustomModelPublic
  /** 是否展开并启用高级设置。 */
  developerMode: boolean
  traceEnabled: boolean
  intervalSec: number
  prohibitedItems: string[]
  customProhibitedItems: CustomProhibitedItem[]
  analysisMode: AnalysisMode
  groupSize: number
  localize: boolean
  behaviorItems: BehaviorItem[]
  /** 行为识别窗口时长（秒） */
  behaviorWindowSec: number
  /** 行为识别推进步长（秒） */
  behaviorStrideSec: number
  /** 行为识别每秒采样帧数 */
  behaviorFps: number
  behaviorImageScalePercent: number
}

export interface CustomModelInput {
  baseUrl: string
  model: string
  apiKey?: string
  extraBody?: string
  coordinateSpaceOverride?: 'auto' | CoordinateSpace
  boxOrderOverride?: 'auto' | BoxOrder
  parseDialectOverride?: 'auto' | ParseDialect
}

export interface SaveSettingsInput {
  requestConcurrency?: number
  judgmentImage?: JudgmentImageOptions
  /** 按设置分区保存，省略时兼容完整设置写入。 */
  section?: 'items' | 'behavior' | 'model' | 'trace'
  modelMode: ModelMode
  customModel: CustomModelInput
  developerMode: boolean
  traceEnabled?: boolean
  intervalSec: number
  prohibitedItems: string[]
  customProhibitedItems: CustomProhibitedItem[]
  analysisMode: AnalysisMode
  groupSize: number
  localize: boolean
  behaviorItems: BehaviorItem[]
  behaviorWindowSec: number
  behaviorStrideSec: number
  behaviorFps: number
  behaviorImageScalePercent?: number
}

export interface TestModelInput {
  modelMode: ModelMode
  /** 测试连接使用界面当前开关，避免自动保存防抖期间读取旧值。 */
  developerMode?: boolean
  traceEnabled?: boolean
  customModel: CustomModelInput
}

export interface BootstrapData {
  settings: PublicSettings
  tasks: TaskSummary[]
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

export interface ExportResult {
  saved: boolean
  path?: string
}

export interface DeleteTaskResult {
  deleted: boolean
}

export interface ModelProbeResult {
  ok: boolean
  message: string
  profile: ModelProfile | null
  /** 探针最佳假设的匹配得分（0..1），用于 UI 展示 */
  score?: number
  /** 探针最佳假设的平均 IoU */
  meanIoU?: number
}

export type TaskEvent =
  | { kind: 'summary'; summary: TaskSummary }
  | { kind: 'results'; summary: TaskSummary; frames: FrameRecord[]; windows: BehaviorWindowRecord[] }

export interface FrameDiagnostics {
  rawResponse: string
  regionRaw: string
  callTraces: ModelCallTrace[]
}

/** 一个片段对应一次时序判定；继承通用判定字段，定位字段不用于行为审核。 */
export interface BehaviorWindowRecord extends FrameRecord {
  endTimestampMs: number
  samples: Array<{ timestampMs: number; fileName: string }>
}

export interface FileDialogResult {
  canceled: boolean
  path?: string
  /** 选择多个视频时返回完整路径列表；path 保留为首个文件的兼容字段。 */
  paths?: string[]
}
