/**
 * 应用默认参数与界面可选值集合。
 *
 * 约定：主进程校验与渲染层表单共用这里的范围/默认值，避免两端各写一套。
 */

export const DEFAULT_CONCURRENCY = 2
export const DEFAULT_TIMEOUT_SEC = 120
export const DEFAULT_INTERVAL_SEC = 2
export const DEFAULT_GROUP_SIZE = 4
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6
export const DEFAULT_MAX_TOKENS = 1200
export const DEFAULT_IMAGE_MAX_EDGE = 1120
export const DEFAULT_LOCALIZE = true

/** 「定位图片长边」下拉可选值（0 = 自动 1120） */
export const IMAGE_MAX_EDGE_OPTIONS = [0, 896, 1120, 1280, 1600] as const

/** 「最大 token」输入框建议值 */
export const MAX_TOKENS_OPTIONS = [600, 1200, 2000, 3000, 4096] as const

/** 自定义违禁物数量上限 */
export const MAX_CUSTOM_PROHIBITED_ITEMS = 20

/** 自定义违禁物名称长度上限 */
export const MAX_CUSTOM_ITEM_LABEL_LENGTH = 12

/** 自定义行为数量与名称限制 */
export const MAX_BEHAVIOR_ITEMS = 20
export const MAX_BEHAVIOR_LABEL_LENGTH = 24

/** 分组发送时每组帧数范围 */
export const MIN_GROUP_SIZE = 2
export const MAX_GROUP_SIZE = 8

/** 行为识别采样默认值：2 秒窗口、每 2 秒推进、4 FPS */
export const DEFAULT_BEHAVIOR_WINDOW_SEC = 2
export const DEFAULT_BEHAVIOR_STRIDE_SEC = 2
export const DEFAULT_BEHAVIOR_FPS = 4

/** 行为识别采样可配置范围（窗口/推进按 0.5 秒步进，帧数为整数） */
export const MIN_BEHAVIOR_WINDOW_SEC = 0.5
export const MAX_BEHAVIOR_WINDOW_SEC = 10
export const MIN_BEHAVIOR_STRIDE_SEC = 0.5
export const MAX_BEHAVIOR_STRIDE_SEC = 10
export const MIN_BEHAVIOR_FPS = 1
export const MAX_BEHAVIOR_FPS = 10
