import { ChevronLeft, ChevronRight, ImageOff, Loader2, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { formatTimeMs } from '@shared/format'
import { isTaskActive } from '@shared/task'
import type { FrameStats } from '@shared/task'
import type { FrameRecord, TaskRecord } from '@shared/types'
import { FrameRow } from './FrameRow'

export type FrameFilterKey = 'all' | 'abnormal' | 'review' | 'normal' | 'failed'

const PAGE_SIZE = 20

/**
 * 结果卡片：筛选标签 / 搜索 / 刷新 / 帧行 / 分页。
 *
 * 筛选、搜索、页码状态内聚在表格里；任务切换时自动回到第一页。
 */
export function FrameTable({
  task,
  stats,
  onRefresh,
  onOpenFrame
}: {
  task: TaskRecord
  stats: FrameStats
  onRefresh: () => Promise<void>
  onOpenFrame: (frameIndex: number) => void
}): JSX.Element {
  const [filter, setFilter] = useState<FrameFilterKey>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const active = isTaskActive(task.status)

  useEffect(() => setPage(1), [filter, query, task.id])

  const filteredFrames = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return task.frames.filter((frame) => {
      if (filter === 'abnormal' && frame.verdict !== 'abnormal') return false
      if (filter === 'review' && frame.verdict !== 'review') return false
      if (filter === 'normal' && frame.verdict !== 'normal') return false
      if (filter === 'failed' && frame.status !== 'failed') return false
      if (!keyword) return true
      return [
        formatTimeMs(frame.timestampMs),
        frame.description,
        frame.evidence,
        frame.error,
        frame.categories.join(' ')
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [task, filter, query])

  const totalPages = Math.max(1, Math.ceil(filteredFrames.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageFrames: FrameRecord[] = filteredFrames.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  )

  const tabs: Array<{ key: FrameFilterKey; label: string; count: number }> = [
    { key: 'all', label: '全部', count: stats.total },
    { key: 'abnormal', label: '异常', count: stats.abnormal },
    { key: 'review', label: '待复核', count: stats.review },
    { key: 'normal', label: '正常', count: stats.normal },
    { key: 'failed', label: '失败', count: stats.failed }
  ]

  return (
    <section className="result-card">
      <div className="result-toolbar">
        <div className="filter-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`filter-tab ${filter === tab.key ? 'is-active' : ''}`}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-end">
          <label className="search-field">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索"
            />
          </label>
          <button
            type="button"
            className="icon-button"
            onClick={() => void onRefresh()}
            aria-label="刷新"
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      {task.frames.length === 0 ? (
        <div className="empty-result">
          {active ? <Loader2 size={24} className="spin" /> : <ImageOff size={24} />}
          <span>{active ? '正在处理' : '暂无结果'}</span>
        </div>
      ) : filteredFrames.length === 0 ? (
        <div className="empty-result">
          <span>暂无结果</span>
        </div>
      ) : (
        <>
          <div className="frame-table-head">
            <span>时间</span>
            <span>判定</span>
            <span>异常情况</span>
            <span>置信度</span>
          </div>
          {pageFrames.map((frame) => (
            <FrameRow
              key={frame.index}
              taskId={task.id}
              frame={frame}
              onOpen={() => onOpenFrame(frame.index)}
            />
          ))}
          <div className="pagination">
            <span>
              第 {safePage} / {totalPages} 页
            </span>
            <div className="pagination-actions">
              <button
                type="button"
                className="icon-button"
                disabled={safePage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                aria-label="上一页"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                aria-label="下一页"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
