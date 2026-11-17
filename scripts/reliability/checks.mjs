import assert from 'node:assert/strict'
import { addPerformanceChecks } from '../performance/checks.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { deriveVerdict, extractJsonValue, parseAnalysisObject, parseFrameGroup, analyzeSingleFrame, analyzeFrameGroup } from '../../src/main/model/analysis'
import { parseBehaviorAnalysis, analyzeBehaviorWindow } from '../../src/main/model/behavior'
import { requestChat, testModelConnection } from '../../src/main/model/client'
import { parseGrounding } from '../../src/shared/localization/dialects'
import { matchItem, normalizeCustomItems, normalizeSelectedItems, resolveProhibitedItems } from '../../src/shared/items'
import { MAX_CUSTOM_PROHIBITED_ITEMS } from '../../src/shared/defaults'
import { getPublicSettings, saveSettings, normalizeRuntimeModel } from '../../src/main/config/settings'
import { getResolvedModelConfig, getResolvedModelConfigForTesting } from '../../src/main/config/model-config'
import { saveProfile, computePromptFingerprint, applyProfileOverrides } from '../../src/main/config/profiles'
import { profileId } from '../../src/shared/localization/profile'
import { localizeFrame } from '../../src/main/localization/locator'
import { newFrame, readTask, rememberTask, flushSave, scheduleSave, deleteStoredTask, flushAllTasks } from '../../src/main/task/store'
import { finishTask, failTask } from '../../src/main/task/outcome'
import { markUnresolvedFailed } from '../../src/main/task/analysis'
import { createRegionRunner } from '../../src/main/task/regions'
import { cancelActiveTask, getTask, initializeTaskManager, retryFailedFrames, shutdownTaskManager, startBehaviorReview, startReview } from '../../src/main/task/manager'
import { taskSession } from '../../src/main/task/session'
import { createSettingsAutosave, registerSettingsFlush, flushPendingSettings } from '../../src/renderer/src/lib/settings-autosave'
import { normalizeImageScalePercent } from '../../src/shared/image'
import { getModelCallTrace, listModelCallTraces, recordModelCallTrace } from '../../src/main/model/call-history'

