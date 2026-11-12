/**
 * 能力探针：标定图定义 + 探针结果判定（纯函数，不依赖 Electron）。
 *
 * 关键设计：同一张图发两个尺寸（R1 1120×672 / R2 560×336），
 * 用"坐标是否随图片尺寸缩放"区分绝对像素与归一化——单张图无法可靠区分。
 */

import {
  DEFAULT_PARSE_ORDER,
  type BoxOrder,
  type CoordinateSpace,
  type LocateContext,
  type ParseDialect,
  type RegionBox
} from './profile'
import {
  containsSpecialTokens,
  containsThinking,
  iou,
  mapRawBoxes,
  parseGrounding
} from './dialects'

export interface ProbeRect {
  label: string
  /** RGB 0-255 */
  color: [number, number, number]
  /** 归一化位置 [x1,y1,x2,y2] */
  rect: [number, number, number, number]
}

export const PROBE_FULL_SIZE = { width: 1120, height: 672 }
export const PROBE_HALF_SIZE = { width: 560, height: 336 }

/** 5 个矩形：大 / 中 / 小 / 细长 / 贴边，覆盖常见难度 */
export const PROBE_RECTS: ProbeRect[] = [
  { label: 'red', color: [220, 40, 40], rect: [0.10, 0.10, 0.30, 0.40] },
  { label: 'blue', color: [40, 80, 220], rect: [0.62, 0.52, 0.80, 0.84] },
  { label: 'green', color: [30, 160, 80], rect: [0.44, 0.42, 0.50, 0.50] },
  { label: 'yellow', color: [230, 190, 40], rect: [0.20, 0.86, 0.70, 0.92] },
  { label: 'black', color: [20, 20, 20], rect: [0.03, 0.03, 0.10, 0.10] }
]

export interface ProbeEvaluation {
  ok: boolean
  jsonOk: boolean
  dialect: ParseDialect
  coordinateSpace: CoordinateSpace | 'unknown'
  boxOrder: BoxOrder
  scaleX: number
  scaleY: number
  multiTarget: boolean
  thinkingPolluted: boolean
  tokenLeak: boolean
  /** 最佳假设的匹配得分（0..1） */
  score: number
  meanIoU: number
  boxesFound: number
  notes: string[]
}

const SPACES: CoordinateSpace[] = [
  'normalized_1000',
  'normalized_100',
  'normalized_01',
  'absolute_px'
]
const ORDERS: BoxOrder[] = ['xyxy', 'yxyx']

interface ScoredHypothesis {
  space: CoordinateSpace
  order: BoxOrder
  score: number
  meanIoU: number
}

function contextFor(
  space: CoordinateSpace,
  order: BoxOrder,
  size: { width: number; height: number }
): LocateContext {
  return {
    space,
    order,
    sentWidth: size.width,
    sentHeight: size.height,
    scaleX: 1,
    scaleY: 1
  }
}

/** 贪心匹配：返回匹配对的 IoU 列表 */
function matchBoxes(predicted: RegionBox[], truth: RegionBox[]): number[] {
  const pairs: Array<{ pi: number; ti: number; value: number }> = []
  for (let pi = 0; pi < predicted.length; pi += 1) {
    for (let ti = 0; ti < truth.length; ti += 1) {
      const value = iou(predicted[pi], truth[ti])
      if (value > 0.15) pairs.push({ pi, ti, value })
    }
  }
  pairs.sort((a, b) => b.value - a.value)
  const usedPredicted = new Set<number>()
  const usedTruth = new Set<number>()
  const matches: number[] = []
  for (const pair of pairs) {
    if (usedPredicted.has(pair.pi) || usedTruth.has(pair.ti)) continue
    usedPredicted.add(pair.pi)
    usedTruth.add(pair.ti)
    matches.push(pair.value)
  }
  return matches
}

