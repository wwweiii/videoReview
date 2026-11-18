import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_ANALYSIS_MODE,
  DEFAULT_BEHAVIOR_IMAGE_SCALE_PERCENT,
  DEFAULT_BEHAVIOR_ITEMS,
  DEFAULT_CONCURRENCY,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_CUSTOM_MODEL,
  DEFAULT_CUSTOM_PROHIBITED_ITEMS,
  DEFAULT_DEVELOPER_MODE,
  DEFAULT_GROUP_SIZE,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_LOCALIZE,
  DEFAULT_MODEL_MODE,
  DEFAULT_MODEL_RUNTIME,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_TRACE_ENABLED,
  MAX_GROUP_SIZE,
  MIN_GROUP_SIZE
} from '@shared/defaults'
import { clampNumber, normalizeInterval } from '@shared/format'
import { DEFAULT_PROHIBITED_ITEMS, normalizeCustomItems, normalizeSelectedItems } from '@shared/items'
import { normalizeBehaviorItems, normalizeBehaviorSampling } from '@shared/behavior'
import type { BoxOrder, CoordinateSpace, ParseDialect } from '@shared/localization/profile'
import type {
  AnalysisConfig,
  AnalysisMode,
  BehaviorAnalysisConfig,
  BehaviorItem,
  CustomModelInput,
  CustomProhibitedItem,
  ModelMode,
  PublicSettings,
  SaveSettingsInput
} from '@shared/types'
import { logger } from '../logger'
import { modelScheduler } from '../runtime/scheduler'
import { normalizeImageScalePercent, normalizeJudgmentImage, type JudgmentImageOptions } from '@shared/image'
import { getSettingsPath } from '../paths'
import { getPresetConfig, isPresetAvailable } from './preset'

export interface StoredCustomModel {
  baseUrl: string
  model: string
  apiKeyEncrypted?: string
  apiKeyPlain?: string
  concurrency: number
  timeoutSec: number
  extraHeaders: string
  extraBody: string
  coordinateSpaceOverride: 'auto' | CoordinateSpace
  boxOrderOverride: 'auto' | BoxOrder
  parseDialectOverride: 'auto' | ParseDialect
}

