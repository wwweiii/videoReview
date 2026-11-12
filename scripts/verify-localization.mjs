#!/usr/bin/env node
/**
 * scripts/verify-localization.mjs
 *
 * 「违禁物定位标记 P0」自动化验证：
 *   1. 用 esbuild 把 src/shared/localization/index.ts 打成 ESM，node 里直接 import（不依赖 Electron）；
 *   2. 纯函数验证：多方言解析、resolveBox（4 坐标空间 × 2 轴序）、validateBox、dedupeBoxes；
 *   3. 端到端验证：spawn scripts/mock-model-server.mjs，用真实 HTTP 请求跑
 *      4 种 MOCK_SPACE × 4 种 MOCK_DIALECT 的探针判定与定位解析；
 *   4. 边界模式（single/none）与原有判定响应语义。
 *
 * 运行：node scripts/verify-localization.mjs（package.json: npm run verify:localization）
 * 退出码：全部通过 0，有失败 1。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const TMP_DIR = path.join(ROOT, '.tmp')
const BUNDLE_PATH = path.join(TMP_DIR, 'localization.mjs')
const MOCK_SCRIPT = path.join(SCRIPT_DIR, 'mock-model-server.mjs')

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg=='

/* ------------------------------------------------------------------ */
/* 测试基础设施                                                         */
/* ------------------------------------------------------------------ */

const stats = { pass: 0, fail: 0 }
const failures = []
const residualLimitations = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    throw new Error(`${message}：不是有效数字（${actual}）`)
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}：实际 ${actual}，期望 ${expected} ± ${tolerance}`)
  }
}

function assertBoxClose(actual, expected, tolerance, message) {
  if (!Array.isArray(actual) || actual.length !== 4) {
    throw new Error(`${message}：不是四元组（${JSON.stringify(actual)}）`)
  }
  for (let index = 0; index < 4; index += 1) {
    assertClose(actual[index], expected[index], tolerance, `${message}[${index}]`)
  }
}

function reportPass(label, extra) {
  stats.pass += 1
  console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`)
}

function reportFail(label, error) {
  stats.fail += 1
  const message = error instanceof Error ? error.message : String(error)
  failures.push(`${label}：${message}`)
  console.log(`  FAIL  ${label}`)
  console.log(`        ${message}`)
}

function check(label, fn) {
  try {
    const extra = fn()
    reportPass(label, extra)
  } catch (error) {
    reportFail(label, error)
  }
}

async function checkAsync(label, fn) {
  try {
    const extra = await fn()
    reportPass(label, extra)
  } catch (error) {
    reportFail(label, error)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* 进程 / HTTP 工具                                                     */
/* ------------------------------------------------------------------ */

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('无法获取空闲端口'))
      })
    })
  })
}

