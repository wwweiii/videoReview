import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Keep in sync with src/main/config/preset.ts.
const PRESET_KEY_HEX = '8f1d2c5a77e94b46f0d315e2bc8a911d4b6e23f7a05c9d78e6134f2cad9b75e0'

const baseUrl = process.env.PRESET_BASE_URL
const model = process.env.PRESET_MODEL
const apiKey = process.env.PRESET_API_KEY || ''
const concurrency = Number(process.env.PRESET_CONCURRENCY || 2)
const timeoutSec = Number(process.env.PRESET_TIMEOUT_SEC || 120)
const extraHeaders = process.env.PRESET_EXTRA_HEADERS || ''
const intervalSec = process.env.PRESET_INTERVAL_SEC
const items = process.env.PRESET_ITEMS
const analysisMode = process.env.PRESET_MODE
const groupSize = process.env.PRESET_GROUP_SIZE
const confidenceThreshold = process.env.PRESET_THRESHOLD
const localize = process.env.PRESET_LOCALIZE
const extraBody = process.env.PRESET_EXTRA_BODY || ''
const maxTokens = process.env.PRESET_MAX_TOKENS
const imageMaxEdge = process.env.PRESET_IMAGE_MAX_EDGE
const imageFormat = process.env.PRESET_IMAGE_FORMAT
const promptLanguage = process.env.PRESET_PROMPT_LANGUAGE
const coordinateSpaceOverride = process.env.PRESET_COORD_SPACE
const boxOrderOverride = process.env.PRESET_BOX_ORDER
const parseDialectOverride = process.env.PRESET_PARSE_DIALECT

if (!baseUrl || !model) {
  console.error(
    [
      'Usage (PowerShell):',
      '  $env:PRESET_BASE_URL="http://10.0.0.10:8000/v1"; $env:PRESET_MODEL="qwen2.5-vl-32b-instruct"; node scripts/encrypt-preset.mjs',
      '',
      'Optional:',
      '  PRESET_API_KEY, PRESET_CONCURRENCY, PRESET_TIMEOUT_SEC, PRESET_EXTRA_HEADERS',
      '  PRESET_INTERVAL_SEC, PRESET_ITEMS (逗号分隔), PRESET_MODE (single/group),',
      '  PRESET_GROUP_SIZE, PRESET_THRESHOLD',
      '',
      '定位标记相关:',
      '  PRESET_LOCALIZE (true/false)',
      '  PRESET_EXTRA_BODY (JSON 字符串，透传到请求体)',
      '  PRESET_MAX_TOKENS, PRESET_IMAGE_MAX_EDGE (0=原图), PRESET_IMAGE_FORMAT (png/jpeg)',
      '  PRESET_PROMPT_LANGUAGE (zh/en)',
      '  PRESET_COORD_SPACE (auto/normalized_1000/normalized_100/normalized_01/absolute_px)',
      '  PRESET_BOX_ORDER (auto/xyxy/yxyx)',
      '  PRESET_PARSE_DIALECT (auto/json_multi/box_tokens/loc_bins/plain_coords)'
    ].join('\n')
  )
  process.exit(1)
}

let extraHeadersObject = {}
if (extraHeaders.trim()) {
  try {
    extraHeadersObject = JSON.parse(extraHeaders)
    if (!extraHeadersObject || typeof extraHeadersObject !== 'object' || Array.isArray(extraHeadersObject)) {
      throw new Error('not an object')
    }
  } catch {
    console.error('PRESET_EXTRA_HEADERS must be a valid JSON object')
    process.exit(1)
  }
}

const runtime = {}
if (extraBody.trim()) {
  try {
    const parsed = JSON.parse(extraBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    runtime.extraBody = extraBody.trim()
  } catch {
    console.error('PRESET_EXTRA_BODY must be a valid JSON object string')
    process.exit(1)
  }
}
if (Number.isFinite(Number(maxTokens))) runtime.maxTokens = Number(maxTokens)
if (Number.isFinite(Number(imageMaxEdge))) runtime.imageMaxEdge = Number(imageMaxEdge)
if (imageFormat === 'png' || imageFormat === 'jpeg') runtime.imageFormat = imageFormat
if (promptLanguage === 'zh' || promptLanguage === 'en') runtime.promptLanguage = promptLanguage
if (
  ['auto', 'normalized_1000', 'normalized_100', 'normalized_01', 'absolute_px'].includes(
    coordinateSpaceOverride
  )
) {
  runtime.coordinateSpaceOverride = coordinateSpaceOverride
}
if (['auto', 'xyxy', 'yxyx'].includes(boxOrderOverride)) runtime.boxOrderOverride = boxOrderOverride
if (
  ['auto', 'json_multi', 'box_tokens', 'loc_bins', 'plain_coords', 'none'].includes(
    parseDialectOverride
  )
) {
  runtime.parseDialectOverride = parseDialectOverride
}

const defaults = {}
if (Number.isFinite(Number(intervalSec))) defaults.intervalSec = Number(intervalSec)
if (items && items.trim()) defaults.prohibitedItems = items.split(',').map((id) => id.trim()).filter(Boolean)
if (analysisMode === 'single' || analysisMode === 'group') defaults.analysisMode = analysisMode
if (Number.isFinite(Number(groupSize))) defaults.groupSize = Number(groupSize)
if (Number.isFinite(Number(confidenceThreshold))) defaults.confidenceThreshold = Number(confidenceThreshold)
if (localize === 'true' || localize === 'false') defaults.localize = localize === 'true'

const payload = JSON.stringify({
  baseUrl: String(baseUrl).trim(),
  model: String(model).trim(),
  apiKey: String(apiKey).trim(),
  concurrency: Number.isFinite(concurrency) ? Math.min(8, Math.max(1, Math.round(concurrency))) : 2,
  timeoutSec: Number.isFinite(timeoutSec) ? Math.min(600, Math.max(15, Math.round(timeoutSec))) : 120,
  extraHeaders,
  ...runtime,
  defaults
})

const key = Buffer.from(PRESET_KEY_HEX, 'hex')
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
const tag = cipher.getAuthTag()
const envelope = {
  v: 1,
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  data: encrypted.toString('base64')
}

const outPath = path.resolve('resources/config/preset.enc')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf8')
console.log(`Encrypted preset written to ${outPath}`)
console.log(`Model fields: ${Object.keys(extraHeadersObject).length ? 'base URL, model, key, headers' : 'base URL, model, key'}`)
