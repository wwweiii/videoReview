/**
 * 解析方言链：从各种模型的原始输出里抽取 bbox，并统一映射成归一化坐标。
 *
 * 设计原则：
 * 1. 解析阶段只抽"原始四元组"，不在解析器里乘宽高；
 * 2. 先得到 RawBox（IR），再由 resolveBox 按 profile 一次性映射；
 * 3. 命中必须"可用"（至少一个框能通过坐标校验），否则继续下一个方言；
 * 4. 全部失败返回空数组，由上层降级，绝不抛错。
 */

import {
  DEFAULT_PARSE_ORDER,
  type LocateContext,
  type ParseDialect,
  type RegionBox
} from './profile'

export interface RawBox {
  label: string
  coords: [number, number, number, number]
  source: 'json' | 'token' | 'loc_bins' | 'text'
  parser: ParseDialect
  /** 模型给的置信度（0..1），没有则为 null */
  confidence?: number | null
}

export interface ParsedGrounding {
  boxes: RawBox[]
  dialect: ParseDialect
  /** 明确表达了"没有目标"（且有否定词、无任何坐标） */
  noTarget: boolean
}

const MIN_AREA = 0.0002
const MAX_AREA = 0.95

/* ------------------------------------------------------------------ */
/* 文本清洗                                                             */
/* ------------------------------------------------------------------ */

const THINK_BLOCK_PATTERNS: RegExp[] = [
  /<think\b[^>]*>[\s\S]*?<\/think>/gi,
  /<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi,
  /<\|think\|>[\s\S]*?<\|end_of_thinking\|>/gi,
  /\u003cthinking\u003e[\s\S]*?<\/thinking>/gi
]

export function stripThinking(raw: string): string {
  let text = raw
  for (const pattern of THINK_BLOCK_PATTERNS) text = text.replace(pattern, '')
  // 只有"思考段在前、正文在后"的常见形态才裁剪，避免误删正文里的正常词
  const cut = text.lastIndexOf('<|end_of_thinking|>')
  if (cut >= 0) text = text.slice(cut + '<|end_of_thinking|>'.length)
  return text.trim()
}

export function containsThinking(raw: string): boolean {
  return THINK_BLOCK_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(raw)
  }) || /<\|begin_of_thought\|>/i.test(raw)
}

export function containsSpecialTokens(raw: string): boolean {
  return /<\|box_start\|>|<\|begin_of_box\|>|<loc_\d+>|<ref>/i.test(raw)
}

export function stripCodeFences(raw: string): string {
  return raw
    .replace(/```(?:json|JSON)?\s*/g, '')
    .replace(/```/g, '')
    .trim()
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/%$/, '')
    if (!normalized) return null
    const parsed = Number.parseFloat(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function numbersInText(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g) ?? []
  return matches.map((item) => Number(item)).filter((item) => Number.isFinite(item))
}

/** 从任意值里提取 4 个数字（数组 / 对象 / 字符串） */
export function quadFromUnknown(value: unknown): [number, number, number, number] | null {
  if (Array.isArray(value)) {
    if (value.length === 4) {
      const numbers = value.map(toFiniteNumber)
      if (numbers.every((item): item is number => item !== null)) {
        return numbers as [number, number, number, number]
      }
    }
    if (value.length === 2 && Array.isArray(value[0]) && Array.isArray(value[1])) {
      const first = value[0].map(toFiniteNumber)
      const second = value[1].map(toFiniteNumber)
      if (first.length === 2 && second.length === 2 && [...first, ...second].every((n) => n !== null)) {
        return [first[0] as number, first[1] as number, second[0] as number, second[1] as number]
      }
    }
    return null
  }

  if (typeof value === 'string') {
    const numbers = numbersInText(value)
    if (numbers.length === 4) return numbers as [number, number, number, number]
    if (numbers.length === 8) {
      // [[x1,y1],[x2,y2]] 平铺
      return [numbers[0], numbers[1], numbers[4], numbers[5]]
    }
    return null
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const xyxyKeys = ['x1', 'y1', 'x2', 'y2']
    if (xyxyKeys.every((key) => toFiniteNumber(record[key]) !== null)) {
      return xyxyKeys.map((key) => toFiniteNumber(record[key]) as number) as [
        number,
        number,
        number,
        number
      ]
    }
    if (
      toFiniteNumber(record.x) !== null &&
      toFiniteNumber(record.y) !== null &&
      toFiniteNumber(record.w) !== null &&
      toFiniteNumber(record.h) !== null &&
      record.w !== undefined &&
      record.h !== undefined &&
      record.bw === undefined
    ) {
      const x = toFiniteNumber(record.x) as number
      const y = toFiniteNumber(record.y) as number
      const w = toFiniteNumber(record.w) as number
      const h = toFiniteNumber(record.h) as number
      return [x, y, x + w, y + h]
    }
    if (
      toFiniteNumber(record.x) !== null &&
      toFiniteNumber(record.y) !== null &&
      toFiniteNumber(record.width) !== null &&
      toFiniteNumber(record.height) !== null
    ) {
      const x = toFiniteNumber(record.x) as number
      const y = toFiniteNumber(record.y) as number
      const w = toFiniteNumber(record.width) as number
      const h = toFiniteNumber(record.height) as number
      return [x, y, x + w, y + h]
    }
  }

  return null
}

