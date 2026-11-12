import type { JSX } from 'react'
import { formatTimeMs } from '@shared/format'
import type { FrameRecord, RegionRecord } from '@shared/types'
import { VerdictBadge } from '../common/StatusBadge'
import { boxLength, boxPercent } from '../../lib/region'
import { frameImageUrl, regionColor } from '../../lib/ui'

/** 结果列表单行：时间 + 缩略图 + 判定 + 异常情况 + 置信度 */
export function FrameRow({
  taskId,
  frame,
  onOpen
}: {
  taskId: string
  frame: FrameRecord
  onOpen: () => void
}): JSX.Element {
  return (
    <div className="frame-row" onClick={onOpen}>
      <div className="frame-time-cell">
        <div className="frame-thumb-wrap">
          <img
            className="frame-thumb"
            src={frameImageUrl(taskId, frame.fileName, true)}
            alt=""
            loading="lazy"
            draggable={false}
          />
          <FrameThumbRegions regions={frame.regions} />
        </div>
        <span>{formatTimeMs(frame.timestampMs)}</span>
      </div>
      <span>
        <VerdictBadge verdict={frame.verdict} />
      </span>
      <div className="frame-desc">
        {frame.categories.length > 0 ? (
          <div className="category-chips">
            {frame.categories.map((category) => (
              <span key={category} className="category-chip">
                {category}
              </span>
            ))}
          </div>
        ) : null}
        <span className={frame.status === 'failed' ? 'frame-error' : ''}>
          {frame.status === 'failed'
            ? frame.error || '识别失败'
            : frame.verdict === 'pending'
              ? '分析中'
              : frame.verdict === 'normal'
                ? '无'
                : frame.description || frame.evidence || '—'}
        </span>
      </div>
      <span className="frame-confidence">
        {frame.confidence === null ? '—' : `${Math.round(frame.confidence * 100)}%`}
      </span>
    </div>
  )
}

/** 结果列表缩略图上的迷你框：只示意“这一帧有目标”，不显示标签 */
function FrameThumbRegions({ regions }: { regions: RegionRecord[] }): JSX.Element | null {
  if (regions.length === 0) return null
  return (
    <span className="thumb-region-layer" aria-hidden="true">
      {regions.map((region) => (
        <span
          key={region.id}
          className={`thumb-region ${region.suspicious ? 'is-suspicious' : ''}`}
          style={{
            left: boxPercent(region.box[0]),
            top: boxPercent(region.box[1]),
            width: boxLength(region.box[0], region.box[2]),
            height: boxLength(region.box[1], region.box[3]),
            borderColor: regionColor(region.category)
          }}
        />
      ))}
    </span>
  )
}
