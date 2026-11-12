/**
 * 定位/探针的提示词模板（纯字符串，便于测试与多语言扩展）。
 *
 * 约定：
 * - 系统提示词里包含「视觉定位助手」标记，便于 mock 服务识别请求类型；
 * - 探针请求额外包含「能力自检」标记；
 * - 坐标规则由 profile 的 coordinateSpace 决定，运行时拼装。
 */

import type { CoordinateSpace } from './profile'

export type PromptLanguage = 'zh' | 'en'

export interface LocalizePromptInput {
  language: PromptLanguage
  space: CoordinateSpace
  sentWidth: number
  sentHeight: number
  scene: string
  itemLabels: string[]
  timestampText: string
  /** 本帧异常判定已确认的类别；有值时只允许定位这些对象，避免"判 A 定位 B" */
  focusLabels?: string[]
}

export interface BuiltMessages {
  system: string
  user: string
}

function coordinateRulesZh(space: CoordinateSpace, width: number, height: number): string {
  if (space === 'absolute_px') {
    return [
      '坐标规则（必须严格遵守）：',
      '1. 以图片左上角为原点，x 轴向右，y 轴向下。',
      `2. 使用像素坐标：[x1, y1, x2, y2]，单位是像素，范围 0 ≤ x ≤ ${width}、0 ≤ y ≤ ${height}（即本次输入图片的宽 ${width}、高 ${height}）。`,
      '3. 不要输出归一化小数，不要输出百分比。'
    ].join('\n')
  }
  const range =
    space === 'normalized_1000'
      ? '0~1000 的整数'
      : space === 'normalized_100'
        ? '0~100 的数值'
        : '0~1 的小数（保留 3 位）'
  return [
    '坐标规则（必须严格遵守）：',
    '1. 以图片左上角为原点，x 轴向右，y 轴向下。',
    `2. 使用归一化坐标：${range}，x 相对图片宽度、y 相对图片高度。`,
    '3. 每个框写成 [x1, y1, x2, y2]，(x1,y1) 是左上角，(x2,y2) 是右下角，且 x1<x2、y1<y2。'
  ].join('\n')
}

function coordinateRulesEn(space: CoordinateSpace, width: number, height: number): string {
  if (space === 'absolute_px') {
    return [
      'Coordinate rules (strict):',
      '1. Origin at top-left, x to the right, y downward.',
      `2. Use pixel coordinates: [x1, y1, x2, y2] in pixels, within 0 ≤ x ≤ ${width} and 0 ≤ y ≤ ${height}.`,
      '3. Do not output normalized decimals or percentages.'
    ].join('\n')
  }
  const range =
    space === 'normalized_1000'
      ? 'integers in 0..1000'
      : space === 'normalized_100'
        ? 'numbers in 0..100'
        : 'decimals in 0..1 (3 decimal places)'
  return [
    'Coordinate rules (strict):',
    '1. Origin at top-left, x to the right, y downward.',
    `2. Use normalized coordinates: ${range}, relative to image width and height.`,
    '3. Each box is [x1, y1, x2, y2] with x1<x2 and y1<y2.'
  ].join('\n')
}

const ZH_OUTPUT = [
  '只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，不要添加任何解释文字。',
  'JSON 结构：',
  '{"objects":[{"label":"手机","bbox":[120,340,260,520],"confidence":0.86}]}',
  '如果你的训练格式使用 <box> 之类的特殊标记，也可以直接使用该格式，只要坐标含义正确。'
].join('\n')

const EN_OUTPUT = [
  'Return exactly one valid JSON object, no markdown fences and no extra prose.',
  'JSON schema:',
  '{"objects":[{"label":"phone","bbox":[120,340,260,520],"confidence":0.86}]}',
  'If your native format uses <box> style tokens, you may use it as long as coordinates are correct.'
].join('\n')

