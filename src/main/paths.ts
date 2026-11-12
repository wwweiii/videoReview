import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let cachedDataDir: string | null = null

/** 任务 id 固定为 UUID：既是 data/tasks 的目录名，也是 vr-media:// 路由的校验依据 */
export const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value)
}

function canWriteDirectory(directory: string): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true })
    const probe = path.join(directory, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function getAppRoot(): string {
  return app.getAppPath()
}

export function getResourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(getAppRoot(), 'resources')
}

export function getDataDir(): string {
  if (cachedDataDir) return cachedDataDir

  // 测试/多环境部署可通过环境变量指定数据目录（安全边界：必须是绝对路径）
  const override = process.env.VIDEOREVIEW_DATA_DIR?.trim()
  if (override && path.isAbsolute(override)) {
    fs.mkdirSync(override, { recursive: true })
    cachedDataDir = override
    return cachedDataDir
  }

  const baseDir = app.isPackaged ? path.dirname(process.execPath) : getAppRoot()
  // 单文件便携版（electron-builder portable）运行时会被解压到临时目录执行，
  // 真实 exe 所在目录由 PORTABLE_EXECUTABLE_DIR 提供；数据目录要跟着 exe 走，
  // 否则 settings/tasks 会写进临时目录，进程退出即丢失。
  const portableDir = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR?.trim() : ''
  const dataBaseDir = portableDir && path.isAbsolute(portableDir) ? portableDir : baseDir
  const siblingDataDir = path.join(dataBaseDir, 'data')

  if (canWriteDirectory(siblingDataDir)) {
    cachedDataDir = siblingDataDir
  } else {
    cachedDataDir = app.getPath('userData')
    fs.mkdirSync(cachedDataDir, { recursive: true })
  }

  return cachedDataDir
}

export function configureElectronDataPath(): string {
  const dataDir = getDataDir()
  app.setPath('userData', path.join(dataDir, 'electron'))
  app.setPath('sessionData', path.join(dataDir, 'electron', 'session'))
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
  return dataDir
}

export function getTasksDir(): string {
  return path.join(getDataDir(), 'tasks')
}

export function getTaskDir(taskId: string): string {
  return path.join(getTasksDir(), taskId)
}

export function getFramesDir(taskId: string): string {
  return path.join(getTaskDir(taskId), 'frames')
}

export function getThumbsDir(taskId: string): string {
  return path.join(getTaskDir(taskId), 'thumbs')
}

export function getTaskFilePath(taskId: string): string {
  return path.join(getTaskDir(taskId), 'task.json')
}

export function getSettingsPath(): string {
  return path.join(getDataDir(), 'settings.json')
}

export function getPresetPath(): string {
  return path.join(getResourcesRoot(), 'config', 'preset.enc')
}

export function getFfmpegPath(): string {
  const platformDir = process.platform === 'win32' ? 'win32' : 'linux'
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64'
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const bundled = path.join(getResourcesRoot(), 'bin', platformDir, archDir, executable)

  if (fs.existsSync(bundled)) return bundled

  // Development fallback. Packaged builds always resolve the bundled binary.
  if (!app.isPackaged) return executable
  throw new Error('视频处理组件缺失')
}

export function getWindowIconPath(): string {
  const candidates = [
    path.join(getResourcesRoot(), 'icon.png'),
    path.join(getAppRoot(), 'build', 'icon.png')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? ''
}
