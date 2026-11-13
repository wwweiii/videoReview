import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_BEHAVIOR_FPS,
  DEFAULT_BEHAVIOR_STRIDE_SEC,
  DEFAULT_BEHAVIOR_WINDOW_SEC,
  DEFAULT_CONCURRENCY,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_GROUP_SIZE,
  DEFAULT_IMAGE_MAX_EDGE,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_LOCALIZE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_SEC
} from '@shared/defaults'
import { clampNumber, normalizeInterval } from '@shared/format'
import { DEFAULT_PROHIBITED_ITEMS, normalizeCustomItems } from '@shared/items'
import { normalizeBehaviorItems, normalizeBehaviorSampling } from '@shared/behavior'
import type { BoxOrder, CoordinateSpace, ParseDialect } from '@shared/localization/profile'
import type { PromptLanguage } from '@shared/localization/prompts'
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
  maxTokens: number
  imageMaxEdge: number
  imageFormat: 'png' | 'jpeg'
  promptLanguage: PromptLanguage
  coordinateSpaceOverride: 'auto' | CoordinateSpace
  boxOrderOverride: 'auto' | BoxOrder
  parseDialectOverride: 'auto' | ParseDialect
}

export interface StoredSettings {
  modelMode: ModelMode
  customModel: StoredCustomModel
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
}

export const DEFAULT_MODEL_RUNTIME: Pick<
  StoredCustomModel,
  | 'extraBody'
  | 'maxTokens'
  | 'imageMaxEdge'
  | 'imageFormat'
  | 'promptLanguage'
  | 'coordinateSpaceOverride'
  | 'boxOrderOverride'
  | 'parseDialectOverride'
> = {
  extraBody: '',
  maxTokens: DEFAULT_MAX_TOKENS,
  imageMaxEdge: DEFAULT_IMAGE_MAX_EDGE,
  imageFormat: 'png',
  promptLanguage: 'zh',
  coordinateSpaceOverride: 'auto',
  boxOrderOverride: 'auto',
  parseDialectOverride: 'auto'
}

let cachedSettings: StoredSettings | null = null

function defaultStoredSettings(): StoredSettings {
  const preset = getPresetConfig()
  const presetDefaults = preset?.defaults ?? {}
  return {
    modelMode: preset ? 'preset' : 'custom',
    customModel: {
      baseUrl: '',
      model: '',
      concurrency: DEFAULT_CONCURRENCY,
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      extraHeaders: '',
      ...DEFAULT_MODEL_RUNTIME
    },
    intervalSec: normalizeInterval(presetDefaults.intervalSec ?? DEFAULT_INTERVAL_SEC),
    // 内置四项固定包含；自定义物品默认为空
    prohibitedItems: [...DEFAULT_PROHIBITED_ITEMS],
    customProhibitedItems: [],
    analysisMode: presetDefaults.analysisMode === 'group' ? 'group' : 'single',
    groupSize: Math.round(clampNumber(presetDefaults.groupSize ?? DEFAULT_GROUP_SIZE, 2, 8)),
    confidenceThreshold: clampNumber(
      presetDefaults.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      0,
      1
    ),
    localize: presetDefaults.localize ?? DEFAULT_LOCALIZE,
    behaviorItems: [],
    behaviorWindowSec: DEFAULT_BEHAVIOR_WINDOW_SEC,
    behaviorStrideSec: DEFAULT_BEHAVIOR_STRIDE_SEC,
    behaviorFps: DEFAULT_BEHAVIOR_FPS
  }
}

/** 内置物品固定包含，自定义物品只能从自定义列表里选 */
function normalizeSelectedItems(
  rawSelected: unknown,
  customItems: CustomProhibitedItem[]
): string[] {
  const customIds = new Set(customItems.map((item) => item.id))
  const selected = Array.isArray(rawSelected)
    ? rawSelected.filter(
        (id): id is string => typeof id === 'string' && customIds.has(id)
      )
    : []
  return [...DEFAULT_PROHIBITED_ITEMS, ...Array.from(new Set(selected))]
}

