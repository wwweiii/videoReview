/**
 * Electron 端到端冒烟（scripts/smoke/run-e2e.mjs 的入口）：
 * 真实 ffmpeg 抽帧 → 判定 → 定位 → task.json → 重定位。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { getDataDir } from '../../src/main/paths'
import {
  getTask,
  initializeTaskManager,
  listTasks,
  relocalizeTask,
  startReview
} from '../../src/main/task/manager'

const root = process.cwd()
const results: Array<{ name: string; ok: boolean; detail: string }> = []

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

function makeVideo(target: string): Promise<void> {
  const platformDir = process.platform === 'win32' ? 'win32' : 'linux'
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpeg = path.join(root, 'resources', 'bin', platformDir, archDir, executable)
  const binary = fs.existsSync(ffmpeg) ? ffmpeg : 'ffmpeg'
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '6', '-pix_fmt', 'yuv420p', target],
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
    modelMode: 'custom',
    customModel: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-e2e-vl',
      concurrency: 2,
      timeoutSec: 30,
      extraHeaders: '',
      extraBody: '',
      maxTokens: 1200,
      imageMaxEdge: 1120,
      imageFormat: 'png',
      promptLanguage: 'zh',
      coordinateSpaceOverride: 'auto',
      boxOrderOverride: 'auto',
      parseDialectOverride: 'auto'
    },
    intervalSec: 1,
    prohibitedItems: ['pen', 'cup', 'kettle', 'phone', 'custom:testpower'],
    customProhibitedItems: [{ id: 'custom:testpower', label: '充电宝' }],
    analysisMode: 'single',
    groupSize: 4,
    confidenceThreshold: 0.6,
    localize: true,
    maxBoxesPerFrame: 8
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
      '内置物品固定包含在任务配置',
      ['pen', 'cup', 'kettle', 'phone'].every((id) => task.config.prohibitedItems.includes(id)),
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

    const relocalizeSummary = await relocalizeTask(summary.id)
    check('relocalize 接受任务', Boolean(relocalizeSummary.id))
    const relocalizeStatus = await waitTerminal(summary.id)
    check('重定位后回到终态', relocalizeStatus === 'completed', relocalizeStatus)
    const afterTask = getTask(summary.id)
    const afterLocated = afterTask.frames.filter(
      (frame) => frame.regionStatus === 'ok' && frame.regions.length > 0
    )
    check('重定位后仍有框', afterLocated.length >= 1, afterLocated.length)
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
  main().catch((error) => {
    console.error('端到端冒烟失败：', error)
    app.exit(1)
  })
})