const BBOX_KEYS = [
  'bbox_2d',
  'bbox',
  'bboxes',
  'box',
  'boxes',
  'xyxy',
  'coordinates',
  'region',
  'rect'
]

const LABEL_KEYS = ['label', 'category', 'name', 'class', 'object', 'item', 'object_name']

function confidenceFromRecord(record: Record<string, unknown>): number | null {
  for (const key of ['confidence', 'score', 'probability']) {
    const value = toFiniteNumber(record[key])
    if (value === null) continue
    const normalized = value > 1 ? value / 100 : value
    return Math.min(1, Math.max(0, normalized))
  }
  return null
}

function labelFromRecord(record: Record<string, unknown>): string {
  for (const key of LABEL_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* JSON 多 schema                                                       */
/* ------------------------------------------------------------------ */

function balancedCandidates(text: string, limit = 24): string[] {
  const results: string[] = []
  for (let start = 0; start < text.length && results.length < limit; start += 1) {
    const opener = text[start]
    if (opener !== '{' && opener !== '[') continue
    const closer = opener === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
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
          results.push(text.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }
  return results
}

function parseJsonLoose(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch {
    // 常见畸形：尾逗号、中文引号、单引号
    const repaired = candidate
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(repaired)
    } catch {
      return null
    }
  }
}

function extractBoxesFromValue(value: unknown, out: RawBox[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return

  if (Array.isArray(value)) {
    // 直接是四元组
    const quad = quadFromUnknown(value)
    if (quad) {
      out.push({ label: '', coords: quad, source: 'json', parser: 'json_multi' })
      return
    }
    for (const item of value) extractBoxesFromValue(item, out, depth + 1)
    return
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of BBOX_KEYS) {
      if (!(key in record)) continue
      const candidate = record[key]
      const quad = quadFromUnknown(candidate)
      if (quad) {
        out.push({
          label: labelFromRecord(record),
          coords: quad,
          source: 'json',
          parser: 'json_multi',
          confidence: confidenceFromRecord(record)
        })
        return
      }
      // boxes: [[...],[...]]
      extractBoxesFromValue(candidate, out, depth + 1)
      return
    }
    for (const nestedKey of ['objects', 'detections', 'results', 'data', 'output', 'items', 'frames']) {
      if (nestedKey in record) extractBoxesFromValue(record[nestedKey], out, depth + 1)
    }
  }
}

/** 去掉特殊 token 包裹的片段，避免把 `<box>[[1,2,3,4]]</box>` 误当 JSON */
function stripTokenSpans(text: string): string {
  return text
    .replace(/<box>[\s\S]*?<\/box>/gi, ' ')
    .replace(/<\|box_start\|>[\s\S]*?<\|box_end\|>/gi, ' ')
    .replace(/<\|begin_of_box\|>[\s\S]*?<\|end_of_box\|>/gi, ' ')
}

export function parseJsonMulti(text: string): RawBox[] {
  const boxes: RawBox[] = []
  const candidates = balancedCandidates(stripTokenSpans(text))
  for (const candidate of candidates) {
    const parsed = parseJsonLoose(candidate)
    if (parsed === null) continue
    const current: RawBox[] = []
    extractBoxesFromValue(parsed, current)
    if (current.length > 0) return current
  }
  return boxes
}

/* ------------------------------------------------------------------ */
/* 特殊 token 方言                                                      */
/* ------------------------------------------------------------------ */

const BOX_TOKEN_PATTERNS: RegExp[] = [
  /<\|box_start\|>([\s\S]*?)<\|box_end\|>/gi,
  /<\|begin_of_box\|>([\s\S]*?)<\|end_of_box\|>/gi,
  /<box>([\s\S]*?)<\/box>/gi
]

const REF_PATTERN = /<ref>([\s\S]*?)<\/ref>/gi

function lastRefLabel(before: string): string {
  REF_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  let label = ''
  while ((match = REF_PATTERN.exec(before)) !== null) label = match[1].trim()
  return label
}

export function parseBoxTokens(text: string): RawBox[] {
  const boxes: RawBox[] = []
  for (const pattern of BOX_TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1] ?? ''
      const numbers = numbersInText(content)
      if (numbers.length < 4) continue
      // 取前 4 个数字（InternVL 常见 [[x1,y1,x2,y2]]）
      const coords = numbers.slice(0, 4) as [number, number, number, number]
      const before = text.slice(Math.max(0, match.index - 240), match.index)
      boxes.push({
        label: lastRefLabel(before),
        coords,
        source: 'token',
        parser: 'box_tokens'
      })
    }
  }
  return boxes
}

