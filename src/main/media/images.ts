import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { normalizeLegacyJudgmentImage, normalizeImageScalePercent, type LegacyJudgmentImageOptions, type TaskJudgmentImageOptions } from '@shared/image'
import { getFfmpegPath } from '../paths'
import { imageScheduler, schedulingKey } from '../runtime/scheduler'
import { imageScaleFilter } from './image-scale'

const MAX_CACHE_BYTES = 24 * 1024 * 1024
const cache = new Map<string, { filePath: string; buffer: Buffer; mime: string }>()
let cacheBytes = 0
let hits = 0
let conversions = 0

export function imageCacheMetrics() { return { bytes: cacheBytes, entries: cache.size, hits, conversions } }

export function clearImageCache(directory?: string): void {
  for (const [key, entry] of cache) {
    if (!directory || entry.filePath.startsWith(path.resolve(directory) + path.sep)) {
      cacheBytes -= entry.buffer.length
      cache.delete(key)
    }
  }
}

function put(key: string, value: { filePath: string; buffer: Buffer; mime: string }): void {
  const old = cache.get(key)
  if (old) { cacheBytes -= old.buffer.length; cache.delete(key) }
  if (value.buffer.length > MAX_CACHE_BYTES) return
  cache.set(key, value)
  cacheBytes += value.buffer.length
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > 64) {
    const first = cache.keys().next().value!
    cacheBytes -= cache.get(first)!.buffer.length
    cache.delete(first)
  }
}

function convert(filePath: string, options: LegacyJudgmentImageOptions & { scalePercent?: number }, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new Error('图片处理已取消'))
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath, '-frames:v', '1']
    const scaleFilter = imageScaleFilter(options.scalePercent)
    if (scaleFilter) args.push('-vf', scaleFilter)
    else if (options.maxEdge) args.push('-vf', `scale=w='min(iw,${options.maxEdge})':h='min(ih,${options.maxEdge})':force_original_aspect_ratio=decrease`)
    if (options.format === 'jpeg') args.push('-c:v', 'mjpeg', '-q:v', String(Math.max(2, Math.round(2 + (100 - options.quality) * 0.6))))
    else args.push('-c:v', 'png')
    args.push('-threads', '1', '-f', 'image2pipe', 'pipe:1')
    const child = spawn(getFfmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0, error = '', failure = ''
    const timer = setTimeout(() => { failure = '图片处理超时'; child.kill() }, 30_000)
    const abort = (): void => { child.kill() }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) { failure = '处理后的图片超过大小限制'; child.kill() }
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString('utf8')).slice(-500) })
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.on('error', (cause) => { cleanup(); reject(cause) })
    child.on('close', (code) => {
      cleanup()
      if (signal?.aborted) reject(new Error('图片处理已取消'))
      else if (failure || code !== 0 || !bytes) reject(new Error(failure || `图片处理失败：${error}`))
      else { conversions++; resolve(Buffer.concat(chunks)) }
    })
  })
}

/** 原图异步读取；转换由独立进程执行，内存缓存有上限，转换副本随任务目录一起删除。 */
export async function imageDataUrl(filePath: string, rawOptions?: TaskJudgmentImageOptions, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('图片处理已取消')
  const originalJpeg = /\.jpe?g$/i.test(filePath)
  const sourceScale = rawOptions && 'scalePercent' in rawOptions
  const options: (LegacyJudgmentImageOptions & { scalePercent?: number }) | null = sourceScale
    ? { maxEdge: 0, format: originalJpeg ? 'jpeg' as const : 'png' as const, quality: 90, scalePercent: normalizeImageScalePercent(rawOptions.scalePercent) }
    : rawOptions ? normalizeLegacyJudgmentImage(rawOptions) : null
  const stat = await fs.stat(filePath)
  const key = crypto.createHash('sha256').update(JSON.stringify([path.resolve(filePath), stat.size, stat.mtimeMs, options])).digest('hex')
  const result = await imageScheduler.run(schedulingKey(), signal, async () => {
    const existing = cache.get(key)
    if (existing) { hits++; cache.delete(key); cache.set(key, existing); return existing }
    const needsConversion = options && (sourceScale ? options.scalePercent! < 100 : options.maxEdge > 0 || options.format === 'jpeg' || originalJpeg)
    const mime = needsConversion ? `image/${options.format}` : originalJpeg ? 'image/jpeg' : 'image/png'
    let buffer: Buffer
    if (needsConversion) {
      const directory = path.join(path.dirname(filePath), '..', 'prepared')
      const target = path.join(directory, `${key}.${options.format === 'jpeg' ? 'jpg' : 'png'}`)
      try { buffer = await fs.readFile(target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        buffer = await convert(filePath, options, signal)
        if (signal?.aborted) throw new Error('图片处理已取消')
        await fs.mkdir(directory, { recursive: true })
        const temporary = `${target}.${crypto.randomUUID()}.tmp`
        try { await fs.writeFile(temporary, buffer); await fs.rename(temporary, target) }
        finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      }
    } else buffer = await fs.readFile(filePath)
    if (signal?.aborted) throw new Error('图片处理已取消')
    const entry = { filePath: path.resolve(filePath), buffer, mime }
    put(key, entry)
    return entry
  })
  if (signal?.aborted) throw new Error('图片处理已取消')
  return `data:${result.mime};base64,${result.buffer.toString('base64')}`
}
