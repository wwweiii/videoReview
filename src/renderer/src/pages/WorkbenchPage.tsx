import { FileVideo2, Loader2, Trash2 } from 'lucide-react'
import { useRef, useState, type DragEvent, type JSX } from 'react'
import { isTaskActive } from '@shared/task'
import type { TaskKind, TaskSummary } from '@shared/types'
import { friendlyError, type ShowToast } from '../lib/ui'

export interface UploadedFile {
  path: string
  name: string
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function normalizedPath(filePath: string): string {
  return filePath.trim().replaceAll('\\', '/').toLowerCase()
}

function taskKey(filePath: string, kind: TaskKind): string {
  return `${normalizedPath(filePath)}:${kind}`
}

function taskMatchesFile(task: TaskSummary, file: UploadedFile): boolean {
  if (task.filePath) return normalizedPath(task.filePath) === normalizedPath(file.path)
  return task.name === file.name
}

function findTask(tasks: TaskSummary[], file: UploadedFile, kind: TaskKind): TaskSummary | null {
  return (
    tasks
      .filter((task) => (task.kind ?? 'items') === kind && taskMatchesFile(task, file))
      .sort((left, right) => {
        const activeOrder = Number(isTaskActive(right.status)) - Number(isTaskActive(left.status))
        return activeOrder || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      })[0] ?? null
  )
}

export function WorkbenchPage({
  files,
  tasks,
  onFilesAdded,
  onFileRemoved,
  onStarted,
  onOpenTask,
  showToast
}: {
  files: UploadedFile[]
  tasks: TaskSummary[]
  onFilesAdded: (files: UploadedFile[]) => void
  onFileRemoved: (filePath: string) => void
  onStarted: (task: TaskSummary) => void
  onOpenTask: (taskId: string, taskKind: TaskKind) => void
  showToast: ShowToast
}): JSX.Element {
  const [starting, setStarting] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  function addFiles(filePaths: string[]): void {
    const next = filePaths
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => ({ path, name: fileName(path) }))
      .filter((file, index, list) => list.findIndex((item) => normalizedPath(item.path) === normalizedPath(file.path)) === index)
    if (next.length > 0) onFilesAdded(next)
  }

  async function chooseFile(): Promise<void> {
    try {
      const result = await window.framelens.selectVideoFile()
      if (!result.canceled) addFiles(result.paths ?? (result.path ? [result.path] : []))
    } catch (error) {
      showToast('error', friendlyError(error))
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const droppedFiles = Array.from(event.dataTransfer.files ?? [])
    const paths: string[] = []
    for (const file of droppedFiles) {
      try {
        const path = window.framelens.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // Ignore files Electron cannot resolve and report only if none were usable.
      }
    }
    if (paths.length === 0 && droppedFiles.length > 0) showToast('error', '无法读取文件')
    addFiles(paths)
  }

  async function startAnalysis(file: UploadedFile, kind: TaskKind): Promise<void> {
    const key = taskKey(file.path, kind)
    if (starting.has(key)) return
    setStarting((previous) => new Set(previous).add(key))
    try {
      const task = await (kind === 'behavior'
        ? window.framelens.startBehaviorReview(file.path)
        : window.framelens.startReview(file.path))
      onStarted(task)
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setStarting((previous) => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  function renderTaskButton(file: UploadedFile, kind: TaskKind): JSX.Element {
    const task = findTask(tasks, file, kind)
    const isStarting = starting.has(taskKey(file.path, kind))
    const isWorking = isStarting || Boolean(task && isTaskActive(task.status))
    const disabled = isStarting
    const isAnalyzed = Boolean(task)
    const label = kind === 'behavior' ? '识别行为' : '识别物品'
    const title = task
      ? isTaskActive(task.status)
        ? '分析中，点击查看任务进度'
        : '已分析，点击重新分析'
      : `开始${label}`

    return (
      <button
        type="button"
        className={`button button-sm uploaded-file-task-button ${kind === 'behavior' ? 'button-secondary' : 'button-primary'} ${isAnalyzed ? 'is-analyzed' : ''}`}
        aria-label={`${file.name}：${title}`}
        disabled={disabled}
        onClick={() => {
          if (task && isTaskActive(task.status)) onOpenTask(task.id, kind)
          else void startAnalysis(file, kind)
        }}
      >
        {isWorking ? <Loader2 size={15} className="uploaded-file-task-spinner spin" /> : null}
        <span>{label}</span>
      </button>
    )
  }

  return (
    <div className="page workbench-page">
      <h1 className="page-title">工作台</h1>
      <div
        className={`upload-panel ${files.length === 0 ? 'is-empty' : ''} ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragging(false)
        }}
        onDrop={handleDrop}
      >
        <button type="button" className="upload-select" onClick={() => void chooseFile()}>
          <span className="upload-icon">
            {starting.size > 0 ? <Loader2 size={34} className="spin" /> : <FileVideo2 size={34} />}
          </span>
          <span className="upload-title">拖入或上传视频</span>
        </button>
      </div>

      {files.length > 0 ? (
        <section className="uploaded-files" aria-label="已上传文件">
          <div className="uploaded-files-heading">
            <h2>已上传文件</h2>
            <span>{files.length} 个文件</span>
          </div>
          <div className="uploaded-files-list">
            {files.map((file) => (
              <div className="uploaded-file-row" key={file.path} title={file.path}>
                <div className="uploaded-file-info">
                  <span className="uploaded-file-icon"><FileVideo2 size={19} /></span>
                  <span className="uploaded-file-name">{file.name}</span>
                </div>
                <div className="uploaded-file-actions">
                  {renderTaskButton(file, 'items')}
                  {renderTaskButton(file, 'behavior')}
                  <button
                    type="button"
                    className="icon-button uploaded-file-delete-button"
                    aria-label={`从工作台删除 ${file.name}`}
                    title="从工作台删除"
                    onClick={() => onFileRemoved(file.path)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
