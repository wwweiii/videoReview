import path from 'node:path'
import type { FrameRecord, RegionStatus, TaskRecord } from '@shared/types'
import type { ModelProfile } from '@shared/localization/profile'
import type { ResolvedModelConfig } from '../config/model-config'
import { getProfile } from '../config/profiles'
import { logger } from '../logger'
import { localizeFrame } from '../localization/locator'
import { ensureProfile } from '../localization/probe'
import { FatalModelError } from '../model/client'
import { getTaskDir } from '../paths'
import { emitFrame, emitSummary } from './event'
import { flushSave, scheduleSave } from './store'

interface LocalizeRunOptions {
  /** true = 只跑定位（重定位），进度只按定位帧计算 */
  onlyLocalize: boolean
  /** true = 只处理尚未成功定位的异常帧（重试失败判定后补齐定位） */
  onlyPendingRegions?: boolean
}

export function regionCandidateFrames(task: TaskRecord): FrameRecord[] {
  return task.frames.filter(
    (frame) =>
      frame.status === 'completed' && (frame.verdict === 'abnormal' || frame.verdict === 'review')
  )
}

export interface RegionCounts {
  planned: number
  located: number
}

/**
 * 定位流水线：判定每完成一帧就入队，由固定并发的工作协程立刻定位。
 * 这样"判定"和"定位"重叠执行，框不用等到全部判定结束才出现。
 */
export interface RegionRunner {
  enqueue(frame: FrameRecord): void
  finish(): Promise<void>
  abort(): void
  counts(): RegionCounts
}

