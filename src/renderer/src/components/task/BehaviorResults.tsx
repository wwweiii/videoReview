import { ChevronLeft, ChevronRight, Loader2, Play, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { behaviorTime } from '@shared/behavior'
import { countFrameStats, isTaskActive } from '@shared/task'
import type { BehaviorWindowRecord, TaskRecord, Verdict } from '@shared/types'
import { frameImageUrl } from '../../lib/ui'
import { VerdictBadge } from '../common/StatusBadge'

const PAGE_SIZE = 20

export function BehaviorResults({ task, onRefresh }: {
  task: TaskRecord
  onRefresh: () => Promise<void>
}): JSX.Element {
  const [filter, setFilter] = useState<'all' | Verdict>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number | null>(null)
  const windows = task.behaviorWindows ?? []
  const stats = countFrameStats(windows)
  useEffect(() => { setPage(1) }, [filter, query, task.id])
  const filtered = useMemo(() => windows.filter((window) => {
    if (filter !== 'all' && window.verdict !== filter) return false
    return [behaviorTime(window.timestampMs), behaviorTime(window.endTimestampMs),
      window.categories.join(' '), window.description, window.evidence, window.error]
      .join(' ').toLowerCase().includes(query.trim().toLowerCase())
  }), [windows, filter, query])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages)
  const tabs = [
    { key: 'all' as const, label: '全部', count: stats.total },
    { key: 'abnormal' as const, label: '异常', count: stats.abnormal },
    { key: 'review' as const, label: '待复核', count: stats.review },
    { key: 'normal' as const, label: '正常', count: stats.normal },
    { key: 'failed' as const, label: '失败', count: stats.failed }
  ]
  const selectedWindow = windows.find((window) => window.index === selected)
  return <>
    <section className="result-card">
      <div className="result-toolbar">
        <div className="filter-tabs">
          {tabs.map((tab) => <button type="button" key={tab.key}
            className={`filter-tab ${filter === tab.key ? 'is-active' : ''}`}
            onClick={() => setFilter(tab.key)}>{tab.label}<span>{tab.count}</span></button>)}
        </div>
        <div className="toolbar-end">
          <label className="search-field"><Search size={17} />
            <input aria-label="搜索行为片段" placeholder="搜索行为或时间" value={query}
              onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" className="icon-button" aria-label="刷新" onClick={() => void onRefresh()}>
            <RefreshCw size={17} />
          </button>
        </div>
      </div>
      {filtered.length === 0 ? <div className="empty-result">
        {isTaskActive(task.status) && windows.length === 0 ? <Loader2 size={24} className="spin" /> : null}
        <span>{isTaskActive(task.status) && windows.length === 0 ? '正在提取连续画面' : '暂无结果'}</span>
      </div> : <>
        <div className="frame-table-head behavior-columns"><span>片段时间</span><span>判定</span><span>行为情况</span><span>置信度</span></div>
        {filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((window) =>
          <button type="button" className="frame-row behavior-row behavior-columns" key={window.index}
            onClick={() => setSelected(window.index)} aria-label={`查看片段 ${behaviorTime(window.timestampMs)}`}>
            <span className="frame-time-cell behavior-time-cell">
              {window.fileName ? <img className="frame-thumb" loading="lazy" alt="片段预览"
                src={frameImageUrl(task.id, window.fileName, true)} /> : null}
              <span>{behaviorTime(window.timestampMs)}<br /><span className="behavior-time-end">至 {behaviorTime(window.endTimestampMs)}</span></span>
            </span>
            <span><VerdictBadge verdict={window.verdict} /></span>
            <span className="frame-desc">
              {window.categories.length > 0 ? <span className="category-chips">{window.categories.map((category) =>
                <span key={category} className="category-chip">{category}</span>)}</span> : null}
              <span className={window.error ? 'frame-error' : ''}>{window.error || window.description ||
                (window.verdict === 'normal' ? '未发现指定行为' : window.verdict === 'review' ? '请人工复核' : '等待识别')}</span>
            </span>
            <span className="frame-confidence">{window.confidence === null ? '—' : `${Math.round(window.confidence * 100)}%`}</span>
          </button>)}
        <div className="pagination"><span>第 {currentPage} / {pages} 页 · 共 {filtered.length} 个片段</span>
          <div className="pagination-actions">
            <button type="button" className="icon-button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></button>
            <button type="button" className="icon-button" aria-label="下一页" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></button>
          </div>
        </div>
      </>}
    </section>
    {selectedWindow ? <BehaviorPreview key={task.id} task={task} window={selectedWindow}
      onClose={() => setSelected(null)}
      onPrevious={selectedWindow.index > 0 ? () => setSelected(selectedWindow.index - 1) : undefined}
      onNext={selectedWindow.index < windows.length - 1 ? () => setSelected(selectedWindow.index + 1) : undefined} /> : null}
  </>
}

