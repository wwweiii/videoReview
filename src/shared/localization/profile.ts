/**
 * 模型无关定位的"能力档案"。
 *
 * 设计目标：业务代码只认 ModelProfile，不认模型名。
 * 所有差异（方言/坐标空间/轴序/补偿系数）都由探针（runtime probe）测出来并存进 profile，
 * 允许运维手动覆盖与导入导出。
 */

export type CoordinateSpace =
  /** Qwen3-VL / InternVL / MiniCPM / GLM / Molmo2 / Gemini 一系的 0–1000 归一化 */
  | 'normalized_1000'
  /** Molmo 0924 的 0–100 */
  | 'normalized_100'
  /** 部分自微调模型的 0–1 */
  | 'normalized_01'
  /** Qwen2.5-VL：模型实际输入图（resize 后）的绝对像素 */
  | 'absolute_px'

export type BoxOrder = 'xyxy' | 'yxyx'

export type ParseDialect =
  | 'json_multi'
  | 'box_tokens'
  | 'loc_bins'
  | 'plain_coords'
  | 'none'

export const DEFAULT_PARSE_ORDER: ParseDialect[] = [
  'json_multi',
  'box_tokens',
  'loc_bins',
  'plain_coords'
]

export const PARSE_DIALECT_LABELS: Record<ParseDialect, string> = {
  json_multi: 'JSON 多 schema',
  box_tokens: '特殊 token（<box>/<ref>/<|begin_of_box|>）',
  loc_bins: 'Florence loc bins',
  plain_coords: '纯坐标文本',
  none: '未识别'
}

export const COORDINATE_SPACE_LABELS: Record<CoordinateSpace, string> = {
  normalized_1000: '0–1000 归一化',
  normalized_100: '0–100 归一化',
  normalized_01: '0–1 归一化',
  absolute_px: '模型输入图绝对像素'
}

export const BOX_ORDER_LABELS: Record<BoxOrder, string> = {
  xyxy: 'x1,y1,x2,y2（左上→右下）',
  yxyx: 'y1,x1,y2,x2（Gemini 系轴序）'
}

/** 业务侧统一使用归一化框：0..1，原点左上，[x1,y1,x2,y2] */
export type RegionBox = [number, number, number, number]

export interface ModelProfile {
  /** 缓存键：normalize(baseUrl)|model|promptFingerprint */
  id: string
  baseUrl: string
  model: string
  promptFingerprint: string
  probedAt: string
  /** 判定请求能否稳定返回 JSON */
  jsonOk: boolean
  /** 该端点能否定位 */
  localizationOk: boolean
  coordinateSpace: CoordinateSpace | 'unknown'
  boxOrder: BoxOrder
  /** 按优先级排列；探针命中的方言置顶 */
  parseDialects: ParseDialect[]
  /** 服务端若还有额外 resize，用这两个系数补偿（探针拟合） */
  scaleX: number
  scaleY: number
  /** 探针推断的每帧框数上限 */
  maxBoxes: number
  multiTarget: boolean
  thinkingPolluted: boolean
  tokenLeak: boolean
  notes: string[]
}

/** 单次定位请求的坐标上下文 */
export interface LocateContext {
  space: CoordinateSpace
  order: BoxOrder
  /** 实际发送给模型的图片尺寸 */
  sentWidth: number
  sentHeight: number
  scaleX: number
  scaleY: number
}

export function unknownProfile(
  baseUrl: string,
  model: string,
  promptFingerprint: string
): ModelProfile {
  return {
    id: profileId(baseUrl, model, promptFingerprint),
    baseUrl,
    model,
    promptFingerprint,
    probedAt: new Date().toISOString(),
    jsonOk: false,
    localizationOk: false,
    coordinateSpace: 'unknown',
    boxOrder: 'xyxy',
    parseDialects: [...DEFAULT_PARSE_ORDER],
    scaleX: 1,
    scaleY: 1,
    maxBoxes: 8,
    multiTarget: true,
    thinkingPolluted: false,
    tokenLeak: false,
    notes: []
  }
}

export function profileId(baseUrl: string, model: string, promptFingerprint: string): string {
  return `${normalizeBaseUrl(baseUrl)}|${model.trim()}|${promptFingerprint}`
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
}

export function hasLocalization(profile: ModelProfile | null): profile is ModelProfile {
  return Boolean(profile && profile.localizationOk && profile.coordinateSpace !== 'unknown')
}
