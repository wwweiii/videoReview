import crypto from 'node:crypto'
import fs from 'node:fs'
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_SEC } from '@shared/defaults'
import { getPresetPath } from '../paths'
import { logger } from '../logger'

// This key protects the preset against casual inspection. Because the client
// application must decrypt it locally, it is obfuscation rather than a server
// side secret. The preset content is never sent to the renderer process.
const PRESET_KEY_HEX = '8f1d2c5a77e94b46f0d315e2bc8a911d4b6e23f7a05c9d78e6134f2cad9b75e0'

export interface PresetDefaults {
  itemImageScalePercent?: number
  behaviorImageScalePercent?: number
  intervalSec?: number
  prohibitedItems?: string[]
  analysisMode?: 'single' | 'group'
  groupSize?: number
  confidenceThreshold?: number
  /** 是否默认开启违禁物定位标记 */
  localize?: boolean
}

export interface PresetModelConfig {
  baseUrl: string
  model: string
  apiKey: string
  concurrency: number
  timeoutSec: number
  extraHeaders: string
  /** 运行时高级配置（可选，用于多客户分发时预置模型适配参数） */
  extraBody?: string
  /** 仅用于迁移旧预设中的行为缩放默认值。 */
  imageScalePercent?: number
  coordinateSpaceOverride?: 'auto' | 'normalized_1000' | 'normalized_100' | 'normalized_01' | 'absolute_px'
  boxOrderOverride?: 'auto' | 'xyxy' | 'yxyx'
  parseDialectOverride?: 'auto' | 'json_multi' | 'box_tokens' | 'loc_bins' | 'plain_coords' | 'none'
  defaults?: PresetDefaults
}

interface EncryptedEnvelope {
  v: number
  iv: string
  tag: string
  data: string
}

let cached: PresetModelConfig | null | undefined

function decodePreset(): PresetModelConfig | null {
  const filePath = getPresetPath()
  if (!fs.existsSync(filePath)) return null
  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EncryptedEnvelope
    if (envelope.v !== 1) throw new Error('不支持的内置预设格式')
    const key = Buffer.from(PRESET_KEY_HEX, 'hex')
    const iv = Buffer.from(envelope.iv, 'base64')
    const tag = Buffer.from(envelope.tag, 'base64')
    const encrypted = Buffer.from(envelope.data, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    const parsed = JSON.parse(plain) as Partial<PresetModelConfig>
    if (!parsed.baseUrl || !parsed.model) throw new Error('内置预设缺少接口地址或模型名称')
    const rawDefaults = (parsed.defaults ?? {}) as PresetDefaults
    const defaults: PresetDefaults = {}
    if (Number.isFinite(Number(rawDefaults.itemImageScalePercent))) defaults.itemImageScalePercent = Number(rawDefaults.itemImageScalePercent)
    if (Number.isFinite(Number(rawDefaults.behaviorImageScalePercent))) defaults.behaviorImageScalePercent = Number(rawDefaults.behaviorImageScalePercent)
    if (Number.isFinite(Number(rawDefaults.intervalSec))) defaults.intervalSec = Number(rawDefaults.intervalSec)
    if (Array.isArray(rawDefaults.prohibitedItems)) {
      defaults.prohibitedItems = rawDefaults.prohibitedItems.filter(
        (id): id is string => typeof id === 'string'
      )
    }
    if (rawDefaults.analysisMode === 'single' || rawDefaults.analysisMode === 'group') {
      defaults.analysisMode = rawDefaults.analysisMode
    }
    if (Number.isFinite(Number(rawDefaults.groupSize))) defaults.groupSize = Number(rawDefaults.groupSize)
    if (Number.isFinite(Number(rawDefaults.confidenceThreshold))) {
      defaults.confidenceThreshold = Number(rawDefaults.confidenceThreshold)
    }
    if (typeof rawDefaults.localize === 'boolean') defaults.localize = rawDefaults.localize
    return {
      baseUrl: String(parsed.baseUrl),
      model: String(parsed.model),
      apiKey: parsed.apiKey ? String(parsed.apiKey) : '',
      concurrency: Number(parsed.concurrency) || DEFAULT_CONCURRENCY,
      timeoutSec: Number(parsed.timeoutSec) || DEFAULT_TIMEOUT_SEC,
      extraHeaders: parsed.extraHeaders ? String(parsed.extraHeaders) : '',
      extraBody: parsed.extraBody ? String(parsed.extraBody) : '',
      imageScalePercent: Number.isFinite(Number(parsed.imageScalePercent))
        ? Number(parsed.imageScalePercent)
        : undefined,
      coordinateSpaceOverride: parsed.coordinateSpaceOverride as PresetModelConfig['coordinateSpaceOverride'],
      boxOrderOverride: parsed.boxOrderOverride as PresetModelConfig['boxOrderOverride'],
      parseDialectOverride: parsed.parseDialectOverride as PresetModelConfig['parseDialectOverride'],
      defaults
    }
  } catch (error) {
    logger.error('读取内置模型预设失败', error)
    return null
  }
}

export function getPresetConfig(): PresetModelConfig | null {
  if (cached === undefined) cached = decodePreset()
  return cached
}

export function isPresetAvailable(): boolean {
  return getPresetConfig() !== null
}