const originalFetch = globalThis.fetch
const tests = []
const test = (name, run) => tests.push({ name, run })
const normal = { abnormal: false, risk_level: 'none', categories: [], description: '', evidence: '', confidence: 0.9, need_human_review: false }
const parsed = (input = {}) => parseAnalysisObject({ ...normal, ...input }, '{}', [], ['phone'])
const verdict = (input) => deriveVerdict(parsed(input), 0.6).verdict
const response = (content, finishReason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }] }))
const initial = {
  modelMode: 'custom', customModel: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test', extraBody: '' },
  developerMode: false, intervalSec: 2, prohibitedItems: ['phone'], customProhibitedItems: [],
  analysisMode: 'single', groupSize: 4, localize: false, behaviorItems: [{ id: 'behavior:run', label: '奔跑' }],
  behaviorWindowSec: 2, behaviorStrideSec: 2, behaviorFps: 4, behaviorImageScalePercent: 100
}
let config
const taskFile = (task) => path.join(process.env.VIDEOREVIEW_DATA_DIR, 'tasks', task.id, 'task.json')
function task(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(), kind: 'items', name: 'test.mp4',
    source: { filePath: '/test.mp4', fileName: 'test.mp4', durationMs: 2000, width: 640, height: 360, fileSizeBytes: 1 },
    config: { ...initial, confidenceThreshold: 0.6 }, frames: [], status: 'analyzing',
    createdAt: now, updatedAt: now, errorMessage: '', progress: 0, phaseMessage: '', regionProfile: null, ...overrides
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(check, timeout = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('等待测试条件超时')
    await delay(10)
  }
}
function abortable(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

test('高置信度正常结果可以通过，低置信度或缺失置信度转待复核', () => {
  assert.equal(verdict({}), 'normal')
  for (const confidence of [0.1, null, undefined, -1, 150, 'invalid']) assert.equal(verdict({ confidence }), 'review')
  assert.equal(verdict({ confidence: '90%' }), 'normal')
})
test('复核字段缺失或类别与判定矛盾时不自动通过', () => {
  assert.equal(verdict({ need_human_review: undefined }), 'review')
  assert.equal(verdict({ categories: ['手机'] }), 'review')
  assert.equal(verdict({ categories: undefined }), 'review')
  assert.equal(verdict({ abnormal: true, categories: ['手机'] }), 'review')
  assert.equal(verdict({ abnormal: true, categories: ['手机'], evidence: '桌面可见手机' }), 'abnormal')
  assert.equal(verdict({ abnormal: true, categories: ['杯子'], evidence: '可见杯子' }), 'review')
})
test('非布尔判定和损坏置信度不会误转成有效结果', () => {
  assert.throws(() => parsed({ abnormal: 2 }))
  assert.equal(verdict({ confidence: '90oops' }), 'review')
  assert.equal(verdict({ confidence: '150%' }), 'review')
  assert.equal(verdict({ confidence: '0x10' }), 'review')
})
test('行为类别精确匹配，不将快速奔跑或未奔跑归入奔跑', () => {
  assert.deepEqual(parseBehaviorAnalysis(JSON.stringify({ ...normal, abnormal: true, categories: ['快速奔跑'] }), ['奔跑', '快速奔跑']).categories, ['快速奔跑'])
  assert.equal(parseBehaviorAnalysis(JSON.stringify({ ...normal, abnormal: true, categories: ['未奔跑'] }), ['奔跑']).needHumanReview, true)
})
test('物品按名称及显式别名匹配，自定义笔记本电脑不会被笔吞掉', () => {
  assert.equal(matchItem('phone').itemId, 'phone')
  assert.equal(matchItem('笔记本电脑').itemId, null)
  assert.equal(normalizeCustomItems([{ label: '笔记本电脑' }]).length, 1)
})

test('预设物品和自定义物品均按实际勾选保存，不补回未选项', () => {
  const custom = [{ id: 'custom:power', label: '充电宝' }]
  assert.deepEqual(normalizeSelectedItems([], custom), [])
  assert.deepEqual(normalizeSelectedItems(['phone', 'pencil', 'phone', 'custom:power', 'missing'], custom), ['phone', 'pencil', 'custom:power'])
  assert.equal(matchItem('铅笔', ['pencil']).itemId, 'pencil')
  assert.equal(matchItem('中性笔', ['pencil']).itemId, null)
  assert.deepEqual(resolveProhibitedItems(['pen', 'cup', 'kettle']).map((item) => item.label), ['笔', '水杯', '水壶'])
})

test('自定义违禁物可添加30项，第31项被截断', () => {
  assert.equal(MAX_CUSTOM_PROHIBITED_ITEMS, 30)
  const items = Array.from({ length: 31 }, (_, index) => ({ id: `custom:item${index}`, label: `测试物品${index}` }))
  assert.equal(normalizeCustomItems(items.slice(0, 30)).length, 30)
  assert.equal(normalizeCustomItems(items).length, 30)
})
test('分组解析兼容对象、顶层数组和带说明的数组', () => {
  for (const raw of [JSON.stringify({ frames: [normal] }), JSON.stringify([normal]), `结果：${JSON.stringify([normal])}`]) {
    assert.equal(parseFrameGroup(raw, 1).size, 1)
  }
})
test('分组乱序按编号还原，重复编号对应帧失败', () => {
  const values = [{ ...normal, frame_index: 1, description: 'second' }, { ...normal, frame_index: 0, description: 'first' }]
  assert.equal(parseFrameGroup(JSON.stringify(values), 2).get(0).description, 'first')
  assert.equal(parseFrameGroup(JSON.stringify([...values, values[0], values[0]]), 2).has(1), false)
})
test('外层 JSON 损坏时，不截取内部完整对象作为成功结果', () => {
  assert.throws(() => extractJsonValue(`结果：[${JSON.stringify(normal)}`))
  assert.throws(() => parseFrameGroup(`结果：{"frames":[${JSON.stringify(normal)}]`, 1))
})
test('缺失编号的部分结果不猜测映射，非法编号不被强制转型', () => {
  assert.equal(parseFrameGroup(JSON.stringify([normal]), 2).size, 0)
  assert.equal(parseFrameGroup(JSON.stringify([{ ...normal, frame_index: false }]), 1).size, 0)
  assert.equal(parseFrameGroup(JSON.stringify([{ ...normal, frame_index: 1 }]), 2).has(0), false)
})
test('定位区分合法空结果与损坏响应，并保留超过20个框', () => {
  assert.equal(parseGrounding('[]').valid, true)
  assert.equal(parseGrounding('{"objects":[]}').valid, true)
  assert.equal(parseGrounding('未发现目标').valid, true)
  for (const raw of ['unrelated text', '{"objects":[}', '{}', '{"objects":[{"bbox":[0,0,0,0]}]}']) assert.equal(parseGrounding(raw).valid, false)
  assert.equal(parseGrounding(JSON.stringify({ objects: Array.from({ length: 25 }, (_, i) => ({ label: 'phone', bbox: [10 + i, 20, 40 + i, 80] })) })).boxes.length, 25)
})
test('旧配置不再控制语言或输出预算，单帧、分组、行为和连接请求均不发送 token 上限', async () => {
  const old = { maxTokens: 16, promptLanguage: 'en', extraBody: JSON.stringify({ max_tokens: 16, max_completion_tokens: 32, max_output_tokens: 64, top_k: 5 }) }
  const runtime = normalizeRuntimeModel(old)
  assert.equal('maxTokens' in runtime, false)
  assert.equal('promptLanguage' in runtime, false)
  const candidate = { ...config, ...old }
  const imagePath = path.join(process.env.VIDEOREVIEW_DATA_DIR, 'token-test.png')
  fs.writeFileSync(imagePath, Buffer.from('test image'))
  const replies = [normal, { frames: [0, 1].map((frame_index) => ({ frame_index, ...normal })) }, normal, '连接成功']
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) assert.equal(key in body, false)
    assert.equal(body.top_k, 5)
    if (calls < 2) assert.ok(body.messages[0].content.includes('本任务需要检查的禁用物品是：手机。'))
    return response(replies[calls++])
  }
  await analyzeSingleFrame(candidate, ['phone'], [], imagePath, 0)
  const group = await analyzeFrameGroup(candidate, ['phone'], [], [0, 1000].map((timestampMs) => ({ filePath: imagePath, timestampMs })))
  assert.equal(group.analyses.size, 2)
  await analyzeBehaviorWindow(candidate, {
    ...newFrame(0, 0, 'token-test.png'), endTimestampMs: 1000,
    samples: [{ index: 0, timestampMs: 0, fileName: 'token-test.png' }]
  }, path.dirname(imagePath), new AbortController().signal, ['奔跑'])
  assert.equal((await testModelConnection(candidate)).preview, '连接成功')
  assert.equal(calls, 4)
})

