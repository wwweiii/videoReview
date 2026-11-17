import { nativeImage } from 'electron'
import { normalizeImageScalePercent } from '@shared/image'
import { imageDataUrl } from '../media/images'
import { formatTimeMs } from '@shared/format'
import { matchItem, resolveProhibitedItems } from '@shared/items'
import type { ChatContentPart, ChatMessage } from '@shared/localization/request'
import { buildLocalizeMessages } from '@shared/localization/prompts'
import type { ModelProfile } from '@shared/localization/profile'
import {
  dedupeBoxes,
  mapRawBoxesAdaptive,
  parseGrounding,
  validateBox
} from '@shared/localization/dialects'
import type { CustomProhibitedItem, ModelCallTrace, RegionRecord } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { logger } from '../logger'
import { requestChat } from '../model/client'
import { LocalizationUnavailableError } from './probe'

export interface PrepareImageOptions {
  imageScalePercent: number
}

export interface PreparedImage {
  dataUrl: string
  sentWidth: number
  sentHeight: number
  originWidth: number
  originHeight: number
}

/** 按原始画面比例缩放并保留 PNG/JPEG 格式，100% 直接复用原始数据。 */
export async function prepareImage(framePath: string, options: PrepareImageOptions, signal?: AbortSignal): Promise<PreparedImage> {
  const originalUrl = await imageDataUrl(framePath, undefined, signal)
  const original = nativeImage.createFromBuffer(Buffer.from(originalUrl.split(',')[1], 'base64'))
  if (original.isEmpty()) throw new Error('无法读取帧图片')
  const origin = original.getSize()
  const scalePercent = normalizeImageScalePercent(options.imageScalePercent)
  const dataUrl = scalePercent === 100
    ? originalUrl
    : await imageDataUrl(framePath, { scalePercent }, signal)
  const sent = scalePercent === 100 ? origin
    : nativeImage.createFromBuffer(Buffer.from(dataUrl.split(',')[1], 'base64')).getSize()
  return {
    dataUrl, sentWidth: sent.width, sentHeight: sent.height,
    originWidth: origin.width, originHeight: origin.height
  }
}

