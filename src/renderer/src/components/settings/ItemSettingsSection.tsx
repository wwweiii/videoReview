import type { JSX } from 'react'
import { ANALYSIS_MODE_LABELS } from '@shared/task'
import type { AnalysisMode } from '@shared/types'
import type { SettingsForm } from '../../hooks/useSettingsForm'
import { ItemSection } from './ItemSection'

/** 设置页「物品识别」子页卡片：抽帧间隔、发送方式（分组帧数内联）、定位开关 + 检测物品 */
export function ItemSettingsSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>物品识别</h2>
      <div className="form-grid">
        <label className="form-field">
          <span>抽帧间隔</span>
          <div className="input-unit">
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              value={form.intervalSec}
              onChange={(event) => form.setIntervalSec(Number(event.target.value) || 2)}
            />
            <span>秒</span>
          </div>
        </label>

        <div className="form-field">
          <span>发送方式</span>
          <div className="send-mode-row">
            <div className="segmented">
              {(['single', 'group'] as AnalysisMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={form.analysisMode === mode ? 'is-active' : ''}
                  onClick={() => form.setAnalysisMode(mode)}
                >
                  {ANALYSIS_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
            {/* 选择「分组」时，每组帧数直接跟在该按钮后面，不再单独占一行 */}
            {form.analysisMode === 'group' ? (
              <div className="send-group-size">
                <span>每组帧数</span>
                <input
                  type="number"
                  min={2}
                  max={8}
                  value={form.groupSize}
                  onChange={(event) => form.setGroupSize(Number(event.target.value) || 4)}
                />
                <span>帧</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="form-field">
          <span>标记违禁物位置</span>
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={form.localize}
              aria-label="标记违禁物位置"
              className={`switch ${form.localize ? 'is-on' : ''}`}
              onClick={() => form.setLocalize((value) => !value)}
            >
              <span className="switch-thumb" />
            </button>
          </div>
        </div>
      </div>

      <ItemSection form={form} />
    </section>
  )
}
