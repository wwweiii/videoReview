import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getEventListeners } from 'node:events'
import { FairScheduler, modelScheduler, withTaskContext } from '../../src/main/runtime/scheduler'
import { requestChat } from '../../src/main/model/client'
import { compactRequestBody } from '../../src/main/model/trace'
import { imageDataUrl, imageCacheMetrics, clearImageCache } from '../../src/main/media/images'
import { saveSettings, getAnalysisConfig } from '../../src/main/config/settings'
import { newFrame, rememberTask, readTask, readTaskSummary, flushSave, trimTaskCache, taskCacheMetrics } from '../../src/main/task/store'
import { getTaskView, getFrameDiagnostics } from '../../src/main/task/manager'
import { getTaskStats, updateResultStats, invalidateTaskStats } from '../../src/main/task/stats'
import { emitFrame, emitSummary, clearSummaryThrottle } from '../../src/main/task/event'
import { countFrameStats } from '../../src/shared/task'
import { applyResultPatches } from '../../src/shared/task-view'

const root = () => process.env.VIDEOREVIEW_DATA_DIR
const taskFile = (value) => path.join(root(), 'tasks', value.id, 'task.json')
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { resolve, promise } }
const completed = (index) => ({ ...newFrame(index, index * 2000, `${index}.png`), status: 'completed', verdict: 'normal' })
const trace = (body, name = 'group') => ({ operation: name, startedAt: '2026-01-01', finishedAt: '2026-01-01', latencyMs: 1, endpoint: 'http://local', status: 200, requestBody: body, responseBody: '{}', promptTokens: 1, completionTokens: 1, totalTokens: 2, error: '' })

