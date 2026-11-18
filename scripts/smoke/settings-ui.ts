/** 隐藏 Electron 窗口，验证真实 React 表单、preload 和设置 IPC。 */
import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getPublicSettings } from '../../src/main/config/settings'
import { getResolvedModelConfig } from '../../src/main/config/model-config'
import { registerIpcHandlers } from '../../src/main/ipc'
import { getTask, listTasks } from '../../src/main/task/manager'
import { emitFrame, emitSummary } from '../../src/main/task/event'
import { flushSave } from '../../src/main/task/store'

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
  async function hasConfirmationLayout(title: string): Promise<boolean> {
    return evaluate(`(() => {
      const dialog = document.querySelector('.confirm-dialog');
      const heading = dialog?.querySelector('h2');
      if (heading?.textContent !== ${JSON.stringify(title)} || dialog.querySelector('p')) return false;
      const icon = dialog.querySelector('.confirm-icon')?.getBoundingClientRect();
      const text = heading.getBoundingClientRect();
      const panel = dialog.getBoundingClientRect();
      const titleRow = dialog.querySelector('.confirm-heading').getBoundingClientRect();
      const close = dialog.querySelector('.dialog-close').getBoundingClientRect();
      const actions = dialog.querySelector('.dialog-actions').getBoundingClientRect();
      const headingTop = titleRow.top - close.bottom;
      const headingBottom = actions.top - titleRow.bottom;
      const insets = [close.top - panel.top, panel.right - close.right,
        panel.right - actions.right, panel.bottom - actions.bottom, titleRow.left - panel.left];
      return Boolean(icon && icon.right < text.left &&
        Math.abs(panel.width - 336) < 1 &&
        insets.every(inset => Math.abs(inset - 12) < 0.5) &&
        Math.abs(icon.top + icon.height / 2 - text.top - text.height / 2) < 1 &&
        Math.abs(headingTop - 1) < 0.5 && Math.abs(headingBottom - 8) < 1);
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
    await evaluate(`document.querySelector('.history-actions [aria-label="删除"]').click()`)
    check('删除任务弹窗使用共享三行布局', await hasConfirmationLayout('删除任务'))
    await click('.dialog-actions .button-ghost', '取消')
    await evaluate(`document.querySelector('.history-row').click()`)
    await until(() => evaluate(`Boolean(document.querySelector('.frame-row'))`))
    check('物品任务详情已移除重新定位按钮及 preload 接口', await evaluate(`![...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '重新定位') && !('relocalizeTask' in window.framelens)`))
    check('没有失败时隐藏失败重试按钮', await evaluate(`![...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '失败重试')`))

    const retryTask = getTask(listTasks()[0].id)
    const failedJudgment = retryTask.frames.find(frame => frame.verdict === 'normal')!
    const failedRegion = retryTask.frames.find(frame => frame.regionStatus === 'ok' && frame.regions.length > 0)!
    const successfulFrames = () => JSON.stringify(retryTask.frames.filter(frame => frame !== failedJudgment && frame !== failedRegion))
    const successfulBefore = successfulFrames()
    const healthUrl = `${getResolvedModelConfig().baseUrl.replace(/\/v1\/?$/, '')}/health`
    const countsBefore = (await (await fetch(healthUrl)).json()).counts
    Object.assign(failedJudgment, { status: 'failed', verdict: 'failed', error: '模拟判定失败' })
    Object.assign(failedRegion, { regionStatus: 'failed', regionError: '模拟定位失败', regions: [] })
    retryTask.status = 'completed_with_errors'
    emitFrame(retryTask, failedJudgment)
    emitFrame(retryTask, failedRegion)
    await flushSave(retryTask)
    emitSummary(retryTask, true)
    await until(() => evaluate(`[...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '失败重试')`))
    check('失败重试显示在原重新定位位置、导出按钮之前', await evaluate(`JSON.stringify([...document.querySelectorAll('.detail-actions button')].map(el => el.textContent.trim())) === JSON.stringify(['失败重试', '导出'])`))
    await click('.detail-actions button', '失败重试')
    await until(() => getTask(retryTask.id).status === 'analyzing')
    await until(() => evaluate(`[...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '取消')`))
    check('重试期间隐藏失败重试按钮，避免重复提交', await evaluate(`![...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '失败重试')`))
    await click('.detail-actions button', '取消')
    check('取消任务弹窗使用共享三行布局', await hasConfirmationLayout('取消任务'))
    await click('.dialog-actions .button-ghost', '取消')
    await until(() => getTask(retryTask.id).status === 'completed')
    const countsAfter = (await (await fetch(healthUrl)).json()).counts
    check('点击失败重试仅重新判定失败帧并补跑失败定位', failedJudgment.status === 'completed' && failedRegion.regionStatus === 'ok' && countsAfter.judgmentCount === countsBefore.judgmentCount + 1 && countsAfter.locateCount === countsBefore.locateCount + 1)
    check('失败重试保留其他成功帧的全部结果', successfulFrames() === successfulBefore)
    await until(() => evaluate(`!document.querySelector('.progress-block')`))
    check('全部重试成功后自动隐藏失败重试按钮', await evaluate(`![...document.querySelectorAll('.detail-actions button')].some(el => el.textContent.trim() === '失败重试')`))
    await evaluate(`document.querySelector('.frame-row').click()`)
    check('帧页码居中显示在顶部导航行', await evaluate(`(() => {
      const header = document.querySelector('.frame-drawer-head');
      const position = header.querySelector('.drawer-position');
      const center = element => {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
      };
      return position.textContent.trim() === '1 / ${retryTask.frames.length}' && Math.abs(center(position) - center(header)) < 1;
    })()`))
    await click('.drawer-head-nav', '下一帧')
    check('切帧后顶部页码随之更新', await evaluate(`document.querySelector('.drawer-position').textContent.trim() === '2 / ${retryTask.frames.length}'`))
    check('任务详情已移除调用轨迹入口', await evaluate(`![...document.querySelectorAll('.drawer button')].some(el => el.textContent.trim() === '调用轨迹')`))
    await evaluate(`document.querySelector('.drawer-head [aria-label="关闭"]').click()`)

    const targetPosition = retryTask.frames.indexOf(failedRegion)
    await evaluate(`document.querySelectorAll('.frame-row')[${targetPosition}].click()`)
    const untouchedFrames = () => JSON.stringify(retryTask.frames.filter(frame => frame !== failedRegion))
    const untouchedBefore = untouchedFrames()
    check('重新判断按钮仅显示文字', await evaluate(`(() => {
      const button = document.querySelector('.drawer-reanalyze');
      return button?.textContent.trim() === '重新判断' && button.childElementCount === 0;
    })()`))
    await click('.drawer-badges button', '重新判断')
    check('重新判断先显示共享三行确认弹窗', await hasConfirmationLayout('重新判断当前帧？'))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    const countsAfterCancel = (await (await fetch(healthUrl)).json()).counts
    check('取消确认保留当前帧且不发出请求', countsAfterCancel.judgmentCount === countsAfter.judgmentCount &&
      await evaluate(`!document.querySelector('.confirm-dialog') && document.querySelector('.drawer-position')?.textContent.trim() === '${targetPosition + 1} / ${retryTask.frames.length}'`))

    const expectedVerdicts = countsAfterCancel.judgmentCount % 2 === 0 ? ['normal', 'abnormal'] : ['abnormal', 'normal']
    for (const expected of expectedVerdicts) {
      const analyzedAt = failedRegion.analyzedAt
      await click('.drawer-badges button', '重新判断')
      await click('.confirm-dialog .button-primary', '确认')
      await until(() => retryTask.status === 'completed' && failedRegion.analyzedAt !== analyzedAt)
      await until(() => evaluate(`!document.querySelector('.drawer-reanalyze').disabled`))
      const label = expected === 'abnormal' ? '异常' : '正常'
      check(`重新判断更新抽屉中的${label}结果和定位状态`, failedRegion.verdict === expected &&
        (expected === 'abnormal' ? failedRegion.regions.length > 0 : failedRegion.regions.length === 0 && failedRegion.regionStatus === 'none') &&
        await evaluate(`document.querySelector('.drawer-badges .badge').textContent === '${label}'`))
    }
    const countsAfterReanalyze = (await (await fetch(healthUrl)).json()).counts
    check('重新判断只对选中的帧发起判定和定位', untouchedFrames() === untouchedBefore &&
      countsAfterReanalyze.judgmentCount === countsAfterCancel.judgmentCount + 2 &&
      countsAfterReanalyze.locateCount === countsAfterCancel.locateCount + 1)

    const moveLabel = targetPosition < retryTask.frames.length - 1 ? '下一帧' : '上一帧'
    const otherFrame = retryTask.frames[targetPosition + (moveLabel === '下一帧' ? 1 : -1)]
    const previousTimes = [failedRegion.analyzedAt, otherFrame.analyzedAt]
    const originalFetch = globalThis.fetch
    let releaseJudgments!: () => void
    let releaseLocalization!: () => void
    const heldJudgments = new Promise<void>((resolve) => { releaseJudgments = resolve })
    const heldLocalization = new Promise<void>((resolve) => { releaseLocalization = resolve })
    let requests = 0
    let localizationStarted = false
    globalThis.fetch = async (input, init) => {
      if (typeof init?.body === 'string') {
        requests += 1
        if (requests <= 2) {
          await heldJudgments
        } else {
          localizationStarted = true
          await heldLocalization
        }
      }
      return originalFetch(input, init)
    }
    try {
      await click('.drawer-badges button', '重新判断')
      await click('.confirm-dialog .button-primary', '确认')
      await until(() => requests === 1)
      check('重新判断中的帧禁用重复提交', await evaluate(`document.querySelector('.drawer-reanalyze').disabled`))
      await click('.drawer-head-nav', moveLabel)
      await click('.drawer-badges button', '重新判断')
      await click('.confirm-dialog .button-primary', '确认')
      await until(() => requests === 2)
      check('同一任务两帧同时发起重新判断', retryTask.status === 'analyzing' &&
        await evaluate(`document.querySelector('.drawer-reanalyze').textContent.trim() === '正在判断'`))
      await evaluate(`document.querySelector('.drawer-head [aria-label="关闭"]').click()`)
      await until(() => evaluate(`document.querySelector('.filter-tab:last-child').textContent === '分析中2'`))
      await click('.filter-tab', '分析中2')
      check('分析中筛选在失败之后，并展示待判定的帧', await evaluate(`
        document.querySelector('.filter-tab.is-active').previousElementSibling.textContent.startsWith('失败') &&
        document.querySelectorAll('.frame-row').length === 2
      `))
      releaseJudgments()
      await until(() => localizationStarted)
      await until(() => evaluate(`document.querySelector('.filter-tab.is-active').textContent === '分析中1'`))
      check('定位中的帧留在分析中筛选里', await evaluate(`
        document.querySelectorAll('.frame-row').length === 1 &&
        document.querySelector('.frame-row .badge').textContent === '异常'
      `))
    } finally {
      releaseJudgments()
      releaseLocalization()
      globalThis.fetch = originalFetch
    }
    await until(() => retryTask.status === 'completed' &&
      failedRegion.analyzedAt !== previousTimes[0] && otherFrame.analyzedAt !== previousTimes[1])
    check('并行重新判断完成后两帧均更新', failedRegion.status === 'completed' && otherFrame.status === 'completed')
    await until(() => evaluate(`document.querySelector('.filter-tab.is-active').textContent === '分析中0'`))
    check('判定和定位完成后自动移出分析中筛选', await evaluate(`
      !document.querySelector('.frame-row') && document.querySelector('.empty-result').textContent === '暂无结果'
    `))

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
    const advancedSelector = '.settings-disclosure'
    const traceSwitchSelector = '[aria-labelledby="model-trace-label"]'
    const traceButtonSelector = '#model-advanced-settings .button-secondary'
    const traceId = await evaluate(`window.framelens.listModelCallTraces().then(page => page.items[0].id)`)
    const traceReadsBlocked = `(async () => {
      const results = await Promise.allSettled([
        window.framelens.listModelCallTraces(),
        window.framelens.getModelCallTrace(${JSON.stringify(traceId)})
      ]);
      return results.every(result => result.status === 'rejected');
    })()`
    check('高级设置展开时箭头朝下', await evaluate(`Boolean(document.querySelector('${advancedSelector}[aria-expanded="true"] .lucide-chevron-down'))`))
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
    check('展开高级设置后高级字段实际生效', getResolvedModelConfig().extraBody === '{"top_k":7}' && getResolvedModelConfig().coordinateSpaceOverride === 'absolute_px' && getResolvedModelConfig().boxOrderOverride === 'yxyx')
    await click(advancedSelector, '高级设置')
    check('关闭后立即测试连接不会携带隐藏的额外参数', !('top_k' in await testConnectionBody()))
    await requestClose()
    check('关闭后移除三项控件，运行配置回到默认', await evaluate(`document.querySelectorAll('.settings-card textarea, .settings-card select').length === 0`) && getResolvedModelConfig().coordinateSpaceOverride === 'auto' && getResolvedModelConfig().boxOrderOverride === 'auto')
    check('收起高级设置时箭头朝右，隐藏轨迹控件并拒绝读取记录',
      await evaluate(`Boolean(document.querySelector('${advancedSelector}[aria-expanded="false"] .lucide-chevron-right')) && !document.querySelector('${traceSwitchSelector}, ${traceButtonSelector}')`) &&
      await evaluate(traceReadsBlocked))
    check('模型页已删除高级配置标题、分隔线和请求上限提示', await evaluate(`!document.querySelector('.form-subhead') && !document.querySelector('.settings-card small') && !document.querySelector('.settings-card').textContent.includes('高级配置')`))
    await evaluate(`document.querySelector('${advancedSelector}').scrollIntoView({ block: 'center' })`)
    await captureSettings('smoke-settings-model-closed.png')
    await click(advancedSelector, '高级设置')
    check('重新开启后立即测试连接恢复额外参数', (await testConnectionBody()).top_k === 7)
    await requestClose()
    check('重新展开保留原坐标空间和轴序', await evaluate(`(() => {
      const values = [...document.querySelectorAll('.settings-card select')].map(el => el.value);
      return values[0] === 'absolute_px' && values[1] === 'yxyx';
    })()`))
    check('重新展开恢复已保存的轨迹开关', await evaluate(`Boolean(document.querySelector('${traceSwitchSelector}[aria-checked="true"]'))`))
    await evaluate(`document.querySelector('${traceSwitchSelector}').click()`)
    await until(() => !getPublicSettings().traceEnabled)
    check('仅开启高级设置时，轨迹入口隐藏且无法读取列表和详情',
      await evaluate(`Boolean(document.querySelector('${traceSwitchSelector}[aria-checked="false"]')) && !document.querySelector('${traceButtonSelector}')`) &&
      await evaluate(traceReadsBlocked))
    await evaluate(`(() => {
      const textarea = document.querySelector('.settings-card textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(savedAdvanced.extraBody)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      for (const select of document.querySelectorAll('.settings-card select')) {
        select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`)
    await requestClose()
    await evaluate(`document.querySelector('${traceSwitchSelector}').click()`)
    await testConnectionBody()
    check('启用轨迹后开关位于调用轨迹左侧', await evaluate(`
      document.querySelector('${traceSwitchSelector}').getBoundingClientRect().right <
      document.querySelector('${traceButtonSelector}').getBoundingClientRect().left
    `))
    await evaluate(`document.querySelector('${advancedSelector}').scrollIntoView({ block: 'center' })`)
    await captureSettings('smoke-settings-model.png')
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
