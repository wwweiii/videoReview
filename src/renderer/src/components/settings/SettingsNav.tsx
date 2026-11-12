import { Activity, Cpu, ScanSearch, type LucideIcon } from 'lucide-react'
import type { JSX } from 'react'

/** 设置页三个子页的标识；顺序即二级菜单展示顺序（物品识别 → 行为识别 → 模型配置）。 */
export type SettingsSection = 'items' | 'behavior' | 'model'

const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: 'items', label: '物品识别', icon: ScanSearch },
  { id: 'behavior', label: '行为识别', icon: Activity },
  { id: 'model', label: '模型配置', icon: Cpu }
]

/** 设置页二级菜单：竖排三个子页按钮，当前项用 is-active 与 aria-current 标记。 */
export function SettingsNav({
  section,
  onChange
}: {
  section: SettingsSection
  onChange: (section: SettingsSection) => void
}): JSX.Element {
  return (
    <nav className="settings-nav" aria-label="设置子页">
      {SETTINGS_SECTIONS.map((entry) => {
        const Icon = entry.icon
        const selected = section === entry.id
        return (
          <button
            key={entry.id}
            type="button"
            className={`settings-nav-item ${selected ? 'is-active' : ''}`}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(entry.id)}
          >
            <Icon size={18} />
            <span>{entry.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
