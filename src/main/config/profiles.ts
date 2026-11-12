/**
 * 模型能力档案（ModelProfile）的持久化与覆盖逻辑。
 *
 * 存储位置：<data>/model-profiles.json
 * 键：normalize(baseUrl)|model|promptFingerprint（提示词/语言/覆盖项变化会自动失效）
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  LOCALIZE_PROMPT_VERSION
} from '@shared/localization/prompts'
import {
  type ModelProfile,
  profileId,
  unknownProfile
} from '@shared/localization/profile'
import { getDataDir } from '../paths'
import { logger } from '../logger'
import type { ResolvedModelConfig } from './model-config'

let cache: Map<string, ModelProfile> | null = null

function profilesPath(): string {
  return path.join(getDataDir(), 'model-profiles.json')
}

function loadProfiles(): Map<string, ModelProfile> {
  if (cache) return cache
  const map = new Map<string, ModelProfile>()
  try {
    const filePath = profilesPath()
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, ModelProfile>
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object') map.set(key, value)
      }
    }
  } catch (error) {
    logger.warn('读取模型能力档案失败', error)
  }
  cache = map
  return map
}

function persistProfiles(): void {
  if (!cache) return
  try {
    const filePath = profilesPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const plain: Record<string, ModelProfile> = {}
    for (const [key, value] of cache) plain[key] = value
    const temporary = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(plain, null, 2), 'utf8')
    fs.renameSync(temporary, filePath)
  } catch (error) {
    logger.warn('保存模型能力档案失败', error)
  }
}

export function computePromptFingerprint(config: ResolvedModelConfig): string {
  const payload = [
    LOCALIZE_PROMPT_VERSION,
    config.promptLanguage,
    config.coordinateSpaceOverride,
    config.boxOrderOverride,
    config.parseDialectOverride
  ].join('|')
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export function getProfile(config: ResolvedModelConfig): ModelProfile | null {
  const key = profileId(config.baseUrl, config.model, computePromptFingerprint(config))
  return loadProfiles().get(key) ?? null
}

export function saveProfile(profile: ModelProfile): void {
  const map = loadProfiles()
  map.set(profile.id, profile)
  persistProfiles()
}

/**
 * 应用运维手动覆盖：
 * - 强制坐标空间 / 轴序 / 方言；
 * - 当"坐标空间 + 方言"都被显式指定时，视为运维确认该端点能出框（无需探针）。
 */
export function applyProfileOverrides(
  base: ModelProfile | null,
  config: ResolvedModelConfig
): ModelProfile | null {
  const hasOverride =
    config.coordinateSpaceOverride !== 'auto' ||
    config.boxOrderOverride !== 'auto' ||
    config.parseDialectOverride !== 'auto'
  if (!hasOverride && !base) return null
  const profile =
    base ??
    unknownProfile(
      config.baseUrl,
      config.model,
      computePromptFingerprint(config)
    )
  const next: ModelProfile = { ...profile }
  if (config.coordinateSpaceOverride !== 'auto') {
    next.coordinateSpace = config.coordinateSpaceOverride
  }
  if (config.boxOrderOverride !== 'auto') {
    next.boxOrder = config.boxOrderOverride
  }
  if (config.parseDialectOverride !== 'auto') {
    next.parseDialects = [
      config.parseDialectOverride,
      ...next.parseDialects.filter((item) => item !== config.parseDialectOverride)
    ]
  }
  if (
    config.coordinateSpaceOverride !== 'auto' &&
    config.parseDialectOverride !== 'auto' &&
    next.parseDialects.length > 0
  ) {
    next.localizationOk = true
    next.notes = [...next.notes, '坐标空间与方言由运维手动指定']
  }
  return next
}
