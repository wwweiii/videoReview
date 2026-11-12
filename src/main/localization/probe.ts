import type { ChatMessage } from '@shared/localization/request'
import { buildProbeMessages } from '@shared/localization/prompts'
import {
  PROBE_FULL_SIZE,
  PROBE_HALF_SIZE,
  evaluateProbe,
  type ProbeEvaluation
} from '@shared/localization/probe'
import { DEFAULT_PARSE_ORDER, profileId, type ModelProfile } from '@shared/localization/profile'
import type { ResolvedModelConfig } from '../config/model-config'
import {
  applyProfileOverrides,
  computePromptFingerprint,
  getProfile,
  saveProfile
} from '../config/profiles'
import { logger } from '../logger'
import { requestChat } from '../model/client'
import { probeDataUrl } from './probe-image'

export class LocalizationUnavailableError extends Error {}

function probeMessages(size: { width: number; height: number }, language: 'zh' | 'en'): ChatMessage[] {
  const { system, user } = buildProbeMessages(language)
  const hint = `（图片尺寸 ${size.width}×${size.height}）`
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: `${user}${hint}` },
        { type: 'image_url', image_url: { url: probeDataUrl(size.width, size.height) } }
      ]
    }
  ]
}

export interface ProbeOutcome {
  profile: ModelProfile
  evaluation: ProbeEvaluation
  rawFirstResponse: string
  rawSecondResponse: string
  /** 本次探测未通过，但沿用了上次成功的档案 */
  reusedExisting?: boolean
}

interface ProbeAttempt {
  evaluation: ProbeEvaluation
  first: string
  second: string
}

async function probeOnce(
  config: ResolvedModelConfig,
  signal?: AbortSignal
): Promise<ProbeAttempt> {
  const first = await requestChat(config, probeMessages(PROBE_FULL_SIZE, config.promptLanguage), {
    maxTokens: Math.min(Math.max(config.maxTokens, 800), 2048),
    timeoutSec: Math.min(config.timeoutSec, 120),
    signal
  })
  let secondText = ''
  try {
    const second = await requestChat(
      config,
      probeMessages(PROBE_HALF_SIZE, config.promptLanguage),
      {
        maxTokens: Math.min(Math.max(config.maxTokens, 800), 2048),
        timeoutSec: Math.min(config.timeoutSec, 120),
        signal
      }
    )
    secondText = second.content
  } catch (error) {
    logger.warn('半尺寸探针请求失败', error)
  }
  return {
    evaluation: evaluateProbe(first.content, secondText),
    first: first.content,
    second: secondText
  }
}

/** 运行能力探针并把结论写入模型档案 */
export async function probeModelConfig(
  config: ResolvedModelConfig,
  maxBoxes: number,
  signal?: AbortSignal
): Promise<ProbeOutcome> {
  const promptFingerprint = computePromptFingerprint(config, maxBoxes)

  // 外部 API 的输出有随机性：第一次不通过时再测一次，取更优结果，避免一次抖动把能力档杀掉
  let attempt = await probeOnce(config, signal)
  if (!attempt.evaluation.ok && !signal?.aborted) {
    try {
      const retry = await probeOnce(config, signal)
      if (retry.evaluation.score >= attempt.evaluation.score) attempt = retry
      logger.info('模型能力探针重试', {
        model: config.model,
        firstScore: attempt.evaluation.score,
        retryScore: retry.evaluation.score
      })
    } catch (error) {
      logger.warn('探针重试失败', error)
    }
  }

  const evaluation = attempt.evaluation
  const existing = getProfile(config, maxBoxes)

  // 之前能定位、这次没通过 → 不降级，沿用旧档案（避免用户点一次探测就把功能弄坏）
  if (!evaluation.ok && existing?.localizationOk && existing.coordinateSpace !== 'unknown') {
    logger.warn('本次探测未通过，沿用上次成功档案', {
      model: config.model,
      score: evaluation.score,
      notes: evaluation.notes
    })
    return {
      profile: existing,
      evaluation,
      rawFirstResponse: attempt.first.slice(0, 2000),
      rawSecondResponse: attempt.second.slice(0, 2000),
      reusedExisting: true
    }
  }

  const profile: ModelProfile = {
    id: profileId(config.baseUrl, config.model, promptFingerprint),
    baseUrl: config.baseUrl,
    model: config.model,
    promptFingerprint,
    probedAt: new Date().toISOString(),
    jsonOk: evaluation.jsonOk,
    localizationOk: evaluation.ok,
    coordinateSpace: evaluation.coordinateSpace,
    boxOrder: evaluation.boxOrder,
    parseDialects:
      evaluation.dialect === 'none'
        ? [...DEFAULT_PARSE_ORDER]
        : [evaluation.dialect, ...DEFAULT_PARSE_ORDER.filter((item) => item !== evaluation.dialect)],
    scaleX: evaluation.scaleX,
    scaleY: evaluation.scaleY,
    maxBoxes: evaluation.multiTarget ? maxBoxes : 1,
    multiTarget: evaluation.multiTarget,
    thinkingPolluted: evaluation.thinkingPolluted,
    tokenLeak: evaluation.tokenLeak,
    notes: evaluation.notes
  }
  saveProfile(profile)
  logger.info('模型能力探针完成', {
    model: config.model,
    ok: profile.localizationOk,
    space: profile.coordinateSpace,
    order: profile.boxOrder,
    dialect: profile.parseDialects[0],
    score: evaluation.score,
    boxes: evaluation.boxesFound
  })
  return {
    profile,
    evaluation,
    rawFirstResponse: attempt.first.slice(0, 2000),
    rawSecondResponse: attempt.second.slice(0, 2000)
  }
}

/** 取当前配置可用的档案：已有就用，没有就跑探针，最后应用手动覆盖 */
export async function ensureProfile(
  config: ResolvedModelConfig,
  maxBoxes: number,
  signal?: AbortSignal
): Promise<ModelProfile> {
  let profile = getProfile(config, maxBoxes)
  if (!profile || (!profile.localizationOk && profile.coordinateSpace === 'unknown')) {
    try {
      const outcome = await probeModelConfig(config, maxBoxes, signal)
      profile = outcome.profile
    } catch (error) {
      if (signal?.aborted) throw error
      logger.warn('模型能力探针失败', error)
      profile = null
    }
  }
  const effective = applyProfileOverrides(profile, config, maxBoxes)
  if (!effective || !effective.localizationOk || effective.coordinateSpace === 'unknown') {
    const reason = effective?.notes?.slice(-2).join('；') || '未探测到可用的定位能力'
    throw new LocalizationUnavailableError(reason)
  }
  return effective
}
