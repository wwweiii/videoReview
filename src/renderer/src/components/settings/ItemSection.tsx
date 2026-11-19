import { Plus, X } from 'lucide-react'
import type { JSX } from 'react'
import type { SettingsForm } from '../../hooks/useSettingsForm'

/** 设置页「检测物品」：只显示已启用的物品，取消后移出列表，添加即启用。 */
export function ItemSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <div className="detect-block">
      <span className="field-title">检测物品</span>
      <div className="detect-list">
        {form.activeItems.map((item) => (
          <span key={item.id} className="detect-item">
            <span className="detect-item-label">{item.label}</span>
            <button
              type="button"
              className="detect-remove"
              aria-label={`取消物品 ${item.label}`}
              title="取消"
              onClick={() => form.removeItem(item.id)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="custom-item-row">
        <input
          aria-label="添加检测物品"
          value={form.customItemInput}
          placeholder="输入物品名称"
          onChange={(event) => form.setCustomItemInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              form.addCustomItems()
            }
          }}
        />
        <button
          type="button"
          className="button button-secondary"
          onClick={form.addCustomItems}
          disabled={!form.customItemInput.trim()}
        >
          <Plus size={15} />
          添加
        </button>
      </div>
    </div>
  )
}
