import { BrowserWindow, Menu, app } from 'electron'
import { registerMediaProtocol, registerMediaSchemes } from './app/media-protocol'
import { createWindow, focusMainWindow } from './app/window'
import { registerIpcHandlers } from './ipc'
import { logger } from './logger'
import { configureElectronDataPath } from './paths'
import { initializeTaskManager, shutdownTaskManager } from './task/manager'

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

  app.on('before-quit', () => {
    shutdownTaskManager()
  })
}

process.on('uncaughtException', (error) => {
  logger.error('未捕获异常', error)
})

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', reason)
})
