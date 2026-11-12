import { buildRequestBody, extractMessageContent } from '@shared/localization/request'
import type { ChatMessage } from '@shared/localization/request'
import type { ResolvedModelConfig } from '../config/model-config'
import { logger } from '../logger'
import { TEST_IMAGE_BASE64 } from './prompts'

export class FatalModelError extends Error {}

/** 解析模型配置里的"额外请求体"（JSON 字符串）；非法时忽略并告警 */
function parseModelExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn('额外请求体不是 JSON 对象，已忽略')
      return undefined
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    logger.warn('额外请求体解析失败，已忽略', error)
    return undefined
  }
}

function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

function parseExtraHeaders(extraHeaders: string): Record<string, string> {
  if (!extraHeaders.trim()) return {}
  try {
    const parsed = JSON.parse(extraHeaders) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') result[key] = String(value)
    }
    return result
  } catch {
    throw new Error('附加请求头不是合法的 JSON 对象')
  }
}

export async function requestChat(
  config: ResolvedModelConfig,
  messages: ChatMessage[],
  options: {
    maxTokens?: number
    timeoutSec?: number
    signal?: AbortSignal
    responseFormat?: 'json_object' | null
    maxAttempts?: number
    requireComplete?: boolean
  } = {}
): Promise<{ content: string; latencyMs: number }> {
  const endpoint = resolveEndpoint(config.baseUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }
  Object.assign(headers, parseExtraHeaders(config.extraHeaders))

  const timeoutSec = Math.max(5, options.timeoutSec ?? config.timeoutSec)
  const body = JSON.stringify(
    buildRequestBody(config.model, messages, {
      maxTokens: options.maxTokens ?? config.maxTokens,
      temperature: 0,
      responseFormat: options.responseFormat ?? null,
      extraBody: parseModelExtraBody(config.extraBody)
    })
  )

  let lastError: Error | null = null
  const started = Date.now()
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3))

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), timeoutSec * 1000)
    const onAbort = (): void => timeoutController.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: timeoutController.signal
      })
      const text = await response.text()
      const latencyMs = Date.now() - started

      if (!response.ok) {
        logger.warn('模型请求返回错误', { status: response.status, body: text.slice(0, 1000) })
        if (response.status === 401 || response.status === 403) {
          throw new FatalModelError('模型鉴权失败，请检查密钥')
        }
        const error = new Error('模型请求失败，请稍后重试') as Error & { status?: number }
        error.status = response.status
        if (response.status === 429 || response.status >= 500) {
          lastError = error
          if (attempt < maxAttempts - 1) {
            await sleep(800 * (attempt + 1), options.signal)
            continue
          }
        }
        throw error
      }

      const content = extractResponseContent(text, options.requireComplete)
      if (!content.trim()) throw new Error('模型未返回内容')
      return { content, latencyMs }
    } catch (error) {
      if (options.signal?.aborted) throw new Error('分析已取消')
      if (error instanceof FatalModelError) throw error
      if (isAbortError(error)) {
        lastError = new Error('模型请求超时')
      } else if (error instanceof Error) {
        const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause
        if (error.message === 'fetch failed' || !error.message) {
          logger.warn('模型连接失败', cause ?? error)
          lastError = new Error('无法连接模型服务')
        } else {
          lastError = error
        }
      } else {
        lastError = new Error('模型请求失败')
      }
      const retryable =
        !(error as { status?: number }).status ||
        (error as { status?: number }).status === 429 ||
        ((error as { status?: number }).status ?? 0) >= 500
      if (attempt < maxAttempts - 1 && retryable) {
        await sleep(800 * (attempt + 1), options.signal)
        continue
      }
      throw lastError
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  throw lastError ?? new Error('模型请求失败')
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted|abort/i.test(error.message))
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('分析已取消'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('分析已取消'))
      },
      { once: true }
    )
  })
}

function extractResponseContent(text: string, requireComplete = false): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('模型返回格式异常')
  }
  const { content, finishReason } = extractMessageContent(parsed)
  if (requireComplete && finishReason === 'length') {
    throw new Error('模型输出达到长度上限，请检查推理配置后重试')
  }
  if (!content.trim()) throw new Error('模型返回内容为空')
  return content
}

export async function testModelConnection(
  config: ResolvedModelConfig
): Promise<{ latencyMs: number; preview: string }> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: '你是一个多模态接口连通性测试助手。'
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '这是一张测试图片。如果你能读取图片，请只回复：连接成功'
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${TEST_IMAGE_BASE64}`
          }
        }
      ]
    }
  ]
  const { content, latencyMs } = await requestChat(config, messages, {
    maxTokens: 30,
    timeoutSec: Math.min(config.timeoutSec, 45)
  })
  return {
    latencyMs,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 160)
  }
}
