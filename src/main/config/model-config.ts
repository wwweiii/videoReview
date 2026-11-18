import type { BoxOrder, CoordinateSpace, ParseDialect } from '@shared/localization/profile'
import type { ModelMode, TestModelInput } from '@shared/types'
import { getPresetConfig } from './preset'
import {
  DEFAULT_MODEL_RUNTIME,
  applyRuntimeOverrides,
  loadSettings,
  normalizeRuntimeModel,
  readSavedApiKey,
  validateCustomModel,
  type StoredSettings
} from './settings'

export interface ResolvedModelConfig {
  mode: ModelMode
  label: string
  developerMode: boolean
  traceEnabled: boolean
  baseUrl: string
  model: string
  apiKey: string
  concurrency: number
  timeoutSec: number
  extraHeaders: string
  extraBody: string
  coordinateSpaceOverride: 'auto' | CoordinateSpace
  boxOrderOverride: 'auto' | BoxOrder
  parseDialectOverride: 'auto' | ParseDialect
}

/** 收起高级设置时保留草稿，并使用默认请求体和坐标配置。 */
function runtimeForMode(source: Parameters<typeof normalizeRuntimeModel>[0], developerMode: boolean) {
  return developerMode ? normalizeRuntimeModel(source) : {
    extraBody: '',
    coordinateSpaceOverride: 'auto' as const,
    boxOrderOverride: 'auto' as const,
    parseDialectOverride: 'auto' as const
  }
}

function resolvePreset(
  stored: StoredSettings,
  developerMode = stored.developerMode,
  traceEnabled = stored.traceEnabled
): ResolvedModelConfig {
  const preset = getPresetConfig()
  if (!preset) throw new Error('预设模型不可用')
  const runtime = runtimeForMode({
    extraBody: preset.extraBody,
    coordinateSpaceOverride: preset.coordinateSpaceOverride,
    boxOrderOverride: preset.boxOrderOverride,
    parseDialectOverride: preset.parseDialectOverride
  }, developerMode)
  return {
    mode: 'preset',
    label: '预设',
    developerMode,
    traceEnabled: developerMode && traceEnabled,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: preset.apiKey,
    concurrency: stored.requestConcurrency,
    timeoutSec: preset.timeoutSec,
    extraHeaders: preset.extraHeaders,
    ...runtime
  }
}

export function getResolvedModelConfig(): ResolvedModelConfig {
  const stored = loadSettings()
  if (stored.modelMode === 'preset') return resolvePreset(stored)
  validateCustomModel({
    baseUrl: stored.customModel.baseUrl,
    model: stored.customModel.model
  })
  return {
    mode: 'custom',
    label: stored.customModel.model,
    developerMode: stored.developerMode,
    traceEnabled: stored.developerMode && stored.traceEnabled,
    baseUrl: stored.customModel.baseUrl,
    model: stored.customModel.model,
    apiKey: readSavedApiKey(stored.customModel),
    concurrency: stored.requestConcurrency,
    timeoutSec: stored.customModel.timeoutSec,
    extraHeaders: stored.customModel.extraHeaders,
    ...runtimeForMode(stored.customModel, stored.developerMode)
  }
}

export function getResolvedModelConfigForTesting(input: TestModelInput): ResolvedModelConfig {
  const stored = loadSettings()
  const developerMode = input.developerMode ?? stored.developerMode
  const traceEnabled = input.traceEnabled ?? stored.traceEnabled
  if (input.modelMode === 'preset') return resolvePreset(stored, developerMode, traceEnabled)
  validateCustomModel(input.customModel)
  const apiKey = input.customModel.apiKey?.trim() || readSavedApiKey(stored.customModel)
  const runtime = runtimeForMode(applyRuntimeOverrides(input.customModel, {
    ...DEFAULT_MODEL_RUNTIME,
    ...stored.customModel
  }), developerMode)
  return {
    mode: 'custom',
    label: input.customModel.model.trim(),
    developerMode,
    traceEnabled: developerMode && traceEnabled,
    baseUrl: input.customModel.baseUrl.trim(),
    model: input.customModel.model.trim(),
    apiKey,
    concurrency: stored.requestConcurrency,
    timeoutSec: stored.customModel.timeoutSec,
    extraHeaders: stored.customModel.extraHeaders,
    ...runtime
  }
}
