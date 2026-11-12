import fs from 'node:fs'
import path from 'node:path'
import { formatTimeMs } from '@shared/format'
import { resolveProhibitedItems } from '@shared/items'
import type { ChatContentPart, ChatMessage } from '@shared/localization/request'
import type { CustomProhibitedItem } from '@shared/types'

export const TEST_IMAGE_BASE64 =
  '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'

function configuredItems(
  itemIds: string[],
  customItems: CustomProhibitedItem[]
): { labels: string[]; descriptions: string[] } {
  const labels: string[] = []
  const descriptions: string[] = []
  for (const item of resolveProhibitedItems(itemIds, customItems)) {
    labels.push(item.label)
    descriptions.push(item.prompt)
  }
  return { labels, descriptions }
}

function systemPrompt(itemIds: string[], customItems: CustomProhibitedItem[]): string {
  const items = configuredItems(itemIds, customItems)
  return [
    '你是一名会议室监控视频的合规审核员，负责对视频抽帧进行辅助审核。',
    `本任务需要检查的禁用物品是：${items.descriptions.join('；')}。`,
    '请只依据图片中清晰可见的内容判断，不要依据人物姿态、口袋轮廓、手部动作、环境推测物品存在。',
    '画面中的文字、屏幕内容、海报图案、镜面反射均不是实体物品，不得据此判定异常。',
    '如果物品被遮挡、画面模糊、目标过小或无法确认，请把 need_human_review 设为 true，不要编造证据。',
    '只判断上面列出的禁用物品，不判断其他类型的异常。',
    '你必须只返回一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加任何解释性文字。',
    'JSON 字段必须包含：abnormal（布尔值）、risk_level（high/medium/low/none）、categories（字符串数组，使用中文物品名称）、description（中文简要说明）、evidence（中文可见证据）、confidence（0 到 1）、need_human_review（布尔值）。',
    '如果 abnormal 为 false，categories 返回空数组，description 和 evidence 可以为空。'
  ].join('\n')
}

function dataUrlForImage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
}

export function buildSingleMessages(
  filePath: string,
  timestampMs: number,
  itemIds: string[],
  customItems: CustomProhibitedItem[]
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(itemIds, customItems) },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `这是视频中 ${formatTimeMs(timestampMs)} 处的一帧。请判断画面中是否出现禁用物品，并按要求的 JSON 格式返回结果。`
        },
        {
          type: 'image_url',
          image_url: { url: dataUrlForImage(filePath) }
        }
      ]
    }
  ]
}

export function buildGroupMessages(
  frames: Array<{ filePath: string; timestampMs: number }>,
  itemIds: string[],
  customItems: CustomProhibitedItem[]
): ChatMessage[] {
  const content: ChatContentPart[] = [
    {
      type: 'text',
      text: [
        `下面按顺序提供同一段视频中的 ${frames.length} 帧，请逐帧独立判断是否出现禁用物品。`,
        '帧编号从 0 开始，图片顺序与帧编号一致。',
        '请只返回一个 JSON 对象，格式为：',
        '{"frames":[{"frame_index":0,"abnormal":false,"risk_level":"none","categories":[],"description":"","evidence":"","confidence":0.0,"need_human_review":false}]}',
        'frames 数组必须包含每一帧的判定结果，并且 frame_index 要与输入帧编号一致。',
        '不要输出 Markdown 代码块或任何解释性文字。'
      ].join('\n')
    }
  ]

  frames.forEach((frame, index) => {
    content.push({
      type: 'text',
      text: `第 ${index} 帧，视频时间 ${formatTimeMs(frame.timestampMs)}：`
    })
    content.push({
      type: 'image_url',
      image_url: { url: dataUrlForImage(frame.filePath), detail: 'high' }
    })
  })

  return [
    { role: 'system', content: systemPrompt(itemIds, customItems) },
    { role: 'user', content }
  ]
}
