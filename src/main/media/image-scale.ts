import { normalizeImageScalePercent } from '@shared/image'

/** 百分比只作用于原始宽高，最小 1 像素，不额外套用固定长边或倍数对齐。 */
export function imageScaleFilter(value?: number): string | null {
  const percent = normalizeImageScalePercent(value)
  if (percent === 100) return null
  const ratio = percent / 100
  return `scale=w='max(1,round(iw*${ratio}))':h='max(1,round(ih*${ratio}))'`
}