test('开发者开关控制实际请求与定位覆盖，关闭保留配置，测试连接使用当前草稿开关', async () => {
  const customModel = { ...initial.customModel, extraBody: '{"top_k":7}', coordinateSpaceOverride: 'absolute_px', boxOrderOverride: 'yxyx', parseDialectOverride: 'json_multi' }
  const expectDefaults = (runtime) => {
    assert.equal(runtime.extraBody, '')
    assert.equal(runtime.coordinateSpaceOverride, 'auto')
    assert.equal(runtime.boxOrderOverride, 'auto')
    assert.equal(runtime.parseDialectOverride, 'auto')
  }
  const bodies = []
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); return response(normal) }
  try {
    saveSettings({ ...initial, developerMode: true, customModel })
    const enabled = getResolvedModelConfig()
    await requestChat(enabled, [])
    assert.equal(bodies.at(-1).top_k, 7)
    assert.equal(applyProfileOverrides(null, enabled).coordinateSpace, 'absolute_px')
    assert.equal(applyProfileOverrides(null, enabled).boxOrder, 'yxyx')
    expectDefaults(getResolvedModelConfigForTesting({ modelMode: 'custom', developerMode: false, customModel }))

    saveSettings({ ...initial, developerMode: false, customModel })
    const disabled = getResolvedModelConfig()
    expectDefaults(disabled)
    await requestChat(disabled, [])
    assert.equal('top_k' in bodies.at(-1), false)
    assert.equal(applyProfileOverrides(null, disabled), null)
    assert.equal(getPublicSettings().customModel.extraBody, customModel.extraBody)
    assert.equal(getPublicSettings().customModel.boxOrderOverride, 'yxyx')
    assert.equal(getResolvedModelConfigForTesting({ modelMode: 'custom', developerMode: true, customModel }).extraBody, customModel.extraBody)
    assert.notEqual(computePromptFingerprint(enabled), computePromptFingerprint(disabled))
    assert.notEqual(computePromptFingerprint({ ...disabled, extraBody: customModel.extraBody }), computePromptFingerprint(disabled))

    saveSettings({ ...initial, developerMode: true, customModel })
    assert.equal(getResolvedModelConfig().extraBody, customModel.extraBody)
  } finally { saveSettings(initial) }
})

