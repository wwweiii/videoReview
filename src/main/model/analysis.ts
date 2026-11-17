import { matchItem } from '@shared/items'
import type { TaskJudgmentImageOptions } from '@shared/image'
import type { CustomProhibitedItem, ModelCallTrace, RiskLevel } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { requestChat } from './client'
import { buildGroupMessages, buildSingleMessages } from './prompts'

export interface ParsedAnalysis {
  abnormal: boolean
  riskLevel: RiskLevel
  categories: string[]
  description: string
  evidence: string
  confidence: number | null
  needHumanReview: boolean
  raw: string
  traces: ModelCallTrace[]
}

export function extractJsonValue(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // 只提取最外层载荷；外层损坏时不把其中一个完整子对象误当成全部结果。
    const start = cleaned.search(/[\[{]/)
    if (start >= 0) {
      const stack: string[] = []
      let inString = false
      let escaped = false
      for (let index = start; index < cleaned.length; index += 1) {
        const char = cleaned[index]
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') inString = true
        else if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
          if (stack.pop() !== (char === '}' ? '{' : '[')) break
          if (stack.length === 0) {
            try {
              return JSON.parse(cleaned.slice(start, index + 1))
            } catch {
              break
            }
          }
        }
      }
    }
  }
  throw new Error('模型返回格式异常')
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', '1', '是', '异常', '有'].includes(normalized)) return true
    if (['false', 'no', '0', '否', '正常', '无'].includes(normalized)) return false
  }
  return null
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,，、;；]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeRisk(value: unknown, abnormal: boolean): RiskLevel {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['high', '高', '严重'].includes(text)) return 'high'
  if (['medium', '中', '中等'].includes(text)) return 'medium'
  if (['low', '低', '轻微'].includes(text)) return 'low'
  if (['none', '无', '正常'].includes(text)) return 'none'
  return abnormal ? 'medium' : 'none'
}

function normalizeConfidence(value: unknown): number | null {
  let number: number | null = null
  const percentage = typeof value === 'string' && value.trim().endsWith('%')
  if (typeof value === 'number') number = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text)) return null
    const parsed = Number(text.replace(/%$/, ''))
    if (Number.isFinite(parsed)) number = parsed
    if (number !== null && text.endsWith('%')) number /= 100
  }
  if (number === null || !Number.isFinite(number)) return null
  if (number > 1 && !percentage) number /= 100
  return number >= 0 && number <= 1 ? number : null
}

function normalizeCategories(value: unknown, customItems: CustomProhibitedItem[], itemIds?: string[]): {
  categories: string[]; inconsistent: boolean
} {
  const values = toStringArray(value)
  const result: string[] = []
  for (const raw of values) {
    const normalized = raw.trim()
    if (!normalized) continue
    const match = matchItem(normalized, itemIds, customItems)
    const known = match.itemId ? match.category : normalized.slice(0, 24)
    if (!result.includes(known)) result.push(known)
  }
  return {
    categories: result,
    inconsistent: values.some((label) => !matchItem(label, itemIds, customItems).itemId) ||
      !(typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string')))
  }
}

export function parseAnalysisObject(
  value: Record<string, unknown>,
  raw: string,
  customItems: CustomProhibitedItem[],
  itemIds?: string[]
): ParsedAnalysis {
  const abnormal = toBoolean(
    value.abnormal ??
      value.has_anomaly ??
      value.hasAbnormal ??
      value.is_abnormal ??
      value.anomaly_detected
  )
  if (abnormal === null) throw new Error('模型返回缺少判定结果')

  const needHumanReview =
    toBoolean(
      value.need_human_review ??
        value.needHumanReview ??
        value.needs_review ??
        value.requires_review
    ) ?? true

  const { categories, inconsistent } = normalizeCategories(
    value.categories ?? value.category ?? value.items ?? value.objects, customItems, itemIds
  )

  return {
    abnormal,
    riskLevel: normalizeRisk(value.risk_level ?? value.riskLevel, abnormal),
    categories: abnormal ? categories : [],
    description: firstString(
      value.description,
      value.anomaly_description,
      value.detail,
      value.summary
    ),
    evidence: firstString(value.evidence, value.reason, value.explanation, value.basis),
    confidence: normalizeConfidence(value.confidence ?? value.score),
    needHumanReview: needHumanReview || inconsistent || (abnormal ? categories.length === 0 : categories.length > 0),
    raw,
    traces: []
  }
}

function extractObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型返回格式异常')
  }
  return value as Record<string, unknown>
}