function BehaviorPreview({ task, window: segment, onClose, onPrevious, onNext }: {
  task: TaskRecord
  window: BehaviorWindowRecord
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}): JSX.Element {
  const player = useRef<HTMLVideoElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [videoError, setVideoError] = useState(false)
  const [sampleIndex, setSampleIndex] = useState(0)
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => previousFocus?.focus()
  }, [])
  useEffect(() => {
    setSampleIndex(0)
    const video = player.current
    if (video && video.readyState >= 1) {
      video.pause()
      video.currentTime = segment.timestampMs / 1000
    }
  }, [segment.index, segment.timestampMs])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrevious?.()
      if (event.key === 'ArrowRight') onNext?.()
      if (event.key === 'Tab') {
        const dialog = closeButton.current?.closest('[role="dialog"]')
        const focusable = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), video, [tabindex="0"]')
        if (!focusable?.length) return
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onPrevious, onNext])
  const sample = segment.samples[sampleIndex] ?? segment.samples[0]
  return <div className="drawer-backdrop" onClick={onClose}>
    <section className="drawer behavior-drawer" role="dialog" aria-modal="true" aria-labelledby="behavior-preview-title" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div className="drawer-head-title">
          <h2 id="behavior-preview-title">{behaviorTime(segment.timestampMs)} — {behaviorTime(segment.endTimestampMs)}</h2>
          <button type="button" className="button button-secondary button-sm drawer-head-nav" onClick={onPrevious} disabled={!onPrevious}>
            <ChevronLeft size={16} />上一片段
          </button>
        </div>
        <div className="drawer-head-actions">
          <button type="button" className="button button-secondary button-sm drawer-head-nav" onClick={onNext} disabled={!onNext}>
            下一片段<ChevronRight size={16} />
          </button>
          <button type="button" ref={closeButton} className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      <div className="drawer-body behavior-preview-body">
        {videoError ? <>
          <p className="behavior-playback-note">原视频暂时无法播放，可查看下方连续采样画面。请确认原文件仍在原位置且编码受支持。</p>
          {sample ? <img className="behavior-still" src={frameImageUrl(task.id, sample.fileName)} alt="选中的采样画面" /> : null}
        </> : <video ref={player} className="behavior-video" controls preload="metadata"
          src={`vr-media://video/${task.id}`} onError={() => setVideoError(true)}
          onLoadedMetadata={() => { if (player.current) player.current.currentTime = segment.timestampMs / 1000 }}
          onTimeUpdate={() => { if (player.current && !player.current.paused && player.current.currentTime >= segment.endTimestampMs / 1000) player.current.pause() }} />}
        <div className="behavior-preview-actions">
          <button type="button" className="button button-secondary" disabled={videoError} onClick={() => {
            const video = player.current
            if (video) { video.currentTime = segment.timestampMs / 1000; void video.play().catch(() => setVideoError(true)) }
          }}><Play size={16} />播放此片段</button>
          <span>{segment.samples.length} 张采样画面</span>
        </div>
        <div className="behavior-samples">{segment.samples.map((item, index) =>
          <button type="button" key={item.fileName} className={index === sampleIndex ? 'is-selected' : ''}
            onClick={() => { setSampleIndex(index); if (player.current) { player.current.pause(); player.current.currentTime = item.timestampMs / 1000 } }}>
            <img loading="lazy" src={frameImageUrl(task.id, item.fileName, true)} alt={`采样画面 ${index + 1}`} />
            <span>{behaviorTime(item.timestampMs)}</span>
          </button>)}</div>
        <div className="drawer-badges"><VerdictBadge verdict={segment.verdict} />
          <span className="drawer-confidence">模型置信度 {segment.confidence === null ? '—' : `${Math.round(segment.confidence * 100)}%`}</span>
        </div>
        {segment.categories.length > 0 ? <div className="category-chips drawer-categories">{segment.categories.map((category) => <span key={category} className="category-chip">{category}</span>)}</div> : null}
        <section className="drawer-section"><h3>行为说明</h3><p>{segment.description || (segment.verdict === 'normal' ? '未发现设置中的指定行为。' : '暂无说明')}</p></section>
        <section className="drawer-section"><h3>可见证据</h3><p>{segment.evidence || '暂无证据'}</p></section>
        {segment.error ? <p className="frame-error">{segment.error}</p> : null}
      </div>
    </section>
  </div>
}
