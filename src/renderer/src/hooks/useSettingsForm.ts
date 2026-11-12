import { useState } from 'react'
import { clampNumber, normalizeInterval } from '@shared/format'
import { MAX_CUSTOM_ITEM_LABEL_LENGTH, MAX_CUSTOM_PROHIBITED_ITEMS } from '@shared/defaults'
import { DEFAULT_PROHIBITED_ITEMS, normalizeCustomItems } from '@shared/items'
import { MAX_BEHAVIOR_ITEMS, MAX_BEHAVIOR_LABEL_LENGTH } from '@shared/defaults'
import { normalizeBehaviorItems, normalizeBehaviorSampling } from '@shared/behavior'
import type { BoxOrder, CoordinateSpace, PromptLanguage } from '@shared/localization'
import type {
  AnalysisMode,
  CustomModelInput,
  CustomProhibitedItem,
  BehaviorItem,
  PublicSettings,
  SaveSettingsInput
} from '@shared/types'
import type { ShowToast } from '../lib/ui'

function normalizeMaxTokens(value: number): number {
  return Math.round(clampNumber(value, 128, 32768))
}

/**
 * 设置页表单状态与纯动作：模型/分析/检测物品/行为采样字段、自定义物品增删勾选、
 * 保存/测试/探测共用的请求体组装。
 *
 * 网络请求（保存/测试/探测）留在 SettingsPage，便于容器统一管理加载与结果状态。
 */
