import type { BoxOrder, CoordinateSpace, ParseDialect } from './localization/profile'
import type { AnalysisMode, BehaviorItem, CustomProhibitedItem, ModelMode, ProhibitedItem } from './types'

/**
 * 设置页初始默认值的统一入口，可直接在本文件调试。
 *
 * 已保存的 data/settings.json 优先；内置 preset.enc 可覆盖部分初始参数。
 * 验证全新启动的默认值时，先备份并移走 settings.json，再重启应用。
 * 下方数值仍受配置页的范围校验约束。
 */

// 模型配置
/** 设置页「模型配置」→「预设 / 自定义」：auto 自动选择；custom 自定义；preset 预设（缺失时回退自定义）。 */
export const DEFAULT_MODEL_MODE: ModelMode | 'auto' = 'auto'
/** 设置页「模型配置」→「请求上限」：并发数，1–8。 */
export const DEFAULT_CONCURRENCY = 4
/** 设置页「模型配置」→「开发者模式」：true 开启，false 关闭。 */
export const DEFAULT_DEVELOPER_MODE = false

/** 自定义模型连接参数；密钥会随共享代码打包，正式密钥建议在设置页填写。 */
export const DEFAULT_CUSTOM_MODEL = {
  /** 设置页「模型配置」→「自定义」→「接口地址」。 */
  baseUrl: 'http://10.100.179.15/qwen36/v1',
  /** 设置页「模型配置」→「自定义」→「模型名称」。 */
  model: 'qwen3.6',
  /** 设置页「模型配置」→「自定义」→「密钥」：输入框不回显初始密钥，已有密钥时提示「已保存」。 */
  apiKey: '123',
  /** 配置页未显示：请求超时，单位为秒。 */
  timeoutSec: 120,
  /** 配置页未显示：额外请求头。 */
  extraHeaders: ''
}
/** 配置页未显示：请求超时默认值，引用上方 timeoutSec。 */
export const DEFAULT_TIMEOUT_SEC = DEFAULT_CUSTOM_MODEL.timeoutSec

/** 开发者配置的初始值；仅在开启开发者模式后参与实际请求。 */
export const DEFAULT_MODEL_RUNTIME: {
  extraBody: string
  coordinateSpaceOverride: 'auto' | CoordinateSpace
  boxOrderOverride: 'auto' | BoxOrder
  parseDialectOverride: 'auto' | ParseDialect
} = {
  /** 设置页「模型配置」→「额外请求体（JSON 对象）」：自定义且开启开发者模式时显示。 */
  extraBody: '',
  /** 设置页「模型配置」→「坐标空间」：auto 对应「自动探测」，自定义且开启开发者模式时显示。 */
  coordinateSpaceOverride: 'auto',
  /** 设置页「模型配置」→「轴序」：auto 对应「自动探测」，自定义且开启开发者模式时显示。 */
  boxOrderOverride: 'auto',
  /** 配置页未显示：解析方言覆盖，仅在开启开发者模式后生效。 */
  parseDialectOverride: 'auto'
}

// 物品识别
/** 设置页「物品识别」→「抽帧间隔」：单位为秒，0.5–60。 */
export const DEFAULT_INTERVAL_SEC = 2
/** 设置页「物品识别」→「发送方式」：single 对应「逐帧」，group 对应「分组」。 */
export const DEFAULT_ANALYSIS_MODE: AnalysisMode = 'single'
/** 设置页「物品识别」→「每组帧数」：选择「分组」时显示，2–8 帧。 */
export const DEFAULT_GROUP_SIZE = 4
/** 配置页未显示：判定置信度阈值，0–1。 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6
/** 设置页「物品识别」→「标记违禁物位置」：true 开启，false 关闭。 */
export const DEFAULT_LOCALIZE = true
/** 设置页「物品识别」→「图片缩放比例」：物品判定与定位共用，宽、高百分比为 1–100。 */
export const DEFAULT_ITEM_IMAGE_SCALE_PERCENT = 100

