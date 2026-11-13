import type { BoxOrder, CoordinateSpace, ParseDialect } from '@shared/localization/profile'
import type { PromptLanguage } from '@shared/localization/prompts'
import type { ModelMode, TestModelInput } from '@shared/types'
import { getPresetConfig } from './preset'
import {
  DEFAULT_MODEL_RUNTIME,
  applyRuntimeOverrides,
  loadSettings,
  normalizeRuntimeModel,
  readSavedApiKey,
  validateCustomModel
} from './settings'

export interface ResolvedModelConfig {
  mode: ModelMode
  label: string
  baseUrl: string
  model: string
  apiKey: string
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

function resolvePreset(): ResolvedModelConfig {
  const preset = getPresetConfig()
  if (!preset) throw new Error('预设模型不可用')
  const runtime = normalizeRuntimeModel({
    extraBody: preset.extraBody,
    maxTokens: preset.maxTokens,
    imageMaxEdge: preset.imageMaxEdge,
    imageFormat: preset.imageFormat,
    promptLanguage: preset.promptLanguage,
    coordinateSpaceOverride: preset.coordinateSpaceOverride,
    boxOrderOverride: preset.boxOrderOverride,
    parseDialectOverride: preset.parseDialectOverride
  })
  return {
    mode: 'preset',
    label: '预设',
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: preset.apiKey,
    concurrency: preset.concurrency,
    timeoutSec: preset.timeoutSec,
    extraHeaders: preset.extraHeaders,
    ...runtime
  }
}

export function getResolvedModelConfig(): ResolvedModelConfig {
  const stored = loadSettings()
  if (stored.modelMode === 'preset') return resolvePreset()
  validateCustomModel({
    baseUrl: stored.customModel.baseUrl,
    model: stored.customModel.model
  })
  return {
    mode: 'custom',
    label: stored.customModel.model,
    baseUrl: stored.customModel.baseUrl,
    model: stored.customModel.model,
    apiKey: readSavedApiKey(stored.customModel),
    concurrency: stored.customModel.concurrency,
    timeoutSec: stored.customModel.timeoutSec,
    extraHeaders: stored.customModel.extraHeaders,
    extraBody: stored.customModel.extraBody,
    maxTokens: stored.customModel.maxTokens,
    imageMaxEdge: stored.customModel.imageMaxEdge,
    imageFormat: stored.customModel.imageFormat,
    promptLanguage: stored.customModel.promptLanguage,
    coordinateSpaceOverride: stored.customModel.coordinateSpaceOverride,
    boxOrderOverride: stored.customModel.boxOrderOverride,
    parseDialectOverride: stored.customModel.parseDialectOverride
  }
}

export function getResolvedModelConfigForTesting(input: TestModelInput): ResolvedModelConfig {
  if (input.modelMode === 'preset') return resolvePreset()
  validateCustomModel(input.customModel)
  const stored = loadSettings()
  const apiKey = input.customModel.apiKey?.trim() || readSavedApiKey(stored.customModel)
  const runtime = applyRuntimeOverrides(input.customModel, {
    ...DEFAULT_MODEL_RUNTIME,
    ...stored.customModel
  })
  return {
    mode: 'custom',
    label: input.customModel.model.trim(),
    baseUrl: input.customModel.baseUrl.trim(),
    model: input.customModel.model.trim(),
    apiKey,
    concurrency: stored.customModel.concurrency,
    timeoutSec: stored.customModel.timeoutSec,
    extraHeaders: stored.customModel.extraHeaders,
    ...runtime
  }
}