export function useSettingsForm({
  settings,
  showToast
}: {
  settings: PublicSettings
  showToast: ShowToast
}) {
  const [modelMode, setModelMode] = useState<'preset' | 'custom'>(
    settings.presetAvailable ? settings.modelMode : 'custom'
  )
  const [baseUrl, setBaseUrl] = useState(settings.customModel.baseUrl)
  const [modelName, setModelName] = useState(settings.customModel.model)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [extraBody, setExtraBody] = useState(settings.customModel.extraBody)
  const [maxTokens, setMaxTokens] = useState(settings.customModel.maxTokens)
  const [imageMaxEdge, setImageMaxEdge] = useState(settings.customModel.imageMaxEdge)
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>(
    settings.customModel.imageFormat
  )
  const [promptLanguage, setPromptLanguage] = useState<PromptLanguage>(
    settings.customModel.promptLanguage
  )
  const [coordinateSpaceOverride, setCoordinateSpaceOverride] = useState<'auto' | CoordinateSpace>(
    settings.customModel.coordinateSpaceOverride
  )
  const [boxOrderOverride, setBoxOrderOverride] = useState<'auto' | BoxOrder>(
    settings.customModel.boxOrderOverride
  )
  const [intervalSec, setIntervalSec] = useState(settings.intervalSec)
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(settings.analysisMode)
  const [groupSize, setGroupSize] = useState(settings.groupSize)
  const [localize, setLocalize] = useState(settings.localize)
  const [items, setItems] = useState<string[]>(settings.prohibitedItems)
  const [customItems, setCustomItems] = useState<CustomProhibitedItem[]>(
    settings.customProhibitedItems
  )
  const [customItemLabel, setCustomItemLabel] = useState('')
  const [behaviorItems, setBehaviorItems] = useState<BehaviorItem[]>(settings.behaviorItems)
  const [behaviorLabel, setBehaviorLabel] = useState('')
  const [behaviorWindowSec, setBehaviorWindowSec] = useState(settings.behaviorWindowSec)
  const [behaviorStrideSec, setBehaviorStrideSec] = useState(settings.behaviorStrideSec)
  const [behaviorFps, setBehaviorFps] = useState(settings.behaviorFps)

  const customValid = Boolean(baseUrl.trim() && modelName.trim())
  const selectedCustomIds = customItems
    .filter((item) => items.includes(item.id))
    .map((item) => item.id)

  function addCustomItem(): void {
    const label = customItemLabel.trim()
    if (!label) return
    if (label.length > MAX_CUSTOM_ITEM_LABEL_LENGTH) {
      showToast('error', `物品名称不能超过 ${MAX_CUSTOM_ITEM_LABEL_LENGTH} 个字`)
      return
    }
    if (customItems.length >= MAX_CUSTOM_PROHIBITED_ITEMS) {
      showToast('error', `最多添加 ${MAX_CUSTOM_PROHIBITED_ITEMS} 个自定义物品`)
      return
    }
    const normalized = normalizeCustomItems([...customItems, { id: '', label }])
    if (normalized.length <= customItems.length) {
      setCustomItemLabel('')
      showToast('error', '该名称与内置物品重复，或已存在')
      return
    }
    const added = normalized[normalized.length - 1]
    setCustomItems(normalized)
    setItems((previous) => [...previous, added.id])
    setCustomItemLabel('')
  }

  function removeCustomItem(itemId: string): void {
    setCustomItems((previous) => previous.filter((item) => item.id !== itemId))
    setItems((previous) => previous.filter((id) => id !== itemId))
  }

  function toggleCustomItem(itemId: string): void {
    setItems((previous) =>
      previous.includes(itemId)
        ? previous.filter((id) => id !== itemId)
        : [...previous, itemId]
    )
  }

  function addBehaviorItem(): void {
    const label = behaviorLabel.trim()
    if (!label) return
    if (label.length > MAX_BEHAVIOR_LABEL_LENGTH) {
      showToast('error', `行为名称不能超过 ${MAX_BEHAVIOR_LABEL_LENGTH} 个字`)
      return
    }
    if (behaviorItems.length >= MAX_BEHAVIOR_ITEMS) {
      showToast('error', `最多添加 ${MAX_BEHAVIOR_ITEMS} 个行为`)
      return
    }
    const next = normalizeBehaviorItems([...behaviorItems, { id: '', label }])
    if (next.length <= behaviorItems.length) {
      showToast('error', '该行为已存在')
      return
    }
    setBehaviorItems(next)
    setBehaviorLabel('')
  }

  function removeBehaviorItem(itemId: string): void {
    setBehaviorItems((previous) => previous.filter((item) => item.id !== itemId))
  }

  function buildCustomModel(): CustomModelInput {
    return {
      baseUrl: baseUrl.trim(),
      model: modelName.trim(),
      apiKey: apiKey.trim() || undefined,
      clearApiKey,
      extraBody: extraBody.trim(),
      maxTokens: normalizeMaxTokens(maxTokens),
      imageMaxEdge,
      imageFormat,
      promptLanguage,
      coordinateSpaceOverride,
      boxOrderOverride,
      parseDialectOverride: settings.customModel.parseDialectOverride
    }
  }

  /** 额外请求体必须是 JSON 对象；非法时不发保存请求 */
  function validateExtraBody(): boolean {
    const text = extraBody.trim()
    if (!text) return true
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        showToast('error', '额外请求体必须是 JSON 对象')
        return false
      }
      return true
    } catch {
      showToast('error', '额外请求体不是合法 JSON')
      return false
    }
  }

  function buildSavePayload(): SaveSettingsInput {
    // 采样参数统一走 shared 归一化，避免渲染层与主进程的校验规则漂移
    const sampling = normalizeBehaviorSampling({
      windowSec: behaviorWindowSec,
      strideSec: behaviorStrideSec,
      fps: behaviorFps
    })
    return {
      modelMode,
      customModel: buildCustomModel(),
      intervalSec: normalizeInterval(intervalSec),
      // 内置四项固定包含，只追加选中的自定义物品
      prohibitedItems: [
        ...DEFAULT_PROHIBITED_ITEMS,
        ...selectedCustomIds.filter((id) => !DEFAULT_PROHIBITED_ITEMS.includes(id))
      ],
      customProhibitedItems: customItems,
      behaviorItems,
      analysisMode,
      groupSize,
      localize,
      behaviorWindowSec: sampling.windowSec,
      behaviorStrideSec: sampling.strideSec,
      behaviorFps: sampling.fps
    }
  }

  return {
    modelMode,
    setModelMode,
    baseUrl,
    setBaseUrl,
    modelName,
    setModelName,
    apiKey,
    setApiKey,
    clearApiKey,
    setClearApiKey,
    extraBody,
    setExtraBody,
    maxTokens,
    setMaxTokens,
    imageMaxEdge,
    setImageMaxEdge,
    imageFormat,
    setImageFormat,
    promptLanguage,
    setPromptLanguage,
    coordinateSpaceOverride,
    setCoordinateSpaceOverride,
    boxOrderOverride,
    setBoxOrderOverride,
    intervalSec,
    setIntervalSec,
    analysisMode,
    setAnalysisMode,
    groupSize,
    setGroupSize,
    localize,
    setLocalize,
    items,
    customItems,
    customItemLabel,
    setCustomItemLabel,
    behaviorItems,
    behaviorLabel,
    setBehaviorLabel,
    behaviorWindowSec,
    setBehaviorWindowSec,
    behaviorStrideSec,
    setBehaviorStrideSec,
    behaviorFps,
    setBehaviorFps,
    addBehaviorItem,
    removeBehaviorItem,
    customValid,
    selectedCustomIds,
    addCustomItem,
    removeCustomItem,
    toggleCustomItem,
    buildCustomModel,
    validateExtraBody,
    buildSavePayload
  }
}

export type SettingsForm = ReturnType<typeof useSettingsForm>
