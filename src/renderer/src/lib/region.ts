/**
 * 检测框几何与定位状态兜底文案（结果列表缩略图 / 抽屉预览共用）。
 */

import type { FrameRecord } from '@shared/types'

/** 框顶低于这个比例时，标签翻到框内，避免被预览容器裁掉 */
export const LABEL_FLIP_THRESHOLD = 0.06

/** 归一化坐标 → 百分比（容忍越界数据，避免负宽度/超出画面） */
export function boxPercent(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return `${clamped * 100}%`
}

export function boxLength(start: number, end: number): string {
  const size = Number.isFinite(end - start) ? Math.min(1, Math.max(0, end - start)) : 0
  return `${size * 100}%`
}

/** 没有框时的定位状态兜底文案 */
export function regionNotice(frame: FrameRecord): string | null {
  switch (frame.regionStatus) {
    case 'pending':
      return '正在定位…'
    case 'failed':
      return frame.regionError ? `定位失败：${frame.regionError}` : '定位失败：模型未返回可用结果'
    case 'unsupported':
      return '当前模型不支持位置输出'
    case 'ok':
      return frame.regionError || '模型未返回位置'
    case 'none':
      if (
        frame.status === 'completed' &&
        (frame.verdict === 'abnormal' || frame.verdict === 'review')
      ) {
        return '未执行定位（设置中未开启）'
      }
      return null
    default:
      return null
  }
}

export function regionNoticeTone(frame: FrameRecord): string {
  if (frame.regionStatus === 'failed') return 'is-error'
  if (frame.regionStatus === 'pending') return 'is-pending'
  return ''
}