export function buildLocalizeMessages(input: LocalizePromptInput): BuiltMessages {
  const {
    language,
    space,
    sentWidth,
    sentHeight,
    scene,
    itemLabels,
    timestampText,
    focusLabels
  } = input
  const focus = (focusLabels ?? []).filter(Boolean)
  const targets = focus.length > 0 ? focus : itemLabels
  const items = targets.join(language === 'zh' ? '、' : ', ')

  if (language === 'en') {
    const system = [
      'You are a visual localization assistant. Your only task is to locate specified objects in the given image and output the bounding box of each object.',
      '',
      coordinateRulesEn(space, sentWidth, sentHeight),
      '',
      'Annotation rules:',
      '1. Only annotate clearly visible, verifiable physical objects; annotate each object once.',
      '2. Text, screen content, posters, reflections and mirror images are not physical objects; do not annotate them.',
      '3. Boxes should hug the visible outline of the object, not a large background area; if occluded, box the visible part only.',
      '4. Output every clearly visible, verifiable target, ordered by confidence from high to low.',
      '5. If no target object is present, return {"objects": []}. Never guess a location.',
      focus.length > 0
        ? `6. The frame has already been judged abnormal for: ${items}. Only locate these objects. Do not output boxes for other objects, and do not substitute a different object when the target is missing.`
        : '',
      '',
      EN_OUTPUT
    ]
      .filter(Boolean)
      .join('\n')
    const user = [
      `This is a frame of a ${scene || 'video'} at ${timestampText}, image size ${sentWidth}x${sentHeight}.`,
      focus.length > 0
        ? `Locate only these judged objects: ${items}. Return {"objects": []} if they are not visible.`
        : `Locate the following objects: ${items}.`,
      'Return JSON only.'
    ].join(' ')
    return { system, user }
  }

  const system = [
    `你是一名视觉定位助手。你的唯一任务是：在给定的一张${scene || '视频'}画面中，找出指定物品，并输出每个物品的外接矩形框。`,
    '',
    coordinateRulesZh(space, sentWidth, sentHeight),
    '',
    '标注规则：',
    '1. 只标注图片中清晰可见、可确认的实体物品；同一物品只标注一次。',
    '2. 文字、屏幕里的画面、海报图案、镜面反射、倒影都不是实体物品，不要标注。',
    '3. 框要贴近物品外边缘，不要框住大片背景；物品被明显遮挡时只框可见部分。',
    '4. 输出所有清晰可见、可确认的目标框，按置信度从高到低排列。',
    '5. 如果图片中没有目标物品，返回 {"objects": []}；找不到时禁止猜测位置。',
    focus.length > 0
      ? `6. 本帧异常判定已确认存在：${items}。请只定位这些对象，不要标注其他物品；如果目标不可见，返回 {"objects": []}，不要用其他物品代替。`
      : '',
    '',
    ZH_OUTPUT
  ]
    .filter(Boolean)
    .join('\n')

  const user = [
    `这是视频 ${timestampText} 处的一帧，图片尺寸为 ${sentWidth}×${sentHeight}。`,
    focus.length > 0
      ? `请只定位本帧已判定的物品：${items}；如果不可见，返回 {"objects": []}。`
      : `请定位以下物品：${items}。`,
    '只输出 JSON。'
  ].join('')

  return { system, user }
}

/** 探针提示词：不指定坐标空间，让模型用训练时的原生表示 */
export function buildProbeMessages(language: PromptLanguage = 'zh'): BuiltMessages {
  if (language === 'en') {
    return {
      system: [
        'You are an image localization self-check tool. The image contains several colored rectangles.',
        'Return only a JSON array, no explanation.',
        'Each element: {"label":"red","bbox":[x1,y1,x2,y2]}',
        'Use the native coordinate representation you were trained with. Do not convert coordinates.',
        'Marker: capability self-check.'
      ].join('\n'),
      user: 'Locate all colored rectangles in the image. Return JSON only.'
    }
  }
  return {
    system: [
      '你是图像定位能力自检器（能力自检）。图中有若干彩色矩形。',
      '请只返回一个 JSON 数组，不要输出任何解释文字。',
      '每个元素格式：{"label":"red","bbox":[x1,y1,x2,y2]}',
      '坐标请使用你训练时的原生坐标表示，不要做任何换算。'
    ].join('\n'),
    user: '请定位图中所有彩色矩形。只输出 JSON。'
  }
}

/** 提示词版本指纹：改模板就必须重新探测 */
export const LOCALIZE_PROMPT_VERSION = 'localize-v3'
