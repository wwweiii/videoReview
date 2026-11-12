import type { JSX } from 'react'
import type { RegionRecord } from '@shared/types'
import { LABEL_FLIP_THRESHOLD, boxLength, boxPercent } from '../../lib/region'
import { regionColor } from '../../lib/ui'

/**
 * 帧预览上的检测框叠层：SVG 框 + 类别标签。
 *
 * 默认不画框——只渲染调用方筛出的 visibleRegions（悬浮/固定的目标）。
 * 只负责渲染，悬浮与固定状态由 FrameDrawer 维护。
 */
export function RegionOverlay({
  regions,
  pinnedRegionIds,
  hoverRegionId,
  onToggleRegion,
  onHoverRegion
}: {
  regions: RegionRecord[]
  pinnedRegionIds: string[]
  hoverRegionId: string | null
  onToggleRegion: (regionId: string) => void
  onHoverRegion: (regionId: string | null) => void
}): JSX.Element {
  return (
    <>
      <svg className="region-layer" aria-hidden="true">
        {regions.map((region) => {
          const color = regionColor(region.category)
          const isActive = pinnedRegionIds.includes(region.id) || hoverRegionId === region.id
          return (
            <rect
              key={region.id}
              className={[
                'region-rect',
                isActive ? 'is-active' : '',
                region.verified === false ? 'is-doubtful' : '',
                region.suspicious ? 'is-suspicious' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              x={boxPercent(region.box[0])}
              y={boxPercent(region.box[1])}
              width={boxLength(region.box[0], region.box[2])}
              height={boxLength(region.box[1], region.box[3])}
              style={{ stroke: color, fill: color }}
              vectorEffect="non-scaling-stroke"
              onMouseEnter={() => onHoverRegion(region.id)}
              onMouseLeave={() => onHoverRegion(null)}
              onClick={() => onToggleRegion(region.id)}
            >
              <title>{region.category}</title>
            </rect>
          )
        })}
      </svg>
      {regions.map((region) => (
        <span
          key={`${region.id}-label`}
          className={[
            'region-label',
            pinnedRegionIds.includes(region.id) || hoverRegionId === region.id ? 'is-active' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            left: boxPercent(region.box[0]),
            top: boxPercent(region.box[1]),
            backgroundColor: regionColor(region.category),
            // 贴顶时把标签翻到框内，避免被容器裁掉
            transform:
              region.box[1] < LABEL_FLIP_THRESHOLD ? 'translateY(0)' : 'translateY(-100%)'
          }}
        >
          {region.category}
        </span>
      ))}
    </>
  )
}