/* ------------------------------------------------------------------ */
/* Florence loc bins                                                    */
/* ------------------------------------------------------------------ */

export function parseLocBins(text: string): RawBox[] {
  const tokens = [...text.matchAll(/<loc_(\d{1,4})>/g)].map((match) => Number(match[1]))
  const boxes: RawBox[] = []
  for (let index = 0; index + 3 < tokens.length; index += 4) {
    boxes.push({
      label: '',
      coords: [tokens[index], tokens[index + 1], tokens[index + 2], tokens[index + 3]],
      source: 'loc_bins',
      parser: 'loc_bins'
    })
  }
  return boxes
}

/* ------------------------------------------------------------------ */
/* 纯坐标文本                                                           */
/* ------------------------------------------------------------------ */

const PLAIN_QUAD_PATTERNS: Array<{ pattern: RegExp; labelGroup: number; coordStart: number }> = [
  {
    pattern:
      /([^\s:：()\[\]]{0,24})\s*[:：]?\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g,
    labelGroup: 1,
    coordStart: 2
  },
  {
    pattern:
      /([^\s:：()\[\]]{0,24})\s*[:：]?\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    labelGroup: 1,
    coordStart: 2
  },
  {
    pattern:
      /([^\s:：()\[\]]{0,24})\s*[:：]?\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*[,;]?\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
    labelGroup: 1,
    coordStart: 2
  },
  {
    pattern:
      /([^\s:：()\[\]]{0,24})\s*[:：]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
    labelGroup: 1,
    coordStart: 2
  }
]

export function parsePlainCoords(text: string): RawBox[] {
  const boxes: RawBox[] = []
  for (const { pattern, labelGroup, coordStart } of PLAIN_QUAD_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const label = (match[labelGroup] ?? '').trim()
      const coords = [
        Number(match[coordStart]),
        Number(match[coordStart + 1]),
        Number(match[coordStart + 2]),
        Number(match[coordStart + 3])
      ] as [number, number, number, number]
      if (!coords.every((item) => Number.isFinite(item))) continue
      // 明显不像坐标的（例如时间 12:30:45）已经由 pattern 排除
      boxes.push({ label, coords, source: 'text', parser: 'plain_coords' })
    }
  }
  return boxes
}

/* ------------------------------------------------------------------ */
/* 坐标映射与校验                                                       */
/* ------------------------------------------------------------------ */

