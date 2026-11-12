import {
  AlertCircle,
  ArrowLeft,
  Crosshair,
  Download,
  Loader2,
  RefreshCw,
  StopCircle
} from 'lucide-react'
import { useEffect, useState, type JSX } from 'react'
import {
  DEFAULT_BEHAVIOR_FPS,
  DEFAULT_BEHAVIOR_STRIDE_SEC,
  DEFAULT_BEHAVIOR_WINDOW_SEC
} from '@shared/defaults'
import { formatDuration } from '@shared/format'
import { countFrameStats, isTaskActive } from '@shared/task'
import { taskResults } from '@shared/behavior'
import type { TaskRecord } from '@shared/types'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { StatusBadge } from '../components/common/StatusBadge'
import { FrameDrawer } from '../components/task/FrameDrawer'
import { FrameTable } from '../components/task/FrameTable'
import { BehaviorResults } from '../components/task/BehaviorResults'
import { friendlyError, type ShowToast } from '../lib/ui'

/**
 * 任务详情页容器：任务头 + 进度 + 提示 + 汇总 + 操作，结果列表与帧抽屉拆到组件。
 */
export function TaskDetailPage({
  task,
  loading,
  onBack,
  onRefresh,
  showToast
}: {
  task: TaskRecord | null
  loading: boolean
  onBack: () => void
  onRefresh: () => Promise<void>
  showToast: ShowToast
}): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busyAction, setBusyAction] = useState<'cancel' | 'retry' | 'export' | 'relocalize' | null>(
    null
  )

  const behavior = task?.kind === 'behavior'
  const stats = countFrameStats(task ? taskResults(task) : [])
  const active = task ? isTaskActive(task.status) : false

  const selectedFrame =
    task && selectedIndex !== null
      ? task.frames.find((frame) => frame.index === selectedIndex) ?? null
      : null
  const selectedPosition =
    task && selectedFrame
      ? task.frames.findIndex((frame) => frame.index === selectedFrame.index)
      : -1

  useEffect(() => {
    if (!selectedFrame || !task) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedIndex(null)
      if (event.key === 'ArrowLeft' && selectedPosition > 0) {
        setSelectedIndex(task.frames[selectedPosition - 1].index)
      }
      if (event.key === 'ArrowRight' && selectedPosition < task.frames.length - 1) {
        setSelectedIndex(task.frames[selectedPosition + 1].index)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedFrame, selectedPosition, task])

  async function cancel(): Promise<void> {
    if (!task) return
    setBusyAction('cancel')
    try {
      await window.framelens.cancelTask(task.id)
      setConfirmCancel(false)
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function retry(): Promise<void> {
    if (!task) return
    setBusyAction('retry')
    try {
      await window.framelens.retryFailedFrames(task.id)
      await onRefresh()
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function relocalize(): Promise<void> {
    if (!task) return
    setBusyAction('relocalize')
    try {
      await window.framelens.relocalizeTask(task.id)
      await onRefresh()
      showToast('success', '已开始重新定位')
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setBusyAction(null)
    }
  }

  async function exportResult(): Promise<void> {
    if (!task) return
    setBusyAction('export')
    try {
      const result = await window.framelens.exportTaskCsv(task.id)
      if (result.saved) showToast('success', '已导出')
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setBusyAction(null)
    }
  }

  if (loading && !task) {
    return (
      <div className="page center-state">
        <Loader2 size={24} className="spin" />
      </div>
    )
  }

  if (!task) {
    return (
      <div className="page center-state">
        <span>任务不存在</span>
        <button type="button" className="button button-secondary" onClick={onBack}>
          返回
        </button>
      </div>
    )
  }

  return (
    <div className="page detail-page">
      <header className="detail-top">
        <button type="button" className="icon-button" onClick={onBack} aria-label="返回">
          <ArrowLeft size={19} />
        </button>
        <div className="detail-heading">
          <h1 title={task.name}>{task.name}</h1>
          <div className="detail-sub">
            <StatusBadge status={task.status} />
            <span>{formatDuration(task.source.durationMs)}</span>
            {task.source.width > 0 ? (
              <span>
                {task.source.width}×{task.source.height}
              </span>
            ) : null}
            <span>{behavior ? `行为识别 · ${task.behaviorConfig?.windowSec ?? DEFAULT_BEHAVIOR_WINDOW_SEC} 秒窗口 · ${task.behaviorConfig?.strideSec ?? DEFAULT_BEHAVIOR_STRIDE_SEC} 秒推进 · ${task.behaviorConfig?.fps ?? DEFAULT_BEHAVIOR_FPS} FPS` : `每 ${task.config.intervalSec} 秒`}</span>
          </div>
        </div>
        <div className="detail-actions">
          {active ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setConfirmCancel(true)}
              disabled={busyAction === 'cancel'}
            >
              <StopCircle size={17} />
              取消
            </button>
          ) : stats.failed > 0 ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void retry()}
              disabled={busyAction === 'retry'}
            >
              {busyAction === 'retry' ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <RefreshCw size={17} />
              )}
              重试
            </button>
          ) : null}
          {!behavior && !active && task.config.localize && stats.abnormal + stats.review > 0 ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void relocalize()}
              disabled={busyAction === 'relocalize'}
              title="使用当前模型配置重新定位异常帧（不重跑判定）"
            >
              {busyAction === 'relocalize' ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <Crosshair size={17} />
              )}
              重新定位
            </button>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void exportResult()}
            disabled={stats.total === 0 || busyAction === 'export'}
          >
            {busyAction === 'export' ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <Download size={17} />
            )}
            导出
          </button>
        </div>
      </header>

      {active ? (
        <section className="progress-block">
          <div className="progress-head">
            <span>{task.phaseMessage}</span>
            <span>{Math.round(task.progress)}%</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.max(1, task.progress)}%` }} />
          </div>
        </section>
      ) : null}

      {!active && (task.status === 'failed' || task.status === 'interrupted') ? (
        <div className="notice">
          <AlertCircle size={19} />
          <span>{task.errorMessage || '任务失败'}</span>
        </div>
      ) : null}

      <div className="summary-line">
        <span>
          共 <strong>{stats.total}</strong> {behavior ? '个片段' : '帧'}
        </span>
        {!behavior && (task.config.localize || stats.located > 0) ? (
          <span>
            已定位 <strong>{stats.located}</strong> 帧
          </span>
        ) : null}
        <span className={stats.abnormal > 0 ? 'summary-abnormal' : ''}>
          异常 <strong>{stats.abnormal}</strong>
        </span>
        <span>
          待复核 <strong>{stats.review}</strong>
        </span>
        <span>
          失败 <strong>{stats.failed}</strong>
        </span>
      </div>

      {behavior ? <BehaviorResults key={task.id} task={task} onRefresh={onRefresh} /> : <FrameTable
        task={task}
        stats={stats}
        onRefresh={onRefresh}
        onOpenFrame={setSelectedIndex}
      />}

      {selectedFrame ? (
        <FrameDrawer
          task={task}
          frame={selectedFrame}
          position={selectedPosition}
          onClose={() => setSelectedIndex(null)}
          onPrevious={() => {
            if (selectedPosition > 0) setSelectedIndex(task.frames[selectedPosition - 1].index)
          }}
          onNext={() => {
            if (selectedPosition < task.frames.length - 1) {
              setSelectedIndex(task.frames[selectedPosition + 1].index)
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmCancel}
        title="取消任务"
        description="已完成的画面会保留。"
        confirmLabel="取消任务"
        danger
        busy={busyAction === 'cancel'}
        onConfirm={() => void cancel()}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  )
}