test('隐藏的非法 JSON 不阻止关闭开发者模式，重新启用时才校验', () => {
  const customModel = { ...initial.customModel, extraBody: '{' }
  try {
    saveSettings({ ...initial, developerMode: false, customModel })
    assert.equal(getResolvedModelConfig().extraBody, '')
    assert.throws(() => saveSettings({ ...initial, developerMode: true, customModel }), /额外请求体不是合法 JSON/)
    assert.equal(getPublicSettings().developerMode, false)
  } finally { saveSettings(initial) }
})

test('统一调用轨迹导入旧记录并去重，分页不传正文，失败调用可查且关闭后不再记录', async () => {
  const oldTrace = {
    operation: '旧调用', startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T00:00:01.000Z',
    latencyMs: 1000, endpoint: 'http://127.0.0.1/v1', status: 200,
    requestBody: JSON.stringify({ model: 'legacy-model', image: 'data:image/png;base64,dGVzdA==' }),
    responseBody: '{}', promptTokens: 1, completionTokens: 2, totalTokens: 3, error: ''
  }
  const legacy = task({ frames: [{ ...newFrame(0, 0, 'a.png'), callTraces: [oldTrace, oldTrace] }] })
  const dir = path.dirname(taskFile(legacy))
  fs.mkdirSync(path.join(dir, 'calls'), { recursive: true })
  fs.writeFileSync(taskFile(legacy), JSON.stringify(legacy), 'utf8')
  fs.writeFileSync(path.join(dir, 'calls', 'a'.repeat(64) + '.json'), JSON.stringify(oldTrace), 'utf8')
  try {
    const imported = await listModelCallTraces()
    const old = imported.items.filter((item) => item.taskId === legacy.id)
    assert.equal(old.length, 1)
    assert.equal('requestBody' in old[0], false)
    const detail = await getModelCallTrace(old[0].id)
    assert.match(detail.requestBody, /sha256=/)
    assert.equal(detail.requestBody.includes('base64,'), false)
    await assert.rejects(getModelCallTrace('../settings.json'), /编号无效/)
    await assert.rejects(listModelCallTraces('../settings.json'), /分页参数无效/)
    for (let i = 0; i < 35; i++) {
      await recordModelCallTrace({ ...oldTrace, startedAt: new Date(Date.now() + i).toISOString(), operation: `分页 ${i}` }, null, 'test')
    }
    const ids = []
    let before
    do {
      const page = await listModelCallTraces(before)
      assert.ok(page.items.length <= 30)
      assert.ok(page.items.every((item) => !('requestBody' in item) && !('responseBody' in item)))
      ids.push(...page.items.map((item) => item.id))
      before = page.nextBefore
    } while (before)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.length, imported.total + 35)

    saveSettings({ ...initial, developerMode: true })
    globalThis.fetch = async () => new Response('服务不可用', { status: 503 })
    await assert.rejects(requestChat(getResolvedModelConfig(), [], { operation: '失败连接测试', maxAttempts: 1 }), /模型请求失败/)
    const failedPage = await listModelCallTraces()
    const failed = failedPage.items.find((item) => item.operation === '失败连接测试')
    assert.equal(failed.status, 503)
    assert.ok(failed.error)
    assert.equal((await getModelCallTrace(failed.id)).responseBody, '服务不可用')
    saveSettings(initial)
    globalThis.fetch = async () => response(normal)
    await requestChat(getResolvedModelConfig(), [])
    assert.equal((await listModelCallTraces()).total, failedPage.total)
  } finally { saveSettings(initial) }
})

test('调用轨迹写入失败不影响模型请求结果', async () => {
  const write = fs.promises.writeFile
  try {
    saveSettings({ ...initial, developerMode: true })
    globalThis.fetch = async () => response(normal)
    fs.promises.writeFile = async () => { throw new Error('EACCES trace simulated') }
    const result = await requestChat(getResolvedModelConfig(), [])
    assert.equal(result.content, JSON.stringify(normal))
  } finally { fs.promises.writeFile = write; saveSettings(initial) }
})

