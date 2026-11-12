import type { JSX } from 'react'
import type { RegionRecord } from '@shared/types'
import { regionColor } from '../../lib/ui'

/** 抽屉正文「检测对象」列表：点击固定/取消固定，悬浮联动画面上的框 */
export function RegionList({
  regions,
  pinnedRegionIds,
  onToggleRegion,
  onHoverRegion
}: {
  regions: RegionRecord[]
  pinnedRegionIds: string[]
  onToggleRegion: (regionId: string) => void
  onHoverRegion: (regionId: string | null) => void
}): JSX.Element {
  return (
    <section className="drawer-section region-list">
      <h3>检测对象</h3>
      <ul className="region-items">
        {regions.map((region) => {
          const isActive = pinnedRegionIds.includes(region.id)
          return (
            <li key={region.id}>
              <button
                type="button"
                className={`region-item ${isActive ? 'is-active' : ''}`}
                onClick={() => onToggleRegion(region.id)}
                onMouseEnter={() => onHoverRegion(region.id)}
                onMouseLeave={() => onHoverRegion(null)}
                aria-pressed={isActive}
              >
                <span
                  className="region-dot"
                  style={{ backgroundColor: regionColor(region.category) }}
                />
                <span className="region-item-name">{region.category}</span>
                {region.suspicious ? <span className="region-item-flag">未标定</span> : null}
                {region.verified === false ? (
                  <span className="region-item-flag is-doubt">存疑</span>
                ) : null}
                <span className="region-item-confidence">
                  {region.confidence === null ? '—' : `${Math.round(region.confidence * 100)}%`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
