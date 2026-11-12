import type { JSX } from 'react'
import {
  DEFAULT_BEHAVIOR_FPS,
  DEFAULT_BEHAVIOR_STRIDE_SEC,
  DEFAULT_BEHAVIOR_WINDOW_SEC,
  MAX_BEHAVIOR_FPS,
  MAX_BEHAVIOR_STRIDE_SEC,
  MAX_BEHAVIOR_WINDOW_SEC,
  MIN_BEHAVIOR_FPS,
  MIN_BEHAVIOR_STRIDE_SEC,
  MIN_BEHAVIOR_WINDOW_SEC
} from '@shared/defaults'
import type { SettingsForm } from '../../hooks/useSettingsForm'
import { BehaviorSection } from './BehaviorSection'

/** 设置页「行为识别」子页卡片：窗口/推进/每秒帧数采样参数 + 识别行为列表 */
export function BehaviorSettingsSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <section className="settings-card">
      <h2>行为识别</h2>
      <div className="form-grid">
        <label className="form-field">
          <span>窗口</span>
          <div className="input-unit">
            <input
              type="number"
              min={MIN_BEHAVIOR_WINDOW_SEC}
              max={MAX_BEHAVIOR_WINDOW_SEC}
              step={0.5}
              value={form.behaviorWindowSec}
              onChange={(event) =>
                form.setBehaviorWindowSec(Number(event.target.value) || DEFAULT_BEHAVIOR_WINDOW_SEC)
              }
            />
            <span>秒</span>
          </div>
        </label>

        <label className="form-field">
          <span>推进</span>
          <div className="input-unit">
            <input
              type="number"
              min={MIN_BEHAVIOR_STRIDE_SEC}
              max={MAX_BEHAVIOR_STRIDE_SEC}
              step={0.5}
              value={form.behaviorStrideSec}
              onChange={(event) =>
                form.setBehaviorStrideSec(Number(event.target.value) || DEFAULT_BEHAVIOR_STRIDE_SEC)
              }
            />
            <span>秒</span>
          </div>
        </label>

        <label className="form-field">
          <span>每秒帧数</span>
          <div className="input-unit">
            <input
              type="number"
              min={MIN_BEHAVIOR_FPS}
              max={MAX_BEHAVIOR_FPS}
              step={1}
              value={form.behaviorFps}
              onChange={(event) =>
                form.setBehaviorFps(Number(event.target.value) || DEFAULT_BEHAVIOR_FPS)
              }
            />
            <span>FPS</span>
          </div>
        </label>
      </div>

      <BehaviorSection form={form} />
    </section>
  )
}
