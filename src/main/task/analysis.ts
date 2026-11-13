import path from 'node:path'
import { taskResults } from '@shared/behavior'
import type { FrameRecord, TaskRecord, Verdict } from '@shared/types'
import type { ResolvedModelConfig } from '../config/model-config'
import { getTaskDir } from '../paths'
import { FatalModelError } from '../model/client'
import {
  analyzeFrameGroup,
  analyzeSingleFrame,
  deriveVerdict,
  type ParsedAnalysis
} from '../model/analysis'
import { emitFrame, emitSummary } from './event'
import type { RegionCounts } from './regions'
import { flushSave, scheduleSave } from './store'

export async function analyzeFrames(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  signal: AbortSignal,
  onlyIndices: Set<number> | null,
  hooks?: {
    onFrameAnalyzed?: (frame: FrameRecord) => void
    getCounts?: () => RegionCounts
  }
): Promise<void> {
  const targetFrames = task.frames.filter(
    (frame) => (onlyIndices ? onlyIndices.has(frame.index) : true) && frame.status !== 'completed'
  )
  if (targetFrames.length === 0) return

  task.status = 'analyzing'
  task.progress = 0
  task.phaseMessage = '正在分析'
  task.errorMessage = ''
  await flushSave(task)
  emitSummary(task, true)

  const groups: FrameRecord[][] = []
  if (task.config.analysisMode === 'group') {
    const size = Math.max(2, task.config.groupSize)
    for (let index = 0; index < targetFrames.length; index += size) {
      groups.push(targetFrames.slice(index, index + size))
    }
  } else {
    for (const frame of targetFrames) groups.push([frame])
  }

  let nextGroup = 0
  let fatalError: Error | null = null
  let consecutiveFailures = 0
  const concurrency = Math.max(1, Math.min(modelConfig.concurrency, groups.length))

  const worker = async (): Promise<void> => {
    while (!signal.aborted && !fatalError) {
      const groupIndex = nextGroup
      nextGroup += 1
      if (groupIndex >= groups.length) return
      const group = groups[groupIndex]
      try {
        if (group.length === 1) {
          const analysis = await analyzeSingleFrame(
            modelConfig,
            task.config.prohibitedItems,
            task.config.customProhibitedItems,
            path.join(getTaskDir(task.id), 'frames', group[0].fileName),
            group[0].timestampMs,
            signal
          )
          applyAnalysis(group[0], analysis, task.config.confidenceThreshold, modelConfig.label)
        } else {
          const groupResult = await analyzeFrameGroup(
            modelConfig,
            task.config.prohibitedItems,
            task.config.customProhibitedItems,
            group.map((frame) => ({
              filePath: path.join(getTaskDir(task.id), 'frames', frame.fileName),
              timestampMs: frame.timestampMs
            })),
            signal
          )
          const analyses = groupResult.analyses
          for (const frame of group) {
            const analysis = analyses.get(group.indexOf(frame))
            if (analysis) {
              applyAnalysis(frame, analysis, task.config.confidenceThreshold, modelConfig.label)
            } else {
              frame.status = 'failed'
              frame.verdict = 'failed'
              frame.error = '未返回该帧结果'
              frame.analyzedAt = new Date().toISOString()
              frame.model = modelConfig.label
              if (modelConfig.developerMode) frame.callTraces.push(...groupResult.traces)
            }
          }
        }
        consecutiveFailures = 0
        updateProgress(task, hooks?.getCounts?.())
        scheduleSave(task)
        for (const frame of group) {
          if (
            frame.status === 'completed' &&
            (frame.verdict === 'abnormal' || frame.verdict === 'review')
          ) {
            hooks?.onFrameAnalyzed?.(frame)
          }
          emitFrame(task, frame)
        }
      } catch (error) {
        if (error instanceof FatalModelError) {
          fatalError = error
          return
        }
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        consecutiveFailures += 1
        const now = new Date().toISOString()
        for (const frame of group) {
          frame.status = 'failed'
          frame.verdict = 'failed'
          frame.error = message
          frame.analyzedAt = now
          frame.model = modelConfig.label
        }
        updateProgress(task, hooks?.getCounts?.())
        scheduleSave(task)
        for (const frame of group) emitFrame(task, frame)
        if (consecutiveFailures >= 4) {
          fatalError = new Error(message)
          return
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (signal.aborted) throw new Error('任务已取消')
  if (fatalError) throw fatalError
}

function applyAnalysis(
  frame: FrameRecord,
  analysis: ParsedAnalysis,
  confidenceThreshold: number,
  modelLabel: string
): void {
  const { verdict, needHumanReview } = deriveVerdict(analysis, confidenceThreshold)
  frame.status = 'completed'
  frame.verdict = verdict as Verdict
  frame.riskLevel = analysis.riskLevel
  frame.categories = analysis.categories
  frame.description = analysis.description
  frame.evidence = analysis.evidence
  frame.confidence = analysis.confidence
  frame.needHumanReview = needHumanReview
  frame.error = ''
  frame.rawResponse = analysis.raw
  frame.analyzedAt = new Date().toISOString()
  frame.model = modelLabel
  if (analysis.traces.length > 0) frame.callTraces.push(...analysis.traces)
}

function updateProgress(task: TaskRecord, counts?: RegionCounts): void {
  const total = task.frames.length
  const processed = task.frames.filter(
    (frame) => frame.status === 'completed' || frame.status === 'failed'
  ).length
  if (!counts) {
    task.progress = total > 0 ? Math.round((processed / total) * 1000) / 10 : 0
    task.phaseMessage = '正在分析'
    return
  }
  // 判定 + 定位共用一条进度条（探测的帧数动态增长，用单调递增避免回退）
  const totalWork = total + Math.max(counts.planned, 1)
  const computed = Math.round(((processed + counts.located) / totalWork) * 1000) / 10
  task.progress = Math.min(99, Math.max(task.progress, computed))
  task.phaseMessage =
    processed < total
      ? `正在分析（已定位 ${counts.located}）`
      : `正在定位违禁物 ${counts.located}/${Math.max(counts.planned, 1)}`
}

export function markUnresolvedFailed(task: TaskRecord, reason: string): void {
  const now = new Date().toISOString()
  for (const frame of taskResults(task)) {
    if (frame.status === 'pending' || frame.status === 'analyzing') {
      frame.status = 'failed'
      frame.verdict = 'failed'
      frame.error = reason
      frame.analyzedAt = now
    }
  }
}
