import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useId } from 'react'

export function ConfirmDialog({
  open,
  title,
  confirmLabel = '确认',
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button dialog-close" onClick={onCancel} disabled={busy} aria-label="关闭">
          <X size={18} />
        </button>
        <div className="confirm-heading">
          <div className={`confirm-icon ${danger ? 'confirm-icon-danger' : ''}`} aria-hidden="true">
            <AlertTriangle size={23} />
          </div>
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="dialog-actions">
          <button className="button button-ghost" onClick={onCancel} disabled={busy} autoFocus>
            取消
          </button>
          <button
            className={`button ${danger ? 'button-danger' : 'button-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
