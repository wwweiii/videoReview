import { useEffect, useRef, useState, type JSX } from 'react'
import type { ConnectionTestResult, PublicSettings } from '@shared/types'
import { BehaviorSettingsSection } from '../components/settings/BehaviorSettingsSection'
import { ItemSettingsSection } from '../components/settings/ItemSettingsSection'
import { ModelSection } from '../components/settings/ModelSection'
import { SettingsNav, type SettingsSection } from '../components/settings/SettingsNav'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { friendlyError, type ShowToast } from '../lib/ui'

/**
 * 设置页容器：持有表单状态（useSettingsForm）与自动保存/测试两类网络动作。
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
  const initialPayloadKeyRef = useRef<string | null>(null)
  const saveVersionRef = useRef(0)
  const skipPayloadKeyRef = useRef<string | null>(null)

  formRef.current = form
  onSavedRef.current = onSaved
  showToastRef.current = showToast

  const payloadKey = JSON.stringify(form.buildSavePayload())

  useEffect(() => {
    if (initialPayloadKeyRef.current === null) {
      initialPayloadKeyRef.current = payloadKey
      return
    }

    if (skipPayloadKeyRef.current === payloadKey) {
      skipPayloadKeyRef.current = null
      initialPayloadKeyRef.current = payloadKey
      return
    }

    if (payloadKey === initialPayloadKeyRef.current) return
    initialPayloadKeyRef.current = payloadKey
    const changeId = ++saveVersionRef.current

    const timer = window.setTimeout(() => {
      const currentForm = formRef.current
      if (currentForm.modelMode === 'custom' && !currentForm.customValid) {
        return
      }
      if (!currentForm.validateExtraBody()) {
        return
      }

      void window.framelens
        .saveSettings(currentForm.buildSavePayload())
        .then((saved) => {
          if (changeId !== saveVersionRef.current) return
          onSavedRef.current(saved)
          if (formRef.current.apiKey) {
            const payloadWithoutApiKey = formRef.current.buildSavePayload()
            payloadWithoutApiKey.customModel.apiKey = undefined
            skipPayloadKeyRef.current = JSON.stringify(payloadWithoutApiKey)
            formRef.current.setApiKey('')
          }
          setTestResult(null)
        })
        .catch((error) => {
          if (changeId === saveVersionRef.current) {
            showToastRef.current('error', friendlyError(error))
          }
        })
    }, 300)

    return () => window.clearTimeout(timer)
  }, [payloadKey])

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
