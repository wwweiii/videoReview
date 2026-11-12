import { Loader2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import type { ConnectionTestResult, PublicSettings } from '@shared/types'
import { AnalysisSection } from '../components/settings/AnalysisSection'
import { ModelSection } from '../components/settings/ModelSection'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { friendlyError, type ShowToast } from '../lib/ui'

/**
 * 设置页容器：持有表单状态（useSettingsForm）与保存/测试/探测三类网络动作，
 * 卡片 UI 拆到 components/settings/*。
 */
export function SettingsPage({
  settings,
  onSaved,
  showToast
}: {
  settings: PublicSettings
  onSaved: (settings: PublicSettings) => void
  showToast: ShowToast
}): JSX.Element {
  const form = useSettingsForm({ settings, showToast })

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)

  const canSave = (form.modelMode === 'preset' || form.customValid) && !saving

  async function save(): Promise<void> {
    if (!form.validateExtraBody()) return
    setSaving(true)
    try {
      const saved = await window.framelens.saveSettings(form.buildSavePayload())
      onSaved(saved)
      form.setApiKey('')
      form.setClearApiKey(false)
      setTestResult(null)
      showToast('success', '已保存')
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setSaving(false)
    }
  }

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
      <header className="page-header">
        <h1 className="page-title">设置</h1>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void save()}
          disabled={!canSave}
        >
          {saving ? <Loader2 size={17} className="spin" /> : null}
          保存
        </button>
      </header>

      <ModelSection
        form={form}
        presetAvailable={settings.presetAvailable}
        hasApiKey={settings.customModel.hasApiKey}
        testing={testing}
        testResult={testResult}
        onTest={() => void testConnection()}
      />

      <AnalysisSection form={form} />
    </div>
  )
}
