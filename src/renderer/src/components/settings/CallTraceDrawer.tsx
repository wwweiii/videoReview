import { ChevronRight, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { ModelCallTraceRecord, ModelCallTraceSummary } from '@shared/types'

function prettyRaw(raw: string): string {
  if (!raw) return '—'
  try { return JSON.stringify(JSON.parse(raw) as unknown, null, 2) }
  catch { return raw }
}

function tokenText(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

function TraceDetail({ id }: { id: string }): JSX.Element {
  const [trace, setTrace] = useState<ModelCallTraceRecord | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void window.framelens.getModelCallTrace(id).then((detail) => {
      if (!cancelled) setTrace(detail)
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [id])
  if (error) return <p role="alert" className="call-trace-error">{error}</p>
  if (!trace) return <p role="status">正在读取调用详情…</p>
  return <div className="call-trace-detail">
    <div className="call-trace-meta">
      <span>排队 {trace.queueMs ?? 0} ms</span>
      {trace.requestBytes !== undefined ? <span>请求 {(trace.requestBytes / 1024).toFixed(1)} KB</span> : null}
      <span>输入 token {tokenText(trace.promptTokens)}</span>
      <span>输出 token {tokenText(trace.completionTokens)}</span>
      <span>总 token {tokenText(trace.totalTokens)}</span>
      <span>{trace.endpoint}</span>
    </div>
    {trace.error ? <p className="call-trace-error">{trace.error}</p> : null}
    <div className="call-trace-block"><h3>输入结构（图片显示摘要）</h3><pre>{prettyRaw(trace.requestBody)}</pre></div>
    <div className="call-trace-block"><h3>输出原始结构</h3><pre>{prettyRaw(trace.responseBody)}</pre></div>
  </div>
}

function CallTraceDetailDrawer({ summary, onClose }: {
  summary: ModelCallTraceSummary
  onClose: () => void
}): JSX.Element {
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => previousFocus?.focus({ preventScroll: true })
  }, [])
  return <div className="drawer-backdrop call-trace-detail-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <aside className="drawer call-trace-detail-drawer" role="dialog" aria-modal="true" aria-labelledby="call-trace-detail-title">
      <header className="drawer-head">
        <h2 id="call-trace-detail-title">调用详情</h2>
        <button type="button" ref={closeButton} className="icon-button" aria-label="关闭调用详情" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="drawer-body call-trace-detail-body">
        <div className="call-trace-item-head"><strong>{summary.operation || '模型调用'}</strong>
          <span>{summary.error ? '失败' : '完成'} · {summary.status ?? '无响应'} · {summary.latencyMs.toLocaleString()} ms</span>
        </div>
        <div className="call-trace-meta">
          <span>{new Date(summary.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
          <span>{summary.model || '未记录模型'}</span>
          <span>{summary.taskName || (summary.taskId ? `任务 ${summary.taskId.slice(0, 8)}` : '模型配置')}</span>
        </div>
        <TraceDetail id={summary.id} />
      </div>
    </aside>
  </div>
}

export function CallTraceDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const [traces, setTraces] = useState<ModelCallTraceSummary[]>([])
  const [total, setTotal] = useState(0)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [selected, setSelected] = useState<ModelCallTraceSummary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const requestVersion = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)

  const load = useCallback(async (before?: string): Promise<void> => {
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    try {
      const page = await window.framelens.listModelCallTraces(before)
      if (version !== requestVersion.current) return
      setTraces((previous) => before ? [...new Map([...previous, ...page.items].map((trace) => [trace.id, trace])).values()] : page.items)
      setTotal(page.total)
      setNextBefore(page.nextBefore)
      if (!before) setSelected(null)
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (version === requestVersion.current) setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    return () => { requestVersion.current++ }
  }, [load])
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => previousFocus?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (selected) setSelected(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, selected])

  return <><div className="drawer-backdrop call-trace-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <aside className="drawer call-trace-drawer" role="dialog" aria-modal={selected ? undefined : true}
      aria-hidden={selected ? true : undefined} inert={Boolean(selected)} aria-labelledby="call-trace-title">
      <header className="drawer-head">
        <div className="drawer-head-title"><h2 id="call-trace-title">调用轨迹</h2><span className="call-trace-count">{total} 次调用</span></div>
        <div className="call-trace-actions">
          <button type="button" className="button button-secondary button-sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />刷新
          </button>
          <button type="button" ref={closeButton} className="icon-button" aria-label="关闭调用轨迹" onClick={onClose}><X size={19} /></button>
        </div>
      </header>
      <div className="drawer-body call-trace-body">
        {loading && traces.length === 0 ? <p role="status" className="call-trace-list-state">正在读取调用记录…</p> : null}
        {error ? <p role="alert" className="call-trace-error call-trace-list-state">{error}</p> : null}
        {!loading && !error && traces.length === 0 ? <p className="call-trace-list-state">暂无调用记录</p> : null}
        <ul className="call-trace-list">
        {traces.map((trace) => <li className="call-trace-item" key={trace.id}>
          <button type="button" className="call-trace-toggle" aria-haspopup="dialog"
            onClick={() => setSelected(trace)}>
            <span className="call-trace-row-main">
              <span className="call-trace-item-head"><strong>{trace.operation || '模型调用'}</strong>
                <span className={trace.error ? 'call-trace-error' : ''}>{trace.error ? '失败' : '完成'} · {trace.status ?? '无响应'} · {trace.latencyMs.toLocaleString()} ms</span>
              </span>
              <span className="call-trace-meta">
                <span>{new Date(trace.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                <span>{trace.model || '未记录模型'}</span>
                <span>{trace.taskName || (trace.taskId ? `任务 ${trace.taskId.slice(0, 8)}` : '模型配置')}</span>
              </span>
            </span>
            <ChevronRight size={17} />
          </button>
        </li>)}
        </ul>
        {nextBefore ? <div className="call-trace-list-footer"><button type="button" className="button button-secondary" disabled={loading} onClick={() => void load(nextBefore)}>{loading ? '正在加载…' : '加载更多'}</button></div> : null}
      </div>
    </aside>
  </div>
    {selected ? <CallTraceDetailDrawer key={selected.id} summary={selected} onClose={() => setSelected(null)} /> : null}
  </>
}
