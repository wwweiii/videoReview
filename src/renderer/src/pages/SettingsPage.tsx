import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ConnectionTestResult, PublicSettings } from '@shared/types'
import { BehaviorSettingsSection } from '../components/settings/BehaviorSettingsSection'
import { ItemSettingsSection } from '../components/settings/ItemSettingsSection'
import { ModelSection } from '../components/settings/ModelSection'
import { SettingsNav, type SettingsSection } from '../components/settings/SettingsNav'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { friendlyError, type ShowToast } from '../lib/ui'
import { createSettingsAutosave, registerSettingsFlush, type SettingsSaveState } from '../lib/settings-autosave'

/**
 * App 保持本组件挂载，让草稿和保存队列跨页面存活。
 *
 * 页面结构为「顶部标题 + 横向二级菜单 + 子页卡片」：子页由 App 通过 section 控制，
 * 三张卡片共用同一个 useSettingsForm，因此切页不会丢失表单内容。
 */
export function SettingsPage({
  settings,
  section,
  onSectionChange,
  onSaved,
  showToast
}: {
  settings: PublicSettings
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  onSaved: (settings: PublicSettings) => void
  showToast: ShowToast
}): JSX.Element {
  const form = useSettingsForm({ settings, showToast })

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const formRef = useRef(form)
  const onSavedRef = useRef(onSaved)
  const showToastRef = useRef(showToast)
  const [saveState, setSaveState] = useState<SettingsSaveState>({ status: 'saved', message: '已保存' })
  const saverRef = useRef<ReturnType<typeof createSettingsAutosave> | null>(null)

  formRef.current = form
  onSavedRef.current = onSaved
  showToastRef.current = showToast

  const payloadKey = JSON.stringify(form.buildSavePayload())

  useLayoutEffect(() => {
    if (!saverRef.current) {
      saverRef.current = createSettingsAutosave({
        initial: formRef.current.buildSavePayload(),
        save: (input) => window.framelens.saveSettings(input),
        onState: (state) => {
          setSaveState(state)
          if (state.status === 'error') showToastRef.current('error', friendlyError(state.message))
        },
        onSaved: (saved, input) => {
          onSavedRef.current(saved)
          if (input.section === 'model' && input.customModel.apiKey &&
              formRef.current.apiKey.trim() === input.customModel.apiKey) formRef.current.setApiKey('')
          setTestResult(null)
        }
      })
    } else {
      saverRef.current.update(formRef.current.buildSavePayload())
    }
  }, [payloadKey])

  useEffect(() => {
    const unregister = registerSettingsFlush(async () => {
      saverRef.current?.update(formRef.current.buildSavePayload())
      await saverRef.current?.flush()
    })
    return () => { unregister(); saverRef.current?.dispose() }
  }, [])

  async function testConnection(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(
        await window.framelens.testModel({
          modelMode: form.modelMode,
          customModel: form.buildCustomModel()
        })
      )
    } catch (error) {
      setTestResult({ ok: false, message: friendlyError(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-header settings-header">
        <div className="settings-heading">
          <h1 className="page-title">设置</h1>
          <SettingsNav section={section} onChange={onSectionChange} />
        </div>
        <div className="settings-save-state" role="status" aria-live="polite" data-status={saveState.status}>
          <span>{saveState.message}</span>
          {saveState.status === 'error' ? <button type="button" className="button button-secondary button-sm"
            onClick={() => { void saverRef.current?.flush().catch(() => undefined) }}>重试保存</button> : null}
        </div>
      </header>

      <div className="settings-content">
        {section === 'items' ? <ItemSettingsSection form={form} /> : null}

        {section === 'behavior' ? <BehaviorSettingsSection form={form} /> : null}

        {section === 'model' ? (
          <ModelSection
            form={form}
            presetAvailable={settings.presetAvailable}
            hasApiKey={settings.customModel.hasApiKey}
            testing={testing}
            testResult={testResult}
            onTest={() => void testConnection()}
          />
        ) : null}
      </div>
    </div>
  )
}
