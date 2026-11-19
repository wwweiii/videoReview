import { Loader2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ConnectionTestResult, PublicSettings } from '@shared/types'
import { BehaviorSettingsSection } from '../components/settings/BehaviorSettingsSection'
import { ItemSettingsSection } from '../components/settings/ItemSettingsSection'
import { ModelSection } from '../components/settings/ModelSection'
import { CallTraceDrawer } from '../components/settings/CallTraceDrawer'
import { SettingsNav, type SettingsSection } from '../components/settings/SettingsNav'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { friendlyError, type ShowToast } from '../lib/ui'
import { createSettingsAutosave, registerSettingsFlush, type SettingsSaveState } from '../lib/settings-autosave'

const IDLE_SAVE_STATE: SettingsSaveState = { status: 'idle' }

/**
 * App 保持本组件挂载，让草稿和保存队列跨页面存活。
 *
 * 页面结构为「顶部标题 + 横向二级菜单 + 子页卡片」：子页由 App 通过 section 控制，
 * 三张卡片共用同一个 useSettingsForm，因此切页不会丢失表单内容。
 */
export function SettingsPage({
  settings,
  section,
  visible,
  onSectionChange,
  onSaved,
  showToast
}: {
  settings: PublicSettings
  section: SettingsSection
  visible: boolean
  onSectionChange: (section: SettingsSection) => void
  onSaved: (settings: PublicSettings) => void
  showToast: ShowToast
}): JSX.Element {
  const form = useSettingsForm({ settings, showToast })

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const canViewTraces = section === 'model' && form.developerMode && form.traceEnabled
  const canViewTracesRef = useRef(canViewTraces)
  const formRef = useRef(form)
  const onSavedRef = useRef(onSaved)
  const showToastRef = useRef(showToast)
  const [saveState, setSaveState] = useState<SettingsSaveState>(IDLE_SAVE_STATE)
  const saving = saveState.status === 'pending' || saveState.status === 'saving'
  const visibleRef = useRef(visible)
  const saverRef = useRef<ReturnType<typeof createSettingsAutosave> | null>(null)

  formRef.current = form
  canViewTracesRef.current = canViewTraces
  onSavedRef.current = onSaved
  showToastRef.current = showToast

  const payloadKey = JSON.stringify(form.buildSavePayload())
  useEffect(() => {
    if (!canViewTraces) setTraceOpen(false)
  }, [canViewTraces])

  useLayoutEffect(() => {
    visibleRef.current = visible
    setSaveState((state) => state.status === 'saved' ? IDLE_SAVE_STATE : state)
  }, [visible, section])

  useEffect(() => {
    if (saveState.status !== 'saved') return
    const timer = setTimeout(() => {
      setSaveState((state) => state === saveState ? IDLE_SAVE_STATE : state)
    }, 2000)
    return () => clearTimeout(timer)
  }, [saveState])

  useLayoutEffect(() => {
    if (!saverRef.current) {
      saverRef.current = createSettingsAutosave({
        initial: formRef.current.buildSavePayload(),
        save: (input) => window.framelens.saveSettings(input),
        onState: (state) => {
          setSaveState(state.status === 'saved' && !visibleRef.current ? IDLE_SAVE_STATE : state)
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
    if (form.modelMode === 'custom' && form.developerMode && !form.validateExtraBody()) return
    setTesting(true)
    setTestResult(null)
    try {
      if (form.developerMode && form.traceEnabled && !(settings.developerMode && settings.traceEnabled)) {
        await saverRef.current?.flush().catch(() => undefined)
      }
      setTestResult(
        await window.framelens.testModel({
          modelMode: form.modelMode,
          developerMode: form.developerMode,
          traceEnabled: form.traceEnabled,
          customModel: form.buildCustomModel()
        })
      )
    } catch (error) {
      setTestResult({ ok: false, message: friendlyError(error) })
    } finally {
      setTesting(false)
    }
  }

  async function openTraces(): Promise<void> {
    try {
      saverRef.current?.update(formRef.current.buildSavePayload())
      await saverRef.current?.flush()
      if (canViewTracesRef.current) setTraceOpen(true)
    } catch (error) { showToast('error', friendlyError(error)) }
  }

  return (
    <div className="page settings-page">
      <header className="page-header settings-header">
        <div className="settings-heading">
          <h1 className="page-title">设置</h1>
          <SettingsNav section={section} onChange={onSectionChange} />
        </div>
        <div className="settings-save-state" role="status" aria-live="polite" data-status={saveState.status}>
          {saving ? (
            <>
              <Loader2 size={15} className="spin" aria-hidden="true" />
              <span>保存中</span>
            </>
          ) : null}
          {saveState.status === 'saved' ? <span>已保存</span> : null}
          {saveState.status === 'error' ? (
            <>
              <span>{saveState.message}</span>
              <button type="button" className="button button-secondary button-sm"
                onClick={() => { void saverRef.current?.flush().catch(() => undefined) }}>重试保存</button>
            </>
          ) : null}
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
            onOpenTraces={() => void openTraces()}
          />
        ) : null}
      </div>
      {canViewTraces && traceOpen ? <CallTraceDrawer onClose={() => setTraceOpen(false)} /> : null}
    </div>
  )
}
