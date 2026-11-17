/** 隐藏 Electron 窗口，验证真实 React 表单、preload 和设置 IPC。 */
import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getPublicSettings } from '../../src/main/config/settings'
import { getResolvedModelConfig } from '../../src/main/config/model-config'
import { registerIpcHandlers } from '../../src/main/ipc'
import { getTask, listTasks } from '../../src/main/task/manager'

type Check = (name: string, ok: boolean, detail?: unknown) => void

export async function verifySettingsUi(videoPath: string, check: Check): Promise<string> {
  registerIpcHandlers()
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
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
  async function captureSettings(name: string): Promise<void> {
    await evaluate(`document.querySelector('.toast-close')?.click()`)
    await evaluate(`document.getAnimations().forEach(animation => { try { animation.finish(); } catch {} })`)
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    fs.writeFileSync(path.join(process.cwd(), '.tmp', name), (await window.webContents.capturePage()).toPNG())
  }
  async function testConnectionBody(): Promise<Record<string, unknown>> {
    const originalFetch = globalThis.fetch
    let body: Record<string, unknown> | undefined
    globalThis.fetch = async (input, init) => {
      if (typeof init?.body === 'string') body = JSON.parse(init.body)
      return originalFetch(input, init)
    }
    try {
      await click('.settings-actions button', '测试连接')
      await until(() => Boolean(body))
      await until(() => evaluate(`!document.querySelector('.settings-actions button').disabled`))
      return body!
    } finally { globalThis.fetch = originalFetch }
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

    await click('.nav-item', '物品识别记录')
    await until(() => evaluate(`Boolean(document.querySelector('.history-row'))`))
    await evaluate(`document.querySelector('.history-row').click()`)
    await until(() => evaluate(`Boolean(document.querySelector('.frame-row'))`))
    await evaluate(`document.querySelector('.frame-row').click()`)
    check('任务详情已移除调用轨迹入口', await evaluate(`![...document.querySelectorAll('.drawer button')].some(el => el.textContent.trim() === '调用轨迹')`))
    await evaluate(`document.querySelector('.drawer-head [aria-label="关闭"]').click()`)

    await click('.nav-item', '设置')
    check('物品页只显示启用项且不包含勾选框', await evaluate(`document.querySelectorAll('.detect-list .detect-item').length === ${getPublicSettings().prohibitedItems.length} && !document.querySelector('.detect-list [role="checkbox"], .detect-list input[type="checkbox"], .detect-list .check-box')`))
    check('物品输入框显示简化文案', await evaluate(`document.querySelector('.custom-item-row input').placeholder === '添加违禁物'`))
    const activeLabels: string[] = await evaluate(`[...document.querySelectorAll('.detect-item-label')].map(el => el.textContent.trim())`)
    await evaluate(`document.querySelector('[aria-label="取消物品 铅笔"]').click()`)
    await requestClose()
    check('取消预设物品后从界面和保存配置中同时移除', !getPublicSettings().prohibitedItems.includes('pencil') && await evaluate(`![...document.querySelectorAll('.detect-item-label')].some(el => el.textContent === '铅笔')`))
    await evaluate(`document.querySelectorAll('.detect-list .detect-remove').forEach(el => el.click())`)
    await requestClose()
    check('界面支持取消全部物品并保存空列表', getPublicSettings().prohibitedItems.length === 0)
    await window.loadFile(path.join(process.cwd(), 'out/renderer/index.html'))
    await until(() => evaluate(`Boolean(document.querySelector('.settings-save-state'))`))
    await click('.nav-item', '设置')
    check('重新加载页面仍保留空物品列表', await evaluate(`document.querySelectorAll('.detect-item').length === 0`))
    for (const label of activeLabels) {
      await evaluate(`(() => {
        const input = document.querySelector('.custom-item-row input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await click('.custom-item-row button', '添加')
    }
    await requestClose()
    check('重新添加预设与自定义物品后立即显示并启用', getPublicSettings().prohibitedItems.includes('pencil') && getPublicSettings().customProhibitedItems.some(item => item.label === '充电宝') && await evaluate(`document.querySelectorAll('.detect-item').length === ${activeLabels.length}`))
    await evaluate(`document.querySelector('[aria-label="取消物品 充电宝"]').click()`)
    await requestClose()
    check('取消自定义物品后移除配置记录', !getPublicSettings().customProhibitedItems.some(item => item.label === '充电宝'))
    await evaluate(`(() => {
      const input = document.querySelector('.custom-item-row input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '充电宝');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await click('.custom-item-row button', '添加')
    await requestClose()
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

    await click('.settings-nav-item', '模型配置')
    check('模型设置不再包含语言、token 或图片缩放项', await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.form-field > span')].map(el => el.textContent);
      return !labels.includes('提示词语言') && !labels.includes('最大 token') && !labels.some(label => label.includes('图片缩放比例'));
    })()`))
    check('定位图片格式已从模型配置移除', await evaluate(`![...document.querySelectorAll('.form-field > span')].some(el => el.textContent === '定位图片格式')`))
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === '请求上限').querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await until(() => evaluate(`document.querySelector('.settings-save-state')?.dataset.status === 'pending'`))
    check('全局请求上限可从界面自动保存', await requestClose() && getPublicSettings().requestConcurrency === 1)
    check('模型图片设置已移除说明文字', await evaluate(`document.querySelectorAll('.settings-card .field-hint').length === 0`))
    const savedAdvanced = getPublicSettings().customModel
    await evaluate(`(() => {
      const textarea = document.querySelector('.settings-card textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, '{"top_k":7}');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      for (const [label, value] of [['坐标空间', 'absolute_px'], ['轴序', 'yxyx']]) {
        const select = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === label).querySelector('select');
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`)
    await requestClose()
    check('开启开发者模式后高级字段实际生效', getResolvedModelConfig().extraBody === '{"top_k":7}' && getResolvedModelConfig().coordinateSpaceOverride === 'absolute_px' && getResolvedModelConfig().boxOrderOverride === 'yxyx')
    await evaluate(`document.querySelector('[aria-label="开发者模式"]').click()`)
    check('关闭后立即测试连接不会携带隐藏的额外参数', !('top_k' in await testConnectionBody()))
    await requestClose()
    check('关闭后移除三项控件，运行配置回到默认', await evaluate(`document.querySelectorAll('.settings-card textarea, .settings-card select').length === 0`) && getResolvedModelConfig().coordinateSpaceOverride === 'auto' && getResolvedModelConfig().boxOrderOverride === 'auto')
    check('关闭开发者模式隐藏轨迹入口并拒绝读取记录', await evaluate(`(async () => ![...document.querySelectorAll('.settings-card button')].some(el => el.textContent.trim() === '调用轨迹') && await window.framelens.listModelCallTraces().then(() => false, () => true))()`))
    check('模型页已删除高级配置标题、分隔线和请求上限提示', await evaluate(`!document.querySelector('.form-subhead') && !document.querySelector('.settings-card small') && !document.querySelector('.settings-card').textContent.includes('高级配置')`))
    await evaluate(`document.querySelector('.developer-mode-field').scrollIntoView({ block: 'center' })`)
    await captureSettings('smoke-settings-model-closed.png')
    await evaluate(`document.querySelector('[aria-label="开发者模式"]').click()`)
    check('重新开启后立即测试连接恢复额外参数', (await testConnectionBody()).top_k === 7)
    await requestClose()
    check('重新展开保留原坐标空间和轴序', await evaluate(`(() => {
      const values = [...document.querySelectorAll('.settings-card select')].map(el => el.value);
      return values[0] === 'absolute_px' && values[1] === 'yxyx';
    })()`))
    await evaluate(`(() => {
      const textarea = document.querySelector('.settings-card textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(savedAdvanced.extraBody)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      for (const select of document.querySelectorAll('.settings-card select')) {
        select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`)
    await requestClose()
    await evaluate(`document.querySelector('.developer-mode-field').scrollIntoView({ block: 'center' })`)
    await captureSettings('smoke-settings-model.png')
    await testConnectionBody()
    await click('.settings-card button', '调用轨迹')
    await until(() => evaluate(`Boolean(document.querySelector('.call-trace-item'))`))
    check('模型页统一列表包含连接测试和物品调用', await evaluate(`document.querySelector('.call-trace-body').textContent.includes('连接测试') && document.querySelector('.call-trace-body').textContent.includes('物品判定')`))
    check('调用轨迹列表初次只显示摘要', await evaluate(`document.querySelectorAll('.call-trace-body pre').length === 0`))
    await captureSettings('smoke-call-traces-list.png')
    const traceScroll = await evaluate(`(() => {
      const body = document.querySelector('.call-trace-body');
      body.scrollTop = 120;
      document.querySelectorAll('.call-trace-toggle')[2].focus({ preventScroll: true });
      return body.scrollTop;
    })()`)
    await evaluate(`document.querySelectorAll('.call-trace-toggle')[2].click()`)
    await until(() => evaluate(`Boolean(document.querySelector('.call-trace-block pre'))`))
    check('调用详情在第二层抽屉按需显示，第一层保留摘要列表', await evaluate(`document.querySelectorAll('.call-trace-body pre').length === 0 && document.querySelector('.call-trace-detail-body').textContent.includes('sha256=') && !document.querySelector('.call-trace-detail-body').textContent.includes('base64,') && document.querySelector('.call-trace-drawer').inert`))
    await captureSettings('smoke-call-traces-detail.png')
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    check('Esc 仅关闭详情层并保留列表位置与焦点', await evaluate(`Boolean(document.querySelector('.call-trace-drawer')) && !document.querySelector('.call-trace-detail-drawer') && document.querySelector('.call-trace-body').scrollTop === ${JSON.stringify(traceScroll)} && document.activeElement === document.querySelectorAll('.call-trace-toggle')[2]`))
    await evaluate(`document.querySelectorAll('.call-trace-toggle')[2].click()`)
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="关闭调用详情"]'))`))
    await evaluate(`document.querySelector('[aria-label="关闭调用详情"]').click()`)
    check('详情关闭按钮返回第一层列表', await evaluate(`Boolean(document.querySelector('.call-trace-drawer')) && !document.querySelector('.call-trace-detail-drawer')`))
    await evaluate(`document.querySelectorAll('.call-trace-toggle')[2].click()`)
    await until(() => evaluate(`Boolean(document.querySelector('.call-trace-detail-backdrop'))`))
    await evaluate(`document.querySelector('.call-trace-detail-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    check('点击详情遮罩只关闭第二层抽屉', await evaluate(`Boolean(document.querySelector('.call-trace-drawer')) && !document.querySelector('.call-trace-detail-drawer')`))
    await evaluate(`document.querySelector('[aria-label="关闭调用轨迹"]').click()`)
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === '请求上限').querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await click('.settings-nav-item', '行为识别')
    check('行为输入框显示简化文案', await evaluate(`document.querySelector('.custom-item-row input').placeholder === '添加行为'`))
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === '图片缩放比例').querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '75');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await until(() => getPublicSettings().behaviorImageScalePercent === 75)
    check('行为图片比例可独立自动保存', getPublicSettings().judgmentImage.scalePercent === 100)
    await evaluate(`(() => {
      const input = document.querySelector('.settings-card .custom-item-row input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '奔跑');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await click('.settings-card .custom-item-row button', '添加')
    await requestClose()
    await evaluate(`document.querySelector('.settings-card').scrollIntoView({ block: 'start' })`)
    await captureSettings('smoke-settings-behavior.png')
    await click('.settings-nav-item', '物品识别')
    check('定位图片保留原格式，物品页不再单独设置定位格式', await evaluate(`![...document.querySelectorAll('.form-field > span')].some(el => el.textContent === '定位图片格式')`))
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('.form-field')].find(el => el.querySelector('span')?.textContent === '图片缩放比例').querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '50');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await requestClose()
    check('物品图片比例独立保存，不覆盖行为比例', getPublicSettings().judgmentImage.scalePercent === 50 && getPublicSettings().behaviorImageScalePercent === 75)
    check('物品图片只显示共用缩放比例且无说明文字', await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.form-field > span')].map(el => el.textContent);
      return !labels.includes('判定图片长边') && !labels.includes('判定图片格式') && !labels.includes('JPEG 质量') && document.querySelectorAll('.settings-card p, .settings-card .field-hint').length === 0;
    })()`))
    await evaluate(`document.querySelector('.settings-card').scrollIntoView({ block: 'start' })`)
    await captureSettings('smoke-settings-items.png')

    const previousIds = new Set(listTasks().map((task) => task.id))
    await editInterval(2.5)
    await click('.nav-item', '工作台')
    await click('.uploaded-file-task-button', '识别物品')
    await until(() => listTasks().some((task) => !previousIds.has(task.id)))
    const started = listTasks().find((task) => !previousIds.has(task.id))!
    check('立即启动任务使用最新设置快照', getTask(started.id).config.intervalSec === 2.5)
    const imageConfig = getTask(started.id).config.judgmentImage
    check('新任务使用物品图片设置快照', Boolean(imageConfig && 'scalePercent' in imageConfig && imageConfig.scalePercent === 50))
    return started.id
  } finally {
    window.destroy()
  }
}
