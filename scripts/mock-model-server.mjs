/**
 * Mock 多模态模型服务（OpenAI 兼容）——「违禁物定位标记 P0」测试桩。
 *
 * 在原有「判定」能力之上扩展了三类请求与多方言/多坐标空间：
 *   - 能力探针（system 含「能力自检」）→ 按 PROBE_RECTS 返回 5 个彩色矩形
 *   - 定位请求（system 含「视觉定位助手」/ visual localization assistant）→ 返回手机、相机 2 个框
 *   - 判定请求（其余）→ 保持原有 abnormal/categories/... 语义
 *
 * 环境变量：
 *   MOCK_PORT           监听端口，默认 8899（兼容旧的 MOCK_MODEL_PORT）
 *   MOCK_DIALECT        json（默认）| bbox_2d | box_tokens | plain | single | none
 *   MOCK_SPACE          normalized_1000（默认）| normalized_100 | normalized_01 | absolute
 *   MOCK_ABNORMAL_EVERY 每 N 个判定请求出现 1 个异常，默认 3
 *   MOCK_DELAY_MS       每条响应延迟毫秒，默认 300（验证脚本会设为 0）
 *
 * 输出形态遵循各族规范示例（src/shared/localization/dialects.ts 已支持 token-first 与单括号四元组）：
 *   - box_tokens：`<ref>标签</ref><box>[[x1, y1, x2, y2]]</box>`，多框时每框一行；
 *   - plain：`标签: (x1, y1, x2, y2)` 单括号四元组。
 *
 * 请求尺寸：从 user 文本解析「图片尺寸为 1120×672」/「image size 1120x672」；
 * 也接受 `x-mock-image-size: 1120x672` 请求头；都拿不到时按 1120×672。
 * mock 不读取图片内容（1×1 PNG 占位即可）。
 */

import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || process.env.MOCK_MODEL_PORT || 8899)
const DELAY_MS = Math.max(0, Number(process.env.MOCK_DELAY_MS ?? 300))
const ABNORMAL_EVERY = Math.max(1, Math.floor(Number(process.env.MOCK_ABNORMAL_EVERY || 3)))
const DEFAULT_SIZE = { width: 1120, height: 672 }

const DIALECT_ALIASES = {
  json: 'json',
  json_multi: 'json',
  bbox_2d: 'bbox_2d',
  bbox2d: 'bbox_2d',
  box_tokens: 'box_tokens',
  tokens: 'box_tokens',
  plain: 'plain',
  plain_coords: 'plain',
  single: 'single',
  none: 'none'
}

const SPACE_ALIASES = {
  normalized_1000: 'normalized_1000',
  normalized_100: 'normalized_100',
  normalized_01: 'normalized_01',
  absolute: 'absolute_px',
  absolute_px: 'absolute_px'
}

const requestedDialect = String(process.env.MOCK_DIALECT || 'json')
  .trim()
  .toLowerCase()
const DIALECT = DIALECT_ALIASES[requestedDialect] ?? 'json'
if (!DIALECT_ALIASES[requestedDialect]) {
  console.warn(`[mock] 未知 MOCK_DIALECT=${requestedDialect}，回退为 json`)
}

const requestedSpace = String(process.env.MOCK_SPACE || 'normalized_1000')
  .trim()
  .toLowerCase()
const SPACE = SPACE_ALIASES[requestedSpace] ?? 'normalized_1000'
if (!SPACE_ALIASES[requestedSpace]) {
  console.warn(`[mock] 未知 MOCK_SPACE=${requestedSpace}，回退为 normalized_1000`)
}

/** 与 src/shared/localization/probe.ts 的 PROBE_RECTS 保持一致（verify 脚本会校验漂移） */
const PROBE_RECTS = [
  { label: 'red', rect: [0.1, 0.1, 0.3, 0.4] },
  { label: 'blue', rect: [0.62, 0.52, 0.8, 0.84] },
  { label: 'green', rect: [0.44, 0.42, 0.5, 0.5] },
  { label: 'yellow', rect: [0.2, 0.86, 0.7, 0.92] },
  { label: 'black', rect: [0.03, 0.03, 0.1, 0.1] }
]