test('行为缩放独立保存并随任务固定，抽帧不再读取模型图片设置或像素上限', async () => {
  assert.equal(normalizeImageScalePercent(), 100)
  assert.equal(normalizeImageScalePercent(50), 50)
  assert.equal(normalizeImageScalePercent(0), 1)
  assert.equal(normalizeImageScalePercent(200), 100)
  assert.equal(normalizeImageScalePercent(NaN), 100)
  const legacy = normalizeRuntimeModel({ imageMaxEdge: 896, imageFormat: 'jpeg' })
  assert.equal('imageScalePercent' in legacy, false)
  assert.equal('imageMaxEdge' in legacy, false)
  assert.equal('imageFormat' in legacy, false)
  let extracted
  globalThis.extractionHook = async (options) => { extracted = options }
  globalThis.fetch = async () => response(normal)
  try {
    saveSettings({ ...initial, section: 'behavior', behaviorImageScalePercent: 50 })
    saveSettings({ ...initial, section: 'items', judgmentImage: { scalePercent: 25 } })
    assert.equal(getPublicSettings().behaviorImageScalePercent, 50)
    const summary = await startBehaviorReview('/test.mp4')
    saveSettings({ ...initial, section: 'behavior', behaviorImageScalePercent: 75 })
    await until(() => !taskSession.activeRuns.has(summary.id))
    assert.equal(getTask(summary.id).status, 'completed')
    assert.equal(getTask(summary.id).behaviorConfig.imageScalePercent, 50)
    assert.equal(getPublicSettings().behaviorImageScalePercent, 75)
    assert.equal(extracted.scalePercent, 50)
    assert.equal(extracted.imageFormat, 'jpeg')
    assert.equal('maxEdge' in extracted, false)
  } finally {
    globalThis.extractionHook = undefined
    saveSettings({ ...initial, judgmentImage: { scalePercent: 100 } })
  }
})

