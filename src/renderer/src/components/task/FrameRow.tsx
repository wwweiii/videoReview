import type { JSX } from 'react'
import { formatTimeMs } from '@shared/format'
import type { FrameRecord } from '@shared/types'
import { VerdictBadge } from '../common/StatusBadge'
import { frameImageUrl } from '../../lib/ui'

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
