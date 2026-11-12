/**
 * 违禁物清单（内置固定项 + 用户自定义项）与标签归一化。
 *
 * 纯函数与常量，主进程（提示词/结果映射）与渲染进程（设置页）共用；
 * 不依赖 Electron / Node，便于单元验证。
 */

import type { CustomProhibitedItem, ProhibitedItem } from './types'
import { MAX_CUSTOM_ITEM_LABEL_LENGTH, MAX_CUSTOM_PROHIBITED_ITEMS } from './defaults'

/**
 * 内置违禁物：固定清单，不可删除、不可取消勾选。
 * 用户只能追加自定义物品；自定义物品可删除。
 */
export const BUILTIN_PROHIBITED_ITEMS: ProhibitedItem[] = [
  {
    id: 'pen',
    label: '笔',
    prompt: '笔（钢笔、圆珠笔、签字笔、马克笔等可书写的笔类）',
    aliases: ['pen', 'ballpoint', '钢笔', '圆珠笔', '签字笔', '中性笔', '铅笔', '马克笔', 'marker']
  },
  {
    id: 'cup',
    label: '水杯',
    prompt: '水杯（杯子、茶杯、保温杯等盛水容器）',
    aliases: ['cup', 'mug', 'glass', 'cup with water', '杯子', '茶杯', '保温杯', '水杯子', '玻璃杯']
  },
  {
    id: 'kettle',
    label: '水壶',
    prompt: '水壶（电水壶、保温壶、茶壶等）',
    aliases: ['kettle', 'teapot', '水壶', '电水壶', '保温壶', '茶壶', '壶', '热水壶']
  },
  {
    id: 'phone',
    label: '手机',
    prompt: '手机（包括正在使用、放在桌面或手持的手机）',
    aliases: ['phone', 'smartphone', 'cellphone', 'mobile', 'mobile phone', '手机', '智能手机', '移动电话']
  }
]

/** 内置 id → 物品 */
const PROHIBITED_ITEM_MAP = new Map(BUILTIN_PROHIBITED_ITEMS.map((item) => [item.id, item]))

/** 默认勾选的检测物品（内置四项固定包含） */
export const DEFAULT_PROHIBITED_ITEMS = BUILTIN_PROHIBITED_ITEMS.map((item) => item.id)

function makeCustomItemId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `custom:${Date.now().toString(36)}${random}`
}

function normalizeLabelText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 判断一个标签是否与某个物品（含别名）匹配 */
export function labelMatchesItem(raw: string, item: ProhibitedItem): boolean {
  const normalized = normalizeLabelText(raw)
  if (!normalized) return false
  const candidates = [item.label, ...(item.aliases ?? [])]
  return candidates.some((candidate) => {
    const text = normalizeLabelText(candidate)
    return Boolean(text) && (normalized === text || normalized.includes(text) || text.includes(normalized))
  })
}

/**
 * 历史版本内置物品（已从固定清单移除）：
 * 仅用于让旧任务在"重新定位/重试"时还能显示正确中文类别，不参与新任务选择。
 */
const LEGACY_ITEM_LABELS: Record<string, string> = {
  tablet: '平板电脑',
  laptop: '笔记本电脑',
  camera: '相机',
  recorder: '录音设备',
  smartwatch: '智能手表',
  earphone: '耳机',
  other_device: '其他电子设备'
}

/** 合并内置 + 自定义物品为 Map；未知 id（历史任务）按 id 当作标签兜底 */
function resolveProhibitedItemMap(
  customItems: CustomProhibitedItem[] = []
): Map<string, ProhibitedItem> {
  const map = new Map<string, ProhibitedItem>(PROHIBITED_ITEM_MAP)
  for (const custom of customItems) {
    if (map.has(custom.id)) continue
    map.set(custom.id, { id: custom.id, label: custom.label, prompt: custom.label, aliases: [] })
  }
  return map
}

/** 按 id 列表解析出物品（未知 id 兜底成"id 作为标签"的临时项，兼容历史任务） */
export function resolveProhibitedItems(
  itemIds: string[] | undefined,
  customItems: CustomProhibitedItem[] = []
): ProhibitedItem[] {
  const map = resolveProhibitedItemMap(customItems)
  if (!itemIds) return [...map.values()]
  const result: ProhibitedItem[] = []
  const seen = new Set<string>()
  for (const id of itemIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const item = map.get(id)
    if (item) {
      result.push(item)
    } else {
      const legacyLabel = LEGACY_ITEM_LABELS[id]
      result.push({ id, label: legacyLabel ?? id, prompt: legacyLabel ?? id, aliases: [] })
    }
  }
  return result
}

export interface ItemMatch {
  itemId: string | null
  category: string
}

/**
 * 把模型给的标签映射回内置/自定义物品。
 *
 * - `itemIds` 省略表示在"内置 + 全部自定义"里匹配；
 * - 标签为空且只有一个候选时直接归给它；
 * - 对不上时保留原始标签（截断 24 字）且 itemId=null。
 */
export function matchItem(
  label: string,
  itemIds?: string[],
  customItems: CustomProhibitedItem[] = []
): ItemMatch {
  const raw = label.trim()
  const normalized = normalizeLabelText(raw)
  if (normalized) {
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

/** 把模型返回的任意标签映射成内置/自定义物品的标准中文名；对不上则保留原标签 */
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
    const normalizedLabel = normalizeLabelText(label)
    if (!normalizedLabel) continue
    // 与内置物品重名/别名冲突的直接丢弃
    if (BUILTIN_PROHIBITED_ITEMS.some((item) => labelMatchesItem(label, item))) continue
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