export function resolveBox(raw: RawBox, context: LocateContext): RegionBox | null {
  let [x1, y1, x2, y2] = raw.coords
  if (context.order === 'yxyx') {
    const nextX1 = y1
    const nextY1 = x1
    const nextX2 = y2
    const nextY2 = x2
    x1 = nextX1
    y1 = nextY1
    x2 = nextX2
    y2 = nextY2
  }

  if (context.space === 'absolute_px') {
    if (!(context.sentWidth > 0) || !(context.sentHeight > 0)) return null
    x1 = (x1 / context.sentWidth) * context.scaleX
    y1 = (y1 / context.sentHeight) * context.scaleY
    x2 = (x2 / context.sentWidth) * context.scaleX
    y2 = (y2 / context.sentHeight) * context.scaleY
  } else {
    const divisor =
      context.space === 'normalized_1000' ? 1000 : context.space === 'normalized_100' ? 100 : 1
    x1 /= divisor
    x2 /= divisor
    y1 /= divisor
    y2 /= divisor
  }

  return validateBox([x1, y1, x2, y2])
}

/** 端点排序 / clamp / 面积过滤；返回归一化框或 null */
export function validateBox(box: [number, number, number, number]): RegionBox | null {
  let [x1, y1, x2, y2] = box
  if (![x1, y1, x2, y2].every((item) => Number.isFinite(item))) return null
  if (x2 < x1) {
    const swap = x1
    x1 = x2
    x2 = swap
  }
  if (y2 < y1) {
    const swap = y1
    y1 = y2
    y2 = swap
  }
  const clamped: RegionBox = [
    clamp01(x1),
    clamp01(y1),
    clamp01(x2),
    clamp01(y2)
  ]
  const width = clamped[2] - clamped[0]
  const height = clamped[3] - clamped[1]
  if (width <= 0 || height <= 0) return null
  const area = width * height
  if (area < MIN_AREA || area > MAX_AREA) return null
  return clamped
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function iou(a: RegionBox, b: RegionBox): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

export interface MappedBox {
  label: string
  box: RegionBox
  parser: ParseDialect
  confidence: number | null
}

/** 把 RawBox 列表按上下文映射成归一化框，丢弃无效框 */
export function mapRawBoxes(raw: RawBox[], context: LocateContext): MappedBox[] {
  const mapped: MappedBox[] = []
  for (const item of raw) {
    const box = resolveBox(item, context)
    if (!box) continue
    mapped.push({
      label: item.label,
      box,
      parser: item.parser,
      confidence: item.confidence ?? null
    })
  }
  return mapped
}

export interface AdaptiveLocateContext extends LocateContext {
  /** 原始帧尺寸：部分网关会按原图像素返回 absolute 坐标，用来自动兜底换算 */
  originWidth?: number
  originHeight?: number
}

/**
 * 坐标映射（带"原图基准"兜底）：
 * 先按发送尺寸映射；若 absolute_px 下用原图尺寸能解析出更多有效框，
 * 说明模型按原图像素返回，改用原图尺寸映射。
 */
export function mapRawBoxesAdaptive(
  raw: RawBox[],
  context: AdaptiveLocateContext
): { mapped: MappedBox[]; usedOrigin: boolean } {
  const primary = mapRawBoxes(raw, context)
  const originWidth = context.originWidth ?? 0
  const originHeight = context.originHeight ?? 0
  const canFallback =
    context.space === 'absolute_px' &&
    raw.length > 0 &&
    originWidth > 0 &&
    originHeight > 0 &&
    (originWidth !== context.sentWidth || originHeight !== context.sentHeight)
  if (!canFallback) return { mapped: primary, usedOrigin: false }

  const originMapped = mapRawBoxes(raw, {
    ...context,
    sentWidth: originWidth,
    sentHeight: originHeight
  })
  if (originMapped.length > primary.length) {
    return { mapped: originMapped, usedOrigin: true }
  }
  return { mapped: primary, usedOrigin: false }
}

/** 同类别高 IoU 去重（默认不限制返回框数，limit 仅供调用方按需收敛） */
export function dedupeBoxes<T extends { label: string; box: RegionBox }>(
  boxes: T[],
  limit: number = Number.POSITIVE_INFINITY,
  threshold = 0.6
): T[] {
  const kept: T[] = []
  for (const candidate of boxes) {
    const duplicate = kept.some(
      (item) => item.label === candidate.label && iou(item.box, candidate.box) > threshold
    )
    if (duplicate) continue
    kept.push(candidate)
    if (kept.length >= limit) break
  }
  return kept
}

/* ------------------------------------------------------------------ */
/* 方言链主函数                                                         */
/* ------------------------------------------------------------------ */

const DIALECT_PARSERS: Record<Exclude<ParseDialect, 'none'>, (text: string) => RawBox[]> = {
  json_multi: parseJsonMulti,
  box_tokens: parseBoxTokens,
  loc_bins: parseLocBins,
  plain_coords: parsePlainCoords
}

function orderDialects(preferred: ParseDialect[]): Array<Exclude<ParseDialect, 'none'>> {
  const known = (Object.keys(DIALECT_PARSERS) as Array<Exclude<ParseDialect, 'none'>>)
  const ordered: Array<Exclude<ParseDialect, 'none'>> = []
  for (const dialect of preferred) {
    if (dialect !== 'none' && known.includes(dialect) && !ordered.includes(dialect)) {
      ordered.push(dialect)
    }
  }
  for (const dialect of known) if (!ordered.includes(dialect)) ordered.push(dialect)
  return ordered
}

export function isRefusal(text: string): boolean {
  const hasNegation =
    /no objects?|there are none|not present|not found|未发现|没有发现|未检测到|不存在|无目标|无异常/i.test(
      text
    )
  const hasQuad = /[\[(]\s*-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+/i.test(text)
  return hasNegation && !hasQuad
}

const SPECIAL_TOKEN_HINT = /<box[\s>]|<\|box_start\|>|<\|begin_of_box\|>|<ref>/i

export function parseGrounding(
  raw: string,
  preferredDialects: ParseDialect[] = DEFAULT_PARSE_ORDER,
  probeContext?: LocateContext
): ParsedGrounding {
  const text = stripCodeFences(stripThinking(raw))
  const tokenFirst = SPECIAL_TOKEN_HINT.test(text)
  for (const dialect of orderDialects(preferredDialects)) {
    // 文本里出现特殊 token 时优先走 token 解析，避免 [[...]] 被 JSON 解析器抢走
    if (tokenFirst && dialect !== 'box_tokens') continue
    try {
      const boxes = DIALECT_PARSERS[dialect](text)
      if (boxes.length === 0) continue
      // 命中必须"可用"：给了 context 就做一次映射校验，否则只做数字合法性检查
      const usable = probeContext
        ? boxes.some((item) => resolveBox(item, probeContext) !== null)
        : boxes.some((item) => quadLooksSane(item.coords))
      if (!usable) continue
      return {
        boxes: boxes.slice(0, 20),
        dialect,
        noTarget: false
      }
    } catch {
      // 继续下一个方言
    }
  }
  if (tokenFirst) {
    // 特殊 token 解析失败时放宽：回到普通方言链再试一次
    for (const dialect of orderDialects(preferredDialects)) {
      if (dialect === 'box_tokens') continue
      try {
        const boxes = DIALECT_PARSERS[dialect](text)
        if (boxes.length === 0) continue
        const usable = probeContext
          ? boxes.some((item) => resolveBox(item, probeContext) !== null)
          : boxes.some((item) => quadLooksSane(item.coords))
        if (!usable) continue
        return { boxes: boxes.slice(0, 20), dialect, noTarget: false }
      } catch {
        // 忽略
      }
    }
  }
  return { boxes: [], dialect: 'none', noTarget: isRefusal(text) }
}

function quadLooksSane(coords: [number, number, number, number]): boolean {
  if (!coords.every((item) => Number.isFinite(item))) return false
  const max = Math.max(...coords.map((item) => Math.abs(item)))
  if (max <= 0) return false
  const width = Math.abs(coords[2] - coords[0])
  const height = Math.abs(coords[3] - coords[1])
  return width > 0 && height > 0
}
