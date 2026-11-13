import { Clock3, X } from 'lucide-react'
import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { ModelCallTrace } from '@shared/types'

function prettyRaw(raw: string): string {
  if (!raw) return '—'
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2)
  } catch {
    return raw
  }
}

function tokenText(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

export function CallTraceDrawer({
  traces,
  onClose
}: {
  traces: ModelCallTrace[]
  onClose: () => void
}): JSX.Element {
  const closeButton = useRef<HTMLButtonElement>(null)
  const totals = useMemo(() => traces.reduce(
    (result, trace) => ({
      prompt: result.prompt + (trace.promptTokens ?? 0),
      completion: result.completion + (trace.completionTokens ?? 0),
      total: result.total + (trace.totalTokens ?? 0)
    }),
    { prompt: 0, completion: 0, total: 0 }
  ), [traces])

  useEffect(() => {
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-backdrop call-trace-backdrop" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside
        className="drawer call-trace-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-trace-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="drawer-head-title">
            <h2 id="call-trace-title">调用轨迹</h2>
            <span className="call-trace-count">{traces.length} 次调用</span>
          </div>
          <button
            type="button"
            ref={closeButton}
            className="icon-button"
            aria-label="关闭调用轨迹"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <div className="drawer-body call-trace-body">
          <div className="call-trace-summary">
            <span><Clock3 size={15} />总耗时 {traces.reduce((sum, trace) => sum + trace.latencyMs, 0).toLocaleString()} ms</span>
            <span>输入 token {tokenText(totals.prompt || null)}</span>
            <span>输出 token {tokenText(totals.completion || null)}</span>
            <span>总 token {tokenText(totals.total || null)}</span>
          </div>
          {traces.length > 0 ? traces.map((trace, index) => (
              <section className="call-trace-item" key={`${trace.startedAt}-${index}`}>
                <div className="call-trace-item-head">
                  <strong>{trace.operation || '模型调用'}</strong>
                  <span>{trace.latencyMs.toLocaleString()} ms · {trace.status ?? '无响应'}</span>
                </div>
                <div className="call-trace-meta">
                  <span>开始 {trace.startedAt}</span>
                  <span>结束 {trace.finishedAt}</span>
                  <span>输入 {tokenText(trace.promptTokens)}</span>
                  <span>输出 {tokenText(trace.completionTokens)}</span>
                  <span>合计 {tokenText(trace.totalTokens)}</span>
                </div>
                {trace.error ? <p className="call-trace-error">{trace.error}</p> : null}
                <div className="call-trace-block">
                  <h3>输入原始结构</h3>
                  <pre>{prettyRaw(trace.requestBody)}</pre>
                </div>
                <div className="call-trace-block">
                  <h3>输出原始结构</h3>
                  <pre>{prettyRaw(trace.responseBody)}</pre>
                </div>
              </section>
            )) : null}
        </div>
      </aside>
    </div>
  )
}