/**
 * 设置页「物品识别」→「检测物品」中的预设项，显示即启用，点击取消后移出列表。
 * label 为页面显示文字，也直接作为物品提示词；id 为内部标识。
 */
export const BUILTIN_PROHIBITED_ITEMS: ProhibitedItem[] = [
  { id: 'phone', label: '手机' },
  { id: 'mineral_water', label: '矿泉水' },
  { id: 'work_badge', label: '工作牌' },
  { id: 'gel_pen', label: '中性笔' },
  { id: 'pencil', label: '铅笔' },
  { id: 'thermos', label: '保温杯' },
  { id: 'notebook', label: '笔记本' },
  { id: 'key', label: '钥匙' },
  { id: 'clip', label: '夹子' },
  { id: 'paper_clip', label: '回形针' },
  { id: 'toothpick', label: '牙签' },
  { id: 'staple', label: '订书针' },
  { id: 'earphone', label: '耳机' },
  { id: 'disposable_chopsticks', label: '一次性筷子' },
  { id: 'stainless_steel_tool', label: '不锈钢工具' },
  { id: 'watch', label: '手表' },
  { id: 'data_cable', label: '数据线' },
  { id: 'air_conditioner_remote', label: '空调遥控器' }
].map((item) => ({ ...item, prompt: item.label, aliases: [item.id] }))
/** 设置页「物品识别」→「检测物品」：初始显示并启用的预设项 id，取消后可输入名称重新添加。 */
export const DEFAULT_PROHIBITED_ITEMS = BUILTIN_PROHIBITED_ITEMS.map((item) => item.id)

/** 设置页「物品识别」→「检测物品」中的初始自定义项，全部显示并启用：例如 [{ id: 'custom:camera', label: '相机' }]。 */
export const DEFAULT_CUSTOM_PROHIBITED_ITEMS: CustomProhibitedItem[] = []

// 行为识别
/** 设置页「行为识别」→「识别行为」：例如 [{ id: 'behavior:sign', label: '手写签字' }]，label 为显示文字。 */
export const DEFAULT_BEHAVIOR_ITEMS: BehaviorItem[] = []
/** 设置页「行为识别」→「窗口」：单位为秒，步进 0.5。 */
export const DEFAULT_BEHAVIOR_WINDOW_SEC = 2
/** 设置页「行为识别」→「推进」：单位为秒，步进 0.5。 */
export const DEFAULT_BEHAVIOR_STRIDE_SEC = 2
/** 设置页「行为识别」→「每秒帧数」：单位为 FPS，取整数。 */
export const DEFAULT_BEHAVIOR_FPS = 4
/** 设置页「行为识别」→「图片缩放比例」：行为图片宽、高百分比为 1–100。 */
export const DEFAULT_BEHAVIOR_IMAGE_SCALE_PERCENT = 100

// 校验范围与数量限制（以下不是初始默认值）

/** 自定义违禁物数量上限 */
export const MAX_CUSTOM_PROHIBITED_ITEMS = 30

/** 自定义违禁物名称长度上限 */
export const MAX_CUSTOM_ITEM_LABEL_LENGTH = 12

/** 自定义行为数量与名称限制 */
export const MAX_BEHAVIOR_ITEMS = 20
export const MAX_BEHAVIOR_LABEL_LENGTH = 24

/** 分组发送时每组帧数范围 */
export const MIN_GROUP_SIZE = 2
export const MAX_GROUP_SIZE = 8

/** 行为识别采样可配置范围（窗口/推进按 0.5 秒步进，帧数为整数） */
export const MIN_BEHAVIOR_WINDOW_SEC = 0.5
export const MAX_BEHAVIOR_WINDOW_SEC = 10
export const MIN_BEHAVIOR_STRIDE_SEC = 0.5
export const MAX_BEHAVIOR_STRIDE_SEC = 10
export const MIN_BEHAVIOR_FPS = 1
export const MAX_BEHAVIOR_FPS = 10