/** 定位请求固定返回的 2 个归一化框 */
const LOCATE_BOXES = [
  { label: '手机', rect: [0.42, 0.52, 0.58, 0.78] },
  { label: '相机', rect: [0.1, 0.3, 0.22, 0.44] }
]

let requestCount = 0
let probeCount = 0
let locateCount = 0
let judgmentCount = 0

/* ------------------------------------------------------------------ */
/* 请求解析                                                             */
/* ------------------------------------------------------------------ */

function partText(part) {
  return part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join('\n')
  return ''
}

function systemText(messages) {
  return messages
    .filter((message) => message && message.role === 'system')
    .map((message) => contentText(message.content))
    .join('\n')
}

function userText(messages) {
  return messages
    .filter((message) => message && message.role === 'user')
    .map((message) => contentText(message.content))
    .join('\n')
}

function countImages(messages) {
  let total = 0
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && part.type === 'image_url') total += 1
    }
  }
  return total
}

function parseSizeFromText(text) {
  const patterns = [
    /图片尺寸为\s*(\d+)\s*[×xX*]\s*(\d+)/,
    /image\s*size\s*[:：]?\s*(\d+)\s*[×xX*]\s*(\d+)/i,
    /(?:尺寸|分辨率)\s*[:：]?\s*(\d+)\s*[×xX*]\s*(\d+)/,
    /(\d{2,5})\s*[×xX]\s*(\d{2,5})/ // 兜底：任意 "1120x672" 写法
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const width = Number(match[1])
    const height = Number(match[2])
    if (width > 0 && height > 0) return { width, height }
  }
  return null
}

