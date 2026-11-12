import { Plus, X } from 'lucide-react'
import type { JSX } from 'react'
import { MAX_BEHAVIOR_LABEL_LENGTH } from '@shared/defaults'
import type { SettingsForm } from '../../hooks/useSettingsForm'

/** 行为识别类别完全由用户设置，不提供内置行为。 */
export function BehaviorSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <div className="detect-block behavior-settings-block">
      <span className="field-title">识别行为</span>
      <div className="behavior-settings-list">
        {form.behaviorItems.map((item) => (
          <span key={item.id} className="behavior-settings-item">
            <span>{item.label}</span>
            <button
              type="button"
              className="detect-remove"
              aria-label={`删除行为 ${item.label}`}
              title="删除"
              onClick={() => form.removeBehaviorItem(item.id)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="custom-item-row">
        <input
          value={form.behaviorLabel}
          maxLength={MAX_BEHAVIOR_LABEL_LENGTH}
          placeholder={`添加行为（最多 ${MAX_BEHAVIOR_LABEL_LENGTH} 字，回车确认）`}
          onChange={(event) => form.setBehaviorLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              form.addBehaviorItem()
            }
          }}
        />
        <button
          type="button"
          className="button button-secondary"
          onClick={() => form.addBehaviorItem()}
          disabled={!form.behaviorLabel.trim()}
        >
          <Plus size={15} />
          添加
        </button>
      </div>
    </div>
  )
}