export interface StoredSettings {
  requestConcurrency: number
  judgmentImage: JudgmentImageOptions
  modelMode: ModelMode
  customModel: StoredCustomModel
  developerMode: boolean
  traceEnabled: boolean
  intervalSec: number
  prohibitedItems: string[]
  customProhibitedItems: CustomProhibitedItem[]
  analysisMode: AnalysisMode
  groupSize: number
  confidenceThreshold: number
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

export { DEFAULT_MODEL_RUNTIME } from '@shared/defaults'

let cachedSettings: StoredSettings | null = null

function defaultStoredSettings(): StoredSettings {
  const preset = getPresetConfig()
  const presetDefaults = preset?.defaults ?? {}
  const customItems = normalizeCustomItems(DEFAULT_CUSTOM_PROHIBITED_ITEMS)
  const behaviorSampling = normalizeBehaviorSampling()
  return {
    requestConcurrency: Math.round(clampNumber(preset?.concurrency ?? DEFAULT_CONCURRENCY, 1, 8)),
    judgmentImage: normalizeJudgmentImage({ scalePercent: presetDefaults.itemImageScalePercent }),
    modelMode: DEFAULT_MODEL_MODE === 'auto'
      ? (preset ? 'preset' : 'custom')
      : DEFAULT_MODEL_MODE === 'preset' && !preset ? 'custom' : DEFAULT_MODEL_MODE,
    developerMode: DEFAULT_DEVELOPER_MODE,
    traceEnabled: DEFAULT_TRACE_ENABLED,
    customModel: {
      baseUrl: DEFAULT_CUSTOM_MODEL.baseUrl.trim(),
      model: DEFAULT_CUSTOM_MODEL.model.trim(),
      ...protectApiKey(DEFAULT_CUSTOM_MODEL.apiKey.trim()),
      concurrency: DEFAULT_CONCURRENCY,
      timeoutSec: Math.round(clampNumber(DEFAULT_TIMEOUT_SEC, 15, 600)),
      extraHeaders: DEFAULT_CUSTOM_MODEL.extraHeaders,
      ...normalizeRuntimeModel(DEFAULT_MODEL_RUNTIME)
    },
    intervalSec: normalizeInterval(presetDefaults.intervalSec ?? DEFAULT_INTERVAL_SEC),
    prohibitedItems: normalizeSelectedItems([...DEFAULT_PROHIBITED_ITEMS, ...customItems.map((item) => item.id)], customItems),
    customProhibitedItems: customItems,
    analysisMode: presetDefaults.analysisMode ?? DEFAULT_ANALYSIS_MODE,
    groupSize: Math.round(clampNumber(presetDefaults.groupSize ?? DEFAULT_GROUP_SIZE, MIN_GROUP_SIZE, MAX_GROUP_SIZE)),
    confidenceThreshold: clampNumber(
      presetDefaults.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      0,
      1
    ),
    localize: presetDefaults.localize ?? DEFAULT_LOCALIZE,
    behaviorItems: normalizeBehaviorItems(DEFAULT_BEHAVIOR_ITEMS),
    behaviorWindowSec: behaviorSampling.windowSec,
    behaviorStrideSec: behaviorSampling.strideSec,
    behaviorFps: behaviorSampling.fps,
    behaviorImageScalePercent: normalizeImageScalePercent(
      presetDefaults.behaviorImageScalePercent ?? preset?.imageScalePercent ?? DEFAULT_BEHAVIOR_IMAGE_SCALE_PERCENT
    )
  }
}

type RuntimeModelFields = Pick<
  StoredCustomModel,
  | 'extraBody'
  | 'coordinateSpaceOverride'
  | 'boxOrderOverride'
  | 'parseDialectOverride'
>

export function normalizeRuntimeModel(
  source: Partial<StoredCustomModel> | undefined
): RuntimeModelFields {
  const raw = source ?? {}
  return {
    extraBody: typeof raw.extraBody === 'string' ? raw.extraBody : DEFAULT_MODEL_RUNTIME.extraBody,
    coordinateSpaceOverride: normalizeSpaceOverride(raw.coordinateSpaceOverride),
    boxOrderOverride:
      raw.boxOrderOverride === 'auto' || raw.boxOrderOverride === 'yxyx' || raw.boxOrderOverride === 'xyxy'
        ? raw.boxOrderOverride
        : DEFAULT_MODEL_RUNTIME.boxOrderOverride,
    parseDialectOverride: normalizeDialectOverride(raw.parseDialectOverride)
  }
}

type LegacyStoredSettings = Partial<Omit<StoredSettings, 'customModel'>> & {
  customModel?: StoredCustomModel & { imageScalePercent?: number }
}

function normalizeStored(raw: LegacyStoredSettings): StoredSettings {
  const defaults = defaultStoredSettings()
  const custom = raw.customModel ?? defaults.customModel
  const customItems = normalizeCustomItems(raw.customProhibitedItems ?? defaults.customProhibitedItems)
  const behaviorSampling = normalizeBehaviorSampling({
    windowSec: raw.behaviorWindowSec,
    strideSec: raw.behaviorStrideSec,
    fps: raw.behaviorFps
  })
  const confidenceThreshold = Number(raw.confidenceThreshold ?? defaults.confidenceThreshold)
  return {
    requestConcurrency: Math.round(clampNumber(
      Number(raw.requestConcurrency ?? (raw.modelMode === 'custom' ? custom.concurrency : defaults.requestConcurrency)) || defaults.requestConcurrency,
      1, 8
    )),
    judgmentImage: normalizeJudgmentImage(raw.judgmentImage ?? defaults.judgmentImage),
    modelMode:
      raw.modelMode === 'preset' || raw.modelMode === 'custom' ? raw.modelMode : defaults.modelMode,
    developerMode: typeof raw.developerMode === 'boolean' ? raw.developerMode : defaults.developerMode,
    traceEnabled: typeof raw.traceEnabled === 'boolean' ? raw.traceEnabled : defaults.traceEnabled,
    customModel: {
      baseUrl: typeof custom.baseUrl === 'string' ? custom.baseUrl : defaults.customModel.baseUrl,
      model: typeof custom.model === 'string' ? custom.model : defaults.customModel.model,
      apiKeyEncrypted:
        typeof custom.apiKeyEncrypted === 'string' ? custom.apiKeyEncrypted : undefined,
      apiKeyPlain: typeof custom.apiKeyPlain === 'string' ? custom.apiKeyPlain : undefined,
      concurrency: Math.round(
        clampNumber(Number(custom.concurrency) || DEFAULT_CONCURRENCY, 1, 8)
      ),
      timeoutSec: Math.round(clampNumber(Number(custom.timeoutSec) || DEFAULT_TIMEOUT_SEC, 15, 600)),
      extraHeaders: typeof custom.extraHeaders === 'string' ? custom.extraHeaders : defaults.customModel.extraHeaders,
      ...normalizeRuntimeModel(custom)
    },
    intervalSec: normalizeInterval(Number(raw.intervalSec ?? defaults.intervalSec) || defaults.intervalSec),
    customProhibitedItems: customItems,
    prohibitedItems: normalizeSelectedItems(raw.prohibitedItems ?? defaults.prohibitedItems, customItems),
    analysisMode: raw.analysisMode === 'group' || raw.analysisMode === 'single' ? raw.analysisMode : defaults.analysisMode,
    groupSize: Math.round(clampNumber(Number(raw.groupSize ?? defaults.groupSize) || defaults.groupSize, MIN_GROUP_SIZE, MAX_GROUP_SIZE)),
    confidenceThreshold: clampNumber(
      Number.isFinite(confidenceThreshold) ? confidenceThreshold : defaults.confidenceThreshold,
      0,
      1
    ),
    localize: typeof raw.localize === 'boolean' ? raw.localize : defaults.localize,
    behaviorItems: normalizeBehaviorItems(raw.behaviorItems ?? defaults.behaviorItems),
    behaviorWindowSec: behaviorSampling.windowSec,
    behaviorStrideSec: behaviorSampling.strideSec,
    behaviorFps: behaviorSampling.fps,
    // 旧共用比例迁入行为设置；物品定位改为跟随原判定比例。
    behaviorImageScalePercent: normalizeImageScalePercent(raw.behaviorImageScalePercent ?? (
      (raw.modelMode ?? defaults.modelMode) === 'preset'
        ? defaults.behaviorImageScalePercent
        : raw.customModel?.imageScalePercent ?? defaults.behaviorImageScalePercent
    ))
  }
}

function normalizeSpaceOverride(value: unknown): 'auto' | CoordinateSpace {
  return value === 'auto' ||
    value === 'normalized_1000' ||
    value === 'normalized_100' ||
    value === 'normalized_01' ||
    value === 'absolute_px'
    ? value
    : DEFAULT_MODEL_RUNTIME.coordinateSpaceOverride
}

function normalizeDialectOverride(value: unknown): 'auto' | ParseDialect {
  return value === 'auto' ||
    value === 'json_multi' ||
    value === 'box_tokens' ||
    value === 'loc_bins' ||
    value === 'plain_coords' ||
    value === 'none'
    ? value
    : DEFAULT_MODEL_RUNTIME.parseDialectOverride
}

export function loadSettings(): StoredSettings {
  if (cachedSettings) return cachedSettings
  try {
    if (fs.existsSync(getSettingsPath())) {
      cachedSettings = normalizeStored(
        JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) as LegacyStoredSettings
      )
    } else {
      cachedSettings = defaultStoredSettings()
    }
  } catch (error) {
    logger.error('读取设置失败', error)
    cachedSettings = defaultStoredSettings()
  }
  return cachedSettings
}

