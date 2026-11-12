/**
 * OpenAI 兼容请求的纯函数部分：请求体拼装与响应内容提取。
 * 不依赖 Electron / Node 专有 API，便于单元测试。
 */

export interface ChatTextPart {
  type: 'text'
  text: string
}

export interface ChatImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' } | string
}

export type ChatContentPart = ChatTextPart | ChatImagePart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface RequestBodyOptions {
  maxTokens?: number
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  temperature?: number
  responseFormat?: 'json_object' | null
  /** 透传给服务端的额外字段：chat_template_kwargs / repetition_penalty 等 */
  extraBody?: Record<string, unknown>
}

export const DEFAULT_REQUEST_OPTIONS: Required<
  Pick<RequestBodyOptions, 'maxTokens' | 'maxTokensField' | 'temperature'>
> = {
  maxTokens: 1200,
  maxTokensField: 'max_tokens',
  temperature: 0
}

export function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  options: RequestBodyOptions = {}
): Record<string, unknown> {
  const field = options.maxTokensField ?? DEFAULT_REQUEST_OPTIONS.maxTokensField
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? DEFAULT_REQUEST_OPTIONS.temperature,
    [field]: options.maxTokens ?? DEFAULT_REQUEST_OPTIONS.maxTokens
  }
  if (options.responseFormat) {
    body.response_format = { type: options.responseFormat }
  }
  if (options.extraBody && typeof options.extraBody === 'object') {
    Object.assign(body, options.extraBody)
  }
  return body
}

export interface ExtractedContent {
  content: string
  reasoning: string
  finishReason: string | null
}

function textFromContentParts(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const pieces: string[] = []
  for (const part of value) {
    if (typeof part === 'string') {
      pieces.push(part)
      continue
    }
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') pieces.push(record.text)
    }
  }
  return pieces.join('\n')
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textFromContentParts(value)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content)) return textFromContentParts(record.content)
  }
  return ''
}

/** 兼容各部署栈的响应结构：content / reasoning / reasoning_content / choice.text */
export function extractMessageContent(payload: unknown): ExtractedContent {
  const data = (payload ?? {}) as {
    choices?: Array<{
      message?: Record<string, unknown>
      text?: unknown
      finish_reason?: unknown
    }>
  }
  const choice = data.choices?.[0]
  const message = choice?.message ?? {}
  const content =
    textFromUnknown(message.content) ||
    textFromUnknown(message.reasoning) ||
    textFromUnknown(message.reasoning_content) ||
    textFromUnknown(choice?.text)
  const reasoning =
    textFromUnknown(message.reasoning) || textFromUnknown(message.reasoning_content)
  const finishReason =
    typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  return { content, reasoning, finishReason }
}
