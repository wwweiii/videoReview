import { DEFAULT_ITEM_IMAGE_SCALE_PERCENT } from './defaults'

/** 宽、高分别相对于原图的百分比；旧任务缺省为原尺寸，不跟随新的初始设置。 */
export function normalizeImageScalePercent(value?: unknown): number {
  const percent = Number(value ?? 100)
  return Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(1, percent))) : 100
}

export interface SourceImageScaleOptions { scalePercent: number }

export type JudgmentImageOptions = SourceImageScaleOptions

/** 仅用于重试旧任务，保留创建时的图片处理快照。 */
export interface LegacyJudgmentImageOptions {
  maxEdge: number
  format: 'png' | 'jpeg'
  quality: number
}

export type TaskJudgmentImageOptions = JudgmentImageOptions | LegacyJudgmentImageOptions

export const DEFAULT_JUDGMENT_IMAGE: JudgmentImageOptions = {
  scalePercent: DEFAULT_ITEM_IMAGE_SCALE_PERCENT
}

export function normalizeJudgmentImage(raw?: Partial<TaskJudgmentImageOptions>): JudgmentImageOptions {
  return { scalePercent: normalizeImageScalePercent(
    raw && 'scalePercent' in raw ? raw.scalePercent ?? DEFAULT_ITEM_IMAGE_SCALE_PERCENT : DEFAULT_ITEM_IMAGE_SCALE_PERCENT
  ) }
}

export function normalizeLegacyJudgmentImage(raw: Partial<LegacyJudgmentImageOptions>): LegacyJudgmentImageOptions {
  const edge = Number(raw?.maxEdge ?? 0)
  const quality = Number(raw?.quality ?? 90)
  return {
    maxEdge: Number.isFinite(edge) && edge > 0 ? Math.round(Math.min(4096, Math.max(256, edge))) : 0,
    format: raw?.format === 'jpeg' ? 'jpeg' : 'png',
    quality: Number.isFinite(quality) ? Math.round(Math.min(100, Math.max(50, quality))) : 90
  }
}
