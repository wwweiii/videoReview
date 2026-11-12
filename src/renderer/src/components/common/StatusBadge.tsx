import type { JSX } from 'react'
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_TONES,
  VERDICT_LABELS,
  VERDICT_TONES
} from '@shared/task'
import type { TaskStatus, Verdict } from '@shared/types'

export function StatusBadge({ status }: { status: TaskStatus }): JSX.Element {
  return (
    <span className={`badge badge-${TASK_STATUS_TONES[status]}`}>{TASK_STATUS_LABELS[status]}</span>
  )
}

export function VerdictBadge({ verdict }: { verdict: Verdict }): JSX.Element {
  return <span className={`badge badge-${VERDICT_TONES[verdict]}`}>{VERDICT_LABELS[verdict]}</span>
}