test('已取消的请求不发送 HTTP', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return response(normal) }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(requestChat(config, [], { signal: controller.signal }), /取消/)
  assert.equal(calls, 0)
})
test('请求中取消立即结束，响应后取消也不提交成功', async () => {
  const controller = new AbortController()
  globalThis.fetch = (_url, options) => abortable(options.signal)
  const pending = requestChat(config, [], { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /取消/)
  const second = new AbortController()
  globalThis.fetch = async () => { second.abort(); return response(normal) }
  await assert.rejects(requestChat(config, [], { signal: second.signal }), /取消/)
})
test('重试结束不残留取消监听器，退避中取消不会再次请求', async () => {
  let calls = 0
  const controller = new AbortController()
  globalThis.fetch = async () => ++calls === 1 ? new Response('busy', { status: 503 }) : response(normal)
  await requestChat(config, [], { signal: controller.signal })
  assert.equal(calls, 2)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  calls = 0
  const cancelled = new AbortController()
  globalThis.fetch = async () => { calls++; setTimeout(() => cancelled.abort(), 10); return new Response('busy', { status: 429 }) }
  await assert.rejects(requestChat(config, [], { signal: cancelled.signal }), /取消/)
  assert.equal(calls, 1)
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0)
})
test('输出达到长度上限时不接受不完整判定', async () => {
  globalThis.fetch = async () => response(normal, 'length')
  await assert.rejects(requestChat(config, [], { requireComplete: true, maxAttempts: 1 }), /长度上限/)
})
test('连续更新仍在最长保存间隔内落盘', async () => {
  const value = task(); rememberTask(value)
  for (let i = 0; i < 23; i++) { value.progress = i; scheduleSave(value); await delay(100) }
  assert.equal(fs.existsSync(taskFile(value)), true)
  assert.ok(JSON.parse(fs.readFileSync(taskFile(value), 'utf8')).progress >= 15)
  await flushSave(value)
  assert.equal(JSON.parse(fs.readFileSync(taskFile(value), 'utf8')).progress, 22)
})
test('磁盘写入失败向上传播，恢复后清空错误且可继续保存', async () => {
  const value = task(); rememberTask(value)
  const original = fs.promises.writeFile
  try {
    fs.promises.writeFile = async () => { throw new Error('ENOSPC simulated') }
    await assert.rejects(flushSave(value), /ENOSPC/)
    assert.match(value.saveError, /保存结果失败/)
  } finally { fs.promises.writeFile = original }
  await flushSave(value)
  assert.equal(value.saveError, '')
})
test('保存失败后不会发布已完成，定位中的帧会收敛到失败', async () => {
  const frame = { ...newFrame(0, 0, 'test.png'), status: 'completed', verdict: 'abnormal', regionStatus: 'pending' }
  const value = task({ frames: [frame] }); rememberTask(value)
  const original = fs.promises.writeFile
  try {
    fs.promises.writeFile = async () => { throw new Error('ENOSPC simulated') }
    await assert.rejects(finishTask(value))
    assert.equal(value.status, 'analyzing')
    await failTask(value, new Error('write failed'), false)
    assert.equal(value.status, 'failed')
    assert.equal(frame.regionStatus, 'failed')
  } finally { fs.promises.writeFile = original }
  await flushSave(value)
})
test('最终保存期间仍未发布完成，取消会覆盖落盘中的终态', async () => {
  const value = task(); rememberTask(value)
  const controller = new AbortController(), entered = deferred(), gate = deferred()
  const original = fs.promises.writeFile
  try {
    fs.promises.writeFile = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
    const finishing = finishTask(value, controller.signal)
    await entered.promise
    assert.equal(value.status, 'analyzing')
    controller.abort(); gate.resolve()
    await assert.rejects(finishing, /取消/)
    await failTask(value, new Error('任务已取消'), true)
    assert.equal(JSON.parse(fs.readFileSync(taskFile(value), 'utf8')).status, 'cancelled')
  } finally { gate.resolve(); fs.promises.writeFile = original }
})
test('删除等待已排队的保存完成，不会删除后重建任务目录', async () => {
  const value = task(); rememberTask(value)
  const original = fs.promises.writeFile
  const entered = deferred(), gate = deferred()
  try {
    fs.promises.writeFile = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
    const save = flushSave(value)
    await entered.promise
    const deleting = deleteStoredTask(value.id)
    gate.resolve()
    await Promise.all([save, deleting])
    assert.equal(fs.existsSync(path.dirname(taskFile(value))), false)
  } finally { gate.resolve(); fs.promises.writeFile = original }
})
test('中断恢复同时处理判定和定位状态', () => {
  const frames = [newFrame(0, 0, 'a.png'), { ...newFrame(1, 1, 'b.png'), status: 'completed', regionStatus: 'pending' }]
  markUnresolvedFailed(task({ frames }), '任务已中断')
  assert.equal(frames[0].status, 'failed')
  assert.equal(frames[1].status, 'completed')
  assert.equal(frames[1].regionStatus, 'failed')
})
test('启动扫描修复磁盘上的中断任务', () => {
  const value = task({ frames: [{ ...newFrame(0, 0, 'a.png'), status: 'completed', regionStatus: 'pending' }] })
  fs.mkdirSync(path.dirname(taskFile(value)), { recursive: true })
  fs.writeFileSync(taskFile(value), JSON.stringify(value), 'utf8')
  initializeTaskManager()
  assert.equal(getTask(value.id).status, 'interrupted')
  assert.equal(getTask(value.id).frames[0].regionStatus, 'failed')
})
test('设置写入失败不污染内存中的已保存设置', () => {
  const before = getPublicSettings().intervalSec
  const rename = fs.renameSync
  try {
    fs.renameSync = () => { throw new Error('EACCES simulated') }
    assert.throws(() => saveSettings({ ...initial, section: 'items', intervalSec: 7 }), /EACCES/)
    assert.equal(getPublicSettings().intervalSec, before)
  } finally { fs.renameSync = rename }
})
test('旧行为任务补齐结果字段，并能恢复未结束片段', () => {
  const window = { index: 0, timestampMs: 0, fileName: 'a.jpg', status: 'analyzing', endTimestampMs: 2000, samples: [] }
  const value = task({ kind: 'behavior', behaviorWindows: [window] })
  fs.mkdirSync(path.dirname(taskFile(value)), { recursive: true })
  fs.writeFileSync(taskFile(value), JSON.stringify(value), 'utf8')
  const loaded = readTask(value.id)
  assert.deepEqual(loaded.behaviorWindows[0].callTraces, [])
  markUnresolvedFailed(loaded, '任务已中断')
  assert.equal(loaded.behaviorWindows[0].status, 'failed')
})
test('模型草稿不合法时，物品和行为图片比例仍可独立自动保存且互不覆盖', async () => {
  const invalid = { ...initial, judgmentImage: { scalePercent: 100 }, customModel: { baseUrl: '', model: '', extraBody: '{' } }
  saveSettings({ ...invalid, section: 'behavior', behaviorFps: 6 })
  saveSettings({ ...invalid, section: 'items', intervalSec: 3 })
  assert.equal(getPublicSettings().behaviorFps, 6)
  assert.equal(getPublicSettings().intervalSec, 3)
  assert.throws(() => saveSettings({ ...invalid, section: 'model' }))
  const saved = []
  const saver = createSettingsAutosave({ initial: invalid, onSaved() {}, onState() {}, save: async (input) => {
    saved.push(input.section)
    return saveSettings(input)
  } })
  try {
    saver.update({ ...invalid, judgmentImage: { scalePercent: 50 } })
    await saver.flush()
    assert.deepEqual(saved, ['items'])
    assert.equal(getPublicSettings().judgmentImage.scalePercent, 50)
    saver.update({ ...invalid, judgmentImage: { scalePercent: 50 }, behaviorImageScalePercent: 75 })
    await saver.flush()
    assert.deepEqual(saved, ['items', 'behavior'])
    assert.equal(getPublicSettings().behaviorImageScalePercent, 75)
    assert.equal(getPublicSettings().judgmentImage.scalePercent, 50)
    saveSettings({ ...initial, section: 'model', judgmentImage: { scalePercent: 100 } })
    assert.equal(getPublicSettings().judgmentImage.scalePercent, 50)
    assert.equal(getPublicSettings().behaviorImageScalePercent, 75)
  } finally { saver.dispose(); saveSettings({ ...initial, judgmentImage: { scalePercent: 100 } }) }
})
test('自动保存串行写入并追赶保存期间的新编辑', async () => {
  const gate = deferred(), entered = deferred(), calls = [], states = []
  const saver = createSettingsAutosave({ initial, onSaved() {}, onState: (state) => states.push(state), save: async (input) => {
    calls.push(input.intervalSec)
    if (calls.length === 1) { entered.resolve(); await gate.promise }
    return getPublicSettings()
  } })
  try {
    saver.update({ ...initial, intervalSec: 3 })
    const saving = saver.flush(); await entered.promise
    saver.update({ ...initial, intervalSec: 4 }); gate.resolve(); await saving
    assert.deepEqual(calls, [3, 4])
    assert.equal(states.at(-1).status, 'saved')
  } finally { gate.resolve(); saver.dispose() }
})
test('自动保存失败保留待保存值，同一值可以重试', async () => {
  let fail = true, calls = 0
  const saver = createSettingsAutosave({ initial, onSaved() {}, onState() {}, save: async () => {
    calls++; if (fail) throw new Error('disk failure'); return getPublicSettings()
  } })
  try {
    saver.update({ ...initial, intervalSec: 5 }); await assert.rejects(saver.flush(), /disk failure/)
    fail = false; await saver.flush(); assert.equal(calls, 2)
  } finally { saver.dispose() }
})
test('一个设置分区失败，不阻止其他分区提交', async () => {
  const saved = []
  const saver = createSettingsAutosave({ initial, onSaved() {}, onState() {}, save: async (input) => {
    if (input.section === 'model') throw new Error('invalid model')
    saved.push(input.section); return getPublicSettings()
  } })
  try {
    saver.update({ ...initial, intervalSec: 3, behaviorFps: 8, customModel: { ...initial.customModel, model: '' } })
    await assert.rejects(saver.flush(), /invalid model/)
    assert.deepEqual(saved, ['items', 'behavior'])
  } finally { saver.dispose() }
})
test('任务启动和窗口关闭的共享 flush 会提交尚在防抖期的修改', async () => {
  let saved = 0
  const saver = createSettingsAutosave({ initial, onSaved() {}, onState() {}, save: async (input) => { saved = input.intervalSec; return getPublicSettings() } })
  const unregister = registerSettingsFlush(saver.flush)
  try {
    saver.update({ ...initial, intervalSec: 6 })
    await flushPendingSettings(); assert.equal(saved, 6)
  } finally { unregister(); saver.dispose() }
})
test('抽帧阶段取消会等待收尾，零帧任务可以重新抽帧', async () => {
  const entered = deferred()
  globalThis.extractionHook = async (options) => { entered.resolve(); await abortable(options.signal) }
  globalThis.fetch = async () => response(normal)
  try {
    const summary = await startReview('/test.mp4'); await entered.promise
    assert.equal(await cancelActiveTask(summary.id), true)
    assert.equal(taskSession.activeRuns.has(summary.id), false)
    assert.equal(getTask(summary.id).status, 'cancelled')
    globalThis.extractionHook = undefined
    retryFailedFrames(summary.id)
    await until(() => !taskSession.activeRuns.has(summary.id))
    assert.equal(getTask(summary.id).status, 'completed')
  } finally { globalThis.extractionHook = undefined }
})
test('失败重试不把模型不支持定位的成功帧当成失败', () => {
  const frame = { ...newFrame(0, 0, 'a.png'), status: 'completed', verdict: 'abnormal', regionStatus: 'unsupported' }
  const value = task({ config: { ...initial, localize: true }, frames: [frame], status: 'completed' })
  rememberTask(value)
  assert.throws(() => retryFailedFrames(value.id), /没有需要重试的结果/)
  assert.equal(frame.regionStatus, 'unsupported')
  assert.equal(taskSession.activeRuns.has(value.id), false)
})

