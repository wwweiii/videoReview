import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isTaskTerminal } from '@shared/task'
import type { PublicSettings, TaskEvent, TaskKind, TaskRecord, TaskSummary } from '@shared/types'
import { Sidebar, type MainView } from './components/layout/Sidebar'
import { Toast, type ToastMessage } from './components/common/Toast'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { TaskHistoryPage } from './pages/TaskHistoryPage'
import { SettingsPage } from './pages/SettingsPage'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { friendlyError, type ShowToast } from './lib/ui'

type View =
  | { name: 'home' }
  | { name: 'tasks' }
  | { name: 'behavior-tasks' }
  | { name: 'settings' }
  | { name: 'task'; taskId: string; taskKind: TaskKind }

function upsertTask(list: TaskSummary[], summary: TaskSummary): TaskSummary[] {
  const next = [...list]
  const index = next.findIndex((task) => task.id === summary.id)
  if (index >= 0) next[index] = summary
  else next.push(summary)
  return next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [view, setView] = useState<View>({ name: 'home' })
  const [detailTask, setDetailTask] = useState<TaskRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentTaskIdRef = useRef<string | null>(null)
  const currentTaskStatusRef = useRef<string | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)

  const showToast: ShowToast = useCallback((kind, message): void => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), kind, message })
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }, [])

  const refreshTasks = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setTasks(await window.framelens.listTasks())
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [showToast])

  const loadTask = useCallback(
    async (taskId: string, silent = false): Promise<void> => {
      if (!silent) {
        setDetailLoading(true)
        setDetailTask(null)
      }
      try {
        const task = await window.framelens.getTask(taskId)
        if (currentTaskIdRef.current === taskId) {
          currentTaskStatusRef.current = task.status
          setDetailTask(task)
        }
      } catch (error) {
        if (!silent) showToast('error', friendlyError(error))
      } finally {
        if (!silent) setDetailLoading(false)
      }
    },
    [showToast]
  )

  const openTask = useCallback(
    (taskId: string, taskKind: TaskKind = 'items'): void => {
      currentTaskIdRef.current = taskId
      currentTaskStatusRef.current = null
      setView({ name: 'task', taskId, taskKind })
      void loadTask(taskId)
    },
    [loadTask]
  )

  useEffect(() => {
    let cancelled = false
    void window.framelens
      .getBootstrap()
      .then((data) => {
        if (cancelled) return
        setSettings(data.settings)
        setTasks(data.tasks)
      })
      .catch((error) => {
        if (!cancelled) setBootError(friendlyError(error))
      })
      .finally(() => {
        if (!cancelled) setBooting(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.framelens.onTaskEvent((event: TaskEvent) => {
      setTasks((previous) => upsertTask(previous, event.summary))

      if (currentTaskIdRef.current !== event.summary.id) return
      const wasExtracting = currentTaskStatusRef.current === 'extracting'
      currentTaskStatusRef.current = event.summary.status
      if (event.kind === 'summary' && wasExtracting && event.summary.status === 'analyzing') {
        window.setTimeout(() => void loadTask(event.summary.id, true), 150)
      }

      setDetailTask((previous) => {
        if (!previous) return previous
        const next: TaskRecord = {
          ...previous,
          status: event.summary.status,
          progress: event.summary.progress,
          phaseMessage: event.summary.phaseMessage,
          errorMessage: event.summary.errorMessage,
          updatedAt: event.summary.updatedAt
        }
        if (event.kind === 'frame') {
          const frames = [...next.frames]
          const index = frames.findIndex((frame) => frame.index === event.frame.index)
          if (index >= 0) frames[index] = event.frame
          else frames.push(event.frame)
          next.frames = frames
        }
        if (event.kind === 'behavior-window') {
          const windows = [...(next.behaviorWindows ?? [])]
          const index = windows.findIndex((window) => window.index === event.window.index)
          if (index >= 0) windows[index] = event.window
          else windows.push(event.window)
          next.behaviorWindows = windows.sort((a, b) => a.index - b.index)
        }
        return next
      })

      if (event.kind === 'summary' && isTaskTerminal(event.summary.status)) {
        window.setTimeout(() => void loadTask(event.summary.id, true), 250)
      }
    })
  }, [loadTask])

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [view])

  function navigate(target: MainView): void {
    currentTaskIdRef.current = null
    currentTaskStatusRef.current = null
    setView(
      target === 'home'
        ? { name: 'home' }
        : target === 'tasks'
          ? { name: 'tasks' }
          : target === 'behavior-tasks'
            ? { name: 'behavior-tasks' }
            : { name: 'settings' }
    )
    if (target === 'tasks' || target === 'behavior-tasks') void refreshTasks()
  }

  async function refreshCurrentTask(): Promise<void> {
    if (view.name !== 'task') return
    await loadTask(view.taskId, true)
  }

  if (booting) {
    return (
      <div className="splash">
        <Loader2 size={22} className="spin" />
      </div>
    )
  }

  if (bootError || !settings) {
    return (
      <div className="splash">
        <span>加载失败</span>
        <button type="button" className="button button-secondary" onClick={() => location.reload()}>
          <RefreshCw size={17} />
          重试
        </button>
      </div>
    )
  }

  const activeView: MainView = view.name === 'task'
    ? (view.taskKind === 'behavior' ? 'behavior-tasks' : 'tasks')
    : view.name

  return (
    <div className="app-shell">
      <Sidebar active={activeView} onNavigate={navigate} />
      <main className="app-main" ref={mainRef}>
        {view.name === 'home' ? (
          <WorkbenchPage
            showToast={showToast}
            onStarted={(task) => {
              setTasks((previous) => upsertTask(previous, task))
              openTask(task.id, task.kind ?? 'items')
            }}
          />
        ) : null}

        {view.name === 'tasks' || view.name === 'behavior-tasks' ? (
          <TaskHistoryPage
            key={view.name}
            kind={view.name === 'behavior-tasks' ? 'behavior' : 'items'}
            tasks={tasks.filter((task) => (task.kind === 'behavior') === (view.name === 'behavior-tasks'))}
            loading={historyLoading}
            onOpenTask={(taskId) => openTask(taskId, view.name === 'behavior-tasks' ? 'behavior' : 'items')}
            onDeleted={(taskId) => setTasks((previous) => previous.filter((task) => task.id !== taskId))}
            onRefresh={refreshTasks}
            showToast={showToast}
          />
        ) : null}

        {view.name === 'settings' ? (
          <SettingsPage settings={settings} onSaved={setSettings} showToast={showToast} />
        ) : null}

        {view.name === 'task' ? (
          <TaskDetailPage
            task={detailTask}
            loading={detailLoading}
            onBack={() => navigate(view.taskKind === 'behavior' ? 'behavior-tasks' : 'tasks')}
            onRefresh={refreshCurrentTask}
            showToast={showToast}
          />
        ) : null}
      </main>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
