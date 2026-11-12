import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { ToastKind } from '../../lib/ui'

export type { ToastKind } from '../../lib/ui'

export interface ToastMessage {
  id: number
  kind: ToastKind
  message: string
}

export function Toast({
  toast,
  onClose
}: {
  toast: ToastMessage | null
  onClose: () => void
}): React.JSX.Element | null {
  if (!toast) return null
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertCircle : Info
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={19} />
      <span>{toast.message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label="关闭提示">
        <X size={16} />
      </button>
    </div>
  )
}
