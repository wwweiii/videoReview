import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import { getWindowIconPath } from '../paths'

let mainWindow: BrowserWindow | null = null
let closeApproved = false
let closeTimer: ReturnType<typeof setTimeout> | null = null

export function isWindowCloseApproved(): boolean { return closeApproved }

export function resetWindowClose(): void {
  closeApproved = false
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}

/** 先让常驻的设置队列完成保存，再由 before-quit 等待任务落盘。 */
export function requestWindowClose(): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return false
  if (closeTimer) return true
  closeTimer = setTimeout(() => {
    resetWindowClose()
    dialog.showErrorBox('暂时无法退出', '页面未完成保存，请检查设置保存状态后重试。')
  }, 10_000)
  mainWindow.webContents.send('app:beforeClose')
  return true
}

export function completeWindowClose(senderId: number, saved: boolean): void {
  if (senderId !== mainWindow?.webContents.id || !closeTimer) return
  resetWindowClose()
  if (saved) {
    closeApproved = true
    app.quit()
  }
}

export function createWindow(): void {
  resetWindowClose()
  const iconPath = getWindowIconPath()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: '视频智能审核',
    icon: iconPath || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    resetWindowClose()
    mainWindow = null
  })

  mainWindow.on('close', (event) => {
    if (!closeApproved && requestWindowClose()) event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** 把已创建的主窗口带到前台（单实例二次启动时使用） */
export function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}
