/**
 * 任务状态、判定结果与帧统计的共用展示/导出辅助。
 *
 * 主进程（CSV 导出）与渲染进程（徽章、筛选、统计）共用同一份中文文案，
 * 避免两处各写一套导致不一致。
 */

import type { AnalysisMode, FrameRecord, RegionStatus, TaskStatus, Verdict } from './types'

/* ------------------------------ 发送方式 ------------------------------ */

export const ANALYSIS_MODE_LABELS: Record<AnalysisMode, string> = {
  single: '逐帧',
  group: '分组'
}

/* ------------------------------ 任务状态 ------------------------------ */

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  extracting: '正在抽帧',
  analyzing: '正在分析',
  completed: '已完成',
  completed_with_errors: '部分失败',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断'
}

/** 任务状态 → 徽章色调（与 styles.css 的 badge-* 类对应） */
export const TASK_STATUS_TONES: Record<TaskStatus, string> = {
  extracting: 'active',
  analyzing: 'active',
  completed: 'success',
  completed_with_errors: 'warning',
  cancelled: 'warning',
  failed: 'danger',
  interrupted: 'warning'
}

/** 是否仍在处理中（不可删除/不可重复启动） */
export function isTaskActive(status: TaskStatus): boolean {
  return status === 'extracting' || status === 'analyzing'
}

/** 是否已到终态 */
export function isTaskTerminal(status: TaskStatus): boolean {
  return !isTaskActive(status)
}

/* ------------------------------ 帧判定 ------------------------------ */

export const VERDICT_LABELS: Record<Verdict, string> = {
  pending: '待分析',
  normal: '正常',
  abnormal: '异常',
  review: '待复核',
  failed: '失败'
}

/** 帧判定 → 徽章色调（与 styles.css 的 badge-* 类对应） */
export const VERDICT_TONES: Record<Verdict, string> = {
  pending: 'pending',
  normal: 'success',
  abnormal: 'danger',
  review: 'warning',
  failed: 'neutral'
}

/** CSV 导出用判定文案（失败帧写"识别失败"，比界面徽章更明确） */
export const VERDICT_EXPORT_LABELS: Record<Verdict, string> = {
  pending: '待分析',
  normal: '正常',
  abnormal: '异常',
  review: '待复核',
  failed: '识别失败'
}

/* ------------------------------ 定位状态 ------------------------------ */

/** CSV 导出用定位状态文案 */
export const REGION_STATUS_EXPORT_LABELS: Record<RegionStatus, string> = {
  none: '未定位',
  pending: '定位中',
  ok: '已定位',
  failed: '定位失败',
  unsupported: '模型不支持定位'
}

/* ------------------------------ 帧统计 ------------------------------ */

export interface FrameStats {
  total: number
  /** 已处理（完成或失败） */
  processed: number
  abnormal: number
  review: number
  normal: number
  failed: number
  /** 尚未处理 */
  pending: number
  /** 已定位出框的帧数 */
  located: number
}

/** 单次遍历统计各种帧状态，供任务摘要与详情页共用 */
export function countFrameStats(frames: FrameRecord[]): FrameStats {
  const stats: FrameStats = {
    total: frames.length,
    processed: 0,
    abnormal: 0,
    review: 0,
    normal: 0,
    failed: 0,
    pending: 0,
    located: 0
  }
  for (const frame of frames) {
    if (frame.status === 'completed' || frame.status === 'failed') stats.processed += 1
    if (frame.status === 'failed') stats.failed += 1
    if (frame.status === 'pending' || frame.status === 'analyzing') stats.pending += 1
    if (frame.verdict === 'abnormal') stats.abnormal += 1
    else if (frame.verdict === 'review') stats.review += 1
    else if (frame.verdict === 'normal') stats.normal += 1
    if (frame.regionStatus === 'ok' && frame.regions.length > 0) stats.located += 1
  }
  return stats
}
