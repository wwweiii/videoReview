import type { PublicSettings, SaveSettingsInput } from '@shared/types'

type Section = NonNullable<SaveSettingsInput['section']>
export interface SettingsSaveState { status: 'saved' | 'pending' | 'saving' | 'error'; message: string }
const sections: Section[] = ['items', 'behavior', 'model']

function sectionKey(input: SaveSettingsInput, section: Section): string {
  if (section === 'model') return JSON.stringify([input.modelMode, input.developerMode, input.customModel, input.requestConcurrency])
  if (section === 'behavior') return JSON.stringify([
    input.behaviorItems, input.behaviorWindowSec, input.behaviorStrideSec, input.behaviorFps,
    input.behaviorImageScalePercent
  ])
  return JSON.stringify([
    input.intervalSec, input.prohibitedItems, input.customProhibitedItems,
    input.analysisMode, input.groupSize, input.localize, input.judgmentImage
  ])
}

/** 分区串行保存；失败保留待保存值，flush 会重试并等待最新版本。 */
export function createSettingsAutosave(options: {
  initial: SaveSettingsInput
  save: (input: SaveSettingsInput) => Promise<PublicSettings>
  onSaved: (settings: PublicSettings, input: SaveSettingsInput) => void
  onState: (state: SettingsSaveState) => void
}) {
  let current = options.initial
  const savedKeys = new Map(sections.map((section) => [section, sectionKey(current, section)]))
  let timer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> | null = null

  function dirtySections(): Section[] {
    return sections.filter((section) => savedKeys.get(section) !== sectionKey(current, section))
  }

  async function drain(): Promise<void> {
    options.onState({ status: 'saving', message: '正在保存…' })
    const failedKeys = new Map<Section, string>()
    const errors = new Map<Section, string>()
    while (true) {
      const section = dirtySections().find((item) => failedKeys.get(item) !== sectionKey(current, item))
      if (!section) break
      const snapshot = { ...current, section }
      const key = sectionKey(snapshot, section)
      try {
        const saved = await options.save(snapshot)
        savedKeys.set(section, key)
        errors.delete(section)
        options.onSaved(saved, snapshot)
      } catch (error) {
        failedKeys.set(section, key)
        errors.set(section, error instanceof Error ? error.message : String(error))
      }
    }
    const failed = dirtySections().map((section) => errors.get(section)).filter(Boolean)
    if (failed.length) {
      const message = failed.join('；')
      options.onState({ status: 'error', message: `保存失败：${message}` })
      throw new Error(message)
    }
    options.onState({ status: 'saved', message: '已保存' })
  }

  function flush(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (saving) return saving
    if (dirtySections().length === 0) {
      options.onState({ status: 'saved', message: '已保存' })
      return Promise.resolve()
    }
    saving = drain().finally(() => { saving = null })
    return saving
  }

  return {
    update(input: SaveSettingsInput): void {
      current = input
      clearTimeout(timer)
      if (dirtySections().length === 0) {
        if (!saving) options.onState({ status: 'saved', message: '已保存' })
        return
      }
      options.onState({ status: 'pending', message: '等待保存…' })
      timer = setTimeout(() => { void flush().catch(() => undefined) }, 300)
    },
    flush,
    dispose(): void { clearTimeout(timer) }
  }
}

// 设置页由 App 常驻，启动任务和关闭窗口共享同一个 flush 入口。
let flushHandler = (): Promise<void> => Promise.resolve()
export function registerSettingsFlush(handler: () => Promise<void>): () => void {
  flushHandler = handler
  return () => { if (flushHandler === handler) flushHandler = () => Promise.resolve() }
}
export function flushPendingSettings(): Promise<void> { return flushHandler() }