function scoreAgainstTruth(predicted: RegionBox[]): { score: number; meanIoU: number } {
  const truth = PROBE_RECTS.map((item) => item.rect as RegionBox)
  if (predicted.length === 0) return { score: 0, meanIoU: 0 }
  const matches = matchBoxes(predicted, truth)
  if (matches.length === 0) return { score: 0, meanIoU: 0 }
  const meanIoU = matches.reduce((sum, value) => sum + value, 0) / matches.length
  const precision = matches.length / predicted.length
  const recall = matches.length / truth.length
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { score: meanIoU * f1, meanIoU }
}

function evaluateHypothesis(
  r1: ReturnType<typeof parseGrounding>,
  r2: ReturnType<typeof parseGrounding> | null,
  space: CoordinateSpace,
  order: BoxOrder
): ScoredHypothesis {
  const mapped1 = mapRawBoxes(r1.boxes, contextFor(space, order, PROBE_FULL_SIZE)).map(
    (item) => item.box
  )
  const first = scoreAgainstTruth(mapped1)
  let second = { score: 0, meanIoU: 0 }
  if (r2 && r2.boxes.length > 0) {
    const mapped2 = mapRawBoxes(r2.boxes, contextFor(space, order, PROBE_HALF_SIZE)).map(
      (item) => item.box
    )
    second = scoreAgainstTruth(mapped2)
  }
  return {
    space,
    order,
    score: (first.score * 2 + second.score) / 3,
    meanIoU: (first.meanIoU * 2 + second.meanIoU) / 3
  }
}

export function evaluateProbe(r1Text: string, r2Text: string): ProbeEvaluation {
  const notes: string[] = []
  const r1 = parseGrounding(r1Text, DEFAULT_PARSE_ORDER)
  const r2 = r2Text ? parseGrounding(r2Text, DEFAULT_PARSE_ORDER) : null

  const jsonOk = r1.boxes.length > 0
  const boxesFound = r1.boxes.length
  const dialect: ParseDialect = r1.dialect
  const thinkingPolluted = containsThinking(r1Text)
  const tokenLeak = containsSpecialTokens(r1Text)

  if (r1.boxes.length === 0) {
    notes.push('探针未解析到任何框（可能不支持定位或提示词不适配）')
    return {
      ok: false,
      jsonOk: false,
      dialect,
      coordinateSpace: 'unknown',
      boxOrder: 'xyxy',
      scaleX: 1,
      scaleY: 1,
      multiTarget: false,
      thinkingPolluted,
      tokenLeak,
      score: 0,
      meanIoU: 0,
      boxesFound: 0,
      notes
    }
  }
  if (r1.boxes.length === 1) notes.push('模型只返回了 1 个框，定位层将降为单目标')

  const hypotheses: ScoredHypothesis[] = []
  for (const space of SPACES) {
    for (const order of ORDERS) {
      hypotheses.push(evaluateHypothesis(r1, r2, space, order))
    }
  }
  hypotheses.sort((a, b) => b.score - a.score)
  const best = hypotheses[0]
  const second = hypotheses[1] ?? { score: 0, space: 'unknown', order: 'xyxy', meanIoU: 0 }

  const strongEnough = best.score >= 0.45
  const clearMargin = best.score - second.score >= 0.1
  const ok = strongEnough && clearMargin

  if (!strongEnough) notes.push(`最佳假设得分仅 ${best.score.toFixed(2)}，定位不可信`)
  if (!clearMargin) {
    notes.push(
      `坐标空间歧义：${best.space}(${best.score.toFixed(2)}) 与 ${second.space}(${second.score.toFixed(2)}) 过于接近`
    )
  }
  if (best.space === 'absolute_px' && r2 && r2.boxes.length === 0) {
    notes.push('第二次（缩图）探针未返回结果，绝对像素判定可靠性下降')
  }

  return {
    ok,
    jsonOk,
    dialect,
    coordinateSpace: ok ? best.space : 'unknown',
    boxOrder: best.order,
    scaleX: 1,
    scaleY: 1,
    multiTarget: boxesFound >= 2,
    thinkingPolluted,
    tokenLeak,
    score: best.score,
    meanIoU: best.meanIoU,
    boxesFound,
    notes
  }
}