const REGION_FAILURE_LIMIT = 4
const REGION_POLL_INTERVAL_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createRegionRunner(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  signal: AbortSignal,
  onlyLocalize: boolean
): RegionRunner {
  const concurrency = Math.max(1, Math.min(modelConfig.concurrency, 3))
  const queue: FrameRecord[] = []
  let planned = 0
  let located = 0
  let failures = 0
  let stopped = false
  let producerDone = false
  let profile: ModelProfile | null = null
  let profileError = ''

  // 探针延迟到"第一帧需要定位"时启动：没有异常帧的任务不发多余请求；
  // 一旦启动就与判定并行，等判定跑完时能力档案通常已就绪。
  let profilePromise: Promise<void> | null = null
  function ensureProfileStarted(): Promise<void> {
    if (!profilePromise) {
      profilePromise = (async () => {
        try {
          profile = await ensureProfile(modelConfig, signal)
          task.regionProfile = profile
        } catch (error) {
          if (signal.aborted) throw error
          profileError = error instanceof Error ? error.message : String(error)
          profile = null
          // 保留失败档案，UI 才能展示"定位不可用"的原因
          task.regionProfile = getProfile(modelConfig)
        }
      })()
      profilePromise.catch(() => undefined)
    }
    return profilePromise
  }

  function markFrame(frame: FrameRecord, status: RegionStatus, reason: string): void {
    frame.regions = []
    frame.regionLevel = 'L0'
    frame.regionStatus = status
    frame.regionError = reason
    if (modelConfig.label) frame.regionModel = modelConfig.label
  }

  function failRest(reason: string, status: RegionStatus): void {
    while (queue.length > 0) {
      const frame = queue.shift() as FrameRecord
      markFrame(frame, status, reason)
      emitFrame(task, frame)
    }
    scheduleSave(task)
  }

  function bumpProgress(): void {
    if (onlyLocalize) {
      task.progress = planned > 0 ? Math.round((located / planned) * 1000) / 10 : 0
      task.phaseMessage = `正在定位违禁物 ${located}/${Math.max(planned, 1)}`
      return
    }
    const total = task.frames.length
    const processed = task.frames.filter(
      (frame) => frame.status === 'completed' || frame.status === 'failed'
    ).length
    const totalWork = total + Math.max(planned, 1)
    const computed = Math.round(((processed + located) / totalWork) * 1000) / 10
    task.progress = Math.min(99, Math.max(task.progress, computed))
    task.phaseMessage =
      processed < total
        ? `正在分析（已定位 ${located}）`
        : `正在定位违禁物 ${located}/${Math.max(planned, 1)}`
  }

  async function locate(frame: FrameRecord): Promise<void> {
    await ensureProfileStarted()
    if (!profile) {
      stopped = true
      failRest(profileError || '当前模型不支持位置输出', 'unsupported')
      markFrame(frame, 'unsupported', profileError || '当前模型不支持位置输出')
      bumpProgress()
      emitFrame(task, frame)
      scheduleSave(task)
      return
    }
    const startedAt = Date.now()
    try {
      const result = await localizeFrame(
        modelConfig,
        profile,
        {
          framePath: path.join(getTaskDir(task.id), 'frames', frame.fileName),
          timestampMs: frame.timestampMs,
          itemIds: task.config.prohibitedItems,
          customItems: task.config.customProhibitedItems,
          focusCategories: frame.categories
        },
        signal
      )
      frame.regions = result.regions
      frame.regionStatus = 'ok'
      frame.regionLevel = result.regions.length > 0 ? 'L3' : 'L0'
      frame.regionModel = modelConfig.label
      // 框被"判定对象一致性"过滤掉时，给用户一个明确解释
      frame.regionError =
        result.regions.length === 0 && result.filteredOut > 0
          ? `定位结果与判定对象不一致（已过滤 ${result.filteredOut} 个框）`
          : ''
      frame.regionRaw = result.raw
      if (result.traces.length > 0) frame.callTraces.push(...result.traces)
      located += 1
      failures = 0
      if (result.usedOriginGrid) {
        logger.warn('单帧定位使用原图坐标系换算', { index: frame.index })
      }
      if (result.filteredOut > 0) {
        logger.warn('定位结果与判定对象不一致，已过滤', {
          index: frame.index,
          filteredOut: result.filteredOut,
          kept: result.regions.length,
          focus: result.focusLabels
        })
      }
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      failures += 1
      markFrame(frame, 'failed', message)
      logger.warn('单帧定位失败', { index: frame.index, reason: message })
      if (error instanceof FatalModelError) {
        stopped = true
        failRest('定位阶段中止（模型鉴权失败）', 'failed')
      } else if (failures >= REGION_FAILURE_LIMIT && located === 0) {
        stopped = true
        failRest('定位阶段中止', 'failed')
      }
    }
    logger.info('单帧定位完成', {
      index: frame.index,
      regions: frame.regions.length,
      status: frame.regionStatus,
      elapsedMs: Date.now() - startedAt
    })
    bumpProgress()
    emitFrame(task, frame)
    scheduleSave(task)
  }

  async function worker(): Promise<void> {
    while (!signal.aborted && !stopped) {
      const frame = queue.shift()
      if (!frame) {
        if (producerDone) return
        await delay(REGION_POLL_INTERVAL_MS)
        continue
      }
      await locate(frame)
    }
  }

  const workersPromise = (async () => {
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
  })()
  workersPromise.catch(() => undefined)

  return {
    enqueue(frame) {
      planned += 1
      frame.regions = []
      frame.regionStatus = 'pending'
      frame.regionLevel = 'L0'
      frame.regionError = ''
      frame.regionRaw = ''
      if (stopped) {
        markFrame(frame, profileError ? 'unsupported' : 'failed', profileError || '定位阶段已中止')
        emitFrame(task, frame)
        return
      }
      void ensureProfileStarted()
      queue.push(frame)
    },
    finish: async () => {
      producerDone = true
      await workersPromise
      const locatedCount = located
      logger.info('定位阶段完成', {
        taskId: task.id,
        targets: planned,
        located: locatedCount,
        space: task.regionProfile?.coordinateSpace ?? 'unknown',
        dialect: task.regionProfile?.parseDialects[0] ?? 'none'
      })
      emitSummary(task, true)
    },
    abort: () => {
      stopped = true
      queue.length = 0
    },
    counts: () => ({ planned, located })
  }
}

export async function localizeFrames(
  task: TaskRecord,
  modelConfig: ResolvedModelConfig,
  signal: AbortSignal,
  options: LocalizeRunOptions
): Promise<void> {
  if (!task.config.localize) return
  let targets = regionCandidateFrames(task)
  if (options.onlyPendingRegions) {
    targets = targets.filter((frame) => frame.regionStatus !== 'ok')
  }
  if (targets.length === 0) return

  task.phaseMessage = '正在定位违禁物'
  if (options.onlyLocalize) task.progress = 0
  emitSummary(task, true)
  await flushSave(task)

  const runner = createRegionRunner(task, modelConfig, signal, options.onlyLocalize)
  for (const frame of targets) runner.enqueue(frame)
  await runner.finish()
  if (signal.aborted) throw new Error('任务已取消')
  task.phaseMessage = '正在分析'
}
