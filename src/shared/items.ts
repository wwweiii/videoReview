/**
 * 自定义违禁物、历史任务兼容与标签归一化。
 *
 * 纯函数与常量，主进程（提示词/结果映射）与渲染进程（设置页）共用；
 * 不依赖 Electron / Node，便于单元验证。
 */

import type { CustomProhibitedItem, ProhibitedItem } from './types'
import { MAX_CUSTOM_ITEM_LABEL_LENGTH, MAX_CUSTOM_PROHIBITED_ITEMS } from './defaults'

/** 设置中的已启用 id 只保留仍存在的自定义物品。 */
export function normalizeSelectedItems(rawSelected: unknown, customItems: CustomProhibitedItem[]): string[] {
  const allowedIds = new Set(customItems.map((item) => item.id))
  return Array.isArray(rawSelected)
    ? [...new Set(rawSelected.filter((id): id is string => typeof id === 'string' && allowedIds.has(id)))]
    : []
}

function makeCustomItemId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `custom:${Date.now().toString(36)}${random}`
}

export function normalizeItemLabelText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 判断一个标签是否与某个物品（含别名）匹配 */
function labelMatchesItem(raw: string, item: ProhibitedItem): boolean {
  const normalized = normalizeItemLabelText(raw)
  if (!normalized) return false
  const candidates = [item.label, ...(item.aliases ?? [])]
  return candidates.some((candidate) => {
    const text = normalizeItemLabelText(candidate)
    return Boolean(text) && normalized === text
  })
}

/** 上一版的默认物品，供已有任务的快照解析和重试。 */
const LEGACY_DEFAULT_ITEM_LABELS = new Map(Object.entries({
  phone: '手机',
  mineral_water: '矿泉水',
  work_badge: '工作牌',
  gel_pen: '中性笔',
  pencil: '铅笔',
  thermos: '保温杯',
  notebook: '笔记本',
  key: '钥匙',
  clip: '夹子',
  paper_clip: '回形针',
  toothpick: '牙签',
  staple: '订书针',
  earphone: '耳机',
  disposable_chopsticks: '一次性筷子',
  stainless_steel_tool: '不锈钢工具',
  watch: '手表',
  data_cable: '数据线',
  air_conditioner_remote: '空调遥控器'
}))

export const LEGACY_DEFAULT_ITEM_IDS = [...LEGACY_DEFAULT_ITEM_LABELS.keys()]

/** 更早版本的任务也可能包含这些物品。 */
const LEGACY_ITEM_LABELS = new Map(Object.entries({
  pen: '笔',
  cup: '水杯',
  kettle: '水壶',
  tablet: '平板电脑',
  laptop: '笔记本电脑',
  camera: '相机',
  recorder: '录音设备',
  smartwatch: '智能手表',
  other_device: '其他电子设备'
}))

/** 按 id 解析物品，兼容历史任务；省略 id 列表时返回全部自定义物品。 */
export function resolveProhibitedItems(
  itemIds: string[] | undefined,
  customItems: CustomProhibitedItem[] = []
): ProhibitedItem[] {
  const map = new Map<string, ProhibitedItem>()
  for (const custom of customItems) {
    if (map.has(custom.id)) continue
    map.set(custom.id, { id: custom.id, label: custom.label, prompt: custom.label, aliases: [] })
  }
  if (!itemIds) return [...map.values()]
  return [...new Set(itemIds)].map((id) => {
    const custom = map.get(id)
    if (custom) return custom
    const defaultLabel = LEGACY_DEFAULT_ITEM_LABELS.get(id)
    const label = defaultLabel ?? LEGACY_ITEM_LABELS.get(id) ?? id
    return { id, label, prompt: label, aliases: defaultLabel ? [id] : [] }
  })
}

export interface ItemMatch {
  itemId: string | null
  category: string
}

/**
 * 把模型给的标签映射回任务物品。
 *
 * - `itemIds` 省略表示在全部自定义物品里匹配；
 * - 标签为空且只有一个候选时直接归给它；
 * - 对不上时保留原始标签（截断 24 字）且 itemId=null。
 */
export function matchItem(
  label: string,
  itemIds?: string[],
  customItems: CustomProhibitedItem[] = []
): ItemMatch {
  const raw = label.trim()
  if (raw) {
    for (const item of resolveProhibitedItems(itemIds, customItems)) {
      if (labelMatchesItem(raw, item)) {
        return { itemId: item.id, category: item.label }
      }
    }
    return { itemId: null, category: raw.slice(0, 24) }
  }
  // 模型没给标签：只有一个候选检测项时直接归给它
  const candidates = resolveProhibitedItems(itemIds, customItems)
  if (candidates.length === 1) {
    const only = candidates[0]
    return { itemId: only.id, category: only.label }
  }
  return { itemId: null, category: '目标' }
}

/** 把模型返回的标签映射成自定义物品名称，对不上则保留原标签。 */
export function canonicalizeItemLabel(
  raw: string,
  customItems: CustomProhibitedItem[] = []
): string {
  const text = raw.trim()
  if (!text) return ''
  const match = matchItem(text, undefined, customItems)
  return match.itemId ? match.category : text.slice(0, 24)
}

/** 清洗/校验用户自定义物品输入 */
export function normalizeCustomItems(input: unknown): CustomProhibitedItem[] {
  if (!Array.isArray(input)) return []
  const result: CustomProhibitedItem[] = []
  const seenLabels = new Set<string>()
  const seenIds = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as { id?: unknown; label?: unknown }
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!label || label.length > MAX_CUSTOM_ITEM_LABEL_LENGTH) continue
    const normalizedLabel = normalizeItemLabelText(label)
    if (seenLabels.has(normalizedLabel)) continue
    let id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!/^custom:[a-z0-9_-]+$/i.test(id) || seenIds.has(id)) id = makeCustomItemId()
    seenLabels.add(normalizedLabel)
    seenIds.add(id)
    result.push({ id, label })
    if (result.length >= MAX_CUSTOM_PROHIBITED_ITEMS) break
  }
  return result
}