type RuntimeModelFields = Pick<
  StoredCustomModel,
  | 'extraBody'
  | 'maxTokens'
  | 'imageMaxEdge'
  | 'imageFormat'
  | 'promptLanguage'
  | 'coordinateSpaceOverride'
  | 'boxOrderOverride'
  | 'parseDialectOverride'
>

export function normalizeRuntimeModel(
  source: Partial<StoredCustomModel> | undefined
): RuntimeModelFields {
  const raw = source ?? {}
  return {
    extraBody: typeof raw.extraBody === 'string' ? raw.extraBody : '',
    maxTokens: Math.round(clampNumber(Number(raw.maxTokens) || DEFAULT_MAX_TOKENS, 128, 32768)),
    imageMaxEdge: Math.round(
      clampNumber(
        raw.imageMaxEdge === undefined ? DEFAULT_IMAGE_MAX_EDGE : Number(raw.imageMaxEdge),
        0,
        4096
      )
    ),
    imageFormat: raw.imageFormat === 'jpeg' ? 'jpeg' : 'png',
    promptLanguage: raw.promptLanguage === 'en' ? 'en' : 'zh',
    coordinateSpaceOverride: normalizeSpaceOverride(raw.coordinateSpaceOverride),
    boxOrderOverride:
      raw.boxOrderOverride === 'yxyx' || raw.boxOrderOverride === 'xyxy'
        ? raw.boxOrderOverride
        : 'auto',
    parseDialectOverride: normalizeDialectOverride(raw.parseDialectOverride)
  }
}

function normalizeStored(raw: Partial<StoredSettings>): StoredSettings {
  const defaults = defaultStoredSettings()
  const custom = raw.customModel ?? defaults.customModel
  const customItems = normalizeCustomItems(raw.customProhibitedItems)
  const behaviorSampling = normalizeBehaviorSampling({
    windowSec: raw.behaviorWindowSec,
    strideSec: raw.behaviorStrideSec,
    fps: raw.behaviorFps
  })
  return {
    modelMode:
      raw.modelMode === 'preset' || raw.modelMode === 'custom' ? raw.modelMode : defaults.modelMode,
    customModel: {
      baseUrl: typeof custom.baseUrl === 'string' ? custom.baseUrl : '',
      model: typeof custom.model === 'string' ? custom.model : '',
      apiKeyEncrypted:
        typeof custom.apiKeyEncrypted === 'string' ? custom.apiKeyEncrypted : undefined,
      apiKeyPlain: typeof custom.apiKeyPlain === 'string' ? custom.apiKeyPlain : undefined,
      concurrency: Math.round(
        clampNumber(Number(custom.concurrency) || DEFAULT_CONCURRENCY, 1, 8)
      ),
      timeoutSec: Math.round(clampNumber(Number(custom.timeoutSec) || DEFAULT_TIMEOUT_SEC, 15, 600)),
      extraHeaders: typeof custom.extraHeaders === 'string' ? custom.extraHeaders : '',
      ...normalizeRuntimeModel(custom)
    },
    intervalSec: normalizeInterval(Number(raw.intervalSec) || DEFAULT_INTERVAL_SEC),
    customProhibitedItems: customItems,
    prohibitedItems: normalizeSelectedItems(raw.prohibitedItems, customItems),
    analysisMode: raw.analysisMode === 'group' ? 'group' : 'single',
    groupSize: Math.round(clampNumber(Number(raw.groupSize) || DEFAULT_GROUP_SIZE, 2, 8)),
    confidenceThreshold: clampNumber(
      Number(raw.confidenceThreshold) || DEFAULT_CONFIDENCE_THRESHOLD,
      0,
      1
    ),
    localize: typeof raw.localize === 'boolean' ? raw.localize : defaults.localize,
    behaviorItems: normalizeBehaviorItems(raw.behaviorItems),
    behaviorWindowSec: behaviorSampling.windowSec,
    behaviorStrideSec: behaviorSampling.strideSec,
    behaviorFps: behaviorSampling.fps
  }
}

function normalizeSpaceOverride(value: unknown): 'auto' | CoordinateSpace {
  return value === 'normalized_1000' ||
    value === 'normalized_100' ||
    value === 'normalized_01' ||
    value === 'absolute_px'
    ? value
    : 'auto'
}

