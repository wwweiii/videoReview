/**
 * Electron 端到端冒烟（scripts/smoke/run-e2e.mjs 的入口）：
 * 真实 ffmpeg 抽帧 → 判定 → 定位 → task.json → 失败重试。
 */
import { app, dialog, nativeImage, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { configureElectronDataPath, getDataDir, getTaskThumbnailPath } from '../../src/main/paths'
import { registerMediaProtocol, registerMediaSchemes } from '../../src/main/app/media-protocol'
import { verifySettingsUi } from './settings-ui'
import { extractFrames } from '../../src/main/media/ffmpeg'
import { imageDataUrl, clearImageCache, imageCacheMetrics } from '../../src/main/media/images'
import { extractionScheduler, modelScheduler } from '../../src/main/runtime/scheduler'
import { getPublicSettings, saveSettings } from '../../src/main/config/settings'
import { prepareImage } from '../../src/main/localization/locator'
import {
  getTask,
  getFrameDiagnostics,
  getTaskView,
  deleteTask,
  exportTaskResults,
  initializeTaskManager,
  listTasks,
  retryFailedFrames,
  startReview,
  startBehaviorReview
} from '../../src/main/task/manager'

const root = process.cwd()
const results: Array<{ name: string; ok: boolean; detail: string }> = []

registerMediaSchemes()
configureElectronDataPath()
// 隐藏窗口销毁后仍需等待任务及汇总，不让 Electron 默认退出造成假阳性。
app.on('window-all-closed', () => {})

function check(name: string, ok: boolean, detail: unknown = ''): void {
  results.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
}

async function waitHealth(url: string, timeoutMs = 15000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('mock 服务启动超时')
}

function startMock(port: number): ChildProcess {
  return spawn('node', [path.join(root, 'scripts/mock-model-server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_DIALECT: 'json',
      MOCK_SPACE: 'normalized_1000',
      MOCK_ABNORMAL_EVERY: '2'
    },
    stdio: 'ignore',
    windowsHide: true
  })
}

function makeVideo(target: string, size = '640x360', duration = 6): Promise<void> {
  const platformDir = process.platform === 'win32' ? 'win32' : 'linux'
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpeg = path.join(root, 'resources', 'bin', platformDir, archDir, executable)
  const binary = fs.existsSync(ffmpeg) ? ffmpeg : 'ffmpeg'
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`, '-t', String(duration), '-pix_fmt', 'yuv420p', target],
      { stdio: 'ignore', windowsHide: true }
    )
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })
}

async function waitTerminal(taskId: string, timeoutMs = 120000): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const task = getTask(taskId)
    if (['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
      return task.status
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('任务执行超时')
}

function writeSettings(port: number): void {
  const dataDir = getDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  const settings = {
    developerMode: true,
    traceEnabled: true,
    requestConcurrency: 2,
    judgmentImage: { maxEdge: 1120, format: 'jpeg', quality: 90 },
    modelMode: 'custom',
    customModel: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-e2e-vl',
      concurrency: 2,
      timeoutSec: 30,
      extraHeaders: '',
      // 模拟历史版本设置，验证移除配置后不会继续影响请求。
      extraBody: JSON.stringify({ max_tokens: 16, max_completion_tokens: 32, max_output_tokens: 64 }),
      maxTokens: 16,
      promptLanguage: 'en',
      imageMaxEdge: 1120,
      imageFormat: 'png',
      imageScalePercent: 60,
      coordinateSpaceOverride: 'auto',
      boxOrderOverride: 'auto',
      parseDialectOverride: 'auto'
    },
    intervalSec: 1,
    prohibitedItems: ['phone', 'pencil', 'custom:testpower'],
    customProhibitedItems: [{ id: 'custom:testpower', label: '充电宝' }],
    analysisMode: 'single',
    groupSize: 4,
    confidenceThreshold: 0.6,
    localize: true
  }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

async function main(): Promise<void> {
  const port = 18894
  const mock = startMock(port)
  const videoPath = path.join(root, '.tmp', 'smoke-video.mp4')
  try {
    await waitHealth(`http://127.0.0.1:${port}/health`)
    writeSettings(port)
    initializeTaskManager()
    const publicModel = getPublicSettings().customModel
    check('旧语言与 token 配置不再暴露或使用', !('maxTokens' in publicModel) && !('promptLanguage' in publicModel))
    check('模型配置移除图片比例、像素上限与格式覆盖', !('imageScalePercent' in publicModel) && !('imageMaxEdge' in publicModel) && !('imageFormat' in publicModel))
    check('旧模型共用图片比例迁入行为设置', getPublicSettings().behaviorImageScalePercent === 60)
    check('旧判定图片设置迁移为 100% 且保留原图格式', JSON.stringify(getPublicSettings().judgmentImage) === JSON.stringify({ scalePercent: 100 }))
    await makeVideo(videoPath)

    const summary = await startReview(videoPath)
    check('startReview 返回任务', Boolean(summary.id), summary.id)
    const finalStatus = await waitTerminal(summary.id)
    check('任务到达终态', finalStatus === 'completed' || finalStatus === 'completed_with_errors', finalStatus)

    const task = getTask(summary.id)
    check('抽出帧数 >= 4', task.frames.length >= 4, task.frames.length)
    check('判定有异常帧', task.frames.some((frame) => frame.verdict === 'abnormal'), {
      abnormal: task.frames.filter((frame) => frame.verdict === 'abnormal').length
    })
    check('能力档案已写入', Boolean(task.regionProfile), task.regionProfile?.coordinateSpace)
    check('定位可用', task.regionProfile?.localizationOk === true, task.regionProfile?.notes)
    const located = task.frames.filter(
      (frame) => frame.regionStatus === 'ok' && frame.regions.length > 0
    )
    check('至少 1 帧定位出框', located.length >= 1, located.length)
    const sample = located[0]
    check('定位框数量>=1', (sample?.regions.length ?? 0) >= 1, sample?.regions.length)
    check(
      '类别映射到内置物品',
      sample?.regions.some((item) => item.itemId === 'phone') === true,
      sample?.regions.map((item) => `${item.category}/${item.itemId}`)
    )
    check(
      '任务配置仅包含勾选的预设和自定义物品',
      JSON.stringify(task.config.prohibitedItems) === JSON.stringify(['phone', 'pencil', 'custom:testpower']),
      task.config.prohibitedItems
    )
    check(
      '自定义物品快照写入任务',
      task.config.customProhibitedItems.some((item) => item.label === '充电宝'),
      task.config.customProhibitedItems
    )
    check(
      '框坐标归一化',
      sample?.regions.every((item) => item.box.every((value) => value >= 0 && value <= 1)) === true,
      sample?.regions.map((item) => item.box)
    )
    check(
      '正常帧不带框',
      task.frames.filter((frame) => frame.verdict === 'normal' && frame.regions.length > 0).length === 0
    )

    const taskFile = path.join(getDataDir(), 'tasks', summary.id, 'task.json')
    const raw = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as {
      frames: Array<{ regions?: unknown[] }>
    }
    const persistedRegions = raw.frames.reduce(
      (sum, frame) => sum + (Array.isArray(frame.regions) ? frame.regions.length : 0),
      0
    )
    check('task.json 持久化 regions', persistedRegions >= 2, persistedRegions)
    check('任务列表可用', listTasks().length === 1, listTasks().length)

    const framePath = path.join(path.dirname(taskFile), 'frames', task.frames[0].fileName)
    const originalBytes = fs.statSync(framePath).size
    const prepared = await imageDataUrl(framePath, { maxEdge: 320, format: 'jpeg', quality: 90 })
    const buffer = Buffer.from(prepared.split(',')[1], 'base64')
    const size = nativeImage.createFromBuffer(buffer).getSize()
    check('旧任务图片快照仍按保存的长边与 JPEG 格式处理', size.width === 320 && size.height === 180 && prepared.startsWith('data:image/jpeg;'), size)
    check('原始抽帧保留，发送副本体积下降', nativeImage.createFromPath(framePath).getSize().width === 640 && buffer.length < originalBytes, { originalBytes, preparedBytes: buffer.length })
    const conversions = imageCacheMetrics().conversions
    clearImageCache()
    await imageDataUrl(framePath, { maxEdge: 320, format: 'jpeg', quality: 90 })
    check('清空内存后仍复用已转换的图片副本', imageCacheMetrics().conversions === conversions)
    const originalJudgment = await imageDataUrl(framePath, { scalePercent: 100 })
    const scaledJudgment = await imageDataUrl(framePath, { scalePercent: 50 })
    const scaledJudgmentSize = nativeImage.createFromBuffer(Buffer.from(scaledJudgment.split(',')[1], 'base64')).getSize()
    check('判定 100% 与原图字节完全一致，无额外压缩或格式转换', originalJudgment.startsWith('data:image/png;') && Buffer.from(originalJudgment.split(',')[1], 'base64').equals(fs.readFileSync(framePath)))
    check('判定 50% 保留 PNG 格式，宽高各减半', scaledJudgment.startsWith('data:image/png;') && scaledJudgmentSize.width === 320 && scaledJudgmentSize.height === 180)

    const largeFrame = path.join(path.dirname(framePath), 'scale-source.png')
    fs.writeFileSync(largeFrame, nativeImage.createFromPath(framePath).resize({ width: 1920, height: 1080 }).toPNG())
    const fullScale = await prepareImage(largeFrame, { imageScalePercent: 100 })
    check('定位 100% 保留 1920×1080 原尺寸、PNG 格式及原始数据', fullScale.sentWidth === 1920 && fullScale.sentHeight === 1080 && fullScale.dataUrl.startsWith('data:image/png;') && Buffer.from(fullScale.dataUrl.split(',')[1], 'base64').equals(fs.readFileSync(largeFrame)))
    const halfScale = await prepareImage(largeFrame, { imageScalePercent: 50 })
    check('定位 50% 按原始宽高缩放为 960×540，不再对齐到 28 的倍数', halfScale.sentWidth === 960 && halfScale.sentHeight === 540 && halfScale.originWidth === 1920 && halfScale.originHeight === 1080 && halfScale.dataUrl.startsWith('data:image/png;'))
    const oddFrame = path.join(path.dirname(framePath), 'scale-odd.png')
    fs.writeFileSync(oddFrame, nativeImage.createFromPath(framePath).resize({ width: 201, height: 101 }).toPNG())
    const oddScale = await prepareImage(oddFrame, { imageScalePercent: 50 })
    check('奇数尺寸按比例取整，定位使用实际发送尺寸', oddScale.sentWidth === 101 && oddScale.sentHeight === 51)
    const jpegFrame = path.join(path.dirname(framePath), 'scale-source.jpg')
    fs.writeFileSync(jpegFrame, nativeImage.createFromPath(framePath).toJPEG(88))
    const jpegOriginal = await prepareImage(jpegFrame, { imageScalePercent: 100 })
    const jpegScaled = await prepareImage(jpegFrame, { imageScalePercent: 50 })
    check('JPEG 在 100% 时复用原始数据，50% 时保持 JPEG 格式', Buffer.from(jpegOriginal.dataUrl.split(',')[1], 'base64').equals(fs.readFileSync(jpegFrame)) && jpegScaled.dataUrl.startsWith('data:image/jpeg;') && jpegScaled.sentWidth === 320 && jpegScaled.sentHeight === 180)

    const largeVideo = path.join(getDataDir(), 'scale-source.mp4')
    await makeVideo(largeVideo, '1920x1080', 1)
    for (const percent of [100, 50]) {
      const scaleTaskId = crypto.randomUUID()
      const frames = await extractFrames({ taskId: scaleTaskId, filePath: largeVideo, durationMs: 1000, intervalSec: 1, imageFormat: 'jpeg', scalePercent: percent, startAtZero: true })
      const extractedPath = path.join(getDataDir(), 'tasks', scaleTaskId, 'frames', frames[0].fileName)
      const dimensions = nativeImage.createFromPath(extractedPath).getSize()
      check(`行为 JPEG 抽帧 ${percent}% 遵循原始比例且没有 1120 上限`, dimensions.width === 1920 * percent / 100 && dimensions.height === 1080 * percent / 100 && frames[0].fileName.endsWith('.jpg'), dimensions)
      await deleteTask(scaleTaskId)
    }
    const diagnostic = await getFrameDiagnostics(task.id, 0)
    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(framePath)).digest('hex')
    check('实际判定请求使用原图内容并保留图片摘要与排队耗时', diagnostic.callTraces.some((trace) => trace.requestBody.includes(`sha256=${originalHash}`) && trace.queueMs !== undefined))
    check('任务清单与普通 IPC 结果不携带调用正文', !fs.readFileSync(taskFile, 'utf8').includes('base64,') && getTaskView(task.id).frames.every((frame) => !frame.callTraces.length && !frame.rawResponse))

    const uiTaskId = await verifySettingsUi(videoPath, check)
    const uiStatus = await waitTerminal(uiTaskId)
    check('界面启动的任务完成并落盘', uiStatus === 'completed', uiStatus)
    const uiTask = getTask(uiTaskId)
    const uiImage = await imageDataUrl(path.join(getDataDir(), 'tasks', uiTaskId, 'frames', uiTask.frames[0].fileName), { scalePercent: 50 })
    const uiImageHash = crypto.createHash('sha256').update(Buffer.from(uiImage.split(',')[1], 'base64')).digest('hex')
    const uiDiagnostic = await getFrameDiagnostics(uiTaskId, 0)
    check('界面保存的 50% 比例确实用于模型判定请求', uiDiagnostic.callTraces.some((trace) => trace.operation === '物品判定' && trace.requestBody.includes(`sha256=${uiImageHash}`)))

    const localizedFrame = uiTask.frames.find((frame) => frame.regionStatus === 'ok')!
    const locatedImage = await imageDataUrl(path.join(getDataDir(), 'tasks', uiTaskId, 'frames', localizedFrame.fileName), { scalePercent: 50 })
    const locatedHash = crypto.createHash('sha256').update(Buffer.from(locatedImage.split(',')[1], 'base64')).digest('hex')
    const locatedDiagnostic = await getFrameDiagnostics(uiTaskId, localizedFrame.index)
    check('物品判定和定位实际使用相同的 50% 图片数据', ['物品判定', '违禁物定位'].every((operation) => locatedDiagnostic.callTraces.some((trace) => trace.operation === operation && trace.requestBody.includes(`sha256=${locatedHash}`))))

    const settingsAfterUi = getPublicSettings()
    const persistedSettings = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'settings.json'), 'utf8'))
    check('新比例分区落盘，旧模型比例字段不再保存', persistedSettings.judgmentImage.scalePercent === 50 && persistedSettings.behaviorImageScalePercent === 75 && !('imageScalePercent' in persistedSettings.customModel))
    const behaviorSummary = await startBehaviorReview(videoPath)
    saveSettings({ ...settingsAfterUi, section: 'behavior', behaviorImageScalePercent: 25 })
    const behaviorStatus = await waitTerminal(behaviorSummary.id)
    const behaviorTask = getTask(behaviorSummary.id)
    check('行为任务固定创建时的 75% 比例并完成识别', behaviorStatus === 'completed' && behaviorTask.behaviorConfig?.imageScalePercent === 75)
    const behaviorSample = behaviorTask.behaviorWindows![0].samples[0]
    const behaviorFramePath = path.join(getDataDir(), 'tasks', behaviorTask.id, 'frames', behaviorSample.fileName)
    const behaviorSize = nativeImage.createFromPath(behaviorFramePath).getSize()
    check('行为抽帧使用独立 75% 比例得到 480×270', behaviorSize.width === 480 && behaviorSize.height === 270, behaviorSize)
    const behaviorHash = crypto.createHash('sha256').update(fs.readFileSync(behaviorFramePath)).digest('hex')
    const behaviorDiagnostic = await getFrameDiagnostics(behaviorTask.id, 0)
    check('行为模型请求直接使用按 75% 抽取的图片', behaviorDiagnostic.callTraces.some((trace) => trace.operation === '行为判定' && trace.requestBody.includes(`sha256=${behaviorHash}`)))
    const behaviorCsv = path.join(getDataDir(), '行为导出.csv')
    const showSaveDialog = dialog.showSaveDialog
    try {
      dialog.showSaveDialog = async (optionsOrWindow, options) => {
        const picker = options ?? optionsOrWindow as Electron.SaveDialogOptions
        check('行为导出保存对话框选用 CSV', picker.filters?.[0].extensions[0] === 'csv' &&
          picker.defaultPath?.endsWith('_行为识别结果.csv') === true)
        return { canceled: false, filePath: behaviorCsv }
      }
      await exportTaskResults(behaviorTask.id)
    } finally {
      dialog.showSaveDialog = showSaveDialog
    }
    const csv = fs.readFileSync(behaviorCsv, 'utf8')
    check('行为导出保留 UTF-8 BOM、原表头和全部片段', csv.startsWith(
      '\uFEFF"序号","开始时间","结束时间","判定","行为类别","行为说明","证据","置信度","采样帧数","错误"\r\n'
    ) && csv.split('\r\n').length === behaviorTask.behaviorWindows!.length + 1)

    saveSettings({ ...settingsAfterUi, section: 'items', judgmentImage: { scalePercent: 100 } })
    const beforeRetry = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    localizedFrame.regionStatus = 'failed'
    localizedFrame.regionError = '模拟定位失败'
    localizedFrame.regions = []
    retryFailedFrames(uiTaskId)
    const retryStatus = await waitTerminal(uiTaskId)
    const afterRetry = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    check('失败重试补齐定位并回到完成状态', retryStatus === 'completed' && localizedFrame.regionStatus === 'ok' && localizedFrame.regions.length > 0, retryStatus)
    check('失败重试不重跑成功判定及成功定位', afterRetry.counts.judgmentCount === beforeRetry.counts.judgmentCount && afterRetry.counts.locateCount === beforeRetry.counts.locateCount + 1)
    const retriedDiagnostic = await getFrameDiagnostics(uiTaskId, localizedFrame.index)
    const retriedTrace = retriedDiagnostic.callTraces.filter((trace) => trace.operation === '违禁物定位').at(-1)
    check('修改设置后失败重试仍使用任务的 50% 图片快照', retriedTrace?.requestBody.includes(`sha256=${locatedHash}`) === true)
    saveSettings(settingsAfterUi)

    const parallel = await Promise.all([startReview(videoPath), startReview(videoPath), startReview(videoPath)])
    const statuses = await Promise.all(parallel.map((task) => waitTerminal(task.id)))
    check('三个任务并行提交均能完成', statuses.every((status) => status === 'completed'), statuses)
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    check('服务端实测在途请求不超过全局上限', health.peakRequests <= 2, health.peakRequests)
    check('服务端收到的请求均不指定输出 token 上限', health.outputLimitedRequests === 0, health.outputLimitedRequests)
    check('旧英文设置下定位和探针仍使用中文', health.nonChineseLocalizationRequests === 0 && health.counts.probeCount > 0 && health.counts.locateCount > 0)
    check('抽帧进程串行调度且任务结束后无残留名额', extractionScheduler.snapshot().peak === 1 && extractionScheduler.snapshot().active === 0 && modelScheduler.snapshot().active === 0)

    const cancelledId = crypto.randomUUID()
    const controller = new AbortController()
    let cancelled = false
    try {
      await extractFrames({
        taskId: cancelledId, filePath: videoPath, durationMs: 6000, intervalSec: 0.1,
        signal: controller.signal, onProgress: (progress) => { if (progress.percent > 0) controller.abort() }
      })
    } catch (error) {
      cancelled = error instanceof Error && error.message === '任务已取消'
    }
    check('真实 FFmpeg 抽帧响应取消', cancelled && controller.signal.aborted)
    await deleteTask(cancelledId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    check('取消返回后删除目录不再被抽帧进程重建', !fs.existsSync(path.join(getDataDir(), 'tasks', cancelledId)))

    fs.renameSync(videoPath, path.join(getDataDir(), 'moved-smoke-video.mp4'))
    for (const [label, taskId] of [['物品', summary.id], ['行为', behaviorSummary.id]]) {
      const saved = fs.readFileSync(getTaskThumbnailPath(taskId))
      const response = await net.fetch(`vr-media://task-thumbnails/${taskId}`)
      const loaded = Buffer.from(await response.arrayBuffer())
      const size = nativeImage.createFromBuffer(loaded).getSize()
      check(`源视频移走后仍能从任务目录加载${label}记录的首帧缩略图`,
        response.ok && loaded.equals(saved) && size.width === 256 && size.height === 144)
    }
  } finally {
    mock.kill()
    try {
      fs.rmSync(videoPath, { force: true })
    } catch {
      // ignore
    }
  }

  const failed = results.filter((item) => !item.ok)
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(`\n端到端冒烟：PASS ${results.length - failed.length} / FAIL ${failed.length}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  registerMediaProtocol()
  main().catch((error) => {
    console.error('端到端冒烟失败：', error)
    app.exit(1)
  })
})
