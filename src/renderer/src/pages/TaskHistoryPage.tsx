import { FileVideo2, Inbox, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import { isTaskActive } from '@shared/task'
import type { TaskKind, TaskSummary } from '@shared/types'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { StatusBadge } from '../components/common/StatusBadge'
import { friendlyError, type ShowToast } from '../lib/ui'

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

export function TaskHistoryPage({
  kind = 'items',
  tasks,
  loading,
  onOpenTask,
  onDeleted,
  onRefresh,
  showToast
}: {
  kind?: TaskKind
  tasks: TaskSummary[]
  loading: boolean
  onOpenTask: (taskId: string) => void
  onDeleted: (taskId: string) => void
  onRefresh: () => Promise<void>
  showToast: ShowToast
}): JSX.Element {
  const [pendingDelete, setPendingDelete] = useState<TaskSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function remove(): Promise<void> {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await window.framelens.deleteTask(pendingDelete.id)
      onDeleted(pendingDelete.id)
      setPendingDelete(null)
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="page history-page">
      <header className="page-header">
        <h1 className="page-title">{kind === 'behavior' ? '行为识别记录' : '物品识别记录'}</h1>
        <button
          type="button"
          className="icon-button"
          onClick={() => void onRefresh()}
          disabled={loading}
          aria-label="刷新"
        >
          {loading ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
        </button>
      </header>

      {tasks.length === 0 ? (
        <div className="empty-state">
          <Inbox size={30} />
          <span>{loading ? '加载中' : '暂无任务'}</span>
        </div>
      ) : (
        <section className="history-card">
          <div className="history-head">
            <span>视频</span>
            <span>时间</span>
            <span>状态</span>
            <span>异常</span>
            <span className="history-head-actions">操作</span>
          </div>
          {tasks.map((task) => (
            <div
              key={task.id}
              className="history-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpenTask(task.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenTask(task.id)
                }
              }}
            >
              <span className="history-file">
                <span className="history-file-icon">
                  <FileVideo2 size={20} />
                </span>
                <span className="history-file-name">{task.name}</span>
              </span>
              <span className="history-time">{formatCreatedAt(task.createdAt)}</span>
              <span>
                <StatusBadge status={task.status} />
              </span>
              <span className={`history-abnormal ${task.abnormalCount > 0 ? 'has-abnormal' : ''}`}>
                {task.abnormalCount}
              </span>
              <span className="history-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setPendingDelete(task)
                  }}
                  disabled={isTaskActive(task.status)}
                  aria-label="删除"
                >
                  <Trash2 size={17} />
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="删除任务"
        description="任务记录和画面将被删除，且无法恢复。"
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}