test('判定阶段取消保留终态，未完成帧不再保持 pending', async () => {
  const entered = deferred()
  globalThis.fetch = async (_url, options) => { entered.resolve(); return abortable(options.signal) }
  const summary = await startReview('/test.mp4'); await entered.promise
  await cancelActiveTask(summary.id)
  assert.equal(getTask(summary.id).status, 'cancelled')
  assert.equal(getTask(summary.id).frames[0].status, 'failed')
})
test('定位停止等待在途请求，不会在终态后回写结果', async () => {
  const fingerprint = computePromptFingerprint(config)
  const profile = { id: profileId(config.baseUrl, config.model, fingerprint), baseUrl: config.baseUrl, model: config.model,
    promptFingerprint: fingerprint, localizationOk: true, coordinateSpace: 'normalized_1000', boxOrder: 'xyxy',
    parseDialects: ['json_multi'], scaleX: 1, scaleY: 1, notes: [] }
  saveProfile(profile)
  const frame = { ...newFrame(0, 0, 'a.png'), status: 'completed', verdict: 'abnormal', categories: ['手机'] }
  const value = task({ frames: [frame] }); rememberTask(value)
  const framePath = path.join(path.dirname(taskFile(value)), 'frames', frame.fileName)
  fs.mkdirSync(path.dirname(framePath), { recursive: true })
  fs.writeFileSync(framePath, Buffer.from('test image'))
  const entered = deferred(), release = deferred()
  globalThis.fetch = async (_url, options) => {
    entered.resolve()
    await abortable(options.signal).catch(() => release.promise)
    return response({ objects: [{ label: '手机', bbox: [100, 100, 300, 300] }] })
  }
  const runner = createRegionRunner(value, config, new AbortController().signal)
  runner.enqueue(frame); await entered.promise
  let stopped = false
  const stopping = runner.abort().then(() => { stopped = true })
  await delay(20); assert.equal(stopped, false)
  release.resolve(); await stopping
  assert.equal(frame.regionStatus, 'failed')
  assert.equal(frame.regions.length, 0)
  await flushSave(value)
  globalThis.fetch = async () => response('unrelated output')
  await assert.rejects(localizeFrame(config, profile, { framePath, timestampMs: 0, itemIds: ['phone'] }), /无法解析/)
})
test('行为识别取消同样等待请求退出并保存失败片段', async () => {
  const entered = deferred()
  globalThis.fetch = async (_url, options) => { entered.resolve(); return abortable(options.signal) }
  const summary = await startBehaviorReview('/test.mp4'); await entered.promise
  await cancelActiveTask(summary.id)
  const value = getTask(summary.id)
  assert.equal(value.status, 'cancelled')
  assert.equal(value.behaviorWindows[0].status, 'failed')
  assert.equal(taskSession.activeRuns.has(summary.id), false)
  assert.equal(JSON.parse(fs.readFileSync(taskFile(value), 'utf8')).status, 'cancelled')
})
addPerformanceChecks({ test, task, initial, getConfig: () => config, response, normal })

test('退出等待任务取消与最终落盘，并拒绝新任务', async () => {
  const entered = deferred()
  globalThis.fetch = async (_url, options) => { entered.resolve(); return abortable(options.signal) }
  const summary = await startReview('/test.mp4'); await entered.promise
  await shutdownTaskManager()
  assert.equal(taskSession.activeRuns.size, 0)
  assert.equal(JSON.parse(fs.readFileSync(taskFile(getTask(summary.id)), 'utf8')).status, 'cancelled')
  await assert.rejects(startReview('/test.mp4'), /退出/)
})

export async function runChecks() {
  saveSettings(initial)
  config = getResolvedModelConfig()
  let failed = 0
  try {
    for (const { name, run } of tests) {
      try { await run(); console.log(`PASS ${name}`) }
      catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`) }
      finally { globalThis.fetch = originalFetch }
    }
  } finally {
    await flushAllTasks()
    globalThis.fetch = originalFetch
  }
  console.log(`可靠性回归：PASS ${tests.length - failed} / FAIL ${failed}`)
  if (failed) throw new Error(`${failed} 项可靠性回归失败`)
}
