import { canonicalizeItemLabel } from '@shared/items'
import type { CustomProhibitedItem, RiskLevel } from '@shared/types'
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
    // Find the most likely JSON payload using bracket balancing.
    for (const opener of ['{', '[']) {
      const start = cleaned.indexOf(opener)
      if (start < 0) continue
      const closer = opener === '{' ? '}' : ']'
      let depth = 0
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
        else if (char === opener) depth += 1
        else if (char === closer) {
          depth -= 1
          if (depth === 0) {
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
  if (typeof value === 'number') return value !== 0
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
  if (typeof value === 'number') number = value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace('%', ''))
    if (Number.isFinite(parsed)) number = parsed
  }
  if (number === null || !Number.isFinite(number)) return null
  if (number > 1) number /= 100
  return Math.min(1, Math.max(0, number))
}

function normalizeCategories(value: unknown, customItems: CustomProhibitedItem[]): string[] {
  const values = toStringArray(value)
  const result: string[] = []
  for (const raw of values) {
    const normalized = raw.trim()
    if (!normalized) continue
    const known = canonicalizeItemLabel(normalized, customItems)
    if (!result.includes(known)) result.push(known)
  }
  return result
}

function parseAnalysisObject(
  value: Record<string, unknown>,
  raw: string,
  customItems: CustomProhibitedItem[]
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
    ) ?? false

  return {
    abnormal,
    riskLevel: normalizeRisk(value.risk_level ?? value.riskLevel, abnormal),
    categories: abnormal
      ? normalizeCategories(
          value.categories ?? value.category ?? value.items ?? value.objects,
          customItems
        )
      : [],
    description: firstString(
      value.description,
      value.anomaly_description,
      value.detail,
      value.summary
    ),
    evidence: firstString(value.evidence, value.reason, value.explanation, value.basis),
    confidence: normalizeConfidence(value.confidence ?? value.score),
    needHumanReview,
    raw
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
  signal?: AbortSignal
): Promise<ParsedAnalysis> {
  let lastParseError: Error | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = buildSingleMessages(filePath, timestampMs, itemIds, customItems)
    const { content } = await requestChat(config, messages, { signal })
    try {
      const parsed = extractJsonValue(content)
      const object = extractObject(parsed)
      if (Array.isArray(object.frames)) {
        const first = object.frames[0]
        return parseAnalysisObject(extractObject(first), content, customItems)
      }
      return parseAnalysisObject(object, content, customItems)
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
  signal?: AbortSignal
): Promise<Map<number, ParsedAnalysis>> {
  const messages = buildGroupMessages(frames, itemIds, customItems)
  const { content } = await requestChat(config, messages, {
    maxTokens: Math.max(700, frames.length * 350),
    signal
  })

  const parsed = extractJsonValue(content)
  const root = extractObject(parsed)
  const rawFrames = root.frames ?? root.results
  const result = new Map<number, ParsedAnalysis>()

  if (Array.isArray(rawFrames)) {
    rawFrames.forEach((item, position) => {
      try {
        const object = extractObject(item)
        const indexValue = object.frame_index ?? object.index ?? position
        const index = Number(indexValue)
        if (!Number.isInteger(index) || index < 0 || index >= frames.length) return
        if (result.has(index)) return
        result.set(index, parseAnalysisObject(object, content, customItems))
      } catch {
        // A malformed item is treated as a missing result for that frame.
      }
    })
    return result
  }

  if (Array.isArray(parsed)) {
    parsed.forEach((item, position) => {
      try {
        const object = extractObject(item)
        if (position < frames.length) {
          result.set(position, parseAnalysisObject(object, content, customItems))
        }
      } catch {
        // Ignore malformed entries; handled as missing by the caller.
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
  if (!analysis.abnormal) {
    return {
      verdict: analysis.needHumanReview ? 'review' : 'normal',
      needHumanReview: analysis.needHumanReview
    }
  }

  const lowConfidence =
    analysis.confidence !== null && analysis.confidence < confidenceThreshold
  const missingEvidence = !analysis.evidence
  const review = analysis.needHumanReview || lowConfidence || missingEvidence
  return {
    verdict: review ? 'review' : 'abnormal',
    needHumanReview: review
  }
}
