import { nativeImage, net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { logger } from '../logger'
import { getFramesDir, getThumbsDir, isTaskId } from '../paths'
import { readTask } from '../task/store'

/** 对已导入的行为任务提供流式读取，支持播放器 seek，不将整个视频读入内存。 */
function videoResponse(request: Request, url: URL): Response {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 1 || !isTaskId(segments[0])) return new Response('Not found', { status: 404 })
  const task = readTask(segments[0])
  if (!task || task.kind !== 'behavior' || !fs.existsSync(task.source.filePath)) {
    return new Response('Not found', { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const stat = fs.statSync(task.source.filePath)
  if (!stat.isFile()) return new Response('Not found', { status: 404 })
  const size = stat.size
  const range = request.headers.get('range')
  let start = 0, end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
  }
  const types: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t' }
  const headers: Record<string, string> = {
    'Content-Type': types[path.extname(task.source.filePath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(Math.max(0, end - start + 1))
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const body = request.method === 'HEAD' || size === 0 ? null
    : Readable.toWeb(fs.createReadStream(task.source.filePath, { start, end })) as ReadableStream
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** 必须在 app ready 之前调用 */
export function registerMediaSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'vr-media',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
}

export function registerMediaProtocol(): void {
  protocol.handle('vr-media', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host === 'video') return videoResponse(request, url)
      if (url.host !== 'frames') {
        return new Response('Not found', { status: 404 })
      }
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments.length !== 2) {
        return new Response('Not found', { status: 404 })
      }
      const taskId = segments[0]
      const fileName = decodeURIComponent(segments[1])
      if (!isTaskId(taskId)) {
        return new Response('Not found', { status: 404 })
      }
      if (
        !fileName ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        fileName.includes('..') ||
        !/\.(png|jpe?g)$/i.test(fileName)
      ) {
        return new Response('Not found', { status: 404 })
      }

      const framesDir = getFramesDir(taskId)
      const sourcePath = path.resolve(framesDir, fileName)
      if (!sourcePath.startsWith(path.resolve(framesDir) + path.sep) || !fs.existsSync(sourcePath)) {
        return new Response('Not found', { status: 404 })
      }

      const thumbRequested = url.searchParams.get('thumb') === '1'
      if (!thumbRequested) {
        return net.fetch(pathToFileURL(sourcePath).toString())
      }

      const thumbDir = getThumbsDir(taskId)
      const thumbPath = path.join(thumbDir, fileName.replace(/\.(png|jpe?g)$/i, '.jpg'))
      if (!fs.existsSync(thumbPath)) {
        fs.mkdirSync(thumbDir, { recursive: true })
        const image = nativeImage.createFromPath(sourcePath)
        if (image.isEmpty()) return new Response('Not found', { status: 404 })
        const original = image.getSize()
        const maxDimension = 480
        const scale = Math.min(1, maxDimension / Math.max(original.width, original.height))
        const resized = scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(original.width * scale)),
              height: Math.max(1, Math.round(original.height * scale)),
              quality: 'good'
            })
          : image
        const buffer = resized.toJPEG(82)
        const temporary = `${thumbPath}.${Date.now()}.tmp`
        fs.writeFileSync(temporary, buffer)
        try {
          fs.renameSync(temporary, thumbPath)
        } catch {
          try {
            fs.unlinkSync(temporary)
          } catch {
            // Another request may already have produced the thumbnail.
          }
        }
      }
      return net.fetch(pathToFileURL(thumbPath).toString())
    } catch (error) {
      logger.error('读取帧图片失败', error)
      return new Response('Internal error', { status: 500 })
    }
  })
}
