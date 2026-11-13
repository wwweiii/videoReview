import { nativeImage } from 'electron'
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
  imageMaxEdge: number
  imageFormat: 'png' | 'jpeg'
}

export interface PreparedImage {
  dataUrl: string
  sentWidth: number
  sentHeight: number
  originWidth: number
  originHeight: number
}

const MULTIPLE = 28

function roundToMultiple(value: number): number {
  return Math.max(MULTIPLE, Math.floor(value / MULTIPLE) * MULTIPLE)
}

/** 定位请求的默认图片长边：传原图（0）时也降到该值，保证速度与坐标标定一致 */
const DEFAULT_LOCALIZE_MAX_EDGE = 1120

/** 读取帧图片，按配置缩放并编码为 data URL */
export function prepareImage(framePath: string, options: PrepareImageOptions): PreparedImage {
  const image = nativeImage.createFromPath(framePath)
  if (image.isEmpty()) throw new Error('无法读取帧图片')
  const origin = image.getSize()
  let width = origin.width
  let height = origin.height

  // 注意：定位阶段始终按"已知尺寸"发送（0 = 自动 1120），
  // 否则外部网关内部 resize 会让 absolute_px 标定失效，而且上传很慢。
  const maxEdge = options.imageMaxEdge > 0 ? options.imageMaxEdge : DEFAULT_LOCALIZE_MAX_EDGE
  if (Math.max(width, height) > maxEdge) {
    const scale = maxEdge / Math.max(width, height)
    width = roundToMultiple(Math.round(width * scale))
    height = roundToMultiple(Math.round(height * scale))
  }

  const resized =
    width === origin.width && height === origin.height
      ? image
      : image.resize({ width, height, quality: 'good' })

  const buffer = options.imageFormat === 'jpeg' ? resized.toJPEG(85) : resized.toPNG()
  const mime = options.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png'

  return {
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    sentWidth: width,
    sentHeight: height,
    originWidth: origin.width,
    originHeight: origin.height
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
  const prepared = prepareImage(input.framePath, {
    imageMaxEdge: config.imageMaxEdge,
    imageFormat: config.imageFormat
  })

  const focusLabels = focusLabelsForFrame(input.focusCategories, input.itemIds, customItems)

  const { system, user } = buildLocalizeMessages({
    language: config.promptLanguage,
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
    maxTokens: Math.max(config.maxTokens, 1200),
    timeoutSec: Math.min(config.timeoutSec, 60),
    signal,
    operation: '违禁物定位'
  })

  // 先用"发送尺寸"解析；absolute_px 下部分网关会按原图像素返回，自动按原图尺寸兜底
  const parsed = parseGrounding(content, profile.parseDialects.slice(0, MAX_PARSE_DIALECTS))
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
