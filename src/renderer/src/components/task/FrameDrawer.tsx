import { ChevronLeft, ChevronRight, ImageOff, Loader2, X } from 'lucide-react'
import { useEffect, useState, type JSX } from 'react'
import { formatTimeMs } from '@shared/format'
import type { FrameRecord, TaskRecord } from '@shared/types'
import { VerdictBadge } from '../common/StatusBadge'
import { regionNotice, regionNoticeTone } from '../../lib/region'
import { frameImageUrl } from '../../lib/ui'
import { RegionList } from './RegionList'
import { RegionOverlay } from './RegionOverlay'

/**
 * 帧详情抽屉：预览图 + 检测框叠层 + 检测对象列表 + 结论/证据。
 *
 * 交互约定（保持不变）：默认不画框，悬浮检测对象/列表项才显示；
 * 点击可固定多个目标；ESC 关闭与左右切帧由父级 TaskDetailPage 统一监听。
 */
export function FrameDrawer({
  task,
  frame,
  position,
  onClose,
  onPrevious,
  onNext
}: {
  task: TaskRecord
  frame: FrameRecord
  position: number
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
}): JSX.Element {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  // 允许同时固定多个检测对象
  const [pinnedRegionIds, setPinnedRegionIds] = useState<string[]>([])
  const [hoverRegionId, setHoverRegionId] = useState<string | null>(null)

  useEffect(() => {
    setImageLoaded(false)
    setImageError(false)
    setPinnedRegionIds([])
    setHoverRegionId(null)
  }, [frame.fileName])

  const regions = frame.regions
  const notice = regions.length === 0 ? regionNotice(frame) : null
  const showDetails =
    frame.status === 'completed' && frame.verdict !== 'normal' && frame.verdict !== 'pending'

  // 默认不在画面上画框：只有"悬浮在检测对象上"或"点击固定"的目标才显示
  const visibleRegionIds = new Set<string>(pinnedRegionIds)
  if (hoverRegionId) visibleRegionIds.add(hoverRegionId)
  const visibleRegions = regions.filter((region) => visibleRegionIds.has(region.id))

  function toggleRegion(regionId: string): void {
    setPinnedRegionIds((previous) =>
      previous.includes(regionId)
        ? previous.filter((id) => id !== regionId)
        : [...previous, regionId]
    )
  }

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div className="drawer-head-title">
            <h2>{formatTimeMs(frame.timestampMs)}</h2>
            <button
              type="button"
              className="button button-secondary button-sm drawer-head-nav"
              onClick={onPrevious}
              disabled={position <= 0}
            >
              <ChevronLeft size={16} />
              上一帧
            </button>
          </div>
          <div className="drawer-head-actions">
            <button
              type="button"
              className="button button-secondary button-sm drawer-head-nav"
              onClick={onNext}
              disabled={position >= task.frames.length - 1}
            >
              下一帧
              <ChevronRight size={16} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
              <X size={19} />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          <div className="drawer-image-wrap frame-viewport">
            {!imageLoaded && !imageError ? (
              <div className="image-state">
                <Loader2 size={22} className="spin" />
              </div>
            ) : null}
            {imageError ? (
              <div className="image-state">
                <ImageOff size={22} />
              </div>
            ) : (
              <div className="frame-stage">
                <img
                  className={`frame-stage-image ${imageLoaded ? 'is-loaded' : ''}`}
                  src={frameImageUrl(task.id, frame.fileName, false)}
                  alt=""
                  onLoad={() => setImageLoaded(true)}
                  onError={() => setImageError(true)}
                />
                {imageLoaded && visibleRegions.length > 0 ? (
                  <RegionOverlay
                    regions={visibleRegions}
                    pinnedRegionIds={pinnedRegionIds}
                    hoverRegionId={hoverRegionId}
                    onToggleRegion={toggleRegion}
                    onHoverRegion={setHoverRegionId}
                  />
                ) : null}
              </div>
            )}
          </div>

          <div className="drawer-badges">
            <VerdictBadge verdict={frame.verdict} />
            <span className="drawer-confidence">
              {frame.confidence === null ? '—' : `${Math.round(frame.confidence * 100)}%`}
            </span>
            <span className="drawer-position">
              {position + 1} / {task.frames.length}
            </span>
          </div>

          {frame.categories.length > 0 ? (
            <div className="category-chips drawer-categories">
              {frame.categories.map((category) => (
                <span key={category} className="category-chip">
                  {category}
                </span>
              ))}
            </div>
          ) : null}

          {regions.length > 0 ? (
            <RegionList
              regions={regions}
              pinnedRegionIds={pinnedRegionIds}
              onToggleRegion={toggleRegion}
              onHoverRegion={setHoverRegionId}
            />
          ) : notice ? (
            <p className={`region-notice ${regionNoticeTone(frame)}`}>{notice}</p>
          ) : null}

          {frame.status === 'failed' ? (
            <p className="drawer-error">{frame.error || '识别失败'}</p>
          ) : showDetails ? (
            <>
              <section className="drawer-section">
                <h3>说明</h3>
                <p>{frame.description || '—'}</p>
              </section>
              <section className="drawer-section">
                <h3>证据</h3>
                <p>{frame.evidence || '—'}</p>
              </section>
            </>
          ) : (
            <p className="drawer-normal">{frame.verdict === 'normal' ? '无异常' : '分析中'}</p>
          )}
        </div>
      </aside>
    </div>
  )
}