function parseSizeFromHeader(req) {
  const raw = req.headers['x-mock-image-size']
  if (typeof raw !== 'string') return null
  const match = raw.match(/^\s*(\d+)\s*[×xX*]\s*(\d+)\s*$/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

function classifyRequest(system, user) {
  const probeMarkers = ['能力自检', 'self-check']
  if (probeMarkers.some((marker) => system.toLowerCase().includes(marker.toLowerCase()))) {
    return 'probe'
  }
  const locateMarkers = ['视觉定位助手', 'visual localization assistant', '视觉定位']
  if (locateMarkers.some((marker) => system.toLowerCase().includes(marker.toLowerCase()))) {
    return 'locate'
  }
  return 'judgment'
}

/* ------------------------------------------------------------------ */
/* 坐标空间换算                                                         */
/* ------------------------------------------------------------------ */

/** 把归一化 [x1,y1,x2,y2] 换算到目标空间 */
function toSpace(rect, space, size) {
  const [x1, y1, x2, y2] = rect
  if (space === 'absolute_px') {
    return [
      Math.round(x1 * size.width),
      Math.round(y1 * size.height),
      Math.round(x2 * size.width),
      Math.round(y2 * size.height)
    ]
  }
  const scale = space === 'normalized_1000' ? 1000 : space === 'normalized_100' ? 100 : 1
  if (space === 'normalized_01') {
    return [x1, y1, x2, y2].map((value) => Math.round(value * 1000) / 1000)
  }
  return [x1, y1, x2, y2].map((value) => Math.round(value * scale))
}

function formatCoordinates(coords) {
  return coords.map((value) => String(value)).join(', ')
}

/**
 * 按方言序列化框列表。
 * dialect=single/none 是「数量模式」：single 只取第一个框，none 返回空列表；
 * 两者的坐标格式都沿用 json。
 */
function serializeBoxes(boxes, dialect, space, size) {
  const mode = dialect === 'single' || dialect === 'none' ? dialect : 'boxes'
  const selected =
    mode === 'none' ? [] : mode === 'single' ? boxes.slice(0, 1) : boxes.slice()
  const converted = selected.map((item) => ({
    label: item.label,
    coords: toSpace(item.rect, space, size)
  }))

  if (mode === 'boxes' && dialect === 'json') {
    return JSON.stringify({
      objects: converted.map((item) => ({
        label: item.label,
        bbox: item.coords,
        confidence: 0.9
      }))
    })
  }
  if (mode === 'boxes' && dialect === 'bbox_2d') {
    return JSON.stringify(
      converted.map((item) => ({ label: item.label, bbox_2d: item.coords }))
    )
  }
  if (mode === 'boxes' && dialect === 'box_tokens') {
    return converted
      .map((item) => `<ref>${item.label}</ref><box>[[${formatCoordinates(item.coords)}]]</box>`)
      .join('\n')
  }
  if (mode === 'boxes' && dialect === 'plain') {
    return converted
      .map((item) => `${item.label}: (${formatCoordinates(item.coords)})`)
      .join('\n')
  }
  // single / none：数量模式统一 JSON 输出
  return JSON.stringify({
    objects: converted.map((item) => ({
      label: item.label,
      bbox: item.coords,
      confidence: 0.9
    }))
  })
}

/* ------------------------------------------------------------------ */
/* 判定响应（保持原有语义）                                             */
/* ------------------------------------------------------------------ */

function frameVerdict(abnormal) {
  return {
    abnormal,
    risk_level: abnormal ? 'high' : 'none',
    categories: abnormal ? ['手机'] : [],
    description: abnormal ? '模拟模型：画面中疑似出现一部手机。' : '',
    evidence: abnormal ? '模拟模型生成的测试证据。' : '',
    confidence: abnormal ? 0.88 : 0.95,
    need_human_review: false
  }
}

function buildJudgmentContent(imageCount) {
  judgmentCount += 1
  if (imageCount > 1) {
    const frames = Array.from({ length: imageCount }, (_, index) => ({
      frame_index: index,
      ...frameVerdict((judgmentCount + index) % ABNORMAL_EVERY === 0)
    }))
    return JSON.stringify({ frames })
  }
  const abnormal = judgmentCount % ABNORMAL_EVERY === 0
  return JSON.stringify(frameVerdict(abnormal))
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function buildCompletion(content, model) {
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-vl',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  }
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'mock-model-server',
        version: '2.0.0',
        dialect: DIALECT,
        space: SPACE,
        abnormalEvery: ABNORMAL_EVERY,
        delayMs: DELAY_MS,
        counts: { requestCount, probeCount, locateCount, judgmentCount }
      })
      return
    }

    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'Not found' } })
      return
    }

    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        requestCount += 1
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // Keep empty; 下面的缺省判定会返回一条兜底内容。
        }

        const messages = Array.isArray(body.messages) ? body.messages : []
        const system = systemText(messages)
        const user = userText(messages)
        const images = countImages(messages)

        let content
        if (user.includes('连接成功')) {
          content = '连接成功'
        } else {
          const kind = classifyRequest(system, user)
          if (kind === 'probe') {
            probeCount += 1
            const size =
              parseSizeFromText(user) || parseSizeFromHeader(req) || { ...DEFAULT_SIZE }
            content = serializeBoxes(PROBE_RECTS, DIALECT, SPACE, size)
          } else if (kind === 'locate') {
            locateCount += 1
            const size =
              parseSizeFromText(user) || parseSizeFromHeader(req) || { ...DEFAULT_SIZE }
            content = serializeBoxes(LOCATE_BOXES, DIALECT, SPACE, size)
          } else {
            content = buildJudgmentContent(images)
          }
        }

        const response = buildCompletion(content, body.model)
        const delay = DELAY_MS
        if (delay > 0) setTimeout(() => sendJson(res, 200, response), delay)
        else sendJson(res, 200, response)
      } catch (error) {
        sendJson(res, 500, { error: { message: `mock server error: ${error.message}` } })
      }
    })
  } catch (error) {
    try {
      sendJson(res, 500, { error: { message: `mock server error: ${error.message}` } })
    } catch {
      // 响应已发出，忽略。
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${PORT}/v1`
  console.log(`Mock multimodal endpoint: ${baseUrl}`)
  console.log(`Base URL: ${baseUrl}`)
  console.log('Model: mock-vl')
  console.log(
    `Config: dialect=${DIALECT} space=${SPACE} abnormalEvery=${ABNORMAL_EVERY} delayMs=${DELAY_MS}`
  )
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
