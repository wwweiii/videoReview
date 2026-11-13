import { Loader2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import type { ConnectionTestResult, PublicSettings } from '@shared/types'
import { BehaviorSettingsSection } from '../components/settings/BehaviorSettingsSection'
import { ItemSettingsSection } from '../components/settings/ItemSettingsSection'
import { ModelSection } from '../components/settings/ModelSection'
import { SettingsNav, type SettingsSection } from '../components/settings/SettingsNav'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { friendlyError, type ShowToast } from '../lib/ui'

/**
 * 设置页容器：持有表单状态（useSettingsForm）与保存/测试两类网络动作。
 *
 * 页面结构为「顶部标题 + 横向二级菜单 + 子页卡片」：子页由 App 通过 section 控制，
 * 三张卡片共用同一个 useSettingsForm，因此切页不会丢失未保存的表单内容。
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
      <header className="page-header settings-header">
        <div className="settings-heading">
          <h1 className="page-title">设置</h1>
          <SettingsNav section={section} onChange={onSectionChange} />
        </div>
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