export async function analyzeSingleFrame(
  config: ResolvedModelConfig,
  itemIds: string[],
  customItems: CustomProhibitedItem[],
  filePath: string,
  timestampMs: number,
  signal?: AbortSignal,
  imageOptions?: TaskJudgmentImageOptions
): Promise<ParsedAnalysis> {
  let lastParseError: Error | null = null
  const allTraces: ModelCallTrace[] = []

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = () => buildSingleMessages(filePath, timestampMs, itemIds, customItems, imageOptions, signal)
    const { content, traces } = await requestChat(config, messages, {
      signal,
      requireComplete: true,
      operation: '物品判定'
    })
    allTraces.push(...traces)
    try {
      const parsed = extractJsonValue(content)
      const object = extractObject(parsed)
      if (Array.isArray(object.frames)) {
        const first = object.frames[0]
        if (object.frames.length !== 1) throw new Error('单帧请求返回了多个判定结果')
        return { ...parseAnalysisObject(extractObject(first), content, customItems, itemIds), traces: allTraces }
      }
      return { ...parseAnalysisObject(object, content, customItems, itemIds), traces: allTraces }
    } catch (error) {
      lastParseError = error instanceof Error ? error : new Error(String(error))
      if (attempt === 0) continue
    }
  }

  throw lastParseError ?? new Error('模型结果解析失败')
}

export async function analyzeFrameGroup(
  config: ResolvedModelConfig,
  itemIds: string[],
  customItems: CustomProhibitedItem[],
  frames: Array<{ filePath: string; timestampMs: number }>,
  signal?: AbortSignal,
  imageOptions?: TaskJudgmentImageOptions
): Promise<{ analyses: Map<number, ParsedAnalysis>; traces: ModelCallTrace[] }> {
  const messages = () => buildGroupMessages(frames, itemIds, customItems, imageOptions, signal)
  const { content, traces } = await requestChat(config, messages, {
    signal,
    requireComplete: true,
    operation: '物品分组判定'
  })

  return { analyses: parseFrameGroup(content, frames.length, customItems, itemIds, traces), traces }
}

/** 缺失、重复或编号不明确的结果不分配给任何帧，由调用方标记失败。 */
export function parseFrameGroup(
  content: string,
  frameCount: number,
  customItems: CustomProhibitedItem[] = [],
  itemIds?: string[],
  traces: ModelCallTrace[] = []
): Map<number, ParsedAnalysis> {
  const parsed = extractJsonValue(content)
  const root = Array.isArray(parsed) ? null : extractObject(parsed)
  const rawFrames = Array.isArray(parsed) ? parsed : root?.frames ?? root?.results
  const result = new Map<number, ParsedAnalysis>()
  const seen = new Set<number>()

  if (Array.isArray(rawFrames)) {
    const positional = rawFrames.length === frameCount && rawFrames.every((item) =>
      item && typeof item === 'object' && !('frame_index' in item) && !('index' in item))
    rawFrames.forEach((item, position) => {
      try {
        const object = extractObject(item)
        const indexValue = object.frame_index ?? object.index ?? (positional ? position : undefined)
        if (typeof indexValue !== 'number' && !(typeof indexValue === 'string' && /^\d+$/.test(indexValue))) return
        const index = Number(indexValue)
        if (!Number.isInteger(index) || index < 0 || index >= frameCount) return
        if (seen.has(index)) { result.delete(index); return }
        seen.add(index)
        result.set(index, { ...parseAnalysisObject(object, content, customItems, itemIds), traces })
      } catch {
        // A malformed item is treated as a missing result for that frame.
      }
    })
    return result
  }

  throw new Error('模型返回格式异常')
}

export function deriveVerdict(
  analysis: ParsedAnalysis,
  confidenceThreshold: number
): { verdict: 'normal' | 'abnormal' | 'review'; needHumanReview: boolean } {
  const lowConfidence =
    analysis.confidence === null || !Number.isFinite(analysis.confidence) ||
    analysis.confidence < confidenceThreshold || analysis.confidence > 1
  const missingEvidence = analysis.abnormal && (!analysis.evidence.trim() || analysis.categories.length === 0)
  const inconsistent = !analysis.abnormal && analysis.categories.length > 0
  const review = analysis.needHumanReview || lowConfidence || missingEvidence || inconsistent
  return {
    verdict: review ? 'review' : analysis.abnormal ? 'abnormal' : 'normal',
    needHumanReview: review
  }
}
