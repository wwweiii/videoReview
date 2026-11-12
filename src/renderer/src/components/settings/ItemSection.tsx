import { Check, Lock, Plus, X } from 'lucide-react'
import type { JSX } from 'react'
import { MAX_CUSTOM_ITEM_LABEL_LENGTH } from '@shared/defaults'
import { BUILTIN_PROHIBITED_ITEMS } from '@shared/items'
import type { SettingsForm } from '../../hooks/useSettingsForm'

/** 设置页「检测物品」：内置固定项 + 自定义项（可勾选/删除）+ 添加输入行 */
export function ItemSection({ form }: { form: SettingsForm }): JSX.Element {
  return (
    <div className="detect-block">
      <span className="field-title">检测物品</span>
      <div className="detect-list">
        {BUILTIN_PROHIBITED_ITEMS.map((item) => (
          <span
            key={item.id}
            className="detect-item is-checked is-fixed"
            title="内置物品，固定检测，不可删除"
          >
            <span className="check-box">
              <Check size={13} />
            </span>
            {item.label}
            <Lock size={12} className="detect-lock" />
          </span>
        ))}
        {form.customItems.map((item) => {
          const checked = form.items.includes(item.id)
          return (
            <span
              key={item.id}
              className={`detect-item detect-item-custom ${checked ? 'is-checked' : ''}`}
            >
              <button
                type="button"
                className="detect-toggle"
                role="checkbox"
                aria-checked={checked}
                onClick={() => form.toggleCustomItem(item.id)}
              >
                <span className="check-box">{checked ? <Check size={13} /> : null}</span>
                {item.label}
              </button>
              <button
                type="button"
                className="detect-remove"
                aria-label={`删除自定义物品 ${item.label}`}
                title="删除"
                onClick={() => form.removeCustomItem(item.id)}
              >
                <X size={12} />
              </button>
            </span>
          )
        })}
      </div>
      <div className="custom-item-row">
        <input
          value={form.customItemLabel}
          maxLength={MAX_CUSTOM_ITEM_LABEL_LENGTH}
          placeholder={`添加自定义违禁物（最多 ${MAX_CUSTOM_ITEM_LABEL_LENGTH} 字，回车确认）`}
          onChange={(event) => form.setCustomItemLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              form.addCustomItem()
            }
          }}
        />
        <button
          type="button"
          className="button button-secondary"
          onClick={() => form.addCustomItem()}
          disabled={!form.customItemLabel.trim()}
        >
          <Plus size={15} />
          添加
        </button>
      </div>
    </div>
  )
}
