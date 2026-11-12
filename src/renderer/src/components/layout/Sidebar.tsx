import { Activity, Clock3, House, Settings2 } from 'lucide-react'
import type { JSX } from 'react'

export type MainView = 'home' | 'tasks' | 'behavior-tasks' | 'settings'

export function Sidebar({
  active,
  onNavigate
}: {
  active: MainView
  onNavigate: (view: MainView) => void
}): JSX.Element {
  const mainItems = [
    { id: 'home' as const, label: '工作台', icon: House },
    { id: 'tasks' as const, label: '物品识别记录', icon: Clock3 },
    { id: 'behavior-tasks' as const, label: '行为识别记录', icon: Activity }
  ]

  return (
    <aside className="sidebar">
      <nav className="nav">
        {mainItems.map((item) => {
          const Icon = item.icon
          const selected = active === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${selected ? 'is-active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={`nav-item ${active === 'settings' ? 'is-active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <Settings2 size={20} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
