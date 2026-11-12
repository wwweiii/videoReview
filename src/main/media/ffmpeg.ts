import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { VideoFileInfo } from '@shared/types'
import { getFfmpegPath, getFramesDir } from '../paths'
import { logger } from '../logger'

type FFmpegProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ExtractedFrame {
  index: number
  timestampMs: number
  fileName: string
}

export interface ExtractionProgress {
  percent: number
  message: string
}

function killProcess(child: FFmpegProcess): void {
  try {
    child.kill()
  } catch {
    // Process already exited.
  }
}

function parseDuration(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  return Math.round(
    (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000
  )
}

function parseResolution(stderr: string): { width: number; height: number } {
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('Video:')) continue
    const match = line.match(/(\d{2,5})x(\d{2,5})/)
    if (match) return { width: Number(match[1]), height: Number(match[2]) }
  }
  return { width: 0, height: 0 }
}

function lastUsefulError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errorLine = [...lines]
    .reverse()
    .find((line) => /error|failed|invalid|not found|no such|unsupported/i.test(line))
  return (errorLine ?? lines[lines.length - 1] ?? '').slice(0, 300)
}

export async function probeVideo(
  filePathInput: string,
  signal?: AbortSignal
): Promise<VideoFileInfo> {
  if (signal?.aborted) throw new Error('操作已取消')
  const filePath = path.resolve(filePathInput)
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error('无法读取所选视频')
  }
  if (!stat.isFile()) throw new Error('所选内容不是视频文件')

  const args = ['-hide_banner', '-nostdin', '-i', filePath, '-t', '0', '-f', 'null', '-']
  const stderr = await new Promise<string>((resolve, reject) => {
    let child: FFmpegProcess
    try {
      child = spawn(getFfmpegPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      reject(new Error('视频解析组件不可用'))
      return
    }

    let output = ''
    let settled = false
    const finish = (callback: () => void, delay = 0): void => {
      if (delay) setTimeout(callback, delay)
      else callback()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcess(child)
      reject(new Error('读取视频超时'))
    }, 30_000)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcess(child)
      reject(new Error('操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('视频解析组件不可用'))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(() => resolve(output))
    })
  })

  const durationMs = parseDuration(stderr)
  if (!durationMs || durationMs <= 0) {
    logger.warn('视频解析失败', stderr.slice(-1500))
    throw new Error('无法读取视频')
  }
  const { width, height } = parseResolution(stderr)
  const info: VideoFileInfo = {
    fileName: path.basename(filePath),
    filePath,
    durationMs,
    width,
    height,
    fileSizeBytes: stat.size
  }
  logger.info('视频读取完成', {
    fileName: info.fileName,
    durationMs,
    width,
    height
  })
  return info
}

export async function extractFrames(options: {
  taskId: string
  filePath: string
  durationMs: number
  intervalSec: number
  /** 行为采样独立使用压缩画面；物品抽帧保留原有默认参数。 */
  imageFormat?: 'png' | 'jpeg'
  maxEdge?: number
  startAtZero?: boolean
  signal?: AbortSignal
  onProgress?: (progress: ExtractionProgress) => void
}): Promise<ExtractedFrame[]> {
  const { taskId, filePath, durationMs, intervalSec, signal, onProgress } = options
  const extension = options.imageFormat === 'jpeg' ? 'jpg' : 'png'
  if (signal?.aborted) throw new Error('任务已取消')
  const framesDir = getFramesDir(taskId)
  fs.mkdirSync(framesDir, { recursive: true })
  for (const file of fs.readdirSync(framesDir)) {
    if (file.endsWith(`.${extension}`)) fs.unlinkSync(path.join(framesDir, file))
  }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    [
      ...(options.startAtZero ? ['setpts=PTS-STARTPTS'] : []),
      `fps=1/${intervalSec}${options.startAtZero ? ':start_time=0:round=up' : ''}`,
      ...(options.maxEdge
        ? [`scale=w='min(iw,${options.maxEdge})':h='min(ih,${options.maxEdge})':force_original_aspect_ratio=decrease`]
        : []),
      'showinfo'
    ].join(','),
    '-vsync',
    'vfr',
    '-start_number',
    '0',
    ...(extension === 'jpg' ? ['-q:v', '3'] : ['-pix_fmt', 'rgb24']),
    path.join(framesDir, `%06d.${extension}`)
  ]

  const frameTimes: number[] = []
  let lastEmit = 0
  const stderrTail: string[] = []

  await new Promise<void>((resolve, reject) => {
    let child: FFmpegProcess
    try {
      child = spawn(getFfmpegPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      reject(new Error('视频处理组件不可用'))
      return
    }

    let settled = false
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const onAbort = (): void => {
      if (settled) return
      settled = true
      killProcess(child)
      reject(new Error('任务已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      let currentUs: number | null = null
      for (const line of lines) {
        const match = line.match(/^(\w+)=(.*)$/)
        if (!match) continue
        if (match[1] === 'out_time_us') {
          const value = Number(match[2])
          if (Number.isFinite(value)) currentUs = value
        }
        if (match[1] === 'progress' && currentUs !== null) {
          const now = Date.now()
          if (now - lastEmit > 400) {
            lastEmit = now
            const percent =
              durationMs > 0
                ? Math.min(99, Math.max(0, (currentUs / 1_000_000 / (durationMs / 1000)) * 100))
                : 0
            onProgress?.({ percent, message: '正在抽帧' })
          }
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.match(/Parsed_showinfo.*pts_time:([0-9.]+)/)
        if (match) frameTimes.push(Number(match[1]))
        if (line.trim()) {
          stderrTail.push(line.trim())
          if (stderrTail.length > 40) stderrTail.shift()
        }
      }
    })

    child.on('error', () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('视频处理组件不可用'))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else {
        const detail = lastUsefulError(stderrTail.join('\n'))
        reject(new Error(detail ? `视频处理失败：${detail}` : '视频处理失败'))
      }
    })
  })

  const files = fs
    .readdirSync(framesDir)
    .filter((file) => file.toLowerCase().endsWith(`.${extension}`))
    .sort((a, b) => a.localeCompare(b, 'en'))
  if (files.length === 0) throw new Error('未提取到视频画面')

  return files.map((fileName, index) => ({
    index,
    timestampMs: Number.isFinite(frameTimes[index])
      ? Math.round(frameTimes[index] * 1000)
      : Math.round(index * intervalSec * 1000),
    fileName
  }))
}
