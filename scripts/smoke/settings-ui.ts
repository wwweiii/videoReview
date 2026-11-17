/** 隐藏 Electron 窗口，验证真实 React 表单、preload 和设置 IPC。 */
import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getPublicSettings } from '../../src/main/config/settings'
import { registerIpcHandlers } from '../../src/main/ipc'
import { getTask, listTasks } from '../../src/main/task/manager'

type Check = (name: string, ok: boolean, detail?: unknown) => void

export async function verifySettingsUi(videoPath: string, check: Check): Promise<string> {
  registerIpcHandlers()
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(process.cwd(), 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  const evaluate = (source: string): Promise<any> => window.webContents.executeJavaScript(source)
  async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
    const started = Date.now()
    while (!await condition()) {
      if (Date.now() - started > 10_000) throw new Error('等待界面条件超时')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  async function click(selector: string, label: string): Promise<void> {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(label)});
      button.click();
    })()`)
  }
  async function editInterval(value: number): Promise<void> {
    await evaluate(`(() => {
      const field = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === '抽帧间隔');
      const input = field.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await until(() => evaluate(`document.querySelector('.settings-save-state')?.dataset.status === 'pending'`))
  }
  function requestClose(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('app:closeReady', listener)
        reject(new Error('页面未回复关闭请求'))
      }, 5000)
      const listener = (event: Electron.IpcMainEvent, saved: boolean): void => {
        if (event.sender.id !== window.webContents.id) return
        clearTimeout(timer)
        ipcMain.removeListener('app:closeReady', listener)
        resolve(saved)
      }
      ipcMain.on('app:closeReady', listener)
      window.webContents.send('app:beforeClose')
    })
  }
  try {
    await window.loadFile(path.join(process.cwd(), 'out/renderer/index.html'))
    await until(() => evaluate(`Boolean(document.querySelector('.settings-save-state'))`))
    await evaluate(`localStorage.setItem('framelens.uploaded-files', ${JSON.stringify(JSON.stringify([{ path: videoPath, name: path.basename(videoPath) }]))})`)
    await window.loadFile(path.join(process.cwd(), 'out/renderer/index.html'))
    await until(() => evaluate(`Boolean(document.querySelector('.uploaded-file-task-button'))`))

    await click('.nav-item', '设置')
    await editInterval(3.5)
    await click('.nav-item', '工作台')
    await until(() => getPublicSettings().intervalSec === 3.5)
    check('界面切到工作台后仍完成自动保存', getPublicSettings().intervalSec === 3.5)
    check('切页后设置界面保持隐藏', await evaluate(`document.querySelector('.settings-page').getClientRects().length === 0`))

    await click('.nav-item', '设置')
    await editInterval(4.5)
    check('关闭请求等待防抖中的设置保存', await requestClose() && getPublicSettings().intervalSec === 4.5)
    await until(() => evaluate(`document.querySelector('.settings-save-state')?.dataset.status === 'saved'`))
    check('保存成功后界面显示已保存', true)

    const rename = fs.renameSync
    try {
      fs.renameSync = () => { throw new Error('EACCES simulated') }
      await editInterval(5.5)
      check('保存失败时页面拒绝关闭并保留已保存配置', !await requestClose() && getPublicSettings().intervalSec === 4.5)
      await until(() => evaluate(`document.querySelector('.settings-save-state')?.dataset.status === 'error'`))
      check('界面明确显示保存失败并提供重试', await evaluate(`document.querySelector('.settings-save-state').textContent.includes('重试保存')`))
    } finally {
      fs.renameSync = rename
    }
    await click('.settings-save-state button', '重试保存')
    await until(() => getPublicSettings().intervalSec === 5.5)
    check('恢复写入后原草稿可重试保存', getPublicSettings().intervalSec === 5.5)

    const previousIds = new Set(listTasks().map((task) => task.id))
    await editInterval(2.5)
    await click('.nav-item', '工作台')
    await click('.uploaded-file-task-button', '识别物品')
    await until(() => listTasks().some((task) => !previousIds.has(task.id)))
    const started = listTasks().find((task) => !previousIds.has(task.id))!
    check('立即启动任务使用最新设置快照', getTask(started.id).config.intervalSec === 2.5)
    return started.id
  } finally {
    window.destroy()
  }
}