export function readSavedApiKey(model: StoredCustomModel): string {
  try {
    if (model.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(model.apiKeyEncrypted, 'base64'))
    }
  } catch (error) {
    logger.warn('读取密钥失败', error)
  }
  if (model.apiKeyPlain) {
    try {
      return Buffer.from(model.apiKeyPlain, 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  return ''
}

function protectApiKey(apiKey: string): Pick<StoredCustomModel, 'apiKeyEncrypted' | 'apiKeyPlain'> {
  if (!apiKey) return {}
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { apiKeyEncrypted: safeStorage.encryptString(apiKey).toString('base64') }
    }
  } catch (error) {
    logger.warn('系统安全存储不可用', error)
  }
  return { apiKeyPlain: Buffer.from(apiKey, 'utf8').toString('base64') }
}

export function validateCustomModel(input: CustomModelInput): void {
  if (!input.baseUrl.trim()) throw new Error('请填写接口地址')
  if (!input.model.trim()) throw new Error('请填写模型名称')
  let url: URL
  try {
    url = new URL(input.baseUrl.trim())
  } catch {
    throw new Error('接口地址格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('接口地址格式不正确')
  }
}

function persistSettings(settings: StoredSettings): void {
  const filePath = getSettingsPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporary, filePath)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function getPublicSettings(): PublicSettings {
  const stored = loadSettings()
  return {
    requestConcurrency: stored.requestConcurrency,
    judgmentImage: { ...stored.judgmentImage },
    modelMode: stored.modelMode,
    presetAvailable: isPresetAvailable(),
    developerMode: stored.developerMode,
    traceEnabled: stored.traceEnabled,
    customModel: {
      baseUrl: stored.customModel.baseUrl,
      model: stored.customModel.model,
      hasApiKey: Boolean(readSavedApiKey(stored.customModel)),
      extraBody: stored.customModel.extraBody,
      coordinateSpaceOverride: stored.customModel.coordinateSpaceOverride,
      boxOrderOverride: stored.customModel.boxOrderOverride,
      parseDialectOverride: stored.customModel.parseDialectOverride
    },
    intervalSec: stored.intervalSec,
    prohibitedItems: [...stored.prohibitedItems],
    customProhibitedItems: stored.customProhibitedItems.map((item) => ({ ...item })),
    analysisMode: stored.analysisMode,
    groupSize: stored.groupSize,
    localize: stored.localize,
    behaviorItems: stored.behaviorItems.map((item) => ({ ...item })),
    behaviorWindowSec: stored.behaviorWindowSec,
    behaviorStrideSec: stored.behaviorStrideSec,
    behaviorFps: stored.behaviorFps,
    behaviorImageScalePercent: stored.behaviorImageScalePercent
  }
}

export function isModelTracingEnabled(): boolean {
  const { developerMode, traceEnabled } = loadSettings()
  return developerMode && traceEnabled
}

/** 行为任务创建时使用的采样参数与行为名称快照。 */
export function getBehaviorConfig(): BehaviorAnalysisConfig {
  const stored = loadSettings()
  return {
    windowSec: stored.behaviorWindowSec,
    strideSec: stored.behaviorStrideSec,
    fps: stored.behaviorFps,
    imageScalePercent: stored.behaviorImageScalePercent,
    behaviors: stored.behaviorItems.map((item) => item.label)
  }
}

export function getAnalysisConfig(): AnalysisConfig {
  const stored = loadSettings()
  return {
    judgmentImage: { ...stored.judgmentImage },
    intervalSec: stored.intervalSec,
    prohibitedItems: [...stored.prohibitedItems],
    customProhibitedItems: stored.customProhibitedItems.map((item) => ({ ...item })),
    analysisMode: stored.analysisMode,
    groupSize: stored.groupSize,
    confidenceThreshold: stored.confidenceThreshold,
    localize: stored.localize,
    behaviorItems: stored.behaviorItems.map((item) => ({ ...item }))
  }
}

export function applyRuntimeOverrides(
  input: CustomModelInput,
  base: RuntimeModelFields
): RuntimeModelFields {
  const merged: Partial<StoredCustomModel> = { ...base }
  if (typeof input.extraBody === 'string') merged.extraBody = input.extraBody
  if (input.coordinateSpaceOverride !== undefined) {
    merged.coordinateSpaceOverride = normalizeSpaceOverride(input.coordinateSpaceOverride)
  }
  if (input.boxOrderOverride !== undefined) {
    merged.boxOrderOverride =
      input.boxOrderOverride === 'yxyx' || input.boxOrderOverride === 'xyxy'
        ? input.boxOrderOverride
        : 'auto'
  }
  if (input.parseDialectOverride !== undefined) {
    merged.parseDialectOverride = normalizeDialectOverride(input.parseDialectOverride)
  }
  return normalizeRuntimeModel(merged)
}

export function saveSettings(input: SaveSettingsInput): PublicSettings {
  const current = loadSettings()
  if (input.section && !['items', 'behavior', 'model', 'trace'].includes(input.section)) {
    throw new Error('未知设置分区')
  }
  const saveModel = !input.section || input.section === 'model'
  const saveItems = !input.section || input.section === 'items'
  const saveBehavior = !input.section || input.section === 'behavior'
  const saveTrace = !input.section || input.section === 'trace'
  if (saveModel && input.modelMode === 'preset' && !isPresetAvailable()) {
    throw new Error('预设模型不可用')
  }
  if (saveModel && input.modelMode === 'custom') validateCustomModel(input.customModel)
  if (saveModel && input.developerMode && input.modelMode === 'custom' && input.customModel.extraBody?.trim()) {
    let value: unknown
    try {
      value = JSON.parse(input.customModel.extraBody)
    } catch {
      throw new Error('额外请求体不是合法 JSON')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('额外请求体必须是 JSON 对象')
    }
  }

  const customItems = normalizeCustomItems(input.customProhibitedItems)
  const selectedItems = normalizeSelectedItems(input.prohibitedItems, customItems)

  const nextCustom: StoredCustomModel = saveModel
    ? {
        ...current.customModel,
        baseUrl: input.customModel.baseUrl.trim(),
        model: input.customModel.model.trim(),
        ...applyRuntimeOverrides(input.customModel, current.customModel)
      }
    : { ...current.customModel }

  if (saveModel && input.customModel.apiKey?.trim()) {
    delete nextCustom.apiKeyPlain
    Object.assign(nextCustom, protectApiKey(input.customModel.apiKey.trim()))
  }

  const behaviorSampling = normalizeBehaviorSampling({
    windowSec: input.behaviorWindowSec,
    strideSec: input.behaviorStrideSec,
    fps: input.behaviorFps
  })
  const next: StoredSettings = {
    ...current,
    customModel: nextCustom,
    traceEnabled: saveTrace && typeof input.traceEnabled === 'boolean' ? input.traceEnabled : current.traceEnabled,
    ...(saveModel
      ? {
          modelMode: input.modelMode,
          developerMode: Boolean(input.developerMode),
          requestConcurrency: Math.round(clampNumber(Number(input.requestConcurrency) || current.requestConcurrency, 1, 8))
        }
      : {}),
    ...(saveItems
      ? {
          judgmentImage: normalizeJudgmentImage(input.judgmentImage ?? current.judgmentImage),
          intervalSec: normalizeInterval(input.intervalSec),
          prohibitedItems: selectedItems,
          customProhibitedItems: customItems,
          analysisMode: input.analysisMode === 'group' ? 'group' : 'single',
          groupSize: Math.round(clampNumber(input.groupSize, 2, 8)),
          localize: Boolean(input.localize)
        }
      : {}),
    ...(saveBehavior
      ? {
          behaviorItems: normalizeBehaviorItems(input.behaviorItems),
          behaviorWindowSec: behaviorSampling.windowSec,
          behaviorStrideSec: behaviorSampling.strideSec,
          behaviorFps: behaviorSampling.fps,
          behaviorImageScalePercent: normalizeImageScalePercent(input.behaviorImageScalePercent ?? current.behaviorImageScalePercent)
        }
      : {})
  }
  persistSettings(next)
  cachedSettings = next
  modelScheduler.setLimit(next.requestConcurrency)
  return getPublicSettings()
}
