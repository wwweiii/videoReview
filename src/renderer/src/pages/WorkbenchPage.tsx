import { FileVideo2, Loader2 } from 'lucide-react'
import { useRef, useState, type DragEvent, type JSX } from 'react'
import type { TaskKind, TaskSummary } from '@shared/types'
import { friendlyError, type ShowToast } from '../lib/ui'

export function WorkbenchPage({
  onStarted,
  showToast
}: {
  onStarted: (task: TaskSummary) => void
  showToast: ShowToast
}): JSX.Element {
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [busy, setBusy] = useState<TaskKind | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  function select(filePath: string): void {
    if (!filePath) return
    setSelectedPath(filePath)
    setSelectedName(filePath.split(/[\\/]/).pop() || filePath)
  }

  async function chooseFile(): Promise<void> {
    if (busy) return
    try {
      const result = await window.framelens.selectVideoFile()
      if (!result.canceled && result.path) select(result.path)
    } catch (error) {
      showToast('error', friendlyError(error))
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (busy) return
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    let filePath = ''
    try {
      filePath = window.framelens.getPathForFile(file)
    } catch {
      filePath = ''
    }
    if (!filePath) {
      showToast('error', '无法读取文件')
      return
    }
    select(filePath)
  }

  async function startAnalysis(kind: TaskKind): Promise<void> {
    if (!selectedPath || busy) return
    setBusy(kind)
    try {
      const task = await (kind === 'behavior'
        ? window.framelens.startBehaviorReview(selectedPath)
        : window.framelens.startReview(selectedPath))
      onStarted(task)
    } catch (error) {
      showToast('error', friendlyError(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page workbench-page">
      <h1 className="page-title">工作台</h1>
      <div
        className={`upload-panel ${dragging ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`}
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
        <button type="button" className="upload-select" onClick={() => void chooseFile()} disabled={Boolean(busy)}>
          <span className="upload-icon">
            {busy ? <Loader2 size={34} className="spin" /> : <FileVideo2 size={34} />}
          </span>
          <span className="upload-title">拖入或上传视频</span>
          {selectedName ? <span className="upload-file">{selectedName}</span> : null}
        </button>

      </div>

      <div className="workbench-actions">
        <button
          type="button"
          className="button button-primary start-analysis"
          onClick={() => void startAnalysis('items')}
          disabled={!selectedPath || Boolean(busy)}
        >
          {busy === 'items' ? <Loader2 size={17} className="spin" /> : null}
          识别物品
        </button>
        <button
          type="button"
          className="button button-secondary start-analysis"
          onClick={() => void startAnalysis('behavior')}
          disabled={!selectedPath || Boolean(busy)}
        >
          {busy === 'behavior' ? <Loader2 size={17} className="spin" /> : null}
          识别行为
        </button>
      </div>
    </div>
  )
}