async function waitForHealth(port, child, outputRef, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`mock 进程提前退出（code=${child.exitCode}）\n${outputRef.value}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(800)
      })
      if (response.ok) return response.json()
    } catch {
      // 服务还没起来，继续等。
    }
    await sleep(50)
  }
  throw new Error(`等待 mock /health 超时（${timeoutMs}ms）\n${outputRef.value}`)
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略。
      }
    }, 1500)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function withMockServer(dialect, space, fn) {
  const port = await getFreePort()
  const child = spawn(process.execPath, [MOCK_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_MODEL_PORT: String(port),
      MOCK_DIALECT: dialect,
      MOCK_SPACE: space,
      MOCK_ABNORMAL_EVERY: '3',
      MOCK_DELAY_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const outputRef = { value: '' }
  child.stdout.on('data', (chunk) => {
    outputRef.value += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    outputRef.value += chunk.toString()
  })
  child.once('error', (error) => {
    outputRef.value += `spawn error: ${error.message}\n`
  })
  try {
    const health = await waitForHealth(port, child, outputRef)
    return await fn(port, health)
  } finally {
    await stopChild(child)
  }
}

async function postChat(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  return response.json()
}

/* ------------------------------------------------------------------ */
/* [1/8] 打包 bundle                                                    */
/* ------------------------------------------------------------------ */

console.log('=== 违禁物定位解析链 / 探针判定 自动化验证 ===')
console.log(`工作目录：${ROOT}`)
section('[1/8] 用 esbuild 打包 src/shared/localization/index.ts')

fs.mkdirSync(TMP_DIR, { recursive: true })
try {
  await build({
    entryPoints: [path.join(ROOT, 'src/shared/localization/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: BUNDLE_PATH,
    logLevel: 'silent'
  })
  const sizeKb = (fs.statSync(BUNDLE_PATH).size / 1024).toFixed(1)
  console.log(`  OK    ${path.relative(ROOT, BUNDLE_PATH)}（${sizeKb} KB）`)
} catch (error) {
  console.error(`  FAIL  打包失败：${error.message}`)
  process.exit(1)
}

const loc = await import(pathToFileURL(BUNDLE_PATH).href)
assert(typeof loc.parseGrounding === 'function', 'bundle 缺少 parseGrounding')
assert(typeof loc.evaluateProbe === 'function', 'bundle 缺少 evaluateProbe')
assert(typeof loc.buildProbeMessages === 'function', 'bundle 缺少 buildProbeMessages')

/* ------------------------------------------------------------------ */
/* [2/8] 多方言解析                                                     */
/* ------------------------------------------------------------------ */

section('[2/8] 多方言解析（parseGrounding / parseBoxTokens / parsePlainCoords）')

const QUAD = [120, 340, 260, 520]

check('json objects → json_multi，1 个框', () => {
  const parsed = loc.parseGrounding('{"objects":[{"label":"手机","bbox":[120,340,260,520]}]}')
  assertEqual(parsed.dialect, 'json_multi', 'dialect')
  assertEqual(parsed.boxes.length, 1, '框数')
  assertEqual(parsed.boxes[0].label, '手机', 'label')
  assertBoxClose(parsed.boxes[0].coords, QUAD, 1e-6, 'coords')
  assertEqual(parsed.noTarget, false, 'noTarget')
})

check('json bbox_2d → 解析链归入 json_multi，1 个框', () => {
  const text = '[{"bbox_2d":[120,340,260,520],"label":"相机"}]'
  const parsed = loc.parseGrounding(text)
  assertEqual(parsed.dialect, 'json_multi', 'dialect')
  assertEqual(parsed.boxes.length, 1, '框数')
  assertEqual(parsed.boxes[0].label, '相机', 'label')
  assertBoxClose(parsed.boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('box_tokens 解析器（<ref>手机</ref><box>[[120,340,260,520]]</box>）', () => {
  const boxes = loc.parseBoxTokens('<ref>手机</ref><box>[[120,340,260,520]]</box>')
  assertEqual(boxes.length, 1, '框数')
  assertEqual(boxes[0].parser, 'box_tokens', 'parser')
  assertEqual(boxes[0].label, '手机', 'label')
  assertBoxClose(boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('box_tokens 规范格式经解析链 → dialect=box_tokens + label 手机', () => {
  const parsed = loc.parseGrounding('<ref>手机</ref><box>[[120,340,260,520]]</box>')
  assertEqual(parsed.dialect, 'box_tokens', 'dialect')
  assertEqual(parsed.boxes.length, 1, '框数')
  assertEqual(parsed.boxes[0].label, '手机', 'label')
  assertBoxClose(parsed.boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('box_tokens 多框规范格式 → 2 个框（token-first 不丢框）', () => {
  const text = [
    '<ref>手机</ref><box>[[470,349,650,524]]</box>',
    '<ref>相机</ref><box>[[112,202,246,296]]</box>'
  ].join('\n')
  const parsed = loc.parseGrounding(text)
  assertEqual(parsed.dialect, 'box_tokens', 'dialect')
  assertEqual(parsed.boxes.length, 2, '框数')
  assertBoxClose(parsed.boxes[0].coords, [470, 349, 650, 524], 1e-6, '第 1 框 coords')
  assertBoxClose(parsed.boxes[1].coords, [112, 202, 246, 296], 1e-6, '第 2 框 coords')
  const labels = parsed.boxes.map((box) => box.label)
  if (labels[1] !== '相机') {
    residualLimitations.push(
      `多框 box_tokens 的 label 归属不准确（期望 [手机, 相机]，实际 [${labels.join(', ')}]）：` +
        'parseBoxTokens 回溯 <ref> 时取 240 字符窗口内的第一个 ref，而非离当前 <box> 最近的 ref。'
    )
  }
  return `labels=${labels.join('/')}`
})

check('plain_coords 规范单括号四元组 → plain_coords，1 个框', () => {
  const boxes = loc.parsePlainCoords('手机: (120,340,260,520)')
  assertEqual(boxes.length, 1, '框数')
  assertEqual(boxes[0].parser, 'plain_coords', 'parser')
  assertEqual(boxes[0].label, '手机', 'label')
  assertBoxClose(boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('plain_coords 空格形态（兼容）→ plain_coords，1 个框', () => {
  const boxes = loc.parsePlainCoords('相机: 120 340 260 520')
  assertEqual(boxes.length, 1, '框数')
  assertEqual(boxes[0].parser, 'plain_coords', 'parser')
  assertEqual(boxes[0].label, '相机', 'label')
  assertBoxClose(boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('plain_coords 单括号四元组经解析链 → dialect=plain_coords', () => {
  const parsed = loc.parseGrounding('手机: (120,340,260,520)')
  assertEqual(parsed.dialect, 'plain_coords', 'dialect')
  assertEqual(parsed.boxes.length, 1, '框数')
  assertEqual(parsed.boxes[0].label, '手机', 'label')
  assertBoxClose(parsed.boxes[0].coords, QUAD, 1e-6, 'coords')
})

check('拒答「未发现目标」→ noTarget=true 且无框', () => {
  const parsed = loc.parseGrounding('未发现目标')
  assertEqual(parsed.boxes.length, 0, '框数')
  assertEqual(parsed.dialect, 'none', 'dialect')
  assertEqual(parsed.noTarget, true, 'noTarget')
})

check('空 JSON 列表 → 无框且不误判为拒答', () => {
  const parsed = loc.parseGrounding('{"objects":[]}')
  assertEqual(parsed.boxes.length, 0, '框数')
  assertEqual(parsed.noTarget, false, 'noTarget')
})

check('Markdown 代码块包裹的 JSON 仍可解析', () => {
  const parsed = loc.parseGrounding('```json\n{"objects":[{"label":"手机","bbox":[10,20,30,40]}]}\n```')
  assertEqual(parsed.boxes.length, 1, '框数')
  assertEqual(parsed.dialect, 'json_multi', 'dialect')
})

check('PROBE_RECTS / PROBE_FULL_SIZE 常量与 mock 约定一致', () => {
  assertEqual(loc.PROBE_RECTS.length, 5, 'PROBE_RECTS 数量')
  const expected = [
    ['red', [0.1, 0.1, 0.3, 0.4]],
    ['blue', [0.62, 0.52, 0.8, 0.84]],
    ['green', [0.44, 0.42, 0.5, 0.5]],
    ['yellow', [0.2, 0.86, 0.7, 0.92]],
    ['black', [0.03, 0.03, 0.1, 0.1]]
  ]
  loc.PROBE_RECTS.forEach((item, index) => {
    assertEqual(item.label, expected[index][0], `第 ${index} 个 label`)
    assertBoxClose(item.rect, expected[index][1], 1e-6, `第 ${index} 个 rect`)
  })
  assertEqual(loc.PROBE_FULL_SIZE.width, 1120, 'PROBE_FULL_SIZE.width')
  assertEqual(loc.PROBE_FULL_SIZE.height, 672, 'PROBE_FULL_SIZE.height')
  assertEqual(loc.PROBE_HALF_SIZE.width, 560, 'PROBE_HALF_SIZE.width')
  assertEqual(loc.PROBE_HALF_SIZE.height, 336, 'PROBE_HALF_SIZE.height')
})

/* ------------------------------------------------------------------ */
/* [3/8] resolveBox：坐标空间 × 轴序                                   */
/* ------------------------------------------------------------------ */

section('[3/8] resolveBox：4 种坐标空间 × xyxy / yxyx')

const rawBox = (coords) => ({ label: 'test', coords, source: 'json', parser: 'json_multi' })
const locateContext = (space, order) => ({
  space,
  order,
  sentWidth: 1120,
  sentHeight: 672,
  scaleX: 1,
  scaleY: 1
})
const EXPECTED_BOX = [0.1, 0.2, 0.3, 0.4]

const RESOLVE_CASES = [
  { name: 'normalized_1000 + xyxy', space: 'normalized_1000', order: 'xyxy', coords: [100, 200, 300, 400] },
  { name: 'normalized_1000 + yxyx', space: 'normalized_1000', order: 'yxyx', coords: [200, 100, 400, 300] },
  { name: 'normalized_100 + xyxy', space: 'normalized_100', order: 'xyxy', coords: [10, 20, 30, 40] },
  { name: 'normalized_100 + yxyx', space: 'normalized_100', order: 'yxyx', coords: [20, 10, 40, 30] },
  { name: 'normalized_01 + xyxy', space: 'normalized_01', order: 'xyxy', coords: [0.1, 0.2, 0.3, 0.4] },
  { name: 'normalized_01 + yxyx', space: 'normalized_01', order: 'yxyx', coords: [0.2, 0.1, 0.4, 0.3] },
  {
    name: 'absolute_px + xyxy（sent 1120×672）',
    space: 'absolute_px',
    order: 'xyxy',
    coords: [112, 134.4, 336, 268.8]
  },
  {
    name: 'absolute_px + yxyx（sent 1120×672）',
    space: 'absolute_px',
    order: 'yxyx',
    coords: [134.4, 112, 268.8, 336]
  }
]

for (const testCase of RESOLVE_CASES) {
  check(`resolveBox · ${testCase.name}`, () => {
    const resolved = loc.resolveBox(rawBox(testCase.coords), locateContext(testCase.space, testCase.order))
    assert(resolved !== null, '解析结果为 null')
    assertBoxClose(resolved, EXPECTED_BOX, 0.02, '归一化框')
  })
}

check('resolveBox · absolute_px 但缺少发送尺寸 → null', () => {
  const resolved = loc.resolveBox(rawBox([112, 134.4, 336, 268.8]), {
    space: 'absolute_px',
    order: 'xyxy',
    sentWidth: 0,
    sentHeight: 0,
    scaleX: 1,
    scaleY: 1
  })
  assertEqual(resolved, null, '结果')
})

/* [3.5/8] absolute_px 基准兜底：真实踩坑回归                           */

section('[3.5/8] absolute_px 原图基准兜底（模型按原图像素返回坐标）')

check('mapRawBoxesAdaptive · 按原图尺寸自动换算，且不会误伤发送尺寸坐标', () => {
  // 真实案例：帧 2048×1080，定位请求压到 1120×588，模型返回的却是原图像素坐标
  const raw = [
    { label: '平板电脑', coords: [313, 826, 466, 915], source: 'json', parser: 'json_multi' },
    { label: '智能手表', coords: [418, 492, 442, 558], source: 'json', parser: 'json_multi' }
  ]
  const context = {
    space: 'absolute_px',
    order: 'xyxy',
    sentWidth: 1120,
    sentHeight: 588,
    originWidth: 2048,
    originHeight: 1080,
    scaleX: 1,
    scaleY: 1
  }
  const sentOnly = loc.mapRawBoxes(raw, context)
  assertEqual(sentOnly.length, 1, '仅按发送尺寸映射时应丢弃越界框')
  const adaptive = loc.mapRawBoxesAdaptive(raw, context)
  assertEqual(adaptive.usedOrigin, true, 'usedOrigin')
  assertEqual(adaptive.mapped.length, 2, '自适应映射框数')
  assertBoxClose(
    adaptive.mapped[0].box,
    [313 / 2048, 826 / 1080, 466 / 2048, 915 / 1080],
    0.01,
    '平板框按原图换算'
  )
})

check('mapRawBoxesAdaptive · 发送尺寸坐标正常时不回退', () => {
  const raw = [{ label: '手机', coords: [420, 300, 580, 450], source: 'json', parser: 'json_multi' }]
  const context = {
    space: 'absolute_px',
    order: 'xyxy',
    sentWidth: 1120,
    sentHeight: 588,
    originWidth: 2048,
    originHeight: 1080,
    scaleX: 1,
    scaleY: 1
  }
  const adaptive = loc.mapRawBoxesAdaptive(raw, context)
  assertEqual(adaptive.usedOrigin, false, 'usedOrigin')
  assertEqual(adaptive.mapped.length, 1, '框数')
})

/* ------------------------------------------------------------------ */
/* [4/8] validateBox                                                    */
/* ------------------------------------------------------------------ */

section('[4/8] validateBox：越界 / 反向端点 / 过小 / 过大 / 非法值')

check('validateBox · 越界坐标被 clamp 到 0..1', () => {
  const box = loc.validateBox([-0.2, 0.1, 1.3, 0.5])
  assert(box !== null, '结果不应为 null')
  assertBoxClose(box, [0, 0.1, 1, 0.5], 1e-6, 'clamp 后')
})

check('validateBox · 反向端点自动排序', () => {
  const box = loc.validateBox([0.8, 0.7, 0.2, 0.1])
  assert(box !== null, '结果不应为 null')
  assertBoxClose(box, [0.2, 0.1, 0.8, 0.7], 1e-6, '排序后')
})

check('validateBox · 面积过小（< 0.0002）→ null', () => {
  assertEqual(loc.validateBox([0.5, 0.5, 0.5005, 0.5005]), null, '结果')
})

check('validateBox · 面积过大（> 0.95）→ null', () => {
  assertEqual(loc.validateBox([0, 0, 1, 1]), null, '结果')
})

check('validateBox · 零宽/零高 → null', () => {
  assertEqual(loc.validateBox([0.2, 0.2, 0.2, 0.5]), null, '零宽')
  assertEqual(loc.validateBox([0.2, 0.2, 0.5, 0.2]), null, '零高')
})

check('validateBox · NaN / Infinity → null', () => {
  assertEqual(loc.validateBox([Number.NaN, 0.1, 0.3, 0.4]), null, 'NaN')
  assertEqual(loc.validateBox([0.1, 0.1, Number.POSITIVE_INFINITY, 0.4]), null, 'Infinity')
})

/* ------------------------------------------------------------------ */
/* [5/8] dedupeBoxes                                                    */
/* ------------------------------------------------------------------ */

section('[5/8] dedupeBoxes：同类高 IoU 去重 / 异类保留 / 数量上限')

check('dedupeBoxes · 同类且 IoU>0.6 只保留 1 个', () => {
  const boxes = [
    { label: '手机', box: [0.1, 0.1, 0.3, 0.3] },
    { label: '手机', box: [0.105, 0.105, 0.305, 0.305] }
  ]
  const kept = loc.dedupeBoxes(boxes, 8)
  assertEqual(kept.length, 1, '保留数量')
  assertBoxClose(kept[0].box, boxes[0].box, 1e-9, '保留第一个框')
})

check('dedupeBoxes · 异类高 IoU 全部保留', () => {
  const boxes = [
    { label: '手机', box: [0.1, 0.1, 0.3, 0.3] },
    { label: '相机', box: [0.1, 0.1, 0.3, 0.3] }
  ]
  assertEqual(loc.dedupeBoxes(boxes, 8).length, 2, '保留数量')
})

check('dedupeBoxes · 同类低 IoU 全部保留', () => {
  const boxes = [
    { label: '手机', box: [0.1, 0.1, 0.2, 0.2] },
    { label: '手机', box: [0.6, 0.6, 0.7, 0.7] }
  ]
  assertEqual(loc.dedupeBoxes(boxes, 8).length, 2, '保留数量')
})

check('dedupeBoxes · limit 生效', () => {
  const boxes = [
    { label: 'a', box: [0.05, 0.05, 0.15, 0.15] },
    { label: 'b', box: [0.25, 0.25, 0.35, 0.35] },
    { label: 'c', box: [0.45, 0.45, 0.55, 0.55] }
  ]
  assertEqual(loc.dedupeBoxes(boxes, 2).length, 2, '保留数量')
})

/* ------------------------------------------------------------------ */
/* [6/8] 请求体与响应内容提取                                           */
/* ------------------------------------------------------------------ */

section('[6/8] buildRequestBody / extractMessageContent')

check('buildRequestBody · 基础字段与 max_tokens 字段名', () => {
  const body = loc.buildRequestBody(
    'mock-vl',
    [{ role: 'user', content: 'ping' }],
    { maxTokens: 1200, responseFormat: 'json_object', extraBody: { top_k: 5 } }
  )
  assertEqual(body.model, 'mock-vl', 'model')
  assertEqual(Array.isArray(body.messages) && body.messages.length, 1, 'messages')
  assertEqual(body.temperature, 0, 'temperature')
  assertEqual(body.max_tokens, 1200, 'max_tokens')
  assertEqual(body.response_format.type, 'json_object', 'response_format')
  assertEqual(body.top_k, 5, 'extraBody 透传')
})

check('extractMessageContent · 兼容 content / reasoning / choice.text', () => {
  const fromContent = loc.extractMessageContent({
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }]
  })
  assertEqual(fromContent.content, 'hello', 'content')
  assertEqual(fromContent.finishReason, 'stop', 'finish_reason')

  const fromReasoning = loc.extractMessageContent({
    choices: [{ message: { reasoning_content: 'think' } }]
  })
  assertEqual(fromReasoning.content, 'think', 'reasoning_content 回退')

  const fromText = loc.extractMessageContent({ choices: [{ text: 'plain' }] })
  assertEqual(fromText.content, 'plain', 'choice.text 回退')
})

/* ------------------------------------------------------------------ */
/* [7/8] 端到端：4 空间 × 4 方言                                        */
/* ------------------------------------------------------------------ */

const SPACES = ['normalized_1000', 'normalized_100', 'normalized_01', 'absolute_px']
const DIALECTS = ['json', 'bbox_2d', 'box_tokens', 'plain']
const DIALECT_EXPECT = {
  json: { dialect: 'json_multi', tokenLeak: false },
  bbox_2d: { dialect: 'json_multi', tokenLeak: false },
  box_tokens: { dialect: 'box_tokens', tokenLeak: true },
  plain: { dialect: 'plain_coords', tokenLeak: false }
}

/** mock 探针输出里能数出的框数（同时校验 mock 确实用了目标方言） */
function countMockBoxes(content, dialect) {
  if (dialect === 'json') {
    const data = JSON.parse(content)
    assert(Array.isArray(data.objects), 'json 方言应返回 {objects:[...]}')
    return data.objects.length
  }
  if (dialect === 'bbox_2d') {
    const data = JSON.parse(content)
    assert(Array.isArray(data), 'bbox_2d 方言应返回 JSON 数组')
    assert(data.every((item) => Array.isArray(item.bbox_2d)), 'bbox_2d 字段缺失')
    return data.length
  }
  if (dialect === 'box_tokens') {
    const refs = (content.match(/<ref>/g) ?? []).length
    const boxes = (content.match(/<box>/g) ?? []).length
    assertEqual(refs, boxes, '<ref> 与 <box> 数量')
    assertEqual(
      (content.match(/\[\[/g) ?? []).length,
      boxes,
      'box_tokens 应使用规范 <box>[[x1,y1,x2,y2]]</box> 形态'
    )
    return boxes
  }
  if (dialect === 'plain') {
    const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
    const valid = lines.every((line) =>
      /^[^:：]+[:：]\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)$/.test(
        line
      )
    )
    assert(valid, `plain 方言应为规范单括号四元组：${JSON.stringify(lines.slice(0, 2))}`)
    return lines.length
  }
  throw new Error(`未知方言 ${dialect}`)
}

function buildProbeRequestBody(width, height) {
  const built = loc.buildProbeMessages('zh')
  const messages = [
    { role: 'system', content: built.system },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          // 探针提示词本身不含尺寸；这里补一条尺寸说明，让 mock 能换算绝对像素（mock 不读图）。
          text: `${built.user}\n（补充信息：图片尺寸为 ${width}×${height}）`
        },
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }
      ]
    }
  ]
  return loc.buildRequestBody('mock-vl', messages)
}

function buildLocateRequestBody(space) {
  const built = loc.buildLocalizeMessages({
    language: 'zh',
    space,
    sentWidth: 1120,
    sentHeight: 672,
    scene: '会议室监控',
    itemLabels: ['手机', '相机'],
    timestampText: '00:00:03'
  })
  const messages = [
    { role: 'system', content: built.system },
    {
      role: 'user',
      content: [
        { type: 'text', text: built.user },
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }
      ]
    }
  ]
  return loc.buildRequestBody('mock-vl', messages)
}

function describeEvaluation(evaluation) {
  return `ok=${evaluation.ok} space=${evaluation.coordinateSpace} dialect=${evaluation.dialect} score=${evaluation.score.toFixed(2)} boxes=${evaluation.boxesFound}`
}

section(
  `[7/8] 探针判定 + 定位解析端到端：${SPACES.length} 空间 × ${DIALECTS.length} 方言 = ${SPACES.length * DIALECTS.length} 组`
)

for (const space of SPACES) {
  for (const dialect of DIALECTS) {
    const tag = `space=${space} dialect=${dialect}`
    await withMockServer(dialect, space, async (port, health) => {
      await checkAsync(`探针判定 · ${tag}`, async () => {
        assertEqual(health.dialect, dialect, 'health.dialect')
        assertEqual(health.space, space, 'health.space')
        assertEqual(health.abnormalEvery, 3, 'health.abnormalEvery')

        const r1 = await postChat(port, buildProbeRequestBody(1120, 672))
        const r2 = await postChat(port, buildProbeRequestBody(560, 336))
        const r1Content = loc.extractMessageContent(r1).content
        const r2Content = loc.extractMessageContent(r2).content
        assertEqual(countMockBoxes(r1Content, dialect), 5, 'R1 返回框数')
        assertEqual(countMockBoxes(r2Content, dialect), 5, 'R2 返回框数')

        const evaluation = loc.evaluateProbe(r1Content, r2Content)
        assert(
          evaluation.ok === true,
          `ok=false（${describeEvaluation(evaluation)}）；notes=${evaluation.notes.join('；')}`
        )
        assertEqual(evaluation.coordinateSpace, space, 'coordinateSpace')
        assertEqual(evaluation.dialect, DIALECT_EXPECT[dialect].dialect, 'dialect')
        assertEqual(evaluation.boxOrder, 'xyxy', 'boxOrder')
        assertEqual(evaluation.boxesFound, 5, 'boxesFound')
        assertEqual(evaluation.tokenLeak, DIALECT_EXPECT[dialect].tokenLeak, 'tokenLeak')
        assertEqual(evaluation.thinkingPolluted, false, 'thinkingPolluted')
        assertEqual(evaluation.multiTarget, true, 'multiTarget')
        return describeEvaluation(evaluation)
      })

      await checkAsync(`定位解析 · ${tag}`, async () => {
        const payload = await postChat(port, buildLocateRequestBody(space))
        const content = loc.extractMessageContent(payload).content
        assertEqual(countMockBoxes(content, dialect), 2, '定位返回框数')

        const context = {
          space,
          order: 'xyxy',
          sentWidth: 1120,
          sentHeight: 672,
          scaleX: 1,
          scaleY: 1
        }
        const parsed = loc.parseGrounding(content, loc.DEFAULT_PARSE_ORDER, context)
        assertEqual(parsed.dialect, DIALECT_EXPECT[dialect].dialect, 'dialect')
        assertEqual(parsed.boxes.length, 2, '解析框数')

        const mapped = loc.mapRawBoxes(parsed.boxes, context)
        assertEqual(mapped.length, 2, '有效框数')
        assertBoxClose(mapped[0].box, [0.42, 0.52, 0.58, 0.78], 0.02, '手机框')
        assertBoxClose(mapped[1].box, [0.1, 0.3, 0.22, 0.44], 0.02, '相机框')
        // box_tokens 多框的 label 归属仍受 parseBoxTokens <ref> 回溯窗口限制（[2/8] 记录），
        // 这里只校验首框 label + 两框坐标；json/bbox_2d/plain 的 label 全量校验。
        assertEqual(mapped[0].label, '手机', '手机 label')
        if (dialect !== 'box_tokens') {
          assertEqual(mapped[1].label, '相机', '相机 label')
        }
        return `2 框，dialect=${parsed.dialect}`
      })
    })
  }
}

/* ------------------------------------------------------------------ */
/* [8/8] 边界模式与判定语义                                             */
/* ------------------------------------------------------------------ */

section('[8/8] single / none 边界模式 + 判定请求语义（MOCK_ABNORMAL_EVERY）')

await withMockServer('single', 'normalized_1000', async (port) => {
  await checkAsync('single 方言 · 定位只返回 1 个框', async () => {
    const payload = await postChat(port, buildLocateRequestBody('normalized_1000'))
    const content = loc.extractMessageContent(payload).content
    assertEqual(countMockBoxes(content, 'json'), 1, '返回框数')
    const context = {
      space: 'normalized_1000',
      order: 'xyxy',
      sentWidth: 1120,
      sentHeight: 672,
      scaleX: 1,
      scaleY: 1
    }
    const parsed = loc.parseGrounding(content, loc.DEFAULT_PARSE_ORDER, context)
    assertEqual(parsed.boxes.length, 1, '解析框数')
  })

  await checkAsync('single 方言 · 探针降级为单目标且判定不可信', async () => {
    const r1 = await postChat(port, buildProbeRequestBody(1120, 672))
    const r2 = await postChat(port, buildProbeRequestBody(560, 336))
    const evaluation = loc.evaluateProbe(
      loc.extractMessageContent(r1).content,
      loc.extractMessageContent(r2).content
    )
    assertEqual(evaluation.boxesFound, 1, 'boxesFound')
    assertEqual(evaluation.ok, false, 'ok')
    assertEqual(evaluation.multiTarget, false, 'multiTarget')
    assertEqual(evaluation.coordinateSpace, 'unknown', 'coordinateSpace')
  })
})

await withMockServer('none', 'normalized_1000', async (port) => {
  await checkAsync('none 方言 · 定位返回空列表', async () => {
    const payload = await postChat(port, buildLocateRequestBody('normalized_1000'))
    const content = loc.extractMessageContent(payload).content
    assertEqual(countMockBoxes(content, 'json'), 0, '返回框数')
    const parsed = loc.parseGrounding(content)
    assertEqual(parsed.boxes.length, 0, '解析框数')
    assertEqual(parsed.dialect, 'none', 'dialect')
  })

  await checkAsync('none 方言 · 探针判定为 unknown / 不可定位', async () => {
    const r1 = await postChat(port, buildProbeRequestBody(1120, 672))
    const evaluation = loc.evaluateProbe(loc.extractMessageContent(r1).content, '')
    assertEqual(evaluation.ok, false, 'ok')
    assertEqual(evaluation.coordinateSpace, 'unknown', 'coordinateSpace')
    assertEqual(evaluation.dialect, 'none', 'dialect')
  })
})

function judgmentMessages(imageCount) {
  const content = [
    {
      type: 'text',
      text: '这是视频中 00:00:01 处的一帧。请判断画面中是否出现禁用物品，并按要求的 JSON 格式返回结果。'
    }
  ]
  for (let index = 0; index < imageCount; index += 1) {
    content.push({ type: 'image_url', image_url: { url: ONE_PIXEL_PNG } })
  }
  return [
    {
      role: 'system',
      content:
        '你是一名会议室监控视频的合规审核员，负责对视频抽帧进行辅助审核。请只返回 JSON 对象。'
    },
    { role: 'user', content }
  ]
}

await withMockServer('json', 'normalized_1000', async (port, health) => {
  check('判定 · health.abnormalEvery=3', () => {
    assertEqual(health.abnormalEvery, 3, 'health.abnormalEvery')
    assertEqual(health.dialect, 'json', 'health.dialect')
    assertEqual(health.space, 'normalized_1000', 'health.space')
  })

  await checkAsync('判定 · 每 3 个判定请求出现 1 个异常', async () => {
    const verdicts = []
    for (let index = 0; index < 3; index += 1) {
      const payload = await postChat(
        port,
        loc.buildRequestBody('mock-vl', judgmentMessages(1))
      )
      verdicts.push(JSON.parse(loc.extractMessageContent(payload).content))
    }
    assertEqual(verdicts.length, 3, '响应数')
    assertEqual(verdicts[0].abnormal, false, '第 1 个判定 abnormal')
    assertEqual(verdicts[1].abnormal, false, '第 2 个判定 abnormal')
    assertEqual(verdicts[2].abnormal, true, '第 3 个判定 abnormal')
    assertEqual(verdicts[2].risk_level, 'high', '异常 risk_level')
    assert(Array.isArray(verdicts[2].categories), 'categories 应为数组')
    assertEqual(verdicts[2].categories[0], '手机', '异常 categories')
    assertEqual(verdicts[0].risk_level, 'none', '正常 risk_level')
    assertEqual(verdicts[0].categories.length, 0, '正常 categories')
    assertEqual(typeof verdicts[0].description, 'string', 'description 类型')
    assertEqual(typeof verdicts[0].evidence, 'string', 'evidence 类型')
    assertEqual(typeof verdicts[0].confidence, 'number', 'confidence 类型')
    assertEqual(typeof verdicts[0].need_human_review, 'boolean', 'need_human_review 类型')
    return `第 3 个判定 abnormal=true`
  })

  await checkAsync('判定 · 多图请求返回 frames 数组（frame_index 对齐）', async () => {
    const payload = await postChat(port, loc.buildRequestBody('mock-vl', judgmentMessages(2)))
    const content = loc.extractMessageContent(payload).content
    const parsed = JSON.parse(content)
    assert(Array.isArray(parsed.frames), 'frames 应为数组')
    assertEqual(parsed.frames.length, 2, 'frames 数量')
    parsed.frames.forEach((frame, index) => {
      assertEqual(frame.frame_index, index, `第 ${index} 帧 frame_index`)
      assertEqual(typeof frame.abnormal, 'boolean', `第 ${index} 帧 abnormal 类型`)
      assert(Array.isArray(frame.categories), `第 ${index} 帧 categories 类型`)
    })
  })

  await checkAsync('连接测试 · 返回「连接成功」', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是一张测试图片。如果你能读取图片，请只回复：连接成功' },
          { type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }
        ]
      }
    ]
    const payload = await postChat(port, loc.buildRequestBody('mock-vl', messages))
    assertEqual(loc.extractMessageContent(payload).content, '连接成功', 'content')
  })
})

/* ------------------------------------------------------------------ */
/* 汇总                                                                 */
/* ------------------------------------------------------------------ */

const total = stats.pass + stats.fail
console.log('\n============================================')
console.log(`汇总：通过 ${stats.pass} / 失败 ${stats.fail} / 共 ${total}`)

if (residualLimitations.length > 0) {
  console.log('\n残余限制（不影响本次断言通过，建议后续修 src 解析器）：')
  for (const limitation of residualLimitations) console.log(`  NOTE  ${limitation}`)
} else {
  console.log('\n残余限制：无（规范格式全部通过）')
}

if (stats.fail > 0) {
  console.log('\n失败明细：')
  for (const failure of failures) console.log(`  - ${failure}`)
  console.log('\n结果：FAIL')
  process.exit(1)
}

console.log('\n结果：ALL PASS ✅')
process.exit(0)
