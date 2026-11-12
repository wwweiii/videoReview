import type { JSX } from 'react'
import { ANALYSIS_MODE_LABELS } from '@shared/task'
import type { AnalysisMode } from '@shared/types'
import type { SettingsForm } from '../../hooks/useSettingsForm'
import { ItemSection } from './ItemSection'
import { BehaviorSection } from './BehaviorSection'

/** 设置页「分析」卡片：抽帧间隔、发送方式、定位开关、每帧框数 + 检测物品 */
export function AnalysisSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>分析</h2>
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
        </div>

        {form.analysisMode === 'group' ? (
          <label className="form-field">
            <span>每组帧数</span>
            <div className="input-unit">
              <input
                type="number"
                min={2}
                max={8}
                value={form.groupSize}
                onChange={(event) => form.setGroupSize(Number(event.target.value) || 4)}
              />
              <span>帧</span>
            </div>
          </label>
        ) : null}

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

        <label className="form-field">
          <span>每帧最大框数</span>
          <div className="input-unit">
            <input
              type="number"
              min={1}
              max={20}
              value={form.maxBoxesPerFrame}
              disabled={!form.localize}
              onChange={(event) => form.setMaxBoxesPerFrame(Number(event.target.value) || 1)}
            />
            <span>个</span>
          </div>
        </label>
      </div>

      <ItemSection form={form} />
      <BehaviorSection form={form} />
    </section>
  )
}