function configuredItemLabels(
  itemIds: string[],
  customItems: CustomProhibitedItem[] = []
): string[] {
  return resolveProhibitedItems(itemIds, customItems).map((item) => item.label)
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface LocalizeFrameInput {
  framePath: string
  timestampMs: number
  /** 物品任务中与判定共用的缩放比例。 */
  imageScalePercent?: number
  itemIds: string[]
  /** 自定义违禁物（任务创建时的快照） */
  customItems?: CustomProhibitedItem[]
  /** 本帧异常判定已确认的类别，用于约束"只定位判定的对象" */
  focusCategories?: string[]
}

export interface LocalizeFrameResult {
  regions: RegionRecord[]
  raw: string
  dialect: string
  prepared: PreparedImage
  /** 传给模型的"本帧只定位这些"标签 */
  focusLabels: string[]
  /** 因与判定对象不一致被过滤掉的框数 */
  filteredOut: number
  /** 坐标疑似按原图像素返回，已按原图尺寸换算 */
  usedOriginGrid: boolean
  traces: ModelCallTrace[]
}

const MAX_PARSE_DIALECTS = 4

function focusLabelsForFrame(
  categories: string[] | undefined,
  itemIds: string[],
  customItems: CustomProhibitedItem[]
): string[] {
  if (!categories || categories.length === 0) return []
  const labels: string[] = []
  for (const category of categories) {
    const trimmed = category.trim()
    if (!trimmed) continue
    const match = matchItem(trimmed, itemIds, customItems)
    // 只约束到"本次实际勾选的检测物品"上；判定里的其他文字不参与定位约束
    if (!match.itemId) continue
    if (match.category && !labels.includes(match.category)) labels.push(match.category)
  }
  return labels
}

function boxMatchesFocus(
  rawLabel: string,
  category: string,
  focusLabels: string[],
  itemIds: string[],
  customItems: CustomProhibitedItem[]
): boolean {
  if (focusLabels.length === 0) return true
  const normalized = new Set(focusLabels.map((label) => normalizeLabel(label)))
  const candidates = [normalizeLabel(rawLabel), normalizeLabel(category)]
  const matched = matchItem(rawLabel, itemIds, customItems)
  if (matched.category) candidates.push(normalizeLabel(matched.category))
  return [...normalized].some((focus) =>
    candidates.some(
      (candidate) => candidate === focus || candidate.includes(focus) || focus.includes(candidate)
    )
  )
}

export async function localizeFrame(
  config: ResolvedModelConfig,
  profile: ModelProfile,
  input: LocalizeFrameInput,
  signal?: AbortSignal
): Promise<LocalizeFrameResult> {
  if (!profile.localizationOk || profile.coordinateSpace === 'unknown') {
    throw new LocalizationUnavailableError('当前模型不支持位置输出')
  }

  const customItems = input.customItems ?? []
  const prepared = await prepareImage(input.framePath, { imageScalePercent: normalizeImageScalePercent(input.imageScalePercent) }, signal)

  const focusLabels = focusLabelsForFrame(input.focusCategories, input.itemIds, customItems)

  const { system, user } = buildLocalizeMessages({
    space: profile.coordinateSpace,
    sentWidth: prepared.sentWidth,
    sentHeight: prepared.sentHeight,
    scene: '视频',
    itemLabels: configuredItemLabels(input.itemIds, customItems),
    focusLabels,
    timestampText: formatTimeMs(input.timestampMs)
  })

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: user },
        { type: 'image_url', image_url: { url: prepared.dataUrl } }
      ] as ChatContentPart[]
    }
  ]

  const { content, traces } = await requestChat(config, messages, {
    timeoutSec: Math.min(config.timeoutSec, 60),
    signal,
    requireComplete: true,
    operation: '违禁物定位'
  })

  // 先用"发送尺寸"解析；absolute_px 下部分网关会按原图像素返回，自动按原图尺寸兜底
  const parsed = parseGrounding(content, profile.parseDialects.slice(0, MAX_PARSE_DIALECTS))
  if (!parsed.valid) throw new Error('定位结果无法解析，请重试定位')
  const adaptive = mapRawBoxesAdaptive(parsed.boxes, {
    space: profile.coordinateSpace,
    order: profile.boxOrder,
    sentWidth: prepared.sentWidth,
    sentHeight: prepared.sentHeight,
    originWidth: prepared.originWidth,
    originHeight: prepared.originHeight,
    scaleX: profile.scaleX,
    scaleY: profile.scaleY
  })
  const mapped = adaptive.mapped
  if (parsed.boxes.length > 0 && mapped.length === 0) {
    throw new Error('定位结果中的坐标无效，请检查坐标配置后重试')
  }
  if (adaptive.usedOrigin) {
    logger.warn('定位坐标疑似按原图像素返回，已自动换算', {
      sent: `${prepared.sentWidth}x${prepared.sentHeight}`,
      origin: `${prepared.originWidth}x${prepared.originHeight}`,
      boxes: parsed.boxes.length
    })
  }

  const withMatches = mapped.map((item) => {
    const match = matchItem(item.label, input.itemIds, customItems)
    return {
      rawLabel: item.label,
      itemId: match.itemId,
      category: match.category,
      box: validateBox(item.box) ?? item.box,
      confidence: item.confidence,
      matchesFocus: boxMatchesFocus(item.label, match.category, focusLabels, input.itemIds, customItems)
    }
  })

  const filtered = withMatches.filter((item) => item.matchesFocus)
  const filteredOut = withMatches.length - filtered.length

  // 同类别高 IoU 去重（保留置信度高者），默认不限制每帧框数
  const sorted = [...filtered].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  const kept = dedupeBoxes(
    sorted.map((item) => ({ ...item, label: item.category })),
    Number.POSITIVE_INFINITY,
    0.6
  )

  const regions: RegionRecord[] = kept.map((item, index) => ({
    id: `${Math.round(input.timestampMs)}-${index}`,
    itemId: item.itemId,
    category: item.category,
    box: item.box,
    confidence: item.confidence,
    source: 'model',
    verified: null,
    suspicious: false,
    level: 'L3',
    locatedBy: 'vlm',
    note: ''
  }))

  return {
    regions,
    raw: content.slice(0, 4000),
    dialect: parsed.dialect,
    prepared,
    focusLabels,
    filteredOut,
    usedOriginGrid: adaptive.usedOrigin,
    traces
  }
}