export function addPerformanceChecks({ test, task, initial, getConfig, response, normal }) {
  test('全局队列限制并发并按任务轮转，排队取消释放监听器', async () => {
    const scheduler = new FairScheduler(2)
    const release1 = await scheduler.acquire('a'), release2 = await scheduler.acquire('a')
    const order = []
    const a = scheduler.acquire('a').then((release) => { order.push('a'); return release })
    const b = scheduler.acquire('b').then((release) => { order.push('b'); return release })
    const cancelled = new AbortController()
    const waiting = scheduler.acquire('c', cancelled.signal)
    const rejected = assert.rejects(waiting, /取消/)
    cancelled.abort(); await rejected
    assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0)
    release1(); const releaseB = await b
    assert.deepEqual(order, ['b'])
    release2(); const releaseA = await a
    releaseA(); releaseB()
    assert.equal(scheduler.snapshot().peak, 2)
    assert.equal(scheduler.snapshot().queued, 0)
    assert.equal(scheduler.snapshot().active, 0)
  })

  test('真实请求入口共用全局预算，排队期间不读取图片', async () => {
    saveSettings({ ...initial, requestConcurrency: 1 })
    const gate = deferred(), entered = deferred()
    let calls = 0, prepared = false
    globalThis.fetch = async () => { calls++; entered.resolve(); await gate.promise; return response(normal) }
    const first = withTaskContext('first', () => requestChat(getConfig(), []))
    try {
      await entered.promise
      const controller = new AbortController()
      const second = withTaskContext('second', () => requestChat(getConfig(), async () => { prepared = true; return [] }, { signal: controller.signal }))
      const rejected = assert.rejects(second, /取消/)
      controller.abort(); await rejected
      assert.equal(prepared, false)
      assert.equal(calls, 1)
    } finally { gate.resolve(); await first; saveSettings({ ...initial, requestConcurrency: 2 }) }
    assert.equal(modelScheduler.snapshot().active, 0)
  })

  test('重试退避期间让出全局名额，其他任务不用等待退避结束', async () => {
    saveSettings({ ...initial, requestConcurrency: 1 })
    let calls = 0
    const entered = deferred()
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) { entered.resolve(); return new Response('busy', { status: 503 }) }
      return response(normal)
    }
    const first = withTaskContext('retry', () => requestChat(getConfig(), []))
    try {
      await entered.promise
      await withTaskContext('other', () => requestChat(getConfig(), []))
      assert.equal(calls, 2)
      await first
      assert.equal(calls, 3)
    } finally { await first; saveSettings({ ...initial, requestConcurrency: 2 }) }
  })

  test('降低并发上限后等待现有请求结束，不再补发超限请求', async () => {
    const scheduler = new FairScheduler(2)
    const a = await scheduler.acquire('a'), b = await scheduler.acquire('b')
    let started = false
    const c = scheduler.acquire('c').then((release) => { started = true; return release })
    scheduler.setLimit(1)
    a(); await delay(0); assert.equal(started, false)
    b(); (await c)()
    assert.equal(scheduler.snapshot().active, 0)
  })

  test('图片读取缓存有复用，源文件改变后失效，已取消读取不执行', async () => {
    const file = path.join(root(), 'cache-image.png')
    fs.writeFileSync(file, 'first', 'utf8')
    clearImageCache()
    const first = await imageDataUrl(file)
    const hits = imageCacheMetrics().hits
    assert.equal(await imageDataUrl(file), first)
    assert.equal(imageCacheMetrics().hits, hits + 1)
    fs.writeFileSync(file, 'changed image', 'utf8')
    assert.notEqual(await imageDataUrl(file), first)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(imageDataUrl(file, undefined, controller.signal), /取消/)
  })

  test('判定图片配置独立保存并固定在任务快照里', () => {
    const before = getAnalysisConfig()
    saveSettings({ ...initial, section: 'items', judgmentImage: { scalePercent: 50 } })
    assert.deepEqual(getAnalysisConfig().judgmentImage, { scalePercent: 50 })
    assert.notDeepEqual(before.judgmentImage, getAnalysisConfig().judgmentImage)
    saveSettings({ ...initial, section: 'items', judgmentImage: { scalePercent: 100 } })
  })

  test('图片内存缓存达到预算后淘汰旧数据', async () => {
    clearImageCache()
    const file = path.join(root(), 'cache-budget.png')
    for (let index = 0; index < 28; index++) {
      fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + index, index))
      await imageDataUrl(file)
    }
    assert.ok(imageCacheMetrics().bytes <= 24 * 1024 * 1024)
    assert.ok(imageCacheMetrics().entries < 28)
    clearImageCache()
  })

  test('调用轨迹去除图片本体，并保留类型、大小和内容摘要', () => {
    const content = 'data:image/png;base64,' + Buffer.from('image bytes').toString('base64')
    const compact = JSON.parse(compactRequestBody(JSON.stringify({ url: content, text: 'prompt' })))
    assert.match(compact.url, /mime=image\/png bytes=11 sha256=/)
    assert.equal(compact.text, 'prompt')
    assert.equal(compact.url.includes('base64'), false)
  })

  test('分组调用只保存一份轨迹，诊断按需读取且不随普通任务查询传输', async () => {
    const body = JSON.stringify({ url: 'data:image/png;base64,' + Buffer.alloc(32 * 1024, 7).toString('base64') })
    const sharedTrace = trace(body)
    const frames = [0, 1].map((index) => ({ ...completed(index), rawResponse: 'original group result', callTraces: [sharedTrace] }))
    const value = task({ frames, status: 'completed' }); rememberTask(value)
    await flushSave(value)
    const disk = fs.readFileSync(taskFile(value), 'utf8')
    assert.equal(disk.includes('base64'), false)
    assert.equal(disk.includes('original group result'), false)
    assert.equal(fs.readdirSync(path.join(root(), 'tasks', value.id, 'calls')).length, 1)
    assert.equal(fs.readdirSync(path.join(root(), 'tasks', value.id, 'details')).length, 1)
    assert.equal(getTaskView(value.id).frames[0].callTraces.length, 0)
    assert.equal((await getFrameDiagnostics(value.id, 0)).rawResponse, 'original group result')
    frames[0].regionRaw = 'location result'
    frames[0].callTraces.push(trace('{}', 'locate'))
    await flushSave(value)
    const detail = await getFrameDiagnostics(value.id, 0)
    assert.equal(detail.rawResponse, 'original group result')
    assert.equal(detail.regionRaw, 'location result')
    assert.equal(detail.callTraces.length, 2)
  })

  test('诊断写入失败保留旧任务清单，恢复后可重试且不会丢原始响应', async () => {
    const value = task({ frames: [completed(0)], status: 'completed' }); rememberTask(value)
    await flushSave(value)
    const before = fs.readFileSync(taskFile(value), 'utf8')
    value.frames[0].rawResponse = 'new response'
    const original = fs.promises.writeFile
    try {
      fs.promises.writeFile = async (file, ...args) => {
        if (String(file).includes(`${path.sep}details${path.sep}`)) throw new Error('ENOSPC detail')
        return original(file, ...args)
      }
      await assert.rejects(flushSave(value), /ENOSPC/)
      assert.equal(fs.readFileSync(taskFile(value), 'utf8'), before)
      assert.equal(value.frames[0].rawResponse, 'new response')
    } finally { fs.promises.writeFile = original }
    await flushSave(value)
    assert.equal((await getFrameDiagnostics(value.id, 0)).rawResponse, 'new response')
  })

  test('读取诊断与保存并发时，仍返回读取开始时的完整诊断', async () => {
    const frame = { ...completed(0), rawResponse: 'judgment', callTraces: [trace('{}', 'judge')] }
    const value = task({ frames: [frame], status: 'completed' }); rememberTask(value)
    await flushSave(value)
    frame.regionRaw = 'location'
    frame.callTraces.push(trace('{}', 'locate'))
    const oldRef = frame.detailRef
    const entered = deferred(), gate = deferred()
    const original = fs.promises.readFile
    let paused = false
    try {
      fs.promises.readFile = async (file, ...args) => {
        if (!paused && String(file).endsWith(`${oldRef}.json`)) {
          paused = true; entered.resolve(); await gate.promise
        }
        return original(file, ...args)
      }
      const reading = getFrameDiagnostics(value.id, 0)
      await entered.promise
      await flushSave(value)
      assert.equal(frame.regionRaw, '')
      assert.equal(frame.callTraces.length, 0)
      gate.resolve()
      const detail = await reading
      assert.equal(detail.rawResponse, 'judgment')
      assert.equal(detail.regionRaw, 'location')
      assert.deepEqual(detail.callTraces.map((entry) => entry.operation), ['judge', 'locate'])
    } finally { gate.resolve(); fs.promises.readFile = original }
  })

  test('有效摘要不读取完整 task.json，旧任务可重建摘要且详情缓存受限', async () => {
    const values = []
    for (let index = 0; index < 12; index++) {
      const value = task({ frames: [completed(0)], status: 'completed' }); rememberTask(value)
      await flushSave(value); values.push(value)
    }
    trimTaskCache()
    const original = fs.readFileSync
    let fullReads = 0
    try {
      fs.readFileSync = (file, ...args) => {
        if (String(file).endsWith('task.json')) fullReads++
        return original(file, ...args)
      }
      assert.equal(readTaskSummary(values[0].id).normalCount, 1)
      assert.equal(fullReads, 0)
    } finally { fs.readFileSync = original }
    const legacy = task({ frames: [completed(0)], status: 'completed' })
    fs.mkdirSync(path.dirname(taskFile(legacy)), { recursive: true })
    fs.writeFileSync(taskFile(legacy), JSON.stringify(legacy), 'utf8')
    assert.equal(readTaskSummary(legacy.id).normalCount, 1)
    assert.equal(fs.existsSync(path.join(path.dirname(taskFile(legacy)), 'summary.json')), true)
    assert.ok(taskCacheMetrics().terminalEntries <= 8)
    assert.equal(readTask(values[0].id).frames[0].verdict, 'normal')
  })

  test('保存期间产生的新诊断不会被旧快照清空，摘要与落盘版本一致', async () => {
    const frame = { ...completed(0), rawResponse: 'first', callTraces: [trace('{}', 'first')] }
    const value = task({ frames: [frame], status: 'completed' }); rememberTask(value)
    const entered = deferred(), gate = deferred()
    const original = fs.promises.writeFile
    try {
      fs.promises.writeFile = async (file, ...args) => {
        if (String(file).includes('task.json.')) { entered.resolve(); await gate.promise }
        return original(file, ...args)
      }
      const pending = flushSave(value)
      await entered.promise
      frame.rawResponse = 'second'
      frame.callTraces.push(trace('{}', 'second'))
      frame.verdict = 'abnormal'; updateResultStats(value, frame)
      gate.resolve(); await pending
      assert.equal(frame.rawResponse, 'second')
      const summary = JSON.parse(fs.readFileSync(path.join(path.dirname(taskFile(value)), 'summary.json'), 'utf8'))
      assert.equal(summary.summary.normalCount, 1)
      await flushSave(value)
      const detail = await getFrameDiagnostics(value.id, 0)
      assert.equal(detail.rawResponse, 'second')
      assert.equal(detail.callTraces.length, 2)
    } finally { gate.resolve(); fs.promises.writeFile = original }
  })

  test('增量统计覆盖判定、定位、重试和取消，与全量统计一致', () => {
    const value = task({ frames: Array.from({ length: 100 }, (_, index) => newFrame(index, index, 'a.png')) })
    getTaskStats(value)
    for (const frame of value.frames) {
      frame.status = frame.index % 3 ? 'completed' : 'failed'
      frame.verdict = frame.index % 3 ? 'abnormal' : 'failed'
      updateResultStats(value, frame)
      frame.regionStatus = 'ok'; frame.regions = [{}]
      updateResultStats(value, frame)
    }
    assert.deepEqual(getTaskStats(value), countFrameStats(value.frames))
    value.frames[0].status = 'pending'; value.frames[0].verdict = 'pending'
    invalidateTaskStats(value)
    assert.deepEqual(getTaskStats(value), countFrameStats(value.frames))
  })

  test('突发帧事件合并为一批，终态立即发送且不夹带诊断正文', async () => {
    const received = []
    globalThis.testWindows = [{ isDestroyed: () => false, webContents: { send: (_channel, event) => received.push(structuredClone(event)) } }]
    const value = task({ frames: Array.from({ length: 40 }, (_, index) => newFrame(index, index, 'a.png')) })
    try {
      getTaskStats(value)
      for (const frame of value.frames) {
        frame.status = 'completed'; frame.verdict = 'normal'; frame.rawResponse = 'heavy'; frame.callTraces = [trace('heavy')]
        emitFrame(value, frame)
      }
      assert.equal(received.filter((event) => event.summary.id === value.id).length, 0)
      value.status = 'completed'; emitSummary(value, true)
      const events = received.filter((event) => event.summary.id === value.id)
      assert.equal(events.length, 2)
      assert.equal(events[0].frames.length, 40)
      assert.equal(events[0].frames[0].rawResponse, '')
      assert.equal(events[0].frames[0].callTraces.length, 0)
      assert.equal(events[1].summary.normalCount, 40)
      await delay(180)
      assert.equal(received.filter((event) => event.summary.id === value.id).length, 2)
      const patched = applyResultPatches(value.frames, [{ ...value.frames[2], description: 'updated' }])
      assert.equal(patched[0], value.frames[0])
      assert.equal(patched[2].description, 'updated')
    } finally { clearSummaryThrottle(value.id); globalThis.testWindows = undefined }
  })

  test('合成负载对比记录统计耗时和存储体积', async () => {
    const count = 2000
    const frames = Array.from({ length: count }, (_, index) => newFrame(index, index, 'a.png'))
    let started = performance.now()
    for (const frame of frames) { frame.status = 'completed'; frame.verdict = 'normal'; countFrameStats(frames) }
    const baselineMs = performance.now() - started
    frames.forEach((frame) => { frame.status = 'pending'; frame.verdict = 'pending' })
    const value = task({ frames })
    started = performance.now(); getTaskStats(value)
    for (const frame of frames) { frame.status = 'completed'; frame.verdict = 'normal'; updateResultStats(value, frame); getTaskStats(value) }
    const incrementalMs = performance.now() - started
    assert.equal(getTaskStats(value).normal, count)
    const body = JSON.stringify({ images: Array.from({ length: 4 }, () => 'data:image/png;base64,' + Buffer.alloc(16 * 1024, 8).toString('base64')) })
    const large = task({ status: 'completed', frames: Array.from({ length: 200 }, (_, index) => ({
      ...completed(index), rawResponse: '{}', callTraces: [trace(body, `group-${Math.floor(index / 4)}`)]
    })) })
    const baselineBytes = Buffer.byteLength(JSON.stringify(large))
    rememberTask(large); await flushSave(large)
    const directory = path.dirname(taskFile(large))
    const diskBytes = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? diskBytes(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0)
    const storedBytes = diskBytes(directory)
    assert.ok(storedBytes < baselineBytes / 10)
    console.log('PERFORMANCE ' + JSON.stringify({ kind: 'synthetic', stats: { frames: count, baselineMs: +baselineMs.toFixed(2), incrementalMs: +incrementalMs.toFixed(2) }, storage: { frames: 200, baselineBytes, storedBytes, reductionPercent: +(100 * (1 - storedBytes / baselineBytes)).toFixed(1) } }))
  })
}