function normalizeDialectOverride(value: unknown): 'auto' | ParseDialect {
  return value === 'json_multi' ||
    value === 'box_tokens' ||
    value === 'loc_bins' ||
    value === 'plain_coords' ||
    value === 'none'
    ? value
    : 'auto'
}

export function loadSettings(): StoredSettings {
  if (cachedSettings) return cachedSettings
  try {
    if (fs.existsSync(getSettingsPath())) {
      cachedSettings = normalizeStored(
        JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) as Partial<StoredSettings>
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
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
  fs.renameSync(temporary, filePath)
}

export function getPublicSettings(): PublicSettings {
  const stored = loadSettings()
  return {
    modelMode: stored.modelMode,
    presetAvailable: isPresetAvailable(),
    customModel: {
      baseUrl: stored.customModel.baseUrl,
      model: stored.customModel.model,
      hasApiKey: Boolean(readSavedApiKey(stored.customModel)),
      extraBody: stored.customModel.extraBody,
      maxTokens: stored.customModel.maxTokens,
      imageMaxEdge: stored.customModel.imageMaxEdge,
      imageFormat: stored.customModel.imageFormat,
      promptLanguage: stored.customModel.promptLanguage,
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
    behaviorFps: stored.behaviorFps
  }
}

/** 行为任务创建时使用的采样参数与行为名称快照。 */
export function getBehaviorConfig(): BehaviorAnalysisConfig {
  const stored = loadSettings()
  return {
    windowSec: stored.behaviorWindowSec,
    strideSec: stored.behaviorStrideSec,
    fps: stored.behaviorFps,
    behaviors: stored.behaviorItems.map((item) => item.label)
  }
}

export function getAnalysisConfig(): AnalysisConfig {
  const stored = loadSettings()
  return {
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
  if (input.maxTokens !== undefined) merged.maxTokens = input.maxTokens
  if (input.imageMaxEdge !== undefined) merged.imageMaxEdge = input.imageMaxEdge
  if (input.imageFormat === 'png' || input.imageFormat === 'jpeg') {
    merged.imageFormat = input.imageFormat
  }
  if (input.promptLanguage === 'zh' || input.promptLanguage === 'en') {
    merged.promptLanguage = input.promptLanguage
  }
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
  if (input.modelMode === 'preset' && !isPresetAvailable()) {
    throw new Error('预设模型不可用')
  }
  if (input.modelMode === 'custom') validateCustomModel(input.customModel)

  const customItems = normalizeCustomItems(input.customProhibitedItems)
  const selectedItems = normalizeSelectedItems(input.prohibitedItems, customItems)

  const nextCustom: StoredCustomModel = {
    ...current.customModel,
    baseUrl: input.customModel.baseUrl.trim(),
    model: input.customModel.model.trim(),
    ...applyRuntimeOverrides(input.customModel, current.customModel)
  }

  if (input.customModel.apiKey?.trim()) {
    delete nextCustom.apiKeyPlain
    Object.assign(nextCustom, protectApiKey(input.customModel.apiKey.trim()))
  }

  const behaviorSampling = normalizeBehaviorSampling({
    windowSec: input.behaviorWindowSec,
    strideSec: input.behaviorStrideSec,
    fps: input.behaviorFps
  })
  cachedSettings = {
    ...current,
    modelMode: input.modelMode,
    customModel: nextCustom,
    intervalSec: normalizeInterval(input.intervalSec),
    prohibitedItems: selectedItems,
    customProhibitedItems: customItems,
    analysisMode: input.analysisMode === 'group' ? 'group' : 'single',
    groupSize: Math.round(clampNumber(input.groupSize, 2, 8)),
    localize: Boolean(input.localize),
    behaviorItems: normalizeBehaviorItems(input.behaviorItems),
    behaviorWindowSec: behaviorSampling.windowSec,
    behaviorStrideSec: behaviorSampling.strideSec,
    behaviorFps: behaviorSampling.fps
  }
  persistSettings(cachedSettings)
  return getPublicSettings()
}
