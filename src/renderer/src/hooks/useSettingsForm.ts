import { useState } from 'react'
import { normalizeImageScalePercent, normalizeJudgmentImage } from '@shared/image'
import { normalizeInterval } from '@shared/format'
import { MAX_CUSTOM_ITEM_LABEL_LENGTH, MAX_CUSTOM_PROHIBITED_ITEMS } from '@shared/defaults'
import { BUILTIN_PROHIBITED_ITEMS, labelMatchesItem, normalizeCustomItems, normalizeSelectedItems, resolveProhibitedItems } from '@shared/items'
import { MAX_BEHAVIOR_ITEMS, MAX_BEHAVIOR_LABEL_LENGTH } from '@shared/defaults'
import { normalizeBehaviorItems, normalizeBehaviorSampling } from '@shared/behavior'
import type { BoxOrder, CoordinateSpace } from '@shared/localization'
import type {
  AnalysisMode,
  CustomModelInput,
  CustomProhibitedItem,
  BehaviorItem,
  PublicSettings,
  SaveSettingsInput
} from '@shared/types'
import type { ShowToast } from '../lib/ui'

/**
 * 设置页表单状态与纯动作：模型/分析/检测物品/行为采样字段、启用物品的添加与取消、
 * 自动保存/测试/探测共用的请求体组装。
 *
 * 网络请求（自动保存/测试/探测）留在 SettingsPage，便于容器统一管理加载与结果状态。
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
  const [requestConcurrency, setRequestConcurrency] = useState(settings.requestConcurrency)
  const [judgmentImage, setJudgmentImage] = useState(settings.judgmentImage)
  const [baseUrl, setBaseUrl] = useState(settings.customModel.baseUrl)
  const [modelName, setModelName] = useState(settings.customModel.model)
  const [apiKey, setApiKey] = useState('')
  const [extraBody, setExtraBody] = useState(settings.customModel.extraBody)
  const [coordinateSpaceOverride, setCoordinateSpaceOverride] = useState<'auto' | CoordinateSpace>(
    settings.customModel.coordinateSpaceOverride
  )
  const [boxOrderOverride, setBoxOrderOverride] = useState<'auto' | BoxOrder>(
    settings.customModel.boxOrderOverride
  )
  const [developerMode, setDeveloperMode] = useState(settings.developerMode)
  const [traceEnabled, setTraceEnabled] = useState(settings.traceEnabled)
  const [intervalSec, setIntervalSec] = useState(settings.intervalSec)
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(settings.analysisMode)
  const [groupSize, setGroupSize] = useState(settings.groupSize)
  const [localize, setLocalize] = useState(settings.localize)
  const [items, setItems] = useState<string[]>(settings.prohibitedItems)
  const [customItems, setCustomItems] = useState<CustomProhibitedItem[]>(
    settings.customProhibitedItems.filter((item) => settings.prohibitedItems.includes(item.id))
  )
  const [customItemLabel, setCustomItemLabel] = useState('')
  const [behaviorItems, setBehaviorItems] = useState<BehaviorItem[]>(settings.behaviorItems)
  const [behaviorLabel, setBehaviorLabel] = useState('')
  const [behaviorWindowSec, setBehaviorWindowSec] = useState(settings.behaviorWindowSec)
  const [behaviorStrideSec, setBehaviorStrideSec] = useState(settings.behaviorStrideSec)
  const [behaviorFps, setBehaviorFps] = useState(settings.behaviorFps)
  const [behaviorImageScalePercent, setBehaviorImageScalePercent] = useState(settings.behaviorImageScalePercent)

  const customValid = (() => {
    if (!baseUrl.trim() || !modelName.trim()) return false
    try {
      const url = new URL(baseUrl.trim())
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  })()
  const activeItems = resolveProhibitedItems(items, customItems)

  function addCustomItem(): void {
    const label = customItemLabel.trim()
    if (!label) return
    if (label.length > MAX_CUSTOM_ITEM_LABEL_LENGTH) {
      showToast('error', `物品名称不能超过 ${MAX_CUSTOM_ITEM_LABEL_LENGTH} 个字`)
      return
    }
    const builtin = BUILTIN_PROHIBITED_ITEMS.find((item) => labelMatchesItem(label, item))
    if (builtin) {
      if (items.includes(builtin.id)) {
        showToast('error', '该物品已存在')
        return
      }
      setItems((previous) => [...previous, builtin.id])
      setCustomItemLabel('')
      return
    }
    if (customItems.length >= MAX_CUSTOM_PROHIBITED_ITEMS) {
      showToast('error', `最多添加 ${MAX_CUSTOM_PROHIBITED_ITEMS} 个自定义物品`)
      return
    }
    const normalized = normalizeCustomItems([...customItems, { id: '', label }])
    if (normalized.length <= customItems.length) {
      setCustomItemLabel('')
      showToast('error', '该物品已存在')
      return
    }
    const added = normalized[normalized.length - 1]
    setCustomItems(normalized)
    setItems((previous) => [...previous, added.id])
    setCustomItemLabel('')
  }

  function removeItem(itemId: string): void {
    setCustomItems((previous) => previous.filter((item) => item.id !== itemId))
    setItems((previous) => previous.filter((id) => id !== itemId))
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
      extraBody: extraBody.trim(),
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
      requestConcurrency,
      judgmentImage: normalizeJudgmentImage(judgmentImage),
      customModel: buildCustomModel(),
      developerMode,
      traceEnabled,
      intervalSec: normalizeInterval(intervalSec),
      prohibitedItems: normalizeSelectedItems(items, customItems),
      customProhibitedItems: customItems,
      behaviorItems,
      analysisMode,
      groupSize,
      localize,
      behaviorWindowSec: sampling.windowSec,
      behaviorStrideSec: sampling.strideSec,
      behaviorFps: sampling.fps,
      behaviorImageScalePercent: normalizeImageScalePercent(behaviorImageScalePercent)
    }
  }

  return {
    requestConcurrency, setRequestConcurrency,
    judgmentImage, setJudgmentImage,
    modelMode,
    setModelMode,
    baseUrl,
    setBaseUrl,
    modelName,
    setModelName,
    apiKey,
    setApiKey,
    extraBody,
    setExtraBody,
    coordinateSpaceOverride,
    setCoordinateSpaceOverride,
    boxOrderOverride,
    setBoxOrderOverride,
    developerMode,
    setDeveloperMode,
    traceEnabled,
    setTraceEnabled,
    intervalSec,
    setIntervalSec,
    analysisMode,
    setAnalysisMode,
    groupSize,
    setGroupSize,
    localize,
    setLocalize,
    activeItems,
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
    behaviorImageScalePercent,
    setBehaviorImageScalePercent,
    addBehaviorItem,
    removeBehaviorItem,
    customValid,
    addCustomItem,
    removeItem,
    buildCustomModel,
    validateExtraBody,
    buildSavePayload
  }
}

export type SettingsForm = ReturnType<typeof useSettingsForm>
