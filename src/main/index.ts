import { BrowserWindow, Menu, app, dialog } from 'electron'
import { registerMediaProtocol, registerMediaSchemes } from './app/media-protocol'
import { createWindow, focusMainWindow, isWindowCloseApproved, requestWindowClose, resetWindowClose } from './app/window'
import { registerIpcHandlers } from './ipc'
import { logger } from './logger'
import { configureElectronDataPath } from './paths'
import { initializeTaskManager, shutdownTaskManager } from './task/manager'
import { taskSession } from './task/session'

registerMediaSchemes()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.setAppUserModelId('com.csg.videoreview')
app.setName('视频智能审核')
configureElectronDataPath()

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  app.whenReady().then(() => {
    try {
      Menu.setApplicationMenu(null)
      initializeTaskManager()
      registerMediaProtocol()
      registerIpcHandlers()
      createWindow()
      logger.info('应用启动', { version: app.getVersion() })
    } catch (error) {
      logger.error('应用初始化失败', error)
      app.quit()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let shutdownComplete = false
  let shutdownPending = false
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (!isWindowCloseApproved() && requestWindowClose()) return
    if (shutdownPending) return
    shutdownPending = true
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('任务仍在收尾，请稍后重试退出')), 15_000)
    })
    void Promise.race([shutdownTaskManager(), timeout]).then(() => {
      shutdownComplete = true
      app.quit()
    }).catch((error) => {
      logger.error('退出前保存失败', error)
      taskSession.shuttingDown = false
      resetWindowClose()
      dialog.showErrorBox('退出前保存失败', error instanceof Error ? error.message : String(error))
    }).finally(() => {
      clearTimeout(timer)
      shutdownPending = false
    })
  })
}

process.on('uncaughtException', (error) => {
  logger.error('未捕获异常', error)
})

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', reason)
})
